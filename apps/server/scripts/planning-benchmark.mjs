// Planning / QC performance benchmark. READ-ONLY: issues SELECTs only.
//
// Team rule: no performance claim without before/after measurement. Run this
// against production before a change lands, then again with --since <ISO> set to
// the deploy time, and diff the two against the BASELINE block below.
//
// Usage:
//   DATABASE_URL='postgres://.../railway?sslmode=no-verify' \
//     node apps/server/scripts/planning-benchmark.mjs [--since 2026-07-30] [--json]
//
// The connection string is read from DATABASE_URL (or NORNS_BENCHMARK_DATABASE_URL)
// and never printed.

import pg from "pg";

// Production telemetry, per-call averages over the window starting 2026-07-30.
// Frozen reference for before/after diffing — do not recompute.
const BASELINE = {
  window_since: "2026-07-30T00:00:00Z",
  calls: {
    "structured:conversation_work_plan_contract|claude-opus-4-8": {
      in: 5240,
      out: 4210,
      sec: 48.9,
    },
    "structured:conversation_work_plan_contract|claude-sonnet-5": {
      in: 3670,
      out: 4175,
      sec: 42.0,
    },
    "structured:review_findings|gpt-5.6-sol": { in: 3768, out: 2937, sec: 55.8 },
    "structured:plan_revision|claude-opus-4-8": { in: 12313, out: 10835, sec: 119.9 },
    "structured:plan_revision|claude-sonnet-5": { in: 9145, out: 14623, sec: 136.3 },
    "conversation_turn|claude-opus-4-8": { in: 8882, out: 1419, sec: 23.6 },
  },
  // Throughput is constant 53-107 tok/s across types: latency is a linear
  // function of output tokens, so an output-token reduction is the only lever.
  throughput_tok_per_sec: [53, 107],
  // plan_review_55bef2af. NOTE: these figures are the plan after TWO rounds
  // (round_exchanges length 2), not one. The measured one-round result on this
  // same input was 3,221 tok / 3 modules (2.62x / 1.50x) -- see roundOne below.
  // Comparing a one-round measurement against the two-round figure manufactures
  // a ~40% improvement that does not exist.
  inflation: {
    review: "plan_review_55",
    seedTokens: 1229,
    seedModules: 2,
    rounds: 2,
    roundOne: { revisedTokens: 3221, revisedModules: 3, tokenGrowth: 2.62, moduleGrowth: 1.5 },
    revisedTokens: 5565,
    revisedModules: 4,
  },
  qc: {
    reviews: 9,
    failed: 7,
    note: "all telemetry failures were structured:plan_revision / invalid_response",
  },
};

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const sinceArg = args[args.indexOf("--since") + 1];
const since = args.includes("--since") ? new Date(sinceArg) : null;
if (since && Number.isNaN(since.getTime()))
  throw new Error(`--since is not a valid ISO date: ${sinceArg}`);

const connectionString = process.env.DATABASE_URL ?? process.env.NORNS_BENCHMARK_DATABASE_URL;
if (!connectionString) throw new Error("set DATABASE_URL (read-only credentials) before running");

const tokens = (value) => Math.round(JSON.stringify(value ?? null).length / 4);
const modules = (value) => value?.plan?.modules?.length ?? null;
const ratio = (after, before) => (before > 0 ? after / before : null);
const num = (value) => (value === null || value === undefined ? null : Number(value));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
// Nearest-rank percentile: exact on tiny samples, no interpolation surprises.
const pct = (xs, p) =>
  xs.length
    ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)]
    : null;
const fmt = (value, digits = 0) =>
  value === null || value === undefined ? "-" : value.toFixed(digits);

function table(rows) {
  if (rows.length === 0) return "(no rows)\n";
  const cols = Object.keys(rows[0]);
  const width = (col) => Math.max(col.length, ...rows.map((row) => String(row[col]).length));
  const widths = cols.map(width);
  const line = (cells) =>
    cells
      .map((cell, i) => String(cell).padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  const lines = [
    line(cols),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map((row) => line(cols.map((c) => row[c]))),
  ];
  return `${lines.join("\n")}\n`;
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
// Belt-and-braces: even a read-only role should not be able to write from here.
await client.query("set session characteristics as transaction read only");

// ai_usage_events is an append-only event stream: tokens land on usage_observed,
// latency on request_completed/request_failed. Collapse to one row per call.
const { rows: calls } = await client.query(
  `select request_id,
          max(request_type) as request_type,
          max(provider) as provider,
          max(model) as model,
          max(input_tokens) as input_tokens,
          max(output_tokens) as output_tokens,
          max(cache_read_tokens) as cache_read_tokens,
          max(latency_ms) as latency_ms,
          max(cost_usd::float8) as cost_usd,
          max(retry_attempt) as retry_attempt,
          bool_or(event_type = 'request_failed') as failed,
          max(error_code) as error_code,
          min(recorded_at) as started_at
     from ai_usage_events
    where ($1::timestamptz is null or recorded_at >= $1::timestamptz)
    group by request_id
    order by min(recorded_at)`,
  [since],
);

const { rows: reviews } = await client.query(
  `select id, status, failure_code, revision_format, pm_model, seed_plan, revised_plan,
          round_exchanges, started_at, completed_at, usage_request_group_id
     from conversation_plan_reviews
    where ($1::timestamptz is null or coalesce(started_at, created_at) >= $1::timestamptz)
    order by coalesce(started_at, created_at)`,
  [since],
);
await client.end();

// 1. Per request type + model.
const byType = new Map();
for (const call of calls) {
  const key = `${call.request_type}|${call.model}`;
  if (!byType.has(key)) byType.set(key, []);
  byType.get(key).push(call);
}
const callStats = [...byType.entries()]
  .map(([key, group]) => {
    const latencies = group.map((c) => num(c.latency_ms)).filter((v) => v !== null);
    const inTok = group.map((c) => num(c.input_tokens)).filter((v) => v !== null);
    const outTok = group.map((c) => num(c.output_tokens)).filter((v) => v !== null);
    const cacheTok = group.map((c) => num(c.cache_read_tokens)).filter((v) => v !== null);
    const throughput = group
      .filter((c) => num(c.output_tokens) && num(c.latency_ms))
      .map((c) => num(c.output_tokens) / (num(c.latency_ms) / 1000));
    const [requestType, model] = key.split("|");
    return {
      key,
      requestType,
      model,
      calls: group.length,
      measured: latencies.length,
      failed: group.filter((c) => c.failed).length,
      medianLatencyMs: pct(latencies, 50),
      meanLatencyMs: mean(latencies),
      p90LatencyMs: pct(latencies, 90),
      avgInputTokens: mean(inTok),
      avgOutputTokens: mean(outTok),
      avgCacheReadTokens: mean(cacheTok),
      tokensPerSec: mean(throughput),
      baseline: BASELINE.calls[key] ?? null,
    };
  })
  .sort((a, b) => a.key.localeCompare(b.key));

// 2. Per review: cost of the QC loop and the plan-inflation metric.
const reviewStats = reviews.map((review) => {
  const group = calls.filter((c) => c.request_id.startsWith(review.usage_request_group_id));
  const seedTokens = tokens(review.seed_plan);
  const seedModules = modules(review.seed_plan);
  const revisedTokens = review.revised_plan ? tokens(review.revised_plan) : null;
  const revisedModules = modules(review.revised_plan);
  // Intermediate rounds are not persisted as plan versions, so per-round plan
  // size is taken from the revision call's output tokens — the plan the PM
  // actually emitted that round. Module counts only exist for the final plan.
  // ponytail: output-token proxy for mid-loop plan size; persist per-round plans
  // if the guardrail needs true per-round module counts.
  let previous = seedTokens;
  const rounds = (review.round_exchanges ?? []).map((exchange, index) => {
    const round = exchange.round ?? index + 1;
    const revisionCall = group.find(
      (c) => c.request_id === `${review.usage_request_group_id}:revision:${round}`,
    );
    const emitted = num(revisionCall?.output_tokens);
    const isFinal = index === (review.round_exchanges?.length ?? 0) - 1;
    const row = {
      round,
      findings: exchange.reviewer?.findings?.length ?? null,
      planTokens: emitted,
      tokenGrowth: emitted ? ratio(emitted, previous) : null,
      modulesAfter: isFinal ? revisedModules : null,
      moduleGrowth:
        isFinal && revisedModules && seedModules ? ratio(revisedModules, seedModules) : null,
    };
    if (emitted) previous = emitted;
    return row;
  });
  return {
    id: review.id,
    status: review.status,
    failureCode: review.failure_code,
    pmModel: review.pm_model,
    revisionFormat: review.revision_format,
    modelCalls: group.length,
    inputTokens: group.reduce((sum, c) => sum + (num(c.input_tokens) ?? 0), 0),
    outputTokens: group.reduce((sum, c) => sum + (num(c.output_tokens) ?? 0), 0),
    costUsd: group.reduce((sum, c) => sum + (num(c.cost_usd) ?? 0), 0),
    wallClockSec:
      review.started_at && review.completed_at
        ? (new Date(review.completed_at) - new Date(review.started_at)) / 1000
        : null,
    seedTokens,
    seedModules,
    revisedTokens,
    revisedModules,
    tokenGrowth: revisedTokens ? ratio(revisedTokens, seedTokens) : null,
    moduleGrowth: revisedModules && seedModules ? ratio(revisedModules, seedModules) : null,
    rounds,
  };
});

// 3. QC reliability.
const completedStatuses = new Set(["converged", "cap_reached"]);
const failures = new Map();
for (const review of reviews) {
  if (completedStatuses.has(review.status)) continue;
  const code = review.failure_code ?? review.status;
  failures.set(code, (failures.get(code) ?? 0) + 1);
}
const telemetryFailures = new Map();
for (const call of calls.filter((c) => c.failed)) {
  const code = `${call.request_type} / ${call.error_code ?? "unknown"}`;
  telemetryFailures.set(code, (telemetryFailures.get(code) ?? 0) + 1);
}
const reliability = {
  reviews: reviews.length,
  completed: reviews.filter((r) => completedStatuses.has(r.status)).length,
  failed: reviews.filter((r) => !completedStatuses.has(r.status)).length,
  failureRate: reviews.length
    ? reviews.filter((r) => !completedStatuses.has(r.status)).length / reviews.length
    : null,
  byFailureCode: Object.fromEntries(failures),
  byTelemetryError: Object.fromEntries(telemetryFailures),
  baseline: BASELINE.qc,
};

const report = {
  since: since?.toISOString() ?? null,
  baseline: BASELINE,
  calls: callStats,
  reviews: reviewStats,
  reliability,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const windowLabel = since ? since.toISOString() : "all time";
  console.log(
    `\nTheNorns planning/QC benchmark — window: ${windowLabel} (baseline window: ${BASELINE.window_since})\n`,
  );

  console.log("1. PER-REQUEST-TYPE LATENCY & TOKENS  (Δ = vs BASELINE)\n");
  console.log(
    table(
      callStats.map((s) => ({
        request_type: s.requestType.replace("structured:", ""),
        model: s.model,
        n: s.calls,
        fail: s.failed,
        med_s: fmt(s.medianLatencyMs / 1000, 1),
        mean_s: fmt(s.meanLatencyMs / 1000, 1),
        p90_s: fmt(s.p90LatencyMs / 1000, 1),
        base_s: s.baseline ? fmt(s.baseline.sec, 1) : "-",
        "Δ_s%":
          s.baseline && s.meanLatencyMs
            ? fmt((s.meanLatencyMs / 1000 / s.baseline.sec - 1) * 100, 1)
            : "-",
        avg_in: fmt(s.avgInputTokens),
        base_in: s.baseline ? s.baseline.in : "-",
        avg_out: fmt(s.avgOutputTokens),
        base_out: s.baseline ? s.baseline.out : "-",
        "Δ_out%":
          s.baseline && s.avgOutputTokens
            ? fmt((s.avgOutputTokens / s.baseline.out - 1) * 100, 1)
            : "-",
        cache_rd: fmt(s.avgCacheReadTokens),
        "tok/s": fmt(s.tokensPerSec, 1),
      })),
    ),
  );

  console.log("\n2. PER QC REVIEW — COST AND PLAN INFLATION\n");
  console.log(
    table(
      reviewStats.map((r) => ({
        review: r.id.replace("plan_review_", "").slice(0, 8),
        status: r.failureCode ? `${r.status}/${r.failureCode}`.slice(0, 28) : r.status,
        pm_model: r.pmModel,
        calls: r.modelCalls,
        in: r.inputTokens,
        out: r.outputTokens,
        usd: fmt(r.costUsd, 3),
        wall_s: fmt(r.wallClockSec, 1),
        seed_tok: r.seedTokens,
        rev_tok: r.revisedTokens ?? "-",
        tok_x: r.tokenGrowth ? `${fmt(r.tokenGrowth, 1)}x` : "-",
        seed_mod: r.seedModules ?? "-",
        rev_mod: r.revisedModules ?? "-",
        mod_x: r.moduleGrowth ? `${fmt(r.moduleGrowth, 1)}x` : "-",
      })),
    ),
  );

  const roundRows = reviewStats.flatMap((r) =>
    r.rounds.map((round) => ({
      review: r.id.replace("plan_review_", "").slice(0, 8),
      round: round.round,
      findings: round.findings ?? "-",
      plan_tok: round.planTokens ?? "-",
      tok_x: round.tokenGrowth ? `${fmt(round.tokenGrowth, 1)}x` : "-",
      modules: round.modulesAfter ?? "-",
      mod_x: round.moduleGrowth ? `${fmt(round.moduleGrowth, 1)}x` : "-",
    })),
  );
  console.log(
    "\n   per-round growth (plan_tok = revision-call output tokens; modules known for final round only)\n",
  );
  console.log(table(roundRows));
  const ref = BASELINE.inflation;
  console.log(
    `   BASELINE inflation reference: ${ref.review} ${ref.seedTokens} tok / ${ref.seedModules} modules -> ${ref.revisedTokens} tok / ${ref.revisedModules} modules ` +
      `(${(ref.revisedTokens / ref.seedTokens).toFixed(1)}x tokens, ${(ref.revisedModules / ref.seedModules).toFixed(1)}x modules in one round)\n`,
  );

  console.log("\n3. QC RELIABILITY\n");
  console.log(
    `   reviews ${reliability.reviews} | completed ${reliability.completed} | failed ${reliability.failed} ` +
      `(${fmt(reliability.failureRate * 100, 1)}%) | baseline ${BASELINE.qc.failed}/${BASELINE.qc.reviews} failed\n`,
  );
  console.log(
    table(
      Object.entries(reliability.byFailureCode).map(([code, count]) => ({
        review_failure_code: code,
        count,
      })),
    ),
  );
  console.log(
    table(
      Object.entries(reliability.byTelemetryError).map(([code, count]) => ({
        telemetry_failure: code,
        count,
      })),
    ),
  );
  console.log(`   baseline throughput band: ${BASELINE.throughput_tok_per_sec.join("-")} tok/s\n`);
}
