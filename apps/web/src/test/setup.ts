// Vitest + jsdom global setup: registers jest-dom's DOM matchers
// (toBeInTheDocument, toHaveTextContent, etc.) for every test file, plus a
// couple of browser APIs jsdom doesn't implement that @xyflow/react (the
// graph canvas) needs just to mount without throwing.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

if (typeof globalThis.matchMedia === "undefined") {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof matchMedia;
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
