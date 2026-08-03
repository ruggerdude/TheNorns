import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, sign as edSign, generateKeyPairSync, verify } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE,
  DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE,
  DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE,
  DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE,
  serializeSignedDeviceHttpTranscript,
} from "@norns/contracts";
import {
  ActiveDeviceIdentityStore,
  ActiveDeviceRepositoryRegistrationClient,
  DEVICE_HTTP_CREDENTIAL_ID_HEADER,
  DEVICE_HTTP_DEVICE_ID_HEADER,
  DEVICE_HTTP_GENERATION_HEADER,
  DEVICE_HTTP_REQUEST_ID_HEADER,
  DEVICE_HTTP_TIMESTAMP_HEADER,
  DeviceBackedGitPublisher,
  InMemoryDeviceCredentialSecretStore,
  LocalRepositoryAccessController,
  PendingDeviceCredentialStore,
  SignedDevicePublicationPermitClient,
  SignedDeviceRepositoryRegistrationClient,
  WorkspaceRegistry,
} from "../dist/index.js";

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), "norns-device-repository-test-"));
}

function createRepository(root) {
  const repository = join(root, "chosen-repository");
  execFileSync("git", ["init", repository], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Norns Test"]);
  writeFileSync(join(repository, "sentinel.txt"), "preserve me\n");
  execFileSync("git", ["-C", repository, "add", "sentinel.txt"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "initial"], { stdio: "ignore" });
  return repository;
}

function createPublishingRepository(root, branch) {
  const repository = join(root, "publishing-repository");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--initial-branch=main", repository], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repository, "config", "user.name", "Norns Test"]);
  writeFileSync(join(repository, "base.txt"), "base\n");
  execFileSync("git", ["-C", repository, "add", "base.txt"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "base"], { stdio: "ignore" });
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "remote", "add", "origin", remote]);
  execFileSync("git", ["-C", repository, "push", "origin", "main"], { stdio: "ignore" });
  execFileSync("git", ["-C", repository, "checkout", "-b", branch], { stdio: "ignore" });
  writeFileSync(join(repository, "work.txt"), `${branch}\n`);
  execFileSync("git", ["-C", repository, "add", "work.txt"]);
  execFileSync("git", ["-C", repository, "commit", "-m", "work"], { stdio: "ignore" });
  const commit = execFileSync("git", ["-C", repository, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  return { repository, remote, commit };
}

function remoteTip(repository, branch) {
  try {
    const output = execFileSync(
      "git",
      ["-C", repository, "ls-remote", "origin", `refs/heads/${branch}`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return output ? output.split(/\s+/, 1)[0] : null;
  } catch {
    return null;
  }
}

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey,
    value: {
      mode: "device",
      deviceId: "device-1",
      credentialId: "credential-1",
      generation: 7,
      sign(payload) {
        return edSign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
      },
    },
  };
}

function assertSignedRequest(call, publicKey, purpose, body) {
  const headers = new Headers(call.init.headers);
  const authorization = headers.get("authorization");
  assert.ok(authorization?.startsWith("Norns-Device "));
  const transcript = serializeSignedDeviceHttpTranscript({
    purpose,
    device_id: headers.get(DEVICE_HTTP_DEVICE_ID_HEADER),
    credential_id: headers.get(DEVICE_HTTP_CREDENTIAL_ID_HEADER),
    generation: Number(headers.get(DEVICE_HTTP_GENERATION_HEADER)),
    http_method: call.init.method,
    canonical_path_and_query: `${call.url.pathname}${call.url.search}`,
    body_sha256: createHash("sha256").update(body).digest("hex"),
    timestamp: headers.get(DEVICE_HTTP_TIMESTAMP_HEADER),
    request_id: headers.get(DEVICE_HTTP_REQUEST_ID_HEADER),
  });
  assert.equal(
    verify(
      null,
      Buffer.from(transcript, "utf8"),
      publicKey,
      Buffer.from(authorization.slice("Norns-Device ".length), "base64"),
    ),
    true,
  );
}

test("repository registration signs only opaque identity and cloud-safe Git metadata", async () => {
  const signedIdentity = identity();
  const calls = [];
  const httpFetch = async (input, init) => {
    const call = { url: new URL(input), init };
    calls.push(call);
    const body = JSON.parse(init.body);
    if (call.url.pathname.endsWith("/revoke")) {
      return Response.json({ registration_id: "registration-1", status: "revoked" });
    }
    return Response.json({
      registration_id: "registration-1",
      status: "active",
      workspace_id: body.workspace_id,
      repository_id: body.repository_id,
    });
  };
  const requestIds = ["request-register", "request-revoke"];
  const client = new SignedDeviceRepositoryRegistrationClient(
    "http://127.0.0.1:4400",
    signedIdentity.value,
    httpFetch,
    () => new Date("2026-07-30T12:00:00.000Z"),
    () => requestIds.shift(),
  );
  const repository = {
    workspace_id: "local:workspace1",
    repository_id: "local:repository1",
    repository_display_name: "The Norns",
    default_branch: "main",
    observed_head: "a".repeat(40),
  };

  const registered = await client.register(repository);
  assert.equal(registered.registration_id, "registration-1");
  const revoked = await client.revoke({
    registration_id: registered.registration_id,
    workspace_id: repository.workspace_id,
    repository_id: repository.repository_id,
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(calls.length, 2);

  const registrationBody = calls[0].init.body;
  assert.equal(registrationBody, JSON.stringify(repository));
  assert.doesNotMatch(registrationBody, /Users|hostname|local_path|repository_path/i);
  await assertSignedRequest(
    calls[0],
    signedIdentity.publicKey,
    DEVICE_REPOSITORY_REGISTRATION_HTTP_SIGNATURE_PURPOSE,
    registrationBody,
  );
  assert.equal(calls[1].url.pathname, "/api/device-repository-registrations/registration-1/revoke");
  await assertSignedRequest(
    calls[1],
    signedIdentity.publicKey,
    DEVICE_REPOSITORY_REGISTRATION_REVOCATION_HTTP_SIGNATURE_PURPOSE,
    calls[1].init.body,
  );
  assert.notEqual(
    new Headers(calls[0].init.headers).get(DEVICE_HTTP_REQUEST_ID_HEADER),
    new Headers(calls[1].init.headers).get(DEVICE_HTTP_REQUEST_ID_HEADER),
  );
});

test("AgentHost repository registration remains pending before enrollment and activates without restart", async () => {
  const dataDir = temporaryDirectory();
  const secrets = new InMemoryDeviceCredentialSecretStore();
  const credential = new PendingDeviceCredentialStore(dataDir, secrets);
  credential.prepare();
  const calls = [];
  const client = new ActiveDeviceRepositoryRegistrationClient(
    "http://127.0.0.1:4400",
    dataDir,
    credential,
    async (input, init) => {
      const call = { url: new URL(input), init };
      calls.push(call);
      const body = JSON.parse(init.body);
      return Response.json({
        registration_id: "registration-active",
        status: "active",
        workspace_id: body.workspace_id,
        repository_id: body.repository_id,
      });
    },
  );
  const repository = {
    workspace_id: "local:workspace-active",
    repository_id: "local:repository-active",
    repository_display_name: "Active repository",
    default_branch: "main",
    observed_head: "a".repeat(40),
  };

  try {
    await assert.rejects(client.register(repository), /device enrollment is not active/);
    assert.equal(calls.length, 0);

    new ActiveDeviceIdentityStore(dataDir).activateFromRedemption({
      device_id: "device-active",
      credential_id: "credential-active",
      generation: 9,
      activated_at: "2026-07-30T12:00:00.000Z",
    });
    const registered = await client.register(repository);
    assert.equal(registered.registration_id, "registration-active");
    assert.equal(calls.length, 1);
    const headers = new Headers(calls[0].init.headers);
    assert.equal(headers.get(DEVICE_HTTP_DEVICE_ID_HEADER), "device-active");
    assert.equal(headers.get(DEVICE_HTTP_CREDENTIAL_ID_HEADER), "credential-active");
    assert.equal(headers.get(DEVICE_HTTP_GENERATION_HEADER), "9");
    assert.ok(headers.get(DEVICE_HTTP_REQUEST_ID_HEADER));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("local approval and removal preserve repository files and never upload its path", async () => {
  const dataDir = temporaryDirectory();
  const repositoryPath = createRepository(dataDir);
  const physicalRepositoryPath = realpathSync(repositoryPath);
  const registrations = [];
  const revocations = [];
  const remote = {
    async register(repository) {
      registrations.push(structuredClone(repository));
      return {
        registration_id: "registration-1",
        status: "active",
        workspace_id: repository.workspace_id,
        repository_id: repository.repository_id,
      };
    },
    async revoke(input) {
      revocations.push(structuredClone(input));
      return { registration_id: input.registration_id, status: "revoked" };
    },
  };
  const workspaces = new WorkspaceRegistry(dataDir, async () => repositoryPath);
  const access = new LocalRepositoryAccessController(dataDir, workspaces, remote);

  try {
    const approved = await access.choose();
    assert.ok(approved);
    assert.equal(approved.local_path, physicalRepositoryPath);
    assert.equal(approved.sync_state, "active");
    assert.equal(registrations.length, 1);
    assert.doesNotMatch(JSON.stringify(registrations[0]), new RegExp(physicalRepositoryPath));
    assert.equal(
      await access.remove({
        workspace_id: "wrong-workspace",
        repository_id: approved.repository_id,
      }),
      null,
    );

    const removed = await access.remove({
      workspace_id: approved.workspace_id,
      repository_id: approved.repository_id,
    });
    assert.equal(removed.server_sync, "complete");
    assert.equal(workspaces.repositoryPath(approved.repository_id), undefined);
    assert.equal(revocations.length, 1);
    assert.equal(existsSync(join(repositoryPath, ".git")), true);
    assert.equal(readFileSync(join(repositoryPath, "sentinel.txt"), "utf8"), "preserve me\n");
    assert.equal(access.list().length, 0);
    assert.deepEqual(
      access.history().map(({ action, server_sync }) => ({ action, server_sync })),
      [
        { action: "approved", server_sync: "complete" },
        { action: "revoked", server_sync: "complete" },
      ],
    );
    const journal = readFileSync(join(dataDir, "repository-access.json"), "utf8");
    assert.doesNotMatch(journal, new RegExp(repositoryPath));
    assert.doesNotMatch(journal, /hostname|repository_path|local_path/i);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("a persisted revocation tombstone removes local access after a crash and retries server sync", async () => {
  const dataDir = temporaryDirectory();
  const repositoryPath = createRepository(dataDir);
  const physicalRepositoryPath = realpathSync(repositoryPath);
  let revokeCalls = 0;
  const remote = {
    async register(repository) {
      return {
        registration_id: "registration-1",
        status: "active",
        workspace_id: repository.workspace_id,
        repository_id: repository.repository_id,
      };
    },
    async revoke(input) {
      revokeCalls += 1;
      return { registration_id: input.registration_id, status: "revoked" };
    },
  };

  try {
    const initialRegistry = new WorkspaceRegistry(dataDir, async () => repositoryPath);
    const initial = new LocalRepositoryAccessController(dataDir, initialRegistry, remote);
    const approved = await initial.choose();
    assert.ok(approved);

    // This is the exact durable boundary after remove() records its tombstone
    // and before it mutates WorkspaceRegistry. Simulate a process crash there.
    const accessFile = join(dataDir, "repository-access.json");
    const tombstoned = JSON.parse(readFileSync(accessFile, "utf8"));
    tombstoned.records[0].sync_state = "revocation_pending";
    tombstoned.history.push({
      event_id: "local:crashboundary",
      workspace_id: approved.workspace_id,
      repository_id: approved.repository_id,
      repository_display_name: approved.repository_display_name,
      action: "revoked",
      occurred_at: "2026-07-30T12:00:00.000Z",
      server_sync: "pending",
    });
    writeFileSync(accessFile, JSON.stringify(tombstoned));
    const crashingRegistry = new WorkspaceRegistry(dataDir, async () => repositoryPath);
    assert.equal(crashingRegistry.repositoryPath(approved.repository_id), physicalRepositoryPath);

    const restartedRegistry = new WorkspaceRegistry(dataDir, async () => repositoryPath);
    const restarted = new LocalRepositoryAccessController(dataDir, restartedRegistry, remote);
    assert.equal(restartedRegistry.repositoryPath(approved.repository_id), undefined);
    assert.equal(existsSync(join(repositoryPath, "sentinel.txt")), true);
    await restarted.synchronize();
    assert.equal(revokeCalls, 1);
    assert.equal(restarted.list().length, 0);
    assert.equal(
      restarted.history().findLast((entry) => entry.action === "revoked")?.server_sync,
      "complete",
    );
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("repository removal uses the workspace and repository composite key", async () => {
  const dataDir = temporaryDirectory();
  const firstRoot = join(dataDir, "first");
  const secondRoot = join(dataDir, "second");
  for (const repository of [firstRoot, secondRoot]) {
    execFileSync("git", ["init", repository], { stdio: "ignore" });
    execFileSync("git", ["-C", repository, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", repository, "config", "user.name", "Norns Test"]);
    writeFileSync(join(repository, "sentinel.txt"), `${repository}\n`);
    execFileSync("git", ["-C", repository, "add", "sentinel.txt"]);
    execFileSync("git", ["-C", repository, "commit", "-m", "initial"], { stdio: "ignore" });
  }
  const selections = [firstRoot, secondRoot];
  const registry = new WorkspaceRegistry(dataDir, async () => selections.shift());

  try {
    const first = await registry.chooseLocalRepository();
    const second = await registry.chooseLocalRepository();
    assert.ok(first);
    assert.ok(second);
    const registryFile = join(dataDir, "workspace-registry.json");
    const persisted = JSON.parse(readFileSync(registryFile, "utf8"));
    persisted.repositories[1].repository_id = persisted.repositories[0].repository_id;
    writeFileSync(registryFile, JSON.stringify(persisted));

    const reloaded = new WorkspaceRegistry(dataDir);
    assert.equal(reloaded.removeRepositoryAccess(first.workspace_id, first.repository_id), true);
    const remaining = reloaded.listLocalRepositoryApprovals();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].workspace_id, second.workspace_id);
    assert.equal(remaining[0].repository_id, first.repository_id);
    assert.equal(existsSync(join(firstRoot, "sentinel.txt")), true);
    assert.equal(existsSync(join(secondRoot, "sentinel.txt")), true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("workspace deletion permanently removes only the exact registered repository folder", async () => {
  const dataDir = temporaryDirectory();
  const repositoryPath = createRepository(dataDir);
  const registry = new WorkspaceRegistry(dataDir, async () => repositoryPath);

  try {
    const approved = await registry.chooseLocalRepository();
    assert.ok(approved);
    const refused = await registry.handleAsync({
      request_id: "delete-wrong-workspace",
      operation: "delete",
      workspace_id: "local:wrong-workspace",
      repository_id: approved.repository_id,
    });
    assert.equal(refused.status, "not_found");
    assert.equal(existsSync(repositoryPath), true);

    const deleted = await registry.handleAsync({
      request_id: "delete-exact-repository",
      operation: "delete",
      workspace_id: approved.workspace_id,
      repository_id: approved.repository_id,
    });
    assert.deepEqual(deleted, {
      request_id: "delete-exact-repository",
      operation: "delete",
      status: "ok",
    });
    assert.equal(existsSync(repositoryPath), false);
    assert.equal(registry.approvedRepositoryCount(), 0);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("malformed repository access state fails closed instead of discarding revocation evidence", async () => {
  const dataDir = temporaryDirectory();
  const repositoryPath = createRepository(dataDir);
  const registry = new WorkspaceRegistry(dataDir, async () => repositoryPath);

  try {
    const access = new LocalRepositoryAccessController(dataDir, registry);
    const approved = await access.choose();
    assert.ok(approved);
    const file = join(dataDir, "repository-access.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    state.records[0].local_path = repositoryPath;
    writeFileSync(file, JSON.stringify(state));

    assert.throws(
      () => new LocalRepositoryAccessController(dataDir, new WorkspaceRegistry(dataDir)),
      /local repository access state is malformed/,
    );
    assert.equal(registry.repositoryPath(approved.repository_id), realpathSync(repositoryPath));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("publication permit issue and consume bind every claim and reject mismatches before consume", async () => {
  const signedIdentity = identity();
  const now = "2026-07-30T12:00:00.000Z";
  const scope = {
    run_id: "run-1",
    repository_registration_id: "registration-1",
    project_device_repository_grant_id: "grant-1",
    repository_binding_id: "binding-1",
    repository_id: "local:repository1",
    branch: "norns/task-1",
    commit_sha: "b".repeat(40),
  };
  const envelope = {
    permit: {
      purpose: "norns.device-publication-permit.v1",
      permit_id: "permit-1",
      ...scope,
      device_id: "device-1",
      credential_id: "credential-1",
      generation: 7,
      issued_at: now,
      expires_at: "2026-07-30T12:00:20.000Z",
    },
    key_id: "publication-key-1",
    signature_base64: Buffer.alloc(64).toString("base64"),
  };
  const calls = [];
  const client = new SignedDevicePublicationPermitClient(
    "http://127.0.0.1:4400",
    signedIdentity.value,
    async (input, init) => {
      const call = { url: new URL(input), init };
      calls.push(call);
      return calls.length === 1
        ? Response.json(envelope)
        : Response.json({
            outcome: "authorized",
            permit_id: "permit-1",
            consumed_at: "2026-07-30T12:00:01.000Z",
          });
    },
    () => new Date(now),
    (() => {
      const ids = ["request-issue", "request-consume"];
      return () => ids.shift();
    })(),
  );

  const consumed = await client.issueAndConsume(scope);
  assert.equal(consumed.outcome, "authorized");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/api/device-publication-permits");
  assert.equal(calls[1].url.pathname, "/api/device-publication-permits/permit-1/consume");
  assert.deepEqual(JSON.parse(calls[1].init.body), envelope);
  await assertSignedRequest(
    calls[0],
    signedIdentity.publicKey,
    DEVICE_PUBLICATION_PERMIT_ISSUE_HTTP_SIGNATURE_PURPOSE,
    calls[0].init.body,
  );
  await assertSignedRequest(
    calls[1],
    signedIdentity.publicKey,
    DEVICE_PUBLICATION_PERMIT_CONSUME_HTTP_SIGNATURE_PURPOSE,
    calls[1].init.body,
  );

  let mismatchCalls = 0;
  const mismatch = new SignedDevicePublicationPermitClient(
    "http://127.0.0.1:4400",
    signedIdentity.value,
    async () => {
      mismatchCalls += 1;
      return Response.json({
        ...envelope,
        permit: { ...envelope.permit, project_device_repository_grant_id: "other-grant" },
      });
    },
    () => new Date(now),
  );
  await assert.rejects(() => mismatch.issueAndConsume(scope), /did not match this run/);
  assert.equal(mismatchCalls, 1);
});

test("publication permit client fails closed when offline, replayed, expired, or overlong", async () => {
  const signedIdentity = identity();
  const now = "2026-07-30T12:00:00.000Z";
  const scope = {
    run_id: "run-1",
    repository_registration_id: "registration-1",
    project_device_repository_grant_id: "grant-1",
    repository_binding_id: "binding-1",
    repository_id: "local:repository1",
    branch: "norns/task-1",
    commit_sha: "b".repeat(40),
  };
  const basePermit = {
    purpose: "norns.device-publication-permit.v1",
    permit_id: "permit-1",
    ...scope,
    device_id: "device-1",
    credential_id: "credential-1",
    generation: 7,
    issued_at: now,
  };
  const signed = (expires_at) => ({
    permit: { ...basePermit, expires_at },
    key_id: "publication-key-1",
    signature_base64: Buffer.alloc(64).toString("base64"),
  });

  const offline = new SignedDevicePublicationPermitClient(
    "http://127.0.0.1:4400",
    signedIdentity.value,
    async () => {
      throw new Error("offline");
    },
    () => new Date(now),
  );
  await assert.rejects(() => offline.issueAndConsume(scope), /offline/);

  for (const expiresAt of [now, "2026-07-30T12:00:31.000Z"]) {
    let calls = 0;
    const stale = new SignedDevicePublicationPermitClient(
      "http://127.0.0.1:4400",
      signedIdentity.value,
      async () => {
        calls += 1;
        return Response.json(signed(expiresAt));
      },
      () => new Date(now),
    );
    await assert.rejects(() => stale.issueAndConsume(scope), /was stale/);
    assert.equal(calls, 1);
  }

  let replayCalls = 0;
  const replay = new SignedDevicePublicationPermitClient(
    "http://127.0.0.1:4400",
    signedIdentity.value,
    async () => {
      replayCalls += 1;
      return replayCalls === 1
        ? Response.json(signed("2026-07-30T12:00:20.000Z"))
        : new Response(null, { status: 409 });
    },
    () => new Date(now),
  );
  await assert.rejects(() => replay.issueAndConsume(scope), /could not be consumed/);
  assert.equal(replayCalls, 2);
});

test("device-backed Git publication consumes authorization before push and fails closed on refusal", async () => {
  const dataDir = temporaryDirectory();
  const branch = "norns/device-permit";
  const published = createPublishingRepository(dataDir, branch);
  const scopeFor = (input) => ({
    run_id: input.run_id,
    repository_registration_id: "registration-1",
    project_device_repository_grant_id: "grant-1",
    repository_binding_id: "binding-1",
    repository_id: "local:repository1",
    branch: input.branch,
    commit_sha: input.commit,
  });
  let authorizations = 0;
  const publisher = new DeviceBackedGitPublisher(
    {
      async issueAndConsume(scope) {
        authorizations += 1;
        assert.equal(remoteTip(published.repository, scope.branch), null);
        return {
          outcome: "authorized",
          permit_id: `permit-${authorizations}`,
          consumed_at: "2026-07-30T12:00:00.000Z",
        };
      },
    },
    scopeFor,
    { repositorySlug: "", token: "" },
  );
  const input = {
    worktree_path: published.repository,
    branch,
    commit: published.commit,
    run_id: "run-1",
    task_id: "task-1",
    verification_passed: true,
    verification_summary: "passed",
  };

  try {
    const result = await publisher.publish(input);
    assert.equal(result.outcome, "pushed");
    assert.equal(authorizations, 1);
    assert.equal(remoteTip(published.repository, branch), published.commit);

    const refusedBranch = "norns/device-refused";
    execFileSync("git", ["-C", published.repository, "checkout", "-b", refusedBranch], {
      stdio: "ignore",
    });
    writeFileSync(join(published.repository, "refused.txt"), "must stay local\n");
    execFileSync("git", ["-C", published.repository, "add", "refused.txt"]);
    execFileSync("git", ["-C", published.repository, "commit", "-m", "refused"], {
      stdio: "ignore",
    });
    const refusedCommit = execFileSync("git", ["-C", published.repository, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const refused = new DeviceBackedGitPublisher(
      {
        async issueAndConsume() {
          throw new Error("device is offline");
        },
      },
      scopeFor,
      { repositorySlug: "", token: "" },
    );
    await assert.rejects(
      () =>
        refused.publish({
          ...input,
          branch: refusedBranch,
          commit: refusedCommit,
          run_id: "run-2",
        }),
      /device is offline/,
    );
    assert.equal(remoteTip(published.repository, refusedBranch), null);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("device-backed force-with-lease retry consumes a second fresh authorization", async () => {
  const dataDir = temporaryDirectory();
  const branch = "norns/device-retry";
  const published = createPublishingRepository(dataDir, branch);
  const contender = join(dataDir, "contender");

  try {
    execFileSync("git", ["clone", published.remote, contender], { stdio: "ignore" });
    execFileSync("git", ["-C", contender, "config", "user.email", "test@example.com"]);
    execFileSync("git", ["-C", contender, "config", "user.name", "Norns Test"]);
    execFileSync("git", ["-C", contender, "checkout", "-b", branch, "origin/main"], {
      stdio: "ignore",
    });
    writeFileSync(join(contender, "other.txt"), "other attempt\n");
    execFileSync("git", ["-C", contender, "add", "other.txt"]);
    execFileSync("git", ["-C", contender, "commit", "-m", "other"], { stdio: "ignore" });
    execFileSync("git", ["-C", contender, "push", "origin", branch], { stdio: "ignore" });

    let authorizations = 0;
    const publisher = new DeviceBackedGitPublisher(
      {
        async issueAndConsume() {
          authorizations += 1;
          return {
            outcome: "authorized",
            permit_id: `permit-${authorizations}`,
            consumed_at: "2026-07-30T12:00:00.000Z",
          };
        },
      },
      (input) => ({
        run_id: input.run_id,
        repository_registration_id: "registration-1",
        project_device_repository_grant_id: "grant-1",
        repository_binding_id: "binding-1",
        repository_id: "local:repository1",
        branch: input.branch,
        commit_sha: input.commit,
      }),
      { repositorySlug: "", token: "" },
    );
    const result = await publisher.publish({
      worktree_path: published.repository,
      branch,
      commit: published.commit,
      run_id: "run-1",
      task_id: "task-1",
      verification_passed: true,
      verification_summary: "passed",
    });
    assert.equal(result.outcome, "republished");
    assert.equal(authorizations, 2);
    assert.equal(remoteTip(published.repository, branch), published.commit);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
