// EXECUTION E1: the task-context assembler, its storage, its runner-facing
// fetch route, and the honesty/size policies.
//
// The end-to-end case deliberately imports the REAL HashVerifiedContextLoader
// from @norns/runner rather than re-implementing hash verification here. Mocks
// of the runner side have hidden three dead paths in this codebase already; if
// the ref shape drifts from what the runner accepts, this test fails.
import { generateKeyPairSync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { HashVerifiedContextLoader } from "@norns/runner";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchContextScopeRepository } from "../src/coordinator/dispatchContextScope.js";
import {
  MAX_TOTAL_CONTEXT_BYTES,
  RUNNER_CONTEXT_RUNNER_ID_HEADER,
  RUNNER_CONTEXT_TIMESTAMP_HEADER,
  RelationalTaskContextAssembler,
  RunnerSignedContextFetcher,
  TASK_CONTEXT_ROUTE_PREFIX,
  TaskContextAssemblyError,
  TaskContextStore,
} from "../src/execution/index.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { listen } from "./helpers.js";

const PROJECT = "project-e1";
const PHASE = "phase-e1";
const STRATEGY = "strategy-e1";
const OBJECTIVE = "objective-e1";
const TASK = "task-e1";
const UPSTREAM = "task-e1-upstream";
const ARCHITECTURE = "arch-e1";
const ASSIGNMENT = "assignment-e1";
const PROFILE = "profile-e1";
const USER = "user-e1";
const RUNNER = "runner-e1";

const HASH_64 = "a".repeat(64);

describe.sequential("EXECUTION E1 — task context assembly", () => {
  let pg: PGlite;
  let transactions: PGliteTransactionRunner;

  async function seedBaseline(): Promise<void> {
    await pg.exec(`
      INSERT INTO users (
        id, username, display_name, email, name, password_hash,
        password_hash_scheme, role, status
      ) VALUES ('${USER}', 'pm@example.com', 'PM', 'pm@example.com', 'PM', 'x',
                'scrypt-v1', 'admin', 'active');
      INSERT INTO projects (
        id, name, description, status, current_architecture_revision_id,
        assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES (
        '${PROJECT}', 'Norns Demo', 'A demo project for E1.', 'active', NULL,
        'assignment/default', 'verification/strict', 'budget/default'
      );
      INSERT INTO phases (id, project_id, objective_summary, status, approved_strategy_version_id)
        VALUES ('${PHASE}', '${PROJECT}', 'Ship the execution path end to end.', 'proposed', NULL);
      INSERT INTO strategy_versions (
        id, project_id, phase_id, version, status, objective, content, convergence, content_hash
      ) VALUES (
        '${STRATEGY}', '${PROJECT}', '${PHASE}', 1, 'approved', 'Ship execution',
        '{}'::jsonb, 'converged', '${HASH_64}'
      );
      UPDATE phases SET status = 'approved', approved_strategy_version_id = '${STRATEGY}'
        WHERE id = '${PHASE}';
      INSERT INTO objectives (id, project_id, phase_id, outcome, success_measures, status, "order")
        VALUES ('${OBJECTIVE}', '${PROJECT}', '${PHASE}', 'A dispatched run produces a verified branch.',
                '["a run completes","tests pass"]'::jsonb, 'active', 0);
      INSERT INTO artifacts (
        id, project_id, kind, label, media_type, storage_ref, content_hash, byte_size,
        provenance_actor_type, provenance_actor_id, redaction_status
      ) VALUES (
        'artifact-e1', '${PROJECT}', 'architecture', 'Repository architecture', 'text/markdown',
        'https://example.com/arch', '${"c".repeat(64)}', 10, 'human', '${USER}', 'reviewed'
      );
      INSERT INTO architecture_revisions (
        id, project_id, revision, title, summary, architecture_artifact_id,
        repository_revision, provenance_actor_type, provenance_actor_id
      ) VALUES (
        '${ARCHITECTURE}', '${PROJECT}', 1, 'Monorepo', 'pnpm workspace: apps/server, apps/runner, packages/contracts.',
        'artifact-e1', 'abc123', 'human', '${USER}'
      );
      UPDATE projects SET current_architecture_revision_id = '${ARCHITECTURE}' WHERE id = '${PROJECT}';
      INSERT INTO agent_profiles (
        id, provider, runtime, model, roles, capabilities, context_limit_tokens, status, cost_metadata
      ) VALUES (
        '${PROFILE}', 'anthropic', 'claude-code', 'claude-opus-4-8', '["implementer"]'::jsonb,
        '[]'::jsonb, 200000, 'available', '{}'::jsonb
      );
    `);
    await seedTask(UPSTREAM, "Define the ref contract", "completed");
    await seedTask(TASK, "Assemble task context", "ready");
    await pg.exec(`
      INSERT INTO task_dependencies (id, project_id, phase_id, predecessor_task_id, successor_task_id)
        VALUES ('dep-e1', '${PROJECT}', '${PHASE}', '${UPSTREAM}', '${TASK}');
      INSERT INTO agent_assignments (
        id, project_id, phase_id, task_id, agent_profile_id, status, rationale,
        rationale_factors, allocation_policy_ref
      ) VALUES (
        '${ASSIGNMENT}', '${PROJECT}', '${PHASE}', '${TASK}', '${PROFILE}', 'active',
        'Strongest at typed backend work.', '{}'::jsonb, 'allocation/default'
      );
      UPDATE tasks SET designated_assignment_id = '${ASSIGNMENT}' WHERE id = '${TASK}';
    `);
    await seedFact("build_command", "pnpm run build", 0.99);
    await seedFact("test_command", "pnpm test", 0.99);
    await seedFact("lint_command", "pnpm biome check .", 0.9);
    await seedFact("package_manager", "pnpm", 0.8);
  }

  async function seedTask(id: string, title: string, state: string): Promise<void> {
    await pg.query(
      `INSERT INTO tasks (
         id, project_id, phase_id, objective_id, strategy_version_id, title, description,
         deliverables, acceptance_criteria, complexity, risk, required_roles,
         required_capabilities, required_inputs, expected_outputs,
         environment_policy_ref, verification_policy_ref, state, lifecycle_version,
         review_evidence, completion_evidence, created_at, completed_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,'M','medium',$10::jsonb,
                 '[]'::jsonb,'[]'::jsonb,$11::jsonb,'env/default','verification/strict',$12,1,
                 $14::jsonb,$14::jsonb,$13,$15)`,
      [
        id,
        PROJECT,
        PHASE,
        OBJECTIVE,
        STRATEGY,
        title,
        `Do the work described by ${title}.`,
        JSON.stringify([`${title} implemented`]),
        JSON.stringify([`${title} has tests`, "build is green"]),
        JSON.stringify(["implementer"]),
        JSON.stringify([`${title} output`]),
        state,
        // Fixed timestamps keep ordering — and therefore the content hash —
        // stable across runs.
        id === UPSTREAM ? "2026-01-01T00:00:00Z" : "2026-01-02T00:00:00Z",
        state === "completed"
          ? JSON.stringify([{ kind: "note", detail: `${title} verified` }])
          : "[]",
        state === "completed" ? "2026-01-01T12:00:00Z" : null,
      ],
    );
  }

  async function seedFact(key: string, value: string, confidence: number): Promise<void> {
    await pg.query(
      `INSERT INTO project_memory_entries (
         id, project_id, category, content, provenance, confidence, version, status, created_at
       ) VALUES ($1,$2,'repository_fact',$3,'repository_ingestion',$4,1,'active','2026-01-01T00:00:00Z')`,
      [`memory-fact-${key}`, PROJECT, `${key}: ${value}`, confidence],
    );
  }

  async function seedMemory(
    id: string,
    category: string,
    content: string,
    createdAt: string,
    approved = true,
  ): Promise<void> {
    await pg.query(
      `INSERT INTO project_memory_entries (
         id, project_id, category, content, provenance, confidence, version, status,
         approved_by_human, approved_by, approved_at, created_at
       ) VALUES ($1,$2,$3,$4,'human',1,1,'active',$5,$6,$7,$8)`,
      [
        id,
        PROJECT,
        category,
        content,
        approved,
        approved ? USER : null,
        approved ? createdAt : null,
        createdAt,
      ],
    );
  }

  function assembler(options?: { maxTotalBytes?: number }): RelationalTaskContextAssembler {
    return new RelationalTaskContextAssembler(transactions, new TaskContextStore(transactions), {
      baseUrl: "https://norns.example.com",
      ...options,
    });
  }

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    transactions = new PGliteTransactionRunner(pg);
    await seedBaseline();
  }, 60_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  // ---- ref shape ----------------------------------------------------------

  it("emits refs in the exact shape V2ContentAddressedReference requires", async () => {
    const refs = await assembler().assembleForTask(TASK);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(Object.keys(ref).sort()).toEqual([
        "artifact_id",
        "byte_size",
        "content_hash",
        "storage_ref",
      ]);
      expect(ref.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(ref.byte_size).toBeGreaterThan(0);
      expect(ref.storage_ref).toBe(
        `https://norns.example.com${TASK_CONTEXT_ROUTE_PREFIX}/${ref.artifact_id}`,
      );
    }
  });

  it("orders the prompt mission -> objective -> task -> dependencies -> repository -> directives -> memory", async () => {
    await seedMemory(
      "memory-directive",
      "directive",
      "Never push to main.",
      "2026-01-03T00:00:00Z",
    );
    await seedMemory("memory-lesson", "lesson", "Prefer PGlite in tests.", "2026-01-04T00:00:00Z");
    const store = new TaskContextStore(transactions);
    const refs = await assembler().assembleForTask(TASK);
    const documents: string[] = [];
    for (const ref of refs) {
      const content = await store.content(ref.artifact_id);
      documents.push(content?.bytes.toString("utf8") ?? "");
    }
    const headings = documents.map((doc) => doc.split("\n")[0]);
    expect(headings).toEqual([
      "# Norns task briefing",
      "## Phase objective",
      "## TASK — this is what you must deliver",
      "## Upstream tasks",
      "## Repository",
      "## Project directives and constraints",
      "## Project memory",
    ]);
    const prompt = documents.join("\n\n");
    expect(prompt).toContain("Assemble task context");
    expect(prompt).toContain("build is green"); // acceptance criterion
    expect(prompt).toContain("pnpm run build");
    expect(prompt).toContain("Never push to main.");
    expect(prompt).toContain("Strongest at typed backend work.");
    expect(prompt).toContain("Define the ref contract");
  });

  it("omits sections with nothing to say rather than emitting empty documents", async () => {
    // No directives, no approved memory, and the upstream edge removed.
    await pg.exec("DELETE FROM task_dependencies");
    const refs = await assembler().assembleForTask(TASK);
    const store = new TaskContextStore(transactions);
    const sections = await pg.query<{ section: string }>(
      "SELECT section FROM task_context_documents ORDER BY section",
    );
    expect(sections.rows.map((row) => row.section)).toEqual([
      "mission",
      "objective",
      "repository",
      "task",
    ]);
    for (const ref of refs) {
      expect((await store.content(ref.artifact_id))?.bytes.byteLength).toBeGreaterThan(0);
    }
  });

  // ---- determinism --------------------------------------------------------

  it("is deterministic: same task + same inputs => same hashes and same ids", async () => {
    const first = await assembler().assembleForTask(TASK);
    const second = await assembler().assembleForTask(TASK);
    expect(second).toEqual(first);
    // Re-assembly writes nothing new.
    const blobs = await pg.query<{ count: string }>(
      "SELECT count(*) AS count FROM task_context_blobs",
    );
    expect(Number(blobs.rows[0]?.count)).toBe(first.length);
  });

  it("changes the hash when an input changes", async () => {
    const before = await assembler().assembleForTask(TASK);
    await pg.exec(
      `UPDATE tasks SET acceptance_criteria = '["a different criterion"]'::jsonb WHERE id = '${TASK}'`,
    );
    const after = await assembler().assembleForTask(TASK);
    const taskRefBefore = before[2];
    const taskRefAfter = after[2];
    expect(taskRefAfter?.content_hash).not.toBe(taskRefBefore?.content_hash);
    // The unchanged sections keep their identity, so they are stored once.
    expect(after[0]).toEqual(before[0]);
    expect(after[4]).toEqual(before[4]);
  });

  it("shares repository and mission documents across tasks in a project", async () => {
    const refsA = await assembler().assembleForTask(TASK);
    const refsB = await assembler().assembleForTask(UPSTREAM);
    expect(refsB[0]).toEqual(refsA[0]); // mission
    const repositoryA = refsA.find((ref) => ref.storage_ref === refsA[4]?.storage_ref);
    expect(refsB.map((r) => r.artifact_id)).toContain(repositoryA?.artifact_id);
  });

  // ---- missing-input honesty ----------------------------------------------

  const missing: Array<{ name: string; code: string; setup: () => Promise<void> }> = [
    {
      name: "unknown task",
      code: "task_not_found",
      setup: async () => {},
    },
    {
      name: "no approved strategy",
      code: "strategy_not_approved",
      setup: async () => {
        await pg.exec(
          `UPDATE phases SET status = 'proposed', approved_strategy_version_id = NULL WHERE id = '${PHASE}'`,
        );
      },
    },
    {
      name: "task from a superseded strategy",
      code: "strategy_superseded",
      setup: async () => {
        await pg.exec(`
          INSERT INTO strategy_versions (
            id, project_id, phase_id, version, status, objective, content, convergence, content_hash
          ) VALUES ('strategy-e1-v2', '${PROJECT}', '${PHASE}', 2, 'approved', 'v2', '{}'::jsonb,
                    'converged', '${"b".repeat(64)}');
          UPDATE phases SET approved_strategy_version_id = 'strategy-e1-v2' WHERE id = '${PHASE}';
        `);
      },
    },
    {
      name: "no deliverables",
      code: "deliverables_missing",
      setup: async () => {
        await pg.exec(`UPDATE tasks SET deliverables = '[]'::jsonb WHERE id = '${TASK}'`);
      },
    },
    {
      name: "no acceptance criteria",
      code: "acceptance_criteria_missing",
      setup: async () => {
        await pg.exec(`UPDATE tasks SET acceptance_criteria = '[]'::jsonb WHERE id = '${TASK}'`);
      },
    },
    {
      name: "repository never ingested",
      code: "architecture_revision_missing",
      setup: async () => {
        await pg.exec(
          `UPDATE projects SET current_architecture_revision_id = NULL WHERE id = '${PROJECT}'`,
        );
      },
    },
    {
      name: "no repository facts",
      code: "repository_facts_missing",
      setup: async () => {
        await pg.exec("DELETE FROM project_memory_entries WHERE category = 'repository_fact'");
      },
    },
    {
      name: "no build/test/lint command",
      code: "verification_commands_missing",
      setup: async () => {
        await pg.exec(
          "DELETE FROM project_memory_entries WHERE id IN ('memory-fact-build_command','memory-fact-test_command','memory-fact-lint_command')",
        );
      },
    },
  ];

  for (const scenario of missing) {
    it(`refuses to assemble with ${scenario.name} (${scenario.code})`, async () => {
      await scenario.setup();
      const target = scenario.code === "task_not_found" ? "task-does-not-exist" : TASK;
      const error = await assembler()
        .assembleForTask(target)
        .then(
          () => null,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeInstanceOf(TaskContextAssemblyError);
      const assembly = error as TaskContextAssemblyError;
      expect(assembly.code).toBe(scenario.code);
      // Actionable: names the missing thing and the human step that fixes it.
      expect(assembly.message.length).toBeGreaterThan(20);
      expect(assembly.action_required.length).toBeGreaterThan(20);
      // Nothing half-assembled was persisted.
      const stored = await pg.query<{ count: string }>(
        "SELECT count(*) AS count FROM task_context_documents",
      );
      expect(Number(stored.rows[0]?.count)).toBe(0);
    });
  }

  it("never invents repository facts", async () => {
    const refs = await assembler().assembleForTask(TASK);
    const store = new TaskContextStore(transactions);
    const repository = (await store.content(refs[4]?.artifact_id ?? ""))?.bytes.toString("utf8");
    expect(repository).toContain("pnpm biome check .");
    // Only seeded facts appear; no invented key sneaks in.
    const factLines = (repository ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- ") && line.includes(":"));
    for (const line of factLines) {
      expect(
        [
          "build_command",
          "test_command",
          "lint_command",
          "package_manager",
          "Project policy",
          "Task policy",
        ].some((key) => line.includes(key)),
      ).toBe(true);
    }
  });

  // ---- size discipline ----------------------------------------------------

  it("defaults to a 256 KiB total cap", () => {
    expect(MAX_TOTAL_CONTEXT_BYTES).toBe(256 * 1024);
  });

  it("trims oldest memory first, then upstream detail, then low-confidence facts", async () => {
    await seedMemory("memory-old", "lesson", `OLD ${"o".repeat(400)}`, "2026-01-03T00:00:00Z");
    await seedMemory("memory-new", "lesson", `NEW ${"n".repeat(400)}`, "2026-01-05T00:00:00Z");
    const store = new TaskContextStore(transactions);

    const full = await assembler().assembleForTask(TASK);
    const fullBytes = full.reduce((sum, ref) => sum + ref.byte_size, 0);

    // Cap just under the untrimmed size: the oldest memory entry goes first and
    // the newer one survives.
    const trimmed = await assembler({ maxTotalBytes: fullBytes - 100 }).assembleForTask(TASK);
    const trimmedText = (await Promise.all(trimmed.map((ref) => store.content(ref.artifact_id))))
      .map((doc) => doc?.bytes.toString("utf8") ?? "")
      .join("\n\n");
    expect(trimmedText).toContain("NEW");
    expect(trimmedText).not.toContain("OLD");
    // Acceptance criteria survive trimming that removes memory.
    expect(trimmedText).toContain("build is green");

    // Tighter still: memory goes entirely, then upstream detail collapses, then
    // the least-confident non-policy fact goes — but the commands never do.
    // The cap is derived from the untrimmable sections (mission, objective,
    // task, repository) so the test does not hard-code a byte count.
    const core =
      (full[0]?.byte_size ?? 0) +
      (full[1]?.byte_size ?? 0) +
      (full[2]?.byte_size ?? 0) +
      (full[4]?.byte_size ?? 0);
    const tightCap = core - 20;
    const tight = await assembler({ maxTotalBytes: tightCap }).assembleForTask(TASK);
    const tightText = (await Promise.all(tight.map((ref) => store.content(ref.artifact_id))))
      .map((doc) => doc?.bytes.toString("utf8") ?? "")
      .join("\n\n");
    expect(tightText).not.toContain("## Project memory");
    expect(tightText).not.toContain("package_manager");
    expect(tightText).toContain("pnpm run build");
    expect(tightText).toContain("pnpm test");
    expect(tightText).toContain("build is green");
    expect(tightText).not.toContain("## Upstream tasks");
    expect(tight.reduce((sum, ref) => sum + ref.byte_size, 0)).toBeLessThanOrEqual(tightCap);
  });

  it("fails rather than truncating when the untrimmable core exceeds the cap", async () => {
    const error = await assembler({ maxTotalBytes: 512 })
      .assembleForTask(TASK)
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(TaskContextAssemblyError);
    expect((error as TaskContextAssemblyError).code).toBe("context_too_large");
  });

  it("rejects a non-HTTPS base URL the runner would refuse anyway", () => {
    expect(
      () =>
        new RelationalTaskContextAssembler(transactions, new TaskContextStore(transactions), {
          baseUrl: "http://norns.example.com",
        }),
    ).toThrow(/must be HTTPS/);
  });

  // ---- the fetch route + the real runner loader ---------------------------

  describe("runner-facing fetch route", () => {
    let server: NornsServer;
    let origin: string;
    let privateKeyPem: string;
    let dispatchScope: DispatchContextScopeRepository;

    beforeEach(async () => {
      const stores = new RelayStores();
      const keys = generateKeyPairSync("ed25519");
      privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      stores.registerRunner(
        RUNNER,
        keys.publicKey.export({ type: "spki", format: "pem" }).toString(),
      );
      const users = new UserStore();
      server = await buildServer({
        stores,
        users,
        projects: new ProjectStore(),
        execution: { transactions, baseUrl: "http://127.0.0.1" },
      });
      origin = await listen(server);
      dispatchScope = new DispatchContextScopeRepository(transactions);
    });

    afterEach(async () => {
      await server.app.close();
    });

    function rebase(storageRef: string): string {
      return `${origin}${new URL(storageRef).pathname}`;
    }

    // EXECUTION E2: the fetch route now ALSO requires a
    // dispatch_context_documents row naming this runner for the exact
    // document requested (authorization on top of E1's authentication). Every
    // case below models the realistic sequence — the document is scoped to
    // the runner the moment a task is actually scheduled — before exercising
    // E1's own signature/hash/existence behavior, so this suite still proves
    // what it proved before E2 landed, against the now-stricter route.
    async function authorize(
      refs: ReadonlyArray<{ artifact_id: string; content_hash: string; byte_size: number }>,
    ): Promise<void> {
      await dispatchScope.recordScope(
        { runnerId: RUNNER, dispatchJobId: "dispatch-job:test", runId: "run:test" },
        refs.map((ref) => ({ ...ref, storage_ref: "unused://scope-only" })),
      );
    }

    it("is exposed on NornsServer for E2's trigger", () => {
      expect(server.taskContext).toBeDefined();
    });

    it("serves bytes the REAL HashVerifiedContextLoader verifies and accepts", async () => {
      const refs = (await server.taskContext?.assembleForTask(TASK)) ?? [];
      expect(refs.length).toBeGreaterThan(0);
      await authorize(refs);
      const loader = new HashVerifiedContextLoader(
        new RunnerSignedContextFetcher(RUNNER, privateKeyPem),
      );
      const prompt = await loader.load(
        refs.map((ref) => ({ ...ref, storage_ref: rebase(ref.storage_ref) })),
      );
      expect(prompt).toContain("# Norns task briefing");
      expect(prompt).toContain("## TASK — this is what you must deliver");
      expect(prompt).toContain("pnpm run build");
    });

    it("makes the loader reject a tampered content_hash", async () => {
      const refs = (await server.taskContext?.assembleForTask(TASK)) ?? [];
      await authorize(refs);
      const loader = new HashVerifiedContextLoader(
        new RunnerSignedContextFetcher(RUNNER, privateKeyPem),
      );
      const first = refs[0];
      if (!first) throw new Error("no refs");
      await expect(
        loader.load([
          { ...first, storage_ref: rebase(first.storage_ref), content_hash: "f".repeat(64) },
        ]),
      ).rejects.toThrow(/content hash mismatch/);
    });

    it("rejects an unsigned request", async () => {
      const refs = (await server.taskContext?.assembleForTask(TASK)) ?? [];
      const response = await fetch(rebase(refs[0]?.storage_ref ?? ""));
      expect(response.status).toBe(401);
    });

    it("rejects a signature from an unknown runner", async () => {
      const refs = (await server.taskContext?.assembleForTask(TASK)) ?? [];
      const fetcher = new RunnerSignedContextFetcher("runner-nobody", privateKeyPem);
      await expect(
        fetcher.fetch({ storage_ref: rebase(refs[0]?.storage_ref ?? "") }),
      ).rejects.toThrow(/401/);
    });

    it("rejects a signature over a different path (no cross-document replay)", async () => {
      const refs = (await server.taskContext?.assembleForTask(TASK)) ?? [];
      const [first, second] = refs;
      if (!first || !second) throw new Error("need two refs");
      // Sign for `first`, then present the credential against `second`.
      let captured: { url: string; headers: Record<string, string> } | null = null;
      const capturing = new RunnerSignedContextFetcher(
        RUNNER,
        privateKeyPem,
        () => new Date(),
        async (input, init) => {
          captured = {
            url: String(input),
            headers: (init?.headers ?? {}) as Record<string, string>,
          };
          return new Response(new Uint8Array(), { status: 200 });
        },
      );
      await capturing.fetch({ storage_ref: rebase(first.storage_ref) });
      if (!captured) throw new Error("no captured request");
      const replay = await fetch(rebase(second.storage_ref), {
        headers: (captured as { headers: Record<string, string> }).headers,
      });
      expect(replay.status).toBe(401);
    });

    it("rejects a stale timestamp", async () => {
      const refs = (await server.taskContext?.assembleForTask(TASK)) ?? [];
      const stale = new RunnerSignedContextFetcher(
        RUNNER,
        privateKeyPem,
        () => new Date(Date.now() - 10 * 60_000),
      );
      await expect(
        stale.fetch({ storage_ref: rebase(refs[0]?.storage_ref ?? "") }),
      ).rejects.toThrow(/401/);
    });

    it("404s an unknown document for an authenticated, authorized runner", async () => {
      // Authorized for this exact (never-created) document id, so the 404
      // proves existence is checked, not just masked behind a 403 — the
      // authorization check alone is covered by the dispatch-scope suite.
      await authorize([
        { artifact_id: "taskctx_missing", content_hash: "a".repeat(64), byte_size: 1 },
      ]);
      const fetcher = new RunnerSignedContextFetcher(RUNNER, privateKeyPem);
      await expect(
        fetcher.fetch({ storage_ref: `${origin}${TASK_CONTEXT_ROUTE_PREFIX}/taskctx_missing` }),
      ).rejects.toThrow(/404/);
    });

    it("403s a document the runner was never scoped to, before existence is checked", async () => {
      const refs = (await server.taskContext?.assembleForTask(TASK)) ?? [];
      const first = refs[0];
      if (!first) throw new Error("no refs");
      // Deliberately no `authorize(...)` call: a valid signature from a real,
      // paired runner is not enough on its own (E2's fix for the E1 gap).
      const fetcher = new RunnerSignedContextFetcher(RUNNER, privateKeyPem);
      await expect(fetcher.fetch({ storage_ref: rebase(first.storage_ref) })).rejects.toThrow(
        /403/,
      );
    });

    it("sends the runner id and timestamp headers it signs over", async () => {
      const refs = (await server.taskContext?.assembleForTask(TASK)) ?? [];
      let headers: Record<string, string> = {};
      const capturing = new RunnerSignedContextFetcher(
        RUNNER,
        privateKeyPem,
        () => new Date(),
        async (_input, init) => {
          headers = (init?.headers ?? {}) as Record<string, string>;
          return new Response(new Uint8Array([1]), { status: 200 });
        },
      );
      await capturing.fetch({ storage_ref: rebase(refs[0]?.storage_ref ?? "") });
      expect(headers[RUNNER_CONTEXT_RUNNER_ID_HEADER]).toBe(RUNNER);
      expect(headers[RUNNER_CONTEXT_TIMESTAMP_HEADER]).toMatch(/^\d{4}-/);
      expect(headers.authorization).toMatch(/^Norns-Runner /);
    });
  });
});
