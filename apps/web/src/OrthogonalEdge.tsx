import { BaseEdge, type EdgeProps, type Node, useStore } from "@xyflow/react";

export interface RoutePoint {
  x: number;
  y: number;
}

export interface RouteObstacle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RouteOptions {
  source: RoutePoint;
  target: RoutePoint;
  sourceId: string;
  targetId: string;
  obstacles: RouteObstacle[];
  clearance?: number;
}

const DEFAULT_NODE_WIDTH = 210;
const DEFAULT_NODE_HEIGHT = 84;
const DEFAULT_CLEARANCE = 18;
const CORNER_RADIUS = 10;

function inflateObstacle(obstacle: RouteObstacle, clearance: number): RouteObstacle {
  return {
    ...obstacle,
    x: obstacle.x - clearance,
    y: obstacle.y - clearance,
    width: obstacle.width + clearance * 2,
    height: obstacle.height + clearance * 2,
  };
}

export function segmentIntersectsObstacle(
  start: RoutePoint,
  end: RoutePoint,
  obstacle: RouteObstacle,
): boolean {
  const left = obstacle.x;
  const right = obstacle.x + obstacle.width;
  const top = obstacle.y;
  const bottom = obstacle.y + obstacle.height;
  if (start.y === end.y) {
    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    return start.y > top && start.y < bottom && maxX > left && minX < right;
  }
  if (start.x === end.x) {
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);
    return start.x > left && start.x < right && maxY > top && minY < bottom;
  }
  return true;
}

function routeIsClear(points: RoutePoint[], obstacles: RouteObstacle[]): boolean {
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    if (!start || !end) return false;
    if (obstacles.some((obstacle) => segmentIntersectsObstacle(start, end, obstacle))) {
      return false;
    }
  }
  return true;
}

function simplifyPoints(points: RoutePoint[]): RoutePoint[] {
  const result: RoutePoint[] = [];
  for (const point of points) {
    const previous = result.at(-1);
    if (previous?.x === point.x && previous.y === point.y) continue;
    const beforePrevious = result.at(-2);
    if (
      beforePrevious &&
      previous &&
      ((beforePrevious.x === previous.x && previous.x === point.x) ||
        (beforePrevious.y === previous.y && previous.y === point.y))
    ) {
      result[result.length - 1] = point;
    } else {
      result.push(point);
    }
  }
  return result;
}

/**
 * Produces the Manhattan-style connector used by conventional flow charts.
 * The short path is preferred; when it would cross a box, the connector is
 * moved into the nearest clear horizontal routing lane.
 */
export function routeOrthogonalPoints({
  source,
  target,
  sourceId,
  targetId,
  obstacles,
  clearance = DEFAULT_CLEARANCE,
}: RouteOptions): RoutePoint[] {
  const inflated = obstacles.map((obstacle) => inflateObstacle(obstacle, clearance));
  const otherObstacles = inflated.filter(
    (obstacle) => obstacle.id !== sourceId && obstacle.id !== targetId,
  );

  const direct = [source, target];
  if (source.y === target.y && routeIsClear(direct, otherObstacles)) return direct;

  const horizontalDistance = Math.abs(target.x - source.x);
  const stub = Math.max(10, Math.min(clearance, horizontalDistance / 4));
  const sourceExit = source.x + stub;
  const targetEntry = target.x - stub;
  const minimumX = Math.min(source.x, target.x);
  const maximumX = Math.max(source.x, target.x);
  const bendCandidates = [
    (source.x + target.x) / 2,
    sourceExit,
    targetEntry,
    ...otherObstacles.flatMap((obstacle) => [
      obstacle.x - clearance,
      obstacle.x + obstacle.width + clearance,
    ]),
  ]
    .filter((x) => x > minimumX && x < maximumX)
    .sort(
      (a, b) => Math.abs(a - (source.x + target.x) / 2) - Math.abs(b - (source.x + target.x) / 2),
    );

  for (const bendX of bendCandidates) {
    const dogleg = simplifyPoints([
      source,
      { x: bendX, y: source.y },
      { x: bendX, y: target.y },
      target,
    ]);
    if (routeIsClear(dogleg, otherObstacles)) return dogleg;
  }

  const centerY = (source.y + target.y) / 2;
  const laneCandidates = [
    ...inflated.flatMap((obstacle) => [
      obstacle.y - clearance,
      obstacle.y + obstacle.height + clearance,
    ]),
    Math.min(source.y, target.y) - clearance * 2,
    Math.max(source.y, target.y) + clearance * 2,
  ].sort((a, b) => Math.abs(a - centerY) - Math.abs(b - centerY));

  for (const laneY of laneCandidates) {
    const laneRoute = simplifyPoints([
      source,
      { x: sourceExit, y: source.y },
      { x: sourceExit, y: laneY },
      { x: targetEntry, y: laneY },
      { x: targetEntry, y: target.y },
      target,
    ]);
    if (routeIsClear(laneRoute, otherObstacles)) return laneRoute;
  }

  const topLane =
    Math.min(source.y, target.y, ...inflated.map((obstacle) => obstacle.y)) - clearance * 2;
  return simplifyPoints([
    source,
    { x: sourceExit, y: source.y },
    { x: sourceExit, y: topLane },
    { x: targetEntry, y: topLane },
    { x: targetEntry, y: target.y },
    target,
  ]);
}

function roundedPath(points: RoutePoint[], radius = CORNER_RADIUS): string {
  const simplified = simplifyPoints(points);
  const first = simplified[0];
  if (!first) return "";
  let path = `M ${first.x} ${first.y}`;
  for (let index = 1; index < simplified.length - 1; index += 1) {
    const previous = simplified[index - 1];
    const corner = simplified[index];
    const next = simplified[index + 1];
    if (!previous || !corner || !next) continue;
    const incoming = Math.hypot(corner.x - previous.x, corner.y - previous.y);
    const outgoing = Math.hypot(next.x - corner.x, next.y - corner.y);
    const cornerRadius = Math.min(radius, incoming / 2, outgoing / 2);
    const beforeCorner = {
      x: corner.x + ((previous.x - corner.x) / incoming) * cornerRadius,
      y: corner.y + ((previous.y - corner.y) / incoming) * cornerRadius,
    };
    const afterCorner = {
      x: corner.x + ((next.x - corner.x) / outgoing) * cornerRadius,
      y: corner.y + ((next.y - corner.y) / outgoing) * cornerRadius,
    };
    path += ` L ${beforeCorner.x} ${beforeCorner.y}`;
    path += ` Q ${corner.x} ${corner.y} ${afterCorner.x} ${afterCorner.y}`;
  }
  const target = simplified.at(-1);
  return `${path} L ${target?.x ?? 0} ${target?.y ?? 0}`;
}

function nodeObstacle(node: Node): RouteObstacle {
  const width =
    node.measured?.width ??
    node.width ??
    (typeof node.style?.width === "number" ? node.style.width : DEFAULT_NODE_WIDTH);
  const height =
    node.measured?.height ??
    node.height ??
    (typeof node.style?.height === "number" ? node.style.height : DEFAULT_NODE_HEIGHT);
  return {
    id: node.id,
    x: node.position.x,
    y: node.position.y,
    width,
    height,
  };
}

export function OrthogonalEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  markerStart,
  style,
  interactionWidth,
}: EdgeProps): React.ReactElement {
  const nodes = useStore((state) => state.nodes);
  const points = routeOrthogonalPoints({
    source: { x: sourceX, y: sourceY },
    target: { x: targetX, y: targetY },
    sourceId: source,
    targetId: target,
    obstacles: nodes.map(nodeObstacle),
  });
  return (
    <BaseEdge
      id={id}
      path={roundedPath(points)}
      markerStart={markerStart}
      markerEnd={markerEnd}
      style={style}
      interactionWidth={interactionWidth}
    />
  );
}
