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

# Phase-2 shared styles.css requests

Append-only. Each entry names the requesting agent, the rule(s), and the exact
change wanted. The integrating PM applies these to `apps/web/src/styles.css`.

## From P2c (Projects.tsx / portfolio + wizard sweep)

Projects.tsx now carries inline `style={TYPE_FLOOR}` (fontSize: var(--text-xs))
workarounds on the labels below. Once an item below lands in styles.css, the
matching inline style in Projects.tsx can be deleted (grep `TYPE_FLOOR`).

### Type floor (raise every sub-12px size to `var(--text-xs)`)

- `.project-stats span` — `.72rem` → `var(--text-xs)`
- `.portfolio-pulse-panel .project-stats span` — `.56rem` → `var(--text-xs)`
- `.attention-summary span` — `.58rem` (and the earlier `.608rem`-era rule near
  `.attention-summary strong`) → `var(--text-xs)`
- `.pulse-foot` — `.62rem` → `var(--text-xs)`
- `.focus-hint` — `.67rem` → `var(--text-xs)`
- `.project-count` — `font: 500 .63rem "DM Mono"` → size `var(--text-xs)`
- `.project-source` — `.68rem` → `var(--text-xs)`
- `.project-tabs-label` — `.6rem` / `.58rem` (two rules) → `var(--text-xs)`
- `.pr-staffing .role-lbl` — `.62rem` → `var(--text-xs)`
- `.chip` — `font: 500 .68rem "DM Mono"` and later override `.61rem` →
  `var(--text-xs)`
- `.pr-titles .desc` — later override `.72rem` → `var(--text-xs)`
- `.pr-phase .pp-num` — `.65rem` → `var(--text-xs)`
- `.pr-phase .pp-bar .pp-pct` — `.68rem` → `var(--text-xs)`
- `.pr-phase .pp-eta` — `.72rem` → `var(--text-xs)`; `.pp-eta .lbl` `.58rem` →
  `var(--text-xs)`
- `.pr-phase.blocked .pp-blocked` — `.74rem` → `var(--text-xs)`
- `.pp-open` — `.7rem` → `var(--text-xs)`
- `.pr-agg .lbl` — `.68rem` → `var(--text-xs)`
- `.pr-fact` — `.72rem` → `var(--text-xs)`
- `.quick-project-copy small` — `.65rem` → `var(--text-xs)`
- `.quick-project-state` — `font: 600 .64rem "DM Mono"` → size `var(--text-xs)`
- `.quick-project-progress small` — `.57rem` → `var(--text-xs)`
- `.quick-access-empty span` — `.7rem` → `var(--text-xs)`
- `.meta` — `font: 400 .69rem "DM Mono"` → size `var(--text-xs)`; also replace
  its raw `color: #7f8993` with `var(--ink-muted)`
- `.repository-list small, .repository-meta` — `.68rem` → `var(--text-xs)`

### Section headings on the portfolio dashboard (tokenized heading ramp)

Per DESIGN-SYSTEM.md, section titles should sit on the `--text-*` scale:

- `.focus-panel-head h2` — `var(--heading-subsection-size)` → `var(--text-lg)`
- `.section-head h2, .section-head h3` — add `font-size: var(--text-lg)`
  (currently inherits base h2 `var(--heading-section-size)`)
- `.project-toolbar h2` — `var(--heading-section-size)` → `var(--text-lg)` so
  "Delivery detail / All projects" matches the other section heads exactly

### Raw hex / legacy-token cleanup in Projects-page rules

- `.project-stats` — `background: rgba(18, 21, 25, 0.75)` → surface tokens
  (e.g. `color-mix(in srgb, var(--bg) 52%, transparent)` like the
  `.portfolio-pulse-panel` override); radius `13px` → `var(--radius)`
- `.project-source` — `background: #0d1013` → `color-mix` on `var(--bg)` /
  `var(--surface)`; `border-radius: 8px` → `var(--radius-sm)`
- `.source-options button` (base rule) — `background: #0d1013`,
  `.is-selected` `background: #211a11` + `rgba(229, 155, 69, .1)` ring →
  brand/surface tokens (the later token-based override already models this)
- `.source-picker legend` — `color: #cbd0d5` → `var(--ink-muted)`;
  `.78rem` → `var(--text-sm)`

### Wizard width

- `.project-setup-view .wizard-page` — drop `max-width: 1120px` (or lower the
  selector's specificity) so the markup-level `.page-container-narrow`
  (720px) governs the New Project wizard width. The wizard main is now
  `page-container page-container-narrow wizard-page`.
- `.project-setup-title` rules — markup migrated to `PageHeader`
  (`.page-header`); the `.project-setup-title` block is now unused by
  Projects.tsx and can be deleted once no other page references it.
