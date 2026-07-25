import { useCallback, useEffect, useRef, useState } from "react";

export interface PollingSnapshot {
  error: Error | null;
  inFlight: boolean;
  lastSuccessAt: Date | null;
}

export interface SingleFlightPollingOptions<T> {
  enabled?: boolean;
  /** Null performs one immediate load without scheduling another. */
  intervalMs: number | null;
  maxBackoffMs?: number;
  resourceKey: string;
  load: (signal: AbortSignal) => Promise<T>;
  onSuccess: (value: T) => void;
  onError?: (error: Error) => void;
}

const INITIAL_SNAPSHOT: PollingSnapshot = {
  error: null,
  inFlight: false,
  lastSuccessAt: null,
};

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Polls only after the previous request settles. Cleanup aborts the current
 * request, and a generation fence prevents a late response from an old
 * resource from publishing into the current view.
 */
export function useSingleFlightPolling<T>({
  enabled = true,
  intervalMs,
  maxBackoffMs = Math.max((intervalMs ?? 1_000) * 8, 30_000),
  resourceKey,
  load,
  onSuccess,
  onError,
}: SingleFlightPollingOptions<T>): PollingSnapshot & { refresh: () => void } {
  const loadRef = useRef(load);
  const successRef = useRef(onSuccess);
  const errorRef = useRef(onError);
  const resourceKeyRef = useRef(resourceKey);
  loadRef.current = load;
  successRef.current = onSuccess;
  errorRef.current = onError;
  resourceKeyRef.current = resourceKey;

  const [snapshot, setSnapshot] = useState<PollingSnapshot>(INITIAL_SNAPSHOT);
  const triggerRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!enabled) {
      triggerRef.current = () => undefined;
      return;
    }

    let stopped = false;
    let running = false;
    let rerunRequested = false;
    let failures = 0;
    let generation = 0;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const activeResourceKey = resourceKey;

    const schedule = (delayMs: number) => {
      if (stopped || intervalMs === null) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(run, delayMs);
    };

    const run = () => {
      if (stopped) return;
      if (running) {
        rerunRequested = true;
        return;
      }
      running = true;
      rerunRequested = false;
      const requestGeneration = ++generation;
      controller = new AbortController();
      setSnapshot((current) => ({ ...current, inFlight: true }));

      void loadRef
        .current(controller.signal)
        .then((value) => {
          if (
            stopped ||
            controller?.signal.aborted ||
            requestGeneration !== generation ||
            resourceKeyRef.current !== activeResourceKey
          ) {
            return;
          }
          failures = 0;
          successRef.current(value);
          setSnapshot({
            error: null,
            inFlight: false,
            lastSuccessAt: new Date(),
          });
        })
        .catch((value: unknown) => {
          if (
            stopped ||
            controller?.signal.aborted ||
            requestGeneration !== generation ||
            resourceKeyRef.current !== activeResourceKey
          ) {
            return;
          }
          failures += 1;
          const error = asError(value);
          errorRef.current?.(error);
          setSnapshot((current) => ({ ...current, error, inFlight: false }));
        })
        .finally(() => {
          if (stopped || requestGeneration !== generation) return;
          running = false;
          controller = undefined;
          if (rerunRequested) {
            run();
            return;
          }
          if (intervalMs !== null) {
            const retryDelay =
              failures === 0
                ? intervalMs
                : Math.min(intervalMs * 2 ** Math.max(0, failures - 1), maxBackoffMs);
            schedule(retryDelay);
          }
        });
    };

    triggerRef.current = run;
    run();

    return () => {
      stopped = true;
      generation += 1;
      window.clearTimeout(timer);
      controller?.abort();
      triggerRef.current = () => undefined;
    };
  }, [enabled, intervalMs, maxBackoffMs, resourceKey]);

  const refresh = useCallback(() => triggerRef.current(), []);
  return { ...snapshot, refresh };
}
