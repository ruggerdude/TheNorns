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
