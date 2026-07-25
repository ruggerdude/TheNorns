import {
  V2InterfaceContractContent,
  V2KnowledgeDeltaChange,
  V2KnowledgePackageContent,
} from "@norns/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { KnowledgeSystemError, type KnowledgeSystemService } from "./service.js";

export interface KnowledgeRouteUser {
  id: string;
  email: string;
}

export interface KnowledgeRouteOptions {
  service: KnowledgeSystemService;
  clock: () => Date;
  requireSession: (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>;
  requireAdmin: (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<KnowledgeRouteUser | null>;
  resolveUser: (request: FastifyRequest) => Promise<KnowledgeRouteUser | undefined>;
}

const id = z.string().trim().min(1);
const nonEmpty = z.string().trim().min(1);
const stringList = z.array(nonEmpty);

const CreatePackageBody = z
  .object({
    id: id.optional(),
    name: nonEmpty,
    type: z.enum(["project", "architecture", "domain", "quality", "phase", "current_state"]),
    authority: z.enum(["constitutional", "domain_standard", "operational"]),
    owner: nonEmpty,
    scope_kind: z.enum(["project", "phase", "domain", "quality", "architecture"]),
    scope_id: id,
    parent_package_id: id.nullable().optional(),
  })
  .strict();

const CreatePackageVersionBody = z
  .object({
    id: id.optional(),
    version: z.string().trim().min(1),
    content: V2KnowledgePackageContent,
    dependency_package_ids: z
      .array(
        z
          .object({
            package_id: id,
            relation_kind: z.enum(["mandatory", "parent_domain", "cross_domain"]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

const TransitionBody = z
  .object({
    to: z.enum(["under_review", "approved", "active", "archived"]),
  })
  .strict();

const CreateInterfaceBody = z
  .object({
    id: id.optional(),
    contract_id: id,
    name: nonEmpty,
    owner: nonEmpty,
    version: z.string().trim().min(1),
    content: V2InterfaceContractContent,
  })
  .strict();

const TaskPackageBody = z
  .object({
    status: z.enum(["draft", "approved"]),
    assignment: nonEmpty,
    expected_outcome: nonEmpty,
    business_or_user_outcome: z.string(),
    scope: stringList,
    out_of_scope: stringList,
    deliverables: stringList.min(1),
    file_scope_declared: z.boolean(),
    permitted_files: stringList,
    restricted_files: stringList,
    required_package_ids: z.array(id),
    required_interface_contract_ids: z.array(id),
    required_decision_record_ids: z.array(id),
    dependencies: z.array(id),
    acceptance_criteria: stringList.min(1),
    required_tests: stringList,
    performance_requirements: stringList,
    accessibility_requirements: stringList,
    reporting_interval_seconds: z.number().int().positive().default(300),
    escalation_conditions: stringList,
    completion_format: nonEmpty,
    branch_or_workspace: z.string(),
    token_budget: z.number().int().positive().nullable(),
  })
  .strict();

const ContextFile = z.object({ path: nonEmpty, reason: nonEmpty }).strict();
const ContextExclusion = z.object({ item: nonEmpty, reason: nonEmpty }).strict();
const ManifestBody = z
  .object({
    repository_commit: nonEmpty,
    included_source_files: z.array(ContextFile).optional(),
    included_test_files: z.array(ContextFile).optional(),
    explicitly_excluded_context: z.array(ContextExclusion).optional(),
    known_context_limitations: stringList.optional(),
    unresolved_questions: stringList.optional(),
  })
  .strict();

const RegisterAgentBody = z
  .object({
    context_manifest_id: id,
    provider: nonEmpty,
    model: nonEmpty,
    branch_or_workspace: nonEmpty,
    token_budget: z.number().int().positive().nullable(),
  })
  .strict();

const HeartbeatBody = z
  .object({
    status: z.enum(["working", "waiting", "blocked", "completed"]),
    completed_since_last_update: stringList,
    currently_working_on: stringList,
    findings: stringList,
    blockers: stringList,
    decisions_needed: stringList,
    files_changed: stringList,
    tests: nonEmpty,
    estimated_remaining_work: z.enum(["small", "moderate", "significant"]),
    risk_level: z.enum(["green", "yellow", "red"]),
  })
  .strict();

const DeltaBody = z
  .object({
    changes: z.array(V2KnowledgeDeltaChange).min(1),
    recommended_package_updates: z.array(
      z
        .object({
          package_id: id,
          current_version: nonEmpty,
          recommended_version: nonEmpty,
        })
        .strict(),
    ),
  })
  .strict();

const DeltaDispositionBody = z
  .object({
    status: z.enum(["accepted", "rejected", "modified", "deferred", "escalated"]),
    note: nonEmpty,
  })
  .strict();

const AcceptanceResult = z
  .object({
    criterion: nonEmpty,
    result: z.enum(["pass", "fail", "partial"]),
    evidence: nonEmpty,
  })
  .strict();
const HandoffBody = z
  .object({
    status: z.enum(["completed", "blocked", "failed"]),
    summary: nonEmpty,
    deliverables: stringList,
    files_changed: stringList,
    interfaces_used: stringList,
    interfaces_changed: stringList,
    tests_added: stringList,
    test_results: stringList,
    acceptance_criteria: z.array(AcceptanceResult),
    known_limitations: stringList,
    open_issues: stringList,
    dependencies_created: stringList,
    knowledge_delta_id: id.nullable(),
    recommended_package_updates: stringList,
    recommended_follow_up_tasks: stringList,
    branch: nonEmpty,
    commit: nonEmpty,
    artifacts: stringList,
  })
  .strict();

const ResolveConflictBody = z
  .object({
    status: z.enum(["resolved", "dismissed"]),
  })
  .strict();

function handleKnowledgeError(reply: FastifyReply, error: unknown): void {
  if (error instanceof KnowledgeSystemError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "conflict" || error.code === "invalid_transition"
          ? 409
          : 422;
    reply.code(status).send({ error: error.code, message: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    reply.code(400).send({ error: "bad_request", issues: error.issues });
    return;
  }
  throw error;
}

export function registerKnowledgeRoutes(
  app: FastifyInstance,
  options: KnowledgeRouteOptions,
): void {
  const now = () => options.clock().toISOString();
  const humanActor = (user: KnowledgeRouteUser) => ({
    actor_type: "human" as const,
    actor_id: user.id,
  });

  app.get("/api/v2/projects/:id/knowledge/packages", async (request, reply) => {
    if (!(await options.requireSession(request, reply))) return;
    const { id: projectId } = request.params as { id: string };
    reply.header("Cache-Control", "no-store").send(await options.service.listPackages(projectId));
  });

  app.post("/api/v2/projects/:id/knowledge/packages", async (request, reply) => {
    const user = await options.requireAdmin(request, reply);
    if (!user) return;
    const body = CreatePackageBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
    const { id: projectId } = request.params as { id: string };
    try {
      const created = await options.service.createPackage({
        project_id: projectId,
        name: body.data.name,
        type: body.data.type,
        authority: body.data.authority,
        owner: body.data.owner,
        scope_kind: body.data.scope_kind,
        scope_id: body.data.scope_id,
        parent_package_id: body.data.parent_package_id ?? null,
        ...(body.data.id ? { id: body.data.id } : {}),
        actor: humanActor(user),
        created_at: now(),
      });
      reply.code(201).send(created);
    } catch (error) {
      handleKnowledgeError(reply, error);
    }
  });

  app.post(
    "/api/v2/projects/:id/knowledge/packages/:packageId/versions",
    async (request, reply) => {
      const user = await options.requireAdmin(request, reply);
      if (!user) return;
      const body = CreatePackageVersionBody.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
      }
      const { packageId } = request.params as { id: string; packageId: string };
      try {
        const created = await options.service.createPackageVersion({
          package_id: packageId,
          version: body.data.version,
          content: body.data.content,
          dependency_package_ids: body.data.dependency_package_ids,
          ...(body.data.id ? { id: body.data.id } : {}),
          actor: humanActor(user),
          created_at: now(),
        });
        reply.code(201).send(created);
      } catch (error) {
        handleKnowledgeError(reply, error);
      }
    },
  );

  app.post(
    "/api/v2/projects/:id/knowledge/package-versions/:versionId/transition",
    async (request, reply) => {
      const user = await options.requireAdmin(request, reply);
      if (!user) return;
      const body = TransitionBody.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
      }
      const { versionId } = request.params as { id: string; versionId: string };
      try {
        reply.send(
          await options.service.transitionPackageVersion({
            version_id: versionId,
            to: body.data.to,
            actor: humanActor(user),
            transitioned_at: now(),
          }),
        );
      } catch (error) {
        handleKnowledgeError(reply, error);
      }
    },
  );

  app.post("/api/v2/projects/:id/knowledge/interfaces", async (request, reply) => {
    const user = await options.requireAdmin(request, reply);
    if (!user) return;
    const body = CreateInterfaceBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
    const { id: projectId } = request.params as { id: string };
    try {
      reply.code(201).send(
        await options.service.createInterfaceContractVersion({
          project_id: projectId,
          contract_id: body.data.contract_id,
          name: body.data.name,
          owner: body.data.owner,
          version: body.data.version,
          content: body.data.content,
          ...(body.data.id ? { id: body.data.id } : {}),
          actor: humanActor(user),
          created_at: now(),
        }),
      );
    } catch (error) {
      handleKnowledgeError(reply, error);
    }
  });

  app.post(
    "/api/v2/projects/:id/knowledge/interface-versions/:versionId/transition",
    async (request, reply) => {
      const user = await options.requireAdmin(request, reply);
      if (!user) return;
      const body = TransitionBody.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
      }
      const { versionId } = request.params as { id: string; versionId: string };
      try {
        reply.send(
          await options.service.transitionInterfaceContractVersion({
            version_id: versionId,
            to: body.data.to,
            actor: humanActor(user),
            transitioned_at: now(),
          }),
        );
      } catch (error) {
        handleKnowledgeError(reply, error);
      }
    },
  );

  app.post("/api/v2/projects/:id/tasks/:taskId/knowledge-package", async (request, reply) => {
    const user = await options.requireAdmin(request, reply);
    if (!user) return;
    const body = TaskPackageBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
    const { taskId } = request.params as { id: string; taskId: string };
    try {
      reply.code(201).send(
        await options.service.createTaskPackage({
          ...body.data,
          task_id: taskId,
          actor: humanActor(user),
          created_at: now(),
        }),
      );
    } catch (error) {
      handleKnowledgeError(reply, error);
    }
  });

  app.post("/api/v2/projects/:id/tasks/:taskId/context-manifest", async (request, reply) => {
    const user = await options.requireAdmin(request, reply);
    if (!user) return;
    const body = ManifestBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
    const { taskId } = request.params as { id: string; taskId: string };
    try {
      reply.code(201).send(
        await options.service.assembleContextManifest({
          task_id: taskId,
          repository_commit: body.data.repository_commit,
          ...(body.data.included_source_files
            ? { included_source_files: body.data.included_source_files }
            : {}),
          ...(body.data.included_test_files
            ? { included_test_files: body.data.included_test_files }
            : {}),
          ...(body.data.explicitly_excluded_context
            ? { explicitly_excluded_context: body.data.explicitly_excluded_context }
            : {}),
          ...(body.data.known_context_limitations
            ? { known_context_limitations: body.data.known_context_limitations }
            : {}),
          ...(body.data.unresolved_questions
            ? { unresolved_questions: body.data.unresolved_questions }
            : {}),
          generated_by: humanActor(user),
          generated_at: now(),
        }),
      );
    } catch (error) {
      handleKnowledgeError(reply, error);
    }
  });

  app.post("/api/v2/projects/:id/runs/:runId/knowledge/register", async (request, reply) => {
    const user = await options.requireAdmin(request, reply);
    if (!user) return;
    const body = RegisterAgentBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
    const { runId } = request.params as { id: string; runId: string };
    try {
      reply.code(201).send(
        await options.service.registerAgent({
          ...body.data,
          run_id: runId,
          actor: humanActor(user),
          registered_at: now(),
        }),
      );
    } catch (error) {
      handleKnowledgeError(reply, error);
    }
  });

  app.post("/api/v2/projects/:id/runs/:runId/knowledge/heartbeat", async (request, reply) => {
    const user = await options.resolveUser(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const body = HeartbeatBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
    const { runId } = request.params as { id: string; runId: string };
    try {
      reply.code(201).send(
        await options.service.recordHeartbeat({
          ...body.data,
          run_id: runId,
          reported_at: now(),
          actor: humanActor(user),
        }),
      );
    } catch (error) {
      handleKnowledgeError(reply, error);
    }
  });

  app.post("/api/v2/projects/:id/runs/:runId/knowledge/delta", async (request, reply) => {
    const user = await options.resolveUser(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const body = DeltaBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
    const { runId } = request.params as { id: string; runId: string };
    try {
      reply.code(201).send(
        await options.service.submitKnowledgeDelta({
          ...body.data,
          run_id: runId,
          submitted_at: now(),
          actor: humanActor(user),
        }),
      );
    } catch (error) {
      handleKnowledgeError(reply, error);
    }
  });

  app.post("/api/v2/projects/:id/runs/:runId/knowledge/handoff", async (request, reply) => {
    const user = await options.resolveUser(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    const body = HandoffBody.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
    const { runId } = request.params as { id: string; runId: string };
    try {
      reply.code(201).send(
        await options.service.submitHandoff({
          ...body.data,
          run_id: runId,
          submitted_at: now(),
          actor: humanActor(user),
        }),
      );
    } catch (error) {
      handleKnowledgeError(reply, error);
    }
  });

  app.post("/api/v2/projects/:id/knowledge/deltas/:deltaId/disposition", async (request, reply) => {
    const user = await options.requireAdmin(request, reply);
    if (!user) return;
    const body = DeltaDispositionBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
    }
    const { deltaId } = request.params as { id: string; deltaId: string };
    try {
      reply.send(
        await options.service.dispositionKnowledgeDelta({
          delta_id: deltaId,
          ...body.data,
          actor: humanActor(user),
          dispositioned_at: now(),
        }),
      );
    } catch (error) {
      handleKnowledgeError(reply, error);
    }
  });

  app.post(
    "/api/v2/projects/:id/phases/:phaseId/knowledge/conflicts/detect",
    async (request, reply) => {
      const user = await options.requireAdmin(request, reply);
      if (!user) return;
      const { id: projectId, phaseId } = request.params as { id: string; phaseId: string };
      try {
        reply.send(
          await options.service.detectConflicts({
            project_id: projectId,
            phase_id: phaseId,
            actor: humanActor(user),
            detected_at: now(),
          }),
        );
      } catch (error) {
        handleKnowledgeError(reply, error);
      }
    },
  );

  app.post(
    "/api/v2/projects/:id/knowledge/conflicts/:conflictId/resolve",
    async (request, reply) => {
      const user = await options.requireAdmin(request, reply);
      if (!user) return;
      const body = ResolveConflictBody.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ error: "bad_request", issues: body.error.issues });
      }
      const { conflictId } = request.params as { id: string; conflictId: string };
      try {
        await options.service.resolveConflict({
          conflict_id: conflictId,
          status: body.data.status,
          actor: humanActor(user),
          resolved_at: now(),
        });
        reply.send({ ok: true });
      } catch (error) {
        handleKnowledgeError(reply, error);
      }
    },
  );

  app.get("/api/v2/projects/:id/tasks/:taskId/knowledge/completion", async (request, reply) => {
    if (!(await options.requireSession(request, reply))) return;
    const { taskId } = request.params as { id: string; taskId: string };
    try {
      reply.send(
        await options.service.evaluateTaskCompletion({ task_id: taskId, evaluated_at: now() }),
      );
    } catch (error) {
      handleKnowledgeError(reply, error);
    }
  });

  app.get("/api/v2/projects/:id/phases/:phaseId/knowledge/completion", async (request, reply) => {
    if (!(await options.requireSession(request, reply))) return;
    const { id: projectId, phaseId } = request.params as { id: string; phaseId: string };
    try {
      reply.send(
        await options.service.evaluatePhaseCompletion({
          project_id: projectId,
          phase_id: phaseId,
          evaluated_at: now(),
        }),
      );
    } catch (error) {
      handleKnowledgeError(reply, error);
    }
  });

  app.get("/api/v2/projects/:id/phases/:phaseId/knowledge/status", async (request, reply) => {
    if (!(await options.requireSession(request, reply))) return;
    const { id: projectId, phaseId } = request.params as { id: string; phaseId: string };
    try {
      reply
        .header("Cache-Control", "no-store")
        .send(await options.service.phaseStatus(projectId, phaseId, now()));
    } catch (error) {
      handleKnowledgeError(reply, error);
    }
  });
}
