// EXECUTION E9 — the credential the agentic runtimes actually send.
//
// THE PROBLEM. Claude Code and Codex are not our code. Each one takes a base
// URL and a bearer/api-key string out of its environment and puts that string
// in an Authorization header. There is no room in that interface for an
// Ed25519 challenge-response, so the relay identity the runner already holds
// cannot be presented on the model calls themselves. Something bearer-shaped
// has to exist.
//
// WHAT IT IS, AND WHAT IT IS EMPHATICALLY NOT. It is NOT a provider key. A
// provider key is deployment-wide, long-lived, and worth stealing; this is
// scoped to ONE run, expires in minutes, is revoked the moment the run stops
// being spendable, and can buy nothing except calls the run's own approved
// budget reservation already covers. The most a fully compromised Actions job
// can do with a stolen one is spend the remainder of the money a human already
// approved for the single task it was dispatched for, until it expires.
//
// STORED HASHED. Only sha-256 of the token is persisted, so a database dump —
// or a stray log of a row — yields nothing usable. Resolution is by hash, and
// the comparison is constant-time.
//
// AUTHORIZATION IS NOT DELEGATED TO IT. The token names a run and a runner
// generation and nothing else. Every request re-resolves the run through E3's
// `ProxiedRunLookup` and re-runs E3's `authorizeProxiedRunAccess`, so a token
// minted a minute ago stops working the instant the run finishes, is
// superseded, is cancelled, or the runner is revoked — without anyone having
// to remember to delete it.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { newId } from "../ids.js";
import type { V2TransactionRunner } from "../persistence/v2/database.js";
import type { ProxiedRunFacts } from "../runners/inferenceProxy.js";

/**
 * Prefix on every issued token.
 *
 * Present so a leaked string is instantly recognisable in a log or a secret
 * scanner as a Norns gateway credential rather than a provider key — the two
 * must never be confused by a human triaging an incident.
 */
export const GATEWAY_TOKEN_PREFIX = "nrngw_";

/**
 * Default lifetime. Long enough for a coding run's model calls, short enough
 * that a token exfiltrated from a CI log is worthless by the time anyone reads
 * it. A run outliving this re-mints; the runner does that automatically.
 */
export const GATEWAY_CREDENTIAL_TTL_MS = 90 * 60 * 1_000;

export interface GatewayCredentialRecord {
  id: string;
  run_id: string;
  runner_id: string;
  /** The dispatch generation the token was minted at. The fence. */
  runner_generation: number;
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface MintedGatewayCredential {
  /** The plaintext token. Returned exactly once, never stored, never logged. */
  token: string;
  expires_at: string;
}

/** Durable storage. A port so the decision logic is testable without a DB. */
export interface GatewayCredentialStore {
  insert(record: GatewayCredentialRecord & { token_hash: string }): Promise<void>;
  findByHash(tokenHash: string): Promise<GatewayCredentialRecord | null>;
  /** Revokes every live credential for a run. Idempotent. */
  revokeRun(runId: string, atIso: string): Promise<void>;
  /** Housekeeping: drop rows no request could ever accept again. */
  purgeExpired(beforeIso: string): Promise<number>;
}

export function hashGatewayToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Constant-time compare of two hex digests.
 *
 * The lookup is by hash so a timing side channel here leaks very little, but
 * "very little" is not a reason to leak it: an attacker who could distinguish
 * near-misses could walk a token out byte by byte.
 */
export function digestsEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

export type GatewayCredentialFailure = "malformed" | "unknown" | "expired" | "revoked";

export type GatewayCredentialResolution =
  | { ok: true; credential: GatewayCredentialRecord }
  | { ok: false; reason: GatewayCredentialFailure };

/**
 * Mints and resolves per-run gateway credentials.
 *
 * Nothing here decides whether a call may proceed — that is
 * `authorizeProxiedRunAccess` on the facts this resolves to. Keeping the two
 * apart is what stops the token from quietly becoming a second, weaker notion
 * of authorization.
 */
export class GatewayCredentialService {
  constructor(
    private readonly store: GatewayCredentialStore,
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs: number = GATEWAY_CREDENTIAL_TTL_MS,
  ) {}

  /**
   * Issue a credential for a run whose ownership the CALLER has already
   * verified. This method deliberately performs no authorization of its own:
   * being the mint AND the guard is how a mint ends up trusted with something
   * it never checked.
   */
  async mint(run: ProxiedRunFacts): Promise<MintedGatewayCredential> {
    // 32 bytes of CSPRNG. base64url so it survives a shell, a YAML file, an
    // HTTP header, and a TOML config without escaping.
    const secret = randomBytes(32).toString("base64url");
    const token = `${GATEWAY_TOKEN_PREFIX}${secret}`;
    const issued = this.now();
    const expires = new Date(issued.getTime() + this.ttlMs);
    await this.store.insert({
      id: newId("gwcred"),
      token_hash: hashGatewayToken(token),
      run_id: run.run_id,
      runner_id: run.runner_id,
      runner_generation: run.runner_generation,
      issued_at: issued.toISOString(),
      expires_at: expires.toISOString(),
      revoked_at: null,
    });
    return { token, expires_at: expires.toISOString() };
  }

  /**
   * Resolve a presented token to the run and generation it was minted for.
   *
   * Every failure is a distinct reason for the SERVER's audit trail only. What
   * goes back on the wire is one indistinguishable 401 — see `routes.ts`.
   */
  async resolve(token: string | null | undefined): Promise<GatewayCredentialResolution> {
    if (typeof token !== "string" || !token.startsWith(GATEWAY_TOKEN_PREFIX)) {
      return { ok: false, reason: "malformed" };
    }
    const presented = hashGatewayToken(token);
    const credential = await this.store.findByHash(presented);
    // findByHash matched on the hash already; re-comparing in constant time
    // costs nothing and removes any dependence on how the store compared.
    if (!credential) return { ok: false, reason: "unknown" };
    if (credential.revoked_at !== null) return { ok: false, reason: "revoked" };
    if (Date.parse(credential.expires_at) <= this.now().getTime()) {
      return { ok: false, reason: "expired" };
    }
    return { ok: true, credential };
  }

  revokeRun(runId: string): Promise<void> {
    return this.store.revokeRun(runId, this.now().toISOString());
  }

  purgeExpired(): Promise<number> {
    return this.store.purgeExpired(this.now().toISOString());
  }
}

// ---------------------------------------------------------------------------
// SQL store
// ---------------------------------------------------------------------------

/**
 * Postgres-backed credential storage.
 *
 * The plaintext token is never a column. `run_id` is a plain text column and
 * NOT a foreign key to `agent_runs`, deliberately: a credential row must be
 * insertable and readable even while the run row is being updated by the
 * coordinator, and authorization does not depend on this table's referential
 * integrity — it depends on re-resolving the run every request.
 */
export class SqlGatewayCredentialStore implements GatewayCredentialStore {
  constructor(private readonly transactions: V2TransactionRunner) {}

  async insert(record: GatewayCredentialRecord & { token_hash: string }): Promise<void> {
    await this.transactions.transaction(async (sql) => {
      await sql.query(
        `INSERT INTO gateway_credentials (
           id, token_hash, run_id, runner_id, runner_generation,
           issued_at, expires_at, revoked_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          record.id,
          record.token_hash,
          record.run_id,
          record.runner_id,
          record.runner_generation,
          record.issued_at,
          record.expires_at,
          record.revoked_at,
        ],
      );
    });
  }

  async findByHash(tokenHash: string): Promise<GatewayCredentialRecord | null> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{
        id: string;
        token_hash: string;
        run_id: string;
        runner_id: string;
        runner_generation: number | string;
        issued_at: string | Date;
        expires_at: string | Date;
        revoked_at: string | Date | null;
      }>(
        `SELECT id, token_hash, run_id, runner_id, runner_generation,
                issued_at, expires_at, revoked_at
         FROM gateway_credentials WHERE token_hash = $1 LIMIT 1`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (!row || !digestsEqual(row.token_hash, tokenHash)) return null;
      return {
        id: row.id,
        run_id: row.run_id,
        runner_id: row.runner_id,
        runner_generation: Number(row.runner_generation),
        issued_at: iso(row.issued_at),
        expires_at: iso(row.expires_at),
        revoked_at: row.revoked_at === null ? null : iso(row.revoked_at),
      };
    });
  }

  async revokeRun(runId: string, atIso: string): Promise<void> {
    await this.transactions.transaction(async (sql) => {
      await sql.query(
        "UPDATE gateway_credentials SET revoked_at = $2 WHERE run_id = $1 AND revoked_at IS NULL",
        [runId, atIso],
      );
    });
  }

  async purgeExpired(beforeIso: string): Promise<number> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{ id: string }>(
        "DELETE FROM gateway_credentials WHERE expires_at < $1 RETURNING id",
        [beforeIso],
      );
      return result.rows.length;
    });
  }
}

/** pglite hands back strings, node-postgres hands back Dates. Normalise. */
function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** In-memory store for tests and for a deployment with no relational option. */
export class InMemoryGatewayCredentialStore implements GatewayCredentialStore {
  private readonly rows = new Map<string, GatewayCredentialRecord & { token_hash: string }>();

  async insert(record: GatewayCredentialRecord & { token_hash: string }): Promise<void> {
    this.rows.set(record.token_hash, { ...record });
  }

  async findByHash(tokenHash: string): Promise<GatewayCredentialRecord | null> {
    const row = this.rows.get(tokenHash);
    return row ? { ...row } : null;
  }

  async revokeRun(runId: string, atIso: string): Promise<void> {
    for (const [hash, row] of this.rows) {
      if (row.run_id === runId && row.revoked_at === null) {
        this.rows.set(hash, { ...row, revoked_at: atIso });
      }
    }
  }

  async purgeExpired(beforeIso: string): Promise<number> {
    const cutoff = Date.parse(beforeIso);
    let removed = 0;
    for (const [hash, row] of this.rows) {
      if (Date.parse(row.expires_at) < cutoff) {
        this.rows.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }
}
