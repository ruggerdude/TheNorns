# TheNorns web app — UI feedback for a design/frontend pass

**Audience:** an agent (or engineer) doing a substantial UI/UX pass on `apps/web`.
**Author context:** written by the agent that built the current UI incrementally,
feature-by-feature, with zero design investment — this doc is an honest
self-assessment plus a punch list, not a spec to follow mechanically.

## What TheNorns is

An AI Program Management platform. A human describes a project, picks a PM
(Anthropic or OpenAI — the reviewer always auto-flips to the other provider),
the two providers run a real cross-provider planning loop, the human reviews
the resulting acceptance criteria (QC), commits it to a workflow graph,
allocates models/budgets to each module, approves, and (eventually — not yet
wired) coding agents execute it. Everything the UI shows is backed by a real
Fastify API — there is no mock data in production use.

## Current state, honestly

This is a **functional prototype with zero design investment.** Every screen
was built to prove a backend capability worked, styled just enough to be
legible, in the order features shipped. There is no design system, no shared
component library, no color/spacing tokens, and no responsive layout. It
looks and feels like an internal dev tool, not a product a PM would want to
open every day. That's the gap this pass should close.

**Concrete evidence**, pulled directly from the source (`apps/web/src/*.tsx`,
1,069 lines total):

- **22 distinct hardcoded hex colors** across 5 files, zero shared constants.
  `#666` alone is independently retyped in `Projects.tsx`, `App.tsx`, and
  `Dashboard.tsx` — not reused from anywhere, just coincidentally identical.
- **71 inline `style={{...}}` object literals.** No CSS file, no styled-
  components, no Tailwind, no CSS modules — every visual property is a JS
  object literal at the call site.
- `fontFamily: "ui-monospace, monospace"` (or `"inherit"`) is **repeated 11
  separate times** instead of set once globally.
- `apps/web/index.html` has no CSS reset, no font loading, no favicon. The
  `<title>` still reads "TheNorns — Workflow Graph" — stale from Phase 4,
  before this became a multi-project PM platform.
- Every button is a bare native `<button type="button">` with ad hoc inline
  styling (or none) — no consistent size, radius, hover/active/disabled
  state, or focus ring across the app.

## Hard constraints — please don't regress these

This is a rebuild of the *look and interaction design*, not the product.
Everything below is real, backend-verified behavior that must keep working:

- **Auth**: session token in `sessionStorage` (`apps/web/src/auth.ts` —
  `getToken`/`setToken`/`clearToken`/`authHeaders`/`ApiError`/
  `UnauthorizedError`). A 401 anywhere should still force sign-out.
- **Login → Projects → Project detail** is the real navigation model. Login
  gates everything; Projects (list + create) is the landing view; opening a
  project shows its graph editor. There's no router library in use (plain
  `useState` view-switching in `App.tsx`) — fine to introduce one if it
  helps, but the three-level flow itself is intentional.
- **Project creation** requires a name, description, and PM provider
  (`anthropic` | `openai`); the reviewer is always the other provider —
  this is a deliberate safety policy (cross-provider review), not a UI
  default to relax. Show it, don't make it editable independently.
- **Live Planning → QC review → Load into graph** is a three-step, human-
  gated flow by design: nothing commits to the graph without the human
  seeing (and being able to edit) every module's acceptance criteria first.
  Collapsing this into one step would remove an intentional safety gate.
- **The graph canvas** (`@xyflow/react`) is wired to real CRUD: dragging a
  connection between nodes calls `POST /graph/edges` (server rejects cycles
  with a 409 + the offending path); deleting an edge calls `DELETE
  /graph/edges`; node delete offers `reparent` vs `cascade` modes because
  a node with dependents can't just vanish silently.
- **Auto Allocate → per-node override → Approve** must stay a distinct
  sequence — approval hashes the graph state and is refused (409) while any
  node is unallocated.
- All requests are scoped under `/api/projects/:id/*` (see endpoint list
  below) — don't reintroduce global (non-project-scoped) graph state.

Nothing above dictates visual style — only that these behaviors keep working
and stay discoverable.

## How to see it yourself

```
pnpm --filter @norns/server run build && node apps/server/dist/main.js   # :8787, token "dev-token"
pnpm --filter @norns/web dev                                              # :5173, proxies /api to :8787
```
Both are also defined in `.claude/launch.json` if your tooling reads that.
Sign in with `dev-token`. There's no seed data — you'll create a project to
see anything past the empty state.

**There is no frontend test suite** (`apps/web`'s `test` script is a literal
no-op echo — coverage today is backend API tests + manual browser
verification). Nothing will break red if you restructure components; that
also means nothing catches you if you break a flow. Click through every flow
in a real browser after changes: sign in, create a project (try both PM
providers), run Live Planning, edit a criterion in QC review, load into
graph, connect/delete an edge, delete a node both ways, auto-allocate,
override a node, approve, open the PM Dashboard, sign out.

## Cross-cutting problems, in priority order

### 1. No design system
No color palette, spacing scale, typography scale, or component library.
Recommend picking one direction and applying it everywhere rather than
polishing screens individually — otherwise you'll spend the same effort and
still end up with 5 files that don't agree with each other. Reasonable
options, roughly in order of how much scaffolding they give you:
- **Tailwind + shadcn/ui (or similar Radix-based kit)** — fast to get a
  consistent, accessible, dark-mode-capable result; large ecosystem.
- **Panda CSS / vanilla-extract** — token-driven, type-safe, no runtime
  cost, more setup work.
- **A small hand-rolled token file** (`colors.ts`, `spacing.ts`) plus CSS
  Modules — lowest dependency footprint, most manual labor.

Whatever you pick, define semantic tokens up front: a real color scale
(not "whatever hex looked fine"), a spacing scale, one type scale, and a
`risk`/`status` color mapping (see graph section below) — then use only
those, everywhere.

### 2. Visual identity is inconsistent
`Login.tsx` is dark (near-black background, dark card, orange `#d97706`
accent button) — an actual designed screen. Everything past login
(`Projects.tsx`, `App.tsx`, `Dashboard.tsx`, `PlanReview.tsx`) is
light-background, black-on-white, monospace, undecorated. The mismatch is
jarring: you sign in to something that looks like a considered product and
land on something that looks like an admin panel. Pick one direction (the
orange-on-dark identity is a reasonable seed) and carry it through every
screen, including empty/loading/error states.

### 3. Zero component reuse
Buttons, cards, badges, form fields, and error banners are each re-styled
inline at every call site rather than built once. Concretely worth
extracting: `Button` (primary/secondary/destructive, with real
hover/active/disabled/focus states), `TextField`/`TextArea`, `Select`,
`Card`, `Badge` (for status: draft/planned, risk level, provider), `ErrorBanner`,
`EmptyState`, and a `Spinner`/skeleton loader.

### 4. No responsive or adaptive layout
- `Login`, `Projects` render in a fixed `maxWidth: 720px` column, left-
  aligned near the top of the viewport — on any real desktop monitor
  there's a wall of dead space to the right and below. Neither centers
  vertically nor uses the available width purposefully.
- The project graph view is a fixed `340px` sidebar + flexed canvas, full
  height. There's no mobile/narrow-viewport behavior at all — under ~700px
  wide this would be unusable (verified conceptually; not yet tested at
  narrow widths).
- Nothing responds to viewport size anywhere in the app.

### 5. No design for loading / empty / error states
- Loading is the literal text "Loading…".
- Errors are a red text block (`color: "#b91c1c"`) inserted into flow,
  which shifts everything below it down — no toast/snackbar system, no
  dismiss, no icon.
- Empty states are one gray sentence ("No projects yet — create one
  above.") with no illustration, no visual weight, nothing that invites
  the action.

### 6. Accessibility gaps
- Status is frequently color-only: green (`#047857`) for "planned" /
  "override" / "approved", red (`#b91c1c`) for errors, orange for
  selection — no icon or text fallback for colorblind users.
- Low-contrast grays (`#666`, `#999`) used for body/secondary text in
  several places — worth auditing against WCAG AA contrast ratios once a
  palette exists.
- No visible focus states beyond browser defaults (which are inconsistent
  across browsers) — needed for keyboard navigation, especially in the
  graph editor.
- Form inputs (`<input>`, `<select>`, `<textarea>`) are rarely paired with
  a real `<label>` (`htmlFor`/`id`) — most rely on `placeholder` text alone,
  which disappears on input and isn't read reliably by all screen readers.

### 7. No iconography
Every affordance is a text button ("Auto Allocate", "Approve allocation
(budget)", "Delete (re-parent)", "← Projects", "sign out"). Nothing is
scannable at a glance; a settings/back/delete/approve icon set would cut
visual noise substantially, especially in the graph sidebar where six text
sections stack vertically.

## Screen-by-screen notes

### Login (`Login.tsx`)
The one screen with actual visual design: centered dark card (~360px),
"TheNorns" wordmark, subtext, password-style input, orange full-width
button. Reasonable as a seed for a broader identity. Missing: any error
state styling beyond a red line (`#f87171`) — worth checking it still reads
as an *error*, not just colored text; no loading state on submit.

### Projects (`Projects.tsx`) — the new landing view
Top-left-aligned "New Project" form (name input, description textarea, PM
`<select>`, Create button) directly above a "Your Projects" list. Problems
observed directly:
- The whole page lives in a 720px-wide left column with no vertical or
  horizontal centering — massive unused whitespace on any real monitor.
- The PM `<select>` is a bare native dropdown with no visual distinction
  between the two providers (no logos/colors) and the "reviewer: X
  (cross-provider by policy)" explanation is a small gray caption easy to
  miss — this is actually an important, differentiating piece of the
  product's safety story and deserves more visual weight.
- Project list rows are plain bordered boxes; the only status signal is a
  small colored word ("draft" gray / "planned" green) top-right. No
  timestamps shown (`created_at` exists in the data, unused in the UI), no
  sorting/filtering/search once you have more than a handful of projects.
- "No projects yet — create one above." is the entire empty state.

### Project graph editor (`App.tsx` → `ProjectGraph`)
The biggest, most complex screen: `@xyflow/react` canvas on the left, a
340px scrollable sidebar on the right stacking, in order: back/sign-out,
project name + PM/reviewer line, "PM Dashboard →" button, graph
version/cost text, **Live Planning** (textarea + button, or the QC review
inline), **Auto Allocate**, **Approval**, and the **node inspector**. Once a
plan is loaded this becomes a long, undifferentiated scroll of six
unrelated concerns with no visual grouping (no cards, no dividers beyond
`<h3>` tags).

Specific problems observed while exercising a real 5-module graph:
- **Graph nodes carry no risk/status color coding.** A `critical`-risk
  module and a `low`-risk module render as identical white boxes — only
  the tiny text label ("L/critical" vs "S/low") differs. This is exactly
  the kind of thing color should carry at a glance.
- **Edges cross messily** with more than ~4 nodes — the layered
  auto-layout (`layout()` in `App.tsx`, a simple longest-path-depth
  algorithm) doesn't minimize edge crossings, and edges have no
  hover/highlight state to trace a single dependency chain.
- **The node inspector panel dumps raw `JSON.stringify(assignment, null, 1)`
  into a `<pre>` block** — a real user sees `{"provider": "anthropic",
  "model": "claude-opus-4-8", ...}` as literal text. This needs a real
  formatted display (labeled rows, or a small table).
- **Node delete has no confirmation** — clicking "Delete (re-parent)" or
  "Delete (cascade)" executes immediately. Cascade delete on a node with
  many dependents is destructive and irreversible from the UI; at minimum
  it deserves a confirm step, ideally a preview of what will be removed
  (the server response already returns the full removed-id list — it's
  just not shown).
- **Auto Allocate's strategy select** ("quality" / "balanced" / "cost") has
  zero explanation of what each does — a tooltip or short caption would
  help a first-time user pick correctly.
- The **draft-project empty state** ("No plan yet — describe the project
  below and run Live Planning to get started.") is good instinct — it's
  the one place in the app that guides the user to the next action. Worth
  extending that pattern everywhere else.

### QC / acceptance-criteria review (`PlanReview.tsx`)
Renders after a successful planning run, before commit. For a real 5-module
plan (10 acceptance criteria) this becomes a **very long unstructured
scroll** — every module is a thin-bordered box with no collapse/expand, no
sticky module headers, and criteria rows are cramped three-field forms
(statement input, type select, verification input) where longer verification
commands visibly truncate (`pnpm test -- email-s…`) because the field is
fixed at `55%` width in a 340px-ish column. Also missing:
- No way to **add or remove** a criterion — only edit existing ones.
- No visibility into the **module dependency graph** while reviewing QC —
  you're reviewing acceptance criteria for `prefs` without being able to
  see that it depends on `email-sender` and `push-sender`.
- No indication of module `complexity`/`risk` here either (it's known at
  this point, just not surfaced) — useful context while judging whether
  proposed verification is adequate.

### PM Dashboard (`Dashboard.tsx`)
Reached via "PM Dashboard →" from inside a project. **This is the most
functionally confusing screen in the app**: it shows a completely different,
hardcoded demo project (`contracts`, `db-schema`, `auth`, `api-core`...) —
not the project you just came from. That's a backend/wiring gap (the
dashboard is still the Phase 6 scripted demo, intentionally decoupled per
`main.ts`), but from a pure UI standpoint it's worth flagging loudly: a user
clicking "PM Dashboard" from "Notifications Service" and landing on unrelated
data with no explanation will assume the app is broken. At minimum, this
screen needs a visible "demo data" label until it's wired to the real
project; ideally, raise this as a product question rather than silently
shipping a nicer-looking version of the same confusion.

Other issues on this screen: it does have more structure than the rest of
the app (bordered cards for Progress/Cost/Nodes/Blocked/Timeline — closest
thing to an intentional layout anywhere), but numbers are presented raw with
no charts (a progress percentage with no bar/ring, a cost breakdown with no
visual proportion), status is text-color-only ("integrated" green, "blocked"
presumably red/orange), and the **Timeline panel prints raw internal
identifiers** — e.g. `project.created proj_50645e7e-7f0f-41b9-8a40-
b1dc102a6ea9 Notifications Service` — a UUID leaking directly into
human-facing copy.

## Suggested priority order

1. **Establish the design system first** (tokens + a handful of primitive
   components: Button, Card, Badge, TextField, Select, ErrorBanner,
   EmptyState). Everything else is faster and more consistent once this
   exists.
2. **Unify the visual identity** end to end (carry Login's dark+accent
   language everywhere, or deliberately choose and apply a different one —
   just make it one decision, not five).
3. **Projects + Login** — landing experience, first impression, lowest
   interaction complexity. Good place to prove the new system out.
4. **Project graph editor sidebar** — restructure the six stacked sections
   into real visual groups (tabs, cards, or an accordion); fix the node
   inspector's raw JSON dump; add risk/status color coding to graph nodes;
   add a confirm step on destructive node deletes.
5. **QC review screen** — add expand/collapse per module, fix truncated
   verification fields, surface dependency + complexity/risk context.
6. **Dashboard** — polish once the "shows the wrong project" question is
   resolved (flag this to the user rather than deciding it unilaterally).

## Reference: API surface the UI talks to

All under `Authorization: Bearer <token>`, all project-scoped except
`/api/projects` itself:

```
GET    /api/projects
POST   /api/projects                          { name, description, pm_provider }
GET    /api/projects/:id
GET    /api/projects/:id/graph
POST   /api/projects/:id/graph/edges           { from, to }
DELETE /api/projects/:id/graph/edges           { from, to }
POST   /api/projects/:id/graph/nodes           { id, title, complexity?, risk?, dependencies? }
DELETE /api/projects/:id/graph/nodes/:nodeId?mode=reparent|cascade
POST   /api/projects/:id/graph/allocate        { strategy: "quality"|"balanced"|"cost" }
POST   /api/projects/:id/graph/nodes/:nodeId/assignment   { model?, budget_usd?, ... }
POST   /api/projects/:id/graph/approve-allocation
POST   /api/projects/:id/plan                  { objective, maxRounds? }   → 501 if provider keys missing
POST   /api/projects/:id/plan/load             { plan }
GET    /api/dashboard                          (currently the unrelated demo project, see above)
```

Full implementation: `apps/server/src/server.ts`. Response/error shapes
(404 unknown project, 409 not-planned-yet / cycle / unallocated, 422
invalid plan, 501 missing keys) are already sensible — the UI should surface
them more legibly than a single red line of raw `message` text.
