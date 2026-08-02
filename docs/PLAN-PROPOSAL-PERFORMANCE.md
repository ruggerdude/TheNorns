# Initial plan proposal performance

The initial conversation plan proposal intentionally makes one structured
provider call on the successful path. Its request keeps the complete assembled
system context (including binding rules and handoff material) and bounds only
the visible recent discussion:

- latest 16 visible user/assistant messages;
- 16,000 included discussion characters total;
- 4,000 included characters per message, using deterministic head/tail excerpts;
- 7,000 generated tokens.

Selection starts at the newest message and restores chronological order before
serialization. Metadata reports counts, character totals, and SHA-256 hashes
for omitted messages or segments; raw omitted discussion and image payloads are
not placed in the request.

## Cap rationale and baseline

The pre-change five-run production sample took 26.25-76.37 seconds (median
45.89 seconds, p90 66.46 seconds, mean 47.48 seconds), with average input of
4,007 tokens, average output of 4,244 tokens, and an average manifest estimate
of 5,201 tokens. The 7,000-token cap leaves modest headroom above the observed
6,661-token maximum while replacing the adapter's 16,000-token default.

The manifest estimate can remain above the discussion limit because the
assembled system context is deliberately not truncated: binding rules and
durable handoff context remain authoritative. Re-run production benchmarks
with the same five-success sample and compare median/p90 latency, input/output
tokens, schema-valid success rate, and module/acceptance redundancy.

Focused verification:

```sh
pnpm --filter @norns/server exec vitest run test/planProposalEnvelope.test.ts test/conversationPlanWorkflowPhase3.test.ts
pnpm --filter @norns/server typecheck
```
