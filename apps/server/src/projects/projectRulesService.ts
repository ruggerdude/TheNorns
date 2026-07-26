import { newId } from "../ids.js";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export const PROJECT_RULES_FILENAME = "NORN.md";
const PROJECT_RULES_SOURCE_KIND = "project_rules_file";

export interface ProjectRulesDto {
  filename: typeof PROJECT_RULES_FILENAME;
  content: string;
  version: number;
  updated_at: string | null;
}

interface ProjectRulesRow {
  id: string;
  content: string;
  version: number;
  created_at: string | Date;
  status?: "active" | "obsolete";
}

export class ProjectRulesNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`project ${projectId} not found`);
    this.name = "ProjectRulesNotFoundError";
  }
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Stores one Markdown rules file as a human-approved project directive.
 * TaskContextAssembler already includes active directives in every future
 * task briefing, so this file is executable project context rather than
 * detached settings metadata.
 */
export class ProjectRulesService {
  constructor(
    private readonly transactions: V2TransactionRunner,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async get(projectId: string): Promise<ProjectRulesDto> {
    return this.transactions.transaction(async (tx) => {
      await this.assertProject(tx, projectId);
      const result = await tx.query<ProjectRulesRow>(
        `SELECT id, content, version, created_at, status
           FROM project_memory_entries
          WHERE project_id = $1
            AND phase_id IS NULL
            AND task_id IS NULL
            AND category = 'directive'
            AND source_ref ->> 'kind' = $2
          ORDER BY version DESC, created_at DESC, id DESC
          LIMIT 1`,
        [projectId, PROJECT_RULES_SOURCE_KIND],
      );
      const row = result.rows[0];
      return {
        filename: PROJECT_RULES_FILENAME,
        content: row?.content ?? "",
        version: row?.version ?? 0,
        updated_at: row ? iso(row.created_at) : null,
      };
    });
  }

  async save(projectId: string, actorId: string, content: string): Promise<ProjectRulesDto> {
    const normalized = content.replaceAll("\r\n", "\n").trim();
    return this.transactions.transaction(async (tx) => {
      await this.assertProject(tx, projectId);
      const currentResult = await tx.query<ProjectRulesRow>(
        `SELECT id, content, version, created_at
           FROM project_memory_entries
          WHERE project_id = $1
            AND phase_id IS NULL
            AND task_id IS NULL
            AND category = 'directive'
            AND status = 'active'
            AND source_ref ->> 'kind' = $2
          ORDER BY version DESC, created_at DESC, id DESC
          LIMIT 1
          FOR UPDATE`,
        [projectId, PROJECT_RULES_SOURCE_KIND],
      );
      const current = currentResult.rows[0];
      if (current?.status === "active" && current.content === normalized) {
        return {
          filename: PROJECT_RULES_FILENAME,
          content: normalized,
          version: current?.version ?? 0,
          updated_at: current ? iso(current.created_at) : null,
        };
      }

      const savedAt = this.now().toISOString();
      const nextId = normalized ? newId("memory") : null;
      if (!nextId) {
        if (current?.status === "active") {
          await tx.query(
            `UPDATE project_memory_entries
                SET status = 'obsolete', superseded_by_memory_entry_id = NULL
              WHERE id = $1 AND project_id = $2`,
            [current.id, projectId],
          );
        }
        return {
          filename: PROJECT_RULES_FILENAME,
          content: "",
          version: current?.version ?? 0,
          updated_at:
            current?.status === "active" ? savedAt : current ? iso(current.created_at) : null,
        };
      }

      const version = (current?.version ?? 0) + 1;
      await tx.query(
        `INSERT INTO project_memory_entries (
           id, project_id, phase_id, task_id, category, content, provenance,
           source_ref, confidence, version, status, approved_by_human,
           approved_by, approved_at, supersedes_memory_entry_id, created_at
         ) VALUES (
           $1,$2,NULL,NULL,'directive',$3,'project_rules_file',
           $4::jsonb,1,$5,'active',true,$6,$7,$8,$7
         )`,
        [
          nextId,
          projectId,
          normalized,
          JSON.stringify({ kind: PROJECT_RULES_SOURCE_KIND, filename: PROJECT_RULES_FILENAME }),
          version,
          actorId,
          savedAt,
          current?.id ?? null,
        ],
      );
      if (current) {
        await tx.query(
          `UPDATE project_memory_entries
              SET status = 'obsolete', superseded_by_memory_entry_id = $3
            WHERE id = $1 AND project_id = $2`,
          [current.id, projectId, nextId],
        );
      }
      return {
        filename: PROJECT_RULES_FILENAME,
        content: normalized,
        version,
        updated_at: savedAt,
      };
    });
  }

  private async assertProject(tx: V2SqlExecutor, projectId: string): Promise<void> {
    const project = await tx.query<{ id: string }>("SELECT id FROM projects WHERE id = $1", [
      projectId,
    ]);
    if (!project.rows[0]) throw new ProjectRulesNotFoundError(projectId);
  }
}
