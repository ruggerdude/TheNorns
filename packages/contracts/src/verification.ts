// Verification (PRD R4 §Graph & Execution): a worker's claim is evidence, not
// state. The runner executes Required Verification Commands (project-level,
// human-approved, outside any plan) plus additive module test_commands, and
// the engine records the immutable result.
import { z } from "zod";
import { sha256Hex } from "./approval.js";

const nonEmpty = z.string().min(1);

export const VerificationKind = z.enum(["required", "module"]);

export const VerificationResult = z.object({
  id: nonEmpty,
  node_id: nonEmpty,
  run_id: nonEmpty,
  commit_sha: z.string().regex(/^[a-f0-9]{7,40}$/, "must be a git sha"),
  command: nonEmpty,
  kind: VerificationKind,
  passed: z.boolean(),
  output_digest: sha256Hex,
  executed_at: z.string().datetime(),
});
export type VerificationResultT = z.infer<typeof VerificationResult>;

export const RequiredVerification = z.object({
  project_id: nonEmpty,
  commands: z.array(nonEmpty).min(1),
  // hash of the human-approved command set; changing it requires a new Approval
  approved_content_hash: sha256Hex,
});
export type RequiredVerificationT = z.infer<typeof RequiredVerification>;
