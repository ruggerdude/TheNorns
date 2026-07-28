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
