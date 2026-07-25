import { createHash } from "node:crypto";
import { V2RepositoryIngestionSeed, type V2RepositoryIngestionSeedT } from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export class RepositoryIngestionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryIngestionConflictError";
  }
}

export interface RepositoryIngestionResult {
  architecture_revision_id: string;
  architecture_revision: number;
  memory_entry_ids: string[];
  replayed: boolean;
}

export interface RepositoryIngestionOptions {
  /**
   * Fact keys whose active values are authoritative for this inspection.
   * Omitted for the public/manual ingestion route; repository analysis passes
   * only deterministic command and committed-manifest policy keys.
   */
  authoritative_repository_fact_keys?: readonly string[];
}

export interface ExistingRepositoryRevisionResult extends RepositoryIngestionResult {
  title: string;
  summary: string;
}

export interface ExistingRepositoryRevisionFactReconciliation {
  project_id: string;
  repository_binding_id: string;
  repository_revision: string;
  repository_facts: ReadonlyArray<{ key: string; value: string; confidence: number }>;
  authoritative_fact_keys: readonly string[];
}

function stableId(kind: string, parts: readonly string[]): string {
  const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  return `${kind}:${digest}`;
}

function splitFact(content: string): { key: string; value: string } {
  const index = content.indexOf(":");
  if (index <= 0) return { key: content.trim(), value: "" };
  return { key: content.slice(0, index).trim(), value: content.slice(index + 1).trim() };
}

async function assertBinding(
  tx: V2SqlExecutor,
  projectId: string,
  bindingId: string,
): Promise<void> {
  const binding = await tx.query(
    `SELECT id FROM repository_bindings
     WHERE id = $1 AND project_id = $2 AND status = 'connected'
     FOR UPDATE`,
    [bindingId, projectId],
  );
  if (binding.rows.length === 0) {
    throw new RepositoryIngestionConflictError(
      `connected repository binding ${bindingId} does not belong to project ${projectId}`,
    );
  }
}

async function reconcileAuthoritativeRepositoryFacts(
  tx: V2SqlExecutor,
  input: {
    project_id: string;
    repository_binding_id: string;
    repository_revision: string;
    repository_facts: ReadonlyArray<{ key: string; value: string; confidence: number }>;
    authoritative_fact_keys: readonly string[];
  },
): Promise<void> {
  const authoritative = new Set(input.authoritative_fact_keys);
  if (authoritative.size === 0) return;
  const sourceRef = JSON.stringify({
    repository_binding_id: input.repository_binding_id,
    repository_revision: input.repository_revision,
    source: "committed_repository_inspection",
  });
  const desiredByKey = new Map<
    string,
    { id: string; key: string; value: string; confidence: number }
  >();
  for (const fact of input.repository_facts) {
    const key = fact.key.trim();
    const value = fact.value.trim();
    if (!authoritative.has(key) || value.length === 0) continue;
    const id = stableId("memory", [
      input.project_id,
      input.repository_revision,
      "repository_fact",
      `${key}: ${value}`,
    ]);
    desiredByKey.set(key, { id, key, value, confidence: fact.confidence });
  }

  for (const fact of desiredByKey.values()) {
    await tx.query(
      `INSERT INTO project_memory_entries (
         id, project_id, category, content, provenance, source_ref,
         confidence, version, status, approved_by_human
       ) VALUES ($1,$2,'repository_fact',$3,'repository_inspection',$4::jsonb,
                 $5,1,'active',false)
       ON CONFLICT (id) DO UPDATE
       SET status='active', superseded_by_memory_entry_id=NULL`,
      [fact.id, input.project_id, `${fact.key}: ${fact.value}`, sourceRef, fact.confidence],
    );
  }

  const active = await tx.query<{ id: string; content: string }>(
    `SELECT id, content FROM project_memory_entries
     WHERE project_id=$1 AND category='repository_fact' AND status='active'
     FOR UPDATE`,
    [input.project_id],
  );
  for (const row of active.rows) {
    const { key } = splitFact(row.content);
    if (!authoritative.has(key)) continue;
    const desired = desiredByKey.get(key);
    if (desired?.id === row.id) continue;
    await tx.query(
      `UPDATE project_memory_entries
       SET status='obsolete', superseded_by_memory_entry_id=$2
       WHERE id=$1 AND project_id=$3 AND status='active'`,
      [row.id, desired?.id ?? null, input.project_id],
    );
  }
}

export class RepositoryIngestionService {
  constructor(private readonly transactions: V2TransactionRunner) {}

  /**
   * Repair exact command facts for a revision already analyzed by an older
   * server. Returning null means the revision is new and needs normal model
   * analysis; a result means the deterministic repair completed idempotently.
   */
  reconcileExistingRevisionFacts(
    input: ExistingRepositoryRevisionFactReconciliation,
  ): Promise<ExistingRepositoryRevisionResult | null> {
    return this.transactions.transaction(async (tx) => {
      await assertBinding(tx, input.project_id, input.repository_binding_id);
      const existing = await tx.query<{
        id: string;
        revision: number;
        title: string;
        summary: string;
      }>(
        `SELECT id, revision, title, summary FROM architecture_revisions
         WHERE project_id=$1 AND repository_revision=$2
         FOR UPDATE`,
        [input.project_id, input.repository_revision],
      );
      const revision = existing.rows[0];
      if (!revision) return null;
      await reconcileAuthoritativeRepositoryFacts(tx, input);
      const memories = await tx.query<{ id: string }>(
        `SELECT id FROM project_memory_entries
         WHERE project_id=$1 AND source_ref->>'repository_revision'=$2
         ORDER BY id`,
        [input.project_id, input.repository_revision],
      );
      return {
        architecture_revision_id: revision.id,
        architecture_revision: revision.revision,
        memory_entry_ids: memories.rows.map((row) => row.id),
        replayed: true,
        title: revision.title,
        summary: revision.summary,
      };
    });
  }

  ingest(
    input: V2RepositoryIngestionSeedT,
    options: RepositoryIngestionOptions = {},
  ): Promise<RepositoryIngestionResult> {
    const seed = V2RepositoryIngestionSeed.parse(input);
    return this.transactions.transaction(async (tx) => {
      await assertBinding(tx, seed.project_id, seed.repository_binding_id);
      const actorId = seed.created_by.actor_id;
      if (actorId === null) throw new RepositoryIngestionConflictError("human actor is required");

      const architectureId = stableId("architecture-revision", [
        seed.project_id,
        seed.repository_binding_id,
        seed.repository_revision,
      ]);
      const artifactId = stableId("artifact", [
        seed.project_id,
        seed.architecture.artifact.storage_ref,
        seed.architecture.artifact.content_hash,
      ]);
      const existing = await tx.query<{
        id: string;
        revision: number;
        architecture_artifact_id: string;
      }>(
        `SELECT id, revision, architecture_artifact_id FROM architecture_revisions
         WHERE project_id = $1 AND repository_revision = $2`,
        [seed.project_id, seed.repository_revision],
      );
      const previous = existing.rows[0];
      if (previous) {
        if (previous.id !== architectureId || previous.architecture_artifact_id !== artifactId) {
          throw new RepositoryIngestionConflictError(
            "repository revision was already ingested with different architecture evidence",
          );
        }
        await reconcileAuthoritativeRepositoryFacts(tx, {
          project_id: seed.project_id,
          repository_binding_id: seed.repository_binding_id,
          repository_revision: seed.repository_revision,
          repository_facts: seed.repository_facts,
          authoritative_fact_keys: options.authoritative_repository_fact_keys ?? [],
        });
        const memories = await tx.query<{ id: string }>(
          `SELECT id FROM project_memory_entries
           WHERE project_id = $1 AND source_ref->>'repository_revision' = $2
           ORDER BY id`,
          [seed.project_id, seed.repository_revision],
        );
        return {
          architecture_revision_id: previous.id,
          architecture_revision: previous.revision,
          memory_entry_ids: memories.rows.map((row) => row.id),
          replayed: true,
        };
      }

      const latest = await tx.query<{ id: string; revision: number }>(
        `SELECT id, revision FROM architecture_revisions
         WHERE project_id = $1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`,
        [seed.project_id],
      );
      const superseded = latest.rows[0];
      const revision = (superseded?.revision ?? 0) + 1;
      await tx.query(
        `INSERT INTO artifacts (
           id, project_id, kind, label, media_type, storage_ref, content_hash,
           byte_size, provenance_actor_type, provenance_actor_id, redaction_status
         ) VALUES ($1,$2,'architecture','Repository architecture',$3,$4,$5,$6,$7,$8,'reviewed')
         ON CONFLICT (id) DO NOTHING`,
        [
          artifactId,
          seed.project_id,
          seed.architecture.artifact.media_type,
          seed.architecture.artifact.storage_ref,
          seed.architecture.artifact.content_hash,
          seed.architecture.artifact.byte_size,
          seed.created_by.actor_type,
          actorId,
        ],
      );
      await tx.query(
        `INSERT INTO architecture_revisions (
           id, project_id, revision, title, summary, architecture_artifact_id,
           repository_revision, provenance_actor_type, provenance_actor_id,
           supersedes_architecture_revision_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          architectureId,
          seed.project_id,
          revision,
          seed.architecture.title,
          seed.architecture.summary,
          artifactId,
          seed.repository_revision,
          seed.created_by.actor_type,
          actorId,
          superseded?.id ?? null,
        ],
      );

      const sourceRef = JSON.stringify({
        repository_binding_id: seed.repository_binding_id,
        repository_revision: seed.repository_revision,
      });
      const memoryEntries = [
        ...seed.repository_facts.map((fact) => ({
          category: "repository_fact",
          content: `${fact.key}: ${fact.value}`,
          confidence: fact.confidence,
          approved: false,
        })),
        ...seed.constraints.map((content) => ({
          category: "constraint",
          content,
          confidence: 1,
          approved: false,
        })),
        ...seed.directives.map((content) => ({
          category: "directive",
          content,
          confidence: 1,
          approved: true,
        })),
        {
          category: "architecture",
          content: seed.architecture.summary,
          confidence: 1,
          approved: false,
        },
      ];
      const memoryIds: string[] = [];
      for (const entry of memoryEntries) {
        const id = stableId("memory", [
          seed.project_id,
          seed.repository_revision,
          entry.category,
          entry.content,
        ]);
        memoryIds.push(id);
        await tx.query(
          `INSERT INTO project_memory_entries (
             id, project_id, category, content, provenance, source_ref,
             confidence, version, status, approved_by_human, approved_by, approved_at
           ) VALUES ($1,$2,$3,$4,'repository_ingestion',$5::jsonb,$6,1,'active',$7,$8,
                     CASE WHEN $7 THEN now() ELSE NULL END)`,
          [
            id,
            seed.project_id,
            entry.category,
            entry.content,
            sourceRef,
            entry.confidence,
            entry.approved,
            entry.approved ? actorId : null,
          ],
        );
      }
      await reconcileAuthoritativeRepositoryFacts(tx, {
        project_id: seed.project_id,
        repository_binding_id: seed.repository_binding_id,
        repository_revision: seed.repository_revision,
        repository_facts: seed.repository_facts,
        authoritative_fact_keys: options.authoritative_repository_fact_keys ?? [],
      });
      await tx.query(
        `UPDATE projects
         SET current_architecture_revision_id = $2,
             primary_repository_binding_id = COALESCE(primary_repository_binding_id, $3),
             assignment_policy_ref = $4,
             verification_policy_ref = $5,
             budget_policy_ref = $6,
             status = 'active', aggregate_version = aggregate_version + 1,
             updated_at = now()
         WHERE id = $1`,
        [
          seed.project_id,
          architectureId,
          seed.repository_binding_id,
          seed.assignment_policy_ref,
          seed.verification_policy_ref,
          seed.budget_policy_ref,
        ],
      );
      return {
        architecture_revision_id: architectureId,
        architecture_revision: revision,
        memory_entry_ids: memoryIds.sort(),
        replayed: false,
      };
    });
  }
}
