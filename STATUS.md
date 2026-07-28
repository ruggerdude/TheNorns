# Design overhaul — status (2026-07-27)

Program: full visual/UX overhaul of apps/web — one design system, one header
pattern, consistent widths/type/colors, new logo, remove "AI" filler copy,
fix flow bugs (New Project layout).

| Phase | Phase Name | % Complete | Est. Completion | Notes |
|-------|-----------|------------|-----------------|-------|
| P0 | Recon & design audit | 100% | done | Full browser tour + code map complete |
| P1 | Design foundation (tokens, shell, logo, headers) | 100% | done | 5 commits, head 76e4ae1. 271/271 web tests, tsc/biome/build clean. Logo+favicon shipped; wizard bug fixed (verified in-browser) |
| P2 | Page sweeps (usage / settings-admin-login / portfolio / workspace) | 45% | ~25 min | A2 DONE (0fb936a, suite green). A3 running. A4+A5 dispatched (Fable, worktrees) |
| P3 | Integration, full verification, browser walkthrough | 0% | ~20 min after P2 | Merge, full test gate, screenshots |
