// Shared driver for App-level regression tests (UI-1, UI-2, UI-3, UI-6, UI-7):
// these bugs live inside ProjectGraph, a local/unexported component in
// App.tsx, so the only way to exercise them without editing production code
// is to render the real, exported <App/> and drive it like a user — seed a
// session token, mock fetch, open a project from the list.
import { render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { App } from "../App";
import { setToken } from "../auth";

/** Seed sessionStorage the same way a real login would (see auth.ts) so
 *  <App/> skips the Login screen and renders Projects directly. */
export function seedAuth(token = "test-token"): void {
  setToken(token);
}

/** Render <App/> (Projects list first) and click through into the named
 *  project's graph workspace. Caller is responsible for having mocked
 *  GET /api/projects and GET /api/projects/:id/graph beforehand. */
export async function renderAppAndOpenProject(projectName: string): Promise<{ user: UserEvent }> {
  const user = userEvent.setup();
  render(<App />);
  const row = await screen.findByRole("button", { name: new RegExp(projectName, "i") });
  await user.click(row);
  return { user };
}
