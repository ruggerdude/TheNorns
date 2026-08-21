import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { RepositoryGraphService } from "../dist/repositoryGraph.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "norns-graphify-test-"));
  const repositoryPath = join(root, "repository");
  const dataDirectory = join(root, "agent-data");
  mkdirSync(repositoryPath, { recursive: true });
  writeFileSync(join(repositoryPath, "service.ts"), "export function run() { return true; }\n");
  execFileSync("git", ["init", "-q", repositoryPath]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.name", "Norns Test"]);
  execFileSync("git", ["-C", repositoryPath, "config", "user.email", "norns@example.test"]);
  execFileSync("git", ["-C", repositoryPath, "add", "service.ts"]);
  execFileSync("git", ["-C", repositoryPath, "commit", "-qm", "fixture"]);
  return { root, repositoryPath, dataDirectory };
}

test("builds a bounded Graphify view without exposing the local repository path", async () => {
  const { root, repositoryPath, dataDirectory } = fixture();
  try {
    const service = new RepositoryGraphService(dataDirectory, async ({ outputDirectory }) => {
      const graphDirectory = join(outputDirectory, "graphify-out");
      mkdirSync(graphDirectory, { recursive: true });
      writeFileSync(
        join(graphDirectory, "graph.json"),
        JSON.stringify({
          directed: true,
          multigraph: false,
          graph: { community_labels: { 1: "Runtime" } },
          nodes: [
            {
              id: `${repositoryPath}/service.ts::run`,
              label: `${repositoryPath}/service.ts run`,
              file_type: "function",
              source_file: join(repositoryPath, "service.ts"),
              source_location: "L1",
              community: 1,
            },
            {
              id: "/Users/another-person/private.ts::result",
              label: "/Users/another-person/private.ts result",
              file_type: "symbol",
              source_file: join(repositoryPath, "service.ts"),
              source_location: "/Users/another-person/private.ts:L3",
              community: 1,
            },
          ],
          links: [
            {
              source: `${repositoryPath}/service.ts::run`,
              target: "/Users/another-person/private.ts::result",
              relation: "returns",
              confidence: "EXTRACTED",
            },
          ],
        }),
      );
      return { version: "0.9.48" };
    });

    const graph = await service.index("local:repository", repositoryPath);
    assert.equal(graph.state, "ready");
    assert.equal(graph.node_count, 2);
    assert.equal(graph.edge_count, 1);
    assert.equal(graph.community_count, 1);
    assert.equal(graph.nodes[0]?.source_file, "service.ts");
    assert.equal(JSON.stringify(graph).includes(repositoryPath), false);
    assert.equal(JSON.stringify(graph).includes("/Users/another-person"), false);
    assert.equal(
      graph.nodes.some((node) => node.degree === 1),
      true,
    );

    const query = await service.query("local:repository", repositoryPath, "run");
    assert.equal(query.query, "run");
    assert.equal(
      query.nodes.some((node) => node.label.includes("run")),
      true,
    );

    writeFileSync(join(repositoryPath, "service.ts"), "export function run() { return false; }\n");
    const stale = await service.status("local:repository", repositoryPath);
    assert.equal(stale.state, "stale");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
