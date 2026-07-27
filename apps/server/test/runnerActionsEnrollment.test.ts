import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RunnerDaemon } from "../../runner/src/daemon.js";

describe.sequential("Actions runner enrollment transport", () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("retries network and 5xx failures with the byte-identical body and persists only after success", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "norns-actions-enroll-"));
    cleanup.push(dataDir);
    const statePath = join(dataDir, "runner-state.json");
    const bodies: string[] = [];
    const stateExistedBeforeResponses: boolean[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      stateExistedBeforeResponses.push(existsSync(statePath));
      if (bodies.length === 1) throw new Error("response lost after request");
      if (bodies.length === 2) return new Response(null, { status: 503 });
      return new Response(JSON.stringify({ generation: 17 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const daemon = new RunnerDaemon({
      serverUrl: "https://norns.example",
      runnerId: "actions:project-1:dispatch-1",
      dataDir,
      reconnect: false,
    });

    await daemon.enroll({
      enrollmentToken: "one-use-enrollment-token",
      dispatchJobId: "dispatch-job-1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(new Set(bodies).size).toBe(1);
    expect(stateExistedBeforeResponses).toEqual([false, false, false]);
    expect(JSON.parse(bodies[0] ?? "{}")).toMatchObject({
      enrollment_token: "one-use-enrollment-token",
      runner_id: "actions:project-1:dispatch-1",
      dispatch_job_id: "dispatch-job-1",
      public_key_pem: expect.stringMatching(
        /^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\n$/,
      ),
    });
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({
      runner_id: "actions:project-1:dispatch-1",
      generation: 17,
      private_key_pem: expect.stringMatching(
        /^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\n$/,
      ),
    });
  });

  it("does not retry a 4xx rejection or persist runner identity", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "norns-actions-enroll-"));
    cleanup.push(dataDir);
    const fetchMock = vi.fn(async () => new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const daemon = new RunnerDaemon({
      serverUrl: "https://norns.example",
      runnerId: "actions:project-1:dispatch-rejected",
      dataDir,
      reconnect: false,
    });

    await expect(
      daemon.enroll({
        enrollmentToken: "rejected-enrollment-token",
        dispatchJobId: "dispatch-job-rejected",
      }),
    ).rejects.toThrow("enrollment rejected (401)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dataDir, "runner-state.json"))).toBe(false);
  });
});
