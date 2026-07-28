# Phase 2 — requests for shared files (styles.css / ui.tsx / Projects.tsx owners)

Append-only. Each entry: requesting agent, file, exact change, why.

## P2d (workspace) — styles.css sticky offsets after shell reorder

App.tsx now renders the workspace shell as: `.topbar` (brand, top: 0) →
`.project-tabs` strip → `main.workspace-page`. The old order (project-tabs
above a `.workspace-topbar` offset 42px) is gone, and the
`workspace-topbar` class is no longer used by any markup.

Requested styles.css changes:

1. **Delete the `.workspace-topbar { top: 42px; z-index: 19; }` block**
   (~line 1858) and the `.workspace-topbar { top: 42px; }` override inside
   the `@media (max-width: 760px)` block (~line 5446). Dead selectors now;
   the 42px offset actively breaks the new order if the class is ever
   reused.
2. **`.workspace-tabs` sticky offset**: change `top: 106px` (~line 1880) to
   `top: 64px`, and the mobile override `top: 104px` (~line 5465) to
   `top: 62px`. The project-tabs strip is not sticky, so once it scrolls
   away the tab bar should dock directly under the 64px topbar (62px at
   ≤760px). (Alternative if you prefer the strip to stay visible: make
   `.project-tabs` sticky at `top: 64px` / `62px`, `z-index: 19`, and keep
   106/104 — either resolves the gap; pick one.)
3. Optional cleanup: `.workspace-topbar` can be dropped from the shared
   selector lists at ~lines 490, 5341, 5349 once (1) lands.

Until these land, behavior is only mildly degraded: the workspace tab bar
sticks 42px lower than the topbar, showing a gap after scroll. Nothing is
broken at rest.

## P2d (workspace) — styles.css heading ramp + run-log micro text

The workspace views draw their heading sizes from the legacy ramp in
styles.css, and the run log has sub-floor px sizes there. I overrode the
views that own a scoped CSS file (operations dashboard, members, knowledge
panel); the rest (debates, debate builder/run, settings, strategy review,
run log) have no scoped stylesheet, so the canonical fix has to land in
styles.css:

1. `.workspace-shell h2` (~line 5638): `var(--heading-section-size)` →
   `var(--text-lg)`. `.workspace-shell h3` (~5642):
   `var(--heading-subsection-size)` → `var(--text-md)`.
   `.workspace-shell h4` (~5646): `var(--heading-detail-size)` →
   `var(--text-base)`. (Design intent: one page-level header per view;
   section headers at --text-lg.)
2. Run log micro text (all sub-floor): `.run-log > summary` (~1078)
   `font-size: 11px` → `var(--text-xs)`; `.run-log-output` (~1095)
   `font-size: 11px` → `var(--text-xs)`; `.run-log-meta` (~1103)
   `font-size: 10.5px` → `var(--text-xs)`.
3. `.project-tabs-label` .6rem (~1654) and its duplicate .58rem (~4492),
   `.project-tab button` .7rem/.68rem (~1673/~4512): raise to
   `var(--text-xs)` (also flagged in DESIGN-SYSTEM.md's per-page list;
   the strip is rendered by ProjectTabs in Projects.tsx, which P2d does
   not own).
