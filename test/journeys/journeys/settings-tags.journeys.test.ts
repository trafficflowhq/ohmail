import { expect } from "vitest";
import { paneGuards, paneJourneys, openPane } from "../bench/panes.js";
import { EVERY_WEB, WEB, journey, journeysOf, signedIn, type Guard } from "../bench/web.js";

const PANE = paneGuards("settings-tags");
export const GUARDS: Guard[] = [
  ...PANE,
  { title: "A tag made in Settings is in the rail at once", rows: [], surfaces: EVERY_WEB, needs: [] },
  {
    // Open: Settings is drawn again when the account's mailboxes arrive, and the box comes back empty.
    title: "Words typed into the new tag's box before the mailboxes have arrived are still there after",
    rows: [], surfaces: WEB, needs: [], open: true,
  },
];

journeysOf("settings-tags", () => {
  paneJourneys("settings-tags", PANE, "tag-new");
  journey(GUARDS[PANE.length]!, async (b) => {
    const { person } = await openPane(b, "settings-tags", "tag-new");
    await person.act("type", "tag-new", { value: "Kiln notes" });
    await person.act("press", "tag-add");
    await person.see("rail-tag", { named: "Kiln notes" });
  });
  journey(GUARDS[PANE.length + 1]!, async (b) => {
    b.faults.push((method, pattern) => (method === "GET" && pattern === "/mailboxes" ? "hold" : null));
    const { person } = await signedIn(b);
    await person.arrive("settings-tags");
    await person.until(async () => b.held().length > 0, "the app to ask for the mailboxes");
    await person.act("type", "tag-new", { value: "Kiln notes" });
    b.release();
    // Mailboxes joins the menu once the mailboxes have arrived.
    await person.see("menu-settings-mailboxes");
    expect(await person.holds("tag-new")).toBe("Kiln notes");
  });
});
