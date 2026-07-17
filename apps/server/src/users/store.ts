// Real user accounts — replaces the single shared deploy token as the
// day-to-day login mechanism. Passwords are hashed with scrypt (Node's
// built-in, memory-hard KDF; no extra dependency, no bcrypt native build to
// fight in Docker). Session tokens are opaque random strings looked up
// server-side — there is no JWT to sign or verify incorrectly.
import { randomBytes } from "node:crypto";
import { newId } from "../ids.js";
import {
  detectPasswordHashScheme,
  hashCurrentPassword,
  verifyAndRehashPassword,
} from "./passwords.js";

export type UserRole = "admin" | "member";
export type UserStatus = "active" | "invited";

export interface UserRecord {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: UserStatus;
  passwordHash: string | null; // null while status === "invited"
  inviteToken: string | null; // set only while status === "invited"
  createdAt: string;
}

export interface UserSummary {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  status: UserStatus;
  created_at: string;
}

export interface UserStoreSnapshot {
  users: UserRecord[];
  sessions: { token: string; userId: string; createdAt: string }[];
}

function hashPassword(password: string): string {
  return hashCurrentPassword(password);
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("invalid email or password");
    this.name = "InvalidCredentialsError";
  }
}
export class UserExistsError extends Error {
  constructor(email: string) {
    super(`a user with email "${email}" already exists`);
    this.name = "UserExistsError";
  }
}
export class UserNotFoundError extends Error {
  constructor(id: string) {
    super(`unknown user "${id}"`);
    this.name = "UserNotFoundError";
  }
}
export class LastActiveAdminError extends Error {
  constructor() {
    super("the last active administrator cannot be removed");
    this.name = "LastActiveAdminError";
  }
}
export class InvalidInviteError extends Error {
  constructor() {
    super("invite link is invalid or has already been used");
    this.name = "InvalidInviteError";
  }
}

export class UserStore {
  private readonly users = new Map<string, UserRecord>();
  private readonly sessions = new Map<string, { userId: string; createdAt: string }>();

  get count(): number {
    return this.users.size;
  }

  /** Whether the workspace has an administrator who can actually sign in.
   *  Invited admins and ordinary members must not permanently close the
   *  first-admin bootstrap path. */
  get hasActiveAdmin(): boolean {
    return [...this.users.values()].some(
      (user) => user.role === "admin" && user.status === "active" && user.passwordHash !== null,
    );
  }

  private byEmail(email: string): UserRecord | undefined {
    const normalized = email.trim().toLowerCase();
    return [...this.users.values()].find((u) => u.email === normalized);
  }

  /** Directly create an active user with a set password — manual add and
   *  first-admin bootstrap both go through this. */
  createActive(input: {
    email: string;
    name?: string | undefined;
    password: string;
    role: UserRole;
  }): UserSummary {
    const email = input.email.trim().toLowerCase();
    if (this.byEmail(email)) throw new UserExistsError(email);
    const record: UserRecord = {
      id: newId("user"),
      email,
      name: input.name?.trim() || null,
      role: input.role,
      status: "active",
      passwordHash: hashPassword(input.password),
      inviteToken: null,
      createdAt: new Date().toISOString(),
    };
    this.users.set(record.id, record);
    return this.summarize(record);
  }

  /** Create a pending invite — no password until the invitee sets one via
   *  acceptInvite(). The raw token is returned only here, at creation; it is
   *  never re-derivable or displayed again once the caller sends the email. */
  createInvite(input: {
    email: string;
    name?: string | undefined;
    role: UserRole;
  }): { summary: UserSummary; inviteToken: string } {
    const email = input.email.trim().toLowerCase();
    if (this.byEmail(email)) throw new UserExistsError(email);
    const inviteToken = randomBytes(32).toString("hex");
    const record: UserRecord = {
      id: newId("user"),
      email,
      name: input.name?.trim() || null,
      role: input.role,
      status: "invited",
      passwordHash: null,
      inviteToken,
      createdAt: new Date().toISOString(),
    };
    this.users.set(record.id, record);
    return { summary: this.summarize(record), inviteToken };
  }

  acceptInvite(inviteToken: string, password: string): UserSummary {
    const record = [...this.users.values()].find((u) => u.inviteToken === inviteToken);
    if (!record) throw new InvalidInviteError();
    record.status = "active";
    record.passwordHash = hashPassword(password);
    record.inviteToken = null;
    return this.summarize(record);
  }

  list(): UserSummary[] {
    return [...this.users.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((u) => this.summarize(u));
  }

  remove(id: string): void {
    const record = this.users.get(id);
    if (!record) throw new UserNotFoundError(id);
    if (
      record.role === "admin" &&
      record.status === "active" &&
      [...this.users.values()].filter(
        (user) => user.role === "admin" && user.status === "active" && user.passwordHash !== null,
      ).length === 1
    ) {
      throw new LastActiveAdminError();
    }
    this.users.delete(id);
    for (const [token, session] of this.sessions) {
      if (session.userId === id) this.sessions.delete(token);
    }
  }

  /** Verify credentials and start a session. Deliberately does not
   *  distinguish "no such email" from "wrong password" to the caller. */
  login(email: string, password: string): { token: string; user: UserSummary } {
    const record = this.byEmail(email);
    if (!record || record.status !== "active" || !record.passwordHash) {
      throw new InvalidCredentialsError();
    }
    const scheme = detectPasswordHashScheme(record.passwordHash);
    if (scheme === null) throw new InvalidCredentialsError();
    const verified = verifyAndRehashPassword(password, record.passwordHash, scheme);
    if (!verified.valid) throw new InvalidCredentialsError();
    if (verified.upgraded_hash !== null) {
      record.passwordHash = verified.upgraded_hash;
    }
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { userId: record.id, createdAt: new Date().toISOString() });
    return { token, user: this.summarize(record) };
  }

  logout(token: string): void {
    this.sessions.delete(token);
  }

  /** Resolve a bearer token to its user, or undefined if not a live session. */
  userForToken(token: string): UserRecord | undefined {
    const session = this.sessions.get(token);
    if (!session) return undefined;
    return this.users.get(session.userId);
  }

  snapshot(): UserStoreSnapshot {
    return {
      users: [...this.users.values()],
      sessions: [...this.sessions.entries()].map(([token, s]) => ({
        token,
        userId: s.userId,
        createdAt: s.createdAt,
      })),
    };
  }

  restoreFrom(snap: UserStoreSnapshot): void {
    this.users.clear();
    this.sessions.clear();
    for (const u of snap.users) this.users.set(u.id, u);
    for (const s of snap.sessions) {
      this.sessions.set(s.token, { userId: s.userId, createdAt: s.createdAt });
    }
  }

  private summarize(record: UserRecord): UserSummary {
    return {
      id: record.id,
      email: record.email,
      name: record.name,
      role: record.role,
      status: record.status,
      created_at: record.createdAt,
    };
  }
}
