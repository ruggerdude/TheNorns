import type { V2TransactionRunner } from "../persistence/v2/database.js";

export interface LegacyRunnerAuthorization {
  canAccessProjectRunner(input: {
    user_id: string;
    project_id: string;
    runner_id: string;
    repository_binding_id?: string;
  }): Promise<boolean>;
  canAccessRun(input: {
    user_id: string;
    project_id?: string;
    run_id: string;
    runner_id: string;
  }): Promise<boolean>;
  canAccessCommand(input: {
    user_id: string;
    command_id: string;
    runner_id?: string;
  }): Promise<boolean>;
  canRevokeRunner(input: { user_id: string; runner_id: string }): Promise<boolean>;
  runnerIdsForUser(userId: string): Promise<ReadonlySet<string>>;
}

interface AllowedRow {
  allowed: boolean;
}

interface RunnerIdRow {
  runner_id: string;
}

function validIds(...ids: string[]): boolean {
  return ids.every((id) => id.trim().length > 0);
}

/**
 * Durable, project-attributed access for compatibility runner surfaces.
 * Administrator role never participates in an allow predicate.
 */
export class PostgresLegacyRunnerAuthorization implements LegacyRunnerAuthorization {
  constructor(private readonly transactions: V2TransactionRunner) {}

  canAccessProjectRunner(input: {
    user_id: string;
    project_id: string;
    runner_id: string;
    repository_binding_id?: string;
  }): Promise<boolean> {
    if (
      !validIds(input.user_id, input.project_id, input.runner_id) ||
      (input.repository_binding_id !== undefined && !input.repository_binding_id.trim())
    ) {
      return Promise.resolve(false);
    }
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<AllowedRow>(
        `SELECT EXISTS (
           SELECT 1
             FROM users actor
             JOIN projects project ON project.id=$2
             JOIN repository_bindings binding
               ON binding.project_id=project.id
              AND binding.binding_type='local_runner'
              AND binding.runner_id=$3
              AND binding.status='connected'
              AND ($4::text IS NULL OR binding.id=$4)
            WHERE actor.id=$1
              AND actor.status='active'
              AND project.status='active'
              AND (
                project.owner_user_id=actor.id
                OR EXISTS (
                  SELECT 1
                    FROM project_members membership
                   WHERE membership.project_id=project.id
                     AND membership.user_id=actor.id
                     AND membership.status='active'
                )
              )
         ) AS allowed`,
        [input.user_id, input.project_id, input.runner_id, input.repository_binding_id ?? null],
      );
      return result.rows[0]?.allowed === true;
    });
  }

  canAccessRun(input: {
    user_id: string;
    project_id?: string;
    run_id: string;
    runner_id: string;
  }): Promise<boolean> {
    if (
      !validIds(input.user_id, input.run_id, input.runner_id) ||
      (input.project_id !== undefined && !input.project_id.trim())
    ) {
      return Promise.resolve(false);
    }
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<AllowedRow>(
        `SELECT EXISTS (
           SELECT 1
             FROM users actor
             JOIN agent_runs run ON run.id=$2
             JOIN projects project ON project.id=run.project_id
            WHERE actor.id=$1
              AND actor.status='active'
              AND ($4::text IS NULL OR project.id=$4)
              AND (
                project.owner_user_id=actor.id
                OR EXISTS (
                  SELECT 1
                    FROM project_members membership
                   WHERE membership.project_id=project.id
                     AND membership.user_id=actor.id
                     AND membership.status='active'
                )
              )
              AND (
                run.runner_id=$3
                OR EXISTS (
                  SELECT 1
                    FROM commands command
                   WHERE command.project_id=project.id
                     AND command.run_id=run.id
                     AND command.runner_id=$3
                )
              )
         ) AS allowed`,
        [input.user_id, input.run_id, input.runner_id, input.project_id ?? null],
      );
      return result.rows[0]?.allowed === true;
    });
  }

  canAccessCommand(input: {
    user_id: string;
    command_id: string;
    runner_id?: string;
  }): Promise<boolean> {
    if (
      !validIds(input.user_id, input.command_id) ||
      (input.runner_id !== undefined && !input.runner_id.trim())
    ) {
      return Promise.resolve(false);
    }
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<AllowedRow>(
        `SELECT EXISTS (
           SELECT 1
             FROM users actor
             JOIN commands command ON command.command_id=$2
             JOIN projects project ON project.id=command.project_id
            WHERE actor.id=$1
              AND actor.status='active'
              AND ($3::text IS NULL OR command.runner_id=$3)
              AND (
                project.owner_user_id=actor.id
                OR EXISTS (
                  SELECT 1
                    FROM project_members membership
                   WHERE membership.project_id=project.id
                     AND membership.user_id=actor.id
                     AND membership.status='active'
                )
              )
         ) AS allowed`,
        [input.user_id, input.command_id, input.runner_id ?? null],
      );
      return result.rows[0]?.allowed === true;
    });
  }

  /**
   * Runner-wide revocation is safe only for an ephemeral identity whose every
   * durable run/command attribution is visible to the caller. A local runner
   * ID can be reused across projects, so even one local binding makes this
   * broad compatibility operation ineligible.
   */
  canRevokeRunner(input: { user_id: string; runner_id: string }): Promise<boolean> {
    if (!validIds(input.user_id, input.runner_id)) return Promise.resolve(false);
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<AllowedRow>(
        `WITH runner_projects AS (
           SELECT run.project_id
             FROM agent_runs run
            WHERE run.runner_id=$2
           UNION
           SELECT command.project_id
             FROM commands command
            WHERE command.runner_id=$2
         )
         SELECT EXISTS (
           SELECT 1
             FROM users actor
            WHERE actor.id=$1
              AND actor.status='active'
              AND EXISTS (SELECT 1 FROM runner_projects)
              AND NOT EXISTS (
                SELECT 1
                  FROM repository_bindings binding
                 WHERE binding.binding_type='local_runner'
                   AND binding.runner_id=$2
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM runner_projects attribution
                  JOIN projects project ON project.id=attribution.project_id
                 WHERE project.owner_user_id IS DISTINCT FROM actor.id
                   AND NOT EXISTS (
                     SELECT 1
                       FROM project_members membership
                      WHERE membership.project_id=project.id
                        AND membership.user_id=actor.id
                        AND membership.status='active'
                   )
              )
         ) AS allowed`,
        [input.user_id, input.runner_id],
      );
      return result.rows[0]?.allowed === true;
    });
  }

  runnerIdsForUser(userId: string): Promise<ReadonlySet<string>> {
    if (!userId.trim()) return Promise.resolve(new Set());
    return this.transactions.transaction(async (sql) => {
      const result = await sql.query<RunnerIdRow>(
        `WITH accessible_projects AS (
           SELECT project.id
             FROM users actor
             JOIN projects project
               ON project.owner_user_id=actor.id
               OR EXISTS (
                 SELECT 1
                   FROM project_members membership
                  WHERE membership.project_id=project.id
                    AND membership.user_id=actor.id
                    AND membership.status='active'
               )
            WHERE actor.id=$1
              AND actor.status='active'
         ),
         attributed_runners AS (
           SELECT binding.runner_id
             FROM repository_bindings binding
             JOIN accessible_projects project ON project.id=binding.project_id
            WHERE binding.binding_type='local_runner'
              AND binding.status='connected'
           UNION
           SELECT run.runner_id
             FROM agent_runs run
             JOIN accessible_projects project ON project.id=run.project_id
            WHERE run.runner_id IS NOT NULL
           UNION
           SELECT command.runner_id
             FROM commands command
             JOIN accessible_projects project ON project.id=command.project_id
         )
         SELECT runner_id
           FROM attributed_runners
          WHERE runner_id IS NOT NULL
            AND btrim(runner_id)<>''
          ORDER BY runner_id`,
        [userId],
      );
      return new Set(result.rows.map((row) => row.runner_id));
    });
  }
}
