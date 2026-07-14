// Human approvals and DecisionRecords (PRD R4 §Data Model). An Approval
// records the content hash of what the human actually saw — the audit trail
// must be able to prove it. DecisionRecords carry supersession so PM
// summaries draw only on active records.
import { z } from "zod";

const nonEmpty = z.string().min(1);
export const sha256Hex = z.string().regex(/^[a-f0-9]{64}$/, "must be a sha256 hex digest");

export const ApprovalKind = z.enum([
  "plan",
  "allocation",
  "budget_extension",
  "merge",
  "review_exception",
]);
export type ApprovalKindT = z.infer<typeof ApprovalKind>;

export const Approval = z.object({
  id: nonEmpty,
  kind: ApprovalKind,
  actor: nonEmpty, // always a human identity
  approved_at: z.string().datetime(),
  content_hash: sha256Hex,
});
export type ApprovalT = z.infer<typeof Approval>;

export const DecisionStatus = z.enum(["active", "obsolete"]);

export const DecisionRecord = z.object({
  id: nonEmpty,
  title: nonEmpty,
  body: nonEmpty,
  status: DecisionStatus.default("active"),
  supersedes: nonEmpty.nullable().default(null),
  superseded_by: nonEmpty.nullable().default(null),
  created_at: z.string().datetime(),
});
export type DecisionRecordT = z.infer<typeof DecisionRecord>;
