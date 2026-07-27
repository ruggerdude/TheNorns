import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, open, unlink, writeFile } from "node:fs/promises";
import { V2_HUMAN_WAIT_INSTRUCTION } from "@norns/contracts";

export interface HumanWaitEnvelopeT {
  schema_version: 1;
  kind: "human_wait";
  decision_point: string;
  question: string;
  compact_summary: string;
}

function parseHumanWaitEnvelope(value: unknown): HumanWaitEnvelopeT {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("human wait envelope must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    JSON.stringify(keys) !==
    JSON.stringify(
      ["compact_summary", "decision_point", "kind", "question", "schema_version"].sort(),
    )
  ) {
    throw new Error("human wait envelope has unknown or missing fields");
  }
  const bounded = (field: string, max: number): string => {
    const candidate = record[field];
    if (typeof candidate !== "string" || candidate.trim().length === 0 || candidate.length > max) {
      throw new Error(`human wait ${field} is invalid`);
    }
    return candidate.trim();
  };
  if (record.schema_version !== 1 || record.kind !== "human_wait") {
    throw new Error("human wait envelope version or kind is invalid");
  }
  return {
    schema_version: 1,
    kind: "human_wait",
    decision_point: bounded("decision_point", 500),
    question: bounded("question", 8_000),
    compact_summary: bounded("compact_summary", 16_000),
  };
}

export function humanWaitPrompt(): string {
  return `\n## Human-decision checkpoint\n${V2_HUMAN_WAIT_INSTRUCTION}`;
}

export function hashHumanWaitEnvelope(envelope: HumanWaitEnvelopeT) {
  return {
    decisionPoint: envelope.decision_point,
    question: envelope.question,
    questionHash: createHash("sha256").update(envelope.question).digest("hex"),
    compactSummary: envelope.compact_summary,
    compactSummaryHash: createHash("sha256").update(envelope.compact_summary).digest("hex"),
  };
}

export async function readHumanWaitEnvelope(path: string): Promise<HumanWaitEnvelopeT | null> {
  let file: FileHandle;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 32_768) {
      throw new Error("human wait envelope must be a regular file no larger than 32768 bytes");
    }
    const raw = await file.readFile("utf8");
    return parseHumanWaitEnvelope(JSON.parse(raw));
  } finally {
    await file.close();
  }
}

/** Used by envelope-native runtimes such as the one-shot inference proxy. */
export async function writeHumanWaitEnvelopeFromExactJson(
  path: string,
  candidate: string,
): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return false;
  }
  let parsed: HumanWaitEnvelopeT;
  try {
    parsed = parseHumanWaitEnvelope(value);
  } catch {
    return false;
  }
  const temporary = `${path}.runtime`;
  await writeFile(temporary, JSON.stringify(parsed), { mode: 0o600, flag: "wx" });
  try {
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  return true;
}
