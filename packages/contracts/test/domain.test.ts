import { describe, expect, it } from "vitest";
import { Approval, DecisionRecord } from "../src/approval.js";
import { ProjectMemoryEntry, renderMemoryBlock } from "../src/memory.js";
import { availableBudgetUsd, budgetThresholdReached } from "../src/usage.js";
import { RequiredVerification } from "../src/verification.js";

const HASH = "a".repeat(64);

describe("approvals", () => {
  it("requires a content hash of what the human saw", () => {
    const ok = Approval.safeParse({
      id: "appr-1",
      kind: "plan",
      actor: "dhatwell",
      approved_at: "2026-07-14T00:00:00.000Z",
      content_hash: HASH,
    });
    expect(ok.success).toBe(true);
    const bad = Approval.safeParse({
      id: "appr-1",
      kind: "plan",
      actor: "dhatwell",
      approved_at: "2026-07-14T00:00:00.000Z",
      content_hash: "not-a-hash",
    });
    expect(bad.success).toBe(false);
  });

  it("decision records default to active with no supersession", () => {
    const record = DecisionRecord.parse({
      id: "dec-14",
      title: "Use pytest",
      body: "All verification uses pytest.",
      created_at: "2026-07-14T00:00:00.000Z",
    });
    expect(record.status).toBe("active");
    expect(record.supersedes).toBeNull();
    expect(record.superseded_by).toBeNull();
  });
});

describe("budget reservations", () => {
  it("available = approved − settled − active reservations", () => {
    expect(availableBudgetUsd(100, 40, 25)).toBe(35);
  });

  it("80% threshold counts settled + reserved", () => {
    expect(budgetThresholdReached(100, 50, 29)).toBe(false);
    expect(budgetThresholdReached(100, 50, 30)).toBe(true);
  });
});

describe("project memory", () => {
  it("cannot represent an unapproved entry", () => {
    const bad = ProjectMemoryEntry.safeParse({
      id: "mem-1",
      directive: "Never install dependencies automatically.",
      version: 1,
      created_by: "pm",
      approved_by_human: false,
      created_at: "2026-07-14T00:00:00.000Z",
    });
    expect(bad.success).toBe(false);
  });

  it("renders only active directives, deterministically", () => {
    const entries = [
      ProjectMemoryEntry.parse({
        id: "mem-1",
        directive: "Always use pytest.",
        version: 1,
        created_by: "human",
        approved_by_human: true,
        created_at: "2026-07-14T00:00:00.000Z",
      }),
      ProjectMemoryEntry.parse({
        id: "mem-2",
        directive: "Never refactor combat.py without approval.",
        version: 1,
        active: false,
        created_by: "human",
        approved_by_human: true,
        created_at: "2026-07-14T00:00:00.000Z",
      }),
    ];
    const block = renderMemoryBlock(entries);
    expect(block).toContain("Always use pytest.");
    expect(block).not.toContain("combat.py");
    expect(renderMemoryBlock(entries)).toEqual(block);
    expect(renderMemoryBlock([])).toBe("");
  });
});

describe("required verification", () => {
  it("must carry at least one command and an approval hash", () => {
    expect(
      RequiredVerification.safeParse({
        project_id: "proj-1",
        commands: ["pnpm test"],
        approved_content_hash: HASH,
      }).success,
    ).toBe(true);
    expect(
      RequiredVerification.safeParse({
        project_id: "proj-1",
        commands: [],
        approved_content_hash: HASH,
      }).success,
    ).toBe(false);
  });
});
