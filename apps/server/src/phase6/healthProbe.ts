import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { V2PublicHttpsUrl } from "@norns/contracts";

export type HealthProbeErrorCode =
  | "dns_unavailable"
  | "private_address"
  | "probe_failed"
  | "redirect_limit"
  | "response_too_large"
  | "unsafe_url";

export class HealthProbeError extends Error {
  constructor(
    readonly code: HealthProbeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HealthProbeError";
  }
}

export interface HealthProbeResult {
  requested_url: string;
  final_url: string;
  status_code: number;
  resolved_address: string;
  redirects: string[];
}

export interface HealthProbeOptions {
  lookup?: (
    hostname: string,
    options: { all: true; verbatim: true },
  ) => Promise<Array<{ address: string; family: number }>>;
  timeoutMs?: number;
  maxRedirects?: number;
  maxResponseBytes?: number;
}

function publicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return false;
  }
  const [a = 0, b = 0, c = 0] = octets;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Bytes(address: string): bigint | null {
  const normalized = address.split("%")[0] ?? "";
  const ipv4Index = normalized.lastIndexOf(":");
  let source = normalized;
  if (normalized.includes(".") && ipv4Index >= 0) {
    const ipv4 = normalized.slice(ipv4Index + 1);
    const octets = ipv4.split(".").map(Number);
    if (octets.length !== 4 || octets.some((value) => value < 0 || value > 255)) return null;
    source = `${normalized.slice(0, ipv4Index)}:${((octets[0] ?? 0) * 256 + (octets[1] ?? 0)).toString(16)}:${((octets[2] ?? 0) * 256 + (octets[3] ?? 0)).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function publicIpv6(address: string): boolean {
  const value = ipv6Bytes(address);
  if (value === null) return false;
  // Globally routable unicast only (2000::/3), excluding documentation.
  return value >> 125n === 1n && value >> 96n !== 0x20010db8n;
}

export function isPublicProbeAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? publicIpv4(address) : family === 6 ? publicIpv6(address) : false;
}

async function requestPinned(
  url: URL,
  address: string,
  family: 4 | 6,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<{ status: number; location: string | null }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
          "User-Agent": "TheNorns-Health-Probe/1",
        },
        servername: url.hostname,
        lookup: (_hostname, _options, callback) => callback(null, address, family),
      },
      (response) => {
        let received = 0;
        response.on("data", (chunk: Buffer | string) => {
          received += Buffer.byteLength(chunk);
          if (received > maxResponseBytes) {
            request.destroy(
              new HealthProbeError("response_too_large", "health response exceeded byte cap"),
            );
          }
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            location:
              typeof response.headers.location === "string" ? response.headers.location : null,
          });
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new HealthProbeError("probe_failed", "health probe timed out"));
    });
    request.on("error", (error) => reject(error));
    request.end();
  });
}

/**
 * Resolve immediately before every connection, reject every non-public answer,
 * then pin the selected address into the TLS request. Redirects repeat the
 * complete validation and resolution process.
 */
export async function probePublicHttpsUrl(
  value: string,
  options: HealthProbeOptions = {},
): Promise<HealthProbeResult> {
  const parsed = V2PublicHttpsUrl.safeParse(value);
  if (!parsed.success) {
    throw new HealthProbeError("unsafe_url", "health probe requires a public HTTPS URL");
  }
  const lookup =
    options.lookup ??
    ((hostname: string, lookupOptions: { all: true; verbatim: true }) =>
      dnsLookup(hostname, lookupOptions));
  const timeoutMs = options.timeoutMs ?? 5_000;
  const maxRedirects = options.maxRedirects ?? 3;
  const maxResponseBytes = options.maxResponseBytes ?? 64 * 1024;
  const redirects: string[] = [];
  let current = new URL(parsed.data);
  let selectedAddress = "";

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    let answers: Array<{ address: string; family: number }>;
    try {
      answers = await lookup(current.hostname, { all: true, verbatim: true });
    } catch {
      throw new HealthProbeError("dns_unavailable", "health host could not be resolved");
    }
    if (answers.length === 0 || answers.some((answer) => !isPublicProbeAddress(answer.address))) {
      throw new HealthProbeError(
        "private_address",
        "health host resolved to a non-public or ambiguous address",
      );
    }
    const selected = [...answers].sort((left, right) =>
      left.address.localeCompare(right.address),
    )[0];
    if (!selected || (selected.family !== 4 && selected.family !== 6)) {
      throw new HealthProbeError("dns_unavailable", "health host had no supported address");
    }
    selectedAddress = selected.address;
    let response: { status: number; location: string | null };
    try {
      response = await requestPinned(
        current,
        selected.address,
        selected.family,
        timeoutMs,
        maxResponseBytes,
      );
    } catch (error) {
      if (error instanceof HealthProbeError) throw error;
      throw new HealthProbeError("probe_failed", "health endpoint could not be reached");
    }
    if (response.location && [301, 302, 303, 307, 308].includes(response.status)) {
      if (redirect === maxRedirects) {
        throw new HealthProbeError("redirect_limit", "health endpoint redirected too many times");
      }
      const target = new URL(response.location, current);
      const targetParse = V2PublicHttpsUrl.safeParse(target.toString());
      if (!targetParse.success) {
        throw new HealthProbeError("unsafe_url", "health redirect target is not public HTTPS");
      }
      redirects.push(target.toString());
      current = target;
      continue;
    }
    return {
      requested_url: value,
      final_url: current.toString(),
      status_code: response.status,
      resolved_address: selectedAddress,
      redirects,
    };
  }
  throw new HealthProbeError("redirect_limit", "health endpoint redirected too many times");
}
