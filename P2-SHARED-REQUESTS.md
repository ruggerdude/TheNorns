# Phase 2 shared-CSS requests

Requests from per-page sweep agents that are blocked by the hard scope rule
(agents may edit only their assigned page files, never `styles.css`,
`ui.tsx`, or `theme.tsx`). Collect here for the integrating PM to apply.

## From P2b (Account.tsx / Admin.tsx / Login.tsx sweep)

### 1. `.login-card` padding/radius are hardcoded, not tokens

`apps/web/src/styles.css` ~line 5566:

```css
.login-card {
  padding: 1.6rem;
  border-radius: 22px;
  box-shadow: var(--shadow);
}
```

Task asked for "form card padding/radius via tokens." `1.6rem` isn't on the
`--space-*` scale and `22px` isn't `--radius-sm`/`--radius`/`--radius-lg`.
Suggest `padding: var(--space-6)` (32px, closest to current) or `var(--space-5)`
or `var(--space-6)` for the horizontal / uniform padding, and
`border-radius: var(--radius-lg)` (16px — the login card is deliberately
larger than the standard 12px `.card` radius, so `--radius-lg` reads closest
to today's 22px without introducing a new value). Left `Login.tsx`'s
`className="login-card card"` unchanged since there's no way to override this
from the component without an inline style or a new scoped class, both
disallowed by the hard scope rule.

### 2. `.meta` is below the `--text-xs` (12px) floor

`apps/web/src/styles.css` ~line 1775:

```css
.meta {
  font: 400 .69rem "DM Mono", monospace;
  color: #7f8993;
}
```

`.69rem` = 11px, under the DESIGN-SYSTEM.md floor. This class is shared well
beyond P2b's three files (also used by `.workspace-header .meta` and others),
so raising it needs a pass to confirm nothing downstream relies on the
tighter size. It directly blocks two P2b asks:

- Login's hero micro-strip (`HUMAN-GATED · CROSS-PROVIDER · AUDITABLE`) —
  asked to "normalize … to var(--text-xs)"; left the markup as
  `<div className="meta">…` since no existing token-based class reproduces
  the muted/mono/tracked look at >=12px without this fix.
- Account.tsx's local-agent-setup paragraph (`Folder paths stay on this
  computer…`) also uses `.meta` and is 1px under the floor.

Suggest: `font: 400 var(--text-xs) "DM Mono", monospace;`.

### 3. `.connection-row span`, `.connection-brand p` — below the floor, but safe/page-scoped

`apps/web/src/styles.css` ~line 791:

```css
.connection-brand p,
.connection-row span {
  color: var(--muted);
  font-size: 0.72rem;
}
```

`.connection-*` classes are used exclusively by `Account.tsx` (grepped the
whole `apps/web/src` — no other consumer), so unlike `.meta` this one is safe
to raise without a cross-page blast-radius check. Suggest
`font-size: var(--text-xs);`. Left as-is only because the hard scope rule
forbids editing `styles.css` from this worktree, not because of any real risk.

### 4. `.full-page-header-title > span` — below the floor, also page-scoped to Account/Admin

`apps/web/src/styles.css` ~line 5451:

```css
.full-page-header-title > span {
  padding-left: 1.1rem;
  border-left: 1px solid var(--line);
  color: var(--muted);
  font-size: .73rem;
  font-weight: 650;
}
```

Only consumers are the `<span>Settings</span>` / `<span>Administration</span>`
labels next to `Brand` in `Account.tsx` and `Admin.tsx`'s topbar. Same
situation as #3 — safe, page-scoped, just blocked by file-scope.

### 5. Bigger finding: `.eyebrow` (and likely `.brand`/`.brand-mark`) have three
competing definitions and the Phase 1 token version is losing the cascade

Grepped `.eyebrow {` and found it defined three times, all as flat top-level
rules (no `@media`, no `@layer`, no `!important`), same specificity:

- `styles.css` ~178 — the canonical Phase 1 version: `color: var(--brand-ink);
  text-transform: uppercase; letter-spacing: .12em; font-size:
  var(--text-xs); font-weight: 700;`
- `styles.css` ~4384 — inside the `/* 2026 PRODUCT REDESIGN */` legacy block:
  `color: var(--accent2); font-size: .66rem; font-weight: 750;
  letter-spacing: .14em;`
- `styles.css` ~5974 — inside a later legacy block: `font-size: 0.74rem;`
  only.

Because plain CSS cascade resolves per-*property*, and rule order in the file
is (178) < (4384) < (5974), the eyebrow actually rendered today is a hybrid:
`text-transform` from #178 (only place that sets it), `color`/`font-weight`/
`letter-spacing` from #4384 (last to set those), `font-size` from #5974
(0.74rem — last to set font-size, and still technically under the 0.75rem
`--text-xs` floor). None of the three pages I swept get the clean Phase 1
token eyebrow the design doc describes — including the `PageHeader`
component I just wired into `Account.tsx`/`Admin.tsx` and both `Login.tsx`
eyebrows. This is a pre-existing Phase 1 cleanup gap, not something
introduced by P2b, but every P2 page that uses `.eyebrow` (which is most of
them, directly or via `PageHeader`) inherits it. Flagging because it likely
blocks other parallel P2 agents the same way. `.brand`/`.brand-mark` show the
same triplication pattern (`ui.tsx`'s canonical rule vs. duplicate blocks at
~4336 and elsewhere) and are worth checking too, though I didn't verify their
cascade outcome as closely as `.eyebrow`'s.

Suggest deleting the two legacy `.eyebrow` blocks (~4384, ~5974) now that
Phase 1's canonical block exists, once each remaining legacy consumer has
been swept (per DESIGN-SYSTEM.md's plan, this is exactly what "when every
reference is gone the alias block gets deleted" describes for aliases — same
idea applies to these un-namespaced duplicate primitives).
