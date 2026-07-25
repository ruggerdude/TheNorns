import {
  Background,
  type Connection,
  ConnectionLineType,
  Controls,
  type Edge,
  type EdgeTypes,
  type Node,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { OrthogonalEdge } from "./OrthogonalEdge";

const graphEdgeTypes: EdgeTypes = { orthogonal: OrthogonalEdge };

export function GraphCanvas({
  nodes,
  edges,
  editable,
  theme,
  onConnect,
  onEdgesDelete,
  onNodeSelect,
}: {
  nodes: Node[];
  edges: Edge[];
  editable: boolean;
  theme: "light" | "dark";
  onConnect: (connection: Connection) => void;
  onEdgesDelete: (edges: Edge[]) => void;
  onNodeSelect: (id: string) => void;
}) {
  const renderedNodes = nodes.map((node) => ({
    ...node,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
  }));

  return (
    <ReactFlow
      nodes={renderedNodes}
      edges={edges}
      edgeTypes={graphEdgeTypes}
      connectionLineType={ConnectionLineType.SmoothStep}
      onConnect={editable ? onConnect : undefined}
      onEdgesDelete={editable ? onEdgesDelete : undefined}
      onNodeClick={(_event, node) => onNodeSelect(node.id)}
      nodesConnectable={editable}
      fitView
    >
      <Background color={theme === "light" ? "#c5ccd3" : "#353c44"} gap={24} size={1} />
      <Controls />
    </ReactFlow>
  );
}
