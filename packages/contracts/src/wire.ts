// WebSocket wire frames for the runner protocol (additive in contracts 1.1.0).
// Auth is a challenge/response over the runner's Ed25519 keypair; after auth
// the reconciliation handshake runs, then commands/events flow.
import { z } from "zod";
import { CommandEnvelope, EventEnvelope, ReconcileRequest, ReconcileResponse } from "./protocol.js";

const nonEmpty = z.string().min(1);
const opaqueId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
const safeDisplayLabel = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("\\") &&
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }),
    "label must not contain path separators or control characters",
  );

// Local workspace discovery is deliberately a small, transient side channel on
// the already-authenticated runner socket.  These IDs are opaque handles, not
// filesystem paths.  A runner owns the handle -> path mapping and never puts a
// path (or an OS error containing one) on this wire.
export const RunnerWorkspaceRequest = z
  .object({
    request_id: opaqueId,
    operation: z.enum(["list", "browse", "validate"]),
    workspace_id: opaqueId.optional(),
    entry_id: opaqueId.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.operation === "browse" && !value.workspace_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["workspace_id"], message: "required" });
    }
    if (value.operation === "validate" && (!value.workspace_id || !value.entry_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entry_id"],
        message: "workspace and entry required",
      });
    }
  });
export type RunnerWorkspaceRequestT = z.infer<typeof RunnerWorkspaceRequest>;

export const RunnerWorkspaceEntry = z
  .object({
    entry_id: opaqueId,
    label: safeDisplayLabel,
    kind: z.enum(["folder", "repository"]),
    can_browse: z.boolean(),
  })
  .strict();
export type RunnerWorkspaceEntryT = z.infer<typeof RunnerWorkspaceEntry>;

export const RunnerWorkspaceResponse = z
  .object({
    request_id: opaqueId,
    operation: z.enum(["list", "browse", "validate"]),
    status: z.enum(["ok", "invalid_request", "not_found", "unavailable"]),
    workspaces: z
      .array(z.object({ workspace_id: opaqueId, label: safeDisplayLabel }).strict())
      .optional(),
    entries: z.array(RunnerWorkspaceEntry).optional(),
    repository: z
      .object({
        workspace_id: opaqueId,
        repository_id: opaqueId,
        repository_display_name: safeDisplayLabel,
        default_branch: z.string().min(1).max(240),
        observed_head: z.string().min(1).max(240),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const payloads = [value.workspaces, value.entries, value.repository].filter(
      (payload) => payload !== undefined,
    );
    if (value.status !== "ok" && payloads.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failed workspace responses must not include data",
      });
      return;
    }
    if (value.status !== "ok") return;
    const correctPayload =
      (value.operation === "list" && value.workspaces !== undefined) ||
      (value.operation === "browse" && value.entries !== undefined) ||
      (value.operation === "validate" && value.repository !== undefined);
    if (!correctPayload || payloads.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "successful workspace response must contain exactly its operation payload",
      });
    }
  });
export type RunnerWorkspaceResponseT = z.infer<typeof RunnerWorkspaceResponse>;

// runner -> server
export const RunnerFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("auth"),
    runner_id: nonEmpty,
    // base64 Ed25519 signature over the server-issued nonce
    nonce_signature: nonEmpty,
  }),
  z.object({ type: z.literal("reconcile_request"), body: ReconcileRequest }),
  z.object({ type: z.literal("event"), event: EventEnvelope }),
  z.object({
    type: z.literal("workspace_response"),
    generation: z.number().int().nonnegative(),
    response: RunnerWorkspaceResponse,
  }),
]);
export type RunnerFrameT = z.infer<typeof RunnerFrame>;

// server -> runner
export const ServerFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("challenge"), nonce: nonEmpty }),
  z.object({ type: z.literal("auth_ok") }),
  z.object({ type: z.literal("auth_error"), reason: nonEmpty }),
  z.object({ type: z.literal("reconcile_response"), body: ReconcileResponse }),
  z.object({ type: z.literal("command"), command: CommandEnvelope }),
  z.object({ type: z.literal("event_ack"), ack_event_seq: z.number().int().nonnegative() }),
  // fencing: the runner's generation is stale; it must stop acting and re-pair
  z.object({ type: z.literal("fenced"), current_generation: z.number().int().nonnegative() }),
  z.object({
    type: z.literal("workspace_request"),
    generation: z.number().int().nonnegative(),
    request: RunnerWorkspaceRequest,
  }),
]);
export type ServerFrameT = z.infer<typeof ServerFrame>;

export function parseRunnerFrame(raw: string): RunnerFrameT | null {
  try {
    return RunnerFrame.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function parseServerFrame(raw: string): ServerFrameT | null {
  try {
    return ServerFrame.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}
