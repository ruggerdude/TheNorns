# The Norns — Design System (Phase 1 foundation)

Phase 1 collapsed the three stacked styling layers in `apps/web/src/styles.css`
(base → "2026 PRODUCT REDESIGN" → "WORKSPACE EFFICIENCY PASS") into one token
system and one set of canonical primitives. This file is the contract for the
Phase 2 per-page sweep agents.

## Tokens (single `:root` block at the top of styles.css)

### Brand

| Token | Value | Use |
|---|---|---|
| `--brand-900` | `#001689` | Deep indigo. Primary-button gradient base, logo tile. |
| `--brand-600` | `#334bb4` | Working brand indigo. Accents, focus borders. |
| `--brand-100` | `#e6e9f9` | Light indigo tint for washes on light surfaces. |
| `--gold` | `#ffb600` | Sparingly: logo thread, focus outline, key highlights. |
| `--brand-ink` | theme-mapped | Brand color guaranteed readable on the current bg (`#bec8f3` dark / `--brand-600` light). Eyebrows, brand-tinted labels. |
| `--brand-wash`, `--brand-wash-subtle` | theme-mapped | Translucent indigo fills (active tabs, stat tiles). |

### Semantic surfaces & ink (theme-mapped, use these — not raw hexes)

`--bg`, `--surface`, `--surface-2` (raised), `--ink`, `--ink-muted`,
`--line`, `--line-strong`, plus status hues `--success`, `--warn`,
`--danger`, `--info`, and shadows `--shadow`, `--shadow-sm`.

### Type scale (rem only — `--text-xs` = 12px is the FLOOR; nothing below it)

`--text-xs` .75 · `--text-sm` .8125 · `--text-base` .875 · `--text-md` 1 ·
`--text-lg` 1.25 · `--text-xl` 1.625 · `--text-2xl` 2.125 ·
`--text-hero` 3 (login hero only).

The legacy heading ramp (`--heading-display-size`, `--heading-page-size`,
`--heading-section-size`, `--heading-subsection-size`, `--heading-detail-size`)
still exists for old page rules; prefer the `--text-*` scale in new code.

### Space, radius, containers, breakpoints

- Space: `--space-1..8` = 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 px.
- Radius: `--radius-sm` 8 · `--radius` 12 · `--radius-lg` 16.
- Containers: `--container` 1200 · `--container-narrow` 720 ·
  `--container-reading` 640.
- Breakpoints for new code: **640 / 900 / 1200** (don't add new ad-hoc ones).

### Legacy aliases (do not use in new code — migrate on contact)

`--text→--ink`, `--muted→--ink-muted`, `--raised→--surface-2`,
`--line2→--line-strong`, `--accent→--brand-600` (light: `--brand-900`),
`--accent2→--brand-ink`, `--warning→--warn`, `--brand-primary→--brand-900`,
`--gold-accent→--gold`. When you sweep a page, replace the alias with the
canonical name; when every reference is gone the alias block gets deleted.

## Shell

- **One topbar pattern**: `.topbar` — 64px, sticky, brand lockup left,
  actions right. `.workspace-topbar` and `.full-page-header` are visual
  aliases (same rule group); migrate markup to `.topbar` when you own the
  page. The theme toggle renders **inline in topbar actions**
  (`AuthenticatedHeaderActions`), never floating.
- **Containers**: wrap page content in
  `.page-container` (+ `.page-container-narrow` / `.page-container-reading`
  modifiers). The legacy `.page` class now maxes at `var(--container)`.

## Component APIs (apps/web/src/ui.tsx)

```tsx
<PageHeader
  eyebrow="Workspace"            // optional, uppercase brand-ink
  title="Settings"               // h1: --text-2xl / 800 / -0.02em
  lede="What this page is for."  // optional, --text-md ink-muted
  actions={<Button …/>}          // optional right-aligned slot
/>

<Brand />                 // topbar lockup: 26px gradient tile + "The Norns"
<BrandMark size={56} />   // raw converging-threads SVG mark, currentColor
                          // strands + gold thread (login-scale usage)
```

CSS: `.page-header`, `.page-header-lede`, `.page-header-actions`,
`.brand`, `.brand-mark`. The favicon (`apps/web/public/favicon.svg`) is the
same mark on the full 48px indigo tile — keep them in sync.

## Phase 2 must clean up per page

- **Adopt `PageHeader`** on every page intro idiom: `.page-intro`,
  `.full-page-intro`, `.dashboard-hero`, `.workspace-header`,
  `.usage-heading`, `.operations-header`, `.conversation-header`,
  `.debates-head`, `.project-setup-title`.
- **Sub-12px fonts remain in page-specific rules** (e.g. `.project-tabs-label`
  .58rem, `.project-source` .61rem, chips/metas at .6–.73rem, workspace-tab
  number chips). Raise to `--text-xs` minimum when sweeping the page.
- **Alias migration** (`--accent` & co) per the table above; also replace
  hardcoded rgba(0, 22, 137, …) with `--brand-wash*`/color-mix on tokens.
- **Purple/sepia stragglers**: some old page rules still mix `#7c5cff`-era
  purple or sepia light-mode hexes (e.g. `.attention-center` gradient,
  `.source-options` light backgrounds, `.login-art` radial, `.project-monogram`).
  Re-tint on brand tokens when you own the page.
- **AI copy sweep**: only index.html + Login eyebrow were rebranded in P1;
  page-level "AI …" strings are Phase 2 scope.
- Usage pages (`UsageHub`, `UsageAnalytics`, `UsageIntelligence`) were left
  100% untouched in Phase 1, including their headers and CSS files.
