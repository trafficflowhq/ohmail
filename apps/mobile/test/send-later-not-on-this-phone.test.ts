/**
 * ═══ SEND LATER IS NOT OFFERED WHERE NOTHING WILL KEEP IT ══════════════════════════════════════
 *
 * A phone that organizes its own mailbox is the install that would have to keep an appointment,
 * and it organizes only while ohmail is running on it — so the promise cannot be made. The engine
 * refuses the verb (409, `apps/sidecar/src/composition-passes.ts`); this file is the other half,
 * so the control is WITHHELD rather than failing after the pick.
 *
 * A PAIRED phone keeps the offer, and that half has its own cases: there the appointment is kept
 * by the install the phone is paired to — a computer, a self-host box, ohmail Cloud — and that
 * install stays on. A file that only exercised the withholding arm would pass over the regression
 * it is most likely to cause.
 *
 * ── WHY THE DECISION IS DRIVEN AND THE MARKUP IS READ ─────────────────────────────────────────
 *
 * There is no React Native renderer in this workspace (`react-test-renderer` and
 * `@testing-library/react-native` are absent from the store — `test/fourth-door.test.ts` and
 * `test/locale.test.ts` both record it), so a mounted-screen case would not be a stricter test,
 * it would be no test. The decision therefore lives in `src/ui/standalone-form.ts` and is driven
 * directly; what a render would have added — is the decision actually wired to the markup — is
 * asserted by reading the two files, which fails if either stops using it.
 *
 * ── HOW TO WATCH IT FAIL ─────────────────────────────────────────────────────────────────────
 *
 * Drop `!o.standalone` from `sendLaterOffered` and the predicate's standalone case reddens while
 * the forward cases stay green; put the composer's button back on a bare `!forward` and the
 * wiring case reddens; delete either render of `Copy.scheduledNotOnThisPhone` and its own case
 * reddens; change the sentence to say "only while ohmail is open" and the claims case reddens,
 * because `phoneStandaloneL1Android` says a phone organizes behind a notification. All four
 * mutations were run and each restore was verified by `cmp`.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DECKS } from "../src/copy";
import { scheduledNotHereSentence, sendLaterOffered } from "../src/ui/standalone-form";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(APP, rel), "utf8");
const COMPOSER = read("src/ui/MessageActions.tsx");
const SCHEDULED = read("app/scheduled.tsx");
const WORLD = read("src/state/world.tsx");
const PAIRING = read("src/net/pairing.ts");

describe("send later, where an appointment can be kept and where it cannot", () => {
  it("THE PREDICATE — a paired reply is offered the appointment, a standalone reply is not", () => {
    // The positive control FIRST: a rule that refused everything would satisfy every other case
    // in this file.
    expect(sendLaterOffered({ standalone: false, forward: false, hasAttachments: false })).toBe(true);
    expect(sendLaterOffered({ standalone: true, forward: false, hasAttachments: false })).toBe(false);
  });

  it("THE ATTACHMENTS ARM — a draft row stores no files, so an attached reply loses the appointment", () => {
    // The webapp's own withheld affordance (`sendLaterUnavailable`); drop `!o.hasAttachments`
    // from the predicate and this row reddens while the two above stay green.
    expect(sendLaterOffered({ standalone: false, forward: false, hasAttachments: true })).toBe(false);
    // …and the composer says WHY, only where attachments are the reason (each absence its own note).
    expect(COMPOSER).toContain("{!w.standalone && !forward && attachments.length > 0 ? (");
    expect(COMPOSER).toContain("{Copy.sendLaterUnavailable}");
  });

  it("THE PRE-EXISTING REASON is untouched — a forward wears no appointment on either door", () => {
    // A draft row stores no forward reference (§14). This was the only reason before and it is
    // still a reason, so the widening cannot have replaced it.
    expect(sendLaterOffered({ standalone: false, forward: true, hasAttachments: false })).toBe(false);
    expect(sendLaterOffered({ standalone: true, forward: true, hasAttachments: false })).toBe(false);
  });

  it("THE DOOR IS DERIVED FROM THE SESSION'S ORIGIN, in the layer that composes the session", () => {
    /* `bootEngine` refuses a local engine handed any other address, so the origin IS the door's
       identity — a second flag could disagree with it, and this is what keeps one from appearing. */
    expect(PAIRING, "the connection layer derives the door from something other than the origin")
      .toContain("standalone: profile.origin === LOCAL_ENGINE_ORIGIN");
    /* AND THE WORLD CARRIES IT RATHER THAN RE-DERIVING IT. A second derivation in `state/` would
       also be a state module reaching into `engine/` for the constant, which `privacy.test.ts`
       refuses — the screens reach the network through the connection layer and nowhere else. */
    expect(WORLD).toContain("standalone: session.standalone");
    expect(WORLD, "the world reaches into the engine composition for the constant")
      .not.toMatch(/from ["'][^"']*\/engine\/(?:boot|native)["']/);
    /* AND THE EMPTY WORLD IS NOT THE STANDALONE ONE. `false` is the same answer a paired session
       gives, which is the safe one: every surface that reads this withholds something. */
    expect(WORLD).toContain("standalone: false");
  });

  it("THE COMPOSER withholds the button through that predicate, not through a bare forward check", () => {
    expect(COMPOSER, "the composer decides for itself instead of asking the predicate")
      .toContain("sendLaterOffered({ standalone: w.standalone, forward, hasAttachments: attachments.length > 0 })");
    expect(COMPOSER, "the Send later button is not gated on the predicate")
      .toMatch(/\{laterOffered \?\s*\(\s*<Button\s+label=\{Copy\.sendLater\}/);
    /* THE OLD FORM IS GONE. A button left on `!forward` would be green on every case above and
       still offered on a phone — the defect this file exists for, invisible to a predicate test. */
    expect(COMPOSER, "the button still renders on the pre-widening condition")
      .not.toMatch(/\{!forward \?\s*\(\s*<Button\s+label=\{Copy\.sendLater\}/);
  });

  it("THE SENTENCE IS RENDERED in both places a person looks for the control", () => {
    // The composer, where the button would have been — and only for the standalone reason: a
    // forward's absence is a different fact and has its own note. The sentence is chosen by the
    // phone's state: `scheduledNotHereSentence`, driven per state below.
    expect(COMPOSER).toContain("scheduledNotHereSentence(w.mailboxes.organizer)");
    expect(COMPOSER).toContain("w.standalone && !forward");
    // And the Scheduled screen, which is where somebody goes looking for a scheduled message.
    expect(SCHEDULED).toContain("scheduledNotHereSentence(w.mailboxes.organizer)");
    expect(SCHEDULED).toContain("w.standalone");
  });

  it("THE SENTENCE TELLS THE TRUTH PER STATE — organizing here, or reading what another install organizes", () => {
    // Organizing its own mailbox: the phone organizes only while ohmail runs.
    expect(scheduledNotHereSentence(null)).toBe(DECKS.en.scheduledNotOnThisPhone);
    // Reading a mailbox a desktop organizes: this phone organizes nothing, so "organizes your
    // mailbox only while ohmail is running" would be false, and the holder is the place to schedule.
    const reading = scheduledNotHereSentence({ name: "zorin-9950" });
    expect(reading).toBe(DECKS.en.scheduledReaderHere("zorin-9950"));
    expect(reading).not.toContain("organizes your mailbox only while");
    expect(reading).toContain("zorin-9950 organizes it");
    expect(DECKS.de.scheduledReaderHere("zorin-9950")).toContain("zorin-9950");
    // A holder that stopped organizes nothing: the sentence says so, in both decks.
    const lapsed = scheduledNotHereSentence({ name: "zorin-9950", stopped: true });
    expect(lapsed).toBe(DECKS.en.scheduledReaderHereStopped("zorin-9950"));
    expect(lapsed).not.toContain("zorin-9950 organizes it");
    expect(DECKS.de.scheduledReaderHereStopped("zorin-9950")).toContain("nicht mehr");
    // Nothing organizes it and nobody is named: this phone does not organize it either.
    expect(scheduledNotHereSentence({ name: "", stopped: true })).toBe(DECKS.en.phoneStateNotOrganized);
  });

  it("THE COPY is in both decks, translated, and says nothing the platform lines make false", () => {
    for (const [locale, deck] of Object.entries(DECKS)) {
      const line = deck.scheduledNotOnThisPhone;
      expect(typeof line, `${locale} has no sentence for a phone that keeps no appointments`)
        .toBe("string");
      expect(line.length, locale).toBeGreaterThan(40);
    }
    const en = DECKS.en.scheduledNotOnThisPhone;
    const de = DECKS.de.scheduledNotOnThisPhone;
    expect(de, "the German deck carries the English sentence").not.toBe(en);
    /* ── THE CLAIM, AGAINST THE PLATFORM LINES THE SAME DECK ALREADY SHIPS ──────────────────
     *
     * `phoneStandaloneL1Ios` says "It organizes while ohmail is open"; `phoneStandaloneL1Android`
     * says "while its notification is shown". ONE sentence covers both surfaces, so it may not
     * borrow the iOS wording — on Android that would be a statement the product makes false, and
     * the whole point of this copy is to be the true half of a refusal. */
    const ios = DECKS.en.phoneStandaloneL1Ios;
    expect(ios, "the iOS line no longer says what this guard is derived from")
      .toContain("while ohmail is open");
    expect(en, "the sentence claims the iOS rule on every platform").not.toContain("while ohmail is open");
    const iosDe = DECKS.de.phoneStandaloneL1Ios;
    expect(iosDe.length, "the German iOS line is missing").toBeGreaterThan(10);
    expect(de).not.toContain("solange ohmail geöffnet");
  });
});
