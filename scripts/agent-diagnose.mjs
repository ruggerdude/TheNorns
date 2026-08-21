#!/usr/bin/env node
// One-shot local-agent diagnosis: everything needed to explain a failed or
// rejected run without a server session. Reads only the runner's data dir.
//
//   node scripts/agent-diagnose.mjs [--data ~/.norns/runner-1] [--runs 10]
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const dataDir = flag("--data", join(homedir(), ".norns", "runner-1"));
const runLimit = Number(flag("--runs", "10"));
const json = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
const section = (title) => console.log(`\n== ${title}`);
const sh = (cmd, cmdArgs) => {
  try {
    return execFileSync(cmd, cmdArgs, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
};

section("Agent install");
const plist = join(homedir(), "Library/LaunchAgents/com.thenorns.local-agent.plist");
const plistText = existsSync(plist) ? readFileSync(plist, "utf8") : "";
console.log("installed version:", /NORNS_LOCAL_AGENT_VERSION<\/key><string>([^<]+)/.exec(plistText)?.[1] ?? "unknown");
const installedDist = "/Applications/Norns Local Agent.app/Contents/Resources/app/arm64/node_modules/@norns/runner/dist";
if (existsSync(installedDist)) console.log("installed dist mtime:", statSync(installedDist).mtime.toISOString());
const procs = sh("pgrep", ["-fl", "cli.js agent-start"]);
console.log("agent process:", procs ? procs.split("\n")[0] : "NOT RUNNING");
if (procs) console.log("started:", sh("ps", ["-o", "lstart=", "-p", procs.split(/\s/)[0]]));
console.log("server:", json(join(dataDir, "agent-config.json"))?.server ?? "unknown");
const errLog = join(homedir(), ".norns/logs/runner.err.log");
if (existsSync(errLog)) {
  const lines = readFileSync(errLog, "utf8").trim().split("\n").filter((l) => !/Debugger|For help, see/.test(l));
  if (lines.length) console.log("stderr tail:", lines.slice(-5).join(" | "));
}

section(`Last ${runLimit} dispatch outcomes (device execution)`);
const state = json(join(dataDir, "device-execution/runner-state.json"));
if (!state) console.log("no device-execution state");
else {
  const acks = state.terminal_acks ?? {};
  const entries = Object.entries(state.executed ?? {})
    .sort((a, b) => (acks[a[0]] ?? 0) - (acks[b[0]] ?? 0))
    .slice(-runLimit);
  for (const [id, outcome] of entries) {
    const run = decodeURIComponent(decodeURIComponent(id.replace(/^dispatch:dispatch-job:run:/, "")));
    console.log(`${String(outcome).padEnd(18)} ${run}`);
  }
  console.log("(rejected = the runner refused the dispatch; the reason is in the server's failure_detail)");
}

section("Device cancellation journal (stale entries replay on every reconnect)");
const journal = json(join(dataDir, "device-cancellation-evidence.json"));
for (const record of journal?.evidence ?? []) {
  console.log(
    `${record.run_id}\n   acknowledged ${record.acknowledged_at} · process_exited ${record.process_exited_at ?? "NEVER (unprovable stop)"}`,
  );
}
if (!journal?.evidence?.length) console.log("none pending");

section("Approved repositories");
for (const record of json(join(dataDir, "repository-access.json"))?.records ?? []) {
  console.log(`${record.repository_display_name.padEnd(32)} ${record.default_branch}@${record.observed_head.slice(0, 8)} ${record.sync_state}`);
}

section("Leftover worktrees (a finished run removes its worktree)");
const worktrees = join(dataDir, "worktrees");
const left = existsSync(worktrees) ? readdirSync(worktrees) : [];
console.log(left.length ? left.join("\n") : "none");

section("Latest coding session");
const runtimeState = join(dataDir, "scratch/runtime-state");
const transcripts = [];
for (const home of existsSync(runtimeState) ? readdirSync(runtimeState) : []) {
  const projects = join(runtimeState, home, ".claude/projects");
  if (!existsSync(projects)) continue;
  for (const project of readdirSync(projects)) {
    for (const file of readdirSync(join(projects, project))) {
      if (!file.endsWith(".jsonl")) continue;
      const path = join(projects, project, file);
      transcripts.push({ path, project, mtime: statSync(path).mtimeMs });
    }
  }
}
const latest = transcripts.sort((a, b) => b.mtime - a.mtime)[0];
if (!latest) console.log("no Claude transcripts under", runtimeState);
else {
  console.log("run:", latest.project.replace(/^.*worktrees-/, ""));
  console.log("transcript:", latest.path);
  let toolCalls = 0;
  let lastText = "";
  let lastResult = "";
  let lastCommand = "";
  for (const line of readFileSync(latest.path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (row.type === "assistant" && part.type === "tool_use") {
        toolCalls += 1;
        lastCommand = part.input?.command ?? part.name;
      }
      if (row.type === "assistant" && part.type === "text" && part.text.trim()) lastText = part.text;
      if (row.type === "user" && part.type === "tool_result") {
        const body = Array.isArray(part.content)
          ? part.content.map((entry) => entry.text ?? "").join(" ")
          : String(part.content ?? "");
        lastResult = body;
      }
    }
  }
  console.log("tool calls:", toolCalls, "(compare with the dispatch's max_turns — a cut-off session ends mid-sentence)");
  console.log("last command:", String(lastCommand).slice(0, 200));
  console.log("last tool result:", lastResult.replace(/\s+/g, " ").slice(0, 400));
  console.log("last assistant text:", lastText.replace(/\s+/g, " ").slice(-400));
}
