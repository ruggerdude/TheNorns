// FRONT DOOR P4 (D3): HTTP surface for image attachments — auth, mime and
// size caps, dedupe, per-objective and per-project quotas, delete, and the
// bytes-serving GET. Mirrors the planningRunRoutes.test.ts harness (buildServer
// over a PGlite transaction runner).
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGliteTransactionRunner } from "../src/persistence/v2/database.js";
import { type V2MigrationDatabase, runCurrentV2Migrations } from "../src/persistence/v2/migrate.js";
import { ProjectStore } from "../src/projects/store.js";
import { type NornsServer, buildServer } from "../src/server.js";
import { RelayStores } from "../src/stores.js";
import { UserStore } from "../src/users/store.js";
import { testAdminToken } from "./helpers.js";

// ---- tiny valid image builders (header-only; the sniffer reads headers) -----
function pngBase64(width = 1, height = 1): string {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLength = Buffer.from([0, 0, 0, 13]);
  const ihdr = Buffer.from("IHDR", "ascii");
  const w = Buffer.alloc(4);
  w.writeUInt32BE(width);
  const h = Buffer.alloc(4);
  h.writeUInt32BE(height);
  const trailer = Buffer.from([8, 6, 0, 0, 0, 0, 0, 0, 0]); // depth,color,comp,filter,interlace,CRC
  return Buffer.concat([signature, ihdrLength, ihdr, w, h, trailer]).toString("base64");
}

function gifBase64(width = 1, height = 1): string {
  const header = Buffer.from("GIF89a", "ascii");
  const dims = Buffer.alloc(4);
  dims.writeUInt16LE(width, 0);
  dims.writeUInt16LE(height, 2);
  return Buffer.concat([header, dims, Buffer.from([0x80, 0, 0])]).toString("base64");
}

/** A valid PNG header padded past the 3 MB per-image cap. */
function oversizePngBase64(): string {
  const header = Buffer.from(pngBase64(1, 1), "base64");
  const filler = Buffer.alloc(3 * 1024 * 1024 + 16, 0x7a);
  return Buffer.concat([header, filler]).toString("base64");
}

interface InjectedResponse {
  statusCode: number;
  json: () => unknown;
  headers: Record<string, string | string[] | undefined>;
  rawPayload: Buffer;
}

describe.sequential("attachment HTTP API (FRONT DOOR P4)", () => {
  let pg: PGlite;
  let server: NornsServer;
  let token: string;
  let projectId: string;

  async function inject(
    method: "GET" | "POST" | "DELETE",
    url: string,
    body?: unknown,
    withAuth = true,
  ): Promise<InjectedResponse> {
    const response = await server.app.inject({
      method,
      url,
      headers: withAuth ? { authorization: `Bearer ${token}` } : {},
      ...(body !== undefined ? { payload: body as Record<string, unknown> } : {}),
    });
    return response as unknown as InjectedResponse;
  }

  function post(url: string, body: unknown, withAuth = true): Promise<InjectedResponse> {
    return inject("POST", url, body, withAuth);
  }

  /** Seed N live attachments (distinct content) directly, bypassing the route,
   *  to exercise aggregate caps cheaply. */
  async function seedAttachments(count: number, purpose: string, bytes: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      // Valid lowercase-hex sha256 (CHECK ^[0-9a-f]{64}$): zero-padded decimal
      // digits are hex-valid, and unique per row within a single seeded purpose.
      const sha = `${purpose.length}${i}`.padStart(64, "0");
      await pg.query("INSERT INTO attachment_blobs (sha256, content) VALUES ($1, $2)", [
        sha,
        Buffer.from([0x01]),
      ]);
      await pg.query(
        `INSERT INTO attachments (id, project_id, sha256, mime, bytes, purpose, created_at)
         VALUES ($1, $2, $3, 'image/png', $4, $5, now())`,
        [`seed_${purpose}_${i}`, projectId, sha, bytes, purpose],
      );
    }
  }

  beforeEach(async () => {
    pg = new PGlite();
    await pg.exec("CREATE ROLE norns_app NOLOGIN");
    await runCurrentV2Migrations(pg as unknown as V2MigrationDatabase);
    projectId = "project-att-1";
    await pg.exec(`
      INSERT INTO projects (
        id, name, status, assignment_policy_ref, verification_policy_ref, budget_policy_ref
      ) VALUES ('${projectId}', 'Att project', 'active', 'assignment/default', 'verification/default', 'budget/default');
    `);
    const transactions = new PGliteTransactionRunner(pg);
    const users = new UserStore();
    token = testAdminToken(users);
    server = await buildServer({
      stores: new RelayStores(),
      users,
      projects: new ProjectStore(),
      attachments: { transactions },
    });
  }, 30_000);

  afterEach(async () => {
    await server.app.close();
    if (!pg.closed) await pg.close();
  });

  const base = () => `/api/v2/projects/${projectId}/attachments`;

  it("rejects unauthenticated requests on every verb", async () => {
    expect((await post(base(), { mime: "image/png", base64: pngBase64() }, false)).statusCode).toBe(
      401,
    );
    expect((await inject("GET", `${base()}/whatever`, undefined, false)).statusCode).toBe(401);
    expect((await inject("DELETE", `${base()}/whatever`, undefined, false)).statusCode).toBe(401);
  });

  it("uploads an image and returns its metadata", async () => {
    const res = await post(base(), { mime: "image/png", base64: pngBase64(4, 3) });
    expect(res.statusCode).toBe(201);
    const dto = res.json() as Record<string, unknown>;
    expect(dto).toMatchObject({
      project_id: projectId,
      mime: "image/png",
      width: 4,
      height: 3,
      purpose: "objective",
    });
    expect(typeof dto.id).toBe("string");
    expect(dto.bytes).toBeGreaterThan(0);
  });

  it("rejects a disallowed media type with 415", async () => {
    const res = await post(base(), { mime: "image/svg+xml", base64: pngBase64() });
    expect(res.statusCode).toBe(415);
    expect(res.json()).toMatchObject({ error: "unsupported_media_type" });
  });

  it("rejects bytes whose format contradicts the declared mime with 400", async () => {
    // Declared png, but the payload is actually a gif.
    const res = await post(base(), { mime: "image/png", base64: gifBase64() });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_image" });
  });

  it("rejects an image over the 3 MB per-image cap with 413", async () => {
    const res = await post(base(), { mime: "image/png", base64: oversizePngBase64() });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ error: "payload_too_large" });
  });

  it("404s an upload to an unknown project", async () => {
    const res = await post("/api/v2/projects/no-such/attachments", {
      mime: "image/png",
      base64: pngBase64(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "project_not_found" });
  });

  it("dedupes identical content within a project, and distinguishes different content", async () => {
    const first = await post(base(), { mime: "image/png", base64: pngBase64(1, 1) });
    const dup = await post(base(), { mime: "image/png", base64: pngBase64(1, 1) });
    const other = await post(base(), { mime: "image/png", base64: pngBase64(2, 2) });
    const firstId = (first.json() as { id: string }).id;
    const dupId = (dup.json() as { id: string }).id;
    const otherId = (other.json() as { id: string }).id;
    expect(dupId).toBe(firstId);
    expect(otherId).not.toBe(firstId);
  });

  it("serves the raw bytes with the correct content-type", async () => {
    const created = await post(base(), { mime: "image/gif", base64: gifBase64(6, 5) });
    const id = (created.json() as { id: string }).id;
    const res = await inject("GET", `${base()}/${id}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("image/gif");
    expect(res.rawPayload.equals(Buffer.from(gifBase64(6, 5), "base64"))).toBe(true);
  });

  it("soft-deletes and then 404s the image and a repeat delete", async () => {
    const created = await post(base(), { mime: "image/png", base64: pngBase64(3, 3) });
    const id = (created.json() as { id: string }).id;
    const del = await inject("DELETE", `${base()}/${id}`);
    expect(del.statusCode).toBe(204);
    expect((await inject("GET", `${base()}/${id}`)).statusCode).toBe(404);
    const repeat = await inject("DELETE", `${base()}/${id}`);
    expect(repeat.statusCode).toBe(404);
    expect(repeat.json()).toMatchObject({ error: "attachment_not_found" });
  });

  it("404s a delete/get of an unknown attachment", async () => {
    expect((await inject("GET", `${base()}/att_missing`)).statusCode).toBe(404);
    expect((await inject("DELETE", `${base()}/att_missing`)).statusCode).toBe(404);
  });

  it("enforces the 8-per-objective cap with 409", async () => {
    await seedAttachments(8, "objective", 100);
    const res = await post(base(), { mime: "image/png", base64: pngBase64(9, 9) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "objective_limit" });
  });

  it("enforces the 40 MB per-project quota with 409", async () => {
    // 14 * 3 MB = 42 MB of live bytes under a non-objective purpose, so the
    // per-objective cap doesn't trip first — only the project quota should.
    await seedAttachments(14, "reference", 3 * 1024 * 1024);
    const res = await post(base(), { mime: "image/png", base64: pngBase64(7, 7) });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "project_quota" });
  });
});
