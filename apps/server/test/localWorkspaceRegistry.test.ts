import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
});
