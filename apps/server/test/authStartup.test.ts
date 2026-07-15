import { describe, expect, it } from "vitest";
import { evaluateAuthStartup } from "../src/startup/authPolicy.js";

describe("production auth startup policy", () => {
  it("keeps development permissive without persistence or a deploy key", () => {
    expect(
      evaluateAuthStartup({
        isProduction: false,
        persistenceConfigured: false,
        persistenceReady: false,
        hasActiveAdmin: false,
        hasDeployToken: false,
      }),
    ).toEqual({ allowed: true, bootstrapRequired: false });
  });

  it("requires configured persistence in production", () => {
    expect(
      evaluateAuthStartup({
        isProduction: true,
        persistenceConfigured: false,
        persistenceReady: false,
        hasActiveAdmin: false,
        hasDeployToken: true,
      }),
    ).toMatchObject({ allowed: false, code: "persistence_required" });
  });

  it("fails closed when configured production persistence is unavailable", () => {
    expect(
      evaluateAuthStartup({
        isProduction: true,
        persistenceConfigured: true,
        persistenceReady: false,
        hasActiveAdmin: true,
        hasDeployToken: false,
      }),
    ).toMatchObject({ allowed: false, code: "persistence_unavailable" });
  });

  it("allows a restored active admin to start without a deploy key", () => {
    expect(
      evaluateAuthStartup({
        isProduction: true,
        persistenceConfigured: true,
        persistenceReady: true,
        hasActiveAdmin: true,
        hasDeployToken: false,
      }),
    ).toEqual({ allowed: true, bootstrapRequired: false });
  });

  it("requires a one-time deploy key when no active admin exists", () => {
    expect(
      evaluateAuthStartup({
        isProduction: true,
        persistenceConfigured: true,
        persistenceReady: true,
        hasActiveAdmin: false,
        hasDeployToken: false,
      }),
    ).toMatchObject({ allowed: false, code: "bootstrap_key_required" });
  });

  it("allows one-time bootstrap on a fresh durable production store", () => {
    expect(
      evaluateAuthStartup({
        isProduction: true,
        persistenceConfigured: true,
        persistenceReady: true,
        hasActiveAdmin: false,
        hasDeployToken: true,
      }),
    ).toEqual({ allowed: true, bootstrapRequired: true });
  });
});
