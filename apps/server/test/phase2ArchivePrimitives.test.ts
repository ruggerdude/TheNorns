import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LegacyArchiveCryptoError,
  decryptLegacyArchive,
  encryptLegacyArchive,
} from "../src/persistence/migration/archiveCrypto.js";
import { canonicalJson, canonicalSha256 } from "../src/persistence/migration/canonicalJson.js";
import { analyzeLegacySnapshot } from "../src/persistence/migration/legacySnapshots.js";
import { buildLegacyRecoveryCheckpoint } from "../src/persistence/migration/snapshotCapture.js";

const KEY = {
  keyId: "archive-key-2026-07",
  key: Buffer.alloc(32, 7),
};

const CONTEXT = {
  archive_id: "archive:run-1:users",
  migration_run_id: "run-1",
  source_key: "users",
  exact_text_sha256: "a".repeat(64),
  semantic_sha256: "b".repeat(64),
  source_frozen_at: "2026-07-16T20:00:00.000Z",
};

describe("Phase 2 canonical JSON", () => {
  it("sorts every object while preserving array order and JSON number semantics", () => {
    const left = {
      z: 1,
      a: { y: true, x: ["second", "first"] },
      negativeZero: -0,
    };
    const right = {
      negativeZero: 0,
      a: { x: ["second", "first"], y: true },
      z: 1,
    };

    expect(canonicalJson(left)).toBe(
      '{"a":{"x":["second","first"],"y":true},"negativeZero":0,"z":1}',
    );
    expect(canonicalJson(right)).toBe(canonicalJson(left));
    expect(canonicalSha256(right)).toBe(canonicalSha256(left));
  });

  it("rejects values PostgreSQL JSONB cannot faithfully represent", () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);

    const sparse = new Array(2);
    sparse[1] = "present";
    expect(() => canonicalJson(sparse)).toThrow(/sparse/);
  });
});

describe("Phase 2 encrypted legacy archives", () => {
  it("binds AES-256-GCM ciphertext to the key ID and authenticated context", () => {
    const plaintext = Buffer.from('{"token":"raw-secret-that-must-stay-encrypted"}');
    const encrypted = encryptLegacyArchive(plaintext, KEY, CONTEXT, (size) =>
      Buffer.alloc(size, 3),
    );

    expect(encrypted.algorithm).toBe("aes-256-gcm");
    expect(encrypted.key_id).toBe(KEY.keyId);
    expect(encrypted.nonce_base64).toBe(Buffer.alloc(12, 3).toString("base64"));
    expect(JSON.stringify(encrypted)).not.toContain("raw-secret-that-must-stay-encrypted");
    expect(decryptLegacyArchive(encrypted, KEY, CONTEXT)).toEqual(plaintext);

    expect(() =>
      decryptLegacyArchive(encrypted, KEY, { ...CONTEXT, source_key: "projects" }),
    ).toThrow(LegacyArchiveCryptoError);
    expect(() =>
      decryptLegacyArchive(encrypted, { keyId: "different", key: KEY.key }, CONTEXT),
    ).toThrow(LegacyArchiveCryptoError);
  });

  it("rejects ciphertext and authentication-tag tampering", () => {
    const encrypted = encryptLegacyArchive(Buffer.from("checkpoint"), KEY, CONTEXT, (size) =>
      Buffer.alloc(size, 4),
    );
    const changedCiphertext = Buffer.from(encrypted.ciphertext_base64, "base64");
    changedCiphertext[0] = (changedCiphertext[0] ?? 0) ^ 1;
    expect(() =>
      decryptLegacyArchive(
        { ...encrypted, ciphertext_base64: changedCiphertext.toString("base64") },
        KEY,
        CONTEXT,
      ),
    ).toThrow(/checksum/);

    const changedTag = Buffer.from(encrypted.auth_tag_base64, "base64");
    changedTag[0] = (changedTag[0] ?? 0) ^ 1;
    expect(() =>
      decryptLegacyArchive(
        { ...encrypted, auth_tag_base64: changedTag.toString("base64") },
        KEY,
        CONTEXT,
      ),
    ).toThrow(/authentication failed/);
  });
});

describe("Phase 2 legacy snapshot analysis and checkpoint assembly", () => {
  const users = {
    futureEnvelopeField: "preserved",
    sessions: [
      {
        token: "legacy-session-token",
        userId: "user-admin",
        createdAt: "2026-07-16T19:01:00.000Z",
      },
    ],
    users: [
      {
        id: "user-admin",
        email: "admin@example.com",
        name: "Admin",
        role: "admin",
        status: "active",
        passwordHash: "aa:bb",
        inviteToken: null,
        createdAt: "2026-07-16T19:00:00.000Z",
        futureUserField: 1,
      },
      {
        id: "user-invited",
        email: "invited@example.com",
        name: null,
        role: "member",
        status: "invited",
        passwordHash: null,
        inviteToken: "legacy-invite-token",
        createdAt: "2026-07-16T19:02:00.000Z",
      },
    ],
  };
  const projects = {
    projects: [
      {
        id: "project-1",
        name: "Project",
        description: "Description",
        pmProvider: "anthropic",
        createdAt: "2026-07-16T19:03:00.000Z",
        plan: { objective: "Ship" },
        graph: {
          version: 3,
          nodes: [
            { id: "a", dependencies: [], assignment: { provider: "anthropic" } },
            { id: "b", dependencies: ["a"], assignment: null },
          ],
        },
        approval: { content_hash: "approval" },
      },
    ],
  };
  const relay = {
    runners: { "runner-1": { generation: 1 } },
    commands: {
      "command-1": { updated_at: "2026-07-16T19:04:00.000Z", state: "queued" },
    },
    eventsByRunner: { "runner-1": [{ event_seq: 1 }, { event_seq: 2 }] },
    watermark: { "runner-1": 2 },
    audit: [
      {
        at: "2026-07-16T19:05:00.000Z",
        actor: "admin@example.com",
        action: "project.created",
        detail: "project-1",
      },
    ],
    pairings: {},
    killSwitch: false,
  };

  it("parses tolerant explicit shapes and emits non-secret counts and last markers", () => {
    const userAnalysis = analyzeLegacySnapshot("users", users);
    expect(userAnalysis.object_counts).toEqual({
      users: 2,
      active_users: 1,
      invited_users: 1,
      admins: 1,
      active_admins: 1,
      sessions: 1,
      invitation_tokens: 1,
    });
    expect(userAnalysis.last_included_record).toMatchObject({
      last_user: { user_id: "user-invited" },
      last_session: { user_id_and_ordinal: "user-admin:0" },
    });
    expect(JSON.stringify(userAnalysis.last_included_record)).not.toContain("legacy-session-token");

    expect(analyzeLegacySnapshot("projects", projects).object_counts).toMatchObject({
      projects: 1,
      plans: 1,
      graph_nodes: 2,
      dependency_edges: 1,
      assignments: 1,
      approvals: 1,
    });
    const relayAnalysis = analyzeLegacySnapshot("relay", relay);
    expect(relayAnalysis.object_counts).toMatchObject({
      runners: 1,
      commands: 1,
      event_streams: 1,
      runner_events: 2,
      audit_entries: 1,
      watermarks: 1,
    });
    expect(relayAnalysis.nonterminal_commands).toEqual([
      {
        command_id: "command-1",
        state: "queued",
        updated_at: "2026-07-16T19:04:00.000Z",
      },
    ]);
  });

  it("builds a stable source manifest and three encrypted archive records", () => {
    let nonceSeed = 0;
    const checkpoint = buildLegacyRecoveryCheckpoint({
      migration_run_id: "migration-phase2-1",
      source_frozen_at: "2026-07-16T20:00:00.000Z",
      recovery_marker: {
        provider: "railway",
        backup_reference: "backup-1",
        database_time: "2026-07-16T20:00:00.000Z",
        wal_lsn: "0/16B6A50",
        transaction_id: "12345",
        application_version: "0.1.0",
        application_commit: "deadbeef",
      },
      retention_expires_at: "2026-08-16T20:00:00.000Z",
      encryption_key: KEY,
      random_bytes: (size) => {
        nonceSeed += 1;
        return Buffer.alloc(size, nonceSeed);
      },
      sources: [
        {
          key: "relay",
          source_text: JSON.stringify(relay, null, 2),
          updated_at: "2026-07-16T19:59:03.000Z",
        },
        {
          key: "users",
          source_text: JSON.stringify(users, null, 2),
          updated_at: "2026-07-16T19:59:01.000Z",
        },
        {
          key: "projects",
          source_text: JSON.stringify(projects, null, 2),
          updated_at: "2026-07-16T19:59:02.000Z",
        },
        {
          key: "graph",
          source_text: '{ "legacy": true, "nodes": [1, 2] }',
          updated_at: "2026-07-16T19:58:00.000Z",
        },
      ],
    });

    expect(checkpoint.archives.map((archive) => archive.source_key)).toEqual([
      "users",
      "projects",
      "relay",
      "graph",
    ]);
    expect(checkpoint.manifest.source_snapshot_hashes.users).toBe(canonicalSha256(users));
    expect(checkpoint.manifest.source_exact_text_hashes.users).toBe(
      createHash("sha256")
        .update(JSON.stringify(users, null, 2))
        .digest("hex"),
    );
    expect(checkpoint.manifest.source_exact_text_hashes.users).not.toBe(
      checkpoint.manifest.source_semantic_hashes.users,
    );
    expect(checkpoint.manifest.source_counts.users?.sessions).toBe(1);
    expect(checkpoint.manifest.unknown_keys).toEqual(["graph"]);
    expect(checkpoint.manifest.findings).toEqual([
      { code: "unknown_snapshot_key", source_key: "graph" },
      {
        code: "nonterminal_legacy_command",
        source_key: "relay",
        command_id: "command-1",
        state: "queued",
        updated_at: "2026-07-16T19:04:00.000Z",
        source_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    ]);
    expect(checkpoint.manifest.source_bundle_hash).toMatch(/^[a-f0-9]{64}$/);

    for (const archive of checkpoint.archives) {
      const exactSource =
        archive.source_key === "users"
          ? JSON.stringify(users, null, 2)
          : archive.source_key === "projects"
            ? JSON.stringify(projects, null, 2)
            : archive.source_key === "relay"
              ? JSON.stringify(relay, null, 2)
              : '{ "legacy": true, "nodes": [1, 2] }';
      expect(archive.source_text_byte_length).toBe(Buffer.byteLength(exactSource));
      expect(archive.exact_text_sha256).toBe(
        createHash("sha256").update(exactSource).digest("hex"),
      );
      expect(JSON.stringify(archive.encrypted)).not.toContain("legacy-session-token");
      expect(
        decryptLegacyArchive(archive.encrypted, KEY, {
          archive_id: archive.archive_id,
          migration_run_id: archive.migration_run_id,
          source_key: archive.source_key,
          exact_text_sha256: archive.exact_text_sha256,
          semantic_sha256: archive.semantic_sha256,
          source_frozen_at: archive.source_frozen_at,
        }).toString("utf8"),
      ).toBe(exactSource);
    }
  });

  it("requires exactly one of each governed snapshot source", () => {
    expect(() =>
      buildLegacyRecoveryCheckpoint({
        migration_run_id: "migration-phase2-1",
        source_frozen_at: "2026-07-16T20:00:00.000Z",
        recovery_marker: {
          provider: "railway",
          backup_reference: "backup-1",
          database_time: "2026-07-16T20:00:00.000Z",
          wal_lsn: "0/16B6A50",
          transaction_id: "12345",
          application_version: "0.1.0",
          application_commit: "deadbeef",
        },
        retention_expires_at: "2026-08-16T20:00:00.000Z",
        encryption_key: KEY,
        sources: [
          {
            key: "users",
            source_text: JSON.stringify(users),
            updated_at: "2026-07-16T19:59:01.000Z",
          },
          {
            key: "projects",
            source_text: JSON.stringify(projects),
            updated_at: "2026-07-16T19:59:02.000Z",
          },
        ],
      }),
    ).toThrow(/missing legacy snapshot source: relay/);
  });
});
