import type { ConversationMessage } from "@norns/adapters";
import { describe, expect, it } from "vitest";
import {
  PLAN_PROPOSAL_MAX_DISCUSSION_CHARACTERS,
  PLAN_PROPOSAL_MAX_DISCUSSION_MESSAGES,
  PLAN_PROPOSAL_MAX_MESSAGE_CHARACTERS,
  PLAN_PROPOSAL_MAX_OUTPUT_TOKENS,
  buildConversationPlanProposalRequest,
} from "../src/conversations/planProposal.js";

describe("bounded conversation plan proposal envelope", () => {
  it("is deterministic, retains the latest direction, and excludes raw omitted discussion", () => {
    const messages: ConversationMessage[] = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content:
        index === 0
          ? `OLD_RAW_DIRECTION_MUST_NOT_LEAK_${"x".repeat(5_000)}`
          : index === 19
            ? `${"n".repeat(5_000)}LATEST_ACCEPTED_DIRECTION`
            : `visible discussion ${index}`,
    }));

    const first = buildConversationPlanProposalRequest({
      assembledSystem: "BINDING_RULES_MUST_REMAIN_COMPLETE",
      messages,
    });
    const second = buildConversationPlanProposalRequest({
      assembledSystem: "BINDING_RULES_MUST_REMAIN_COMPLETE",
      messages,
    });

    expect(first).toEqual(second);
    expect(first.maxTokens).toBe(PLAN_PROPOSAL_MAX_OUTPUT_TOKENS);
    expect(first.maxTokens).toBe(7_000);
    expect(first.system.endsWith("\n\nBINDING_RULES_MUST_REMAIN_COMPLETE")).toBe(true);
    expect(first.discussion.chronological_messages.length).toBeLessThanOrEqual(
      PLAN_PROPOSAL_MAX_DISCUSSION_MESSAGES,
    );
    expect(first.discussion.omission.included_characters).toBeLessThanOrEqual(
      PLAN_PROPOSAL_MAX_DISCUSSION_CHARACTERS,
    );
    expect(
      first.discussion.chronological_messages.every(
        (message) => message.included_characters <= PLAN_PROPOSAL_MAX_MESSAGE_CHARACTERS,
      ),
    ).toBe(true);
    expect(first.discussion.chronological_messages.map((message) => message.source_index)).toEqual(
      [...first.discussion.chronological_messages]
        .map((message) => message.source_index)
        .sort((left, right) => left - right),
    );
    expect(first.discussion.chronological_messages.at(-1)?.source_index).toBe(19);
    expect(first.prompt).toContain("LATEST_ACCEPTED_DIRECTION");
    expect(JSON.stringify(first)).not.toContain("OLD_RAW_DIRECTION_MUST_NOT_LEAK");
    expect(first.discussion.omission.omitted_content_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("never serializes image payloads into the text-only discussion digest", () => {
    const rawBase64 = "RAW_BASE64_MUST_NOT_APPEAR";
    const built = buildConversationPlanProposalRequest({
      assembledSystem: "binding",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Use the attached layout." },
            { type: "image", mime: "image/png", base64: rawBase64 },
          ],
        },
      ],
    });

    expect(built.prompt).toContain("Use the attached layout.");
    expect(built.prompt).toContain("Visible image/png image omitted");
    expect(built.prompt).not.toContain(rawBase64);
  });
});
