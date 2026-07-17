export interface SanitizableLegacyUser extends Record<string, unknown> {
  inviteToken?: unknown;
}

export interface SanitizableLegacySession extends Record<string, unknown> {
  token?: unknown;
}

export interface SanitizableLegacyUserSnapshot extends Record<string, unknown> {
  users: SanitizableLegacyUser[];
  sessions: SanitizableLegacySession[];
}

export interface LegacyCredentialSanitizationResult<T extends SanitizableLegacyUserSnapshot> {
  snapshot: T;
  revoked_session_count: number;
  revoked_invitation_count: number;
}

/**
 * Returns a new compatibility snapshot with every reusable credential
 * removed. Identity fields, password hashes, roles, timestamps and unknown
 * forward-compatible fields are preserved.
 */
export function sanitizeLegacyCredentialSnapshot<T extends SanitizableLegacyUserSnapshot>(
  source: T,
): LegacyCredentialSanitizationResult<T> {
  const revokedInvitationCount = source.users.filter(
    (user) => typeof user.inviteToken === "string" && user.inviteToken.length > 0,
  ).length;
  const users = source.users.map((user) => ({ ...user, inviteToken: null }));
  const snapshot = {
    ...source,
    users,
    sessions: [],
  } as unknown as T;
  return {
    snapshot,
    revoked_session_count: source.sessions.length,
    revoked_invitation_count: revokedInvitationCount,
  };
}

export function hasReusableLegacyCredentials(source: SanitizableLegacyUserSnapshot): boolean {
  return (
    source.sessions.length > 0 ||
    source.users.some((user) => typeof user.inviteToken === "string" && user.inviteToken.length > 0)
  );
}
