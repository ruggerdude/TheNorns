import type { EventEnvelopeT } from "@norns/contracts";
import { RunnerDaemon } from "@norns/runner";
// Phase 1A acceptance (local half): full control set, buffered replay across
// a forced disconnect (no gaps, no duplicate execution), server restart
// recovery from durable state, generation fencing, audit completeness.
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { type Stack, commandState, listen, startStack, waitFor } from "./helpers.js";

let stack: Stack | null = null;

afterEach(async () => {
  await stack?.stop();
  stack = null;
});

function runStatuses(events: readonly EventEnvelopeT[]): string[] {
  return events
    .filter((e) => e.payload.kind === "run_status")
    .map((e) => (e.payload.kind === "run_status" ? e.payload.status : ""));
}

describe("phase 1A — remote control", () => {
  it("pairs, connects, heartbeats, and reports runner status", async () => {
    stack = await startStack();
    const runners = (await (await stack.api("/api/runners")).json()) as {
      runner_id: string;
      connected: boolean;
      last_seen_at: string | null;
    }[];
    expect(runners).toHaveLength(1);
    expect(runners[0]?.connected).toBe(true);
    await waitFor(async () => {
      const rs = (await (await (stack as Stack).api("/api/runners")).json()) as {
        last_seen_at: string | null;
      }[];
      return rs[0]?.last_seen_at !== null;
    }, "heartbeat marks last_seen");
  });

  it("launches a fixture, streams logs, completes; audit is complete", async () => {
    stack = await startStack();
    const commandId = await stack.issue({ kind: "launch_fixture", fixture: "count:5:30" });

    await waitFor(
      async () => (await commandState(stack as Stack, commandId)) === "succeeded",
      "command succeeded",
    );
    await waitFor(async () => {
      const events = (await (
        await (stack as Stack).api("/api/events/runner-1")
      ).json()) as EventEnvelopeT[];
      return runStatuses(events).includes("completed");
    }, "fixture completed");

    const events = (await (await stack.api("/api/events/runner-1")).json()) as EventEnvelopeT[];
    const logs = events.filter((e) => e.payload.kind === "run_log");
    expect(logs.length).toBe(5);
    // events are contiguous from seq 1 with no gaps or duplicates
    const seqs = events.map((e) => e.event_seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
    // correlation: fixture events carry the command's correlation chain
    const started = events.find((e) => e.payload.kind === "run_status");
    expect(started?.causation_id).toBe(commandId);

    const audit = (await (await stack.api("/api/audit")).json()) as { action: string }[];
    const actions = audit.map((a) => a.action);
    for (const expected of [
      "pairing.started",
      "pairing.completed",
      "runner.connected",
      "command.issued",
      "command.delivered",
      "command.ack",
      "run.status",
    ]) {
      expect(actions, `audit contains ${expected}`).toContain(expected);
    }
  });

  it("interrupt pauses, resume resumes, cancel terminates", async () => {
    stack = await startStack();
    const launch = await stack.issue({ kind: "launch_fixture", fixture: "count:100:40" });
    const runId = `run_${launch}`;

    await waitFor(async () => {
      const events = (await (
        await (stack as Stack).api("/api/events/runner-1")
      ).json()) as EventEnvelopeT[];
      return runStatuses(events).includes("started");
    }, "run started");

    await stack.issue({ kind: "interrupt", run_id: runId });
    await waitFor(async () => {
      const events = (await (
        await (stack as Stack).api("/api/events/runner-1")
      ).json()) as EventEnvelopeT[];
      return runStatuses(events).includes("paused");
    }, "run paused");

    await stack.issue({ kind: "resume_session", run_id: runId });
    await waitFor(async () => {
      const events = (await (
        await (stack as Stack).api("/api/events/runner-1")
      ).json()) as EventEnvelopeT[];
      return runStatuses(events).includes("resumed");
    }, "run resumed");

    await stack.issue({ kind: "cancel", run_id: runId });
    await waitFor(async () => {
      const events = (await (
        await (stack as Stack).api("/api/events/runner-1")
      ).json()) as EventEnvelopeT[];
      return runStatuses(events).includes("cancelled");
    }, "run cancelled");
  });

  it("survives a forced mid-run disconnect: buffered replay, no gaps, no dupes", async () => {
    stack = await startStack();
    await stack.issue({ kind: "launch_fixture", fixture: "count:20:40" });

    await waitFor(async () => {
      const events = (await (
        await (stack as Stack).api("/api/events/runner-1")
      ).json()) as EventEnvelopeT[];
      return events.filter((e) => e.payload.kind === "run_log").length >= 3;
    }, "some ticks before the kill");

    // network kill mid-task; the run keeps going locally, events buffer
    stack.daemon.disconnectNow();

    await waitFor(async () => {
      const events = (await (
        await (stack as Stack).api("/api/events/runner-1")
      ).json()) as EventEnvelopeT[];
      return runStatuses(events).includes("completed");
    }, "completed after reconnect + replay");

    const events = (await (await stack.api("/api/events/runner-1")).json()) as EventEnvelopeT[];
    const logs = events.filter((e) => e.payload.kind === "run_log");
    expect(logs.length).toBe(20); // every tick arrived exactly once
    const seqs = events.map((e) => e.event_seq);
    expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
  });

  it("recovers across a server restart from durable state, without double execution", async () => {
    stack = await startStack();
    const { daemon, dataDir, server } = stack;

    // take the runner offline, then queue a command against the outbox
    daemon.stop();
    await waitFor(() => server.connectedRunners().length === 0, "runner offline");
    const commandId = await stack.issue({ kind: "launch_fixture", fixture: "count:3:20" });
    expect(await commandState(stack, commandId)).toBe("queued");

    // durable snapshot -> server dies -> new server restored from the snapshot
    const snapshot = stack.server.stores.snapshot();
    await stack.server.app.close();

    const restored = await buildServer({
      stores: RelayStores.restore(snapshot),
      users: stack.users, // same UserStore instance -> stack.token is still a live session
    });
    const url = await listen(restored);
    const restoredToken = stack.token;
    const api = (path: string) =>
      fetch(`${url}${path}`, { headers: { authorization: `Bearer ${restoredToken}` } });

    // same runner identity, same durable runner state, new connection
    const revived = new RunnerDaemon({
      serverUrl: url,
      runnerId: "runner-1",
      dataDir,
      heartbeatMs: 500,
      reconnectDelayMs: 100,
    });
    revived.loadState();
    revived.connect();

    await waitFor(async () => {
      const res = (await (await api(`/api/commands/${commandId}`)).json()) as { state: string };
      return res.state === "succeeded";
    }, "queued command delivered and executed after restart");

    const events = (await (await api("/api/events/runner-1")).json()) as EventEnvelopeT[];
    const startedCount = runStatuses(events).filter((s) => s === "started").length;
    expect(startedCount).toBe(1); // exactly one execution, ever

    revived.stop();
    await restored.app.close();
    stack = null; // already torn down
  });

  it("fences a stale generation after key rotation/revocation", async () => {
    stack = await startStack();
    stack.server.stores.revokeRunnerSessions("runner-1");
    stack.daemon.disconnectNow(); // force a reconnect under the old generation

    await waitFor(() => stack?.daemon.isFenced === true, "daemon fenced");
    expect(stack.server.connectedRunners()).toHaveLength(0);
    const audit = (await (await stack.api("/api/audit")).json()) as { action: string }[];
    expect(audit.map((a) => a.action)).toContain("runner.fenced");
  });

  it("rejects unauthenticated API access and audits it", async () => {
    stack = await startStack();
    const res = await fetch(`${stack.url}/api/runners`);
    expect(res.status).toBe(401);
    const audit = (await (await stack.api("/api/audit")).json()) as { action: string }[];
    expect(audit.map((a) => a.action)).toContain("auth.rejected");
  });

  it("kill switch refuses new commands", async () => {
    stack = await startStack();
    await stack.api("/api/kill-switch", {
      method: "POST",
      body: JSON.stringify({ engaged: true }),
    });
    const res = await stack.api("/api/commands", {
      method: "POST",
      body: JSON.stringify({
        runner_id: "runner-1",
        payload: { kind: "launch_fixture", fixture: "count:1:10" },
      }),
    });
    expect(res.status).toBe(423);
  });
});
