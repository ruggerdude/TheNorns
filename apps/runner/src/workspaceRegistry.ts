import { execFile, execFileSync } from "node:child_process";
// Runner-local workspace registry.  The relay receives only opaque handles
// and Git metadata: all physical paths remain in this 0600 local file.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { platform } from "node:process";
import { promisify } from "node:util";
import type {
  RepositoryInspectionT,
  RunnerWorkspaceEntryT,
  RunnerWorkspaceRequestT,
  RunnerWorkspaceResponseT,
} from "@norns/contracts";
import {
  MAX_REPOSITORY_FILE_CHARS,
  MAX_REPOSITORY_SAMPLE_CHARS,
  MAX_REPOSITORY_TREE_PATHS,
  selectRepositoryKeyFiles,
} from "@norns/contracts";

interface WorkspaceRecord {
  workspace_id: string;
  root_path: string;
  label: string;
}

interface RepositoryRecord {
  repository_id: string;
  workspace_id: string;
  repository_path: string;
}

interface PersistedRegistry {
  version: 1;
  workspaces: WorkspaceRecord[];
  repositories: RepositoryRecord[];
}

interface Handle {
  workspace_id: string;
  path: string;
  kind: "folder" | "repository";
  expires_at: number;
}

const GIT_PROBE_TIMEOUT_MS = 250;
const BROWSE_DEADLINE_MS = 750;
const MAX_BROWSE_ENTRIES = 200;
const MAX_BROWSE_SCAN = 400;

class InvalidWorkspaceRegistryError extends Error {}

const execFileAsync = promisify(execFile);

export type DirectoryPicker = (purpose?: "repository" | "clone_parent") => Promise<string | null>;
export type RepositoryCloner = (input: {
  cloneUrl: string;
  target: string;
  token: string;
}) => Promise<void>;

const cloneGitHubRepository: RepositoryCloner = async ({ cloneUrl, target, token }) => {
  const authorization = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  await execFileAsync("git", ["clone", "--origin", "origin", "--no-tags", "--", cloneUrl, target], {
    encoding: "utf8",
    timeout: 5 * 60_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${authorization}`,
    },
  });
};

function pickerCommand(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolvePicker) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        resolvePicker(null);
        return;
      }
      const selected = stdout.trim();
      resolvePicker(selected || null);
    });
  });
}

/** Opens the operating system's folder chooser without exposing its result to the relay. */
export function chooseNativeDirectory(
  purpose: "repository" | "clone_parent" = "repository",
): Promise<string | null> {
  const prompt =
    purpose === "clone_parent"
      ? "Choose where The Norns should create the project folder"
      : "Choose a Git project folder for The Norns";
  if (platform === "darwin") {
    return pickerCommand("osascript", [
      "-e",
      `POSIX path of (choose folder with prompt "${prompt}")`,
    ]);
  }
  if (platform === "win32") {
    return pickerCommand("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = '${prompt}'; if ($dialog.ShowDialog() -eq 'OK') { $dialog.SelectedPath }`,
    ]);
  }
  return pickerCommand("zenity", ["--file-selection", "--directory", `--title=${prompt}`]);
}

function opaque(): string {
  // Random values are persisted locally.  Cloud-facing identity must not be
  // derivable from the physical path, even by someone who knows a candidate.
  return `local:${randomUUID().replaceAll("-", "")}`;
}

function safeLabel(value: string, fallback: string): string {
  const candidate = value.trim().slice(0, 240);
  const containsControl = [...candidate].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  return candidate && !candidate.includes("/") && !candidate.includes("\\") && !containsControl
    ? candidate
    : fallback;
}

function safeError(): "invalid_request" | "not_found" | "unavailable" {
  // Do not leak an operating-system error (which commonly includes a path).
  return "unavailable";
}

/** A bounded, symlink-safe registry for folders explicitly approved locally. */
export class WorkspaceRegistry {
  private readonly dataDirectory: string;
  private readonly file: string;
  private readonly lockDirectory: string;
  private state: PersistedRegistry;
  private readonly handles = new Map<string, Handle>();

  constructor(
    dataDir: string,
    private readonly directoryPicker: DirectoryPicker = chooseNativeDirectory,
    private readonly repositoryCloner: RepositoryCloner = cloneGitHubRepository,
  ) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.dataDirectory = dataDir;
    this.file = join(dataDir, "workspace-registry.json");
    this.lockDirectory = join(dataDir, "workspace-registry.lock");
    this.state = { version: 1, workspaces: [], repositories: [] };
    this.withMutationLock(() => {
      if (existsSync(this.file)) this.reloadOrRecover();
      else this.persist();
    });
    chmodSync(this.file, 0o600);
  }

  /** Handles native selection asynchronously so an open dialog never blocks the runner socket. */
  async handleAsync(request: RunnerWorkspaceRequestT): Promise<RunnerWorkspaceResponseT> {
    if (request.operation !== "choose" && request.operation !== "clone") {
      return this.handle(request);
    }
    try {
      const selectedPath = await this.directoryPicker(
        request.operation === "clone" ? "clone_parent" : "repository",
      );
      if (!selectedPath) {
        return {
          request_id: request.request_id,
          operation: request.operation,
          status: "cancelled",
        };
      }
      if (request.operation === "clone") {
        const cloned = await this.cloneSelectedRepository(
          selectedPath,
          request.clone_url ?? "",
          request.repository_name ?? "",
          request.clone_token ?? "",
        );
        return "repository" in cloned
          ? {
              request_id: request.request_id,
              operation: "clone",
              status: "ok",
              repository: cloned.repository,
            }
          : {
              request_id: request.request_id,
              operation: "clone",
              status: cloned.status,
            };
      }
      const repository = this.registerSelectedRepository(selectedPath);
      return repository
        ? {
            request_id: request.request_id,
            operation: "choose",
            status: "ok",
            repository,
          }
        : { request_id: request.request_id, operation: "choose", status: "invalid_request" };
    } catch {
      return {
        request_id: request.request_id,
        operation: request.operation,
        status: request.operation === "clone" ? "clone_failed" : "unavailable",
      };
    }
  }

  /**
   * Clone into a human-approved parent without exposing that parent to the
   * relay. The short-lived repository-scoped token is supplied to git only
   * through process environment configuration and is never written into the
   * remote URL or the runner registry.
   */
  private async cloneSelectedRepository(
    selectedParent: string,
    cloneUrl: string,
    repositoryName: string,
    cloneToken: string,
  ): Promise<
    | { repository: NonNullable<RunnerWorkspaceResponseT["repository"]> }
    | { status: "invalid_request" | "destination_exists" | "clone_failed" }
  > {
    if (
      !/^[A-Za-z0-9._-]{1,100}$/.test(repositoryName) ||
      !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(cloneUrl) ||
      !cloneToken
    ) {
      return { status: "invalid_request" };
    }
    const parent = this.localDirectory(selectedParent);
    const target = resolve(parent, repositoryName);
    if (!this.contains(parent, target) || target === parent) {
      return { status: "invalid_request" };
    }
    if (existsSync(target)) {
      if (this.matchesClone(target, cloneUrl)) {
        const repository = this.registerSelectedRepository(target);
        return repository ? { repository } : { status: "destination_exists" };
      }
      return { status: "destination_exists" };
    }
    const staging = join(parent, `.norns-clone-${randomUUID()}`);
    let installedTarget = false;
    try {
      await this.repositoryCloner({ cloneUrl, target: staging, token: cloneToken });
      if (existsSync(target)) {
        rmSync(staging, { recursive: true, force: true });
        return { status: "destination_exists" };
      }
      renameSync(staging, target);
      installedTarget = true;
      const repository = this.registerSelectedRepository(target);
      if (!repository) throw new Error("cloned repository could not be verified");
      return { repository };
    } catch {
      rmSync(staging, { recursive: true, force: true });
      if (installedTarget) rmSync(target, { recursive: true, force: true });
      return { status: "clone_failed" };
    }
  }

  private matchesClone(path: string, cloneUrl: string): boolean {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
      const physical = realpathSync(path);
      const existing = execFileSync(
        "git",
        ["-C", physical, "config", "--get", "remote.origin.url"],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 3_000,
        },
      ).trim();
      return (
        existing.toLowerCase() === cloneUrl.toLowerCase() && this.gitMetadata(physical) !== null
      );
    } catch {
      return false;
    }
  }

  addWorkspace(inputPath: string, label?: string): WorkspaceRecord {
    const root = this.localDirectory(inputPath);
    return this.withMutationLock(() => {
      this.reloadOrRecover();
      const existing = this.state.workspaces.find((entry) => entry.root_path === root);
      const record: WorkspaceRecord = {
        workspace_id: existing?.workspace_id ?? opaque(),
        root_path: root,
        label: safeLabel(label ?? "", basename(root)),
      };
      const index = this.state.workspaces.findIndex(
        (entry) => entry.workspace_id === record.workspace_id,
      );
      if (index >= 0) this.state.workspaces[index] = record;
      else this.state.workspaces.push(record);
      this.persist();
      return record;
    });
  }

  removeWorkspace(workspaceId: string): boolean {
    return this.withMutationLock(() => {
      this.reloadOrRecover();
      const before = this.state.workspaces.length;
      this.state.workspaces = this.state.workspaces.filter(
        (entry) => entry.workspace_id !== workspaceId,
      );
      this.state.repositories = this.state.repositories.filter(
        (entry) => entry.workspace_id !== workspaceId,
      );
      if (before !== this.state.workspaces.length) this.persist();
      return before !== this.state.workspaces.length;
    });
  }

  listConfigured(): readonly { workspace_id: string; label: string }[] {
    this.reload();
    return this.state.workspaces.map(({ workspace_id, label, root_path }) => ({
      workspace_id,
      label: safeLabel(label, basename(root_path)),
    }));
  }

  /** Handles a wire request.  It never throws or returns a raw filesystem path. */
  handle(request: RunnerWorkspaceRequestT): RunnerWorkspaceResponseT {
    try {
      this.reload();
      this.pruneHandles();
      if (request.operation === "list") {
        return {
          request_id: request.request_id,
          operation: "list",
          status: "ok",
          workspaces: [...this.listConfigured()],
        };
      }
      if (request.operation === "catalog") {
        return {
          request_id: request.request_id,
          operation: "catalog",
          status: "ok",
          repositories: this.catalog(),
        };
      }
      if (request.operation === "inspect") {
        const inspection = this.inspect(request.repository_id ?? "");
        return inspection
          ? {
              request_id: request.request_id,
              operation: "inspect",
              status: "ok",
              inspection,
            }
          : {
              request_id: request.request_id,
              operation: "inspect",
              status: "not_found",
            };
      }
      const workspace = this.workspace(request.workspace_id ?? "");
      if (!workspace)
        return {
          request_id: request.request_id,
          operation: request.operation,
          status: "not_found",
        };
      if (request.operation === "browse") {
        const path = request.entry_id
          ? this.handlePath(workspace, request.entry_id, "folder")
          : workspace.root_path;
        if (!path)
          return { request_id: request.request_id, operation: "browse", status: "not_found" };
        return {
          request_id: request.request_id,
          operation: "browse",
          status: "ok",
          entries: this.browse(workspace, path),
        };
      }
      return this.withMutationLock(() => {
        // A CLI remove may happen after browse. Reload under the same lock used
        // by add/remove before accepting the transient handle or persisting a
        // repository identity, so removal always revokes validation.
        this.reloadOrRecover();
        const currentWorkspace = this.workspace(request.workspace_id ?? "");
        if (!currentWorkspace)
          return { request_id: request.request_id, operation: "validate", status: "not_found" };
        const path = this.handlePath(currentWorkspace, request.entry_id ?? "", "repository");
        if (!path)
          return { request_id: request.request_id, operation: "validate", status: "not_found" };
        const repository = this.validate(currentWorkspace, path);
        return repository
          ? { request_id: request.request_id, operation: "validate", status: "ok", repository }
          : { request_id: request.request_id, operation: "validate", status: "invalid_request" };
      });
    } catch {
      return { request_id: request.request_id, operation: request.operation, status: safeError() };
    }
  }

  repositoryPath(repositoryId: string): string | undefined {
    this.reload();
    const repository = this.state.repositories.find(
      (entry) => entry.repository_id === repositoryId,
    );
    if (!repository) return undefined;
    const workspace = this.workspace(repository.workspace_id);
    if (!workspace) return undefined;
    try {
      // Re-check at execution time.  A directory that was safe during folder
      // selection may later be replaced by a symlink; returning its persisted
      // lexical path would let Git follow that replacement outside the root.
      const stat = lstatSync(repository.repository_path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
      const physical = realpathSync(repository.repository_path);
      if (!this.contains(workspace.root_path, physical)) return undefined;
      return this.gitMetadata(physical) === null ? undefined : physical;
    } catch {
      return undefined;
    }
  }

  /** Exact local values that must be stripped from any cloud-bound text. */
  sensitivePaths(repositoryId: string): readonly string[] {
    this.reload();
    const repository = this.state.repositories.find(
      (entry) => entry.repository_id === repositoryId,
    );
    if (!repository) return [];
    const workspace = this.workspace(repository.workspace_id);
    return workspace ? [workspace.root_path, repository.repository_path] : [];
  }

  /**
   * Reads a bounded snapshot from the repository's committed HEAD. Untracked
   * files and working-tree edits are deliberately excluded, and no physical
   * path is included in the relay response.
   */
  private inspect(repositoryId: string): RepositoryInspectionT | null {
    const path = this.repositoryPath(repositoryId);
    if (!path) return null;
    const sensitivePaths = this.sensitivePaths(repositoryId).flatMap((sensitivePath) => [
      sensitivePath,
      ...(sensitivePath.startsWith("/private/") ? [sensitivePath.slice("/private".length)] : []),
    ]);
    const repository = this.state.repositories.find(
      (entry) => entry.repository_id === repositoryId,
    );
    if (!repository) return null;
    const workspace = this.workspace(repository.workspace_id);
    if (!workspace) return null;
    const metadata = this.gitMetadata(path, 3_000);
    if (!metadata) return null;

    const rawTree = execFileSync("git", ["-C", path, "ls-tree", "-r", "-z", "--long", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const blobs = rawTree
      .split("\0")
      .filter(Boolean)
      .flatMap((line) => {
        const match = line.match(/^\d+\s+blob\s+[a-f0-9]+\s+(\d+|-)\t(.+)$/s);
        if (!match) return [];
        const filePath = match[2] ?? "";
        const size = Number(match[1]);
        if (
          !Number.isFinite(size) ||
          filePath.startsWith("/") ||
          filePath.includes("\\") ||
          filePath
            .split("/")
            .some((segment) => segment.length === 0 || segment === "." || segment === "..")
        ) {
          return [];
        }
        return [{ path: filePath, size }];
      });
    if (blobs.length === 0) return null;

    let budget = MAX_REPOSITORY_SAMPLE_CHARS;
    const tree_paths: string[] = [];
    for (const blob of blobs.slice(0, MAX_REPOSITORY_TREE_PATHS)) {
      const cost = blob.path.length + 1;
      if (cost > budget) break;
      tree_paths.push(blob.path);
      budget -= cost;
    }
    const files: RepositoryInspectionT["files"] = [];
    for (const file of selectRepositoryKeyFiles(blobs)) {
      if (budget <= file.path.length) break;
      const raw = execFileSync("git", ["-C", path, "show", `HEAD:${file.path}`], {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3_000,
        maxBuffer: 1024 * 1024,
      });
      // NUL is a reliable cheap binary signal. Binary key files are skipped.
      if (raw.includes(0)) continue;
      const content = sensitivePaths.reduce(
        (safe, sensitivePath) => safe.replaceAll(sensitivePath, "[LOCAL_PATH]"),
        raw.toString("utf8"),
      );
      const cap = Math.min(MAX_REPOSITORY_FILE_CHARS, Math.max(0, budget - file.path.length));
      if (cap === 0) break;
      files.push({
        path: file.path,
        content: content.slice(0, cap),
        truncated: content.length > cap,
      });
      budget -= file.path.length + Math.min(content.length, cap);
    }

    return {
      repository_id: repositoryId,
      repository_display_name: safeLabel(workspace.label, basename(path)),
      default_branch: metadata.defaultBranch,
      observed_head: metadata.head,
      total_files: blobs.length,
      tree_truncated: blobs.length > tree_paths.length,
      tree_paths,
      files,
    };
  }

  private catalog(): NonNullable<RunnerWorkspaceResponseT["repositories"]> {
    const repositories: NonNullable<RunnerWorkspaceResponseT["repositories"]> = [];
    for (const record of [...this.state.repositories]) {
      const path = this.repositoryPath(record.repository_id);
      if (!path) continue;
      const metadata = this.gitMetadata(path, 3_000);
      if (!metadata) continue;
      repositories.push({
        workspace_id: record.workspace_id,
        repository_id: record.repository_id,
        repository_display_name: safeLabel(basename(path), "Repository"),
        default_branch: metadata.defaultBranch,
        observed_head: metadata.head,
      });
    }
    return repositories.slice(0, 200);
  }

  private browse(workspace: WorkspaceRecord, path: string): RunnerWorkspaceEntryT[] {
    // One directory level only.  No recursive traversal and no symlink following.
    const entries: RunnerWorkspaceEntryT[] = [];
    const deadline = Date.now() + BROWSE_DEADLINE_MS;
    // An approved workspace may itself be the repository (the common case for
    // a user who approves one cloned project folder).
    if (
      path === workspace.root_path &&
      this.mightBeGitRepository(path) &&
      this.gitMetadata(path) !== null
    ) {
      const entryId = randomUUID().replaceAll("-", "");
      this.rememberHandle(entryId, {
        workspace_id: workspace.workspace_id,
        path,
        kind: "repository",
        expires_at: Date.now() + 5 * 60_000,
      });
      entries.push({
        entry_id: entryId,
        label: safeLabel(workspace.label, basename(workspace.root_path)),
        kind: "repository",
        can_browse: false,
      });
    }
    const directory = opendirSync(path);
    const names: string[] = [];
    try {
      while (names.length < MAX_BROWSE_SCAN && Date.now() < deadline) {
        const entry = directory.readSync();
        if (!entry) break;
        if (entry.name !== ".git") names.push(entry.name);
      }
    } finally {
      directory.closeSync();
    }
    for (const name of names.sort()) {
      if (entries.length >= MAX_BROWSE_ENTRIES || Date.now() >= deadline) break;
      const child = join(path, name);
      const stat = lstatSync(child);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      const physical = realpathSync(child);
      if (!this.contains(workspace.root_path, physical)) continue;
      const repository = this.mightBeGitRepository(physical) && this.gitMetadata(physical) !== null;
      const entryId = randomUUID().replaceAll("-", "");
      this.rememberHandle(entryId, {
        workspace_id: workspace.workspace_id,
        path: physical,
        kind: repository ? "repository" : "folder",
        expires_at: Date.now() + 5 * 60_000,
      });
      entries.push({
        entry_id: entryId,
        label: safeLabel(name, repository ? "Repository" : "Folder"),
        kind: repository ? "repository" : "folder",
        can_browse: !repository,
      });
    }
    return entries;
  }

  private validate(
    workspace: WorkspaceRecord,
    path: string,
  ): RunnerWorkspaceResponseT["repository"] | null {
    const metadata = this.gitMetadata(path);
    if (!metadata) return null;
    const existing = this.state.repositories.find(
      (entry) => entry.workspace_id === workspace.workspace_id && entry.repository_path === path,
    );
    const record: RepositoryRecord = {
      repository_id: existing?.repository_id ?? opaque(),
      workspace_id: workspace.workspace_id,
      repository_path: path,
    };
    const index = this.state.repositories.findIndex(
      (entry) => entry.repository_id === record.repository_id,
    );
    if (index >= 0) this.state.repositories[index] = record;
    else this.state.repositories.push(record);
    this.persist();
    return {
      workspace_id: workspace.workspace_id,
      repository_id: record.repository_id,
      repository_display_name: safeLabel(basename(path), "Repository"),
      default_branch: metadata.defaultBranch,
      observed_head: metadata.head,
    };
  }

  private registerSelectedRepository(
    selectedPath: string,
  ): RunnerWorkspaceResponseT["repository"] | null {
    const root = this.localDirectory(selectedPath);
    // An explicit human selection can tolerate a slower probe than passive
    // directory browsing, especially when the repository lives on an external volume.
    const metadata = this.gitMetadata(root, 3_000);
    if (!metadata) return null;
    return this.withMutationLock(() => {
      this.reloadOrRecover();
      const existingWorkspace = this.state.workspaces.find((entry) => entry.root_path === root);
      const workspace: WorkspaceRecord = {
        workspace_id: existingWorkspace?.workspace_id ?? opaque(),
        root_path: root,
        label: safeLabel("", basename(root)),
      };
      const workspaceIndex = this.state.workspaces.findIndex(
        (entry) => entry.workspace_id === workspace.workspace_id,
      );
      if (workspaceIndex >= 0) this.state.workspaces[workspaceIndex] = workspace;
      else this.state.workspaces.push(workspace);

      const existingRepository = this.state.repositories.find(
        (entry) => entry.workspace_id === workspace.workspace_id && entry.repository_path === root,
      );
      const repository: RepositoryRecord = {
        repository_id: existingRepository?.repository_id ?? opaque(),
        workspace_id: workspace.workspace_id,
        repository_path: root,
      };
      const repositoryIndex = this.state.repositories.findIndex(
        (entry) => entry.repository_id === repository.repository_id,
      );
      if (repositoryIndex >= 0) this.state.repositories[repositoryIndex] = repository;
      else this.state.repositories.push(repository);
      this.persist();
      return {
        workspace_id: workspace.workspace_id,
        repository_id: repository.repository_id,
        repository_display_name: safeLabel(basename(root), "Repository"),
        default_branch: metadata.defaultBranch,
        observed_head: metadata.head,
      };
    });
  }

  private gitMetadata(
    path: string,
    timeoutMs = GIT_PROBE_TIMEOUT_MS,
  ): { defaultBranch: string; head: string } | null {
    try {
      // `-C` accepts a path, but it has already been realpath-contained and no
      // user string reaches the shell (execFileSync does not invoke one).
      const [inside, rawTopLevel, head, branch] = execFileSync(
        "git",
        [
          "-C",
          path,
          "rev-parse",
          "--is-inside-work-tree",
          "--show-toplevel",
          "HEAD",
          "--abbrev-ref",
          "HEAD",
        ],
        {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: timeoutMs,
        },
      )
        .trim()
        .split("\n");
      if (inside !== "true" || !rawTopLevel || !head || !branch || branch === "HEAD") return null;
      const topLevel = realpathSync(rawTopLevel);
      // Choosing a nested folder must not silently bind its parent repository.
      if (topLevel !== path) return null;
      return { head, defaultBranch: branch };
    } catch {
      return null;
    }
  }

  private mightBeGitRepository(path: string): boolean {
    try {
      const metadata = lstatSync(join(path, ".git"));
      return !metadata.isSymbolicLink() && (metadata.isDirectory() || metadata.isFile());
    } catch {
      return false;
    }
  }

  private handlePath(
    workspace: WorkspaceRecord,
    entryId: string,
    kind: Handle["kind"],
  ): string | undefined {
    const entry = this.handles.get(entryId);
    if (
      !entry ||
      entry.expires_at <= Date.now() ||
      entry.workspace_id !== workspace.workspace_id ||
      entry.kind !== kind
    )
      return undefined;
    try {
      const stat = lstatSync(entry.path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return undefined;
      const physical = realpathSync(entry.path);
      return this.contains(workspace.root_path, physical) ? physical : undefined;
    } catch {
      return undefined;
    }
  }

  private workspace(id: string): WorkspaceRecord | undefined {
    return this.state.workspaces.find((entry) => entry.workspace_id === id);
  }

  private localDirectory(input: string): string {
    const submitted = resolve(input);
    // Do not turn an operator-approved symlink into a root with a surprising
    // target.  The user must approve the physical directory itself.
    if (lstatSync(submitted).isSymbolicLink()) throw new Error("workspace must not be a symlink");
    const path = realpathSync(submitted);
    if (!statSync(path).isDirectory()) throw new Error("workspace must be a real directory");
    return path;
  }

  private contains(root: string, child: string): boolean {
    const relativePath = relative(root, child);
    return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
  }

  private persist(): void {
    // Readers must see either the prior complete registry or the next complete
    // registry. A unique temp name also keeps independent runner/CLI processes
    // from clobbering one another during atomic replacement.
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600 });
      chmodSync(temporary, 0o600);
      this.fsync(temporary);
      renameSync(temporary, this.file);
      chmodSync(this.file, 0o600);
      this.fsync(this.dataDirectory);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  private reload(): void {
    try {
      this.readState();
    } catch (error) {
      if (!(error instanceof InvalidWorkspaceRegistryError)) throw error;
      this.withMutationLock(() => this.reloadOrRecover());
    }
  }

  private reloadOrRecover(): void {
    try {
      this.readState();
    } catch (error) {
      if (!(error instanceof InvalidWorkspaceRegistryError)) throw error;
      // Never recover authorization from a stale backup. Preserve the invalid
      // bytes for operator diagnosis and replace them with an empty, fail-closed
      // registry that must be explicitly re-approved through the CLI.
      const quarantine = `${this.file}.corrupt-${Date.now()}-${randomUUID()}`;
      renameSync(this.file, quarantine);
      chmodSync(quarantine, 0o600);
      this.state = { version: 1, workspaces: [], repositories: [] };
      this.persist();
    }
  }

  private readState(): void {
    let candidate: unknown;
    try {
      candidate = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) throw new InvalidWorkspaceRegistryError();
      throw error;
    }
    if (!this.validState(candidate)) throw new InvalidWorkspaceRegistryError();
    this.state = candidate;
    chmodSync(this.file, 0o600);
  }

  private validState(value: unknown): value is PersistedRegistry {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<PersistedRegistry>;
    return (
      candidate.version === 1 &&
      Array.isArray(candidate.workspaces) &&
      candidate.workspaces.every(
        (workspace) =>
          workspace !== null &&
          typeof workspace === "object" &&
          typeof workspace.workspace_id === "string" &&
          typeof workspace.root_path === "string" &&
          typeof workspace.label === "string",
      ) &&
      Array.isArray(candidate.repositories) &&
      candidate.repositories.every(
        (repository) =>
          repository !== null &&
          typeof repository === "object" &&
          typeof repository.repository_id === "string" &&
          typeof repository.workspace_id === "string" &&
          typeof repository.repository_path === "string",
      )
    );
  }

  private fsync(path: string): void {
    const descriptor = openSync(path, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private withMutationLock<T>(operation: () => T): T {
    const startedAt = Date.now();
    for (;;) {
      try {
        mkdirSync(this.lockDirectory, { mode: 0o700 });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(this.lockDirectory).mtimeMs > 60_000) {
            rmSync(this.lockDirectory, { recursive: true, force: true });
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code !== "ENOENT") throw lockError;
          continue;
        }
        if (Date.now() - startedAt >= 5_000) throw new Error("workspace registry is busy");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    try {
      return operation();
    } finally {
      rmSync(this.lockDirectory, { recursive: true, force: true });
    }
  }

  private rememberHandle(id: string, value: Handle): void {
    this.pruneHandles();
    while (this.handles.size >= 1_000) {
      const oldest = this.handles.keys().next().value;
      if (!oldest) break;
      this.handles.delete(oldest);
    }
    this.handles.set(id, value);
  }

  private pruneHandles(): void {
    const now = Date.now();
    for (const [id, handle] of this.handles) {
      if (handle.expires_at <= now) this.handles.delete(id);
    }
  }
}
