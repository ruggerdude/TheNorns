---
name: full-scope-pm
description: Perform a full-scope audit and remediation of The Norns' mobile browser experience. Use whenever the user invokes /full-scope-pm or asks for the full mobile audit/remediation pass — responsive-browser work on the existing web app, not a native mobile application.
---

Perform a full-scope audit and remediation of The Norns' mobile browser experience.

## Outcome

Make the existing responsive web application reliable and comfortable on modern phones. This is responsive-browser work only, not a native mobile application.

## Scope

- Audit all primary user journeys at 320px, 375px, 390px, and 412px widths.
- Cover authentication, Portfolio, project creation/adoption, project workspace navigation, conversations, plan handoff, QC activity, Usage, Settings, and Administration.
- Fix horizontal overflow, clipped or unreachable controls, poor touch targets, broken drawers, dialogs that exceed the viewport, unreadable dense content, unsafe fixed heights, keyboard/scrolling problems, and missing safe-area handling.
- Ensure tables, code blocks, menus, forms, alerts, and long text behave sensibly on narrow screens.
- Preserve current desktop and tablet behavior.
- Preserve all existing product workflows and accessibility semantics.
- Do not introduce a new design system, native application, unrelated refactor, or feature expansion.

## Verification

- Add or strengthen automated responsive tests for representative phone viewports.
- Verify that primary journeys have no document-level horizontal overflow.
- Verify navigation drawers, conversation controls, forms, menus, and dialogs are visible and operable.
- Perform real browser inspection of the completed mobile experience, not just static CSS review.
- Run the relevant formatting, linting, type-checking, unit, build, and Playwright test suites.
- Confirm existing desktop coverage still passes.

## Completion

- Deliver all verified fixes.
- Document any remaining limitations that cannot safely be resolved within scope.
- Deliver as follows: stage only task-related changes, commit them, push to GitHub main, verify local main matches origin/main, and verify the automatic Railway deployment and live application health (`GET /health` returns `{"ok":true,...}` — see [DEPLOY.md](../../../DEPLOY.md)).
