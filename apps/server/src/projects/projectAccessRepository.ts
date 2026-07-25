import type { V2ProjectMemberT } from "@norns/contracts";
import type { V2SqlExecutor, V2TransactionRunner } from "../persistence/v2/database.js";

export type ProjectAccessIdentityRole = "admin" | "member";
export type ProjectAccessIdentityStatus = "active" | "invited" | "disabled";

export interface ProjectAccessIdentity {
  id: string;
  email: string;
  name: string | null;
  role: ProjectAccessIdentityRole;
  status: ProjectAccessIdentityStatus;
}

export interface ProjectAccessProject {
  id: string;
  ownerUserId: string | null;
}

export interface ProjectMembershipRecord {
  projectId: string;
  userId: string;
  status: "active" | "removed";
}

export interface ProjectMemberCandidate {
  user_id: string;
  email: string;
  name: string | null;
  workspace_role: ProjectAccessIdentityRole;
}

export interface ProjectAccessRepository {
  project(projectId: string): Promise<ProjectAccessProject | null>;
  identity(userId: string): Promise<ProjectAccessIdentity | null>;
  membership(projectId: string, userId: string): Promise<ProjectMembershipRecord | null>;
  listMembers(projectId: string): Promise<V2ProjectMemberT[]>;
  listMemberCandidates(projectId: string): Promise<ProjectMemberCandidate[]>;
  listAccessibleProjectIds(userId: string, isAdmin: boolean): Promise<string[]>;
  upsertMember(projectId: string, userId: string, addedByUserId: string): Promise<void>;
  removeMember(projectId: string, userId: string, removedByUserId: string): Promise<boolean>;
  setOwner(projectId: string, ownerUserId: string): Promise<void>;
}

export interface ProjectAccessRepositoryStore {
  transaction<T>(work: (repository: ProjectAccessRepository) => Promise<T>): Promise<T>;
}

interface ProjectRow {
  id: string;
  owner_user_id: string | null;
}

interface IdentityRow {
  id: string;
  email: string;
  name: string | null;
  role: ProjectAccessIdentityRole;
  status: ProjectAccessIdentityStatus;
}

interface MembershipRow {
  project_id: string;
  user_id: string;
  status: "active" | "removed";
}

interface MemberRow extends IdentityRow {
  project_id: string;
  project_role: "owner" | "member";
  membership_status: "active" | "removed";
  added_by_user_id: string | null;
  added_at: string | Date | null;
  removed_by_user_id: string | null;
  removed_at: string | Date | null;
}

function iso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

class SqlProjectAccessRepository implements ProjectAccessRepository {
  constructor(private readonly sql: V2SqlExecutor) {}

  async project(projectId: string): Promise<ProjectAccessProject | null> {
    const result = await this.sql.query<ProjectRow>(
      "SELECT id, owner_user_id FROM projects WHERE id=$1",
      [projectId],
    );
    const row = result.rows[0];
    return row ? { id: row.id, ownerUserId: row.owner_user_id } : null;
  }

  async identity(userId: string): Promise<ProjectAccessIdentity | null> {
    const result = await this.sql.query<IdentityRow>(
      "SELECT id, email, name, role, status FROM users WHERE id=$1",
      [userId],
    );
    return result.rows[0] ?? null;
  }

  async membership(projectId: string, userId: string): Promise<ProjectMembershipRecord | null> {
    const result = await this.sql.query<MembershipRow>(
      `SELECT project_id, user_id, status
       FROM project_members
       WHERE project_id=$1 AND user_id=$2`,
      [projectId, userId],
    );
    const row = result.rows[0];
    return row ? { projectId: row.project_id, userId: row.user_id, status: row.status } : null;
  }

  async listMembers(projectId: string): Promise<V2ProjectMemberT[]> {
    const result = await this.sql.query<MemberRow>(
      `SELECT project.id AS project_id,
              identity.id, identity.email, identity.name, identity.role, identity.status,
              CASE WHEN identity.id=project.owner_user_id THEN 'owner' ELSE 'member' END
                AS project_role,
              CASE WHEN identity.id=project.owner_user_id THEN 'active'
                   ELSE membership.status END AS membership_status,
              membership.added_by_user_id, membership.added_at,
              CASE WHEN identity.id=project.owner_user_id THEN NULL
                   ELSE membership.removed_by_user_id END AS removed_by_user_id,
              CASE WHEN identity.id=project.owner_user_id THEN NULL
                   ELSE membership.removed_at END AS removed_at
       FROM projects project
       JOIN users identity
         ON identity.id=project.owner_user_id
         OR EXISTS (
           SELECT 1
           FROM project_members candidate
           WHERE candidate.project_id=project.id
             AND candidate.user_id=identity.id
         )
       LEFT JOIN project_members membership
         ON membership.project_id=project.id
        AND membership.user_id=identity.id
       WHERE project.id=$1
       ORDER BY CASE WHEN identity.id=project.owner_user_id THEN 0 ELSE 1 END,
                lower(identity.email), identity.id`,
      [projectId],
    );
    return result.rows.map((row) => ({
      schema_version: 2,
      project_id: row.project_id,
      user_id: row.id,
      email: row.email,
      name: row.name,
      workspace_role: row.role,
      identity_status: row.status,
      project_role: row.project_role,
      membership_status: row.membership_status,
      added_by_user_id: row.added_by_user_id,
      added_at: iso(row.added_at),
      removed_by_user_id: row.removed_by_user_id,
      removed_at: iso(row.removed_at),
    }));
  }

  async listMemberCandidates(projectId: string): Promise<ProjectMemberCandidate[]> {
    const result = await this.sql.query<{
      id: string;
      email: string;
      name: string | null;
      role: ProjectAccessIdentityRole;
    }>(
      `SELECT identity.id, identity.email, identity.name, identity.role
       FROM users identity
       JOIN projects project ON project.id=$1
       WHERE identity.status='active'
         AND identity.role='member'
         AND identity.id<>project.owner_user_id
         AND NOT EXISTS (
           SELECT 1
           FROM project_members membership
           WHERE membership.project_id=project.id
             AND membership.user_id=identity.id
             AND membership.status='active'
         )
       ORDER BY lower(identity.email), identity.id`,
      [projectId],
    );
    return result.rows.map((row) => ({
      user_id: row.id,
      email: row.email,
      name: row.name,
      workspace_role: row.role,
    }));
  }

  async listAccessibleProjectIds(userId: string, isAdmin: boolean): Promise<string[]> {
    const result = await this.sql.query<{ id: string }>(
      `SELECT project.id
       FROM projects project
       WHERE $2::boolean
          OR project.owner_user_id=$1
          OR EXISTS (
            SELECT 1
            FROM project_members membership
            WHERE membership.project_id=project.id
              AND membership.user_id=$1
              AND membership.status='active'
          )
       ORDER BY project.created_at, project.id`,
      [userId, isAdmin],
    );
    return result.rows.map((row) => row.id);
  }

  async upsertMember(projectId: string, userId: string, addedByUserId: string): Promise<void> {
    await this.sql.query(
      `INSERT INTO project_members (
         project_id, user_id, status, added_by_user_id, added_at,
         removed_by_user_id, removed_at
       ) VALUES ($1,$2,'active',$3,now(),NULL,NULL)
       ON CONFLICT (project_id, user_id) DO UPDATE
       SET status='active',
           added_by_user_id=EXCLUDED.added_by_user_id,
           added_at=EXCLUDED.added_at,
           removed_by_user_id=NULL,
           removed_at=NULL`,
      [projectId, userId, addedByUserId],
    );
  }

  async removeMember(projectId: string, userId: string, removedByUserId: string): Promise<boolean> {
    const result = await this.sql.query<{ user_id: string }>(
      `UPDATE project_members
       SET status='removed', removed_by_user_id=$3, removed_at=now()
       WHERE project_id=$1 AND user_id=$2 AND status='active'
       RETURNING user_id`,
      [projectId, userId, removedByUserId],
    );
    return result.rows.length > 0;
  }

  async setOwner(projectId: string, ownerUserId: string): Promise<void> {
    await this.sql.query("UPDATE projects SET owner_user_id=$2, updated_at=now() WHERE id=$1", [
      projectId,
      ownerUserId,
    ]);
  }
}

export class PostgresProjectAccessRepository implements ProjectAccessRepositoryStore {
  constructor(private readonly transactions: V2TransactionRunner) {}

  transaction<T>(work: (repository: ProjectAccessRepository) => Promise<T>): Promise<T> {
    return this.transactions.transaction((sql) => work(new SqlProjectAccessRepository(sql)));
  }
}
