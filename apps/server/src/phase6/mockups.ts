import { createHash } from "node:crypto";
import {
  V2ConversationMockupVersion,
  type V2ConversationMockupVersionT,
  V2MockupManifest,
  type V2MockupManifestT,
} from "@norns/contracts";
import { TaskContextStore } from "../execution/taskContextStore.js";
import { newId } from "../ids.js";
import { canonicalJson, canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import { Phase6ArtifactService } from "./artifacts.js";
import {
  MOCKUP_DESKTOP_VIEWPORT,
  MOCKUP_MOBILE_VIEWPORT,
  renderDeterministicMockup,
} from "./renderer.js";

const MAX_RENDER_ATTEMPTS = 3;
const MOCKUP_CONTEXT_SECTION = "approved_mockup";

export type Phase6MockupErrorCode =
  | "action_conflict"
  | "manifest_conflict"
  | "mockup_not_found"
  | "mockup_not_ready"
  | "render_lease_lost"
  | "task_package_missing";

export class Phase6MockupError extends Error {
  constructor(
    readonly code: Phase6MockupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "Phase6MockupError";
  }
}

export interface Phase6CheckpointAction {
  action_id: string;
  action_type: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  initiated_by_user_id: string;
  phase_id: string | null;
}

export interface Phase6CheckpointResult {
  state: "queued" | "applied";
  resource_type: "project" | "task";
  resource_id: string;
}

interface MockupRequestRow {
  id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  action_id: string;
  initiated_by_user_id: string;
  task_id: string | null;
  plan_version_id: string | null;
  module_id: string | null;
  phase_id: string | null;
  root_request_id: string;
  source_mockup_version_id: string | null;
  brief: string;
  target: "desktop" | "mobile" | "responsive";
  artifact_refs: unknown;
  revision_direction: string | null;
  attempts: number;
}

interface MockupVersionRow {
  id: string;
  root_request_id: string;
  request_id: string;
  project_id: string;
  work_item_id: string;
  conversation_id: string;
  task_id: string | null;
  plan_version_id: string | null;
  module_id: string | null;
  created_by_action_id: string;
  version: number;
  brief: string;
  target: "desktop" | "mobile" | "responsive";
  interaction_notes: unknown;
  manifest_artifact_id: string;
  manifest_artifact_hash: string;
  canonical_manifest: string;
  renderer_profile: unknown;
  supersedes_mockup_version_id: string | null;
  created_at: string | Date;
  decision: "approved" | "revision_requested" | "rejected" | null;
  has_successor: boolean;
}

interface ScreenshotRow {
  viewport: "desktop" | "mobile";
  artifact_id: string;
  artifact_hash: string;
  label: string;
  width: number;
  height: number;
  capture_profile: unknown;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function stringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function versionStatus(row: MockupVersionRow): V2ConversationMockupVersionT["status"] {
  if (row.has_successor) return "superseded";
  return row.decision ?? "candidate";
}

function mapVersion(
  row: MockupVersionRow,
  screenshots: ScreenshotRow[],
): V2ConversationMockupVersionT {
  const ordered = [...screenshots].sort((left, right) =>
    left.viewport === "desktop" && right.viewport === "mobile" ? -1 : 1,
  );
  if (
    ordered.length !== 2 ||
    ordered[0]?.viewport !== "desktop" ||
    ordered[1]?.viewport !== "mobile"
  ) {
    throw new Phase6MockupError("mockup_not_ready", `mockup version "${row.id}" is incomplete`);
  }
  return V2ConversationMockupVersion.parse({
    schema_version: 2,
    id: row.id,
    root_request_id: row.root_request_id,
    request_id: row.request_id,
    project_id: row.project_id,
    work_item_id: row.work_item_id,
    conversation_id: row.conversation_id,
    task_id: row.task_id,
    plan_version_id: row.plan_version_id,
    module_id: row.module_id,
    created_by_action_id: row.created_by_action_id,
    version: Number(row.version),
    status: versionStatus(row),
    brief: row.brief,
    target: row.target,
    interaction_notes: stringArray(row.interaction_notes),
    manifest: {
      artifact_id: row.manifest_artifact_id,
      content_hash: row.manifest_artifact_hash,
      media_type: "application/json",
      label: "Mockup manifest",
    },
    renderer_profile: row.renderer_profile,
    screenshots: ordered.map((screenshot) => ({
      viewport: screenshot.viewport,
      artifact: {
        artifact_id: screenshot.artifact_id,
        content_hash: screenshot.artifact_hash,
        media_type: "image/png",
        label: screenshot.label,
      },
      width: Number(screenshot.width),
      height: Number(screenshot.height),
      capture_profile: screenshot.capture_profile,
    })),
    supersedes_mockup_version_id: row.supersedes_mockup_version_id,
    created_at: iso(row.created_at),
  });
}

function evidenceHash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function versionIdFor(requestId: string): string {
  return `mockup-version:${requestId}`;
}

function decisionIdFor(actionId: string): string {
  return `mockup-decision:${actionId}`;
}

function supplementIdFor(decisionId: string): string {
  return `mockup-supplement:${decisionId}`;
}

export function implementationVisualEvidenceRequirement(approvedMockupVersionId: string) {
  return {
    manifest_path: ".norns/visual-evidence.json",
    producer: "playwright",
    approved_mockup_version_id: approvedMockupVersionId,
    required_captures: [
      { viewport: "desktop", width: 1440, height: 1024, media_type: "image/png" },
      { viewport: "mobile", width: 390, height: 844, media_type: "image/png" },
    ],
    capture_profile: {
      renderer: "playwright",
      pixel_ratio: 1,
      network: "application_only",
      locale: "en-US",
      timezone: "UTC",
    },
    manifest_schema: {
      root_keys: ["schema_version", "approved_mockup_version_id", "capture_profile", "screenshots"],
      capture_profile_keys: [
        "renderer",
        "browser_name",
        "browser_version",
        "font_revision",
        "pixel_ratio",
        "network",
        "locale",
        "timezone",
        "fixed_clock",
      ],
      screenshot_keys: ["viewport", "path", "content_hash"],
      manifest_template: {
        schema_version: 2,
        approved_mockup_version_id: approvedMockupVersionId,
        capture_profile: {
          renderer: "playwright",
          browser_name: "<non-empty Playwright browser name>",
          browser_version: "<non-empty Playwright browser version>",
          font_revision: "<64 lowercase hex SHA-256 of the exact loaded font profile>",
          pixel_ratio: 1,
          network: "application_only",
          locale: "en-US",
          timezone: "UTC",
          fixed_clock: "<one ISO-8601 UTC instant frozen for both captures>",
        },
        screenshots: [
          {
            viewport: "desktop",
            path: ".norns/visual-evidence/desktop-1440x1024.png",
            content_hash: "<64 lowercase hex SHA-256 of this PNG's bytes>",
          },
          {
            viewport: "mobile",
            path: ".norns/visual-evidence/mobile-390x844.png",
            content_hash: "<64 lowercase hex SHA-256 of this PNG's bytes>",
          },
        ],
      },
    },
    production_rules: [
      "Use Playwright to capture the implemented application at exactly 1440x1024 and 390x844 with deviceScaleFactor 1.",
      "Replace every angle-bracket placeholder in the template with the observed value; do not add or omit manifest keys.",
      "Compute each content_hash from the exact PNG file bytes using lowercase SHA-256.",
      "Commit the manifest and both ordinary, non-symlink PNG files in the same implementation commit before verification and deployment.",
    ],
    commit_policy: "manifest_and_pngs_must_be_regular_files_in_the_verified_implementation_commit",
  } as const;
}

export class Phase6MockupService {
  private readonly artifacts: Phase6ArtifactService;
  private readonly contextStore: TaskContextStore;

  constructor(
    private readonly transactions: V2TransactionRunner,
    options: { artifactQuotaBytes?: number } = {},
  ) {
    this.artifacts = new Phase6ArtifactService(transactions, options.artifactQuotaBytes);
    this.contextStore = new TaskContextStore(transactions);
  }

  artifactService(): Phase6ArtifactService {
    return this.artifacts;
  }

  async checkpointAction(
    tx: V2SqlExecutor,
    action: Phase6CheckpointAction,
    parameters: Record<string, unknown>,
  ): Promise<Phase6CheckpointResult | null> {
    if (
      !["create_mockup", "approve_mockup", "revise_mockup", "reject_mockup"].includes(
        action.action_type,
      )
    ) {
      return null;
    }
    if (action.action_type === "create_mockup") {
      const requestId = `mockup-request:${action.action_id}`;
      await tx.query(
        `INSERT INTO conversation_mockup_requests (
           id,project_id,work_item_id,conversation_id,action_id,task_id,
           brief,target,artifact_refs
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
         ON CONFLICT(action_id) DO NOTHING`,
        [
          requestId,
          action.project_id,
          action.work_item_id,
          action.conversation_id,
          action.action_id,
          parameters.task_id ?? null,
          parameters.brief,
          parameters.target,
          JSON.stringify(parameters.artifact_refs ?? []),
        ],
      );
      return { state: "queued", resource_type: "project", resource_id: requestId };
    }

    const versionId = String(parameters.mockup_version_id ?? "");
    const version = await this.lockExactVersion(tx, action, versionId, parameters);
    if (action.action_type === "approve_mockup" && version.task_id === null) {
      await this.assertPlanningApprovalCurrent(tx, action, version, parameters);
    }
    const decisionId = decisionIdFor(action.action_id);
    const decision =
      action.action_type === "approve_mockup"
        ? "approved"
        : action.action_type === "revise_mockup"
          ? "revision_requested"
          : "rejected";
    const decidedAt = new Date().toISOString();
    await tx.query(
      `INSERT INTO conversation_mockup_decisions (
         id,project_id,work_item_id,conversation_id,mockup_version_id,action_id,
         decided_by_user_id,decision,manifest_artifact_id,manifest_artifact_hash,
         rationale,direction,created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        decisionId,
        action.project_id,
        action.work_item_id,
        action.conversation_id,
        version.id,
        action.action_id,
        action.initiated_by_user_id,
        decision,
        version.manifest_artifact_id,
        version.manifest_artifact_hash,
        decision === "rejected" ? parameters.reason : null,
        decision === "revision_requested" ? parameters.direction : null,
        decidedAt,
      ],
    );

    if (decision === "approved") {
      const executionTarget =
        version.task_id !== null &&
        parameters.task_id === version.task_id &&
        parameters.plan_version_id == null &&
        parameters.module_id == null;
      const planningTarget =
        version.task_id === null &&
        version.plan_version_id !== null &&
        version.module_id !== null &&
        parameters.task_id == null &&
        parameters.plan_version_id === version.plan_version_id &&
        parameters.module_id === version.module_id;
      if (!executionTarget && !planningTarget) {
        throw new Phase6MockupError(
          "action_conflict",
          "approval does not identify the mockup version's exact task or planning module",
        );
      }
      if (executionTarget) {
        await this.insertApprovalSupplement(tx, action, version, decisionId, decidedAt);
      }
      return {
        state: "applied",
        resource_type: executionTarget ? "task" : "project",
        resource_id: executionTarget ? (version.task_id as string) : action.work_item_id,
      };
    }
    if (decision === "revision_requested") {
      const source = (
        await tx.query<{
          root_request_id: string;
          artifact_refs: unknown;
        }>(
          `SELECT root_request_id,artifact_refs
             FROM conversation_mockup_requests
            WHERE id=$1`,
          [version.request_id],
        )
      ).rows[0];
      if (!source) throw new Phase6MockupError("mockup_not_found", "source request is missing");
      const requestId = `mockup-request:${action.action_id}`;
      await tx.query(
        `INSERT INTO conversation_mockup_requests (
           id,project_id,work_item_id,conversation_id,action_id,task_id,
           root_request_id,source_mockup_version_id,payload_hash,brief,target,
           artifact_refs,revision_direction,available_at
         )
         SELECT $1,$2,$3,$4,$5,$6,$7,$8,current_action.payload_hash,$9,$10,
                $11::jsonb,$12,now()
           FROM conversation_actions current_action
          WHERE current_action.id=$5`,
        [
          requestId,
          action.project_id,
          action.work_item_id,
          action.conversation_id,
          action.action_id,
          version.task_id,
          source.root_request_id,
          version.id,
          version.brief,
          version.target,
          JSON.stringify(
            typeof source.artifact_refs === "string"
              ? JSON.parse(source.artifact_refs)
              : source.artifact_refs,
          ),
          parameters.direction,
        ],
      );
      return { state: "queued", resource_type: "project", resource_id: requestId };
    }
    return { state: "applied", resource_type: "project", resource_id: decisionId };
  }

  async version(
    projectId: string,
    conversationId: string,
    versionId: string,
  ): Promise<V2ConversationMockupVersionT> {
    return this.transactions.transaction(async (tx) => {
      const row = await this.versionRow(tx, projectId, conversationId, versionId);
      if (!row) {
        throw new Phase6MockupError(
          "mockup_not_found",
          `unknown mockup version "${versionId}" in this project conversation`,
        );
      }
      const screenshots = await this.screenshotRows(tx, row.id);
      return mapVersion(row, screenshots);
    });
  }

  async list(projectId: string, conversationId: string): Promise<V2ConversationMockupVersionT[]> {
    return this.transactions.transaction(async (tx) => {
      const versions = await tx.query<MockupVersionRow>(
        `${this.versionSelect()}
          WHERE version.project_id=$1 AND version.conversation_id=$2
          ORDER BY version.created_at,version.version,version.id`,
        [projectId, conversationId],
      );
      const result: V2ConversationMockupVersionT[] = [];
      for (const row of versions.rows) {
        result.push(mapVersion(row, await this.screenshotRows(tx, row.id)));
      }
      return result;
    });
  }

  private versionSelect(): string {
    return `SELECT version.id,version.root_request_id,version.request_id,
                   version.project_id,version.work_item_id,version.conversation_id,
                   version.task_id,
                   NULLIF(root_action.payload->'parameters'->>'plan_version_id','')
                     AS plan_version_id,
                   NULLIF(root_action.payload->'parameters'->>'module_id','') AS module_id,
                   version.created_by_action_id,version.version,
                   version.brief,version.target,version.interaction_notes,
                   version.manifest_artifact_id,version.manifest_artifact_hash,
                   version.canonical_manifest,version.renderer_profile,
                   version.supersedes_mockup_version_id,version.created_at,
                   decision.decision,
                   EXISTS (
                     SELECT 1 FROM conversation_mockup_versions successor
                      WHERE successor.supersedes_mockup_version_id=version.id
                   ) AS has_successor
              FROM conversation_mockup_versions version
              JOIN conversation_mockup_requests root_request
                ON root_request.id=version.root_request_id
              JOIN conversation_actions root_action
                ON root_action.id=root_request.action_id
              LEFT JOIN conversation_mockup_decisions decision
                ON decision.mockup_version_id=version.id`;
  }

  private async versionRow(
    tx: V2SqlExecutor,
    projectId: string,
    conversationId: string,
    versionId: string,
  ): Promise<MockupVersionRow | null> {
    const result = await tx.query<MockupVersionRow>(
      `${this.versionSelect()}
        WHERE version.project_id=$1 AND version.conversation_id=$2 AND version.id=$3`,
      [projectId, conversationId, versionId],
    );
    return result.rows[0] ?? null;
  }

  private async screenshotRows(tx: V2SqlExecutor, versionId: string): Promise<ScreenshotRow[]> {
    return (
      await tx.query<ScreenshotRow>(
        `SELECT screenshot.viewport,screenshot.artifact_id,screenshot.artifact_hash,
                artifact.label,screenshot.width,screenshot.height,
                screenshot.capture_profile
           FROM conversation_mockup_version_artifacts screenshot
           JOIN artifacts artifact ON artifact.id=screenshot.artifact_id
          WHERE screenshot.mockup_version_id=$1
          ORDER BY CASE screenshot.viewport WHEN 'desktop' THEN 1 ELSE 2 END`,
        [versionId],
      )
    ).rows;
  }

  private async lockExactVersion(
    tx: V2SqlExecutor,
    action: Phase6CheckpointAction,
    versionId: string,
    parameters: Record<string, unknown>,
  ): Promise<MockupVersionRow> {
    const version = (
      await tx.query<MockupVersionRow>(
        `${this.versionSelect()}
          WHERE version.id=$1
            AND version.project_id=$2
            AND version.work_item_id=$3
            AND version.conversation_id=$4
          FOR UPDATE OF version`,
        [versionId, action.project_id, action.work_item_id, action.conversation_id],
      )
    ).rows[0];
    if (!version) {
      throw new Phase6MockupError("mockup_not_found", "mockup version is outside action scope");
    }
    if (
      version.decision !== null ||
      version.has_successor ||
      parameters.manifest_artifact_id !== version.manifest_artifact_id ||
      parameters.manifest_artifact_hash !== version.manifest_artifact_hash
    ) {
      throw new Phase6MockupError(
        "manifest_conflict",
        "mockup decision lost its exact candidate version or manifest race",
      );
    }
    return version;
  }

  private async assertPlanningApprovalCurrent(
    tx: V2SqlExecutor,
    action: Phase6CheckpointAction,
    version: MockupVersionRow,
    parameters: Record<string, unknown>,
  ): Promise<void> {
    const work = (
      await tx.query<{ status: string }>(
        `SELECT status FROM work_items
          WHERE project_id=$1 AND id=$2 FOR UPDATE`,
        [action.project_id, action.work_item_id],
      )
    ).rows[0];
    const conversation = (
      await tx.query<{ status: string; kind: string }>(
        `SELECT status,kind FROM work_conversations
          WHERE project_id=$1 AND work_item_id=$2 AND id=$3 FOR UPDATE`,
        [action.project_id, action.work_item_id, action.conversation_id],
      )
    ).rows[0];
    const currentPlan = (
      await tx.query<{ id: string }>(
        `SELECT plan.id
           FROM work_plan_versions plan
          WHERE plan.project_id=$1 AND plan.work_item_id=$2
            AND plan.conversation_id=$3
            AND plan.status IN ('candidate','in_qc','changes_requested','approved')
          ORDER BY plan.version DESC
          LIMIT 1
          FOR UPDATE`,
        [action.project_id, action.work_item_id, action.conversation_id],
      )
    ).rows[0];
    const targetPlanId = String(parameters.plan_version_id ?? "");
    const targetModuleId = String(parameters.module_id ?? "");
    const target = await tx.query<{ id: string }>(
      `SELECT id FROM work_plan_versions
        WHERE id=$1 AND project_id=$2 AND work_item_id=$3 AND conversation_id=$4
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(plan->'plan'->'modules') module
             WHERE module->>'id'=$5
          )`,
      [
        targetPlanId,
        action.project_id,
        action.work_item_id,
        action.conversation_id,
        targetModuleId,
      ],
    );
    const transition = await tx.query<{ id: string }>(
      `SELECT id FROM conversation_handoffs
        WHERE project_id=$1 AND work_item_id=$2 AND source_conversation_id=$3
        LIMIT 1`,
      [action.project_id, action.work_item_id, action.conversation_id],
    );
    if (
      !work ||
      !conversation ||
      conversation.kind !== "planning" ||
      conversation.status !== "active" ||
      !["planning", "in_qc", "awaiting_approval"].includes(work.status) ||
      !currentPlan ||
      currentPlan.id !== targetPlanId ||
      version.plan_version_id !== targetPlanId ||
      version.module_id !== targetModuleId ||
      !target.rows[0] ||
      transition.rows[0]
    ) {
      throw new Phase6MockupError(
        "action_conflict",
        "planning mockup approval is stale because its plan/module is no longer current",
      );
    }
  }

  private async insertApprovalSupplement(
    tx: V2SqlExecutor,
    action: Phase6CheckpointAction,
    version: MockupVersionRow,
    decisionId: string,
    decidedAt: string,
  ): Promise<void> {
    if (!version.task_id) {
      throw new Phase6MockupError("task_package_missing", "approved mockup has no target task");
    }
    const binding = (
      await tx.query<{
        package_id: string;
      }>(
        `SELECT package_id
           FROM conversation_task_package_bindings
          WHERE project_id=$1 AND work_item_id=$2 AND conversation_id=$3 AND task_id=$4`,
        [action.project_id, action.work_item_id, action.conversation_id, version.task_id],
      )
    ).rows[0];
    if (!binding) {
      throw new Phase6MockupError(
        "task_package_missing",
        "target task has no immutable conversation package binding",
      );
    }
    const screenshots = await this.screenshotRows(tx, version.id);
    const projected = mapVersion({ ...version, decision: null, has_successor: false }, screenshots);
    const supplement = {
      schema_version: 2,
      kind: "approved_mockup",
      mockup_version_id: version.id,
      manifest_artifact_id: version.manifest_artifact_id,
      manifest_artifact_hash: version.manifest_artifact_hash,
      approval: {
        decision_id: decisionId,
        action_id: action.action_id,
        decided_by_user_id: action.initiated_by_user_id,
        decided_at: decidedAt,
      },
      brief: version.brief,
      target: version.target,
      interaction_notes: projected.interaction_notes,
      renderer_profile: projected.renderer_profile,
      screenshots: projected.screenshots,
      implementation_visual_evidence_requirement: implementationVisualEvidenceRequirement(
        version.id,
      ),
    };
    const canonical = canonicalJson(supplement);
    const bytes = Buffer.from(canonical, "utf8");
    const contentHash = canonicalSha256(supplement);
    const document = await this.contextStore.put(tx, {
      projectId: action.project_id,
      section: MOCKUP_CONTEXT_SECTION,
      content: bytes,
      mediaType: "application/json",
    });
    if (document.sha256 !== contentHash) {
      throw new Error("canonical mockup supplement hash changed while storing context");
    }
    const ordinal =
      (
        await tx.query<{ ordinal: number }>(
          `SELECT coalesce(max(ordinal),0)::int+1 AS ordinal
           FROM conversation_task_package_supplements
          WHERE base_package_id=$1`,
          [binding.package_id],
        )
      ).rows[0]?.ordinal ?? 1;
    await tx.query(
      `INSERT INTO conversation_task_package_supplements (
         id,project_id,work_item_id,conversation_id,task_id,base_package_id,
         ordinal,source_mockup_version_id,approval_decision_id,
         manifest_artifact_id,manifest_artifact_hash,supplement,
         canonical_supplement,content_hash,context_document_id,
         context_byte_size,context_media_type,created_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16,
         'application/json',$17
       )`,
      [
        supplementIdFor(decisionId),
        action.project_id,
        action.work_item_id,
        action.conversation_id,
        version.task_id,
        binding.package_id,
        ordinal,
        version.id,
        decisionId,
        version.manifest_artifact_id,
        version.manifest_artifact_hash,
        JSON.stringify(supplement),
        canonical,
        contentHash,
        document.id,
        bytes.byteLength,
        decidedAt,
      ],
    );
  }
}

/**
 * Restart-safe renderer worker. Rendering happens outside the transaction; the
 * lease-owner fence is checked again before any immutable evidence is written.
 */
export class Phase6MockupWorker {
  private readonly workerId: string;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly service: Phase6MockupService,
    options: { workerId?: string } = {},
  ) {
    this.workerId = options.workerId ?? `phase6-mockup:${process.pid}`;
  }

  async tick(): Promise<{ request_id: string; version_id: string | null; status: string } | null> {
    await this.transactions.transaction(async (tx) => {
      await tx.query(
        `UPDATE conversation_mockup_requests
            SET status='queued',lease_owner=NULL,lease_expires_at=NULL,
                available_at=now(),last_error='recovered_expired_render_lease',
                updated_at=now()
          WHERE status='leased' AND lease_expires_at<=now()`,
      );
    });
    const leaseOwner = `${this.workerId}:${newId("lease")}`;
    const claimed = await this.transactions.transaction(async (tx) => {
      const candidate = (
        await tx.query<MockupRequestRow>(
          `SELECT request.id,request.project_id,request.work_item_id,
                  request.conversation_id,request.action_id,
                  action.initiated_by_user_id,request.task_id,
                  NULLIF(root_action.payload->'parameters'->>'plan_version_id','')
                    AS plan_version_id,
                  NULLIF(root_action.payload->'parameters'->>'module_id','') AS module_id,
                  task.phase_id,
                  request.root_request_id,request.source_mockup_version_id,
                  request.brief,request.target,request.artifact_refs,
                  request.revision_direction,request.attempts
             FROM conversation_mockup_requests request
             JOIN conversation_actions action ON action.id=request.action_id
             JOIN conversation_mockup_requests root_request
               ON root_request.id=request.root_request_id
             JOIN conversation_actions root_action ON root_action.id=root_request.action_id
             LEFT JOIN tasks task ON task.id=request.task_id
            WHERE request.status='queued' AND request.available_at<=now()
            ORDER BY request.available_at,request.created_at,request.id
            FOR UPDATE OF request SKIP LOCKED
            LIMIT 1`,
        )
      ).rows[0];
      if (!candidate) return null;
      const leased = await tx.query<{ id: string; attempts: number }>(
        `UPDATE conversation_mockup_requests
            SET status='leased',lease_owner=$2,lease_expires_at=now()+interval '2 minutes',
                attempts=attempts+1,last_error=NULL,updated_at=now()
          WHERE id=$1 AND status='queued'
          RETURNING id,attempts`,
        [candidate.id, leaseOwner],
      );
      return leased.rows[0]
        ? { ...candidate, attempts: Number(leased.rows[0].attempts), leaseOwner }
        : null;
    });
    if (!claimed) return null;

    try {
      const artifactRefs = stringArray(claimed.artifact_refs);
      const briefNote =
        `The ${claimed.target} design is derived from this brief: ${claimed.brief}`.slice(0, 500);
      const interactionNotes = [
        briefNote,
        ...(claimed.revision_direction
          ? [`Revision direction applied: ${claimed.revision_direction}`.slice(0, 500)]
          : []),
        `Review the ${claimed.target} behavior in both fixed desktop and mobile captures; approval binds implementation to this exact manifest hash.`,
      ];
      const rendered = renderDeterministicMockup({
        schema_version: 1,
        title: claimed.brief.slice(0, 160),
        summary: claimed.brief.slice(0, 1_000),
        target: claimed.target,
        sections: [
          {
            heading: "Primary workflow",
            body: claimed.brief.slice(0, 800),
            emphasis: "primary",
          },
          {
            heading: "Decision state",
            body: interactionNotes[0] ?? claimed.brief,
            emphasis: claimed.revision_direction ? "warning" : "normal",
          },
          {
            heading: "Evidence",
            body:
              artifactRefs.length > 0
                ? `${artifactRefs.length} project-scoped source artifact references are attached.`
                : "No source artifacts were attached; the design follows the written brief.",
            emphasis: "normal",
          },
        ],
        interaction_notes: interactionNotes,
        source_artifact_ids: artifactRefs,
      });
      const result = await this.finalize(claimed, rendered, interactionNotes);
      return { request_id: claimed.id, version_id: result, status: "rendered" };
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 1_000) : "mockup render failed";
      const status = claimed.attempts >= MAX_RENDER_ATTEMPTS ? "failed" : "queued";
      await this.transactions.transaction(async (tx) => {
        const updated = await tx.query<{ id: string }>(
          `UPDATE conversation_mockup_requests
              SET status=$3,lease_owner=NULL,lease_expires_at=NULL,
                  last_error=$4,
                  available_at=CASE WHEN $3='queued' THEN now()+interval '5 seconds'
                                    ELSE available_at END,
                  updated_at=now()
            WHERE id=$1 AND status='leased' AND lease_owner=$2
            RETURNING id`,
          [claimed.id, claimed.leaseOwner, status, message],
        );
        if (status === "failed" && updated.rows[0]) {
          const failureCode = `mockup_render_failed:${message}`.slice(0, 500);
          await tx.query(
            `UPDATE conversation_action_delivery_intents
                SET status='failed',lease_owner=NULL,lease_expires_at=NULL,
                    last_error=$2,updated_at=now()
              WHERE action_id=$1 AND status='fallback_queued'`,
            [claimed.action_id, failureCode],
          );
          await tx.query(
            `UPDATE conversation_actions
                SET status='failed',failure_code=$2,updated_at=now()
              WHERE id=$1 AND status='recorded'`,
            [claimed.action_id, failureCode],
          );
          await tx.query(
            `INSERT INTO conversation_action_delivery_events (
               id,project_id,work_item_id,conversation_id,action_id,sequence,status,
               delivery_mode,target_run_id,target_command_id,receipt
             ) VALUES ($1,$2,$3,$4,$5,3,'failed','checkpoint',NULL,NULL,$6::jsonb)
             ON CONFLICT(action_id,sequence) DO NOTHING`,
            [
              `action-delivery-event:${claimed.action_id}:3`,
              claimed.project_id,
              claimed.work_item_id,
              claimed.conversation_id,
              claimed.action_id,
              JSON.stringify({ kind: "failed", failure_code: failureCode }),
            ],
          );
        }
      });
      if (error instanceof Phase6MockupError && error.code === "render_lease_lost") return null;
      return { request_id: claimed.id, version_id: null, status };
    }
  }

  private async finalize(
    request: MockupRequestRow & { leaseOwner: string },
    rendered: ReturnType<typeof renderDeterministicMockup>,
    interactionNotes: string[],
  ): Promise<string> {
    return this.transactions.transaction(async (tx) => {
      const fence = (
        await tx.query<{ id: string }>(
          `SELECT id FROM conversation_mockup_requests
            WHERE id=$1 AND status='leased' AND lease_owner=$2
              AND lease_expires_at>now()
            FOR UPDATE`,
          [request.id, request.leaseOwner],
        )
      ).rows[0];
      if (!fence) throw new Phase6MockupError("render_lease_lost", "mockup render lease was lost");

      const sourceVersion = request.source_mockup_version_id
        ? (
            await tx.query<{ version: number }>(
              "SELECT version FROM conversation_mockup_versions WHERE id=$1",
              [request.source_mockup_version_id],
            )
          ).rows[0]
        : null;
      const versionNumber = sourceVersion ? Number(sourceVersion.version) + 1 : 1;
      const versionId = versionIdFor(request.id);
      const commonMetadata = {
        project_id: request.project_id,
        work_item_id: request.work_item_id,
        conversation_id: request.conversation_id,
      };
      const desktop = await this.service.artifactService().putInTransaction(tx, {
        metadata: {
          ...commonMetadata,
          media_type: "image/png",
          purpose: "mockup_desktop",
          content_hash: evidenceHash(rendered.desktop),
          byte_size: rendered.desktop.byteLength,
          idempotency_key: `${request.id}:desktop`,
        },
        content: rendered.desktop,
        label: "Desktop mockup",
        provenance: { actor_type: "coordinator", actor_id: this.workerId },
        expected_dimensions: MOCKUP_DESKTOP_VIEWPORT,
        phase_id: request.phase_id,
        task_id: request.task_id,
      });
      const mobile = await this.service.artifactService().putInTransaction(tx, {
        metadata: {
          ...commonMetadata,
          media_type: "image/png",
          purpose: "mockup_mobile",
          content_hash: evidenceHash(rendered.mobile),
          byte_size: rendered.mobile.byteLength,
          idempotency_key: `${request.id}:mobile`,
        },
        content: rendered.mobile,
        label: "Mobile mockup",
        provenance: { actor_type: "coordinator", actor_id: this.workerId },
        expected_dimensions: MOCKUP_MOBILE_VIEWPORT,
        phase_id: request.phase_id,
        task_id: request.task_id,
      });
      const screenshotManifest = [
        {
          viewport: "desktop" as const,
          artifact: desktop.evidence,
          ...MOCKUP_DESKTOP_VIEWPORT,
          capture_profile: rendered.profile,
        },
        {
          viewport: "mobile" as const,
          artifact: mobile.evidence,
          ...MOCKUP_MOBILE_VIEWPORT,
          capture_profile: rendered.profile,
        },
      ];
      const manifestValue: V2MockupManifestT = V2MockupManifest.parse({
        schema_version: 2,
        kind: "mockup",
        mockup_version_id: versionId,
        root_request_id: request.root_request_id,
        request_id: request.id,
        task_id: request.task_id,
        plan_version_id: request.plan_version_id,
        module_id: request.module_id,
        version: versionNumber,
        brief: request.brief,
        target: request.target,
        interaction_notes: interactionNotes,
        renderer_profile: rendered.profile,
        screenshots: screenshotManifest,
      });
      const canonicalManifest = canonicalJson(manifestValue);
      const manifestBytes = Buffer.from(canonicalManifest, "utf8");
      const manifest = await this.service.artifactService().putInTransaction(tx, {
        metadata: {
          ...commonMetadata,
          media_type: "application/json",
          purpose: "mockup_manifest",
          content_hash: evidenceHash(manifestBytes),
          byte_size: manifestBytes.byteLength,
          idempotency_key: `${request.id}:manifest`,
        },
        content: manifestBytes,
        label: "Mockup manifest",
        provenance: { actor_type: "coordinator", actor_id: this.workerId },
        phase_id: request.phase_id,
        task_id: request.task_id,
      });
      await tx.query(
        `INSERT INTO conversation_mockup_versions (
           id,root_request_id,request_id,project_id,work_item_id,conversation_id,
           task_id,created_by_action_id,version,brief,target,interaction_notes,
           manifest_artifact_id,manifest_artifact_hash,canonical_manifest,
           renderer_profile,supersedes_mockup_version_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,$16::jsonb,$17
         )`,
        [
          versionId,
          request.root_request_id,
          request.id,
          request.project_id,
          request.work_item_id,
          request.conversation_id,
          request.task_id,
          request.action_id,
          versionNumber,
          request.brief,
          request.target,
          JSON.stringify(interactionNotes),
          manifest.id,
          manifest.content_hash,
          canonicalManifest,
          JSON.stringify(rendered.profile),
          request.source_mockup_version_id,
        ],
      );
      for (const screenshot of [
        { viewport: "desktop", artifact: desktop, ...MOCKUP_DESKTOP_VIEWPORT },
        { viewport: "mobile", artifact: mobile, ...MOCKUP_MOBILE_VIEWPORT },
      ] as const) {
        await tx.query(
          `INSERT INTO conversation_mockup_version_artifacts (
             mockup_version_id,project_id,viewport,artifact_id,artifact_hash,
             width,height,capture_profile
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
          [
            versionId,
            request.project_id,
            screenshot.viewport,
            screenshot.artifact.id,
            screenshot.artifact.content_hash,
            screenshot.width,
            screenshot.height,
            JSON.stringify(rendered.profile),
          ],
        );
      }
      const conversation = (
        await tx.query<{ next_message_sequence: number | string }>(
          "SELECT next_message_sequence FROM work_conversations WHERE id=$1 FOR UPDATE",
          [request.conversation_id],
        )
      ).rows[0];
      if (!conversation) throw new Error("mockup conversation disappeared");
      await tx.query(
        `INSERT INTO work_messages (
           id,project_id,work_item_id,conversation_id,initiated_by_user_id,
           actor_type,actor_id,role,visibility_status,sequence,parts
         ) VALUES ($1,$2,$3,$4,$5,'coordinator',NULL,'assistant','complete',$6,$7::jsonb)`,
        [
          `message:mockup:${versionId}`,
          request.project_id,
          request.work_item_id,
          request.conversation_id,
          request.initiated_by_user_id,
          Number(conversation.next_message_sequence),
          JSON.stringify([
            {
              type: "text",
              format: "markdown",
              text: `Mockup version ${versionNumber} is ready for explicit review.`,
            },
            { type: "mockup", mockup_version_id: versionId },
          ]),
        ],
      );
      await tx.query(
        `UPDATE work_conversations
            SET next_message_sequence=next_message_sequence+1,updated_at=now()
          WHERE id=$1`,
        [request.conversation_id],
      );
      await tx.query(
        `UPDATE conversation_mockup_requests
            SET status='rendered',lease_owner=NULL,lease_expires_at=NULL,
                rendered_version_id=$3,last_error=NULL,updated_at=now()
          WHERE id=$1 AND status='leased' AND lease_owner=$2`,
        [request.id, request.leaseOwner, versionId],
      );
      await this.finishQueuedAction(tx, request, versionId);
      return versionId;
    });
  }

  private async finishQueuedAction(
    tx: V2SqlExecutor,
    request: MockupRequestRow & { leaseOwner: string },
    versionId: string,
  ): Promise<void> {
    const leased = await tx.query<{ id: string }>(
      `UPDATE conversation_action_delivery_intents
          SET status='leased',lease_owner=$2,lease_expires_at=now()+interval '30 seconds',
              attempts=attempts+1,updated_at=now()
        WHERE action_id=$1 AND status='fallback_queued'
        RETURNING id`,
      [request.action_id, request.leaseOwner],
    );
    const intentId = leased.rows[0]?.id;
    if (!intentId) throw new Error("rendered mockup action lost its delivery intent");
    const steps = [
      {
        fromAction: "recorded",
        toAction: "sent",
        actionTime: "sent_at",
        fromIntent: "leased",
        toIntent: "sent",
        status: "sent",
        receipt: { kind: "sent", outbox_id: intentId },
      },
      {
        fromAction: "sent",
        toAction: "agent_acknowledged",
        actionTime: "acknowledged_at",
        fromIntent: "sent",
        toIntent: "acknowledged",
        status: "agent_acknowledged",
        receipt: { kind: "agent_ack", ack_event_id: `mockup:${versionId}` },
      },
      {
        fromAction: "agent_acknowledged",
        toAction: "applied",
        actionTime: "applied_at",
        fromIntent: "acknowledged",
        toIntent: "applied",
        status: "applied",
        receipt: {
          kind: "applied",
          context_receipt_hash: canonicalSha256({
            action_id: request.action_id,
            mockup_version_id: versionId,
          }),
        },
      },
    ] as const;
    for (const [index, step] of steps.entries()) {
      const action = await tx.query<{ id: string }>(
        `UPDATE conversation_actions SET status=$2,${step.actionTime}=now(),updated_at=now()
          WHERE id=$1 AND status=$3 RETURNING id`,
        [request.action_id, step.toAction, step.fromAction],
      );
      const intent = await tx.query<{ id: string }>(
        `UPDATE conversation_action_delivery_intents
            SET status=$2,lease_owner=NULL,lease_expires_at=NULL,updated_at=now()
          WHERE id=$1 AND status=$3 RETURNING id`,
        [intentId, step.toIntent, step.fromIntent],
      );
      if (!action.rows[0] || !intent.rows[0]) {
        throw new Error("mockup delivery lifecycle lost its fenced action");
      }
      await tx.query(
        `INSERT INTO conversation_action_delivery_events (
           id,project_id,work_item_id,conversation_id,action_id,sequence,status,
           delivery_mode,target_run_id,target_command_id,receipt
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'checkpoint',NULL,NULL,$8::jsonb)
         ON CONFLICT(action_id,sequence) DO NOTHING`,
        [
          `action-delivery-event:${request.action_id}:${index + 3}`,
          request.project_id,
          request.work_item_id,
          request.conversation_id,
          request.action_id,
          index + 3,
          step.status,
          JSON.stringify(step.receipt),
        ],
      );
    }
  }
}
