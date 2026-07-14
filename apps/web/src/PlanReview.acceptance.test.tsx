// UI-4 regression: a module can have every acceptance criterion removed and
// "Load into graph" does not disable. PlanReview.tsx's disable check is
//   modules.some((m) => m.acceptance.some((c) => !c.statement.trim() || ...))
// `.some()` on an empty array is vacuously false, so a 0-criteria module
// doesn't block submission — the server correctly 400s it, but the UI never
// should have let the human get there.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { PlanReview } from "./PlanReview";
import { makeCoreApiModule, makePlan, makePlanResult, makeWebUiModule } from "./test/fixtures";

describe("UI-4: empty-acceptance module must block commit", () => {
  test("removing every criterion from a module keeps 'Load into graph' disabled", async () => {
    const user = userEvent.setup();
    const plan = makePlan({
      modules: [
        makeCoreApiModule({
          // Exactly one criterion, so a single "Remove criterion" click empties it.
          acceptance: [
            {
              id: "ac-only",
              statement: "Something is true",
              verification_type: "test",
              verification: "pnpm test",
            },
          ],
        }),
        makeWebUiModule(),
      ],
    });

    render(
      <PlanReview
        result={makePlanResult({ plan })}
        committing={false}
        onCancel={() => {}}
        onCommit={() => {}}
      />,
    );

    // The Core API module is the first (open={mi === 0}) — its "Remove
    // criterion" button is already visible without expanding anything.
    const [removeButton] = screen.getAllByRole("button", { name: /remove criterion/i });
    expect(removeButton).toBeDefined();
    await user.click(removeButton as HTMLElement);

    const commitButton = screen.getByTestId("load-into-graph");
    expect(commitButton).toBeDisabled();
  });
});
