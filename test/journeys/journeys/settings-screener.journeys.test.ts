import { expect } from "vitest";
import { paneGuards, paneJourneys, openPane } from "../bench/panes.js";
import { WEB, journey, journeysOf, type Guard } from "../bench/web.js";

const PANE = paneGuards("settings-screener");
export const GUARDS: Guard[] = [
  ...PANE,
  { title: "Turning on \"Keep my Ohbox for what's relevant\" reaches the account", rows: [], surfaces: WEB, needs: [] },
];

journeysOf("settings-screener", () => {
  paneJourneys("settings-screener", PANE, "posture");
  journey(GUARDS[PANE.length]!, async (b) => {
    const { person } = await openPane(b, "settings-screener", "posture");
    const before = b.heard.filter((h) => h.method === "PATCH" && h.pattern === "/account/screening").length;
    await person.act("press", "posture");
    // The far end: the server took the write, and answered it.
    await person.until(async () => b.heard.filter((h) => h.method === "PATCH" && h.pattern === "/account/screening" && h.status === 200).length > before,
      "the server to take the new preference");
    expect((await person.spoken("posture")).disabled).toBe(false);
  });
});
