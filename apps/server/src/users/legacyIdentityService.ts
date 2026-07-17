import type {
  CreateActiveIdentityInput,
  CreateIdentityInviteInput,
  IdentityService,
  IdentityUser,
  IdentityUserSummary,
} from "./identityService.js";
import { IdentityAlreadyBootstrappedError } from "./identityService.js";
import type { UserRecord, UserStore, UserSummary } from "./store.js";

function summary(user: UserSummary): IdentityUserSummary {
  return user;
}

function identity(user: UserRecord): IdentityUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  };
}

/**
 * Compatibility adapter for the in-memory snapshot identity store.
 *
 * The legacy store has no disabled state, so both disable/remove retain its
 * historical hard-remove behavior. The relational implementation below is
 * archive-only and soft-disables instead.
 */
export class LegacyIdentityService implements IdentityService {
  constructor(private readonly store: UserStore) {}

  async hasActiveAdmin(): Promise<boolean> {
    return this.store.hasActiveAdmin;
  }

  async bootstrapAdmin(
    input: Omit<CreateActiveIdentityInput, "role">,
  ): Promise<IdentityUserSummary> {
    if (this.store.hasActiveAdmin) throw new IdentityAlreadyBootstrappedError();
    return summary(this.store.createActive({ ...input, role: "admin" }));
  }

  async userForToken(token: string): Promise<IdentityUser | undefined> {
    const user = this.store.userForToken(token);
    return user ? identity(user) : undefined;
  }

  async login(
    email: string,
    password: string,
  ): Promise<{ token: string; user: IdentityUserSummary }> {
    const result = this.store.login(email, password);
    return { token: result.token, user: summary(result.user) };
  }

  async logout(token: string): Promise<void> {
    this.store.logout(token);
  }

  async list(): Promise<IdentityUserSummary[]> {
    return this.store.list().map(summary);
  }

  async createActive(input: CreateActiveIdentityInput): Promise<IdentityUserSummary> {
    return summary(this.store.createActive(input));
  }

  async createInvite(
    input: CreateIdentityInviteInput,
  ): Promise<{ summary: IdentityUserSummary; inviteToken: string }> {
    const result = this.store.createInvite(input);
    return { summary: summary(result.summary), inviteToken: result.inviteToken };
  }

  async acceptInvite(inviteToken: string, password: string): Promise<IdentityUserSummary> {
    return summary(this.store.acceptInvite(inviteToken, password));
  }

  async disable(id: string): Promise<void> {
    this.store.remove(id);
  }

  async remove(id: string): Promise<void> {
    this.store.remove(id);
  }
}
