// Lightweight global-fetch stub for tests. The app's fetch usage is a
// handful of small helper functions (api()/postJson() in App.tsx, request()
// in Projects.tsx, the raw fetch() in Dashboard.tsx) — not enough surface to
// justify pulling in MSW. A test registers `{method, urlPattern} -> response`
// routes, installs the stub onto global.fetch, and can inspect every call
// that was made afterwards.
export interface MockResponseInit {
  status?: number;
  body?: unknown;
}

export type MockHandler = (
  url: string,
  init: RequestInit | undefined,
) => MockResponseInit | Promise<MockResponseInit>;

export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
  /**
   * Request headers, keys lowercased. Recorded so a test can assert the REAL
   * invocation shape — e.g. that a body-less POST does NOT carry
   * `content-type: application/json`, a combination Fastify rejects with 400
   * before any route handler runs (this exact mismatch between a loose fetch
   * mock and the real server shipped a broken button once — POLISH P3).
   */
  headers: Record<string, string>;
}

function normalizedHeaders(headers: RequestInit["headers"]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
  for (const [key, value] of entries) result[key.toLowerCase()] = String(value);
  return result;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: MockHandler;
}

function toPattern(pattern: string | RegExp): RegExp {
  if (pattern instanceof RegExp) return pattern;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}$`);
}

/**
 * A queue-able mock for `global.fetch`. Register routes with `.get`/`.post`/
 * etc. (most specific/most-recently-added match wins), then call `.install()`
 * once per test. `.calls` records every request made, in order, for
 * assertions like "the override PATCH never fired".
 */
export class MockFetch {
  private routes: Route[] = [];
  readonly calls: RecordedCall[] = [];
  private previousFetch: typeof fetch | undefined;

  constructor() {
    // App-level tests seed a session token before rendering. Mirror the
    // successful session restoration that accompanies that token by default;
    // auth-specific tests can override this route because newer routes win.
    this.get("/api/auth/me", {
      body: {
        id: "test-user",
        email: "test@example.com",
        name: "Test User",
        role: "member",
        status: "active",
      },
    });
  }

  /** Register a route. Later registrations are checked first, so a test can
   *  override a broad default with a one-off failure response. */
  route(method: string, pattern: string | RegExp, handler: MockResponseInit | MockHandler): this {
    const resolved: MockHandler = typeof handler === "function" ? handler : () => handler;
    this.routes.unshift({
      method: method.toUpperCase(),
      pattern: toPattern(pattern),
      handler: resolved,
    });
    return this;
  }

  get(pattern: string | RegExp, handler: MockResponseInit | MockHandler): this {
    return this.route("GET", pattern, handler);
  }
  post(pattern: string | RegExp, handler: MockResponseInit | MockHandler): this {
    return this.route("POST", pattern, handler);
  }
  patch(pattern: string | RegExp, handler: MockResponseInit | MockHandler): this {
    return this.route("PATCH", pattern, handler);
  }
  del(pattern: string | RegExp, handler: MockResponseInit | MockHandler): this {
    return this.route("DELETE", pattern, handler);
  }

  /** Register a route whose handler rejects the fetch promise entirely —
   *  simulates a network failure (DNS/connection reset), as opposed to a
   *  well-formed HTTP error response. */
  networkError(method: string, pattern: string | RegExp, message = "network error"): this {
    return this.route(method, pattern, () => {
      throw new TypeError(message);
    });
  }

  install(): void {
    this.previousFetch = globalThis.fetch;
    globalThis.fetch = this.handle as unknown as typeof fetch;
  }

  restore(): void {
    if (this.previousFetch) globalThis.fetch = this.previousFetch;
  }

  private handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    this.calls.push({ method, url, body, headers: normalizedHeaders(init?.headers) });

    const route = this.routes.find((r) => r.method === method && r.pattern.test(url));
    if (!route) {
      throw new Error(`MockFetch: no route registered for ${method} ${url}`);
    }
    const result = await route.handler(url, init);
    const status = result.status ?? 200;
    return new Response(JSON.stringify(result.body ?? {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}
