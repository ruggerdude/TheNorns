import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  DeviceActionAuthorizationError,
  PostgresDeviceActionAuthorization,
} from "../src/devices/actionAuthorization.js";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";

describe.sequential("transaction-local device action authorization", () => {
  let database: PGlite;
  let transactions: PGliteTransactionRunner;
  let authorization: PostgresDeviceActionAuthorization;

  beforeAll(async () => {
    database = new PGlite();
    transactions = new PGliteTransactionRunner(database);
    authorization = new PostgresDeviceActionAuthorization();
    await database.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT,
        status TEXT NOT NULL
      );
      CREATE TABLE project_members (
        project_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL
      );
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT,
        lifecycle TEXT NOT NULL,
        current_generation BIGINT NOT NULL
      );
      CREATE TABLE device_credentials (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        generation BIGINT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE device_repository_registrations (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE project_device_repository_grants (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        repository_registration_id TEXT NOT NULL,
        state TEXT NOT NULL
      );
      CREATE TABLE repository_bindings (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        binding_type TEXT NOT NULL,
        status TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        workspace_id TEXT,
        repository_id TEXT NOT NULL,
        project_device_repository_grant_id TEXT
      );
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        repository_binding_id TEXT NOT NULL,
        initiated_by_user_id TEXT NOT NULL
      );
      CREATE TABLE commands (
        command_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        runner_generation BIGINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE device_run_cancellations (
        run_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL
      );
      CREATE TABLE runner_revocations (
        runner_id TEXT PRIMARY KEY,
        revoked_through_generation BIGINT NOT NULL
      );

      INSERT INTO users (id,status)
      VALUES
        ('device-owner','active'),
        ('project-owner','active'),
        ('member','active'),
        ('admin-only','active'),
        ('disabled-owner','disabled');
      INSERT INTO projects (id,owner_user_id,status)
      VALUES ('project-1','project-owner','active');
      INSERT INTO project_members (project_id,user_id,status)
      VALUES ('project-1','member','active');
      INSERT INTO devices (id,owner_user_id,lifecycle,current_generation)
      VALUES
        ('device-1','device-owner','active',3),
        ('device-disabled-owner','disabled-owner','active',1);
      INSERT INTO device_credentials (id,device_id,generation,state)
      VALUES
        ('credential-1','device-1',3,'active'),
        ('credential-disabled','device-disabled-owner',1,'active');
      INSERT INTO device_repository_registrations (
        id,device_id,workspace_id,repository_id,state
      ) VALUES (
        'registration-1','device-1','workspace-1','repository-1','active'
      );
      INSERT INTO project_device_repository_grants (
        id,project_id,repository_registration_id,state
      ) VALUES ('grant-1','project-1','registration-1','active');
      INSERT INTO repository_bindings (
        id,project_id,binding_type,status,runner_id,workspace_id,repository_id,
        project_device_repository_grant_id
      ) VALUES (
        'binding-1','project-1','local_runner','connected','device-1',
        'workspace-1','repository-1','grant-1'
      ), (
        'binding-poisoned','project-1','local_runner','connected','runner-legacy',
        'workspace-1','repository-1','grant-1'
      ), (
        'binding-legacy','project-1','local_runner','connected','runner-legacy',
        'workspace-legacy','repository-legacy',NULL
      ), (
        'binding-actions','project-1','github','connected','actions-binding-runner',
        NULL,'repository-actions',NULL
      );
      INSERT INTO agent_runs (
        id,project_id,repository_binding_id,initiated_by_user_id
      ) VALUES
        ('run-1','project-1','binding-1','member'),
        ('run-poisoned','project-1','binding-poisoned','member'),
        ('run-legacy','project-1','binding-legacy','member'),
        ('run-actions','project-1','binding-actions','member');
      INSERT INTO commands (command_id,run_id,runner_id,runner_generation)
      VALUES
        ('command-1','run-1','device-1',3),
        ('command-poisoned','run-poisoned','runner-legacy',9),
        ('command-legacy','run-legacy','runner-legacy',9),
        ('command-actions','run-actions','actions-attempt-runner',2);
    `);
  });

  afterAll(async () => {
    await database.close();
  });

  it("never falls back when a declared device is missing, disabled, stale, or using another credential", async () => {
    const rejected = [
      {
        subject: "device" as const,
        runner_id: "missing-device",
        generation: 1,
        credential_id: "credential-1",
        code: "device_inactive",
      },
      {
        subject: "device" as const,
        runner_id: "device-disabled-owner",
        generation: 1,
        credential_id: "credential-disabled",
        code: "device_inactive",
      },
      {
        subject: "device" as const,
        runner_id: "device-1",
        generation: 2,
        credential_id: "credential-1",
        code: "device_generation_fenced",
      },
      {
        subject: "device" as const,
        runner_id: "device-1",
        generation: 3,
        credential_id: "wrong-credential",
        code: "device_credential_inactive",
      },
    ];

    for (const input of rejected) {
      await expect(
        transactions.transaction((sql) => authorization.lockTransportIdentity(sql, input)),
      ).rejects.toMatchObject({ code: input.code });
    }
  });

  it("authorizes the exact current binding and run for eligible project actors", async () => {
    await expect(
      transactions.transaction(async (sql) => {
        const identity = await authorization.resolveDispatchTargetIdentity(sql, {
          runner_id: "device-1",
          generation: 3,
        });
        await authorization.assertDispatchBinding(sql, {
          ...identity,
          actor_user_id: "member",
          project_id: "project-1",
          repository_binding_id: "binding-1",
        });
        await authorization.assertRun(sql, {
          ...identity,
          run_id: "run-1",
          project_id: "project-1",
          repository_binding_id: "binding-1",
        });
      }),
    ).resolves.toBeUndefined();
  });

  it("does not treat an unrelated active administrator-shaped account as project authority", async () => {
    await expect(
      transactions.transaction(async (sql) => {
        const identity = await authorization.resolveDispatchTargetIdentity(sql, {
          runner_id: "device-1",
          generation: 3,
        });
        return authorization.assertDispatchBinding(sql, {
          ...identity,
          actor_user_id: "admin-only",
          project_id: "project-1",
          repository_binding_id: "binding-1",
        });
      }),
    ).rejects.toMatchObject({ code: "device_binding_unauthorized" });
  });

  it("rejects the right device and run when the claimed project or binding differs", async () => {
    const identity = {
      subject: "device" as const,
      runner_id: "device-1",
      generation: 3,
      credential_id: "credential-1",
    };
    for (const target of [
      { run_id: "run-1", project_id: "wrong-project" },
      { run_id: "run-1", repository_binding_id: "wrong-binding" },
    ]) {
      await expect(
        transactions.transaction((sql) =>
          authorization.assertRun(sql, {
            ...identity,
            ...target,
          }),
        ),
      ).rejects.toMatchObject({ code: "device_run_unauthorized" });
    }
  });

  it("holds the grant-chain locks until the accepted operation finishes", async () => {
    let releaseAccepted!: () => void;
    const holdAccepted = new Promise<void>((resolve) => {
      releaseAccepted = resolve;
    });
    let authorizationReached!: () => void;
    const reached = new Promise<void>((resolve) => {
      authorizationReached = resolve;
    });
    const accepted = transactions.transaction(async (sql) => {
      await authorization.assertRun(sql, {
        subject: "device",
        runner_id: "device-1",
        generation: 3,
        credential_id: "credential-1",
        run_id: "run-1",
      });
      authorizationReached();
      await holdAccepted;
    });
    await reached;

    let revocationSettled = false;
    const revoke = database
      .query("UPDATE project_device_repository_grants SET state='revoked' WHERE id='grant-1'")
      .then(() => {
        revocationSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(revocationSettled).toBe(false);

    releaseAccepted();
    await accepted;
    await revoke;
    expect(revocationSettled).toBe(true);
    await database.query(
      "UPDATE project_device_repository_grants SET state='active' WHERE id='grant-1'",
    );
  });

  it("rejects a run as soon as cancellation has been durably requested", async () => {
    await database.query(
      "INSERT INTO device_run_cancellations (run_id,device_id) VALUES ('run-1','device-1')",
    );
    await expect(
      transactions.transaction((sql) =>
        authorization.assertRun(sql, {
          subject: "device",
          runner_id: "device-1",
          generation: 3,
          credential_id: "credential-1",
          run_id: "run-1",
        }),
      ),
    ).rejects.toMatchObject({ code: "device_run_unauthorized" });
    await database.query("DELETE FROM device_run_cancellations");
  });

  it("fails current-run authorization immediately after its grant is revoked", async () => {
    await database.query(
      "UPDATE project_device_repository_grants SET state='revoked' WHERE id='grant-1'",
    );
    await expect(
      transactions.transaction(async (sql) => {
        const identity = await authorization.resolveDispatchTargetIdentity(sql, {
          runner_id: "device-1",
          generation: 3,
        });
        return authorization.assertRun(sql, {
          ...identity,
          run_id: "run-1",
        });
      }),
    ).rejects.toMatchObject({ code: "device_run_unauthorized" });
  });

  it("rejects a legacy-classified target when the durable binding grant names a device", async () => {
    await expect(
      transactions.transaction(async (sql) => {
        const identity = await authorization.resolveDispatchTargetIdentity(sql, {
          runner_id: "runner-legacy",
          generation: 9,
        });
        expect(identity.subject).toBe("legacy_runner");
        return authorization.assertDispatchBinding(sql, {
          ...identity,
          actor_user_id: "member",
          project_id: "project-1",
          repository_binding_id: "binding-poisoned",
        });
      }),
    ).rejects.toMatchObject({ code: "device_binding_unauthorized" });

    await expect(
      transactions.transaction(async (sql) => {
        const identity = await authorization.resolveDispatchTargetIdentity(sql, {
          runner_id: "runner-legacy",
          generation: 9,
        });
        return authorization.assertRun(sql, {
          ...identity,
          run_id: "run-poisoned",
        });
      }),
    ).rejects.toMatchObject({ code: "device_run_unauthorized" });
  });

  it("preserves explicit legacy compatibility only for a grantless exact-target binding", async () => {
    const identity = {
      subject: "legacy_runner" as const,
      runner_id: "runner-legacy",
      generation: 9,
    };
    await expect(
      transactions.transaction((sql) =>
        authorization.assertDispatchBinding(sql, {
          ...identity,
          actor_user_id: "member",
          project_id: "project-1",
          repository_binding_id: "binding-legacy",
        }),
      ),
    ).resolves.toBe("legacy_runner");
    await expect(
      transactions.transaction((sql) =>
        authorization.assertRun(sql, {
          ...identity,
          run_id: "run-legacy",
        }),
      ),
    ).resolves.toBe("legacy_runner");
  });

  it("preserves grantless non-local dispatches whose attempt runner differs from the binding", async () => {
    const identity = {
      subject: "legacy_runner" as const,
      runner_id: "actions-attempt-runner",
      generation: 2,
    };
    await expect(
      transactions.transaction((sql) =>
        authorization.assertDispatchBinding(sql, {
          ...identity,
          actor_user_id: "member",
          project_id: "project-1",
          repository_binding_id: "binding-actions",
        }),
      ),
    ).resolves.toBe("legacy_runner");
    await expect(
      transactions.transaction((sql) =>
        authorization.assertRun(sql, {
          ...identity,
          run_id: "run-actions",
        }),
      ),
    ).resolves.toBe("legacy_runner");
  });
});
