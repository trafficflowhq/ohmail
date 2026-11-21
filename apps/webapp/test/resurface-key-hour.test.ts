import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { sliceOfDeclaration } from "./source-anchor";

/**
 * THE KEY'S RETURN IS ONE OF THE CHOOSER'S: `b` (and the palette's Resurface) books tomorrow at the hour the chooser
 * shows, never a horizon the chooser cannot produce. Moved from `triage-keys.test.tsx`, whose other cases walk today's
 * Triage view, and re-pointed by path: the two verbs that mint the key's horizon are app-logic's press
 * (`press/message-verbs.ts` for one letter, `press/selection-verbs.ts` for a selection), fed the consent row by the
 * Ohbox's live verbs; the reader's own quick return is `reader/actions/use-verbs.ts`; the chooser is
 * `reader/actions/ResurfaceMenu.tsx`, filled from the room's hour, which the ground's consent mount hands from the same
 * row. The claim is unchanged.
 */
const read = (rel: string): string => readFileSync(resolve(process.cwd(), rel), "utf8");

const MESSAGE_VERBS = "packages/app-logic/src/press/message-verbs.ts";
const SELECTION_VERBS = "packages/app-logic/src/press/selection-verbs.ts";
const READER_VERBS = "packages/app/src/reader/actions/use-verbs.ts";
const CHOOSER = "packages/app/src/reader/actions/ResurfaceMenu.tsx";
const PANEL = "packages/app/src/reader/actions/ActionBar.tsx";
const MENUS = "packages/app/src/reader/actions/ActionMenus.tsx";
const CONSENT_MOUNT = "packages/app/src/mail/ground/ConsentMount.tsx";
const OHBOX_VERBS = "packages/app-logic/src/ohbox/live-verbs.ts";

describe("TRI-F11 — `b` matches the picker and is reversible", () => {
  it("the keyboard default IS a picker option — tomorrow, at the hour the strip shows", () => {
    // The picker's presets are tomorrow / next week at the account's hour; the keyboard and palette default once
    // used `nextFridayNine`, a horizon the picker cannot produce. SINCE mail 0110 the preset takes an HOUR: the key
    // and the chooser must agree about WHICH hour, so a key that kept minting 09:00 after somebody set 14:30 goes red
    // here. Each site that mints the key's horizon is asked apart: one of the pair was fixed alone once.
    const sites = [MESSAGE_VERBS, SELECTION_VERBS, READER_VERBS].map((p) => [p, read(p)] as const);
    for (const [where, text] of sites) {
      expect(text, `${where} mints the retired Friday horizon`).not.toMatch(/nextFridayNine/);
      // Neither site may mint a bare 09:00 any more — the `*Nine` wrappers belong to send later.
      expect(text, `${where} mints a bare 09:00`).not.toMatch(/tomorrowNine/);
    }
    // `.iso`: both verbs take the instant off the same horizon value, at the press (`nowAt()`), from the account's
    // stored hour on the consent row the Ohbox's verbs are handed.
    expect(sliceOfDeclaration(read(MESSAGE_VERBS), "pressResurface"), "the single-message verb")
      .toMatch(/const when = tomorrowAt\(nowAt\(\), cx\.consent\.resurfaceTime\)\.iso;/);
    expect(sliceOfDeclaration(read(SELECTION_VERBS), "pileSet"), "the selection verb").toMatch(
      /const when = action === "resurface" \? tomorrowAt\(nowAt\(\), cx\.consent\.resurfaceTime\)\.iso : null;/,
    );
    // The reader's own quick return books the chooser's own Tomorrow, at the room's hour, minted at the press.
    expect(read(READER_VERBS), "the reader's quick return").toMatch(
      /action = `resurface:\$\{resurfaceHorizonsIn\(new Date\(\), hour\.stored, readerZone\(\)\)\.tomorrow\.iso\}`;/,
    );
    // …and the chooser fills its control from the SAME field: the consent row's hour, handed to the room by the
    // ground's consent mount, read by the panel and given to the chooser; the Ohbox's verbs read the same row.
    expect(read(CONSENT_MOUNT)).toMatch(/useRoomResurface\(\{ stored: row\.resurfaceTime,/);
    expect(read(OHBOX_VERBS)).toMatch(/const consent = useConsent\(\);/);
    expect(read(PANEL)).toMatch(/const hour = useResurfaceTime\(\)/);
    expect(read(PANEL)).toMatch(/<ActionMenus\b[\s\S]*?hour=\{hour\}/);
    expect(read(MENUS)).toMatch(/<ResurfaceMenu\b[\s\S]*?stored=\{hour\.stored\}/);
    const chooser = read(CHOOSER);
    expect(chooser).toMatch(/resurfaceClock\(stored\)/);
    expect(chooser).toMatch(/resurfaceHorizonsIn\(now, at, zone\)/);
  });
});
