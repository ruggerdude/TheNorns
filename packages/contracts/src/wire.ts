// WebSocket wire frames for the runner protocol (additive in contracts 1.1.0).
// Auth is a challenge/response over the runner's Ed25519 keypair; after auth
// the reconciliation handshake runs, then commands/events flow.
import { z } from "zod";
import { RunnerInferenceRequest, RunnerInferenceResponse } from "./inference.js";
import { CommandEnvelope, EventEnvelope, ReconcileRequest, ReconcileResponse } from "./protocol.js";
import { RepositoryInspection } from "./repositoryInspection.js";

const nonEmpty = z.string().min(1);
const deviceGeneration = z.number().int().nonnegative();
const opaqueId = z
  .string()
  .min(1)
  .max(200)
  // Nested orchestration IDs are percent-encoded before they become wire IDs.
  // Accept only complete percent escapes so the handle remains bounded and
  // cannot contain path separators or control characters.
  .regex(/^(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})+$/);
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
const githubCloneUrl = z
  .string()
  .url()
  .max(500)
  .regex(
    /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/,
    "clone URL must be an uncredentialed GitHub HTTPS URL",
  );

const repositoryGraphText = z
  .string()
  .min(1)
  .max(1_000)
  .refine(
    (value) =>
      ![...value].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }),
    "graph text must not contain control characters",
  );

const repositoryGraphPath = repositoryGraphText.refine(
  (value) =>
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.split("/").some((segment) => segment === "" || segment === "." || segment === ".."),
  "graph source files must be repository-relative paths",
);

export const RepositoryGraphNode = z
  .object({
    id: repositoryGraphText,
    label: repositoryGraphText,
    file_type: repositoryGraphText.optional(),
    source_file: repositoryGraphPath.optional(),
    source_location: z.string().min(1).max(100).optional(),
    community: repositoryGraphText.optional(),
    community_label: repositoryGraphText.optional(),
    degree: z.number().int().nonnegative().max(1_000_000),
  })
  .strict();
export type RepositoryGraphNodeT = z.infer<typeof RepositoryGraphNode>;

export const RepositoryGraphEdge = z
  .object({
    id: repositoryGraphText,
    source: repositoryGraphText,
    target: repositoryGraphText,
    relation: repositoryGraphText,
    confidence: repositoryGraphText.optional(),
  })
  .strict();
export type RepositoryGraphEdgeT = z.infer<typeof RepositoryGraphEdge>;

export const RepositoryGraph = z
  .object({
    state: z.enum(["missing", "ready", "stale", "unavailable", "failed"]),
    message: z.string().min(1).max(500).optional(),
    graphify_version: z.string().min(1).max(100).optional(),
    observed_head: z.string().min(1).max(240).optional(),
    indexed_head: z.string().min(1).max(240).optional(),
    indexed_at: z.string().datetime().optional(),
    node_count: z.number().int().nonnegative().max(10_000_000),
    edge_count: z.number().int().nonnegative().max(20_000_000),
    community_count: z.number().int().nonnegative().max(1_000_000),
    nodes: z.array(RepositoryGraphNode).max(240),
    edges: z.array(RepositoryGraphEdge).max(600),
    truncated: z.boolean(),
    query: z.string().min(1).max(200).optional(),
  })
  .strict();
export type RepositoryGraphT = z.infer<typeof RepositoryGraph>;

export const LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE = "norns.legacy-runner-wss-auth.v1" as const;
export const DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE =
  "norns.device-cancellation-evidence-wss.v1" as const;

export const SignedLegacyRunnerWssAuthenticationTranscript = z
  .object({
    purpose: z.literal(LEGACY_RUNNER_WSS_AUTH_SIGNATURE_PURPOSE),
    runner_id: nonEmpty,
    generation: z.number().int().nonnegative(),
    protocol_version: z.number().int().nonnegative(),
    challenge: nonEmpty,
  })
  .strict();
export type SignedLegacyRunnerWssAuthenticationTranscriptT = z.infer<
  typeof SignedLegacyRunnerWssAuthenticationTranscript
>;

export function canonicalLegacyRunnerWssAuthenticationTranscript(
  input: SignedLegacyRunnerWssAuthenticationTranscriptT,
): string {
  const transcript = SignedLegacyRunnerWssAuthenticationTranscript.parse(input);
  return JSON.stringify({
    purpose: transcript.purpose,
    runner_id: transcript.runner_id,
    generation: transcript.generation,
    protocol_version: transcript.protocol_version,
    challenge: transcript.challenge,
  });
}

export const SignedDeviceCancellationEvidenceWssTranscript = z
  .object({
    purpose: z.literal(DEVICE_CANCELLATION_EVIDENCE_WSS_SIGNATURE_PURPOSE),
    device_id: opaqueId,
    credential_id: opaqueId,
    generation: deviceGeneration,
    run_id: opaqueId,
    evidence_state: z.enum(["runner_acknowledged", "process_exited"]),
    acknowledged_at: z.string().datetime(),
    process_exited_at: z.string().datetime().nullable(),
    process_tree_reaped: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const acknowledged =
      value.evidence_state === "runner_acknowledged" &&
      value.process_exited_at === null &&
      value.process_tree_reaped === false;
    const exited =
      value.evidence_state === "process_exited" &&
      value.process_exited_at !== null &&
      value.process_tree_reaped === true;
    if (!acknowledged && !exited) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cancellation evidence state does not match its process-exit proof",
      });
    }
  });
export type SignedDeviceCancellationEvidenceWssTranscriptT = z.infer<
  typeof SignedDeviceCancellationEvidenceWssTranscript
>;

export function canonicalDeviceCancellationEvidenceWssTranscript(
  input: SignedDeviceCancellationEvidenceWssTranscriptT,
): string {
  const transcript = SignedDeviceCancellationEvidenceWssTranscript.parse(input);
  return JSON.stringify({
    purpose: transcript.purpose,
    device_id: transcript.device_id,
    credential_id: transcript.credential_id,
    generation: transcript.generation,
    run_id: transcript.run_id,
    evidence_state: transcript.evidence_state,
    acknowledged_at: transcript.acknowledged_at,
    process_exited_at: transcript.process_exited_at,
    process_tree_reaped: transcript.process_tree_reaped,
  });
}

// Local workspace discovery is deliberately a small, transient side channel on
// the already-authenticated runner socket.  These IDs are opaque handles, not
// filesystem paths.  A runner owns the handle -> path mapping and never puts a
// path (or an OS error containing one) on this wire.
export const RunnerWorkspaceRequest = z
  .object({
    request_id: opaqueId,
    operation: z.enum([
      "list",
      "catalog",
      "browse",
      "validate",
      "choose",
      "choose_clone_parent",
      "clone",
      "inspect",
      "graphify_status",
      "graphify_index",
      "graphify_query",
      "delete",
    ]),
    workspace_id: opaqueId.optional(),
    entry_id: opaqueId.optional(),
    repository_id: opaqueId.optional(),
    clone_url: githubCloneUrl.optional(),
    repository_name: safeDisplayLabel.optional(),
    clone_token: z.string().min(1).max(1_000).optional(),
    clone_destination_id: opaqueId.optional(),
    graph_search: z.string().trim().min(1).max(200).optional(),
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
    if (value.operation === "inspect" && !value.repository_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repository_id"],
        message: "required",
      });
    }
    if (
      ["graphify_status", "graphify_index", "graphify_query"].includes(value.operation) &&
      !value.repository_id
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repository_id"],
        message: "required",
      });
    }
    if (value.operation === "graphify_query" && !value.graph_search) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["graph_search"],
        message: "required",
      });
    }
    if (value.operation === "delete" && (!value.workspace_id || !value.repository_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repository_id"],
        message: "workspace and repository required",
      });
    }
    if (
      value.operation === "clone" &&
      (!value.clone_url || !value.repository_name || !value.clone_token)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["clone_url"],
        message: "clone URL, repository name, and clone token required",
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

export const RunnerWorkspaceRepository = z
  .object({
    workspace_id: opaqueId,
    repository_id: opaqueId,
    repository_display_name: safeDisplayLabel,
    default_branch: z.string().min(1).max(240),
    observed_head: z.string().min(1).max(240),
  })
  .strict();
export type RunnerWorkspaceRepositoryT = z.infer<typeof RunnerWorkspaceRepository>;

export const RunnerWorkspaceResponse = z
  .object({
    request_id: opaqueId,
    operation: z.enum([
      "list",
      "catalog",
      "browse",
      "validate",
      "choose",
      "choose_clone_parent",
      "clone",
      "inspect",
      "graphify_status",
      "graphify_index",
      "graphify_query",
      "delete",
    ]),
    status: z.enum([
      "ok",
      "cancelled",
      "invalid_request",
      "not_found",
      "unavailable",
      "destination_exists",
      "clone_failed",
    ]),
    workspaces: z
      .array(z.object({ workspace_id: opaqueId, label: safeDisplayLabel }).strict())
      .optional(),
    entries: z.array(RunnerWorkspaceEntry).optional(),
    repository: RunnerWorkspaceRepository.optional(),
    // Enrolled devices register approved repositories with the relay before
    // returning a clone response. This opaque id lets onboarding grant the
    // exact working copy without exposing its filesystem path.
    repository_registration_id: opaqueId.optional(),
    clone_destination: z
      .object({
        clone_destination_id: opaqueId,
        label: safeDisplayLabel,
      })
      .strict()
      .optional(),
    repositories: z.array(RunnerWorkspaceRepository).max(200).optional(),
    inspection: RepositoryInspection.optional(),
    repository_graph: RepositoryGraph.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const payloads = [
      value.workspaces,
      value.entries,
      value.repository,
      value.clone_destination,
      value.repositories,
      value.inspection,
      value.repository_graph,
    ].filter((payload) => payload !== undefined);
    if (value.status !== "ok" && payloads.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failed workspace responses must not include data",
      });
      return;
    }
    if (value.status !== "ok") return;
    if (
      value.repository_registration_id !== undefined &&
      value.operation !== "choose" &&
      value.operation !== "clone"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["repository_registration_id"],
        message: "repository registration is valid only for a selected repository",
      });
    }
    const correctPayload =
      (value.operation === "list" && value.workspaces !== undefined) ||
      (value.operation === "catalog" && value.repositories !== undefined) ||
      (value.operation === "browse" && value.entries !== undefined) ||
      (value.operation === "choose_clone_parent" && value.clone_destination !== undefined) ||
      (value.operation === "delete" && payloads.length === 0) ||
      ((value.operation === "validate" ||
        value.operation === "choose" ||
        value.operation === "clone") &&
        value.repository !== undefined) ||
      (value.operation === "inspect" && value.inspection !== undefined) ||
      (["graphify_status", "graphify_index", "graphify_query"].includes(value.operation) &&
        value.repository_graph !== undefined);
    const expectedPayloadCount = value.operation === "delete" ? 0 : 1;
    if (!correctPayload || payloads.length !== expectedPayloadCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "successful workspace response must contain exactly its operation payload",
      });
    }
  });
export type RunnerWorkspaceResponseT = z.infer<typeof RunnerWorkspaceResponse>;

// runner -> server
export const DeviceRunnerAuthenticationFrame = z
  .object({
    type: z.literal("device_auth"),
    device_id: opaqueId,
    credential_id: opaqueId,
    generation: deviceGeneration,
    protocol_version: nonEmpty,
    agent_version: z.string().trim().min(1).max(100).optional(),
    capabilities: z.array(z.string().trim().min(1).max(100)).max(64).optional(),
    transcript_signature: nonEmpty,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.agent_version === undefined) !== (value.capabilities === undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent version and capabilities must be reported together",
      });
    }
    if (value.capabilities && new Set(value.capabilities).size !== value.capabilities.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "agent capabilities must be unique",
      });
    }
  });
export type DeviceRunnerAuthenticationFrameT = z.infer<typeof DeviceRunnerAuthenticationFrame>;

export const DeviceCancellationEvidenceFrame = z
  .object({
    type: z.literal("device_cancellation_evidence"),
    device_id: opaqueId,
    credential_id: opaqueId,
    generation: deviceGeneration,
    run_id: opaqueId,
    evidence_state: z.enum(["runner_acknowledged", "process_exited"]),
    acknowledged_at: z.string().datetime(),
    process_exited_at: z.string().datetime().nullable(),
    process_tree_reaped: z.boolean(),
    transcript_signature: nonEmpty,
  })
  .strict()
  .superRefine((value, context) => {
    const acknowledged =
      value.evidence_state === "runner_acknowledged" &&
      value.process_exited_at === null &&
      value.process_tree_reaped === false;
    const exited =
      value.evidence_state === "process_exited" &&
      value.process_exited_at !== null &&
      value.process_tree_reaped === true;
    if (!acknowledged && !exited) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "cancellation evidence state does not match its process-exit proof",
      });
    }
  });
export type DeviceCancellationEvidenceFrameT = z.infer<typeof DeviceCancellationEvidenceFrame>;

export const RunnerFrame = z.union([
  z
    .object({
      type: z.literal("auth"),
      runner_id: nonEmpty,
      generation: z.number().int().nonnegative(),
      protocol_version: z.number().int().nonnegative(),
      transcript_signature: nonEmpty,
    })
    .strict(),
  DeviceRunnerAuthenticationFrame,
  DeviceCancellationEvidenceFrame,
  z.object({ type: z.literal("reconcile_request"), body: ReconcileRequest }),
  z.object({ type: z.literal("event"), event: EventEnvelope }),
  z.object({
    type: z.literal("workspace_response"),
    generation: z.number().int().nonnegative(),
    response: RunnerWorkspaceResponse,
  }),
  // EXECUTION E3 — proxied model inference. Additive: a runner that never
  // sends this frame is unaffected, and the generation travels with it so a
  // superseded runner cannot spend a project's budget.
  z.object({
    type: z.literal("inference_request"),
    generation: z.number().int().nonnegative(),
    request: RunnerInferenceRequest,
  }),
]);
export type RunnerFrameT = z.infer<typeof RunnerFrame>;

// server -> runner
export const ServerFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("challenge"),
    nonce: nonEmpty,
    device_auth: z
      .object({
        challenge: nonEmpty,
        supported_protocol_versions: z.array(nonEmpty).min(1).max(16),
      })
      .strict()
      .optional(),
  }),
  z.object({ type: z.literal("auth_ok") }),
  z
    .object({
      type: z.literal("device_auth_ok"),
      device_id: opaqueId,
      generation: deviceGeneration,
      protocol_version: nonEmpty,
    })
    .strict(),
  z
    .object({
      type: z.literal("device_cancellation_request"),
      device_id: opaqueId,
      credential_id: opaqueId,
      generation: deviceGeneration,
      run_id: opaqueId,
      cause: z.enum(["project_stop", "device_revocation", "emergency_stop"]),
      requested_at: z.string().datetime(),
      publication_fenced: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal("device_cancellation_evidence_ack"),
      run_id: opaqueId,
      evidence_state: z.enum(["runner_acknowledged", "process_exited"]),
    })
    .strict(),
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
  // EXECUTION E3 — the completion, or a typed refusal, correlated by
  // request_id back to the runner's pending call.
  z.object({
    type: z.literal("inference_response"),
    generation: z.number().int().nonnegative(),
    response: RunnerInferenceResponse,
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
