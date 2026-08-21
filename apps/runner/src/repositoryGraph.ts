import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  RepositoryGraphEdgeT,
  RepositoryGraphNodeT,
  RepositoryGraphT,
} from "@norns/contracts";

const execFileAsync = promisify(execFile);

export const GRAPHIFY_PACKAGE_VERSION = "0.9.48";
const MAX_GRAPH_BYTES = 64 * 1024 * 1024;
const MAX_VISIBLE_NODES = 180;
const MAX_VISIBLE_EDGES = 500;

interface GraphifyMetadata {
  indexed_head: string;
  indexed_at: string;
  graphify_version: string;
}

interface RawGraph {
  nodes?: unknown;
  links?: unknown;
  edges?: unknown;
  graph?: unknown;
}

interface ParsedGraph {
  nodes: RepositoryGraphNodeT[];
  edges: RepositoryGraphEdgeT[];
  communityCount: number;
}

export type GraphifyCommand = (input: {
  repositoryPath: string;
  outputDirectory: string;
}) => Promise<{ version: string }>;

function cleanText(value: unknown, fallback: string, maximum = 1_000): string {
  const sanitized = [...String(value ?? "")]
    .map((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127 ? " " : character;
    })
    .join("");
  const text = sanitized.replace(/\s+/g, " ").trim().slice(0, maximum);
  return text || fallback;
}

function withoutModelCredentials(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, GRAPHIFY_QUERY_LOG_DISABLE: "1" };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
  ]) {
    delete environment[key];
  }
  return environment;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 128 * 1024,
      env: withoutModelCredentials(),
    });
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function graphifyInvocation(): Promise<{ command: string; prefix: string[] } | null> {
  if (await commandExists("graphify")) return { command: "graphify", prefix: [] };
  if (await commandExists("uvx")) {
    return {
      command: "uvx",
      prefix: ["--from", `graphifyy==${GRAPHIFY_PACKAGE_VERSION}`, "graphify"],
    };
  }
  return null;
}

const runGraphify: GraphifyCommand = async ({ repositoryPath, outputDirectory }) => {
  const invocation = await graphifyInvocation();
  if (!invocation) throw new Error("graphify_unavailable");
  await execFileAsync(
    invocation.command,
    [
      ...invocation.prefix,
      "extract",
      repositoryPath,
      "--code-only",
      "--force",
      "--out",
      outputDirectory,
    ],
    {
      encoding: "utf8",
      timeout: 10 * 60_000,
      maxBuffer: 2 * 1024 * 1024,
      env: withoutModelCredentials(),
    },
  );
  return {
    version: invocation.command === "uvx" ? GRAPHIFY_PACKAGE_VERSION : "installed",
  };
};

function cacheKey(repositoryId: string): string {
  return createHash("sha256").update(repositoryId).digest("hex").slice(0, 32);
}

function readMetadata(file: string): GraphifyMetadata | null {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Partial<GraphifyMetadata>;
    if (
      typeof value.indexed_head !== "string" ||
      typeof value.indexed_at !== "string" ||
      typeof value.graphify_version !== "string" ||
      !Number.isFinite(Date.parse(value.indexed_at))
    ) {
      return null;
    }
    return value as GraphifyMetadata;
  } catch {
    return null;
  }
}

async function repositoryRevision(repositoryPath: string): Promise<string> {
  const [head, status] = await Promise.all([
    execFileAsync("git", ["-C", repositoryPath, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 128 * 1024,
    }),
    execFileAsync("git", ["-C", repositoryPath, "status", "--porcelain=v1"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    }),
  ]);
  const commit = head.stdout.trim();
  const workingTree = status.stdout;
  if (!workingTree) return commit;
  const digest = createHash("sha256").update(workingTree).digest("hex").slice(0, 12);
  return `${commit}-dirty.${digest}`;
}

function safeRelativeSource(repositoryPath: string, raw: unknown): string | undefined {
  const value = String(raw ?? "").trim();
  if (!value) return undefined;
  const normalized = value.replaceAll("\\", "/");
  const candidate = isAbsolute(value)
    ? relative(repositoryPath, resolve(value)).replaceAll("\\", "/")
    : normalized.replace(/^\.\//, "");
  if (
    !candidate ||
    candidate.startsWith("/") ||
    candidate.length > 1_000 ||
    candidate.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return candidate;
}

function scrubRepositoryPath(
  repositoryPath: string,
  value: unknown,
  fallback: string,
  maximum = 1_000,
): string {
  const physical = repositoryPath.replaceAll("\\", "/").replace(/\/$/, "");
  const aliases = [physical];
  if (physical.startsWith("/private/")) aliases.push(physical.slice("/private".length));
  let text = String(value ?? "").replaceAll("\\", "/");
  const containsRepositoryPath = aliases.some((alias) => text.includes(alias));
  if (
    !containsRepositoryPath &&
    (text.startsWith("/") || /^[A-Za-z]:\//.test(text) || text.startsWith("file://"))
  ) {
    return cleanText(fallback, fallback, maximum);
  }
  for (const alias of aliases) text = text.replaceAll(alias, "");
  return cleanText(text.replace(/^file:\/+/, "").replace(/^\/+/, ""), fallback, maximum);
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function parseGraph(repositoryPath: string, graphFile: string): ParsedGraph {
  const size = statSync(graphFile).size;
  if (size <= 0 || size > MAX_GRAPH_BYTES) throw new Error("graphify_output_too_large");
  const raw = JSON.parse(readFileSync(graphFile, "utf8")) as RawGraph;
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const rawEdges = Array.isArray(raw.links) ? raw.links : Array.isArray(raw.edges) ? raw.edges : [];
  const communityLabels = objectValue(objectValue(raw.graph).community_labels);
  const ids = new Map<string, string>();
  const usedIds = new Set<string>();

  const nodes = rawNodes.flatMap((entry, index): RepositoryGraphNodeT[] => {
    const node = objectValue(entry);
    const rawId = String(node.id ?? `node-${index + 1}`);
    let id = scrubRepositoryPath(repositoryPath, rawId, `node-${index + 1}`);
    if (id.length > 1_000 || usedIds.has(id)) {
      id = `node:${createHash("sha256").update(rawId).digest("hex").slice(0, 32)}`;
    }
    usedIds.add(id);
    ids.set(rawId, id);
    const community =
      node.community === undefined || node.community === null
        ? undefined
        : cleanText(node.community, "unassigned");
    const sourceFile = safeRelativeSource(repositoryPath, node.source_file);
    const sourceLocation =
      scrubRepositoryPath(repositoryPath, node.source_location, "", 100) || undefined;
    const fileType = cleanText(node.file_type ?? node.type, "", 1_000) || undefined;
    const label = scrubRepositoryPath(
      repositoryPath,
      node.label ?? node.name ?? rawId,
      sourceFile ?? `Node ${index + 1}`,
    );
    const communityLabel = community
      ? cleanText(
          node.community_label ?? node.community_name ?? communityLabels[community],
          "",
          1_000,
        ) || undefined
      : undefined;
    return [
      {
        id,
        label,
        ...(fileType ? { file_type: fileType } : {}),
        ...(sourceFile ? { source_file: sourceFile } : {}),
        ...(sourceLocation ? { source_location: sourceLocation } : {}),
        ...(community ? { community } : {}),
        ...(communityLabel ? { community_label: communityLabel } : {}),
        degree: 0,
      },
    ];
  });

  const knownIds = new Set(nodes.map((node) => node.id));
  const degree = new Map<string, number>();
  const edges = rawEdges.flatMap((entry, index): RepositoryGraphEdgeT[] => {
    const edge = objectValue(entry);
    const source = ids.get(String(edge.source ?? edge._src ?? ""));
    const target = ids.get(String(edge.target ?? edge._tgt ?? ""));
    if (!source || !target || !knownIds.has(source) || !knownIds.has(target)) return [];
    degree.set(source, (degree.get(source) ?? 0) + 1);
    degree.set(target, (degree.get(target) ?? 0) + 1);
    const relation = cleanText(edge.relation ?? edge.type, "related to");
    const confidence = cleanText(edge.confidence, "", 1_000) || undefined;
    return [
      {
        id: `edge:${createHash("sha256")
          .update(`${source}\0${target}\0${relation}\0${index}`)
          .digest("hex")
          .slice(0, 32)}`,
        source,
        target,
        relation,
        ...(confidence ? { confidence } : {}),
      },
    ];
  });
  for (const node of nodes) node.degree = Math.min(degree.get(node.id) ?? 0, 1_000_000);
  return {
    nodes,
    edges,
    communityCount: new Set(nodes.flatMap((node) => (node.community ? [node.community] : []))).size,
  };
}

function visibleSubgraph(graph: ParsedGraph, query?: string): ParsedGraph {
  const normalizedQuery = query?.trim().toLocaleLowerCase();
  const ordered = [...graph.nodes].sort(
    (left, right) => right.degree - left.degree || left.label.localeCompare(right.label),
  );
  const seeds = normalizedQuery
    ? ordered
        .filter((node) =>
          [node.label, node.source_file, node.file_type, node.community_label]
            .filter(Boolean)
            .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery)),
        )
        .slice(0, 60)
    : [];
  if (!normalizedQuery) {
    const communities = new Map<string, RepositoryGraphNodeT[]>();
    for (const node of ordered) {
      const community = node.community ?? "unassigned";
      communities.set(community, [...(communities.get(community) ?? []), node]);
    }
    for (const members of communities.values()) {
      const representative = members[0];
      if (representative) seeds.push(representative);
    }
    for (const node of ordered) {
      if (seeds.length >= Math.min(80, ordered.length)) break;
      if (!seeds.some((seed) => seed.id === node.id)) seeds.push(node);
    }
  }
  const selected = new Set(seeds.map((node) => node.id));
  if (normalizedQuery) {
    for (const edge of graph.edges) {
      if (!edge.relation.toLocaleLowerCase().includes(normalizedQuery)) continue;
      selected.add(edge.source);
      if (selected.size < MAX_VISIBLE_NODES) selected.add(edge.target);
    }
  }
  for (const edge of graph.edges) {
    if (selected.size >= MAX_VISIBLE_NODES) break;
    if (selected.has(edge.source) || selected.has(edge.target)) {
      selected.add(edge.source);
      if (selected.size < MAX_VISIBLE_NODES) selected.add(edge.target);
    }
  }
  const nodes = ordered.filter((node) => selected.has(node.id)).slice(0, MAX_VISIBLE_NODES);
  const included = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter((edge) => included.has(edge.source) && included.has(edge.target))
    .slice(0, MAX_VISIBLE_EDGES);
  return {
    nodes,
    edges,
    communityCount: new Set(nodes.flatMap((node) => (node.community ? [node.community] : []))).size,
  };
}

function emptyGraph(
  state: RepositoryGraphT["state"],
  observedHead: string,
  message?: string,
): RepositoryGraphT {
  return {
    state,
    ...(message ? { message } : {}),
    observed_head: observedHead,
    node_count: 0,
    edge_count: 0,
    community_count: 0,
    nodes: [],
    edges: [],
    truncated: false,
  };
}

export class RepositoryGraphService {
  private readonly root: string;
  private readonly active = new Map<string, Promise<RepositoryGraphT>>();

  constructor(
    dataDirectory: string,
    private readonly command: GraphifyCommand = runGraphify,
  ) {
    this.root = join(dataDirectory, "repository-graphs");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  async status(repositoryId: string, repositoryPath: string): Promise<RepositoryGraphT> {
    return this.read(repositoryId, repositoryPath);
  }

  async query(
    repositoryId: string,
    repositoryPath: string,
    search: string,
  ): Promise<RepositoryGraphT> {
    return this.read(repositoryId, repositoryPath, search.trim().slice(0, 200));
  }

  async index(repositoryId: string, repositoryPath: string): Promise<RepositoryGraphT> {
    const existing = this.active.get(repositoryId);
    if (existing) return existing;
    const operation = this.build(repositoryId, repositoryPath).finally(() => {
      this.active.delete(repositoryId);
    });
    this.active.set(repositoryId, operation);
    return operation;
  }

  private locations(repositoryId: string): {
    outputDirectory: string;
    graphFile: string;
    metadataFile: string;
  } {
    const outputDirectory = join(this.root, cacheKey(repositoryId));
    return {
      outputDirectory,
      graphFile: join(outputDirectory, "graphify-out", "graph.json"),
      metadataFile: join(outputDirectory, "norns-graphify.json"),
    };
  }

  private async build(repositoryId: string, repositoryPath: string): Promise<RepositoryGraphT> {
    const observedHead = await repositoryRevision(repositoryPath);
    const locations = this.locations(repositoryId);
    mkdirSync(locations.outputDirectory, { recursive: true, mode: 0o700 });
    try {
      const result = await this.command({
        repositoryPath,
        outputDirectory: locations.outputDirectory,
      });
      if (!existsSync(locations.graphFile)) throw new Error("graphify_output_missing");
      const metadata: GraphifyMetadata = {
        indexed_head: observedHead,
        indexed_at: new Date().toISOString(),
        graphify_version: cleanText(result.version, GRAPHIFY_PACKAGE_VERSION, 100),
      };
      writeFileSync(locations.metadataFile, `${JSON.stringify(metadata)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      return this.read(repositoryId, repositoryPath);
    } catch (error) {
      if (error instanceof Error && error.message === "graphify_unavailable") {
        return emptyGraph(
          "unavailable",
          observedHead,
          "Graphify is not available on this computer. Install Graphify or uv, then try again.",
        );
      }
      return emptyGraph(
        "failed",
        observedHead,
        "Graphify could not build this repository map. Confirm the repository is readable and try again.",
      );
    }
  }

  private async read(
    repositoryId: string,
    repositoryPath: string,
    query?: string,
  ): Promise<RepositoryGraphT> {
    const observedHead = await repositoryRevision(repositoryPath);
    const locations = this.locations(repositoryId);
    const metadata = readMetadata(locations.metadataFile);
    if (!metadata || !existsSync(locations.graphFile)) {
      const invocation = await graphifyInvocation();
      return emptyGraph(
        invocation ? "missing" : "unavailable",
        observedHead,
        invocation
          ? "Build a local Graphify map to explore this repository."
          : "Graphify is not available on this computer. Install Graphify or uv to build the map.",
      );
    }
    try {
      const complete = parseGraph(repositoryPath, locations.graphFile);
      const visible = visibleSubgraph(complete, query);
      return {
        state: metadata.indexed_head === observedHead ? "ready" : "stale",
        graphify_version: metadata.graphify_version,
        observed_head: observedHead,
        indexed_head: metadata.indexed_head,
        indexed_at: metadata.indexed_at,
        node_count: Math.min(complete.nodes.length, 10_000_000),
        edge_count: Math.min(complete.edges.length, 20_000_000),
        community_count: Math.min(complete.communityCount, 1_000_000),
        nodes: visible.nodes,
        edges: visible.edges,
        truncated:
          visible.nodes.length < complete.nodes.length ||
          visible.edges.length < complete.edges.length,
        ...(query ? { query } : {}),
      };
    } catch {
      return emptyGraph(
        "failed",
        observedHead,
        "The local Graphify map could not be read. Rebuild it to repair the index.",
      );
    }
  }
}
