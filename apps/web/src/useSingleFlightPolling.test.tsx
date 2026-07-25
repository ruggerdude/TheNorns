import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSingleFlightPolling } from "./useSingleFlightPolling";

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function Probe({
  load,
  onValue,
}: {
  load: (signal: AbortSignal) => Promise<string>;
  onValue: (value: string) => void;
}): React.ReactElement {
  const polling = useSingleFlightPolling({
    intervalMs: 1_000,
    maxBackoffMs: 8_000,
    resourceKey: "probe",
    load,
    onSuccess: onValue,
  });
  return (
    <div>
      <span data-testid="in-flight">{String(polling.inFlight)}</span>
      <span data-testid="error">{polling.error?.message ?? ""}</span>
    </div>
  );
}

describe("useSingleFlightPolling", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it("never overlaps requests and aborts without publishing a stale response", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const loads = [first, second];
    const load = vi.fn((signal: AbortSignal) => {
      const next = loads.shift();
      if (!next) throw new Error("unexpected poll");
      signal.addEventListener("abort", () =>
        next.reject(new DOMException("Aborted", "AbortError")),
      );
      return next.promise;
    });
    const onValue = vi.fn();
    const view = render(<Probe load={load} onValue={onValue} />);

    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(load).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve("first"));
    await act(() => vi.advanceTimersByTimeAsync(1_001));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));

    view.unmount();
    await act(async () => second.resolve("stale"));
    expect(onValue).toHaveBeenCalledTimes(1);
    expect(onValue).toHaveBeenCalledWith("first");
  });

  it("backs off after failures and clears the stale error after recovery", async () => {
    const load = vi
      .fn<(signal: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"))
      .mockResolvedValue("recovered");
    render(<Probe load={load} onValue={vi.fn()} />);

    expect(await screen.findByTestId("error")).toHaveTextContent("first failure");
    await act(() => vi.advanceTimersByTimeAsync(1_001));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("error")).toHaveTextContent("second failure");

    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(load).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1_001));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("error")).toHaveTextContent("");
  });
});
