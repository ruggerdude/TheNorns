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
