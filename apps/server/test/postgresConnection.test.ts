import { describe, expect, it } from "vitest";
import {
  assertRestrictedRuntimeDatabase,
  isPrivatePostgresHostname,
  postgresPoolConfig,
} from "../src/persistence/postgresConnection.js";

describe("PostgreSQL connection security", () => {
  it("classifies only exact private hostnames and validates public TLS", () => {
    expect(isPrivatePostgresHostname("localhost")).toBe(true);
    expect(isPrivatePostgresHostname("db.railway.internal")).toBe(true);
    expect(isPrivatePostgresHostname("db.railway.internal.example.com")).toBe(false);

    expect(
      postgresPoolConfig("postgresql://localhost-in-password@public.example.com/norns").ssl,
    ).toEqual({ rejectUnauthorized: true });
    expect(
      postgresPoolConfig("postgresql://user:pass@db.railway.internal/norns").ssl,
    ).toBeUndefined();
    expect(postgresPoolConfig("postgresql://user:pass@127.0.0.1:5432/norns").ssl).toBeUndefined();
  });

  it("rejects archive keys in the ordinary application environment", async () => {
    await expect(
      assertRestrictedRuntimeDatabase(
        {
          query: async () => ({ rows: [] }),
        } as never,
        { NORNS_ARCHIVE_KEY: "secret" },
      ),
    ).rejects.toMatchObject({
      code: "archive_key_in_runtime",
    });
  });

  it("rejects privileged logins and proves archive ciphertext is denied", async () => {
    let calls = 0;
    const privileged = {
      query: async () => {
        calls += 1;
        if (calls === 1) return { rows: [{ relation: "legacy_snapshot_archives" }] };
        return {
          rows: [
            {
              rolname: "owner",
              rolsuper: true,
              rolcreatedb: false,
              rolcreaterole: false,
              rolreplication: false,
              rolbypassrls: false,
              can_set_runtime_role: true,
            },
          ],
        };
      },
    };
    await expect(assertRestrictedRuntimeDatabase(privileged as never, {})).rejects.toMatchObject({
      code: "privileged_runtime_login",
    });

    calls = 0;
    const restricted = {
      query: async () => {
        calls += 1;
        if (calls === 1) return { rows: [{ relation: "legacy_snapshot_archives" }] };
        if (calls === 2) {
          return {
            rows: [
              {
                rolname: "norns_runtime",
                rolsuper: false,
                rolcreatedb: false,
                rolcreaterole: false,
                rolreplication: false,
                rolbypassrls: false,
                can_set_runtime_role: true,
              },
            ],
          };
        }
        throw Object.assign(new Error("permission denied for table legacy_snapshot_archives"), {
          code: "42501",
        });
      },
    };
    await expect(assertRestrictedRuntimeDatabase(restricted as never, {})).resolves.toBeUndefined();
  });
});
