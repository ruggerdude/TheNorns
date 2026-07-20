// Shared test fixtures, built (and runtime-validated) against the real
// contracts rather than "whatever the UI happens to read":
//  - PlanModule/AcceptanceCriterion/PlanContract come from @norns/contracts
//    (packages/contracts/src/plan.ts) — the same schema the server validates
//    a loaded plan against.
//  - NodeAssignment mirrors apps/server/src/graph/allocation.ts's zod schema.
//    It's duplicated (not imported) because apps/server is a private app,
//    not a shared package — keep the two in sync if that schema changes.
import {
  AcceptanceCriterion,
  type AcceptanceCriterionT,
  Approval,
  type ApprovalT,
  PlanContract,
  type PlanContractT,
  PlanModule,
  type PlanModuleT,
  type PmModelT,
} from "@norns/contracts";
import { z } from "zod";
import type { MockResponseInit } from "./mockFetch";

// ---- allocation / assignment -------------------------------------------------

const NodeAssignment = z.object({
  provider: z.enum(["anthropic", "openai"]),
  model: z.string().min(1),
  role: z.literal("implementation"),
  worker_count: z.number().int().min(1).max(3),
  reviewer_model: z.string().min(1),
  budget_usd: z.number().positive(),
  rationale: z.string().min(1),
  source: z.enum(["auto", "pm", "override"]),
});
export type NodeAssignmentT = z.infer<typeof NodeAssignment>;

export function makeAssignment(overrides: Partial<NodeAssignmentT> = {}): NodeAssignmentT {
  return NodeAssignment.parse({
    provider: "anthropic",
    model: "claude-sonnet-5",
    role: "implementation",
    worker_count: 1,
    reviewer_model: "openai-reasoning-default",
    budget_usd: 50,
    rationale:
      "balanced strategy: complexity M x risk medium -> claude-sonnet-5, 1 worker(s), $50 budget; reviewed by openai-reasoning-default (cross-provider).",
    source: "auto",
    ...overrides,
  });
}

// ---- plan / acceptance criteria ----------------------------------------------

let acceptanceCounter = 0;
export function makeAcceptanceCriterion(
  overrides: Partial<AcceptanceCriterionT> = {},
): AcceptanceCriterionT {
  acceptanceCounter += 1;
  return AcceptanceCriterion.parse({
    id: `ac-${acceptanceCounter}`,
    statement: "The endpoint returns 200 for a valid request",
    verification_type: "test",
    verification: "pnpm test src/api.test.ts",
    ...overrides,
  });
}

export function makeCoreApiModule(overrides: Partial<PlanModuleT> = {}): PlanModuleT {
  return PlanModule.parse({
    id: "core-api",
    title: "Core API",
    description: "Implements the core REST API surface.",
    deliverables: ["OpenAPI schema", "CRUD endpoints"],
    acceptance: [
      makeAcceptanceCriterion({
        id: "ac-core-api-1",
        statement: "POST /items creates a record and returns 201",
        verification: "pnpm test src/items.test.ts",
      }),
    ],
    dependencies: [],
    estimated_complexity: "M",
    risk: "medium",
    execution: {},
    parallelization: { safe: false },
    inputs: [],
    outputs: [],
    open_decisions: [],
    ...overrides,
  });
}

export function makeWebUiModule(overrides: Partial<PlanModuleT> = {}): PlanModuleT {
  return PlanModule.parse({
    id: "web-ui",
    title: "Web UI",
    description: "Front-end for browsing and acting on notifications.",
    deliverables: ["Inbox view", "Preferences page"],
    acceptance: [
      makeAcceptanceCriterion({
        id: "ac-web-ui-1",
        statement: "Inbox lists notifications newest-first",
        verification: "pnpm test src/inbox.test.tsx",
      }),
      makeAcceptanceCriterion({
        id: "ac-web-ui-2",
        statement: "Marking a notification read persists across reload",
        verification: "pnpm test src/inbox.test.tsx -t read",
      }),
    ],
    dependencies: ["core-api"],
    estimated_complexity: "L",
    risk: "high",
    execution: {},
    parallelization: { safe: false },
    inputs: [],
    outputs: [],
    open_decisions: [],
    ...overrides,
  });
}

export function makePlan(overrides: Partial<PlanContractT> = {}): PlanContractT {
  return PlanContract.parse({
    objective: "Ship the v1 notifications service",
    assumptions: [],
    modules: [makeCoreApiModule(), makeWebUiModule()],
    risks: [],
    out_of_scope: [],
    ...overrides,
  });
}

// ---- planning-result fixtures (App.tsx's PlanResult) -------------------------

export interface PlanResultFixture {
  status: "converged" | "cap_reached";
  rounds: number;
  plan: PlanContractT;
  content_hash: string;
  total_cost_usd: number;
  outstanding: Array<{
    severity: "must_fix" | "should_fix" | "suggestion";
    module_id: string | null;
    finding: string;
    recommendation: string;
  }>;
  policy: {
    pm_provider: string;
    pm_model: string;
    reviewer_provider: string;
    reviewer_model: string;
  };
  versions: Array<{
    version: number;
    findings: Array<{
      severity: "must_fix" | "should_fix" | "suggestion";
      module_id: string | null;
      finding: string;
      recommendation: string;
    }> | null;
    responses: Array<{
      finding_index: number;
      disposition: "accept" | "rebut";
      rationale: string;
    }> | null;
  }>;
}

export function makePlanResult(overrides: Partial<PlanResultFixture> = {}): PlanResultFixture {
  const plan = makePlan();
  return {
    status: "converged",
    rounds: 2,
    plan,
    content_hash: "a".repeat(64),
    total_cost_usd: 42.5,
    outstanding: [],
    policy: {
      pm_provider: "anthropic",
      pm_model: "claude-sonnet-5",
      reviewer_provider: "openai",
      reviewer_model: "gpt-5-codex",
    },
    versions: [{ version: 1, findings: [], responses: [] }],
    ...overrides,
  };
}

/** A plan the two providers agreed on within the round cap. */
export const convergedPlanResult: PlanResultFixture = makePlanResult();

/** Hit the round cap with the reviewer still unhappy about something — the
 *  human sees status/rounds/outstanding findings alongside the plan, IF the
 *  UI actually threads them through (UI-3: today it doesn't). */
export const capReachedPlanResult: PlanResultFixture = makePlanResult({
  status: "cap_reached",
  rounds: 5,
  total_cost_usd: 118.2,
  outstanding: [
    {
      severity: "must_fix",
      module_id: "web-ui",
      finding:
        "Reviewer flagged: web-ui module has no rollback plan for a failed notification-preferences migration.",
      recommendation: "Add a rollback drill and name the evidence required before release.",
    },
  ],
  versions: [
    {
      version: 1,
      findings: [
        {
          severity: "must_fix",
          module_id: "web-ui",
          finding: "Rollback evidence is missing from the release strategy.",
          recommendation: "Add a production-safe rollback drill.",
        },
      ],
      responses: [
        {
          finding_index: 0,
          disposition: "rebut",
          rationale: "The existing deployment smoke test covers rollback behavior.",
        },
      ],
    },
  ],
});

/** POST .../plan/load response when a module's acceptance array is empty:
 *  the server's LoadPlanBody schema (which embeds PlanContract, whose
 *  PlanModule.acceptance is z.array(...).min(1)) fails safeParse before the
 *  handler body ever runs, so the response carries no `message` field —
 *  exactly what apps/web/src/App.tsx's api() falls back to
 *  `request failed: ${status}` for. */
export const planLoadInvalid400Response: MockResponseInit = {
  status: 400,
  body: { error: "bad_request" },
};

/** A generic mid-request server failure (as opposed to a validation 400). */
export const planLoadServerError500Response: MockResponseInit = {
  status: 500,
  body: { error: "internal_error", message: "unexpected server error" },
};

// ---- graph fixtures (App.tsx's GraphDto) --------------------------------------

export interface GraphNodeFixture {
  id: string;
  title: string;
  complexity: string;
  risk: string;
  dependencies: string[];
  assignment: NodeAssignmentT | null;
}

export function makeGraphNode(overrides: Partial<GraphNodeFixture> = {}): GraphNodeFixture {
  return {
    id: "core-api",
    title: "Core API",
    complexity: "M",
    risk: "medium",
    dependencies: [],
    assignment: null,
    ...overrides,
  };
}

export interface GraphDtoFixture {
  version: number;
  nodes: GraphNodeFixture[];
  cost: { total_usd: number; unallocated: string[] };
}

function costFor(nodes: GraphNodeFixture[]): GraphDtoFixture["cost"] {
  const unallocated = nodes.filter((n) => !n.assignment).map((n) => n.id);
  const total =
    Math.round(nodes.reduce((sum, n) => sum + (n.assignment?.budget_usd ?? 0), 0) * 100) / 100;
  return { total_usd: total, unallocated };
}

export function makeGraph(nodes: GraphNodeFixture[], version = 1): GraphDtoFixture {
  return { version, nodes, cost: costFor(nodes) };
}

const coreApiAllocated = makeGraphNode({
  id: "core-api",
  title: "Core API",
  complexity: "M",
  risk: "medium",
  dependencies: [],
  assignment: makeAssignment({ budget_usd: 50 }),
});

const webUiAllocated = makeGraphNode({
  id: "web-ui",
  title: "Web UI",
  complexity: "L",
  risk: "high",
  dependencies: ["core-api"],
  assignment: makeAssignment({
    model: "claude-opus-4-8",
    budget_usd: 180,
    worker_count: 2,
    rationale:
      "balanced strategy: complexity L x risk high -> claude-opus-4-8, 2 worker(s), $180 budget.",
  }),
});

/** Every node has an assignment — ready to approve. */
export const fullyAllocatedGraph: GraphDtoFixture = makeGraph(
  [coreApiAllocated, webUiAllocated],
  3,
);

/** One node still unassigned — the "Approve" action should stay disabled. */
export const partiallyAllocatedGraph: GraphDtoFixture = makeGraph(
  [
    coreApiAllocated,
    makeGraphNode({
      id: "web-ui",
      title: "Web UI",
      complexity: "L",
      risk: "high",
      dependencies: ["core-api"],
      assignment: null,
    }),
  ],
  3,
);

/** The Approval a human gets back from POST .../graph/approve-allocation for
 *  fullyAllocatedGraph at version 3. */
export const approvalHash = "b".repeat(64);
export const approvedAllocation: ApprovalT = Approval.parse({
  id: "appr_fixture001",
  kind: "allocation",
  actor: "operator",
  approved_at: "2026-07-14T12:00:00.000Z",
  content_hash: approvalHash,
});

/** Same graph, one version later — represents "approved, then something
 *  changed" (a re-allocation, an override, an edge edit). Nothing today
 *  invalidates the approval UI when the graph moves past the approved
 *  version/fingerprint (UI-1) — this fixture is what that regression test
 *  mutates the fixture graph into mid-test. */
export const mutatedAfterApprovalGraph: GraphDtoFixture = makeGraph(
  [
    coreApiAllocated,
    {
      ...webUiAllocated,
      assignment: makeAssignment({
        model: "claude-opus-4-8",
        budget_usd: 220,
        worker_count: 2,
        source: "override",
        rationale: "human override after approval",
      }),
    },
  ],
  4,
);

// ---- project fixtures (Projects.tsx's ProjectSummary) -------------------------

export interface ProjectSummaryFixture {
  id: string;
  name: string;
  description: string;
  pm_provider: "anthropic" | "openai";
  pm_model: PmModelT;
  reviewer_provider: "anthropic" | "openai";
  status: "draft" | "planned";
  created_at: string;
  plan_objective: string | null;
}

export function makeProject(overrides: Partial<ProjectSummaryFixture> = {}): ProjectSummaryFixture {
  return {
    id: "proj_alpha001",
    name: "Notifications Service",
    description: "Cross-provider notification delivery for the platform.",
    pm_provider: "anthropic",
    pm_model: "claude-sonnet-5",
    reviewer_provider: "openai",
    status: "planned",
    created_at: "2026-07-01T00:00:00.000Z",
    plan_objective: "Ship the v1 notifications service",
    ...overrides,
  };
}

/** Two distinct, independent projects — for isolation tests (does opening
 *  project B ever show project A's data, or vice versa). */
export const projectAlpha: ProjectSummaryFixture = makeProject();
export const projectBeta: ProjectSummaryFixture = makeProject({
  id: "proj_beta002",
  name: "Billing Reconciliation",
  description: "Automates monthly billing reconciliation across ledgers.",
  pm_provider: "openai",
  pm_model: "gpt-5.6-terra",
  reviewer_provider: "anthropic",
  created_at: "2026-07-05T00:00:00.000Z",
  plan_objective: "Reconcile billing discrepancies automatically",
});

// ---- dashboard fixture (Dashboard.tsx's DashboardDto) --------------------------

export interface DashboardDtoFixture {
  graph_version: number;
  nodes: Record<string, string>;
  blocked: { node_id: string; reason: string }[];
  review_queue: string[];
  progress_pct: number;
  eta: { label: string; value: null };
  cost: {
    settled_usd: number;
    active_reservations_usd: number;
    approved_usd: number;
    project_cap_usd: number;
    burn_rate_usd_per_hour: number;
  };
  usage_by_source: Record<
    string,
    { input_tokens: number; output_tokens: number; cost_usd: number }
  >;
  kill_switch: boolean;
  timeline: { at: string; actor: string; action: string; detail: string }[];
  pm_summary: string;
}

export function makeDashboard(overrides: Partial<DashboardDtoFixture> = {}): DashboardDtoFixture {
  return {
    graph_version: 1,
    nodes: { "demo-node": "integrated" },
    blocked: [],
    review_queue: [],
    progress_pct: 42,
    eta: { label: "experimental", value: null },
    cost: {
      settled_usd: 120,
      active_reservations_usd: 30,
      approved_usd: 500,
      project_cap_usd: 1000,
      burn_rate_usd_per_hour: 4.2,
    },
    usage_by_source: {
      anthropic: { input_tokens: 1000, output_tokens: 500, cost_usd: 12.34 },
    },
    kill_switch: false,
    timeline: [],
    // Deliberately distinctive: this is main.ts's hardcoded demoSession, not
    // whatever real project the UI opened it from (UI-6).
    pm_summary: "GLOBAL DEMO SESSION — 2/5 nodes integrated, 1 awaiting review, 0 blocked.",
    ...overrides,
  };
}

export const demoDashboard: DashboardDtoFixture = makeDashboard();
