#!/bin/bash
# Periodic safety net: patch-snapshot every agent worktree.
# Read-only w.r.t. git's index (no add/commit), so it can never contend with an
# agent's own git commands. Restores with: git apply <patch> + untar untracked.
ROOT="/Users/dhatwell/The Norns"
OUT="$ROOT/.claude/snapshots"
while true; do
  TS=$(date +%H%M%S)
  for wt in "$ROOT"/.claude/worktrees/agent-*; do
    [ -d "$wt" ] || continue
    id=$(basename "$wt")
    # tracked modifications
    git -C "$wt" diff HEAD > "$OUT/$id.tracked.patch" 2>/dev/null
    # untracked, non-ignored files
    git -C "$wt" ls-files --others --exclude-standard -z 2>/dev/null \
      | tar --null -T - -czf "$OUT/$id.untracked.tgz" -C "$wt" 2>/dev/null
    # keep a timestamped copy only when something is actually pending
    if [ -s "$OUT/$id.tracked.patch" ]; then
      cp "$OUT/$id.tracked.patch" "$OUT/$id.$TS.patch" 2>/dev/null
    fi
  done
  # prune snapshots older than a day
  find "$OUT" -name "*.patch" -mmin +1440 -delete 2>/dev/null
  sleep 180
done
