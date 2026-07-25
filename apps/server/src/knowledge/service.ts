import { createHash } from "node:crypto";
import {
  type V2ActorT,
  V2AgentHandoff,
  type V2AgentHandoffT,
  V2AgentHeartbeat,
  type V2AgentHeartbeatT,
  V2CompletionGate,
  type V2CompletionGateT,
  V2InterfaceContractContent,
  type V2InterfaceContractContentT,
  V2InterfaceContractVersion,
  type V2InterfaceContractVersionT,
  type V2KnowledgeAuthorityT,
  V2KnowledgeConflict,
  type V2KnowledgeConflictT,
  V2KnowledgeDelta,
  type V2KnowledgeDeltaStatusT,
  type V2KnowledgeDeltaT,
  type V2KnowledgeLifecycleStatusT,
  V2KnowledgePackage,
  V2KnowledgePackageContent,
  type V2KnowledgePackageContentT,
  type V2KnowledgePackageT,
  type V2KnowledgePackageTypeT,
  V2KnowledgePackageVersion,
  type V2KnowledgePackageVersionRefT,
  type V2KnowledgePackageVersionT,
  V2PhaseKnowledgeStatus,
  type V2PhaseKnowledgeStatusT,
  V2TaskContextManifest,
  type V2TaskContextManifestT,
  V2TaskKnowledgePackage,
  type V2TaskKnowledgePackageT,
} from "@norns/contracts";
import { canonicalJson, canonicalSha256 } from "../persistence/migration/canonicalJson.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export type KnowledgeScopeKind = "project" | "phase" | "domain" | "quality" | "architecture";
export type KnowledgeDependencyKind = "mandatory" | "parent_domain" | "cross_domain";

export class KnowledgeSystemError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "invalid_transition"
      | "approval_required"
      | "missing_context"
      | "conflict"
      | "scope_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "KnowledgeSystemError";
  }
}

function idFor(prefix: string, ...parts: unknown[]): string {
  const digest = createHash("sha256").update(canonicalJson(parts)).digest("hex").slice(0, 32);
  return `${prefix}:${digest}`;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function asStringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function actorColumns(actor: V2ActorT): [V2ActorT["actor_type"], string | null] {
  return [actor.actor_type, actor.actor_id];
}

function actorFromColumns(type: unknown, id: unknown): V2ActorT | null {
  if (typeof type !== "string") return null;
  return {
    actor_type: type as V2ActorT["actor_type"],
    actor_id: typeof id === "string" ? id : null,
  };
}

interface PackageRow {
  id: string;
  project_id: string;
  name: string;
  package_type: V2KnowledgePackageTypeT;
  authority: V2KnowledgeAuthorityT;
  owner_role: string;
  scope_kind: KnowledgeScopeKind;
  scope_id: string;
  parent_package_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface PackageVersionRow {
  id: string;
  project_id: string;
  package_id: string;
  version: string;
  status: V2KnowledgeLifecycleStatusT;
  content: unknown;
  content_hash: string;
  created_by_actor_type: string;
  created_by_actor_id: string | null;
  approved_by_actor_type: string | null;
  approved_by_actor_id: string | null;
  approved_at: unknown | null;
  supersedes_version_id: string | null;
  superseded_by_version_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface PackageRefRow extends PackageVersionRow {
  name: string;
  package_type: V2KnowledgePackageTypeT;
  scope_kind: KnowledgeScopeKind;
  scope_id: string;
}

interface ContractVersionRow {
  id: string;
  project_id: string;
  contract_id: string;
  name: string;
  version: string;
  status: V2KnowledgeLifecycleStatusT;
  content: unknown;
  content_hash: string;
  created_by_actor_type: string;
  created_by_actor_id: string | null;
  approved_by_actor_type: string | null;
  approved_by_actor_id: string | null;
  approved_at: unknown | null;
  supersedes_version_id: string | null;
  superseded_by_version_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface TaskPackageRow {
  id: string;
  project_id: string;
  phase_id: string;
  task_id: string;
  version: number;
  status: "draft" | "approved" | "superseded";
  content: unknown;
  content_hash: string;
  approved_by_actor_type: string | null;
  approved_by_actor_id: string | null;
  approved_at: unknown | null;
  created_at: unknown;
  updated_at: unknown;
}

function packageFromRow(row: PackageRow): V2KnowledgePackageT {
  return V2KnowledgePackage.parse({
    schema_version: 2,
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    type: row.package_type,
    authority: row.authority,
    owner: row.owner_role,
    scope_kind: row.scope_kind,
    scope_id: row.scope_id,
    parent_package_id: row.parent_package_id,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

function packageVersionFromRow(row: PackageVersionRow): V2KnowledgePackageVersionT {
  return V2KnowledgePackageVersion.parse({
    schema_version: 2,
    id: row.id,
    project_id: row.project_id,
    package_id: row.package_id,
    version: row.version,
    status: row.status,
    content: asObject(row.content),
    content_hash: row.content_hash,
    created_by: actorFromColumns(row.created_by_actor_type, row.created_by_actor_id),
    approved_by: actorFromColumns(row.approved_by_actor_type, row.approved_by_actor_id),
    approved_at: row.approved_at ? iso(row.approved_at) : null,
    supersedes_version_id: row.supersedes_version_id,
    superseded_by_version_id: row.superseded_by_version_id,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

function packageRefFromRow(row: PackageRefRow): V2KnowledgePackageVersionRefT {
  return {
    package_id: row.package_id,
    version_id: row.id,
    name: row.name,
    type: row.package_type,
    version: row.version,
    status: row.status,
    content_hash: row.content_hash,
  };
}

function contractVersionFromRow(row: ContractVersionRow): V2InterfaceContractVersionT {
  return V2InterfaceContractVersion.parse({
    schema_version: 2,
    id: row.id,
    project_id: row.project_id,
    contract_id: row.contract_id,
    name: row.name,
    version: row.version,
    status: row.status,
    content: asObject(row.content),
    content_hash: row.content_hash,
    created_by: actorFromColumns(row.created_by_actor_type, row.created_by_actor_id),
    approved_by: actorFromColumns(row.approved_by_actor_type, row.approved_by_actor_id),
    approved_at: row.approved_at ? iso(row.approved_at) : null,
    supersedes_version_id: row.supersedes_version_id,
    superseded_by_version_id: row.superseded_by_version_id,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

function taskPackageFromRow(row: TaskPackageRow): V2TaskKnowledgePackageT {
  return V2TaskKnowledgePackage.parse({
    schema_version: 2,
    id: row.id,
    project_id: row.project_id,
    phase_id: row.phase_id,
    task_id: row.task_id,
    version: asNumber(row.version),
    status: row.status,
    ...asObject(row.content),
    content_hash: row.content_hash,
    approved_by: actorFromColumns(row.approved_by_actor_type, row.approved_by_actor_id),
    approved_at: row.approved_at ? iso(row.approved_at) : null,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  });
}

async function audit(
  sql: V2SqlExecutor,
  input: {
    projectId: string;
    phaseId?: string | null;
    taskId?: string | null;
    actor: V2ActorT;
    action: string;
    subjectType: string;
    subjectId: string;
    detail?: unknown;
    at: string;
  },
): Promise<void> {
  await sql.query(
    `INSERT INTO knowledge_audit_log (
       project_id, phase_id, task_id, actor_type, actor_id, action,
       subject_type, subject_id, detail, occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)`,
    [
      input.projectId,
      input.phaseId ?? null,
      input.taskId ?? null,
      input.actor.actor_type,
      input.actor.actor_id,
      input.action,
      input.subjectType,
      input.subjectId,
      JSON.stringify(input.detail ?? {}),
      input.at,
    ],
  );
}

async function loadPackageVersion(
  sql: V2SqlExecutor,
  versionId: string,
  lock = false,
): Promise<PackageVersionRow | null> {
  const result = await sql.query<PackageVersionRow>(
    `SELECT * FROM knowledge_package_versions WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

async function loadContractVersion(
  sql: V2SqlExecutor,
  versionId: string,
  lock = false,
): Promise<ContractVersionRow | null> {
  const result = await sql.query<ContractVersionRow>(
    `SELECT version_row.*, contract.name
       FROM knowledge_interface_contract_versions version_row
       JOIN knowledge_interface_contracts contract ON contract.id=version_row.contract_id
      WHERE version_row.id=$1${lock ? " FOR UPDATE OF version_row" : ""}`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

export interface CreateKnowledgePackageInput {
  id?: string;
  project_id: string;
  name: string;
  type: V2KnowledgePackageTypeT;
  authority: V2KnowledgeAuthorityT;
  owner: string;
  scope_kind: KnowledgeScopeKind;
  scope_id: string;
  parent_package_id?: string | null;
  actor: V2ActorT;
  created_at: string;
}

export interface CreateKnowledgePackageVersionInput {
  id?: string;
  package_id: string;
  version: string;
  content: V2KnowledgePackageContentT;
  dependency_package_ids?: Array<{
    package_id: string;
    relation_kind: KnowledgeDependencyKind;
  }>;
  actor: V2ActorT;
  created_at: string;
}

export interface CreateInterfaceContractVersionInput {
  id?: string;
  contract_id: string;
  project_id: string;
  name: string;
  owner: string;
  version: string;
  content: V2InterfaceContractContentT;
  actor: V2ActorT;
  created_at: string;
}

type TaskPackageContentInput = Pick<
  V2TaskKnowledgePackageT,
  | "assignment"
  | "expected_outcome"
  | "business_or_user_outcome"
  | "scope"
  | "out_of_scope"
  | "deliverables"
  | "file_scope_declared"
  | "permitted_files"
  | "restricted_files"
  | "required_package_ids"
  | "required_interface_contract_ids"
  | "required_decision_record_ids"
  | "dependencies"
  | "acceptance_criteria"
  | "required_tests"
  | "performance_requirements"
  | "accessibility_requirements"
  | "reporting_interval_seconds"
  | "escalation_conditions"
  | "completion_format"
  | "branch_or_workspace"
  | "token_budget"
>;

export interface CreateTaskKnowledgePackageInput extends TaskPackageContentInput {
  task_id: string;
  status: "draft" | "approved";
  actor: V2ActorT;
  created_at: string;
}

export interface AssembleManifestInput {
  task_id: string;
  repository_commit: string;
  generated_by: V2ActorT;
  generated_at: string;
  included_source_files?: Array<{ path: string; reason: string }>;
  included_test_files?: Array<{ path: string; reason: string }>;
  explicitly_excluded_context?: Array<{ item: string; reason: string }>;
  known_context_limitations?: string[];
  unresolved_questions?: string[];
}

export interface RegisterKnowledgeAgentInput {
  run_id: string;
  context_manifest_id: string;
  provider: string;
  model: string;
  branch_or_workspace: string;
  token_budget: number | null;
  actor: V2ActorT;
  registered_at: string;
}

export type RecordHeartbeatInput = Omit<
  V2AgentHeartbeatT,
  | "schema_version"
  | "id"
  | "project_id"
  | "phase_id"
  | "task_id"
  | "sequence"
  | "content_hash"
  | "repeated_update_count"
> & { actor: V2ActorT };

export type SubmitKnowledgeDeltaInput = Omit<
  V2KnowledgeDeltaT,
  | "schema_version"
  | "id"
  | "project_id"
  | "phase_id"
  | "task_id"
  | "status"
  | "disposition_note"
  | "dispositioned_by"
  | "dispositioned_at"
> & { actor: V2ActorT };

export type SubmitAgentHandoffInput = Omit<
  V2AgentHandoffT,
  "schema_version" | "id" | "project_id" | "phase_id" | "task_id"
> & { actor: V2ActorT };

export class KnowledgeSystemService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  createPackage(input: CreateKnowledgePackageInput): Promise<V2KnowledgePackageT> {
    return this.transactions.transaction(async (sql) => {
      const id =
        input.id ??
        idFor("kp", input.project_id, input.type, input.scope_kind, input.scope_id, input.name);
      if (input.parent_package_id) {
        const parent = await sql.query<{ project_id: string }>(
          "SELECT project_id FROM knowledge_packages WHERE id=$1",
          [input.parent_package_id],
        );
        if (parent.rows[0]?.project_id !== input.project_id) {
          throw new KnowledgeSystemError(
            "scope_mismatch",
            "parent knowledge package is not in this project",
          );
        }
      }
      await sql.query(
        `INSERT INTO knowledge_packages (
           id, project_id, name, package_type, authority, owner_role,
           scope_kind, scope_id, parent_package_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [
          id,
          input.project_id,
          input.name,
          input.type,
          input.authority,
          input.owner,
          input.scope_kind,
          input.scope_id,
          input.parent_package_id ?? null,
          input.created_at,
        ],
      );
      await audit(sql, {
        projectId: input.project_id,
        ...(input.scope_kind === "phase" ? { phaseId: input.scope_id } : {}),
        actor: input.actor,
        action: "knowledge.package.created",
        subjectType: "knowledge_package",
        subjectId: id,
        at: input.created_at,
      });
      const row = await sql.query<PackageRow>("SELECT * FROM knowledge_packages WHERE id=$1", [id]);
      return packageFromRow(row.rows[0] as PackageRow);
    });
  }

  createPackageVersion(
    input: CreateKnowledgePackageVersionInput,
  ): Promise<V2KnowledgePackageVersionT> {
    return this.transactions.transaction(async (sql) => {
      const packageResult = await sql.query<PackageRow>(
        "SELECT * FROM knowledge_packages WHERE id=$1 FOR UPDATE",
        [input.package_id],
      );
      const packageRow = packageResult.rows[0];
      if (!packageRow) throw new KnowledgeSystemError("not_found", "knowledge package not found");
      const content = V2KnowledgePackageContent.parse(input.content);
      const hash = canonicalSha256(content);
      const id = input.id ?? idFor("kpv", input.package_id, input.version, hash);
      const actor = actorColumns(input.actor);
      await sql.query(
        `INSERT INTO knowledge_package_versions (
           id, project_id, package_id, version, status, content, content_hash,
           created_by_actor_type, created_by_actor_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,'draft',$5::jsonb,$6,$7,$8,$9,$9)`,
        [
          id,
          packageRow.project_id,
          input.package_id,
          input.version,
          JSON.stringify(content),
          hash,
          actor[0],
          actor[1],
          input.created_at,
        ],
      );

      for (const dependency of input.dependency_package_ids ?? []) {
        const required = await sql.query<{ id: string; project_id: string }>(
          `SELECT id, project_id FROM knowledge_package_versions
            WHERE package_id=$1 AND status='active'`,
          [dependency.package_id],
        );
        const requiredVersion = required.rows[0];
        if (!requiredVersion || requiredVersion.project_id !== packageRow.project_id) {
          throw new KnowledgeSystemError(
            "missing_context",
            `dependency package ${dependency.package_id} has no active version in this project`,
          );
        }
        await sql.query(
          `INSERT INTO knowledge_package_dependencies (
             id, project_id, package_version_id, required_package_version_id, relation_kind, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            idFor("kpd", id, requiredVersion.id),
            packageRow.project_id,
            id,
            requiredVersion.id,
            dependency.relation_kind,
            input.created_at,
          ],
        );
      }
      await sql.query("UPDATE knowledge_packages SET updated_at=$2 WHERE id=$1", [
        input.package_id,
        input.created_at,
      ]);
      await audit(sql, {
        projectId: packageRow.project_id,
        ...(packageRow.scope_kind === "phase" ? { phaseId: packageRow.scope_id } : {}),
        actor: input.actor,
        action: "knowledge.package_version.created",
        subjectType: "knowledge_package_version",
        subjectId: id,
        detail: { version: input.version, content_hash: hash },
        at: input.created_at,
      });
      const row = await loadPackageVersion(sql, id);
      return packageVersionFromRow(row as PackageVersionRow);
    });
  }

  transitionPackageVersion(input: {
    version_id: string;
    to: "under_review" | "approved" | "active" | "archived";
    actor: V2ActorT;
    transitioned_at: string;
  }): Promise<V2KnowledgePackageVersionT> {
    return this.transactions.transaction(async (sql) => {
      const row = await loadPackageVersion(sql, input.version_id, true);
      if (!row) throw new KnowledgeSystemError("not_found", "knowledge package version not found");
      const allowed: Record<string, string[]> = {
        draft: ["under_review"],
        under_review: ["approved"],
        approved: ["active"],
        active: ["archived"],
      };
      if (!allowed[row.status]?.includes(input.to)) {
        throw new KnowledgeSystemError(
          "invalid_transition",
          `knowledge package version cannot move from ${row.status} to ${input.to}`,
        );
      }
      const approval =
        input.to === "approved" || input.to === "active" || input.to === "archived"
          ? actorColumns(input.actor)
          : [null, null];

      if (input.to === "active") {
        const active = await sql.query<{ id: string }>(
          `SELECT id FROM knowledge_package_versions
            WHERE package_id=$1 AND status='active' FOR UPDATE`,
          [row.package_id],
        );
        const previous = active.rows[0];
        if (previous) {
          await sql.query(
            `UPDATE knowledge_package_versions
                SET status='superseded', superseded_by_version_id=$2, updated_at=$3
              WHERE id=$1`,
            [previous.id, row.id, input.transitioned_at],
          );
          row.supersedes_version_id = previous.id;
        }
      }

      await sql.query(
        `UPDATE knowledge_package_versions
            SET status=$2,
                approved_by_actor_type=COALESCE(approved_by_actor_type,$3),
                approved_by_actor_id=COALESCE(approved_by_actor_id,$4),
                approved_at=COALESCE(approved_at,$5),
                supersedes_version_id=$6,
                updated_at=$5
          WHERE id=$1`,
        [
          row.id,
          input.to,
          approval[0],
          approval[1],
          input.transitioned_at,
          row.supersedes_version_id,
        ],
      );
      await audit(sql, {
        projectId: row.project_id,
        actor: input.actor,
        action: `knowledge.package_version.${input.to}`,
        subjectType: "knowledge_package_version",
        subjectId: row.id,
        detail: { from: row.status, to: input.to },
        at: input.transitioned_at,
      });
      return packageVersionFromRow((await loadPackageVersion(sql, row.id)) as PackageVersionRow);
    });
  }

  listPackages(projectId: string): Promise<
    Array<{
      package: V2KnowledgePackageT;
      versions: V2KnowledgePackageVersionT[];
    }>
  > {
    return this.transactions.transaction(async (sql) => {
      const packageRows = await sql.query<PackageRow>(
        "SELECT * FROM knowledge_packages WHERE project_id=$1 ORDER BY package_type, name, id",
        [projectId],
      );
      const versionRows = await sql.query<PackageVersionRow>(
        `SELECT version_row.* FROM knowledge_package_versions version_row
          WHERE project_id=$1 ORDER BY package_id, created_at, id`,
        [projectId],
      );
      return packageRows.rows.map((row) => ({
        package: packageFromRow(row),
        versions: versionRows.rows
          .filter((version) => version.package_id === row.id)
          .map(packageVersionFromRow),
      }));
    });
  }

  createInterfaceContractVersion(
    input: CreateInterfaceContractVersionInput,
  ): Promise<V2InterfaceContractVersionT> {
    return this.transactions.transaction(async (sql) => {
      const content = V2InterfaceContractContent.parse(input.content);
      const hash = canonicalSha256(content);
      const id = input.id ?? idFor("icv", input.contract_id, input.version, hash);
      await sql.query(
        `INSERT INTO knowledge_interface_contracts (
           id, project_id, name, owner_role, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$5)
         ON CONFLICT (id) DO NOTHING`,
        [input.contract_id, input.project_id, input.name, input.owner, input.created_at],
      );
      const scope = await sql.query<{ project_id: string; name: string }>(
        "SELECT project_id, name FROM knowledge_interface_contracts WHERE id=$1",
        [input.contract_id],
      );
      if (scope.rows[0]?.project_id !== input.project_id) {
        throw new KnowledgeSystemError(
          "scope_mismatch",
          "interface contract belongs to another project",
        );
      }
      const actor = actorColumns(input.actor);
      await sql.query(
        `INSERT INTO knowledge_interface_contract_versions (
           id, project_id, contract_id, version, status, content, content_hash,
           created_by_actor_type, created_by_actor_id, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,'draft',$5::jsonb,$6,$7,$8,$9,$9)`,
        [
          id,
          input.project_id,
          input.contract_id,
          input.version,
          JSON.stringify(content),
          hash,
          actor[0],
          actor[1],
          input.created_at,
        ],
      );
      await audit(sql, {
        projectId: input.project_id,
        actor: input.actor,
        action: "knowledge.interface_version.created",
        subjectType: "interface_contract_version",
        subjectId: id,
        detail: { version: input.version, content_hash: hash },
        at: input.created_at,
      });
      return contractVersionFromRow((await loadContractVersion(sql, id)) as ContractVersionRow);
    });
  }

  transitionInterfaceContractVersion(input: {
    version_id: string;
    to: "under_review" | "approved" | "active" | "archived";
    actor: V2ActorT;
    transitioned_at: string;
  }): Promise<V2InterfaceContractVersionT> {
    return this.transactions.transaction(async (sql) => {
      const row = await loadContractVersion(sql, input.version_id, true);
      if (!row) throw new KnowledgeSystemError("not_found", "interface version not found");
      const allowed: Record<string, string[]> = {
        draft: ["under_review"],
        under_review: ["approved"],
        approved: ["active"],
        active: ["archived"],
      };
      if (!allowed[row.status]?.includes(input.to)) {
        throw new KnowledgeSystemError(
          "invalid_transition",
          `interface version cannot move from ${row.status} to ${input.to}`,
        );
      }
      const approval = actorColumns(input.actor);
      let supersedes = row.supersedes_version_id;
      if (input.to === "active") {
        const active = await sql.query<{ id: string }>(
          `SELECT id FROM knowledge_interface_contract_versions
            WHERE contract_id=$1 AND status='active' FOR UPDATE`,
          [row.contract_id],
        );
        const previous = active.rows[0];
        if (previous) {
          supersedes = previous.id;
          await sql.query(
            `UPDATE knowledge_interface_contract_versions
                SET status='superseded', superseded_by_version_id=$2, updated_at=$3
              WHERE id=$1`,
            [previous.id, row.id, input.transitioned_at],
          );
        }
      }
      await sql.query(
        `UPDATE knowledge_interface_contract_versions
            SET status=$2,
                approved_by_actor_type=COALESCE(approved_by_actor_type,$3),
                approved_by_actor_id=COALESCE(approved_by_actor_id,$4),
                approved_at=COALESCE(approved_at,$5),
                supersedes_version_id=$6,
                updated_at=$5
          WHERE id=$1`,
        [row.id, input.to, approval[0], approval[1], input.transitioned_at, supersedes],
      );
      await audit(sql, {
        projectId: row.project_id,
        actor: input.actor,
        action: `knowledge.interface_version.${input.to}`,
        subjectType: "interface_contract_version",
        subjectId: row.id,
        detail: { from: row.status, to: input.to },
        at: input.transitioned_at,
      });
      return contractVersionFromRow((await loadContractVersion(sql, row.id)) as ContractVersionRow);
    });
  }

  createTaskPackage(input: CreateTaskKnowledgePackageInput): Promise<V2TaskKnowledgePackageT> {
    return this.transactions.transaction(async (sql) => {
      const task = await sql.query<{
        project_id: string;
        phase_id: string;
        deliverables: unknown;
        acceptance_criteria: unknown;
      }>("SELECT project_id, phase_id, deliverables, acceptance_criteria FROM tasks WHERE id=$1", [
        input.task_id,
      ]);
      const scope = task.rows[0];
      if (!scope) throw new KnowledgeSystemError("not_found", "task not found");
      const next = await sql.query<{ version: number }>(
        "SELECT COALESCE(max(version),0)::int + 1 AS version FROM task_knowledge_packages WHERE task_id=$1",
        [input.task_id],
      );
      const version = asNumber(next.rows[0]?.version ?? 1);
      const content: TaskPackageContentInput = {
        assignment: input.assignment,
        expected_outcome: input.expected_outcome,
        business_or_user_outcome: input.business_or_user_outcome,
        scope: input.scope,
        out_of_scope: input.out_of_scope,
        deliverables: input.deliverables,
        file_scope_declared: input.file_scope_declared,
        permitted_files: input.permitted_files,
        restricted_files: input.restricted_files,
        required_package_ids: input.required_package_ids,
        required_interface_contract_ids: input.required_interface_contract_ids,
        required_decision_record_ids: input.required_decision_record_ids,
        dependencies: input.dependencies,
        acceptance_criteria: input.acceptance_criteria,
        required_tests: input.required_tests,
        performance_requirements: input.performance_requirements,
        accessibility_requirements: input.accessibility_requirements,
        reporting_interval_seconds: input.reporting_interval_seconds,
        escalation_conditions: input.escalation_conditions,
        completion_format: input.completion_format,
        branch_or_workspace: input.branch_or_workspace,
        token_budget: input.token_budget,
      };
      const hash = canonicalSha256(content);
      const id = idFor("tkp", input.task_id, version, hash);
      const approval = input.status === "approved" ? actorColumns(input.actor) : [null, null];
      const parsed = V2TaskKnowledgePackage.parse({
        schema_version: 2,
        id,
        project_id: scope.project_id,
        phase_id: scope.phase_id,
        task_id: input.task_id,
        version,
        status: input.status,
        ...content,
        content_hash: hash,
        approved_by:
          input.status === "approved" ? { actor_type: approval[0], actor_id: approval[1] } : null,
        approved_at: input.status === "approved" ? input.created_at : null,
        created_at: input.created_at,
        updated_at: input.created_at,
      });
      if (input.status === "approved") {
        await sql.query(
          `UPDATE task_knowledge_packages
              SET status='superseded', updated_at=$2
            WHERE task_id=$1 AND status='approved'`,
          [input.task_id, input.created_at],
        );
      }
      await sql.query(
        `INSERT INTO task_knowledge_packages (
           id, project_id, phase_id, task_id, version, status, content, content_hash,
           approved_by_actor_type, approved_by_actor_id, approved_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$12)`,
        [
          id,
          scope.project_id,
          scope.phase_id,
          input.task_id,
          version,
          input.status,
          JSON.stringify(content),
          hash,
          approval[0],
          approval[1],
          input.status === "approved" ? input.created_at : null,
          input.created_at,
        ],
      );
      await audit(sql, {
        projectId: scope.project_id,
        phaseId: scope.phase_id,
        taskId: input.task_id,
        actor: input.actor,
        action: `knowledge.task_package.${input.status}`,
        subjectType: "task_knowledge_package",
        subjectId: id,
        detail: { version, content_hash: hash },
        at: input.created_at,
      });
      return parsed;
    });
  }

  getApprovedTaskPackage(taskId: string): Promise<V2TaskKnowledgePackageT | null> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<TaskPackageRow>(
        `SELECT * FROM task_knowledge_packages
          WHERE task_id=$1 AND status='approved'`,
        [taskId],
      );
      return result.rows[0] ? taskPackageFromRow(result.rows[0]) : null;
    });
  }

  assembleContextManifest(input: AssembleManifestInput): Promise<V2TaskContextManifestT> {
    return this.transactions.transaction((sql) => this.assembleManifest(sql, input));
  }

  private async assembleManifest(
    sql: V2SqlExecutor,
    input: AssembleManifestInput,
  ): Promise<V2TaskContextManifestT> {
    const task = await sql.query<{
      project_id: string;
      phase_id: string;
      title: string;
    }>("SELECT project_id, phase_id, title FROM tasks WHERE id=$1", [input.task_id]);
    const taskRow = task.rows[0];
    if (!taskRow) throw new KnowledgeSystemError("not_found", "task not found");

    const taskPackageResult = await sql.query<TaskPackageRow>(
      `SELECT * FROM task_knowledge_packages
        WHERE task_id=$1 AND status='approved'`,
      [input.task_id],
    );
    const taskPackageRow = taskPackageResult.rows[0];
    if (!taskPackageRow) {
      throw new KnowledgeSystemError(
        "missing_context",
        `task ${input.task_id} has no approved Task Package`,
      );
    }
    const taskPackage = taskPackageFromRow(taskPackageRow);

    const packageRows = await sql.query<PackageRefRow & { parent_package_id: string | null }>(
      `SELECT version_row.*, package.name, package.package_type,
              package.scope_kind, package.scope_id, package.parent_package_id
         FROM knowledge_package_versions version_row
         JOIN knowledge_packages package ON package.id=version_row.package_id
        WHERE version_row.project_id=$1 AND version_row.status='active'
        ORDER BY package.package_type, package.name, package.id`,
      [taskRow.project_id],
    );
    const activeByPackage = new Map(packageRows.rows.map((row) => [row.package_id, row]));
    const selected = new Map<string, PackageRefRow & { parent_package_id: string | null }>();

    for (const row of packageRows.rows) {
      const mandatoryProject =
        row.package_type === "project" &&
        row.scope_kind === "project" &&
        row.scope_id === taskRow.project_id;
      const mandatoryPhase =
        row.package_type === "phase" &&
        row.scope_kind === "phase" &&
        row.scope_id === taskRow.phase_id;
      const currentState =
        row.package_type === "current_state" &&
        ((row.scope_kind === "project" && row.scope_id === taskRow.project_id) ||
          (row.scope_kind === "phase" && row.scope_id === taskRow.phase_id));
      if (
        mandatoryProject ||
        mandatoryPhase ||
        currentState ||
        taskPackage.required_package_ids.includes(row.package_id)
      ) {
        selected.set(row.package_id, row);
      }
    }

    const hasProjectPackage = [...selected.values()].some(
      (row) => row.package_type === "project" && row.scope_id === taskRow.project_id,
    );
    const hasPhasePackage = [...selected.values()].some(
      (row) => row.package_type === "phase" && row.scope_id === taskRow.phase_id,
    );
    if (!hasProjectPackage || !hasPhasePackage) {
      const missing = [
        ...(!hasProjectPackage ? ["an active Project Package"] : []),
        ...(!hasPhasePackage ? ["an active Phase Package"] : []),
      ];
      throw new KnowledgeSystemError(
        "missing_context",
        `task ${input.task_id} is missing ${missing.join(" and ")}`,
      );
    }
    const missingExplicit = taskPackage.required_package_ids.filter(
      (id) => !activeByPackage.has(id),
    );
    if (missingExplicit.length > 0) {
      throw new KnowledgeSystemError(
        "missing_context",
        `required Knowledge Packages have no active version: ${missingExplicit.join(", ")}`,
      );
    }

    // Parent-domain inheritance is structural: selecting a child selects every
    // active ancestor without making the task author repeat the hierarchy.
    let parentAdded = true;
    while (parentAdded) {
      parentAdded = false;
      for (const row of [...selected.values()]) {
        if (!row.parent_package_id || selected.has(row.parent_package_id)) continue;
        const parent = activeByPackage.get(row.parent_package_id);
        if (!parent) {
          throw new KnowledgeSystemError(
            "missing_context",
            `parent package ${row.parent_package_id} has no active version`,
          );
        }
        selected.set(parent.package_id, parent);
        parentAdded = true;
      }
    }

    // Versioned dependencies are already pinned by the producing package
    // version. A dependency that has since been superseded is stale context,
    // not permission to silently substitute the latest version.
    let dependencyAdded = true;
    while (dependencyAdded) {
      dependencyAdded = false;
      const selectedVersionIds = [...selected.values()].map((row) => row.id);
      if (selectedVersionIds.length === 0) break;
      const dependencies = await sql.query<
        PackageRefRow & {
          package_version_id: string;
          relation_kind: KnowledgeDependencyKind;
          parent_package_id: string | null;
        }
      >(
        `SELECT dependency.package_version_id, dependency.relation_kind,
                required.*, package.name, package.package_type,
                package.scope_kind, package.scope_id, package.parent_package_id
           FROM knowledge_package_dependencies dependency
           JOIN knowledge_package_versions required
             ON required.id=dependency.required_package_version_id
           JOIN knowledge_packages package ON package.id=required.package_id
          WHERE dependency.package_version_id = ANY($1::text[])`,
        [selectedVersionIds],
      );
      for (const dependency of dependencies.rows) {
        if (dependency.status !== "active") {
          throw new KnowledgeSystemError(
            "missing_context",
            `package dependency ${dependency.id} is ${dependency.status}; revise the dependent package before dispatch`,
          );
        }
        if (!selected.has(dependency.package_id)) {
          selected.set(dependency.package_id, dependency);
          dependencyAdded = true;
        }
      }
    }

    const interfaceRows =
      taskPackage.required_interface_contract_ids.length === 0
        ? []
        : (
            await sql.query<ContractVersionRow>(
              `SELECT version_row.*, contract.name
                 FROM knowledge_interface_contract_versions version_row
                 JOIN knowledge_interface_contracts contract
                   ON contract.id=version_row.contract_id
                WHERE version_row.project_id=$1
                  AND version_row.contract_id = ANY($2::text[])
                  AND version_row.status='active'
                ORDER BY contract.name, contract.id`,
              [taskRow.project_id, taskPackage.required_interface_contract_ids],
            )
          ).rows;
    const foundContracts = new Set(interfaceRows.map((row) => row.contract_id));
    const missingContracts = taskPackage.required_interface_contract_ids.filter(
      (id) => !foundContracts.has(id),
    );
    if (missingContracts.length > 0) {
      throw new KnowledgeSystemError(
        "missing_context",
        `required Interface Contracts have no active version: ${missingContracts.join(", ")}`,
      );
    }

    const decisionRows =
      taskPackage.required_decision_record_ids.length === 0
        ? []
        : (
            await sql.query<{ id: string; status: string }>(
              `SELECT id, status FROM decision_records
                WHERE project_id=$1 AND id = ANY($2::text[])`,
              [taskRow.project_id, taskPackage.required_decision_record_ids],
            )
          ).rows;
    const activeDecisions = new Set(
      decisionRows.filter((row) => row.status === "active").map((row) => row.id),
    );
    const missingDecisions = taskPackage.required_decision_record_ids.filter(
      (id) => !activeDecisions.has(id),
    );
    if (missingDecisions.length > 0) {
      throw new KnowledgeSystemError(
        "missing_context",
        `required Decision Records are absent or superseded: ${missingDecisions.join(", ")}`,
      );
    }

    const includedPackages = [...selected.values()]
      .sort(
        (left, right) =>
          left.package_type.localeCompare(right.package_type) ||
          left.name.localeCompare(right.name) ||
          left.package_id.localeCompare(right.package_id),
      )
      .map(packageRefFromRow);
    const currentState = [...selected.values()]
      .filter((row) => row.package_type === "current_state")
      .flatMap((row) => V2KnowledgePackageContent.parse(asObject(row.content)).current_state);
    const selectedIds = new Set(includedPackages.map((row) => row.package_id));
    const automaticExclusions = packageRows.rows
      .filter((row) => !selectedIds.has(row.package_id))
      .map((row) => ({
        item: `${row.name} ${row.version}`,
        reason: "not required by task scope, inheritance, or an interface dependency",
      }));
    const sourceFiles =
      input.included_source_files ??
      taskPackage.permitted_files.map((path) => ({
        path,
        reason: "declared task file scope",
      }));
    const semantic = {
      project_id: taskRow.project_id,
      phase_id: taskRow.phase_id,
      task_id: input.task_id,
      task_package_id: taskPackage.id,
      generated_by: input.generated_by,
      repository_commit: input.repository_commit,
      included_packages: includedPackages,
      included_decision_records: [...activeDecisions].sort(),
      included_interface_contracts: interfaceRows.map((row) => ({
        contract_id: row.contract_id,
        version_id: row.id,
        name: row.name,
        version: row.version,
        status: row.status,
        content_hash: row.content_hash,
      })),
      included_source_files: sourceFiles,
      included_test_files: input.included_test_files ?? [],
      included_current_state: currentState,
      explicitly_excluded_context: [
        ...automaticExclusions,
        ...(input.explicitly_excluded_context ?? []),
      ],
      known_context_limitations: input.known_context_limitations ?? [],
      unresolved_questions: input.unresolved_questions ?? [],
    };
    const estimatedTokens = Math.ceil(Buffer.byteLength(canonicalJson(semantic), "utf8") / 4);
    const contentHash = canonicalSha256({ ...semantic, estimated_tokens: estimatedTokens });
    const id = idFor("tcm", input.task_id, contentHash);
    const manifest = V2TaskContextManifest.parse({
      schema_version: 2,
      id,
      ...semantic,
      estimated_tokens: estimatedTokens,
      content_hash: contentHash,
      generated_at: input.generated_at,
    });
    await sql.query(
      `INSERT INTO task_context_manifests (
         id, project_id, phase_id, task_id, task_package_id, repository_commit,
         content, content_hash, generated_by_actor_type, generated_by_actor_id,
         estimated_tokens, generated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12)
       ON CONFLICT (task_id, content_hash) DO NOTHING`,
      [
        manifest.id,
        manifest.project_id,
        manifest.phase_id,
        manifest.task_id,
        manifest.task_package_id,
        manifest.repository_commit,
        JSON.stringify(manifest),
        manifest.content_hash,
        manifest.generated_by.actor_type,
        manifest.generated_by.actor_id,
        manifest.estimated_tokens,
        manifest.generated_at,
      ],
    );
    const stored = await sql.query<{ content: unknown }>(
      "SELECT content FROM task_context_manifests WHERE task_id=$1 AND content_hash=$2",
      [input.task_id, contentHash],
    );
    await audit(sql, {
      projectId: taskRow.project_id,
      phaseId: taskRow.phase_id,
      taskId: input.task_id,
      actor: input.generated_by,
      action: "knowledge.context_manifest.assembled",
      subjectType: "task_context_manifest",
      subjectId: id,
      detail: {
        content_hash: contentHash,
        package_versions: includedPackages.map((row) => row.version_id),
      },
      at: input.generated_at,
    });
    return V2TaskContextManifest.parse(asObject(stored.rows[0]?.content ?? manifest));
  }

  /**
   * Optional bridge into the existing content-addressed task briefing. Projects
   * without an approved Task Package keep their legacy briefing; once a Task
   * Package is approved, the exact manifest and authoritative package content
   * become an additional untrimmable section.
   */
  async contextSectionForTask(
    sql: V2SqlExecutor,
    taskId: string,
  ): Promise<{ section: "knowledge"; content: Buffer } | null> {
    const taskPackage = await sql.query<{ id: string }>(
      `SELECT id FROM task_knowledge_packages
        WHERE task_id=$1 AND status='approved'`,
      [taskId],
    );
    if (!taskPackage.rows[0]) return null;
    const revision = await sql.query<{ repository_revision: string }>(
      `SELECT architecture.repository_revision
         FROM tasks task
         JOIN projects project ON project.id=task.project_id
         LEFT JOIN architecture_revisions architecture
           ON architecture.id=project.current_architecture_revision_id
        WHERE task.id=$1`,
      [taskId],
    );
    const manifest = await this.assembleManifest(sql, {
      task_id: taskId,
      repository_commit: revision.rows[0]?.repository_revision ?? "repository-revision-unavailable",
      generated_by: { actor_type: "system", actor_id: "knowledge-context-assembler" },
      generated_at: new Date().toISOString(),
    });
    const packageIds = manifest.included_packages.map((entry) => entry.version_id);
    const packageRows =
      packageIds.length === 0
        ? []
        : (
            await sql.query<PackageRefRow>(
              `SELECT version_row.*, package.name, package.package_type,
                      package.scope_kind, package.scope_id
                 FROM knowledge_package_versions version_row
                 JOIN knowledge_packages package ON package.id=version_row.package_id
                WHERE version_row.id = ANY($1::text[])
                ORDER BY package.package_type, package.name`,
              [packageIds],
            )
          ).rows;
    const contractIds = manifest.included_interface_contracts.map((entry) => entry.version_id);
    const contracts =
      contractIds.length === 0
        ? []
        : (
            await sql.query<ContractVersionRow>(
              `SELECT version_row.*, contract.name
                 FROM knowledge_interface_contract_versions version_row
                 JOIN knowledge_interface_contracts contract
                   ON contract.id=version_row.contract_id
                WHERE version_row.id = ANY($1::text[])
                ORDER BY contract.name`,
              [contractIds],
            )
          ).rows;
    const decisions =
      manifest.included_decision_records.length === 0
        ? []
        : (
            await sql.query<{ id: string; title: string; rationale: string }>(
              `SELECT id, title, rationale FROM decision_records
                WHERE id = ANY($1::text[]) ORDER BY id`,
              [manifest.included_decision_records],
            )
          ).rows;
    const task = taskPackageFromRow(
      (
        await sql.query<TaskPackageRow>("SELECT * FROM task_knowledge_packages WHERE id=$1", [
          manifest.task_package_id,
        ])
      ).rows[0] as TaskPackageRow,
    );
    const lines = [
      "# Authoritative knowledge manifest",
      "",
      `Manifest: ${manifest.id}`,
      `Repository commit: ${manifest.repository_commit}`,
      "",
      "This section contains validated current knowledge, not conversation history.",
      "The exact package and contract versions below are pinned for this task.",
      "",
      "## Task Package",
      "",
      `Assignment: ${task.assignment}`,
      `Expected outcome: ${task.expected_outcome}`,
      "",
      "Permitted files:",
      ...(task.file_scope_declared
        ? task.permitted_files.map((path) => `- ${path}`)
        : ["- File scope has not been declared; stop before overlapping repository work."]),
      "",
      "Restricted files:",
      ...(task.restricted_files.length > 0
        ? task.restricted_files.map((path) => `- ${path}`)
        : ["- None declared"]),
    ];
    for (const row of packageRows) {
      const content = V2KnowledgePackageContent.parse(asObject(row.content));
      lines.push(
        "",
        `## ${row.name} — ${row.version}`,
        "",
        content.purpose,
        "",
        ...content.authoritative_standards.map((item) => `- Standard: ${item}`),
        ...content.constraints.map((item) => `- Constraint: ${item}`),
        ...content.architecture.map((item) => `- Architecture: ${item}`),
        ...content.current_state.map((item) => `- Current state: ${item}`),
        ...content.known_issues.map((item) => `- Known issue: ${item}`),
      );
    }
    for (const row of contracts) {
      const content = V2InterfaceContractContent.parse(asObject(row.content));
      lines.push(
        "",
        `## Interface: ${row.name} — ${row.version}`,
        "",
        content.purpose,
        "",
        ...content.inputs.map((item) => `- Input: ${item}`),
        ...content.outputs.map((item) => `- Output: ${item}`),
        ...content.error_behavior.map((item) => `- Error behavior: ${item}`),
        ...content.state_ownership.map((item) => `- State ownership: ${item}`),
        ...content.cancellation_behavior.map((item) => `- Cancellation: ${item}`),
        ...content.concurrency_behavior.map((item) => `- Concurrency: ${item}`),
      );
    }
    if (decisions.length > 0) {
      lines.push("", "## Decision Records", "");
      for (const decision of decisions) {
        lines.push(`- ${decision.id}: ${decision.title} — ${decision.rationale}`);
      }
    }
    return { section: "knowledge", content: Buffer.from(`${lines.join("\n")}\n`, "utf8") };
  }

  registerAgent(input: RegisterKnowledgeAgentInput): Promise<{
    run_id: string;
    project_id: string;
    phase_id: string;
    task_id: string;
    status: string;
    started_at: string;
  }> {
    return this.transactions.transaction(async (sql) => {
      const scope = await sql.query<{
        project_id: string;
        phase_id: string;
        task_id: string;
        manifest_project_id: string;
        manifest_phase_id: string;
        manifest_task_id: string;
      }>(
        `SELECT run.project_id, run.phase_id, run.task_id,
                manifest.project_id AS manifest_project_id,
                manifest.phase_id AS manifest_phase_id,
                manifest.task_id AS manifest_task_id
           FROM agent_runs run
           JOIN task_context_manifests manifest ON manifest.id=$2
          WHERE run.id=$1`,
        [input.run_id, input.context_manifest_id],
      );
      const row = scope.rows[0];
      if (!row) throw new KnowledgeSystemError("not_found", "run or context manifest not found");
      if (
        row.project_id !== row.manifest_project_id ||
        row.phase_id !== row.manifest_phase_id ||
        row.task_id !== row.manifest_task_id
      ) {
        throw new KnowledgeSystemError(
          "scope_mismatch",
          "run and context manifest do not describe the same task",
        );
      }
      await sql.query(
        `INSERT INTO agent_execution_registrations (
           run_id, project_id, phase_id, task_id, context_manifest_id,
           provider, model, branch_or_workspace, token_budget, status, started_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'registered',$10)`,
        [
          input.run_id,
          row.project_id,
          row.phase_id,
          row.task_id,
          input.context_manifest_id,
          input.provider,
          input.model,
          input.branch_or_workspace,
          input.token_budget,
          input.registered_at,
        ],
      );
      await audit(sql, {
        projectId: row.project_id,
        phaseId: row.phase_id,
        taskId: row.task_id,
        actor: input.actor,
        action: "knowledge.agent.registered",
        subjectType: "agent_run",
        subjectId: input.run_id,
        detail: {
          provider: input.provider,
          model: input.model,
          context_manifest_id: input.context_manifest_id,
        },
        at: input.registered_at,
      });
      return {
        run_id: input.run_id,
        project_id: row.project_id,
        phase_id: row.phase_id,
        task_id: row.task_id,
        status: "registered",
        started_at: input.registered_at,
      };
    });
  }

  recordHeartbeat(input: RecordHeartbeatInput): Promise<V2AgentHeartbeatT> {
    return this.transactions.transaction(async (sql) => {
      const registration = await sql.query<{
        project_id: string;
        phase_id: string;
        task_id: string;
        status: string;
      }>(
        `SELECT project_id, phase_id, task_id, status
           FROM agent_execution_registrations WHERE run_id=$1 FOR UPDATE`,
        [input.run_id],
      );
      const scope = registration.rows[0];
      if (!scope) throw new KnowledgeSystemError("not_found", "agent run is not registered");
      if (["completed", "failed", "cancelled"].includes(scope.status)) {
        throw new KnowledgeSystemError(
          "invalid_transition",
          `terminal agent registration ${input.run_id} cannot heartbeat`,
        );
      }
      const previous = await sql.query<{
        sequence: number;
        content_hash: string;
        repeated_update_count: number;
      }>(
        `SELECT sequence, content_hash, repeated_update_count
           FROM agent_status_heartbeats
          WHERE run_id=$1 ORDER BY sequence DESC LIMIT 1`,
        [input.run_id],
      );
      const previousRow = previous.rows[0];
      const semantic = {
        status: input.status,
        completed_since_last_update: input.completed_since_last_update,
        currently_working_on: input.currently_working_on,
        findings: input.findings,
        blockers: input.blockers,
        decisions_needed: input.decisions_needed,
        files_changed: input.files_changed,
        tests: input.tests,
        estimated_remaining_work: input.estimated_remaining_work,
        risk_level: input.risk_level,
      };
      const contentHash = canonicalSha256(semantic);
      const sequence = asNumber(previousRow?.sequence ?? 0) + 1;
      const repeated =
        previousRow?.content_hash === contentHash
          ? asNumber(previousRow.repeated_update_count) + 1
          : 0;
      const id = idFor("hb", input.run_id, sequence, contentHash);
      const heartbeat = V2AgentHeartbeat.parse({
        schema_version: 2,
        id,
        project_id: scope.project_id,
        phase_id: scope.phase_id,
        task_id: scope.task_id,
        run_id: input.run_id,
        sequence,
        reported_at: input.reported_at,
        ...semantic,
        content_hash: contentHash,
        repeated_update_count: repeated,
      });
      await sql.query(
        `INSERT INTO agent_status_heartbeats (
           id, project_id, phase_id, task_id, run_id, sequence, progress_status,
           risk_level, payload, content_hash, repeated_update_count, reported_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)`,
        [
          heartbeat.id,
          heartbeat.project_id,
          heartbeat.phase_id,
          heartbeat.task_id,
          heartbeat.run_id,
          heartbeat.sequence,
          heartbeat.status,
          heartbeat.risk_level,
          JSON.stringify(heartbeat),
          heartbeat.content_hash,
          heartbeat.repeated_update_count,
          heartbeat.reported_at,
        ],
      );
      const nextStatus =
        heartbeat.status === "blocked"
          ? "blocked"
          : heartbeat.status === "waiting"
            ? "waiting"
            : "active";
      await sql.query(
        `UPDATE agent_execution_registrations
            SET status=$2, last_heartbeat_at=$3
          WHERE run_id=$1`,
        [input.run_id, nextStatus, input.reported_at],
      );
      await audit(sql, {
        projectId: scope.project_id,
        phaseId: scope.phase_id,
        taskId: scope.task_id,
        actor: input.actor,
        action:
          repeated >= 2 ? "knowledge.agent.heartbeat_stagnation" : "knowledge.agent.heartbeat",
        subjectType: "agent_run",
        subjectId: input.run_id,
        detail: { sequence, risk_level: heartbeat.risk_level, repeated_update_count: repeated },
        at: input.reported_at,
      });
      return heartbeat;
    });
  }

  submitKnowledgeDelta(input: SubmitKnowledgeDeltaInput): Promise<V2KnowledgeDeltaT> {
    return this.transactions.transaction(async (sql) => {
      const run = await sql.query<{ project_id: string; phase_id: string; task_id: string }>(
        "SELECT project_id, phase_id, task_id FROM agent_runs WHERE id=$1",
        [input.run_id],
      );
      const scope = run.rows[0];
      if (!scope) throw new KnowledgeSystemError("not_found", "agent run not found");
      const id = idFor(
        "kd",
        input.run_id,
        input.submitted_at,
        input.changes,
        input.recommended_package_updates,
      );
      const delta = V2KnowledgeDelta.parse({
        schema_version: 2,
        id,
        project_id: scope.project_id,
        phase_id: scope.phase_id,
        task_id: scope.task_id,
        run_id: input.run_id,
        status: "proposed",
        changes: input.changes,
        recommended_package_updates: input.recommended_package_updates,
        submitted_at: input.submitted_at,
        disposition_note: null,
        dispositioned_by: null,
        dispositioned_at: null,
      });
      await sql.query(
        `INSERT INTO knowledge_deltas (
           id, project_id, phase_id, task_id, run_id, status, changes,
           recommended_package_updates, submitted_at
         ) VALUES ($1,$2,$3,$4,$5,'proposed',$6::jsonb,$7::jsonb,$8)`,
        [
          delta.id,
          delta.project_id,
          delta.phase_id,
          delta.task_id,
          delta.run_id,
          JSON.stringify(delta.changes),
          JSON.stringify(delta.recommended_package_updates),
          delta.submitted_at,
        ],
      );
      await audit(sql, {
        projectId: scope.project_id,
        phaseId: scope.phase_id,
        taskId: scope.task_id,
        actor: input.actor,
        action: "knowledge.delta.submitted",
        subjectType: "knowledge_delta",
        subjectId: id,
        detail: { change_count: delta.changes.length },
        at: input.submitted_at,
      });
      return delta;
    });
  }

  dispositionKnowledgeDelta(input: {
    delta_id: string;
    status: Exclude<V2KnowledgeDeltaStatusT, "proposed">;
    note: string;
    actor: V2ActorT;
    dispositioned_at: string;
  }): Promise<V2KnowledgeDeltaT> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{
        id: string;
        project_id: string;
        phase_id: string;
        task_id: string;
        run_id: string;
        status: V2KnowledgeDeltaStatusT;
        changes: unknown;
        recommended_package_updates: unknown;
        submitted_at: unknown;
      }>("SELECT * FROM knowledge_deltas WHERE id=$1 FOR UPDATE", [input.delta_id]);
      const row = result.rows[0];
      if (!row) throw new KnowledgeSystemError("not_found", "knowledge delta not found");
      if (row.status !== "proposed" && row.status !== "deferred") {
        throw new KnowledgeSystemError(
          "invalid_transition",
          `knowledge delta is already ${row.status}`,
        );
      }
      const actor = actorColumns(input.actor);
      await sql.query(
        `UPDATE knowledge_deltas
            SET status=$2, disposition_note=$3, dispositioned_by_actor_type=$4,
                dispositioned_by_actor_id=$5, dispositioned_at=$6
          WHERE id=$1`,
        [input.delta_id, input.status, input.note, actor[0], actor[1], input.dispositioned_at],
      );
      await audit(sql, {
        projectId: row.project_id,
        phaseId: row.phase_id,
        taskId: row.task_id,
        actor: input.actor,
        action: `knowledge.delta.${input.status}`,
        subjectType: "knowledge_delta",
        subjectId: row.id,
        detail: { note: input.note },
        at: input.dispositioned_at,
      });
      return V2KnowledgeDelta.parse({
        schema_version: 2,
        id: row.id,
        project_id: row.project_id,
        phase_id: row.phase_id,
        task_id: row.task_id,
        run_id: row.run_id,
        status: input.status,
        changes: typeof row.changes === "string" ? JSON.parse(row.changes) : row.changes,
        recommended_package_updates:
          typeof row.recommended_package_updates === "string"
            ? JSON.parse(row.recommended_package_updates)
            : row.recommended_package_updates,
        submitted_at: iso(row.submitted_at),
        disposition_note: input.note,
        dispositioned_by: input.actor,
        dispositioned_at: input.dispositioned_at,
      });
    });
  }

  submitHandoff(input: SubmitAgentHandoffInput): Promise<V2AgentHandoffT> {
    return this.transactions.transaction(async (sql) => {
      const registration = await sql.query<{
        project_id: string;
        phase_id: string;
        task_id: string;
        status: string;
      }>(
        `SELECT project_id, phase_id, task_id, status
           FROM agent_execution_registrations WHERE run_id=$1 FOR UPDATE`,
        [input.run_id],
      );
      const scope = registration.rows[0];
      if (!scope) throw new KnowledgeSystemError("not_found", "agent run is not registered");
      if (input.status === "completed" && !input.knowledge_delta_id) {
        throw new KnowledgeSystemError(
          "missing_context",
          "a completed handoff must reference the run's Knowledge Delta",
        );
      }
      if (input.knowledge_delta_id) {
        const delta = await sql.query<{ run_id: string }>(
          "SELECT run_id FROM knowledge_deltas WHERE id=$1",
          [input.knowledge_delta_id],
        );
        if (delta.rows[0]?.run_id !== input.run_id) {
          throw new KnowledgeSystemError(
            "scope_mismatch",
            "handoff Knowledge Delta belongs to another run",
          );
        }
      }
      const id = idFor("handoff", input.run_id, input.submitted_at);
      const handoff = V2AgentHandoff.parse({
        schema_version: 2,
        id,
        project_id: scope.project_id,
        phase_id: scope.phase_id,
        task_id: scope.task_id,
        run_id: input.run_id,
        status: input.status,
        summary: input.summary,
        deliverables: input.deliverables,
        files_changed: input.files_changed,
        interfaces_used: input.interfaces_used,
        interfaces_changed: input.interfaces_changed,
        tests_added: input.tests_added,
        test_results: input.test_results,
        acceptance_criteria: input.acceptance_criteria,
        known_limitations: input.known_limitations,
        open_issues: input.open_issues,
        dependencies_created: input.dependencies_created,
        knowledge_delta_id: input.knowledge_delta_id,
        recommended_package_updates: input.recommended_package_updates,
        recommended_follow_up_tasks: input.recommended_follow_up_tasks,
        branch: input.branch,
        commit: input.commit,
        artifacts: input.artifacts,
        submitted_at: input.submitted_at,
      });
      await sql.query(
        `INSERT INTO agent_handoffs (
           id, project_id, phase_id, task_id, run_id, status, payload,
           knowledge_delta_id, submitted_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [
          handoff.id,
          handoff.project_id,
          handoff.phase_id,
          handoff.task_id,
          handoff.run_id,
          handoff.status,
          JSON.stringify(handoff),
          handoff.knowledge_delta_id,
          handoff.submitted_at,
        ],
      );
      const registrationStatus =
        handoff.status === "completed"
          ? "completed"
          : handoff.status === "failed"
            ? "failed"
            : "blocked";
      await sql.query(
        `UPDATE agent_execution_registrations
            SET status=$2, completed_at=$3
          WHERE run_id=$1`,
        [
          input.run_id,
          registrationStatus,
          registrationStatus === "blocked" ? null : input.submitted_at,
        ],
      );
      await audit(sql, {
        projectId: scope.project_id,
        phaseId: scope.phase_id,
        taskId: scope.task_id,
        actor: input.actor,
        action: `knowledge.agent_handoff.${handoff.status}`,
        subjectType: "agent_handoff",
        subjectId: handoff.id,
        detail: {
          branch: handoff.branch,
          commit: handoff.commit,
          knowledge_delta_id: handoff.knowledge_delta_id,
        },
        at: input.submitted_at,
      });
      return handoff;
    });
  }

  detectConflicts(input: {
    project_id: string;
    phase_id: string;
    actor: V2ActorT;
    detected_at: string;
  }): Promise<V2KnowledgeConflictT[]> {
    return this.transactions.transaction(async (sql) => {
      const registrations = await sql.query<{
        run_id: string;
        task_id: string;
        branch_or_workspace: string;
        manifest: unknown;
        task_package: unknown;
        handoff: unknown | null;
      }>(
        `SELECT registration.run_id, registration.task_id,
                registration.branch_or_workspace,
                manifest.content AS manifest,
                task_package.content AS task_package,
                handoff.payload AS handoff
           FROM agent_execution_registrations registration
           JOIN task_context_manifests manifest
             ON manifest.id=registration.context_manifest_id
           JOIN task_knowledge_packages task_package
             ON task_package.id=manifest.task_package_id
           LEFT JOIN agent_handoffs handoff ON handoff.run_id=registration.run_id
          WHERE registration.project_id=$1 AND registration.phase_id=$2
            AND registration.status IN ('registered','active','waiting','blocked','completed')
          ORDER BY registration.task_id, registration.run_id`,
        [input.project_id, input.phase_id],
      );
      const detected: V2KnowledgeConflictT[] = [];
      const recordConflict = async (
        leftTask: string,
        rightTask: string,
        kind: V2KnowledgeConflictT["kind"],
        severity: V2KnowledgeConflictT["severity"],
        summary: string,
        details: string[],
      ) => {
        const [left, right] = [leftTask, rightTask].sort();
        const id = idFor("kc", input.phase_id, left, right, kind);
        await sql.query(
          `INSERT INTO knowledge_conflicts (
             id, project_id, phase_id, left_task_id, right_task_id, severity,
             conflict_kind, summary, details, status, detected_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'open',$10)
           ON CONFLICT (phase_id, left_task_id, right_task_id, conflict_kind) DO NOTHING`,
          [
            id,
            input.project_id,
            input.phase_id,
            left,
            right,
            severity,
            kind,
            summary,
            JSON.stringify(details),
            input.detected_at,
          ],
        );
        const row = await sql.query<{
          id: string;
          project_id: string;
          phase_id: string;
          left_task_id: string;
          right_task_id: string;
          severity: V2KnowledgeConflictT["severity"];
          conflict_kind: V2KnowledgeConflictT["kind"];
          summary: string;
          details: unknown;
          status: "open" | "resolved" | "dismissed";
          detected_at: unknown;
          resolved_by_actor_type: string | null;
          resolved_by_actor_id: string | null;
          resolved_at: unknown | null;
        }>("SELECT * FROM knowledge_conflicts WHERE id=$1", [id]);
        const conflict = row.rows[0];
        if (!conflict) return;
        detected.push(
          V2KnowledgeConflict.parse({
            schema_version: 2,
            id: conflict.id,
            project_id: conflict.project_id,
            phase_id: conflict.phase_id,
            left_task_id: conflict.left_task_id,
            right_task_id: conflict.right_task_id,
            severity: conflict.severity,
            kind: conflict.conflict_kind,
            summary: conflict.summary,
            details: asStringArray(conflict.details),
            status: conflict.status,
            detected_at: iso(conflict.detected_at),
            resolved_by: actorFromColumns(
              conflict.resolved_by_actor_type,
              conflict.resolved_by_actor_id,
            ),
            resolved_at: conflict.resolved_at ? iso(conflict.resolved_at) : null,
          }),
        );
      };

      for (let leftIndex = 0; leftIndex < registrations.rows.length; leftIndex += 1) {
        for (
          let rightIndex = leftIndex + 1;
          rightIndex < registrations.rows.length;
          rightIndex += 1
        ) {
          const left = registrations.rows[leftIndex];
          const right = registrations.rows[rightIndex];
          if (!left || !right || left.task_id === right.task_id) continue;
          const leftTaskPackage = asObject(left.task_package);
          const rightTaskPackage = asObject(right.task_package);
          const leftDeclared = leftTaskPackage.file_scope_declared === true;
          const rightDeclared = rightTaskPackage.file_scope_declared === true;
          const leftFiles = asStringArray(leftTaskPackage.permitted_files);
          const rightFiles = asStringArray(rightTaskPackage.permitted_files);
          const fileOverlap = leftFiles.filter((path) => rightFiles.includes(path));
          if (!leftDeclared || !rightDeclared) {
            await recordConflict(
              left.task_id,
              right.task_id,
              "file_overlap",
              "C2",
              "Parallel file ownership cannot be proven disjoint",
              [
                ...(!leftDeclared ? [`${left.task_id} has no declared file scope`] : []),
                ...(!rightDeclared ? [`${right.task_id} has no declared file scope`] : []),
              ],
            );
          } else if (fileOverlap.length > 0) {
            await recordConflict(
              left.task_id,
              right.task_id,
              "file_overlap",
              "C2",
              "Parallel tasks declare overlapping file ownership",
              fileOverlap,
            );
          }
          if (left.branch_or_workspace === right.branch_or_workspace) {
            await recordConflict(
              left.task_id,
              right.task_id,
              "branch_overlap",
              "C4",
              "Parallel agents share one branch or workspace",
              [left.branch_or_workspace],
            );
          }
          const leftManifest = V2TaskContextManifest.parse(asObject(left.manifest));
          const rightManifest = V2TaskContextManifest.parse(asObject(right.manifest));
          const leftPackages = new Map(
            leftManifest.included_packages.map((entry) => [entry.package_id, entry.version_id]),
          );
          const versionMismatches: string[] = [];
          for (const entry of rightManifest.included_packages) {
            const leftVersion = leftPackages.get(entry.package_id);
            if (leftVersion && leftVersion !== entry.version_id) {
              versionMismatches.push(`${entry.package_id}: ${leftVersion} vs ${entry.version_id}`);
            }
          }
          if (versionMismatches.length > 0) {
            await recordConflict(
              left.task_id,
              right.task_id,
              "package_version_mismatch",
              "C3",
              "Parallel tasks use different authoritative package versions",
              versionMismatches,
            );
          }
          if (left.handoff && right.handoff) {
            const leftHandoff = V2AgentHandoff.parse(asObject(left.handoff));
            const rightHandoff = V2AgentHandoff.parse(asObject(right.handoff));
            const interfaceOverlap = leftHandoff.interfaces_changed.filter((contract) =>
              rightHandoff.interfaces_changed.includes(contract),
            );
            if (interfaceOverlap.length > 0) {
              await recordConflict(
                left.task_id,
                right.task_id,
                "interface_overlap",
                "C3",
                "Independent tasks changed the same interface",
                interfaceOverlap,
              );
            }
          }
        }
      }
      if (detected.length > 0) {
        await audit(sql, {
          projectId: input.project_id,
          phaseId: input.phase_id,
          actor: input.actor,
          action: "knowledge.conflicts.detected",
          subjectType: "phase",
          subjectId: input.phase_id,
          detail: { conflicts: detected.map((conflict) => conflict.id) },
          at: input.detected_at,
        });
      }
      return detected;
    });
  }

  resolveConflict(input: {
    conflict_id: string;
    status: "resolved" | "dismissed";
    actor: V2ActorT;
    resolved_at: string;
  }): Promise<void> {
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<{
        project_id: string;
        phase_id: string;
        left_task_id: string;
      }>("SELECT project_id, phase_id, left_task_id FROM knowledge_conflicts WHERE id=$1", [
        input.conflict_id,
      ]);
      const row = result.rows[0];
      if (!row) throw new KnowledgeSystemError("not_found", "knowledge conflict not found");
      const actor = actorColumns(input.actor);
      await sql.query(
        `UPDATE knowledge_conflicts
            SET status=$2, resolved_by_actor_type=$3, resolved_by_actor_id=$4, resolved_at=$5
          WHERE id=$1 AND status='open'`,
        [input.conflict_id, input.status, actor[0], actor[1], input.resolved_at],
      );
      await audit(sql, {
        projectId: row.project_id,
        phaseId: row.phase_id,
        taskId: row.left_task_id,
        actor: input.actor,
        action: `knowledge.conflict.${input.status}`,
        subjectType: "knowledge_conflict",
        subjectId: input.conflict_id,
        at: input.resolved_at,
      });
    });
  }

  evaluateTaskCompletion(input: {
    task_id: string;
    evaluated_at: string;
  }): Promise<V2CompletionGateT> {
    return this.transactions.transaction((sql) =>
      this.evaluateTaskCompletionInTransaction(sql, input.task_id, input.evaluated_at, true),
    );
  }

  private async evaluateTaskCompletionInTransaction(
    sql: V2SqlExecutor,
    taskId: string,
    evaluatedAt: string,
    persist: boolean,
  ): Promise<V2CompletionGateT> {
    const task = await sql.query<{
      id: string;
      project_id: string;
      phase_id: string;
      designated_run_id: string | null;
      deliverables: unknown;
      acceptance_criteria: unknown;
    }>(
      `SELECT id, project_id, phase_id, designated_run_id, deliverables, acceptance_criteria
         FROM tasks WHERE id=$1`,
      [taskId],
    );
    const taskRow = task.rows[0];
    if (!taskRow) throw new KnowledgeSystemError("not_found", "task not found");
    const taskPackage = await sql.query<TaskPackageRow>(
      `SELECT * FROM task_knowledge_packages
        WHERE task_id=$1 AND status='approved'`,
      [taskId],
    );
    const packageValue = taskPackage.rows[0] ? taskPackageFromRow(taskPackage.rows[0]) : null;
    const handoffResult = await sql.query<{ payload: unknown; knowledge_delta_id: string | null }>(
      `SELECT payload, knowledge_delta_id FROM agent_handoffs
        WHERE task_id=$1 ORDER BY submitted_at DESC LIMIT 1`,
      [taskId],
    );
    const handoff = handoffResult.rows[0]
      ? V2AgentHandoff.parse(asObject(handoffResult.rows[0].payload))
      : null;
    const run = taskRow.designated_run_id
      ? (
          await sql.query<{ verification_status: string }>(
            "SELECT verification_status FROM agent_runs WHERE id=$1",
            [taskRow.designated_run_id],
          )
        ).rows[0]
      : null;
    const reviewPolicy = await sql.query<{
      requires_independent_review: boolean;
    }>(
      `SELECT COALESCE(
                constraint_row.requires_independent_review,
                CASE
                  WHEN planning.mode='quick'
                   AND assignment.reviewer_agent_profile_id IS NULL
                  THEN false
                  ELSE true
                END
              ) AS requires_independent_review
         FROM tasks task
         JOIN phases phase ON phase.id=task.phase_id
         LEFT JOIN planning_runs planning ON planning.id=phase.planning_run_id
         LEFT JOIN agent_assignments assignment
           ON assignment.id=task.designated_assignment_id
         LEFT JOIN task_coordination_constraints constraint_row
           ON constraint_row.task_id=task.id
        WHERE task.id=$1`,
      [taskId],
    );
    const review = await sql.query<{ approved: number }>(
      `SELECT count(*)::int AS approved FROM agent_reviews
        WHERE task_id=$1 AND decision='approved'`,
      [taskId],
    );
    const conflict = await sql.query<{ id: string; summary: string }>(
      `SELECT id, summary FROM knowledge_conflicts
        WHERE status='open' AND severity IN ('C3','C4')
          AND (left_task_id=$1 OR right_task_id=$1)`,
      [taskId],
    );
    const expectedCriteria =
      packageValue?.acceptance_criteria ?? asStringArray(taskRow.acceptance_criteria);
    const handoffCriteria = new Map(
      (handoff?.acceptance_criteria ?? []).map((criterion) => [criterion.criterion, criterion]),
    );
    const missingCriteria = expectedCriteria.filter(
      (criterion) => handoffCriteria.get(criterion)?.result !== "pass",
    );
    const requiredTests = packageValue?.required_tests ?? [];
    const checks = [
      {
        id: "approved_task_package",
        label: "Approved Task Package exists",
        passed: packageValue !== null,
        evidence: packageValue ? [packageValue.id] : [],
      },
      {
        id: "deliverables",
        label: "Required deliverables are reported",
        passed:
          Boolean(handoff) &&
          (handoff?.deliverables.length ?? 0) >=
            (packageValue?.deliverables ?? asStringArray(taskRow.deliverables)).length,
        evidence: handoff?.deliverables ?? [],
      },
      {
        id: "acceptance_criteria",
        label: "Every acceptance criterion passes with evidence",
        passed: Boolean(handoff) && missingCriteria.length === 0,
        evidence:
          handoff?.acceptance_criteria.map(
            (criterion) => `${criterion.result}: ${criterion.criterion} — ${criterion.evidence}`,
          ) ?? [],
      },
      {
        id: "required_tests",
        label: "Required tests are reported",
        passed:
          Boolean(handoff) &&
          (requiredTests.length === 0 || (handoff?.test_results.length ?? 0) > 0),
        evidence: handoff?.test_results ?? [],
      },
      {
        id: "verification",
        label: "Runner verification passed",
        passed: run?.verification_status === "passed",
        evidence: run ? [`verification_status=${run.verification_status}`] : [],
      },
      {
        id: "independent_review",
        label: "Independent review is approved when required",
        passed:
          reviewPolicy.rows[0]?.requires_independent_review === false ||
          asNumber(review.rows[0]?.approved) > 0,
        evidence: [`approved_reviews=${asNumber(review.rows[0]?.approved)}`],
      },
      {
        id: "knowledge_delta",
        label: "Knowledge Delta is submitted",
        passed: Boolean(handoff?.knowledge_delta_id),
        evidence: handoff?.knowledge_delta_id ? [handoff.knowledge_delta_id] : [],
      },
      {
        id: "handoff",
        label: "Structured completion handoff exists",
        passed: handoff?.status === "completed",
        evidence: handoff ? [handoff.id, handoff.commit] : [],
      },
      {
        id: "critical_conflicts",
        label: "No unresolved C3 or C4 conflict remains",
        passed: conflict.rows.length === 0,
        evidence: conflict.rows.map((row) => `${row.id}: ${row.summary}`),
      },
    ];
    const blockers = checks
      .filter((check) => !check.passed)
      .map((check) => check.label)
      .concat(missingCriteria.map((criterion) => `Acceptance criterion: ${criterion}`));
    const gate = V2CompletionGate.parse({
      schema_version: 2,
      scope_type: "task",
      scope_id: taskId,
      passed: blockers.length === 0,
      evaluated_at: evaluatedAt,
      checks,
      blockers,
    });
    if (persist) {
      return this.persistCompletionGate(sql, {
        id: idFor("gate", "task", taskId, evaluatedAt),
        project_id: taskRow.project_id,
        phase_id: taskRow.phase_id,
        task_id: taskId,
        gate,
      });
    }
    return gate;
  }

  /**
   * Completion-gate ids are deterministic across runner replay. A knowledge
   * handoff and the terminal run event may legitimately evaluate the same
   * task at the same runner timestamp, and reconnect can evaluate it again.
   * Treat that exact write as an idempotent replay, but never let the primary
   * key hide a different evaluation: every persisted field and the canonical
   * gate payload must still match the value computed in this transaction.
   */
  private async persistCompletionGate(
    sql: V2SqlExecutor,
    input: {
      id: string;
      project_id: string;
      phase_id: string;
      task_id: string | null;
      gate: V2CompletionGateT;
    },
  ): Promise<V2CompletionGateT> {
    const inserted = await sql.query<{ id: string }>(
      `INSERT INTO knowledge_gate_evaluations (
         id, project_id, phase_id, task_id, scope_type, scope_id,
         passed, payload, evaluated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        input.id,
        input.project_id,
        input.phase_id,
        input.task_id,
        input.gate.scope_type,
        input.gate.scope_id,
        input.gate.passed,
        JSON.stringify(input.gate),
        input.gate.evaluated_at,
      ],
    );
    if (inserted.rows[0]) return input.gate;

    const existing = await sql.query<{
      project_id: string;
      phase_id: string | null;
      task_id: string | null;
      scope_type: string;
      scope_id: string;
      passed: boolean;
      payload: unknown;
      evaluated_at: unknown;
    }>(
      `SELECT project_id, phase_id, task_id, scope_type, scope_id,
              passed, payload, evaluated_at
         FROM knowledge_gate_evaluations
        WHERE id=$1`,
      [input.id],
    );
    const row = existing.rows[0];
    const persistedGate = row ? V2CompletionGate.parse(asObject(row.payload)) : null;
    if (!row || !persistedGate) {
      throw new KnowledgeSystemError(
        "conflict",
        `completion gate ${input.id} conflicted but could not be loaded`,
      );
    }
    const expectedFingerprint = canonicalJson({
      project_id: input.project_id,
      phase_id: input.phase_id,
      task_id: input.task_id,
      scope_type: input.gate.scope_type,
      scope_id: input.gate.scope_id,
      passed: input.gate.passed,
      evaluated_at: input.gate.evaluated_at,
      payload: input.gate,
    });
    const persistedFingerprint = canonicalJson({
      project_id: row.project_id,
      phase_id: row.phase_id,
      task_id: row.task_id,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      passed: row.passed,
      evaluated_at: iso(row.evaluated_at),
      payload: persistedGate,
    });
    if (persistedFingerprint !== expectedFingerprint) {
      throw new KnowledgeSystemError(
        "conflict",
        `completion gate ${input.id} already exists with different evidence`,
      );
    }
    return persistedGate;
  }

  evaluatePhaseCompletion(input: {
    project_id: string;
    phase_id: string;
    evaluated_at: string;
  }): Promise<V2CompletionGateT> {
    return this.transactions.transaction(async (sql) => {
      const phase = await sql.query<{ id: string }>(
        "SELECT id FROM phases WHERE id=$1 AND project_id=$2",
        [input.phase_id, input.project_id],
      );
      if (!phase.rows[0]) throw new KnowledgeSystemError("not_found", "phase not found");
      const tasks = await sql.query<{ id: string }>(
        "SELECT id FROM tasks WHERE phase_id=$1 ORDER BY created_at, id",
        [input.phase_id],
      );
      const taskGates: V2CompletionGateT[] = [];
      for (const task of tasks.rows) {
        taskGates.push(
          await this.evaluateTaskCompletionInTransaction(sql, task.id, input.evaluated_at, false),
        );
      }
      const unresolvedDeltas = await sql.query<{ id: string }>(
        `SELECT id FROM knowledge_deltas
          WHERE phase_id=$1 AND status IN ('proposed','deferred','escalated')`,
        [input.phase_id],
      );
      const criticalConflicts = await sql.query<{ id: string }>(
        `SELECT id FROM knowledge_conflicts
          WHERE phase_id=$1 AND status='open' AND severity IN ('C3','C4')`,
        [input.phase_id],
      );
      const integrationConflicts = await sql.query<{ id: string }>(
        `SELECT id FROM run_integration_conflicts
          WHERE phase_id=$1 AND status='awaiting_human'`,
        [input.phase_id],
      );
      const openDecisions = await sql.query<{ id: string }>(
        `SELECT id FROM decision_points
          WHERE phase_id=$1 AND status='open'`,
        [input.phase_id],
      );
      const pendingPackageVersions = await sql.query<{ id: string }>(
        `SELECT version_row.id
           FROM knowledge_package_versions version_row
           JOIN knowledge_packages package ON package.id=version_row.package_id
          WHERE version_row.project_id=$1
            AND (
              (package.scope_kind='phase' AND package.scope_id=$2)
              OR (package.package_type='current_state' AND package.scope_id=$2)
            )
            AND version_row.status IN ('draft','under_review','approved')`,
        [input.project_id, input.phase_id],
      );
      const qualityTaskIds = (
        await sql.query<{ task_id: string; content: unknown }>(
          `SELECT task_id, content FROM task_knowledge_packages
            WHERE phase_id=$1 AND status='approved'`,
          [input.phase_id],
        )
      ).rows
        .filter((row) => {
          const content = asObject(row.content);
          return (
            asStringArray(content.performance_requirements).length > 0 ||
            asStringArray(content.accessibility_requirements).length > 0
          );
        })
        .map((row) => row.task_id);
      const failedTaskGates = taskGates.filter((gate) => !gate.passed);
      const qualityFailures = taskGates.filter(
        (gate) => qualityTaskIds.includes(gate.scope_id) && !gate.passed,
      );
      const checks = [
        {
          id: "tasks",
          label: "Every required task passes its completion gate",
          passed: tasks.rows.length > 0 && failedTaskGates.length === 0,
          evidence: taskGates.map(
            (gate) => `${gate.scope_id}: ${gate.passed ? "pass" : gate.blockers.join("; ")}`,
          ),
        },
        {
          id: "integration",
          label: "Integration has no unresolved conflicts",
          passed: integrationConflicts.rows.length === 0 && criticalConflicts.rows.length === 0,
          evidence: [
            ...integrationConflicts.rows.map((row) => row.id),
            ...criticalConflicts.rows.map((row) => row.id),
          ],
        },
        {
          id: "quality",
          label: "Performance and accessibility requirements pass",
          passed: qualityFailures.length === 0,
          evidence: qualityTaskIds,
        },
        {
          id: "decisions",
          label: "No human decision remains open",
          passed: openDecisions.rows.length === 0,
          evidence: openDecisions.rows.map((row) => row.id),
        },
        {
          id: "knowledge_reconciliation",
          label: "Knowledge Deltas are reconciled",
          passed: unresolvedDeltas.rows.length === 0 && pendingPackageVersions.rows.length === 0,
          evidence: [
            ...unresolvedDeltas.rows.map((row) => row.id),
            ...pendingPackageVersions.rows.map((row) => row.id),
          ],
        },
      ];
      const blockers = checks.filter((check) => !check.passed).map((check) => check.label);
      const gate = V2CompletionGate.parse({
        schema_version: 2,
        scope_type: "phase",
        scope_id: input.phase_id,
        passed: blockers.length === 0,
        evaluated_at: input.evaluated_at,
        checks,
        blockers,
      });
      return this.persistCompletionGate(sql, {
        id: idFor("gate", "phase", input.phase_id, input.evaluated_at),
        project_id: input.project_id,
        phase_id: input.phase_id,
        task_id: null,
        gate,
      });
    });
  }

  phaseStatus(
    projectId: string,
    phaseId: string,
    generatedAt: string,
  ): Promise<V2PhaseKnowledgeStatusT> {
    return this.transactions.transaction(async (sql) => {
      const phase = await sql.query<{ id: string }>(
        "SELECT id FROM phases WHERE id=$1 AND project_id=$2",
        [phaseId, projectId],
      );
      if (!phase.rows[0]) throw new KnowledgeSystemError("not_found", "phase not found");
      const taskRows = await sql.query<{
        id: string;
        title: string;
        state: string;
        package_content: unknown | null;
        handoff_payload: unknown | null;
      }>(
        `SELECT task.id, task.title, task.state,
                task_package.content AS package_content,
                handoff.payload AS handoff_payload
           FROM tasks task
           LEFT JOIN task_knowledge_packages task_package
             ON task_package.task_id=task.id AND task_package.status='approved'
           LEFT JOIN agent_handoffs handoff ON handoff.task_id=task.id
          WHERE task.phase_id=$1
          ORDER BY task.created_at, task.id`,
        [phaseId],
      );
      const heartbeatRows = await sql.query<{
        run_id: string;
        task_id: string;
        payload: unknown;
        reported_at: unknown;
        repeated_update_count: number;
      }>(
        `SELECT DISTINCT ON (heartbeat.run_id)
                heartbeat.run_id, heartbeat.task_id, heartbeat.payload,
                heartbeat.reported_at, heartbeat.repeated_update_count
           FROM agent_status_heartbeats heartbeat
          WHERE heartbeat.phase_id=$1
          ORDER BY heartbeat.run_id, heartbeat.sequence DESC`,
        [phaseId],
      );
      const registrations = await sql.query<{
        run_id: string;
        task_id: string;
        started_at: unknown;
        last_heartbeat_at: unknown | null;
        status: string;
      }>(
        `SELECT run_id, task_id, started_at, last_heartbeat_at, status
           FROM agent_execution_registrations
          WHERE phase_id=$1 AND status IN ('registered','active','waiting','blocked')`,
        [phaseId],
      );
      const nowMs = new Date(generatedAt).getTime();
      const taskPackageByTask = new Map(
        taskRows.rows.map((row) => [row.id, asObject(row.package_content)]),
      );
      const missingHeartbeatRunIds = registrations.rows
        .filter((registration) => {
          const packageContent = taskPackageByTask.get(registration.task_id);
          const interval = asNumber(packageContent?.reporting_interval_seconds ?? 300);
          const last = registration.last_heartbeat_at ?? registration.started_at;
          return nowMs - new Date(String(last)).getTime() > interval * 2 * 1000;
        })
        .map((registration) => registration.run_id);
      const latestHeartbeats = heartbeatRows.rows.map((row) =>
        V2AgentHeartbeat.parse(asObject(row.payload)),
      );
      const completed = taskRows.rows
        .filter((row) => {
          if (!row.handoff_payload) return false;
          return V2AgentHandoff.parse(asObject(row.handoff_payload)).status === "completed";
        })
        .map((row) => row.title);
      const inProgress = taskRows.rows
        .filter((row) => !completed.includes(row.title) && row.state !== "cancelled")
        .map((row) => row.title);
      const blockers = [
        ...latestHeartbeats.flatMap((heartbeat) => heartbeat.blockers),
        ...missingHeartbeatRunIds.map((runId) => `Missing heartbeat from ${runId}`),
      ];
      const conflictRows = await sql.query<{ summary: string; severity: string }>(
        `SELECT summary, severity FROM knowledge_conflicts
          WHERE phase_id=$1 AND status='open' ORDER BY severity DESC, detected_at`,
        [phaseId],
      );
      blockers.push(
        ...conflictRows.rows
          .filter((row) => ["C3", "C4"].includes(row.severity))
          .map((row) => row.summary),
      );
      const risks = [
        ...latestHeartbeats
          .filter((heartbeat) => heartbeat.risk_level !== "green")
          .map((heartbeat) => `${heartbeat.run_id}: ${heartbeat.risk_level}`),
        ...latestHeartbeats
          .filter((heartbeat) => heartbeat.repeated_update_count >= 2)
          .map((heartbeat) => `${heartbeat.run_id}: repeated identical status updates`),
        ...conflictRows.rows
          .filter((row) => ["C1", "C2"].includes(row.severity))
          .map((row) => row.summary),
      ];
      const openDecisions = await sql.query<{ question: string }>(
        `SELECT question FROM decision_points
          WHERE phase_id=$1 AND status='open' ORDER BY created_at`,
        [phaseId],
      );
      const decisionsRequired = [
        ...latestHeartbeats.flatMap((heartbeat) => heartbeat.decisions_needed),
        ...openDecisions.rows.map((row) => row.question),
      ];
      const overallStatus =
        blockers.length > 0 || latestHeartbeats.some((heartbeat) => heartbeat.risk_level === "red")
          ? "red"
          : risks.length > 0 || decisionsRequired.length > 0
            ? "yellow"
            : "green";
      return V2PhaseKnowledgeStatus.parse({
        schema_version: 2,
        project_id: projectId,
        phase_id: phaseId,
        overall_status: overallStatus,
        completed,
        in_progress: inProgress,
        blockers,
        risks,
        decisions_required: decisionsRequired,
        active_agents: registrations.rows.length,
        next_milestone: inProgress[0] ?? (completed.length > 0 ? "Phase completion gate" : ""),
        missing_heartbeat_run_ids: missingHeartbeatRunIds,
        generated_at: generatedAt,
      });
    });
  }
}
