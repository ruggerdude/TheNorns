// EXECUTION E1: the missing component. Nothing in TheNorns ever assembled a
// task prompt, so both schedule routes demanded caller-supplied `context_refs`
// that no producer could mint — approving a plan was the product's terminal
// state. This module turns an approved, materialized task into the exact
// content-addressed refs `HashVerifiedContextLoader` fetches and verifies.
//
// Three rules govern everything below:
//
//  1. DETERMINISM. Same task + same inputs => byte-identical documents =>
//     identical `content_hash` and `artifact_id`. Nothing wall-clock, nothing
//     random, every list explicitly ordered. Re-assembly is therefore free and
//     safe, and a changed hash always means changed inputs.
//  2. HONESTY. A missing required input is a specific, actionable failure —
//     never a thinner prompt. An agent that has to guess the build command or
//     the acceptance criteria produces work nobody can verify. Repository facts
//     are read, never invented.
//  3. SIZE DISCIPLINE. A hard total cap, and when it binds, the lowest-value
//     material goes first. The task and its acceptance criteria are never
//     trimmed; if the untrimmable core alone exceeds the cap, that is a
//     failure, not a truncation.
import type { V2ContentAddressedReferenceT } from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";
import type { TaskContextStore } from "./taskContextStore.js";

/**
 * The frozen interface EXECUTION E1 and E2 build against.
 *
 * Assemble everything one task's agent needs, store it content-addressed, and
 * return refs the runner can fetch and hash-verify.
 */
export interface TaskContextAssembler {
  assembleForTask(taskId: string): Promise<V2ContentAddressedReferenceT[]>;
}

// ---- size policy ------------------------------------------------------------

/**
 * Total assembled context cap, across every ref, measured in UTF-8 bytes of the
 * stored documents. 256 KiB is ~64k tokens of prose — comfortably inside every
 * runtime this dispatches to while leaving room for the agent's own reading of
 * the repository, which is where its context budget should actually go. The
 * cap is on the *briefing*, not on the work.
 */
export const MAX_TOTAL_CONTEXT_BYTES = 256 * 1024;

/** Repository-fact keys that describe how to build, test, and lint. */
export const VERIFICATION_COMMAND_KEYS = ["build_command", "test_command", "lint_command"] as const;

// ---- failures ---------------------------------------------------------------

export type TaskContextAssemblyCode =
  | "task_not_found"
  | "strategy_not_approved"
  | "strategy_superseded"
  | "project_missing"
  | "objective_missing"
  | "deliverables_missing"
  | "acceptance_criteria_missing"
  | "architecture_revision_missing"
  | "repository_facts_missing"
  | "verification_commands_missing"
  | "context_too_large";

/**
 * A refusal to assemble. `action_required` names the human step that unblocks
 * it, mirroring ActionsExecutionError so the route surface can render it.
 */
export class TaskContextAssemblyError extends Error {
  constructor(
    readonly code: TaskContextAssemblyCode,
    message: string,
    readonly action_required: string,
  ) {
    super(message);
    this.name = "TaskContextAssemblyError";
  }
}

// ---- row shapes -------------------------------------------------------------

interface TaskRow {
  id: string;
  project_id: string;
  phase_id: string;
  objective_id: string;
  strategy_version_id: string;
  title: string;
  description: string;
  deliverables: unknown;
  acceptance_criteria: unknown;
  complexity: string;
  risk: string;
  required_roles: unknown;
  required_capabilities: unknown;
  required_inputs: unknown;
  expected_outputs: unknown;
  environment_policy_ref: string;
  verification_policy_ref: string;
  state: string;
  designated_assignment_id: string | null;
}

interface PhaseRow {
  id: string;
  objective_summary: string;
  status: string;
  approved_strategy_version_id: string | null;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  current_architecture_revision_id: string | null;
  verification_policy_ref: string;
}

interface ObjectiveRow {
  id: string;
  outcome: string;
  success_measures: unknown;
  status: string;
}

interface ArchitectureRow {
  id: string;
  revision: number | string;
  title: string;
  summary: string;
  repository_revision: string;
}

interface MemoryRow {
  id: string;
  category: string;
  content: string;
  confidence: number | string;
}

interface DependencyRow {
  id: string;
  title: string;
  state: string;
  expected_outputs: unknown;
  completion_evidence: unknown;
}

interface AssignmentRow {
  id: string;
  rationale: string;
  provider: string | null;
  model: string | null;
  roles: unknown;
}

// ---- helpers ----------------------------------------------------------------

function asStringList(value: unknown): string[] {
  const raw = typeof value === "string" ? safeJson(value) : value;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) =>
      typeof item === "string"
        ? item.trim()
        : item && typeof item === "object"
          ? JSON.stringify(item)
          : String(item ?? "").trim(),
    )
    .filter((item) => item.length > 0);
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join("\n");
}

function utf8(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

/** `"key: value"` is the shape repository ingestion writes for a fact. */
function splitFact(content: string): { key: string; value: string } {
  const index = content.indexOf(":");
  if (index <= 0) return { key: content.trim(), value: "" };
  return { key: content.slice(0, index).trim(), value: content.slice(index + 1).trim() };
}

function numeric(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

// ---- the assembled model ----------------------------------------------------

interface RepositoryFact {
  id: string;
  key: string;
  value: string;
  confidence: number;
  /** Build/test/lint commands are policy, not trivia — never trimmed. */
  policy: boolean;
}

interface DependencyOutcome {
  id: string;
  title: string;
  state: string;
  expected_outputs: string[];
  completion_evidence: string[];
}

interface MemoryItem {
  id: string;
  category: string;
  content: string;
}

interface ContextModel {
  project: ProjectRow;
  phase: PhaseRow;
  objective: ObjectiveRow;
  task: TaskRow;
  assignment: AssignmentRow | null;
  architecture: ArchitectureRow;
  facts: RepositoryFact[];
  directives: MemoryItem[];
  dependencies: DependencyOutcome[];
  /** Set once dependency detail has been degraded to title+state. */
  dependenciesCompact: boolean;
  memory: MemoryItem[];
}

/** Emission order. The runner's loader concatenates refs in array order, so
 *  this is literally the prompt order the agent reads. */
const SECTION_ORDER = [
  "mission",
  "objective",
  "task",
  "dependencies",
  "repository",
  "directives",
  "memory",
] as const;
type SectionName = (typeof SECTION_ORDER)[number];

// ---- rendering --------------------------------------------------------------

function renderMission(model: ContextModel): string {
  const lines = [
    "# Norns task briefing",
    "",
    "You are an autonomous coding agent. You have been dispatched to complete ONE",
    "task inside a dedicated git worktree of this project's repository. Everything",
    "you need to start is in this briefing; you will not be asked follow-up",
    "questions and there is no human in the loop while you work.",
    "",
    "How to work:",
    "",
    bullets([
      "Read the repository before changing it. This briefing states facts about the project, not its full source.",
      "Do exactly the task in the TASK section. Do not expand its scope.",
      "Every acceptance criterion must be satisfied and demonstrably true before you finish.",
      "Run the project's build, test, and lint commands (REPOSITORY section) and leave them passing.",
      "Follow every project directive and constraint; they override your own defaults.",
      "Commit your work on the branch you were given. Do not merge, rebase onto, or push to other branches.",
      "If the task is impossible as specified, stop and report why. Do not substitute a different task.",
    ]),
    "",
    "## Project",
    "",
    `- Name: ${model.project.name}`,
  ];
  const description = model.project.description.trim();
  if (description.length > 0) {
    lines.push("", description);
  }
  return lines.join("\n");
}

function renderObjective(model: ContextModel): string {
  const measures = asStringList(model.objective.success_measures);
  const lines = [
    "## Phase objective",
    "",
    "This task exists to advance the objective below. Judge your own work against it.",
    "",
    "### Phase goal",
    "",
    model.phase.objective_summary.trim(),
    "",
    "### Objective outcome",
    "",
    model.objective.outcome.trim(),
  ];
  if (measures.length > 0) {
    lines.push("", "### Success measures", "", bullets(measures));
  }
  return lines.join("\n");
}

function renderTask(model: ContextModel): string {
  const task = model.task;
  const lines = [
    "## TASK — this is what you must deliver",
    "",
    `### ${task.title.trim()}`,
    "",
    task.description.trim(),
    "",
    "### Deliverables",
    "",
    bullets(asStringList(task.deliverables)),
    "",
    "### Acceptance criteria",
    "",
    "You are done only when every one of these is true and you can show it:",
    "",
    bullets(asStringList(task.acceptance_criteria)),
  ];
  const expected = asStringList(task.expected_outputs);
  if (expected.length > 0) {
    lines.push("", "### Expected outputs", "", bullets(expected));
  }
  const inputs = asStringList(task.required_inputs);
  if (inputs.length > 0) {
    lines.push("", "### Required inputs", "", bullets(inputs));
  }
  const roles = asStringList(task.required_roles);
  const capabilities = asStringList(task.required_capabilities);
  lines.push(
    "",
    "### Task profile",
    "",
    bullets([
      `Complexity: ${task.complexity}`,
      `Risk: ${task.risk}`,
      ...(roles.length > 0 ? [`Required roles: ${roles.join(", ")}`] : []),
      ...(capabilities.length > 0 ? [`Required capabilities: ${capabilities.join(", ")}`] : []),
      `Verification policy: ${task.verification_policy_ref}`,
      `Environment policy: ${task.environment_policy_ref}`,
    ]),
  );
  if (model.assignment) {
    const profile = [
      asStringList(model.assignment.roles).join(", "),
      model.assignment.provider ?? "",
      model.assignment.model ?? "",
    ]
      .filter((part) => part.length > 0)
      .join(" / ");
    const rationale = model.assignment.rationale.trim();
    lines.push(
      "",
      "### Why you were assigned",
      "",
      profile.length > 0 ? `${profile}: ${rationale}` : rationale,
    );
  }
  return lines.join("\n");
}

function renderDependencies(model: ContextModel): string | null {
  if (model.dependencies.length === 0) return null;
  const lines = [
    "## Upstream tasks",
    "",
    "These tasks precede yours. Build on what they produced; do not redo them.",
    "",
  ];
  for (const dependency of model.dependencies) {
    lines.push(`### ${dependency.title.trim()} (${dependency.state})`);
    if (!model.dependenciesCompact) {
      if (dependency.expected_outputs.length > 0) {
        lines.push("", "Produced:", "", bullets(dependency.expected_outputs));
      }
      if (dependency.completion_evidence.length > 0) {
        lines.push("", "Evidence:", "", bullets(dependency.completion_evidence));
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function renderRepository(model: ContextModel): string {
  const policy = model.facts.filter((fact) => fact.policy);
  const other = model.facts.filter((fact) => !fact.policy);
  const lines = [
    "## Repository",
    "",
    "Facts ingested from this repository. They are authoritative — do not contradict",
    "them, and do not assume anything about the codebase that is not stated here or",
    "visible in the working tree.",
    "",
    "### Architecture",
    "",
    `Revision ${model.architecture.revision} — ${model.architecture.title.trim()}`,
    `Ingested at repository revision \`${model.architecture.repository_revision}\`.`,
    "",
    model.architecture.summary.trim(),
    "",
    "### Build, test, and lint",
    "",
    "Run these from the repository root. They must pass before you finish.",
    "",
    bullets(policy.map((fact) => `${fact.key}: \`${fact.value}\``)),
  ];
  if (other.length > 0) {
    lines.push("", "### Repository facts", "", bullets(other.map((f) => `${f.key}: ${f.value}`)));
  }
  lines.push(
    "",
    "### Verification policy",
    "",
    `- Project policy: ${model.project.verification_policy_ref}`,
    `- Task policy: ${model.task.verification_policy_ref}`,
  );
  return lines.join("\n");
}

function renderDirectives(model: ContextModel): string | null {
  if (model.directives.length === 0) return null;
  const directives = model.directives.filter((item) => item.category === "directive");
  const constraints = model.directives.filter((item) => item.category === "constraint");
  const lines = [
    "## Project directives and constraints",
    "",
    "These are binding. They override your defaults and any habit from other projects.",
  ];
  if (directives.length > 0) {
    lines.push("", "### Directives", "", bullets(directives.map((item) => item.content.trim())));
  }
  if (constraints.length > 0) {
    lines.push("", "### Constraints", "", bullets(constraints.map((item) => item.content.trim())));
  }
  return lines.join("\n");
}

function renderMemory(model: ContextModel): string | null {
  if (model.memory.length === 0) return null;
  const lines = [
    "## Project memory",
    "",
    "Human-approved decisions and lessons carried forward from earlier work.",
    "Treat them as background, not as instructions for this task.",
    "",
    bullets(model.memory.map((item) => `[${item.category}] ${item.content.trim()}`)),
  ];
  return lines.join("\n");
}

function renderSection(section: SectionName, model: ContextModel): string | null {
  switch (section) {
    case "mission":
      return renderMission(model);
    case "objective":
      return renderObjective(model);
    case "task":
      return renderTask(model);
    case "dependencies":
      return renderDependencies(model);
    case "repository":
      return renderRepository(model);
    case "directives":
      return renderDirectives(model);
    case "memory":
      return renderMemory(model);
  }
}

interface RenderedSection {
  section: SectionName;
  content: Buffer;
}

function renderAll(model: ContextModel): RenderedSection[] {
  const rendered: RenderedSection[] = [];
  for (const section of SECTION_ORDER) {
    const text = renderSection(section, model);
    if (text === null) continue;
    rendered.push({ section, content: utf8(`${text}\n`) });
  }
  return rendered;
}

function totalBytes(sections: readonly RenderedSection[]): number {
  return sections.reduce((sum, section) => sum + section.content.byteLength, 0);
}

// ---- trimming ---------------------------------------------------------------

/**
 * Drop exactly one unit of the lowest-value remaining material. Returns false
 * when nothing droppable is left, which means the untrimmable core alone is
 * over the cap.
 *
 * Priority, lowest value first:
 *   1. Project memory, oldest entry first.
 *   2. Upstream-task detail: first collapse every dependency to title+state,
 *      then drop dependencies oldest first.
 *   3. Non-policy repository facts, least confident first.
 *
 * Never dropped: the mission, the phase objective, the task (including its
 * deliverables and acceptance criteria), project directives and constraints,
 * the architecture summary, and the build/test/lint commands.
 */
function dropLowestValue(model: ContextModel): boolean {
  if (model.memory.length > 0) {
    model.memory.shift();
    return true;
  }
  if (model.dependencies.length > 0 && !model.dependenciesCompact) {
    model.dependenciesCompact = true;
    return true;
  }
  if (model.dependencies.length > 0) {
    model.dependencies.shift();
    return true;
  }
  const trimmableFact = model.facts.findIndex((fact) => !fact.policy);
  if (trimmableFact >= 0) {
    model.facts.splice(trimmableFact, 1);
    return true;
  }
  return false;
}

function trimToCap(model: ContextModel, cap: number): RenderedSection[] {
  let rendered = renderAll(model);
  while (totalBytes(rendered) > cap) {
    if (!dropLowestValue(model)) {
      throw new TaskContextAssemblyError(
        "context_too_large",
        `the untrimmable core of task ${model.task.id} is ${totalBytes(rendered)} bytes, over the ${cap}-byte context cap`,
        "Shorten the task description, deliverables, acceptance criteria, or project directives, or split the task.",
      );
    }
    rendered = renderAll(model);
  }
  return rendered;
}

// ---- the assembler ----------------------------------------------------------

export interface TaskContextAssemblerOptions {
  /**
   * Origin the runner fetches from, e.g. `https://norns.example.com`. Must be
   * HTTPS (or http on localhost, matching the runner's own fetcher check) —
   * validated here so a misconfiguration fails at assembly, not at the runner.
   */
  baseUrl: string;
  maxTotalBytes?: number;
}

export const TASK_CONTEXT_ROUTE_PREFIX = "/api/v2/execution/task-context";

export class RelationalTaskContextAssembler implements TaskContextAssembler {
  private readonly baseUrl: string;
  private readonly maxTotalBytes: number;

  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly store: TaskContextStore,
    options: TaskContextAssemblerOptions,
  ) {
    const url = new URL(options.baseUrl);
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
      throw new Error(
        `task context base URL must be HTTPS (got ${url.protocol}//${url.host}); the runner rejects anything else`,
      );
    }
    this.baseUrl = url.origin;
    this.maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_CONTEXT_BYTES;
  }

  async assembleForTask(taskId: string): Promise<V2ContentAddressedReferenceT[]> {
    return this.transactions.transaction(async (tx) => {
      const model = await this.gather(tx, taskId);
      const sections = trimToCap(model, this.maxTotalBytes);
      const refs: V2ContentAddressedReferenceT[] = [];
      for (const section of sections) {
        const stored = await this.store.put(tx, {
          projectId: model.project.id,
          section: section.section,
          content: section.content,
        });
        refs.push({
          artifact_id: stored.id,
          content_hash: stored.sha256,
          byte_size: stored.byte_size,
          storage_ref: `${this.baseUrl}${TASK_CONTEXT_ROUTE_PREFIX}/${stored.id}`,
        });
      }
      return refs;
    });
  }

  private async gather(tx: V2SqlExecutor, taskId: string): Promise<ContextModel> {
    const taskResult = await tx.query<TaskRow>(
      `SELECT id, project_id, phase_id, objective_id, strategy_version_id, title, description,
              deliverables, acceptance_criteria, complexity, risk, required_roles,
              required_capabilities, required_inputs, expected_outputs,
              environment_policy_ref, verification_policy_ref, state, designated_assignment_id
         FROM tasks WHERE id = $1`,
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) {
      throw new TaskContextAssemblyError(
        "task_not_found",
        `task ${taskId} does not exist`,
        "Approve a strategy version for the phase so its tasks are materialized, then schedule an existing task id.",
      );
    }

    if (asStringList(task.deliverables).length === 0) {
      throw new TaskContextAssemblyError(
        "deliverables_missing",
        `task ${taskId} ("${task.title}") has no deliverables`,
        "Re-plan this task with concrete deliverables; an agent cannot infer what to produce.",
      );
    }
    if (asStringList(task.acceptance_criteria).length === 0) {
      throw new TaskContextAssemblyError(
        "acceptance_criteria_missing",
        `task ${taskId} ("${task.title}") has no acceptance criteria`,
        "Re-plan this task with acceptance criteria; without them nothing can decide whether the work is done.",
      );
    }

    const phaseResult = await tx.query<PhaseRow>(
      `SELECT id, objective_summary, status, approved_strategy_version_id
         FROM phases WHERE id = $1 AND project_id = $2`,
      [task.phase_id, task.project_id],
    );
    const phase = phaseResult.rows[0];
    if (!phase) {
      throw new TaskContextAssemblyError(
        "objective_missing",
        `phase ${task.phase_id} for task ${taskId} does not exist`,
        "The task references a phase that is gone; re-plan the phase.",
      );
    }
    if (phase.approved_strategy_version_id === null) {
      throw new TaskContextAssemblyError(
        "strategy_not_approved",
        `phase ${phase.id} has no approved strategy version`,
        "Approve the phase's strategy version before scheduling any of its tasks.",
      );
    }
    if (phase.approved_strategy_version_id !== task.strategy_version_id) {
      throw new TaskContextAssemblyError(
        "strategy_superseded",
        `task ${taskId} belongs to strategy version ${task.strategy_version_id}, but phase ${phase.id} has approved ${phase.approved_strategy_version_id}`,
        "Schedule a task from the approved strategy version, or approve the version this task belongs to.",
      );
    }

    const projectResult = await tx.query<ProjectRow>(
      `SELECT id, name, description, current_architecture_revision_id, verification_policy_ref
         FROM projects WHERE id = $1`,
      [task.project_id],
    );
    const project = projectResult.rows[0];
    if (!project) {
      throw new TaskContextAssemblyError(
        "project_missing",
        `project ${task.project_id} for task ${taskId} does not exist`,
        "The task's project is gone; nothing can be assembled for it.",
      );
    }

    const objectiveResult = await tx.query<ObjectiveRow>(
      `SELECT id, outcome, success_measures, status FROM objectives
        WHERE id = $1 AND project_id = $2 AND phase_id = $3`,
      [task.objective_id, task.project_id, task.phase_id],
    );
    const objective = objectiveResult.rows[0];
    if (!objective) {
      throw new TaskContextAssemblyError(
        "objective_missing",
        `objective ${task.objective_id} for task ${taskId} does not exist`,
        "Re-approve the phase strategy so its objectives are materialized.",
      );
    }

    if (project.current_architecture_revision_id === null) {
      throw new TaskContextAssemblyError(
        "architecture_revision_missing",
        `project ${project.id} has no current architecture revision`,
        "Ingest the repository (Connect repository → ingest) so the architecture revision and repository facts exist.",
      );
    }
    const architectureResult = await tx.query<ArchitectureRow>(
      `SELECT id, revision, title, summary, repository_revision
         FROM architecture_revisions WHERE id = $1 AND project_id = $2`,
      [project.current_architecture_revision_id, project.id],
    );
    const architecture = architectureResult.rows[0];
    if (!architecture) {
      throw new TaskContextAssemblyError(
        "architecture_revision_missing",
        `project ${project.id} points at architecture revision ${project.current_architecture_revision_id}, which does not exist`,
        "Re-ingest the repository to rebuild the architecture revision.",
      );
    }

    // Repository facts are READ, never synthesized. An empty set means the
    // repository was never ingested, and an agent would be guessing.
    const factResult = await tx.query<MemoryRow>(
      `SELECT id, category, content, confidence FROM project_memory_entries
        WHERE project_id = $1 AND status = 'active' AND category = 'repository_fact'
        ORDER BY id ASC`,
      [project.id],
    );
    if (factResult.rows.length === 0) {
      throw new TaskContextAssemblyError(
        "repository_facts_missing",
        `project ${project.id} has no ingested repository facts`,
        "Ingest the repository so its facts (including the build, test, and lint commands) are recorded.",
      );
    }
    const facts: RepositoryFact[] = factResult.rows.map((row) => {
      const { key, value } = splitFact(row.content);
      return {
        id: row.id,
        key,
        value,
        confidence: numeric(row.confidence),
        policy: (VERIFICATION_COMMAND_KEYS as readonly string[]).includes(key),
      };
    });
    if (!facts.some((fact) => fact.policy)) {
      throw new TaskContextAssemblyError(
        "verification_commands_missing",
        `project ${project.id} has no ${VERIFICATION_COMMAND_KEYS.join(", ")} repository fact`,
        `Record at least one of ${VERIFICATION_COMMAND_KEYS.join(", ")} during repository ingestion; an agent cannot verify its own work without one.`,
      );
    }
    // Lowest-confidence facts are the first to go when the cap binds, so order
    // the trimmable ones that way up front and keep the order deterministic.
    facts.sort((left, right) => {
      if (left.policy !== right.policy) return left.policy ? 1 : -1;
      if (left.confidence !== right.confidence) return left.confidence - right.confidence;
      return left.key === right.key
        ? left.id.localeCompare(right.id)
        : left.key.localeCompare(right.key);
    });
    // Render policy facts first (they are the useful ones) while keeping the
    // trimming order above: renderRepository partitions on `policy`.

    const directiveResult = await tx.query<MemoryRow>(
      `SELECT id, category, content, confidence FROM project_memory_entries
        WHERE project_id = $1 AND status = 'active'
          AND category IN ('directive', 'constraint')
          AND (phase_id IS NULL OR phase_id = $2)
        ORDER BY category ASC, created_at ASC, id ASC`,
      [project.id, task.phase_id],
    );
    const directives: MemoryItem[] = directiveResult.rows.map((row) => ({
      id: row.id,
      category: row.category,
      content: row.content,
    }));

    // Only human-approved memory reaches an agent. Machine-inferred lessons
    // that nobody signed off must not steer autonomous work.
    const memoryResult = await tx.query<MemoryRow>(
      `SELECT id, category, content, confidence FROM project_memory_entries
        WHERE project_id = $1 AND status = 'active' AND approved_by_human = true
          AND category IN ('decision', 'lesson', 'phase_completion', 'architecture')
          AND (phase_id IS NULL OR phase_id = $2)
        ORDER BY created_at ASC, id ASC`,
      [project.id, task.phase_id],
    );
    const memory: MemoryItem[] = memoryResult.rows.map((row) => ({
      id: row.id,
      category: row.category,
      content: row.content,
    }));

    const dependencyResult = await tx.query<DependencyRow>(
      `SELECT p.id AS id, p.title AS title, p.state AS state,
              p.expected_outputs AS expected_outputs, p.completion_evidence AS completion_evidence
         FROM task_dependencies d
         JOIN tasks p ON p.id = d.predecessor_task_id
        WHERE d.successor_task_id = $1 AND d.project_id = $2
        ORDER BY p.created_at ASC, p.id ASC`,
      [task.id, task.project_id],
    );
    const dependencies: DependencyOutcome[] = dependencyResult.rows.map((row) => ({
      id: row.id,
      title: row.title,
      state: row.state,
      expected_outputs: asStringList(row.expected_outputs),
      completion_evidence: asStringList(row.completion_evidence),
    }));

    let assignment: AssignmentRow | null = null;
    if (task.designated_assignment_id !== null) {
      const assignmentResult = await tx.query<AssignmentRow>(
        `SELECT a.id AS id, a.rationale AS rationale,
                p.provider AS provider, p.model AS model, p.roles AS roles
           FROM agent_assignments a
           LEFT JOIN agent_profiles p ON p.id = a.agent_profile_id
          WHERE a.id = $1 AND a.task_id = $2`,
        [task.designated_assignment_id, task.id],
      );
      assignment = assignmentResult.rows[0] ?? null;
    }

    return {
      project,
      phase,
      objective,
      task,
      assignment,
      architecture,
      facts,
      directives,
      dependencies,
      dependenciesCompact: false,
      memory,
    };
  }
}
