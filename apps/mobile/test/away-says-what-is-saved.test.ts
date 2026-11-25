/**
 * THE AWAY SWITCH SAYS WHAT IS SAVED, ON THE PHONE TOO.
 *
 * The line under the On/Off segments read the segment's position, so "On. Replies to new mail"
 * stood over a responder that was still off until Save, and Back dropped the edit in silence.
 * The rules are pure (`src/ui/away-form.ts`) and driven as data; the screen's wiring to them is
 * read from its source, the way the other phone screens are held (`send-later-not-on-this-phone`).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DECKS } from "../src/copy";
import {
  awayFailedLine, awaySavedUntil, awayStatedLine, awayUnsaved, awayUnsavedLine, type AwayRow,
} from "../src/ui/away-form";
import web from "../../webapp/messages/en.json";

const SCREEN = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../app/away.tsx"), "utf8");

const off: AwayRow = {
  enabled: false, body: "Back Monday", startsAt: null, endsAt: null,
  audience: "screened_in", throttle: "per_day", piles: ["INBOX"], updatedAt: "t0",
};
const on: AwayRow = { ...off, enabled: true };

describe("the line states the saved row", () => {
  it("a saved OFF reads Off whatever the segment says; a saved ON reads On; no read, no line", () => {
    expect(awayStatedLine(off)).toBe(DECKS.en.awayOff);
    expect(awayStatedLine(on)).toBe(DECKS.en.awayOn);
    expect(awayStatedLine(null)).toBeNull();
  });

  it("the screen draws that line, and not the segment's position", () => {
    expect(SCREEN).toContain("{awayStatedLine(read) ?? \" \"}");
    expect(SCREEN).not.toContain("{enabled ? Copy.awayOn : Copy.awayOff}");
  });
});

describe("an unsaved change is named, and leaving with one asks", () => {
  it("switching on over a saved OFF is unsaved, and says the responder stays off", () => {
    expect(awayUnsaved(off, { enabled: true, body: "Back Monday", endsAt: null })).toBe(true);
    expect(awayUnsavedLine(off)).toBe(DECKS.en.awayUnsavedStillOff);
    expect(awayUnsavedLine(on)).toBe(DECKS.en.awayUnsavedStillOn);
  });

  it("the message and the end date are edits too", () => {
    expect(awayUnsaved(off, { enabled: false, body: "Back Tuesday", endsAt: null })).toBe(true);
    expect(awayUnsaved(off, { enabled: false, body: "Back Monday", endsAt: "2036-01-01T22:59:59.999Z" })).toBe(true);
  });

  it("CONTROL: the stored row is no change — an emptied message is the absent one, an instant by its time", () => {
    expect(awayUnsaved(off, { enabled: false, body: "Back Monday", endsAt: null })).toBe(false);
    expect(awayUnsaved({ ...off, body: null }, { enabled: false, body: "  ", endsAt: null })).toBe(false);
    const at = "2036-01-01T22:59:59.999Z";
    expect(awayUnsaved({ ...off, endsAt: at }, { enabled: false, body: "Back Monday", endsAt: "2036-01-01T23:59:59.999+01:00" })).toBe(false);
    expect(awayUnsaved(null, { enabled: true, body: "x", endsAt: null })).toBe(false);
  });

  it("the screen holds the stack on it, asks, and Discard puts the saved row back before it goes", () => {
    expect(SCREEN).toContain("const unsaved = awayUnsaved(read, edits);");
    expect(SCREEN).toContain("usePreventRemove(unsaved && !saving, ({ data }) => setLeaving({ action: data.action }));");
    expect(SCREEN).toContain("<SheetRow label={Copy.awayLeaveDiscard} onPress={discardAndLeave} />");
    expect(SCREEN).toMatch(/if \(read !== null\) adopt\(read\);\s+if \(held !== null\) navigation\.dispatch\(held\.action\);/);
    expect(SCREEN).toMatch(/\{unsaved && read !== null \? \(\s*<View[^>]*>\s*<Txt[^>]*>\{awayUnsavedLine\(read\)\}<\/Txt>/);
  });
});

describe("the end date and a failed save speak for the SAVED row (REVIEW-026 H1, H2)", () => {
  const NOW = new Date("2026-10-09T12:00:00.000Z");
  const later = "2036-09-14T21:59:59.999Z";
  it("'On until' only while the saved row is on; a saved OFF with a stored date says nothing", () => {
    expect(awaySavedUntil({ ...off, endsAt: later }, NOW)).toBeNull();
    expect(awaySavedUntil({ ...on, endsAt: later }, NOW)).toBe("onUntil");
    expect(awaySavedUntil({ ...on, endsAt: "2020-01-02T23:59:59.000Z" }, NOW)).toBe("expired");
    expect(awaySavedUntil(on, NOW)).toBeNull();
    expect(awaySavedUntil(null, NOW)).toBeNull();
  });

  it("the screen draws the until sentence from the saved row, never from the edit", () => {
    expect(SCREEN).toContain("const savedUntil = awaySavedUntil(read, now);");
    expect(SCREEN).toContain("Copy.awayUntilOn(setTimeLabel(read.endsAt, now, zone))");
    expect(SCREEN).not.toContain("Copy.awayUntilOn(setTimeLabel(endsAt, now, zone))");
  });

  it("a failed save names the saved state, not the switch's position, and the edit stays pending", () => {
    expect(awayFailedLine(off)).toBe(DECKS.en.awayFailedStillOff);
    expect(awayFailedLine(on)).toBe(DECKS.en.awayFailedStillOn);
    expect(SCREEN).toContain(": awayFailedLine(read)}");
    expect(SCREEN).not.toContain("enabled ? Copy.awayFailedStillOn : Copy.awayFailedStillOff");
    /* The refused branch returns before `adopt`, so the switch keeps the edit and it reads unsaved. */
    expect(SCREEN).toContain('if (out.kind === "refused") { setSaid("failed"); return; }');
  });

  it("the leave sheet has one way out: Keep editing, with the primitive's Cancel row withdrawn", () => {
    expect(SCREEN).toContain("label={Copy.awayLeaveAsk} cancel=\"own\">");
  });
});

describe("the sentences are the web's", () => {
  it("word for word in English, and present in German", () => {
    expect(DECKS.en.awayUnsavedStillOff).toBe(web.away.unsavedStillOff);
    expect(DECKS.en.awayUnsavedStillOn).toBe(web.away.unsavedStillOn);
    expect(DECKS.en.awayLeaveAsk).toBe(web.away.leaveAsk);
    expect(DECKS.en.awayLeaveDiscard).toBe(web.away.leaveDiscard);
    expect(DECKS.en.awayLeaveKeep).toBe(web.away.leaveKeep);
    expect(DECKS.de.awayLeaveDiscard).toBe("Änderungen verwerfen");
  });
});
