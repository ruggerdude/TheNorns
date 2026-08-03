import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceRegistry } from "@norns/runner";
import { describe, expect, it } from "vitest";

function gitRepository(root: string, name: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["-C", path, "init", "-b", "main"]);
  execFileSync("git", ["-C", path, "config", "user.email", "test@norns.invalid"]);
  execFileSync("git", ["-C", path, "config", "user.name", "Norns Test"]);
  writeFileSync(join(path, "README.md"), "test\n");
  execFileSync("git", ["-C", path, "add", "README.md"]);
  execFileSync("git", ["-C", path, "commit", "-m", "initial"]);
  return path;
}

describe("runner-local workspace registry", () => {
  it("uses the native chooser to approve and validate a repository in one step", async () => {
    const data = mkdtempSync(join(tmpdir(), "norns-native-choice-"));
    const repository = gitRepository(data, "chosen-project");
    writeFileSync(join(repository, "README.md"), `test\n${repository}\n`);
    execFileSync("git", ["-C", repository, "add", "README.md"]);
    execFileSync("git", ["-C", repository, "commit", "--amend", "--no-edit"]);
    const registry = new WorkspaceRegistry(data, async () => repository);

    const response = await registry.handleAsync({
      request_id: "choose-project",
      operation: "choose",
    });

    expect(response).toMatchObject({
      operation: "choose",
      status: "ok",
      repository: {
        repository_display_name: "chosen-project",
        default_branch: "main",
      },
    });
    expect(JSON.stringify(response)).not.toContain(repository);
    expect(registry.listConfigured()).toEqual([
      expect.objectContaining({ label: "chosen-project" }),
    ]);
    expect(registry.repositoryPath(response.repository?.repository_id ?? "")).toBe(
      realpathSync(repository),
    );
    expect(registry.handle({ request_id: "catalog-projects", operation: "catalog" })).toMatchObject(
      {
        status: "ok",
        repositories: [
          {
            repository_display_name: "chosen-project",
            default_branch: "main",
          },
        ],
      },
    );

    // Inspection is committed-HEAD only: neither a working-tree edit nor an
    // untracked file may cross the relay.
    writeFileSync(join(repository, "README.md"), "uncommitted secret\n");
    writeFileSync(join(repository, "UNTRACKED_SECRET.txt"), "must stay local\n");
    const inspection = registry.handle({
      request_id: "inspect-project",
      operation: "inspect",
      repository_id: response.repository?.repository_id,
    });
    expect(inspection).toMatchObject({
      operation: "inspect",
      status: "ok",
      inspection: {
        repository_display_name: "chosen-project",
        default_branch: "main",
        total_files: 1,
        tree_paths: ["README.md"],
        files: [{ path: "README.md", content: "test\n[LOCAL_PATH]\n", truncated: false }],
      },
    });
    expect(JSON.stringify(inspection)).not.toContain(repository);
    expect(JSON.stringify(inspection)).not.toContain("uncommitted secret");
    expect(JSON.stringify(inspection)).not.toContain("must stay local");
  });

  it("treats closing the native chooser as a clean cancellation", async () => {
    const data = mkdtempSync(join(tmpdir(), "norns-native-cancel-"));
    const registry = new WorkspaceRegistry(data, async () => null);
    await expect(
      registry.handleAsync({ request_id: "choose-cancelled", operation: "choose" }),
    ).resolves.toEqual({
      request_id: "choose-cancelled",
      operation: "choose",
      status: "cancelled",
    });
    expect(registry.listConfigured()).toEqual([]);
  });

  it("clones into a chosen parent, keeps credentials local, and converges on retry", async () => {
    const data = mkdtempSync(join(tmpdir(), "norns-native-clone-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "norns-clone-source-"));
    const source = gitRepository(sourceRoot, "fresh-app-source");
    const parent = join(data, "projects");
    mkdirSync(parent);
    const cloneUrl = "https://github.com/octocat/fresh-app.git";
    const purposes: Array<string | undefined> = [];
    const tokens: string[] = [];
    let cloneCount = 0;
    const registry = new WorkspaceRegistry(
      data,
      async (purpose) => {
        purposes.push(purpose);
        return parent;
      },
      async ({ target, token }) => {
        cloneCount += 1;
        tokens.push(token);
        execFileSync("git", ["clone", "--", source, target]);
        execFileSync("git", ["-C", target, "remote", "set-url", "origin", cloneUrl]);
      },
    );
    const request = {
      request_id: "clone-project",
      operation: "clone" as const,
      clone_url: cloneUrl,
      repository_name: "fresh-app",
      clone_token: "one-use-secret",
    };

    const first = await registry.handleAsync(request);
    expect(first).toMatchObject({
      operation: "clone",
      status: "ok",
      repository: {
        repository_display_name: "fresh-app",
        default_branch: "main",
      },
    });
    expect(JSON.stringify(first)).not.toContain(parent);
    expect(JSON.stringify(first)).not.toContain("one-use-secret");
    expect(readFileSync(join(data, "workspace-registry.json"), "utf8")).not.toContain(
      "one-use-secret",
    );
    expect(tokens).toEqual(["one-use-secret"]);

    const second = await registry.handleAsync({ ...request, request_id: "clone-project-retry" });
    expect(second).toMatchObject({ operation: "clone", status: "ok" });
    expect(cloneCount).toBe(1);
    expect(purposes).toEqual(["clone_parent", "clone_parent"]);
  });

  it("selects a clone parent before creation and consumes only its opaque handle", async () => {
    const data = mkdtempSync(join(tmpdir(), "norns-preselected-clone-"));
    const sourceRoot = mkdtempSync(join(tmpdir(), "norns-preselected-source-"));
    const source = gitRepository(sourceRoot, "preselected-source");
    const parent = join(data, "Projects");
    mkdirSync(parent);
    const cloneUrl = "https://github.com/octocat/preselected-app.git";
    let pickerCount = 0;
    const registry = new WorkspaceRegistry(
      data,
      async () => {
        pickerCount += 1;
        return parent;
      },
      async ({ target }) => {
        execFileSync("git", ["clone", "--", source, target]);
        execFileSync("git", ["-C", target, "remote", "set-url", "origin", cloneUrl]);
      },
    );

    const selected = await registry.handleAsync({
      request_id: "choose-clone-parent",
      operation: "choose_clone_parent",
    });
    expect(selected).toMatchObject({
      status: "ok",
      clone_destination: { label: "Projects" },
    });
    expect(JSON.stringify(selected)).not.toContain(parent);

    const cloned = await registry.handleAsync({
      request_id: "clone-preselected",
      operation: "clone",
      clone_url: cloneUrl,
      repository_name: "preselected-app",
      clone_token: "one-use-secret",
      clone_destination_id: selected.clone_destination?.clone_destination_id,
    });
    expect(cloned).toMatchObject({ status: "ok", operation: "clone" });
    expect(pickerCount).toBe(1);

    await expect(
      registry.handleAsync({
        request_id: "clone-reuse-destination",
        operation: "clone",
        clone_url: cloneUrl,
        repository_name: "preselected-app",
        clone_token: "one-use-secret",
        clone_destination_id: selected.clone_destination?.clone_destination_id,
      }),
    ).resolves.toMatchObject({ status: "not_found" });
  });

  it("does not remove a destination another process creates during clone", async () => {
    const data = mkdtempSync(join(tmpdir(), "norns-native-clone-race-"));
    const parent = join(data, "projects");
    mkdirSync(parent);
    const destination = join(parent, "fresh-app");
    const registry = new WorkspaceRegistry(
      data,
      async () => parent,
      async () => {
        mkdirSync(destination);
        writeFileSync(join(destination, "owned-by-another-process"), "keep\n");
        throw new Error("simulated clone race");
      },
    );

    await expect(
      registry.handleAsync({
        request_id: "clone-race",
        operation: "clone",
        clone_url: "https://github.com/octocat/fresh-app.git",
        repository_name: "fresh-app",
        clone_token: "one-use-secret",
      }),
    ).resolves.toMatchObject({ status: "clone_failed" });
    expect(readFileSync(join(destination, "owned-by-another-process"), "utf8")).toBe("keep\n");
  });

  it("keeps paths local, skips symlinks, and validates an approved Git repository", () => {
    const data = mkdtempSync(join(tmpdir(), "norns-workspaces-"));
    const workspace = join(data, "approved");
    mkdirSync(workspace);
    const repository = gitRepository(workspace, "project-a");
    mkdirSync(join(workspace, "unsafe\\folder"));
    const outside = mkdtempSync(join(tmpdir(), "norns-outside-"));
    symlinkSync(outside, join(workspace, "escape"));
    const registry = new WorkspaceRegistry(data);
    expect(() => registry.addWorkspace(join(workspace, "escape"))).toThrow("must not be a symlink");
    const configured = registry.addWorkspace(workspace, "/private/should-not-cross-the-wire");

    const listing = registry.handle({ request_id: "list-1", operation: "list" });
    expect(listing).toEqual({
      request_id: "list-1",
      operation: "list",
      status: "ok",
      workspaces: [{ workspace_id: configured.workspace_id, label: "approved" }],
    });
    const browse = registry.handle({
      request_id: "browse-1",
      operation: "browse",
      workspace_id: configured.workspace_id,
    });
    expect(browse.status).toBe("ok");
    expect(browse.entries).toEqual([
      expect.objectContaining({ label: "project-a", kind: "repository", can_browse: false }),
      expect.objectContaining({ label: "Folder", kind: "folder", can_browse: true }),
    ]);
    expect(JSON.stringify(browse)).not.toContain(repository);
    expect(JSON.stringify(browse)).not.toContain(workspace);
    expect(JSON.stringify(listing)).not.toContain("/private/should-not-cross-the-wire");
    const entryId = browse.entries?.[0]?.entry_id;
    if (!entryId) throw new Error("repository entry was not returned");
    const validation = registry.handle({
      request_id: "validate-1",
      operation: "validate",
      workspace_id: configured.workspace_id,
      entry_id: entryId,
    });
    expect(validation).toMatchObject({
      status: "ok",
      repository: {
        workspace_id: configured.workspace_id,
        repository_display_name: "project-a",
        default_branch: "main",
      },
    });
    expect(JSON.stringify(validation)).not.toContain(repository);
    const repositoryId = validation.repository?.repository_id;
    if (!repositoryId) throw new Error("repository validation did not return an id");
    expect(registry.repositoryPath(repositoryId)).toBe(realpathSync(repository));
    const registryPath = join(data, "workspace-registry.json");
    expect(lstatSync(registryPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(registryPath, "utf8")).toContain(repository);

    // Selection-time validation is not enough: replacing the folder later
    // must not make execution follow a symlink outside the approved root.
    renameSync(repository, join(workspace, "project-a-original"));
    symlinkSync(outside, repository);
    expect(registry.repositoryPath(repositoryId)).toBeUndefined();
  });

  it("reloads CLI changes and does not resurrect a removed workspace", () => {
    const data = mkdtempSync(join(tmpdir(), "norns-workspace-reload-"));
    const firstRoot = join(data, "first-root");
    mkdirSync(firstRoot);
    gitRepository(firstRoot, "first-project");
    const secondRoot = join(data, "second-root");
    mkdirSync(secondRoot);

    // The daemon instance remains alive while a separate CLI instance edits
    // the same runner-local registry file.
    const daemonRegistry = new WorkspaceRegistry(data);
    const cliRegistry = new WorkspaceRegistry(data);
    const first = cliRegistry.addWorkspace(firstRoot, "First");
    expect(daemonRegistry.listConfigured()).toEqual([
      { workspace_id: first.workspace_id, label: "First" },
    ]);
    const browse = daemonRegistry.handle({
      request_id: "browse-before-remove",
      operation: "browse",
      workspace_id: first.workspace_id,
    });
    const entryId = browse.entries?.[0]?.entry_id;
    if (!entryId) throw new Error("repository entry was not returned");
    const validation = daemonRegistry.handle({
      request_id: "validate-before-remove",
      operation: "validate",
      workspace_id: first.workspace_id,
      entry_id: entryId,
    });
    const repositoryId = validation.repository?.repository_id;
    if (!repositoryId) throw new Error("repository validation did not return an id");

    expect(cliRegistry.removeWorkspace(first.workspace_id)).toBe(true);
    expect(daemonRegistry.repositoryPath(repositoryId)).toBeUndefined();

    expect(daemonRegistry.handle({ request_id: "list-after-remove", operation: "list" })).toEqual({
      request_id: "list-after-remove",
      operation: "list",
      status: "ok",
      workspaces: [],
    });
    expect(
      daemonRegistry.handle({
        request_id: "validate-after-remove",
        operation: "validate",
        workspace_id: first.workspace_id,
        entry_id: entryId,
      }),
    ).toEqual({
      request_id: "validate-after-remove",
      operation: "validate",
      status: "not_found",
    });

    // A later mutation by the already-loaded daemon begins by reloading the
    // file, so it cannot write its stale copy of the removed workspace back.
    const second = daemonRegistry.addWorkspace(secondRoot, "Second");
    expect(new WorkspaceRegistry(data).listConfigured()).toEqual([
      { workspace_id: second.workspace_id, label: "Second" },
    ]);
  });

  it("quarantines a truncated registry and fails closed without reauthorizing paths", () => {
    const data = mkdtempSync(join(tmpdir(), "norns-workspace-corrupt-"));
    const workspace = join(data, "approved-root");
    mkdirSync(workspace);
    const registry = new WorkspaceRegistry(data);
    registry.addWorkspace(workspace, "Approved");
    const registryPath = join(data, "workspace-registry.json");

    // Simulate a truncated legacy/non-atomic write while the daemon instance
    // remains loaded. Recovery preserves the bytes but authorizes nothing.
    writeFileSync(registryPath, '{"version":1,"workspaces":[');
    expect(registry.listConfigured()).toEqual([]);
    expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual({
      version: 1,
      workspaces: [],
      repositories: [],
    });
    expect(lstatSync(registryPath).mode & 0o777).toBe(0o600);
    const quarantined = readdirSync(data).filter((name) =>
      name.startsWith("workspace-registry.json.corrupt-"),
    );
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(data, quarantined[0] ?? ""), "utf8")).toContain('"workspaces":[');
    expect(lstatSync(join(data, quarantined[0] ?? "")).mode & 0o777).toBe(0o600);
  });

  it("bounds a browse response without probing ordinary folders as Git repositories", () => {
    const data = mkdtempSync(join(tmpdir(), "norns-workspace-bounded-"));
    const workspace = join(data, "many-folders");
    mkdirSync(workspace);
    for (let index = 0; index < 250; index += 1) {
      mkdirSync(join(workspace, `folder-${String(index).padStart(3, "0")}`));
    }
    const registry = new WorkspaceRegistry(data);
    const configured = registry.addWorkspace(workspace, "Many folders");
    const response = registry.handle({
      request_id: "bounded-browse",
      operation: "browse",
      workspace_id: configured.workspace_id,
    });
    expect(response).toMatchObject({ status: "ok" });
    expect(response.entries).toHaveLength(200);
  });
});
