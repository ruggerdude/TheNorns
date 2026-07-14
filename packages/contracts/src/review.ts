// Structured reviewer findings and PM dispositions (PRD R4 §Planning
// Workflow). The PM must respond to every must-fix finding — accept + revise,
// or rebut with rationale — and rebuttals are visible to the human at
// approval time. Convergence = zero must-fix findings.
import { z } from "zod";

export const ReviewSeverity = z.enum(["must_fix", "should_fix", "suggestion"]);
export type ReviewSeverityT = z.infer<typeof ReviewSeverity>;

export const ReviewFinding = z.object({
  severity: ReviewSeverity,
  module_id: z.string().nullable(), // null = plan-level
  finding: z.string().min(1),
  recommendation: z.string().min(1),
});
export type ReviewFindingT = z.infer<typeof ReviewFinding>;

export const ReviewFindings = z.object({
  findings: z.array(ReviewFinding),
});
export type ReviewFindingsT = z.infer<typeof ReviewFindings>;

export const FindingDisposition = z.enum(["accept", "rebut"]);

export const FindingResponse = z.object({
  finding_index: z.number().int().nonnegative(),
  disposition: FindingDisposition,
  rationale: z.string().min(1),
});
export type FindingResponseT = z.infer<typeof FindingResponse>;

export function mustFixCount(findings: readonly ReviewFindingT[]): number {
  return findings.filter((f) => f.severity === "must_fix").length;
}

/** Review policy record (PRD: cross-provider is the default, exceptions are
 * documented and human-approved). */
export const ReviewPolicyRecord = z.object({
  requested_policy: z.literal("cross_provider"),
  pm_provider: z.string().min(1),
  reviewer_provider: z.string().min(1),
  exception_reason: z.string().nullable(),
  exception_approved_by: z.string().nullable(),
});
export type ReviewPolicyRecordT = z.infer<typeof ReviewPolicyRecord>;
