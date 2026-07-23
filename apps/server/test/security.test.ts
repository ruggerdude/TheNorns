// Phase 8 security & resilience gate (the locally-provable set): planted-
// secret redaction end to end, audit completeness for every mutating action,
// terminal-race conflict rules, replay rejection, kill-switch dispatch
// refusal, dispatch-loop lease recovery, strict approval hashes, the
// merge-to-main gate, and durable-state restore fidelity. Live sandbox-escape
// (Docker host) and deployed backup-restore (Neon) remain gated — NORN-008.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventEnvelopeT } from "@norns/contracts";
import { REDACTED, Redactor } from "@norns/runner";
import { afterEach, describe, expect, it } from "vitest";
import { DispatchStore } from "../src/engine/dispatch.js";
import { DispatchLoop } from "../src/engine/dispatchLoop.js";
import { LocalGitRepo } from "../src/engine/git.js";
import {
  MergeApprovalError,
  integrationHeadHash,
  mergeIntegrationToMain,
} from "../src/engine/release.js";
import { RelayStores } from "../src/stores.js";
import { type Stack, startStack, waitFor } from "./helpers.js";

let stack: Stack | null = null;

afterEach(async () => {
  await stack?.stop();
  stack = null;
});

const PLANTED = "sk-ant-PLANTED-SECRET-0123456789abcdef";

describe("phase 8 — secret redaction", () => {
  it("redacts known injected credentials and common secret shapes", () => {
    const redactor = new Redactor();
    redactor.registerSecret("hunter2-secret-value");
    const input = [
      "injected: hunter2-secret-value",
      "key: sk-ant-abc123def456ghi789jkl",
      "gh: ghp_abcdefghijklmnopqrstuv123456",
      "aws: AKIAIOSFODNN7EXAMPLE",
      "cfg: password=SuperSecret123",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
    ].join("\n");
    const out = redactor.redact(input);
    expect(out).not.toContain("hunter2-secret-value");
    expect(out).not.toContain("sk-ant-abc123");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("SuperSecret123");
    expect(out).not.toContain("BEGIN PRIVATE KEY");
    expect(out.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("a planted secret in run logs NEVER reaches the server — redacted before buffering", async () => {
    stack = await startStack();
    stack.daemon.redactor.registerSecret(PLANTED);
    await stack.issue({ kind: "launch_fixture", fixture: `leak:${PLANTED}` });

    await waitFor(async () => {
      const events = (await (
        await (stack as Stack).api("/api/events/runner-1")
      ).json()) as EventEnvelopeT[];
      return events.some(
        (e) => e.payload.kind === "run_status" && e.payload.status === "completed",
      );
    }, "leak fixture completed");

    const events = (await (await stack.api("/api/events/runner-1")).json()) as EventEnvelopeT[];
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(PLANTED); // nothing server-side carries it
    const leakLog = events.find((e) => e.payload.kind === "run_log");
    expect(leakLog && leakLog.payload.kind === "run_log" ? leakLog.payload.chunk : "").toContain(
      REDACTED,
    );
  });
});

describe("phase 8 — audit completeness", () => {
  it("every mutating relay action lands in the audit trail", async () => {
    stack = await startStack();
    await stack.issue({ kind: "launch_fixture", fixture: "count:1:10" });
    await stack.api("/api/kill-switch", {
      method: "POST",
      body: JSON.stringify({ engaged: true }),
    });
    await stack.api("/api/kill-switch", {
      method: "POST",
      body: JSON.stringify({ engaged: false }),
    });
    await fetch(`${stack.url}/api/audit`); // unauthenticated probe

    await waitFor(async () => {
      const audit = (await (await (stack as Stack).api("/api/audit")).json()) as {
        action: string;
      }[];
      return audit.some((a) => a.action === "command.ack");
    }, "acks audited");

    const audit = (await (await stack.api("/api/audit")).json()) as { action: string }[];
    const actions = new Set(audit.map((a) => a.action));
    for (const required of [
      "runner.connected",
      "command.issued",
      "command.delivered",
      "command.ack",
      "kill_switch",
      "auth.rejected",
    ]) {
      expect(actions, `audit contains ${required}`).toContain(required);
    }
  });
});

describe("phase 8 — protocol races and replay", () => {
  it("first terminal commits: a losing terminal ack is recorded, never applied", () => {
    const stores = new RelayStores();
    stores.registerRunner("r1", "pem");
    const now = new Date();
    stores.enqueueCommand(
      {
        protocol: 1,
        command_id: "cmd-race",
        idempotency_key: "cmd-race",
        correlation_id: "corr",
        causation_id: null,
        project_id: "p",
        runner_id: "r1",
        generation: 1,
        issued_by_session: "operator",
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 60_000).toISOString(),
        payload: { kind: "cancel", run_id: "run-1" },
      },
      now,
    );
    stores.setCommandState("cmd-race", "delivered", now);
    stores.setCommandState("cmd-race", "accepted", now);
    stores.setCommandState("cmd-race", "executing", now);
    stores.setCommandState("cmd-race", "succeeded", now); // completion wins
    stores.setCommandState("cmd-race", "cancelled", now); // cancel loses the race
    const record = stores.command("cmd-race");
    expect(record?.state).toBe("succeeded");
    expect(record?.superseded_terminal).toBe("cancelled"); // recorded, not applied
  });

  it("replayed and out-of-order events are rejected without corrupting the log", () => {
    const stores = new RelayStores();
    const event = (seq: number): EventEnvelopeT => ({
      protocol: 1,
      event_seq: seq,
      runner_id: "r1",
      generation: 1,
      correlation_id: "corr",
      causation_id: null,
      occurred_at: new Date().toISOString(),
      payload: { kind: "heartbeat" },
    });
    expect(stores.ingestEvent(event(1))).toBe("accepted");
    expect(stores.ingestEvent(event(2))).toBe("accepted");
    expect(stores.ingestEvent(event(1))).toBe("duplicate"); // replay attack
    expect(stores.ingestEvent(event(5))).toBe("out_of_order"); // gap forces resync
    expect(stores.eventsFor("r1")).toHaveLength(2);
    expect(stores.eventWatermark("r1")).toBe(2);
  });

  it("durable snapshot restores with full fidelity (local restore test)", async () => {
    stack = await startStack();
    await stack.issue({ kind: "launch_fixture", fixture: "count:2:10" });
    await waitFor(async () => {
      const events = (await (
        await (stack as Stack).api("/api/events/runner-1")
      ).json()) as EventEnvelopeT[];
      return events.some(
        (e) => e.payload.kind === "run_status" && e.payload.status === "completed",
      );
    }, "run completed");

    const snapshot = stack.server.stores.snapshot();
    const restored = RelayStores.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot); // byte-fidelity roundtrip
    expect(restored.eventWatermark("runner-1")).toBe(
      stack.server.stores.eventWatermark("runner-1"),
    );
    expect(restored.auditEntries().length).toBe(stack.server.stores.auditEntries().length);
  });
});

describe("phase 8 — dispatch loop", () => {
  it("delivers claimed jobs, refuses under kill switch, retries failures via leases", async () => {
    const store = new DispatchStore();
    const delivered: string[] = [];
    let killSwitch = false;
    let failFirst = true;
    const loop = new DispatchLoop({
      store,
      killSwitchEngaged: () => killSwitch,
      retryDelayMs: 0,
      deliverer: {
        deliver: async (job) => {
          if (failFirst && job.node_id === "flaky") {
            failFirst = false;
            throw new Error("transient delivery failure");
          }
          delivered.push(job.node_id);
          return `cmd-${job.node_id}`;
        },
      },
    });

    store.enqueue({ node_id: "steady", runner_id: "r1", payload: {} });
    store.enqueue({ node_id: "flaky", runner_id: "r1", payload: {} });

    killSwitch = true;
    expect(await loop.tick()).toBe(0); // dispatch refuses entirely

    killSwitch = false;
    await loop.tick(); // steady delivered; flaky failed -> requeued
    expect(delivered).toContain("steady");
    await loop.tick(); // polling recovery: flaky retried and delivered
    expect(delivered).toContain("flaky");
    expect(store.get("job_2")?.status).toBe("done");
    expect(store.get("job_2")?.attempts).toBe(2);
  });
});

describe("phase 8 — merge-to-main release gate", () => {
  it("refuses without approval, refuses stale hashes, merges with a matching one", async () => {
    const base = mkdtempSync(join(tmpdir(), "norns-release-"));
    const repo = await LocalGitRepo.init(join(base, "repo"), "pilot", join(base, "trees"));
    await repo.ensureIntegrationBranch();

    await expect(mergeIntegrationToMain(repo, null)).rejects.toThrow(MergeApprovalError);

    const staleApproval = {
      id: "appr-stale",
      kind: "merge" as const,
      actor: "dhatwell",
      approved_at: new Date().toISOString(),
      content_hash: "a".repeat(64), // approved something else
    };
    await expect(mergeIntegrationToMain(repo, staleApproval)).rejects.toThrow(/does not match/);

    const approval = { ...staleApproval, content_hash: await integrationHeadHash(repo) };
    const result = await mergeIntegrationToMain(repo, approval);
    expect(result.commit).toMatch(/^[a-f0-9]{40}$/);
  });
});
