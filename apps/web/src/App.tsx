// Phase 4 graph editor: React Flow rendering of the workflow graph with
// editing (edges with cycle rejection, node deletion with re-parent/cascade
// confirmation), Auto Allocate under three strategies, per-node overrides,
// cost preview, and allocation approval — all through the server API.
import {
  Background,
  type Connection,
  Controls,
  type Edge,
  type Node,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";

const TOKEN = new URLSearchParams(window.location.search).get("token") ?? "dev-token";

interface Assignment {
  provider: string;
  model: string;
  worker_count: number;
  reviewer_model: string;
  budget_usd: number;
  rationale: string;
  source: "auto" | "override";
}

interface GraphNodeDto {
  id: string;
  title: string;
  complexity: string;
  risk: string;
  dependencies: string[];
  assignment: Assignment | null;
}

interface GraphDto {
  version: number;
  nodes: GraphNodeDto[];
  cost: { total_usd: number; unallocated: string[] };
}

async function api(path: string, method = "GET", body?: unknown): Promise<GraphDto> {
  const res = await fetch(path, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await res.json()) as GraphDto & { message?: string };
  if (!res.ok) throw new Error(json.message ?? `request failed: ${res.status}`);
  return json;
}

/** Layered layout: x by longest-path depth, y by index within the layer. */
function layout(nodes: GraphNodeDto[]): Map<string, { x: number; y: number }> {
  const depths = new Map<string, number>();
  const depthOf = (id: string, seen: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const node = nodes.find((n) => n.id === id);
    const depth =
      !node || node.dependencies.length === 0
        ? 0
        : Math.max(...node.dependencies.map((dep) => depthOf(dep, seen))) + 1;
    depths.set(id, depth);
    return depth;
  };
  for (const node of nodes) depthOf(node.id, new Set());
  const perLayer = new Map<number, number>();
  const positions = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    const depth = depths.get(node.id) ?? 0;
    const index = perLayer.get(depth) ?? 0;
    perLayer.set(depth, index + 1);
    positions.set(node.id, { x: depth * 250 + 20, y: index * 110 + 20 });
  }
  return positions;
}

export function App(): React.ReactElement {
  const [graph, setGraph] = useState<GraphDto | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [strategy, setStrategy] = useState("balanced");
  const [error, setError] = useState<string | null>(null);
  const [approvalHash, setApprovalHash] = useState<string | null>(null);
  const [overrideModel, setOverrideModel] = useState("");
  const [overrideBudget, setOverrideBudget] = useState("");

  const call = useCallback(async (path: string, method = "GET", body?: unknown) => {
    try {
      setError(null);
      const next = await api(path, method, body);
      setGraph(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void call("/api/graph");
  }, [call]);

  const { nodes, edges } = useMemo(() => {
    if (!graph) return { nodes: [] as Node[], edges: [] as Edge[] };
    const positions = layout(graph.nodes);
    const flowNodes: Node[] = graph.nodes.map((node) => ({
      id: node.id,
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      style: {
        border: node.id === selected ? "2px solid #d97706" : "1px solid #666",
        borderRadius: 8,
        padding: 6,
        width: 210,
        fontSize: 12,
        background: node.assignment ? "#ecfdf5" : "#fff",
      },
      data: {
        label: (
          <div>
            <strong>{node.id}</strong> ({node.complexity}/{node.risk})
            {node.assignment ? (
              <div>
                {node.assignment.model} · {node.assignment.worker_count}w · $
                {node.assignment.budget_usd}
                {node.assignment.source === "override" ? " · OVERRIDE" : ""}
              </div>
            ) : (
              <div style={{ color: "#999" }}>unallocated</div>
            )}
          </div>
        ),
      },
    }));
    const flowEdges: Edge[] = graph.nodes.flatMap((node) =>
      node.dependencies.map((dep) => ({
        id: `${dep}->${node.id}`,
        source: dep,
        target: node.id,
        markerEnd: "arrowclosed" as const,
      })),
    );
    return { nodes: flowNodes, edges: flowEdges };
  }, [graph, selected]);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        void call("/api/graph/edges", "POST", { from: connection.source, to: connection.target });
      }
    },
    [call],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      for (const edge of deleted) {
        void call("/api/graph/edges", "DELETE", { from: edge.source, to: edge.target });
      }
    },
    [call],
  );

  const selectedNode = graph?.nodes.find((n) => n.id === selected) ?? null;

  return (
    <div style={{ display: "flex", height: "100vh", fontFamily: "ui-monospace, monospace" }}>
      <div style={{ flex: 1 }} data-testid="graph-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onConnect={onConnect}
          onEdgesDelete={onEdgesDelete}
          onNodeClick={(_event, node) => setSelected(node.id)}
          fitView
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>
      <div style={{ width: 320, padding: 16, borderLeft: "1px solid #ddd", overflow: "auto" }}>
        <h2 style={{ marginTop: 0 }}>TheNorns graph</h2>
        <div data-testid="graph-version">graph v{graph?.version ?? "…"}</div>
        <div data-testid="cost-total">
          cost preview: ${graph?.cost.total_usd ?? 0}
          {graph && graph.cost.unallocated.length > 0
            ? ` (${graph.cost.unallocated.length} unallocated)`
            : ""}
        </div>
        {error ? (
          <div data-testid="error" style={{ color: "#b91c1c", margin: "8px 0" }}>
            {error}
          </div>
        ) : null}
        <h3>Auto Allocate</h3>
        <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
          <option value="quality">quality</option>
          <option value="balanced">balanced</option>
          <option value="cost">cost</option>
        </select>{" "}
        <button
          type="button"
          onClick={() => void call("/api/graph/allocate", "POST", { strategy })}
        >
          Auto Allocate
        </button>
        <h3>Approval</h3>
        <button
          type="button"
          onClick={async () => {
            try {
              setError(null);
              const res = await fetch("/api/graph/approve-allocation", {
                method: "POST",
                headers: { authorization: `Bearer ${TOKEN}` },
              });
              const body = (await res.json()) as { content_hash?: string; message?: string };
              if (!res.ok) throw new Error(body.message ?? "approval refused");
              setApprovalHash(body.content_hash ?? null);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            }
          }}
        >
          Approve allocation (budget)
        </button>
        {approvalHash ? (
          <div data-testid="approval-hash" style={{ wordBreak: "break-all", color: "#047857" }}>
            approved: {approvalHash}
          </div>
        ) : null}
        {selectedNode ? (
          <div data-testid="node-panel">
            <h3>{selectedNode.id}</h3>
            <div>{selectedNode.title}</div>
            <div>
              deps: {selectedNode.dependencies.join(", ") || "none"} · {selectedNode.complexity}/
              {selectedNode.risk}
            </div>
            {selectedNode.assignment ? (
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>
                {JSON.stringify(selectedNode.assignment, null, 1)}
              </pre>
            ) : null}
            <h4>Override</h4>
            <input
              placeholder="model"
              value={overrideModel}
              onChange={(e) => setOverrideModel(e.target.value)}
              style={{ width: "100%" }}
            />
            <input
              placeholder="budget usd"
              value={overrideBudget}
              onChange={(e) => setOverrideBudget(e.target.value)}
              style={{ width: "100%", marginTop: 4 }}
            />
            <button
              type="button"
              style={{ marginTop: 4 }}
              onClick={() => {
                const patch: Record<string, unknown> = {};
                if (overrideModel) patch.model = overrideModel;
                if (overrideBudget) patch.budget_usd = Number(overrideBudget);
                void call(`/api/graph/nodes/${selectedNode.id}/assignment`, "POST", patch);
              }}
            >
              Apply override
            </button>
            <h4>Delete node</h4>
            <button
              type="button"
              onClick={() =>
                void call(`/api/graph/nodes/${selectedNode.id}?mode=reparent`, "DELETE")
              }
            >
              Delete (re-parent)
            </button>{" "}
            <button
              type="button"
              onClick={() =>
                void call(`/api/graph/nodes/${selectedNode.id}?mode=cascade`, "DELETE")
              }
            >
              Delete (cascade)
            </button>
          </div>
        ) : (
          <p style={{ color: "#666" }}>Click a node to inspect, override, or delete it.</p>
        )}
      </div>
    </div>
  );
}
