const PRELOAD_RECOVERY_KEY_PREFIX = "norns:vite-preload-reload:";

export interface PreloadRecoveryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PreloadRecoveryDependencies {
  storage: PreloadRecoveryStorage | null;
  reload: () => void;
}

export interface PreloadRecoveryEvent extends Event {
  payload?: unknown;
}

interface PreloadRecoveryEventTarget {
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface InstallPreloadRecoveryOptions {
  eventTarget?: PreloadRecoveryEventTarget;
  storage?: PreloadRecoveryStorage | null;
  reload?: () => void;
}

function readableFailure(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object") {
    try {
      const candidate = payload as { message?: unknown; name?: unknown };
      const message = typeof candidate.message === "string" ? candidate.message : "";
      const name = typeof candidate.name === "string" ? candidate.name : "";
      if (name || message) return `${name}:${message}`;
    } catch {
      // A hostile object should not turn recovery itself into another error.
    }
  }
  try {
    return String(payload ?? "unknown-preload-error");
  } catch {
    return "unknown-preload-error";
  }
}

function failureHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function preloadRecoveryKey(payload: unknown): string {
  return `${PRELOAD_RECOVERY_KEY_PREFIX}${failureHash(readableFailure(payload))}`;
}

/**
 * Vite emits `vite:preloadError` when an older page requests a lazy chunk that
 * a newer deployment no longer has. Reload once for that exact failure and
 * suppress Vite's unhandled error. If session storage is unavailable, do not
 * reload: without a durable guard that could create an infinite reload loop.
 */
export function recoverFromPreloadError(
  event: PreloadRecoveryEvent,
  dependencies: PreloadRecoveryDependencies,
): boolean {
  const { storage } = dependencies;
  if (!storage) return false;

  const key = preloadRecoveryKey(event.payload);
  try {
    if (storage.getItem(key) !== null) return false;
    storage.setItem(key, "attempted");
  } catch {
    return false;
  }

  event.preventDefault();
  dependencies.reload();
  return true;
}

function browserSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function installPreloadRecovery(options: InstallPreloadRecoveryOptions = {}): () => void {
  const eventTarget = options.eventTarget ?? window;
  const storage = options.storage === undefined ? browserSessionStorage() : options.storage;
  const reload = options.reload ?? (() => window.location.reload());
  const listener: EventListener = (event) => {
    recoverFromPreloadError(event as PreloadRecoveryEvent, { storage, reload });
  };

  eventTarget.addEventListener("vite:preloadError", listener);
  return () => eventTarget.removeEventListener("vite:preloadError", listener);
}
