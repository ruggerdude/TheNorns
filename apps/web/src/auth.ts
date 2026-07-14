// Session-based auth: the access token lives in sessionStorage, not the URL.
// If someone still arrives with ?token=… (e.g. an old link), we migrate it
// into sessionStorage and strip it from the address bar — so it never lingers
// in history or logs.
const KEY = "norns_token";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

/** A non-2xx API response that wasn't a 401 — carries the status for callers
 *  that need to branch on it (e.g. 409 "project has no plan yet" isn't an
 *  error worth alarming the user with, it's just where a fresh project starts). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function getToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const fromUrl = params.get("token");
  if (fromUrl) {
    sessionStorage.setItem(KEY, fromUrl);
    params.delete("token");
    const query = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));
    return fromUrl;
  }
  return sessionStorage.getItem(KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(KEY);
}

export function authHeaders(hasBody = false): Record<string, string> {
  const token = sessionStorage.getItem(KEY) ?? "";
  return {
    authorization: `Bearer ${token}`,
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };
}
