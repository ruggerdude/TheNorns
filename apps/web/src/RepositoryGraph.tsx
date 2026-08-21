import type {
  RepositoryGraphEdgeT,
  RepositoryGraphNodeT,
  RepositoryGraphT,
} from "@norns/contracts";
import {
  Background,
  Controls,
  type Edge,
  MarkerType,
  MiniMap,
  type Node,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UnauthorizedError } from "./auth";
import {
  loadRepositoryGraph,
  pollRepositoryGraphBuild,
  queryRepositoryGraph,
  startRepositoryGraphBuild,
} from "./repositoryGraphApi";
import { useTheme } from "./theme";
import { Badge, Button, Spinner } from "./ui";
import "./RepositoryGraph.css";

const COMMUNITY_COLORS = [
  "#3159d5",
  "#078a68",
  "#8b5cc7",
  "#c26b2f",
  "#c14372",
  "#357b9f",
  "#7570c9",
  "#738629",
] as const;

function communityColor(value: string | undefined): string {
  if (!value) return COMMUNITY_COLORS[0];
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return COMMUNITY_COLORS[hash % COMMUNITY_COLORS.length] ?? COMMUNITY_COLORS[0];
}

function shortRevision(value: string | undefined): string {
  if (!value) return "—";
  const [commit, suffix] = value.split("-dirty.");
  return `${commit?.slice(0, 8) ?? value.slice(0, 8)}${suffix ? " · modified" : ""}`;
}

function layout(nodes: RepositoryGraphNodeT[]): Map<string, { x: number; y: number }> {
  const groups = new Map<string, RepositoryGraphNodeT[]>();
  for (const node of nodes) {
    const group = node.community_label ?? node.community ?? "Repository";
    groups.set(group, [...(groups.get(group) ?? []), node]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  const columns = Math.max(1, Math.ceil(Math.sqrt(groups.size)));
  [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([, members], groupIndex) => {
      const originX = (groupIndex % columns) * 640;
      const originY = Math.floor(groupIndex / columns) * 500;
      const ordered = [...members].sort(
        (left, right) => right.degree - left.degree || left.label.localeCompare(right.label),
      );
      const radius = Math.max(135, Math.min(245, ordered.length * 13));
      ordered.forEach((node, nodeIndex) => {
        if (nodeIndex === 0) {
          positions.set(node.id, { x: originX + 230, y: originY + 185 });
          return;
        }
        const angle = ((nodeIndex - 1) / Math.max(1, ordered.length - 1)) * Math.PI * 2;
        const ring = 1 + Math.floor((nodeIndex - 1) / 18) * 0.62;
        positions.set(node.id, {
          x: originX + 230 + Math.cos(angle) * radius * ring,
          y: originY + 185 + Math.sin(angle) * radius * 0.68 * ring,
        });
      });
    });
  return positions;
}

function graphStateLabel(state: RepositoryGraphT["state"]): string {
  if (state === "ready") return "Current";
  if (state === "stale") return "Refresh recommended";
  if (state === "missing") return "Not built";
  if (state === "unavailable") return "Setup needed";
  return "Build failed";
}

export function RepositoryGraph({
  projectId,
  onUnauthorized,
}: {
  projectId: string;
  onUnauthorized: () => void;
}): React.ReactElement {
  const { theme } = useTheme();
  const [graph, setGraph] = useState<RepositoryGraphT | null>(null);
  const [loading, setLoading] = useState(true);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const mounted = useRef(true);

  const handleError = useCallback(
    (reason: unknown) => {
      if (reason instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    },
    [onUnauthorized],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadRepositoryGraph(projectId);
      if (!mounted.current) return;
      setGraph(next);
      setActiveQuery(null);
      setSelectedId(null);
    } catch (reason) {
      if (mounted.current) handleError(reason);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [handleError, projectId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const build = useCallback(async () => {
    setBuilding(true);
    setError(null);
    setActiveQuery(null);
    try {
      const started = await startRepositoryGraphBuild(projectId);
      while (mounted.current) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1_500));
        const result = await pollRepositoryGraphBuild(projectId, started.request_id);
        if (result.pending) continue;
        if (mounted.current) {
          setGraph(result.graph);
          setSelectedId(null);
        }
        break;
      }
    } catch (reason) {
      if (mounted.current) handleError(reason);
    } finally {
      if (mounted.current) setBuilding(false);
    }
  }, [handleError, projectId]);

  const search = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      const normalized = query.trim();
      if (!normalized || building) return;
      setLoading(true);
      setError(null);
      try {
        const next = await queryRepositoryGraph(projectId, normalized);
        if (!mounted.current) return;
        setGraph(next);
        setActiveQuery(normalized);
        setSelectedId(next.nodes[0]?.id ?? null);
      } catch (reason) {
        if (mounted.current) handleError(reason);
      } finally {
        if (mounted.current) setLoading(false);
      }
    },
    [building, handleError, projectId, query],
  );

  const positions = useMemo(() => layout(graph?.nodes ?? []), [graph?.nodes]);
  const flowNodes = useMemo<Node[]>(
    () =>
      (graph?.nodes ?? []).map((node) => {
        const color = communityColor(node.community);
        const selected = node.id === selectedId;
        return {
          id: node.id,
          position: positions.get(node.id) ?? { x: 0, y: 0 },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          draggable: false,
          selectable: true,
          style: {
            width: node.degree >= 10 ? 196 : 174,
            padding: "10px 12px",
            borderRadius: 12,
            borderStyle: "solid",
            borderTopWidth: selected ? 2 : 1,
            borderRightWidth: selected ? 2 : 1,
            borderBottomWidth: selected ? 2 : 1,
            borderLeftWidth: 5,
            borderTopColor: selected ? color : `${color}66`,
            borderRightColor: selected ? color : `${color}66`,
            borderBottomColor: selected ? color : `${color}66`,
            borderLeftColor: color,
            background: theme === "light" ? "#ffffff" : "#171b25",
            color: theme === "light" ? "#182033" : "#f1f4fb",
            boxShadow: selected
              ? `0 0 0 5px ${color}20, 0 14px 34px rgba(22, 30, 52, .18)`
              : "0 8px 24px rgba(22, 30, 52, .10)",
            fontSize: 12,
          },
          data: {
            label: (
              <div className="repository-graph-node-label">
                <strong title={node.label}>{node.label}</strong>
                <span>{node.file_type ?? node.source_file ?? "symbol"}</span>
                <small>{node.degree} connections</small>
              </div>
            ),
          },
        };
      }),
    [graph?.nodes, positions, selectedId, theme],
  );
  const flowEdges = useMemo<Edge[]>(
    () =>
      (graph?.edges ?? []).map((edge) => {
        const highlighted = edge.source === selectedId || edge.target === selectedId;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
          animated: highlighted,
          label: highlighted ? edge.relation : undefined,
          style: {
            stroke: highlighted ? "#3159d5" : theme === "light" ? "#a6afc3" : "#58627b",
            strokeWidth: highlighted ? 2.2 : 1.2,
          },
          labelStyle: {
            fill: theme === "light" ? "#3c4760" : "#c6cee0",
            fontSize: 10,
          },
        };
      }),
    [graph?.edges, selectedId, theme],
  );

  const selected = graph?.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedConnections = useMemo(
    () =>
      (graph?.edges ?? [])
        .filter((edge) => edge.source === selectedId || edge.target === selectedId)
        .slice(0, 24),
    [graph?.edges, selectedId],
  );
  const labels = useMemo(
    () => new Map((graph?.nodes ?? []).map((node) => [node.id, node.label])),
    [graph?.nodes],
  );

  return (
    <section className="repository-graph" aria-labelledby="repository-graph-title">
      <header className="repository-graph-header">
        <div>
          <div className="eyebrow">Graphify · local code map</div>
          <h2 id="repository-graph-title">Repository map</h2>
          <p>
            Explore symbols, files, and their real code relationships. Indexing runs privately on
            the execution computer.
          </p>
        </div>
        <div className="repository-graph-header-actions">
          {graph ? (
            <Badge
              tone={graph.state === "ready" ? "success" : graph.state === "stale" ? "warn" : "info"}
            >
              {graphStateLabel(graph.state)}
            </Badge>
          ) : null}
          <Button variant="primary" disabled={building} onClick={() => void build()}>
            {building
              ? "Building with Graphify…"
              : graph?.state === "ready"
                ? "Refresh map"
                : "Build map"}
          </Button>
        </div>
      </header>

      {error ? <div className="repository-graph-error">{error}</div> : null}

      {graph && (graph.state === "ready" || graph.state === "stale") ? (
        <>
          <div className="repository-graph-toolbar">
            <form onSubmit={(event) => void search(event)}>
              <label htmlFor="repository-graph-search">
                Find a file, class, function, or symbol
              </label>
              <div>
                <input
                  id="repository-graph-search"
                  type="search"
                  value={query}
                  placeholder="e.g. WorkspaceRegistry or authentication"
                  onChange={(event) => setQuery(event.target.value)}
                />
                <Button type="submit" disabled={!query.trim() || loading || building}>
                  Search map
                </Button>
                {activeQuery ? (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      setQuery("");
                      void load();
                    }}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
            </form>
            <div className="repository-graph-stats" aria-label="Graph statistics">
              <span>
                <strong>{graph.node_count.toLocaleString()}</strong> symbols
              </span>
              <span>
                <strong>{graph.edge_count.toLocaleString()}</strong> relationships
              </span>
              <span>
                <strong>{graph.community_count.toLocaleString()}</strong> communities
              </span>
              <span>
                <strong>{shortRevision(graph.indexed_head)}</strong> indexed
              </span>
            </div>
          </div>

          {graph.state === "stale" ? (
            <div className="repository-graph-notice">
              The repository changed after this map was built. You can explore it now or refresh it.
            </div>
          ) : null}
          {activeQuery ? (
            <div className="repository-graph-query-summary">
              Showing the neighborhood around “{activeQuery}” · {graph.nodes.length} visible symbols
            </div>
          ) : graph.truncated ? (
            <div className="repository-graph-query-summary">
              Showing the most connected areas. Search to open a focused neighborhood elsewhere.
            </div>
          ) : null}

          <div className={`repository-graph-workspace${selected ? " has-inspector" : ""}`}>
            <div className="repository-graph-canvas" data-testid="repository-graph-canvas">
              {loading ? (
                <div className="repository-graph-loading">
                  <Spinner label="Searching repository map…" />
                </div>
              ) : graph.nodes.length === 0 ? (
                <div className="repository-graph-empty">
                  <strong>No matching symbols</strong>
                  <p>Try a filename, class, function, or shorter phrase.</p>
                </div>
              ) : (
                <ReactFlow
                  key={`${graph.indexed_at ?? "map"}:${graph.query ?? "overview"}`}
                  nodes={flowNodes}
                  edges={flowEdges}
                  nodesConnectable={false}
                  nodesDraggable={false}
                  elementsSelectable
                  fitView
                  fitViewOptions={{ padding: 0.22, maxZoom: 1.15 }}
                  minZoom={0.08}
                  maxZoom={1.8}
                  onNodeClick={(_event, node) => setSelectedId(node.id)}
                  onPaneClick={() => setSelectedId(null)}
                >
                  <Background color={theme === "light" ? "#d9dfeb" : "#30384c"} gap={28} size={1} />
                  <MiniMap
                    pannable
                    zoomable
                    nodeColor={(node) =>
                      communityColor(graph.nodes.find((item) => item.id === node.id)?.community)
                    }
                    maskColor={theme === "light" ? "rgba(241,244,250,.76)" : "rgba(13,17,27,.72)"}
                  />
                  <Controls showInteractive={false} />
                </ReactFlow>
              )}
            </div>

            {selected ? (
              <aside className="repository-graph-inspector" aria-label="Selected symbol details">
                <div className="repository-graph-inspector-head">
                  <div>
                    <span>{selected.file_type ?? "Symbol"}</span>
                    <h3>{selected.label}</h3>
                  </div>
                  <button
                    type="button"
                    aria-label="Close symbol details"
                    onClick={() => setSelectedId(null)}
                  >
                    ×
                  </button>
                </div>
                {selected.source_file ? (
                  <div className="repository-graph-source">
                    <span>Source</span>
                    <strong>
                      {selected.source_file}
                      {selected.source_location ? `:${selected.source_location}` : ""}
                    </strong>
                  </div>
                ) : null}
                <dl>
                  <div>
                    <dt>Community</dt>
                    <dd>{selected.community_label ?? selected.community ?? "Unassigned"}</dd>
                  </div>
                  <div>
                    <dt>Connections</dt>
                    <dd>{selected.degree}</dd>
                  </div>
                </dl>
                <div className="repository-graph-relations">
                  <h4>Visible relationships</h4>
                  {selectedConnections.length ? (
                    <ul>
                      {selectedConnections.map((edge: RepositoryGraphEdgeT) => {
                        const outbound = edge.source === selected.id;
                        const otherId = outbound ? edge.target : edge.source;
                        return (
                          <li key={edge.id}>
                            <button type="button" onClick={() => setSelectedId(otherId)}>
                              <span>{outbound ? edge.relation : `is ${edge.relation} by`}</span>
                              <strong>{labels.get(otherId) ?? otherId}</strong>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : (
                    <p>No relationships are visible in this focused view.</p>
                  )}
                </div>
              </aside>
            ) : null}
          </div>
        </>
      ) : loading && !graph ? (
        <div className="repository-graph-initial">
          <Spinner label="Loading repository map…" />
        </div>
      ) : graph ? (
        <div className="repository-graph-onboarding">
          <div className="repository-graph-mark" aria-hidden="true">
            ⌘
          </div>
          <h3>
            {graph.state === "unavailable"
              ? "Graphify needs a local runtime"
              : graph.state === "failed"
                ? "Rebuild the repository map"
                : "Build the repository map"}
          </h3>
          <p>{graph.message}</p>
          {graph.state === "unavailable" ? (
            <small>Install uv or Graphify on the execution computer, then choose Build map.</small>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
