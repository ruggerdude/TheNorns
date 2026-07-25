# Existing-project adoption — visual handoff

**Audience:** visual/UI implementation agent
**Status:** functional workflow implemented; visual refinement pending

## Product contract

Adoption is a short path, not a configuration wizard:

1. The user chooses **Existing**.
2. The user chooses **GitHub repository** or **Local folder**.
3. The user selects one reusable repository.
4. The user may answer **What should The Norns do first?**
5. The user selects **Adopt project**.

Everything else is derived or automatic:

- Project name comes from the repository name.
- Project description comes from the optional direction, repository
  description, or a neutral “Continue development of …” fallback.
- The default coordinator, automatic cross-provider reviewer, verification
  policy, and three planning rounds are used.
- Repository analysis always runs after creation.
- If the optional direction is non-empty, a planning run starts after
  analysis. If it is blank, the analyzed project opens without creating a
  plan.

Do not add name, model, reviewer, policy, runner, path, or round-count inputs
to the adoption path. “Advanced options” that do not change behavior should
not be added.

## Setup boundary

GitHub authorization/installations and local-helper installation/pairing belong
to **Settings → Connections**. The project wizard may show readiness and an
**Open Connections** action, but it must not perform setup itself.

The Connections screen owns:

- GitHub identity and reusable account/organization installations.
- Local-helper readiness and its one-time setup command.
- **Add local repository**, which opens the native folder picker.
- The reusable inventory of approved local repositories.

Raw local paths must never be displayed. Use repository display name, branch,
and abbreviated commit only.

## Screen hierarchy

Keep the existing modal and component language, but make the adoption path
read as one compact decision surface:

1. New/Existing segmented choice.
2. GitHub/Local segmented choice.
3. Repository selector as the dominant content.
4. Optional first-direction field, visually secondary.
5. One primary **Adopt project** action.

The repository selector should make the current selection unmistakable without
adding a separate confirmation screen. For GitHub, preserve search/pasted-URL
matching and account selection when more than one installation exists. For
local sources, show only repositories already approved in Connections.

## Transition states

After submission, keep the user in the same modal and show a simple two-stage
progress narrative:

1. **Understanding the repository** — bounded committed files are being
   analyzed and architecture/constraints/verification facts are being
   recorded.
2. **Starting the first plan** — shown only when optional direction was
   supplied.

The visual treatment should communicate forward motion without exposing
internal service names, token mechanics, or runner identifiers.

On failure, preserve the already-created project and show:

- A concrete error.
- **Retry**, which resumes analysis/planning without creating another project.
- **Open project anyway**, which leaves the recoverable analysis step visible
  in the project workspace.

## Copy guidance

Prefer:

- “Approved local repositories”
- “Open Connections”
- “Understanding the repository”
- “What should The Norns do first? (optional)”
- “Leave blank to adopt and understand the repository without starting a
  plan.”

Avoid:

- “Runner,” “pairing code,” “workspace ID,” or “selection token” in project
  creation.
- Claims that uncommitted files are analyzed. Local analysis reads committed
  `HEAD`.
- Copy implying the optional direction is required.

## Responsive and accessibility requirements

- Preserve native buttons, fields, `fieldset`/`legend`, labels, focus rings,
  and `aria-pressed` selection state.
- Keep the primary action reachable without horizontal scrolling.
- On narrow screens, stack source choices and repository metadata; do not
  truncate the repository name before its owner.
- Loading states require text, not animation alone.
- Error recovery actions must remain keyboard reachable and distinguishable
  without color.

## Functional seams that visual work must preserve

- `SettingsTab` routing to `connections`.
- `GET /api/runners/helper/repositories` for reusable local inventory.
- `POST /api/runners/helper/repositories/choose` only from Connections.
- `POST /api/v2/projects/:id/analyze-repository` before optional planning.
- Retry against the existing project ID.
- No browser/server transport of raw Mac paths.
