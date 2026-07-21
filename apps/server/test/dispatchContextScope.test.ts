// EXECUTION E2: `DispatchContextScopeRepository` in isolation — the missing
// authorization layer on top of E1's authentication-only fetch route. A
// direct unit test alongside the HTTP-level proof in
// executionTaskContext.test.ts's "runner-facing fetch route" suite and
// phaseLaunchService.test.ts's end-to-end scheduling test.
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchContextScopeRepository } from "../src/coordinator/dispatchContextScope.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";

describe.sequential("EXECUTION E2 — DispatchContextScopeRepository", () => {
  let pg: PGlite;
  let repo: DispatchContextScopeRepository;

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    repo = new DispatchContextScopeRepository(new PGliteTransactionRunner(pg));
  }, 60_000);

  afterEach(async () => {
    if (!pg.closed) await pg.close();
  });

  const ref = (artifactId: string) => ({
    artifact_id: artifactId,
    content_hash: "a".repeat(64),
    byte_size: 10,
    storage_ref: `https://norns.example.com/api/v2/execution/task-context/${artifactId}`,
  });

  it("is unauthorized for a document that was never scoped to any runner", async () => {
    expect(await repo.isAuthorized("runner-1", "doc-1")).toBe(false);
  });

  it("authorizes exactly the runner recorded for exactly the document scoped to it", async () => {
    await repo.recordScope(
      { runnerId: "runner-1", dispatchJobId: "dispatch-job:run-1", runId: "run-1" },
      [ref("doc-1"), ref("doc-2")],
    );
    expect(await repo.isAuthorized("runner-1", "doc-1")).toBe(true);
    expect(await repo.isAuthorized("runner-1", "doc-2")).toBe(true);
    // Neither a different document nor a different runner is authorized.
    expect(await repo.isAuthorized("runner-1", "doc-3")).toBe(false);
    expect(await repo.isAuthorized("runner-2", "doc-1")).toBe(false);
  });

  it("is a no-op for an empty ref list (never writes a row)", async () => {
    await repo.recordScope(
      { runnerId: "runner-1", dispatchJobId: "dispatch-job:run-1", runId: "run-1" },
      [],
    );
    const rows = await pg.query<{ count: string }>(
      "SELECT count(*) AS count FROM dispatch_context_documents",
    );
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });

  it("refreshes the scope to the latest dispatch when the same shared document is re-dispatched to the same runner", async () => {
    // Project-shared documents (repository/directives/memory sections) are
    // content-addressed and reused across every task in a project, so the
    // same runner is legitimately re-dispatched the same document under a
    // new dispatch job — the row is refreshed in place, not duplicated.
    await repo.recordScope(
      { runnerId: "runner-1", dispatchJobId: "dispatch-job:run-1", runId: "run-1" },
      [ref("shared-doc")],
    );
    await repo.recordScope(
      { runnerId: "runner-1", dispatchJobId: "dispatch-job:run-2", runId: "run-2" },
      [ref("shared-doc")],
    );
    expect(await repo.isAuthorized("runner-1", "shared-doc")).toBe(true);
    const rows = await pg.query<{ count: string; dispatch_job_id: string; run_id: string }>(
      "SELECT count(*) AS count FROM dispatch_context_documents WHERE runner_id = 'runner-1' AND context_document_id = 'shared-doc'",
    );
    expect(Number(rows.rows[0]?.count)).toBe(1);
    const row = await pg.query<{ dispatch_job_id: string; run_id: string }>(
      "SELECT dispatch_job_id, run_id FROM dispatch_context_documents WHERE runner_id = 'runner-1' AND context_document_id = 'shared-doc'",
    );
    expect(row.rows[0]).toEqual({ dispatch_job_id: "dispatch-job:run-2", run_id: "run-2" });
  });

  it("scopes the same document independently per runner (one runner's dispatch never authorizes another)", async () => {
    await repo.recordScope(
      { runnerId: "runner-1", dispatchJobId: "dispatch-job:run-1", runId: "run-1" },
      [ref("shared-doc")],
    );
    expect(await repo.isAuthorized("runner-2", "shared-doc")).toBe(false);
    await repo.recordScope(
      { runnerId: "runner-2", dispatchJobId: "dispatch-job:run-3", runId: "run-3" },
      [ref("shared-doc")],
    );
    expect(await repo.isAuthorized("runner-1", "shared-doc")).toBe(true);
    expect(await repo.isAuthorized("runner-2", "shared-doc")).toBe(true);
  });
});
