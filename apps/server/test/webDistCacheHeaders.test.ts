// POLISH P2: Safari was showing stale content after deploys because BOTH
// index.html and hashed /assets/* files were served with
// `cache-control: public, max-age=0`. That is backwards on both ends:
//   - index.html changes on every deploy without its URL changing, so it
//     must always revalidate (`no-cache`), not merely permit a max-age=0
//     heuristic reuse that Safari sometimes honors from its bfcache/memory
//     cache without revalidating.
//   - Vite content-hashes everything under /assets/*, so those responses are
//     immutable by construction and should never be re-fetched.
// This test boots a real server against a fixture `webDist` directory and
// asserts the exact cache-control value fastify-static's setHeaders callback
// produces for each of those cases, plus a non-hashed static file and the SPA
// fallback route (which serves index.html via reply.sendFile()).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";

let server: NornsServer | null = null;
let webDist: string | null = null;

afterEach(async () => {
  await server?.app.close();
  server = null;
  if (webDist) {
    rmSync(webDist, { recursive: true, force: true });
    webDist = null;
  }
});

function makeWebDistFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "norns-webdist-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>fixture</title>");
  writeFileSync(join(dir, "favicon.ico"), "fake-icon-bytes");
  const assetsDir = join(dir, "assets");
  mkdirSync(assetsDir);
  writeFileSync(join(assetsDir, "index-C5YKz2ZJ.js"), "console.log('fixture bundle');");
  return dir;
}

describe("POLISH P2 — webDist cache-control headers", () => {
  it("revalidates index.html, caches hashed assets for a year, and gives other static files a short max-age", async () => {
    webDist = makeWebDistFixture();
    server = await buildServer({
      stores: new RelayStores(),
      users: new UserStore(),
      webDist,
    });

    const root = await server.app.inject({ method: "GET", url: "/" });
    expect(root.statusCode).toBe(200);
    expect(root.headers["cache-control"]).toBe("no-cache");

    const deepRoute = await server.app.inject({ method: "GET", url: "/projects/abc123/board" });
    expect(deepRoute.statusCode).toBe(200);
    expect(deepRoute.headers["cache-control"]).toBe("no-cache");

    const asset = await server.app.inject({ method: "GET", url: "/assets/index-C5YKz2ZJ.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const favicon = await server.app.inject({ method: "GET", url: "/favicon.ico" });
    expect(favicon.statusCode).toBe(200);
    expect(favicon.headers["cache-control"]).toBe("public, max-age=3600");
  });
});
