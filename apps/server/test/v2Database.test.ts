import { describe, expect, it } from "vitest";
import {
  type NodePgClientLike,
  type NodePgPoolLike,
  NodePgTransactionRunner,
} from "../src/persistence/v2/database.js";

class RecordingClient implements NodePgClientLike {
  readonly calls: string[] = [];
  released = false;

  constructor(private readonly rejectedSql: string | null = null) {}

  async query<TRow>(
    sql: string,
    _params?: unknown[],
  ): Promise<{ rows: TRow[]; rowCount: number | null }> {
    this.calls.push(sql);
    if (sql === this.rejectedSql) throw new Error(`rejected: ${sql}`);
    if (sql === "SELECT value") {
      return { rows: [{ value: 42 } as TRow], rowCount: 1 };
    }
    return { rows: [], rowCount: null };
  }

  release(): void {
    this.released = true;
  }
}

function poolFor(client: RecordingClient): NodePgPoolLike {
  return {
    connect: async () => client,
  };
}

describe("NodePgTransactionRunner", () => {
  it("makes privileged transactions explicit and commits before releasing", async () => {
    const client = new RecordingClient();
    const runner = new NodePgTransactionRunner(poolFor(client), { mode: "privileged" });

    const result = await runner.transaction(async (tx) => {
      const selected = await tx.query<{ value: number }>("SELECT value");
      expect(selected.affectedRows).toBe(1);
      return selected.rows[0]?.value;
    });

    expect(result).toBe(42);
    expect(client.calls).toEqual(["BEGIN", "SELECT value", "COMMIT"]);
    expect(client.released).toBe(true);
  });

  it("assumes the restricted runtime role before application work", async () => {
    const client = new RecordingClient();
    const runner = new NodePgTransactionRunner(poolFor(client), {
      mode: "runtime",
      role: "norns_app",
    });

    const result = await runner.transaction(async (tx) => {
      const selected = await tx.query<{ value: number }>("SELECT value");
      return selected.rows[0]?.value;
    });

    expect(result).toBe(42);
    expect(client.calls).toEqual(["BEGIN", 'SET LOCAL ROLE "norns_app"', "SELECT value", "COMMIT"]);
    expect(client.released).toBe(true);
  });

  it("rolls back before application work when the runtime role cannot be assumed", async () => {
    const client = new RecordingClient('SET LOCAL ROLE "norns_app"');
    const runner = new NodePgTransactionRunner(poolFor(client), {
      mode: "runtime",
      role: "norns_app",
    });
    let workCalled = false;

    await expect(
      runner.transaction(async () => {
        workCalled = true;
      }),
    ).rejects.toThrow('rejected: SET LOCAL ROLE "norns_app"');

    expect(workCalled).toBe(false);
    expect(client.calls).toEqual(["BEGIN", 'SET LOCAL ROLE "norns_app"', "ROLLBACK"]);
    expect(client.released).toBe(true);
  });

  it("rolls back technical failures and still releases the client", async () => {
    const client = new RecordingClient();
    const runner = new NodePgTransactionRunner(poolFor(client), { mode: "privileged" });

    await expect(
      runner.transaction(async (tx) => {
        await tx.query("SELECT value");
        throw new Error("fault");
      }),
    ).rejects.toThrow("fault");

    expect(client.calls).toEqual(["BEGIN", "SELECT value", "ROLLBACK"]);
    expect(client.released).toBe(true);
  });
});
