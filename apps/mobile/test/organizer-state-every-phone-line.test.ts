/**
 * EVERY OHBOX LINE ON THE PHONE FOLLOWS THE LIVE CLAIM (the desktop case's phone twin, and
 * the same on a paired phone). After the desktop handed a mailbox back, the strip said nothing
 * organizes it while the connect notice above still named the desktop and the knock below offered
 * "N new senders waiting · Screener", until a restart; and a paired phone never drew a gap offer its
 * server counted. The decisions are driven here through the real `claimHere`; that the screens use
 * them is read off the route, since this workspace has no React Native renderer (`fourth-door.test.ts`).
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { DECKS } from "../src/copy";
import { EN } from "../src/copy.en";
import { knockSlotOf, noneOrganizedWhy, notOrganizingSay } from "../src/ui/not-organizing";
import { claimHere, readingAtConnectLine, readingAtConnectNow } from "../src/ui/standalone-form";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string): string => readFileSync(join(APP, rel), "utf8");

const DESKTOP = "omarchy";
const here = (holderState: "held" | "stopped" | "none" | null) => ({
  organizing: false, releaseRequestedAt: null,
  heldBy: { name: DESKTOP, standDownReason: "organized_elsewhere:local", holderState },
});
const SAID = { name: DESKTOP };

describe("the connect notice follows the claim the strip reads", () => {
  it("names the desktop while it holds the mailbox, and drops once it hands it back — no restart", () => {
    const before = readingAtConnectNow(SAID, claimHere(here("held")));
    expect(before && readingAtConnectLine(before)).toBe(EN.readingAtConnect(DESKTOP));
    // The same session, one look later: the desktop released, the look reads nobody.
    expect(readingAtConnectNow(SAID, claimHere(here("none"))), "the notice outlived the hand-back").toBeNull();
    expect(readingAtConnectNow(SAID, claimHere(here("stopped"))), "a holder that stopped organizes nothing").toBeNull();
  });

  it("names the holder the claim names now, and an unnamed one by the unnamed sentence", () => {
    expect(readingAtConnectNow(SAID, { k: "theirs", name: "Studio Mac", kind: "local" })).toEqual({ name: "Studio Mac" });
    expect(readingAtConnectLine(readingAtConnectNow(SAID, { k: "theirsUnnamed", kind: "local" })!)).toBe(EN.readingAtConnectUnknown);
  });

  it("this phone organizing it, our own hand-back, a pause and a blocked gate drop it too", () => {
    expect(readingAtConnectNow(SAID, claimHere({ organizing: true, releaseRequestedAt: null, heldBy: null }))).toBeNull();
    expect(readingAtConnectNow(SAID, claimHere({ organizing: false, releaseRequestedAt: null, heldBy: null }, "idle", true))).toBeNull();
    expect(readingAtConnectNow(SAID, { k: "parked" })).toBeNull();
    expect(readingAtConnectNow(SAID, { k: "blocked", reason: "meta_folder_full", holding: false })).toBeNull();
  });

  it("CONTROL: a claim not read yet keeps what the connect said, and nothing said stays nothing", () => {
    expect(readingAtConnectNow(SAID, claimHere({ organizing: null, releaseRequestedAt: null, heldBy: null }))).toEqual(SAID);
    expect(readingAtConnectNow(null, claimHere(here("held")))).toBeNull();
    expect(readingAtConnectNow(SAID, null), "a paired session has no claim here").toBeNull();
  });
});

describe("the Ohbox's knock where nothing organizes any live mailbox", () => {
  it("gives way to the strip that already says it, and says the state itself where none does", () => {
    expect(knockSlotOf("stopped", true)).toEqual({ k: "none" });
    expect(knockSlotOf("stopped", false)).toEqual({ k: "state", why: "stopped" });
    expect(knockSlotOf("never_agreed", false)).toEqual({ k: "state", why: "never_agreed" });
  });

  it("CONTROL: where something organizes one, the knock stands whatever the strip says", () => {
    expect(knockSlotOf(null, true)).toEqual({ k: "knock" });
    expect(knockSlotOf(null, false)).toEqual({ k: "knock" });
  });

  it("the roster reading it asks: a hand-back on this wire reads as nothing organizing it", () => {
    const row = { status: "connected", organizerRole: "reader" as const, organizeConsentedAt: "2026-10-12T00:00:00Z", organizedBy: null, organizerState: null };
    expect(noneOrganizedWhy([row])).toBe("stopped");
    expect(noneOrganizedWhy([{ ...row, organizerRole: "organizer" as const }])).toBeNull();
  });

  it("says the waiting shelf's own sentence, never a filing promise, in both decks", () => {
    expect(notOrganizingSay("stopped")).toEqual({ title: EN.waitingNotOrganizedTitle, hint: EN.waitingNotYetHint, press: EN.waitingNotYetPress });
    expect(notOrganizingSay("never_agreed").title).toBe(EN.waitingNotYetTitle);
    for (const deck of Object.values(DECKS)) {
      expect(typeof deck.screeningNoteNobody).toBe("string");
      expect(deck.screeningNoteNobody.length).toBeGreaterThan(40);
    }
    expect(EN.screeningNoteNobody).not.toMatch(/files there|automatically/);
  });
});

describe("the screens read these decisions", () => {
  it("the Ohbox draws the notice and the knock slot from them, and the knock only in its own arm", () => {
    const ohbox = src("app/(tabs)/index.tsx");
    expect(ohbox).toMatch(/readingAtConnectNow\(w\.standalone \? readingAtConnectSaid\(\) : null, claim\)/);
    expect(ohbox).toMatch(/knockSlotOf\(w\.mailboxes\.known \? noneOrganizedWhy\(w\.mailboxes\.rows\) : null, strip !== null\)/);
    expect(ohbox).toMatch(/knock\.k === "knock" \? <Doorbell /);
    expect(ohbox.match(/<Doorbell /g), "a second, unconditional knock").toHaveLength(1);
  });

  it("a paired session draws the gap offer its server counted", () => {
    expect(src("src/ui/OrganizerStrip.tsx")).toMatch(/useWorld\(\)\.standalone \? <OnThisPhone \/> : <GapLetters \/>/);
  });

  it("both screening sheets say the state in place of the rule's promise", () => {
    expect(src("src/ui/MessageActions.tsx")).toMatch(/nobody \? Copy\.screeningNoteNobody : applyRetro \? Copy\.screeningNoteRetro/);
    const sheet = src("src/ui/SenderDetail.tsx");
    expect(sheet).toMatch(/nobody && relay === null \? Copy\.screeningNoteNobody : senderSheetLine\(relay, organizer\)/);
    expect(sheet).toMatch(/hint=\{nobody \? Copy\.screeningNoteNobody : ruleLine\}/);
    expect(sheet).toMatch(/shape\.explainer && !nobody \?/);
  });
});
