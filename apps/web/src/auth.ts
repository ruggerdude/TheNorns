// Browser authentication uses a Secure, HttpOnly, SameSite cookie. JavaScript
// retains only a non-secret presence marker so refresh can attempt /auth/me;
// the raw session credential is never placed in web storage.
const KEY = "norns_cookie_session";

export interface CurrentUser {
  id: string;
  email: string;
  name: string | null;
  role: "admin" | "member";
  status: "active" | "invited";
}

export interface AuthSession {
  token?: string;
  csrf_token?: string;
  user: CurrentUser;
}

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
  return sessionStorage.getItem(KEY);
}

export function setToken(_token?: string): void {
  sessionStorage.removeItem("norns_token");
  sessionStorage.setItem(KEY, "present");
}

export function clearToken(): void {
  sessionStorage.removeItem(KEY);
}

export function authHeaders(hasBody = false): Record<string, string> {
  const csrf = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("norns_csrf="))
    ?.slice("norns_csrf=".length);
  return {
    ...(csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {}),
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };
}

/** An email invite link looks like /?invite=<token>. Read it once, then strip
 *  it from the address bar so it never lingers in history or logs. */
export function consumeInviteToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get("invite");
  if (!invite) return null;
  params.delete("invite");
  const query = params.toString();
  window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));
  return invite;
}

export function consumeRecoveryToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const recovery = params.get("recovery");
  if (!recovery) return null;
  params.delete("recovery");
  const query = params.toString();
  window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));
  return recovery;
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "Incorrect email or password.",
  already_bootstrapped: "Setup has already been completed — sign in instead.",
  bootstrap_disabled: "First-time setup isn't enabled on this deployment.",
  invalid_deploy_token: "That setup key isn't correct.",
  bad_request: "Please check the form and try again.",
};

/** Turn a caught auth error into copy fit for an <Alert>. */
export function describeAuthError(error: unknown): string {
  if (error instanceof ApiError) return ERROR_MESSAGES[error.message] ?? error.message;
  return error instanceof Error ? error.message : String(error);
}

async function authPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: authHeaders(true),
    credentials: "include",
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) {
    throw new ApiError(json.message ?? json.error ?? `request failed: ${res.status}`, res.status);
  }
  return json;
}

export async function fetchAuthStatus(): Promise<{ needs_bootstrap: boolean }> {
  const res = await fetch("/api/auth/status", { credentials: "include" });
  return (await res.json()) as { needs_bootstrap: boolean };
}

export function login(email: string, password: string): Promise<AuthSession> {
  return authPost<AuthSession>("/api/auth/login", { email, password });
}

export function bootstrap(
  deployToken: string,
  email: string,
  password: string,
  name: string | undefined,
): Promise<AuthSession> {
  return authPost<AuthSession>("/api/auth/bootstrap", {
    deploy_token: deployToken,
    email,
    password,
    ...(name ? { name } : {}),
  });
}

export function acceptInvite(inviteToken: string, password: string): Promise<AuthSession> {
  return authPost<AuthSession>("/api/auth/accept-invite", {
    invite_token: inviteToken,
    password,
  });
}

export async function requestPasswordRecovery(email: string): Promise<void> {
  await authPost<{ accepted: true }>("/api/auth/recovery/request", { email });
}

export async function completePasswordRecovery(
  recoveryToken: string,
  password: string,
): Promise<void> {
  await authPost<{ ok: true }>("/api/auth/recovery/complete", {
    recovery_token: recoveryToken,
    password,
  });
}

export async function fetchMe(): Promise<CurrentUser> {
  const res = await fetch("/api/auth/me", { headers: authHeaders(), credentials: "include" });
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) throw new ApiError(`request failed: ${res.status}`, res.status);
  return (await res.json()) as CurrentUser;
}

/** Best-effort: invalidate the session server-side. The client-side token
 *  clear is what actually matters for sign-out, so failures here are silent. */
export async function requestLogout(): Promise<void> {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
    });
  } catch {
    // ignore — token is cleared client-side regardless
  }
}
