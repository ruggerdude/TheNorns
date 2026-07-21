// ONBOARDING O2: the verification contract for a project's WORKSPACE folder.
//
// ADR-006: the server executes no repository commands. It never stats a
// directory, never runs `git`, and never reads the operator's filesystem.
// Everything below is a *contract* the runner satisfies; this module owns the
// shape of the question and the shape of the honest answer, nothing else.
//
// The transport (a runner frame carrying an inspect request) is deliberately
// NOT defined here: apps/runner/** and packages/contracts/src/wire.ts are
// outside this phase's ownership. O2 ships the port plus an "offline" default
// implementation, so today every folder-first creation takes the FRONT DOOR
// D2 unverified path and a later phase can drop in the real runner-backed
// implementation without touching the onboarding commands.
import { z } from "zod";

/** What the caller needs to be true of the folder before it is usable. */
export const WorkspaceFolderExpectation = z.enum([
  /** Scenarios 1, 2, 3: a brand-new staging folder, or a clone target. */
  "empty_or_absent",
  /** Scenario 4: an existing working tree that is already a git repository. */
  "existing_git_repository",
]);
export type WorkspaceFolderExpectationT = z.infer<typeof WorkspaceFolderExpectation>;

/**
 * What a runner reports back about a candidate workspace folder.
 *
 * Deliberately path-free, matching the rule already enforced on the workspace
 * wire in packages/contracts/src/wire.ts: a runner owns the handle -> path
 * mapping and never puts a path (or an OS error containing one) on the wire.
 * `remote_url` is the git remote, which is a public repository URL, not a
 * filesystem location.
 */
export const WorkspaceFolderReport = z
  .object({
    runner_id: z.string().min(1).max(240),
    exists: z.boolean(),
    /** True when the folder is absent OR present with no entries. */
    is_empty: z.boolean(),
    is_git_repository: z.boolean(),
    head_revision: z.string().min(1).max(240).nullable(),
    default_branch: z.string().min(1).max(240).nullable(),
    remote_url: z.string().min(1).max(2048).nullable(),
    /** Opaque runner-owned handles, mirroring the folder-picker flow. */
    workspace_id: z.string().min(1).max(240).nullable(),
    repository_id: z.string().min(1).max(240).nullable(),
  })
  .strict();
export type WorkspaceFolderReportT = z.infer<typeof WorkspaceFolderReport>;

export interface WorkspaceInspectionRequest {
  /**
   * The operator-supplied folder path. Held transiently: it is handed to the
   * runner and used to derive an opaque sha256 fingerprint plus a sanitized
   * last-segment display name. It is never persisted verbatim, never logged,
   * and never returned to a client.
   */
  readonly local_path: string;
  readonly expectation: WorkspaceFolderExpectationT;
}

/** The seam a runner-backed implementation fills in. */
export interface WorkspaceVerificationPort {
  inspect(request: WorkspaceInspectionRequest): Promise<WorkspaceFolderReportT>;
}

/** No runner could answer. FRONT DOOR D2: creation still succeeds, unverified. */
export class WorkspaceVerificationUnavailableError extends Error {
  readonly code = "workspace_verification_unavailable" as const;

  constructor(readonly reason: string) {
    super(`no runner could inspect the chosen folder: ${reason}`);
    this.name = "WorkspaceVerificationUnavailableError";
  }
}

/** A runner answered, and the answer disqualifies the folder. */
export class WorkspaceVerificationFailedError extends Error {
  constructor(
    readonly code: "workspace_not_empty" | "workspace_missing" | "workspace_not_a_git_repository",
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceVerificationFailedError";
  }
}

/**
 * The default port: there is no runner-side inspection frame yet, so every
 * inspection is "unavailable" and every folder-first creation lands on the
 * FRONT DOOR D2 unverified path. Honest by construction -- it never claims a
 * folder was checked.
 */
export class OfflineWorkspaceVerification implements WorkspaceVerificationPort {
  inspect(_request: WorkspaceInspectionRequest): Promise<WorkspaceFolderReportT> {
    return Promise.reject(
      new WorkspaceVerificationUnavailableError("no paired runner is online for this workspace"),
    );
  }
}

/**
 * Turns a report into either a verified outcome or an honest failure.
 * Exported separately from the port so the judgement lives on the server and
 * cannot be talked out of by a runner that reports a convenient boolean.
 */
export function judgeWorkspaceReport(
  expectation: WorkspaceFolderExpectationT,
  report: WorkspaceFolderReportT,
): WorkspaceFolderReportT {
  if (expectation === "empty_or_absent") {
    if (!report.is_empty) {
      throw new WorkspaceVerificationFailedError(
        "workspace_not_empty",
        "the chosen folder already has files in it; pick an empty folder, or choose " +
          "the existing-local option to work in place",
      );
    }
    return report;
  }
  if (!report.exists) {
    throw new WorkspaceVerificationFailedError(
      "workspace_missing",
      "the chosen folder does not exist on the runner's machine",
    );
  }
  if (!report.is_git_repository) {
    throw new WorkspaceVerificationFailedError(
      "workspace_not_a_git_repository",
      "the chosen folder is not a git repository; run `git init` there first, or " +
        "choose the new-local option to stage work in an empty folder",
    );
  }
  return report;
}
