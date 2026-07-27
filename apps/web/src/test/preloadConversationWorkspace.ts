/**
 * Tests that exercise PhaseTab behavior are not testing Vite's chunk-loading
 * latency. Preload the real lazy module outside Testing Library's one-second
 * query window so a CPU-constrained parallel CI run cannot strand assertions
 * on the Suspense fallback. Production still loads this module lazily.
 */
export async function preloadConversationWorkspaceForTest(): Promise<void> {
  await import("../ConversationWorkspace");
}
