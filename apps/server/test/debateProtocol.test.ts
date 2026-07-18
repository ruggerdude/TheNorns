import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DebateJudgeResult,
  DebateParticipantProposalResult,
  DebateParticipantRevisionResult,
  type DebateProtocolError,
  DebateSynthesisResult,
  buildJudgePrompt,
  buildParticipantProposalPrompt,
  buildParticipantRevisionPrompt,
  buildSynthesisPrompt,
} from "../src/debates/protocol.js";

const now = "2026-07-18T12:00:00.000Z";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function actor(
  kind: "participant" | "judge" | "synthesizer" = "participant",
  overrides: Record<string, unknown> = {},
) {
  return {
    schema_version: 2 as const,
    id: `${kind}-actor`,
    debate_id: "debate-1",
    actor_kind: kind,
    role_label: kind === "participant" ? "skeptical orchard architect" : kind,
    display_name: `${kind} display`,
    instructions: `Apply the user-selected ${kind} perspective without changing model identity.`,
    provider: "user-selected-provider",
    model: "user-selected-model",
    runtime: "provider_api",
    position: 0,
    max_turns: 3,
    max_input_tokens: 12_000,
    max_output_tokens: 2_000,
    budget_limit_usd: 5,
    created_at: now,
    ...overrides,
  };
}

function promptInput(
  kind: "participant" | "judge" | "synthesizer" = "participant",
  overrides: Record<string, unknown> = {},
) {
  const selectedActor = actor(kind);
  return {
    debate: {
      schema_version: 2 as const,
      id: "debate-1",
      project_id: "project-1",
      phase_id: null,
      source_debate_id: null,
      state: "ready" as const,
      title: "Persistence architecture",
      question: "Which persistence architecture best preserves recovery evidence?",
      stopping_policy: {
        exact_rounds: null,
        max_rounds: 3,
        max_duration_seconds: 3_600,
        max_total_input_tokens: 100_000,
        max_total_output_tokens: 20_000,
        max_total_cost_usd: 20,
        stop_on_consensus: true,
        no_material_change_rounds: 2,
        repeated_disagreement_rounds: 2,
        provider_failure_threshold: 3,
      },
      content_hash: hash("debate-definition"),
      aggregate_version: 1,
      created_by: { actor_type: "human" as const, actor_id: "user-1" },
      created_at: now,
      archived_at: null,
    },
    run: {
      schema_version: 2 as const,
      id: "run-1",
      project_id: "project-1",
      debate_id: "debate-1",
      attempt: 1,
      state: "running" as const,
      lifecycle_version: 2,
      event_version: 4,
      cursor_round_number: 1,
      cursor_turn_number: 1,
      stop_after: "none" as const,
      stop_reason: null,
      started_at: now,
      finished_at: null,
      aggregate_version: 3,
      created_at: now,
      updated_at: now,
    },
    round: {
      schema_version: 2 as const,
      id: "round-1",
      debate_run_id: "run-1",
      round_number: 1,
      state: "active" as const,
      consensus_reported: false,
      material_change: null,
      unresolved_disagreement_fingerprint: null,
      started_at: now,
      finished_at: null,
      created_at: now,
      updated_at: now,
    },
    turn: {
      schema_version: 2 as const,
      id: "turn-1",
      debate_run_id: "run-1",
      round_id: "round-1",
      turn_number: 1,
      actor_id: selectedActor.id,
      state: "queued" as const,
      designated_attempt_id: null,
      prompt_hash: hash("pending-prompt"),
      output_message_id: null,
      created_at: now,
      updated_at: now,
      completed_at: null,
    },
    actor: selectedActor,
    contexts: [],
    transcript: [],
    ...overrides,
  };
}

function message(sequence: number, content: string) {
  return {
    schema_version: 2 as const,
    id: `message-${sequence}`,
    debate_run_id: "run-1",
    sequence,
    message_kind: "participant" as const,
    actor_snapshot: actor("participant", { id: `participant-${sequence}` }),
    turn_id: `prior-turn-${sequence}`,
    turn_attempt_id: `prior-attempt-${sequence}`,
    content,
    content_hash: hash(content),
    created_at: now,
  };
}

function finding(key = "durability-gap") {
  return {
    schema_version: 2 as const,
    id: `finding-${key}`,
    debate_run_id: "run-1",
    message_id: "message-1",
    key,
    severity: "must_fix" as const,
    finding: "The proposal does not explain crash recovery.",
    recommendation: "Add a durable cursor and designated attempt rule.",
    disposition: "open" as const,
    created_at: now,
  };
}

describe("debate structured result schemas", () => {
  it("accepts normalized participant, judge, and synthesis results and rejects extra fields", () => {
    const proposal = {
      content: "Use an append-only transcript plus a locked operational projection.",
      summary: "Append-only evidence with a recoverable projection.",
      claims: ["The transcript can rebuild the projection."],
      findings: [],
      consensus_reported: false,
      material_change: true,
      unresolved_disagreements: ["Snapshot cadence"],
    };
    expect(DebateParticipantProposalResult.parse(proposal).material_change).toBe(true);
    expect(
      DebateParticipantRevisionResult.parse({
        ...proposal,
        finding_dispositions: [
          { key: "durability-gap", disposition: "resolved", rationale: "Added a cursor." },
        ],
      }).finding_dispositions,
    ).toHaveLength(1);
    expect(
      DebateJudgeResult.parse({
        conclusion: "The append-only design is better supported.",
        rationale: "It retains recovery evidence.",
        evidence_message_ids: ["message-1"],
        findings: [],
        consensus_reported: false,
        material_change: true,
        unresolved_disagreements: [],
      }).conclusion,
    ).toContain("append-only");
    expect(
      DebateSynthesisResult.safeParse({
        content: "Final output",
        summary: "Summary",
        conclusion: "Conclusion",
        rationale: "Rationale",
        evidence_message_ids: [],
        unresolved_disagreements: [],
        provider_specific_payload: {},
      }).success,
    ).toBe(false);
  });
});

describe("debate prompt protocol", () => {
  it("uses the selected actor role and limits without encoding a provider or model", () => {
    const built = buildParticipantProposalPrompt(promptInput());

    expect(built.schemaName).toBe("debate_participant_proposal_v2");
    expect(built.maxTokens).toBe(2_000);
    expect(built.system).toContain("skeptical orchard architect");
    expect(built.system).toContain("Apply the user-selected participant perspective");
    expect(`${built.system}\n${built.prompt}`).not.toContain("user-selected-model");
    expect(`${built.system}\n${built.prompt}`).not.toContain("user-selected-provider");
  });

  it("compresses deterministically, retains the newest message first, and stays under the cap", () => {
    const contextContent = "context evidence ".repeat(800);
    const contexts = [
      {
        context: {
          schema_version: 2 as const,
          id: "context-1",
          debate_id: "debate-1",
          ordinal: 0,
          label: "Architecture evidence",
          artifact: null,
          inline_content: contextContent,
          content_hash: hash(contextContent),
          created_at: now,
        },
        resolved_content: contextContent,
      },
    ];
    const transcript = Array.from({ length: 8 }, (_, index) =>
      message(index + 1, `message ${index + 1} evidence `.repeat(500)),
    );
    const input = promptInput("participant", {
      actor: actor("participant", { max_input_tokens: 6_000 }),
      contexts,
      transcript,
    });

    const first = buildParticipantProposalPrompt(input);
    const second = buildParticipantProposalPrompt(input);

    expect(first.prompt).toBe(second.prompt);
    expect(first.contextManifest).toEqual(second.contextManifest);
    expect(first.contextManifest.selected_message_ids).toContain("message-8");
    expect(first.contextManifest.truncated_message_ids).toContain("message-8");
    expect(first.contextManifest.omitted_message_ids.length).toBeGreaterThan(0);
    expect(first.contextManifest.input_token_upper_bound).toBeLessThanOrEqual(6_000);
    expect(first.prompt).toContain("[TRUNCATED:message-8]");
  });

  it("rejects cross-run records and content whose hash was not verified", () => {
    const wrongRun = promptInput("participant", {
      transcript: [{ ...message(1, "evidence"), debate_run_id: "another-run" }],
    });
    expect(() => buildParticipantProposalPrompt(wrongRun)).toThrowError(
      expect.objectContaining<Partial<DebateProtocolError>>({ code: "scope_mismatch" }),
    );

    const content = "verified source";
    const badContext = promptInput("participant", {
      contexts: [
        {
          context: {
            schema_version: 2 as const,
            id: "context-bad",
            debate_id: "debate-1",
            ordinal: 0,
            label: "Bad context",
            artifact: null,
            inline_content: content,
            content_hash: hash("different source"),
            created_at: now,
          },
          resolved_content: content,
        },
      ],
    });
    expect(() => buildParticipantProposalPrompt(badContext)).toThrow(
      "resolved context does not match its content hash",
    );
  });

  it("builds revision, judge, and synthesis operations for independently selected actors", () => {
    const prior = message(1, "Initial proposal");
    const revision = buildParticipantRevisionPrompt({
      ...promptInput("participant", { transcript: [prior] }),
      previous_message_id: prior.id,
      findings: [finding()],
    });
    expect(revision.schemaName).toBe("debate_participant_revision_v2");
    expect(revision.prompt).toContain("durability-gap");
    expect(
      revision.schema.safeParse({
        content: "Revised",
        summary: "Revised",
        claims: [],
        findings: [],
        consensus_reported: false,
        material_change: true,
        unresolved_disagreements: [],
        finding_dispositions: [],
      }).success,
    ).toBe(false);

    const judge = buildJudgePrompt(promptInput("judge", { transcript: [prior] }));
    expect(judge.schemaName).toBe("debate_judgment_v2");
    expect(judge.system).toContain("Assigned role: judge");
    expect(
      judge.schema.safeParse({
        conclusion: "Conclusion",
        rationale: "Rationale",
        evidence_message_ids: ["invented-message"],
        findings: [],
        consensus_reported: false,
        material_change: false,
        unresolved_disagreements: [],
      }).success,
    ).toBe(false);

    const synthesis = buildSynthesisPrompt({
      ...promptInput("synthesizer", { transcript: [prior] }),
      judgment: {
        schema_version: 2,
        id: "judgment-1",
        debate_run_id: "run-1",
        revision_id: null,
        judge_actor_id: "judge-actor",
        conclusion: "Prefer the append-only design.",
        rationale: "It has stronger recovery evidence.",
        evidence: [],
        content_hash: hash("judgment"),
        created_at: now,
      },
      open_findings: [finding("snapshot-risk")],
    });
    expect(synthesis.schemaName).toBe("debate_synthesis_v2");
    expect(synthesis.prompt).toContain("snapshot-risk");

    expect(() => buildJudgePrompt(promptInput("participant"))).toThrowError(
      expect.objectContaining<Partial<DebateProtocolError>>({ code: "actor_kind_mismatch" }),
    );
  });
});
