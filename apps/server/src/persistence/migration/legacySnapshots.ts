import { CommandState, type CommandStateT, TERMINAL_COMMAND_STATES } from "@norns/contracts";
import { z } from "zod";
import type { GovernedLegacySnapshotKey, LegacySnapshotKey } from "./archiveRepository.js";

const nonEmpty = z.string().min(1);
const legacyTimestamp = z.string().min(1);

export const LegacyUserRecordSchema = z
  .object({
    id: nonEmpty,
    email: nonEmpty,
    name: z.string().nullable().optional().default(null),
    role: z.enum(["admin", "member"]),
    status: z.enum(["active", "invited"]),
    passwordHash: z.string().nullable(),
    inviteToken: z.string().nullable().optional().default(null),
    createdAt: legacyTimestamp,
  })
  .passthrough();

export const LegacySessionRecordSchema = z
  .object({
    token: nonEmpty,
    userId: nonEmpty,
    createdAt: legacyTimestamp,
  })
  .passthrough();

export const LegacyUsersSnapshotSchema = z
  .object({
    users: z.array(LegacyUserRecordSchema).default([]),
    sessions: z.array(LegacySessionRecordSchema).default([]),
  })
  .passthrough();

const LegacyGraphNodeSchema = z
  .object({
    id: nonEmpty,
    dependencies: z.array(z.string()).optional().default([]),
    assignment: z.unknown().nullable().optional().default(null),
  })
  .passthrough();

const LegacyGraphSnapshotSchema = z
  .object({
    version: z.number().int().nonnegative(),
    nodes: z.array(LegacyGraphNodeSchema).default([]),
  })
  .passthrough();

export const LegacyProjectRecordSchema = z
  .object({
    id: nonEmpty,
    name: z.string(),
    description: z.string(),
    pmProvider: nonEmpty,
    pmModel: z.string().nullable().optional(),
    sourceType: z.enum(["local", "github"]).nullable().optional(),
    sourceLocation: z.string().nullable().optional(),
    createdAt: legacyTimestamp,
    plan: z.unknown().nullable().optional().default(null),
    graph: LegacyGraphSnapshotSchema.nullable().optional().default(null),
    approval: z.unknown().nullable().optional().default(null),
  })
  .passthrough();

export const LegacyProjectsSnapshotSchema = z
  .object({
    projects: z.array(LegacyProjectRecordSchema).default([]),
  })
  .passthrough();

const LegacyRelayAuditSchema = z
  .object({
    at: legacyTimestamp,
    actor: z.string(),
    action: z.string(),
    detail: z.string(),
  })
  .passthrough();

const LegacyRelayCommandSchema = z
  .object({
    updated_at: legacyTimestamp,
    state: CommandState.optional(),
  })
  .passthrough();

export const LegacyRelaySnapshotSchema = z
  .object({
    runners: z.record(z.unknown()).default({}),
    commands: z.record(LegacyRelayCommandSchema).default({}),
    eventsByRunner: z.record(z.array(z.unknown())).default({}),
    watermark: z.record(z.number().int().nonnegative()).default({}),
    audit: z.array(LegacyRelayAuditSchema).default([]),
    pairings: z.record(z.unknown()).default({}),
    killSwitch: z.boolean().default(false),
  })
  .passthrough();

export type LegacyUsersSnapshot = z.infer<typeof LegacyUsersSnapshotSchema>;
export type LegacyProjectsSnapshot = z.infer<typeof LegacyProjectsSnapshotSchema>;
export type LegacyRelaySnapshot = z.infer<typeof LegacyRelaySnapshotSchema>;
export type ParsedLegacySnapshot =
  | LegacyUsersSnapshot
  | LegacyProjectsSnapshot
  | LegacyRelaySnapshot;

export interface LegacySnapshotAnalysis {
  key: LegacySnapshotKey;
  parsed: unknown;
  object_counts: Record<string, number>;
  last_included_record: Record<string, unknown> | null;
  finding_code: "unknown_snapshot_key" | null;
  nonterminal_commands: {
    command_id: string;
    state: CommandStateT | "unknown";
    updated_at: string;
  }[];
}

function timestampOrder(value: string): [number, string] {
  const parsed = Date.parse(value);
  return [Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed, value];
}

function later(
  left: { timestamp: string; tieBreaker: string } | null,
  right: { timestamp: string; tieBreaker: string },
): { timestamp: string; tieBreaker: string } {
  if (!left) return right;
  const [leftEpoch, leftRaw] = timestampOrder(left.timestamp);
  const [rightEpoch, rightRaw] = timestampOrder(right.timestamp);
  if (rightEpoch !== leftEpoch) return rightEpoch > leftEpoch ? right : left;
  if (rightRaw !== leftRaw) return rightRaw > leftRaw ? right : left;
  return right.tieBreaker > left.tieBreaker ? right : left;
}

function analyzeUsers(value: unknown): LegacySnapshotAnalysis {
  const parsed = LegacyUsersSnapshotSchema.parse(value);
  const active = parsed.users.filter((user) => user.status === "active").length;
  const invited = parsed.users.length - active;
  const admins = parsed.users.filter((user) => user.role === "admin").length;
  const activeAdmins = parsed.users.filter(
    (user) => user.role === "admin" && user.status === "active" && user.passwordHash !== null,
  ).length;
  const invitationsWithTokens = parsed.users.filter(
    (user) => typeof user.inviteToken === "string" && user.inviteToken.length > 0,
  ).length;

  let lastUser: { timestamp: string; tieBreaker: string } | null = null;
  for (const user of parsed.users) {
    lastUser = later(lastUser, { timestamp: user.createdAt, tieBreaker: user.id });
  }
  let lastSession: { timestamp: string; tieBreaker: string } | null = null;
  for (const [index, session] of parsed.sessions.entries()) {
    lastSession = later(lastSession, {
      timestamp: session.createdAt,
      tieBreaker: `${session.userId}:${index}`,
    });
  }

  const marker =
    lastUser || lastSession
      ? {
          last_user:
            lastUser === null
              ? null
              : { user_id: lastUser.tieBreaker, created_at: lastUser.timestamp },
          last_session:
            lastSession === null
              ? null
              : {
                  user_id_and_ordinal: lastSession.tieBreaker,
                  created_at: lastSession.timestamp,
                },
        }
      : null;

  return {
    key: "users",
    parsed,
    object_counts: {
      users: parsed.users.length,
      active_users: active,
      invited_users: invited,
      admins,
      active_admins: activeAdmins,
      sessions: parsed.sessions.length,
      invitation_tokens: invitationsWithTokens,
    },
    last_included_record: marker,
    finding_code: null,
    nonterminal_commands: [],
  };
}

function analyzeProjects(value: unknown): LegacySnapshotAnalysis {
  const parsed = LegacyProjectsSnapshotSchema.parse(value);
  let lastProject: { timestamp: string; tieBreaker: string } | null = null;
  let plans = 0;
  let graphNodes = 0;
  let dependencyEdges = 0;
  let assignments = 0;
  let approvals = 0;

  for (const project of parsed.projects) {
    lastProject = later(lastProject, {
      timestamp: project.createdAt,
      tieBreaker: project.id,
    });
    if (project.plan !== null) plans += 1;
    if (project.approval !== null) approvals += 1;
    for (const node of project.graph?.nodes ?? []) {
      graphNodes += 1;
      dependencyEdges += node.dependencies.length;
      if (node.assignment !== null) assignments += 1;
    }
  }

  return {
    key: "projects",
    parsed,
    object_counts: {
      projects: parsed.projects.length,
      draft_projects: parsed.projects.length - plans,
      planned_projects: plans,
      plans,
      graph_nodes: graphNodes,
      dependency_edges: dependencyEdges,
      assignments,
      approvals,
    },
    last_included_record:
      lastProject === null
        ? null
        : { project_id: lastProject.tieBreaker, created_at: lastProject.timestamp },
    finding_code: null,
    nonterminal_commands: [],
  };
}

function analyzeRelay(value: unknown): LegacySnapshotAnalysis {
  const parsed = LegacyRelaySnapshotSchema.parse(value);
  const eventStreams = Object.values(parsed.eventsByRunner);
  const runnerEvents = eventStreams.reduce((total, events) => total + events.length, 0);

  let lastAudit: { timestamp: string; tieBreaker: string } | null = null;
  for (const [index, audit] of parsed.audit.entries()) {
    lastAudit = later(lastAudit, { timestamp: audit.at, tieBreaker: String(index) });
  }
  let lastCommand: { timestamp: string; tieBreaker: string } | null = null;
  for (const [commandId, command] of Object.entries(parsed.commands)) {
    lastCommand = later(lastCommand, {
      timestamp: command.updated_at,
      tieBreaker: commandId,
    });
  }

  const marker =
    lastAudit || lastCommand || Object.keys(parsed.watermark).length > 0
      ? {
          last_audit:
            lastAudit === null
              ? null
              : { ordinal: Number(lastAudit.tieBreaker), at: lastAudit.timestamp },
          last_command:
            lastCommand === null
              ? null
              : { command_id: lastCommand.tieBreaker, updated_at: lastCommand.timestamp },
          runner_watermarks: parsed.watermark,
        }
      : null;

  return {
    key: "relay",
    parsed,
    object_counts: {
      runners: Object.keys(parsed.runners).length,
      commands: Object.keys(parsed.commands).length,
      event_streams: eventStreams.length,
      runner_events: runnerEvents,
      audit_entries: parsed.audit.length,
      pairings: Object.keys(parsed.pairings).length,
      watermarks: Object.keys(parsed.watermark).length,
    },
    last_included_record: marker,
    finding_code: null,
    nonterminal_commands: Object.entries(parsed.commands)
      .filter(([, command]) => {
        const state = command.state;
        return state === undefined || !TERMINAL_COMMAND_STATES.has(state);
      })
      .map(([commandId, command]) => ({
        command_id: commandId,
        state: command.state ?? ("unknown" as const),
        updated_at: command.updated_at,
      }))
      .sort((left, right) => left.command_id.localeCompare(right.command_id)),
  };
}

function genericJsonCounts(value: unknown): Record<string, number> {
  const counts = {
    json_objects: 0,
    json_arrays: 0,
    json_scalars: 0,
    top_level_entries: 1,
  };
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      counts.json_arrays += 1;
      for (const entry of candidate) visit(entry);
      return;
    }
    if (candidate !== null && typeof candidate === "object") {
      counts.json_objects += 1;
      for (const entry of Object.values(candidate)) visit(entry);
      return;
    }
    counts.json_scalars += 1;
  };
  if (Array.isArray(value)) counts.top_level_entries = value.length;
  else if (value !== null && typeof value === "object") {
    counts.top_level_entries = Object.keys(value).length;
  }
  visit(value);
  return counts;
}

export function isGovernedLegacySnapshotKey(
  key: LegacySnapshotKey,
): key is GovernedLegacySnapshotKey {
  return key === "users" || key === "projects" || key === "relay";
}

export function analyzeLegacySnapshot(
  key: LegacySnapshotKey,
  value: unknown,
): LegacySnapshotAnalysis {
  switch (key) {
    case "users":
      return analyzeUsers(value);
    case "projects":
      return analyzeProjects(value);
    case "relay":
      return analyzeRelay(value);
    default:
      return {
        key,
        parsed: value,
        object_counts: genericJsonCounts(value),
        last_included_record: {
          source_key: key,
          capture_scope: "entire_opaque_snapshot",
        },
        finding_code: "unknown_snapshot_key",
        nonterminal_commands: [],
      };
  }
}
