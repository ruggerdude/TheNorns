import type { UserRole } from "./store.js";

export type IdentityUserStatus = "active" | "invited" | "disabled";

/**
 * Authentication-facing identity shape. Password and credential material is
 * deliberately absent so callers cannot accidentally serialize it.
 */
export interface IdentityUser {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: IdentityUserStatus;
  createdAt: string;
}

/** Wire-compatible summary used by the existing user-management routes. */
export interface IdentityUserSummary {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: IdentityUserStatus;
  created_at: string;
}

export interface CreateActiveIdentityInput {
  email: string;
  name?: string | undefined;
  password: string;
  role: UserRole;
}

export interface CreateIdentityInviteInput {
  email: string;
  name?: string | undefined;
  role: UserRole;
}

export interface IdentitySessionSummary {
  id: string;
  status: "active" | "revoked" | "expired";
  created_at: string;
  authenticated_at: string;
  expires_at: string;
  last_seen_at: string | null;
  current: boolean;
}

export class IdentityAlreadyBootstrappedError extends Error {
  constructor() {
    super("an active administrator already exists");
    this.name = "IdentityAlreadyBootstrappedError";
  }
}

/**
 * Async seam used while the legacy snapshot store and normalized PostgreSQL
 * identity implementation coexist. `remove()` is retained for route
 * compatibility, but relational implementations must treat it as a soft
 * disable: user and audit identity are never hard-deleted in the MVP.
 */
export interface IdentityService {
  hasActiveAdmin(): Promise<boolean>;
  bootstrapAdmin(input: Omit<CreateActiveIdentityInput, "role">): Promise<IdentityUserSummary>;
  userForToken(token: string): Promise<IdentityUser | undefined>;
  login(email: string, password: string): Promise<{ token: string; user: IdentityUserSummary }>;
  logout(token: string): Promise<void>;
  list(): Promise<IdentityUserSummary[]>;
  createActive(input: CreateActiveIdentityInput): Promise<IdentityUserSummary>;
  createInvite(
    input: CreateIdentityInviteInput,
  ): Promise<{ summary: IdentityUserSummary; inviteToken: string }>;
  acceptInvite(inviteToken: string, password: string): Promise<IdentityUserSummary>;
  disable(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Phase 7 capabilities are optional only for the legacy compatibility adapter. */
  isRecentSession?(token: string, maximumAgeMs: number): Promise<boolean>;
  listSessions?(userId: string, currentToken: string): Promise<IdentitySessionSummary[]>;
  revokeSession?(userId: string, sessionId: string): Promise<void>;
  requestPasswordRecovery?(email: string): Promise<string | undefined>;
  resetPassword?(recoveryToken: string, password: string): Promise<void>;
}

export {
  InvalidCredentialsError,
  InvalidInviteError,
  LastActiveAdminError,
  UserExistsError,
  UserNotFoundError,
} from "./store.js";
