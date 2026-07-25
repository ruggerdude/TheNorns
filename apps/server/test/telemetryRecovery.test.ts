import { FakeAdapter } from "@norns/adapters";
import {
  type AiPricingProfileInputT,
  type AiPricingProfileT,
  AiUsageLifecycleEvent,
  type AiUsageLifecycleEventInputT,
  type AiUsageLifecycleEventT,
} from "@norns/contracts";
import { describe, expect, it } from "vitest";
import type { AiUsageTelemetryRepository } from "../src/persistence/v2/aiUsageTelemetry.js";
import {
  AiInvocationTelemetry,
  type AiTelemetryHealth,
} from "../src/usage-intelligence/telemetry.js";

class RecoverableTelemetryRepository implements AiUsageTelemetryRepository {
  available = false;
  private readonly stored = new Map<string, AiUsageLifecycleEventT>();

  async createPricingProfile(_input: AiPricingProfileInputT): Promise<AiPricingProfileT> {
    throw new Error("not used");
  }

  async findEffectivePricingProfile(
    _provider: string,
    _model: string,
    _occurredAt: string,
    _pricingVersion?: string,
  ): Promise<AiPricingProfileT | null> {
    if (!this.available) throw new Error("database unavailable");
    return null;
  }

  async appendEvent(
    input: AiUsageLifecycleEventInputT,
    stableEventId = `event-${this.stored.size + 1}`,
  ): Promise<AiUsageLifecycleEventT> {
    if (!this.available) throw new Error("database unavailable");
    const existing = this.stored.get(stableEventId);
    if (existing) return existing;
    const sequence =
      [...this.stored.values()].filter((event) => event.request_id === input.request_id).length + 1;
    const persisted = AiUsageLifecycleEvent.parse({
      ...input,
      id: stableEventId,
      schema_version: 1,
      sequence,
      recorded_at: input.occurred_at,
    });
    this.stored.set(stableEventId, persisted);
    return persisted;
  }

  async requestEvents(requestId: string): Promise<AiUsageLifecycleEventT[]> {
    return [...this.stored.values()]
      .filter((event) => event.request_id === requestId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  events(): AiUsageLifecycleEventT[] {
    return [...this.stored.values()].sort((left, right) => left.sequence - right.sequence);
  }
}

describe("AI telemetry outage recovery", () => {
  it("returns provider success, then reconciles the complete lifecycle in order", async () => {
    const repository = new RecoverableTelemetryRepository();
    const healthChanges: AiTelemetryHealth[] = [];
    const telemetry = new AiInvocationTelemetry(repository, () => new Date(), {
      retryBaseDelayMs: 60_000,
      onHealthChange: (health) => healthChanges.push(health),
    });
    const adapter = new FakeAdapter("anthropic");
    adapter.enqueue("provider success");

    const result = await telemetry.wrapAdapter(adapter).complete({
      projectId: "outage-project",
      prompt: "never persist this prompt",
    });

    expect(result.text).toBe("provider success");
    expect(telemetry.health()).toMatchObject({
      status: "degraded",
      pendingEvents: 3,
      droppedEvents: 0,
    });

    repository.available = true;
    await expect(telemetry.reconcile()).resolves.toBe(3);

    expect(repository.events().map((event) => event.event_type)).toEqual([
      "request_started",
      "usage_observed",
      "request_completed",
    ]);
    expect(JSON.stringify(repository.events())).not.toContain("never persist this prompt");
    expect(telemetry.health()).toMatchObject({
      status: "healthy",
      pendingEvents: 0,
      droppedEvents: 0,
    });
    expect(healthChanges.map((health) => health.status)).toEqual(["degraded", "healthy"]);
  });

  it("bounds permanent-outage memory and exposes every dropped lifecycle event", async () => {
    const repository = new RecoverableTelemetryRepository();
    const telemetry = new AiInvocationTelemetry(repository, () => new Date(), {
      maxPendingEvents: 2,
      maxRetryAttempts: 1,
      retryBaseDelayMs: 60_000,
      // A broken observability callback is isolated just like persistence.
      onHealthChange: () => {
        throw new Error("monitor failed");
      },
    });
    const adapter = new FakeAdapter("openai");
    adapter.enqueue("provider success despite total outage");

    await expect(
      telemetry.wrapAdapter(adapter).complete({
        projectId: "outage-project",
        prompt: "secret",
      }),
    ).resolves.toMatchObject({ text: "provider success despite total outage" });

    expect(telemetry.health()).toMatchObject({
      status: "degraded",
      pendingEvents: 2,
      droppedEvents: 1,
    });
    await expect(telemetry.reconcile()).resolves.toBe(0);
    expect(telemetry.health()).toMatchObject({
      status: "degraded",
      pendingEvents: 0,
      droppedEvents: 3,
    });
  });
});
