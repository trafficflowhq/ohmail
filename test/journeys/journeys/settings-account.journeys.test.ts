import { expect } from "vitest";
import { paneGuards, paneJourneys, openPane } from "../bench/panes.js";
import { WEB, journey, journeysOf, type Guard } from "../bench/web.js";

const PANE = paneGuards("settings-account");
export const GUARDS: Guard[] = [
  ...PANE,
  { title: "Account offers a change of password, sign out and the account's deletion", rows: [], surfaces: WEB, needs: [] },
];

journeysOf("settings-account", () => {
  paneJourneys("settings-account", PANE, "sign-out");
  journey(GUARDS[PANE.length]!, async (b) => {
    const { person } = await openPane(b, "settings-account", "sign-out");
    await person.see("change-password");
    expect((await person.spoken("erase-begin")).disabled).toBe(true);
  });
});
