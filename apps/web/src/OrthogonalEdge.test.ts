import { describe, expect, it } from "vitest";
import {
  type RouteObstacle,
  routeOrthogonalPoints,
  segmentIntersectsObstacle,
} from "./OrthogonalEdge";

function routeCrosses(points: Array<{ x: number; y: number }>, obstacle: RouteObstacle): boolean {
  return points.slice(1).some((point, index) => {
    const previous = points[index];
    return previous ? segmentIntersectsObstacle(previous, point, obstacle) : false;
  });
}

function isOrthogonal(points: Array<{ x: number; y: number }>): boolean {
  return points.every((point, index) => {
    const previous = points[index - 1];
    return !previous || point.x === previous.x || point.y === previous.y;
  });
}

describe("orthogonal flow-chart routing", () => {
  it("keeps a clear dependency on one horizontal line", () => {
    expect(
      routeOrthogonalPoints({
        source: { x: 210, y: 60 },
        target: { x: 300, y: 60 },
        sourceId: "source",
        targetId: "target",
        obstacles: [],
      }),
    ).toEqual([
      { x: 210, y: 60 },
      { x: 300, y: 60 },
    ]);
  });

  it("routes around a box that blocks the direct path", () => {
    const blocker = { id: "blocker", x: 235, y: 20, width: 90, height: 80 };
    const points = routeOrthogonalPoints({
      source: { x: 210, y: 60 },
      target: { x: 360, y: 60 },
      sourceId: "source",
      targetId: "target",
      obstacles: [blocker],
    });
    expect(points.length).toBeGreaterThan(2);
    expect(routeCrosses(points, blocker)).toBe(false);
    expect(isOrthogonal(points)).toBe(true);
  });

  it("uses a clear routing lane when several boxes occupy the center", () => {
    const blockers = [
      { id: "upper", x: 230, y: 0, width: 110, height: 85 },
      { id: "lower", x: 230, y: 105, width: 110, height: 85 },
    ];
    const points = routeOrthogonalPoints({
      source: { x: 210, y: 95 },
      target: { x: 370, y: 95 },
      sourceId: "source",
      targetId: "target",
      obstacles: blockers,
    });
    expect(blockers.every((blocker) => !routeCrosses(points, blocker))).toBe(true);
  });
});
