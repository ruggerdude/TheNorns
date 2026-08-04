import { describe, expect, it, vi } from "vitest";
import {
  type PreloadRecoveryEvent,
  installPreloadRecovery,
  recoverFromPreloadError,
} from "./bootstrapRecovery";

function preloadEvent(message: string): PreloadRecoveryEvent {
  const event = new Event("vite:preloadError", { cancelable: true }) as PreloadRecoveryEvent;
  event.payload = new TypeError(message);
  return event;
}

describe("stale deployment preload recovery", () => {
  it("prevents the preload error and reloads only once for each failure signature", () => {
    const storage = new Map<string, string>();
    const reload = vi.fn();
    const dependencies = {
      storage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
      },
      reload,
    };

    const first = preloadEvent("Failed to fetch /assets/PhaseTab-old.js");
    expect(recoverFromPreloadError(first, dependencies)).toBe(true);
    expect(first.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    const repeat = preloadEvent("Failed to fetch /assets/PhaseTab-old.js");
    expect(recoverFromPreloadError(repeat, dependencies)).toBe(false);
    expect(repeat.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);

    const newChunk = preloadEvent("Failed to fetch /assets/Account-old.js");
    expect(recoverFromPreloadError(newChunk, dependencies)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not risk a reload loop when session storage is unavailable", () => {
    const event = preloadEvent("Failed to fetch /assets/PhaseTab-old.js");
    const reload = vi.fn();

    expect(
      recoverFromPreloadError(event, {
        storage: {
          getItem: () => {
            throw new DOMException("blocked", "SecurityError");
          },
          setItem: vi.fn(),
        },
        reload,
      }),
    ).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("installs and removes the Vite listener before rendering", () => {
    const eventTarget = new EventTarget();
    const reload = vi.fn();
    const remove = installPreloadRecovery({ eventTarget, storage: sessionStorage, reload });

    eventTarget.dispatchEvent(preloadEvent("Failed to fetch /assets/first.js"));
    expect(reload).toHaveBeenCalledTimes(1);

    remove();
    eventTarget.dispatchEvent(preloadEvent("Failed to fetch /assets/second.js"));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
