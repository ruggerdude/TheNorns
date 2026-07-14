// UI-5 regression lock-in: believed already fixed by the accordion redesign
// (`<details open={mi === 0}>` with a stable `key={m.id}`) — manual expansion
// of a module's accordion should survive re-renders caused by editing an
// unrelated field elsewhere in the plan. This test is the one exception in
// this suite: it is expected to PASS today. If it fails, that's a genuine
// regression worth reporting, not a bug in the test.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test } from "vitest";
import { PlanReview } from "./PlanReview";
import { makeCoreApiModule, makePlan, makeWebUiModule } from "./test/fixtures";

describe("UI-5: manual accordion expansion survives unrelated edits", () => {
  test("expanding the second module, then editing the first, leaves the second expanded", async () => {
    const user = userEvent.setup();
    const plan = makePlan({
      modules: [makeCoreApiModule(), makeWebUiModule()],
    });

    render(<PlanReview plan={plan} committing={false} onCancel={() => {}} onCommit={() => {}} />);

    // web-ui (module index 1) starts collapsed (open={mi === 0} only opens
    // index 0) — jsdom keeps <details> children in the DOM tree regardless
    // of the open attribute (no layout engine), so assert on visibility
    // (which jest-dom derives from the ancestor <details>'s open state)
    // rather than presence.
    expect(screen.getByTestId("ac-statement-web-ui-0")).not.toBeVisible();

    // Manually expand the second module's <details> via its <summary>.
    const [, webUiSummary] = screen.getAllByText(/· \d+ criteria/i);
    expect(webUiSummary).toBeDefined();
    await user.click(webUiSummary as HTMLElement);
    expect(screen.getByTestId("ac-statement-web-ui-0")).toBeVisible();

    // Now edit an unrelated field on the FIRST module — this triggers a
    // setModules() state update and a re-render of the whole list.
    const firstStatementInput = screen.getByTestId("ac-statement-core-api-0");
    await user.type(firstStatementInput, " (edited)");

    // The second module's accordion should still be open — a stable
    // key={m.id} means React reuses the same <details> DOM node rather than
    // remounting it, so the browser-native (uncontrolled) open state isn't
    // reset by the re-render.
    expect(screen.getByTestId("ac-statement-web-ui-0")).toBeVisible();
  });
});
