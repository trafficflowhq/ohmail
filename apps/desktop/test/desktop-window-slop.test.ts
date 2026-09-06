import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SLOP } from "@ohmail/fixtures";
import { DOOR_COPY } from "../src/door-copy.js";

/**
 * ═══ NO AI SLOP IN THE WINDOW'S OWN WORDS ══════════════════════════════════════════════════
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────────────
 *
 * The house rule — no "seamlessly", "effortlessly", "powerful", "simply", and no reassurance
 * nobody asked for — has been checkable on the LANDING PAGE for months, and nowhere else. The
 * desktop window has a namespace of its own (`desktopDoor`, 200-odd sentences), the host pane has
 * another (`host`), and neither was swept by anything. So the one surface where the product
 * introduces itself to a person who has just installed it was the surface with no guard on it.
 *
 * ── WHY THE SAME REGEX AND NOT A SECOND ONE ────────────────────────────────────────────────
 *
 * It is imported from the shared fixtures package rather than restated here. Two copies of a
 * banned-word list is precisely how one of them comes to permit a word the other refuses, and
 * this repository has measured that shape in other guards. One rule, two sweeps.
 *
 * ── AND BOTH LANGUAGES ─────────────────────────────────────────────────────────────────────
 *
 * A rule that only holds in English holds for half the product. The German renderings are in the
 * pattern for that reason, and every namespace below is swept in both catalogues.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (locale: string): Record<string, Record<string, string>> =>
  JSON.parse(fs.readFileSync(path.join(REPO, `apps/webapp/messages/${locale}.json`), "utf8"));

const EN = read("en");
const DE = read("de");

/** Whole namespaces the WINDOW owns — every sentence in them is the window's own writing. */
const WINDOW_NAMESPACES = ["desktopDoor", "host"] as const;

/**
 * And the three keys the paired door added to a SHARED namespace. Named individually rather than
 * sweeping `mailboxes` whole, because that namespace is the browser's too and its other hundred
 * keys are not this slice's to vouch for — a sweep that failed on somebody else's sentence would
 * be a guard that fires on innocent content, which is as bad as one that cannot fire.
 */
const MAILBOX_KEYS = [
  "desktopManageOnHost",
  "desktopManageOnHostWhy",
  "desktopHoldsCountHost",
] as const;

describe("the desktop window's own copy carries none of the banned vocabulary", () => {
  it("neither catalogue uses one, in either window namespace", () => {
    for (const [locale, m] of [["en", EN], ["de", DE]] as const) {
      for (const ns of WINDOW_NAMESPACES) {
        expect(m[ns], `${locale}.json has no "${ns}" namespace — update the list`).toBeDefined();
        const hit = SLOP.exec(JSON.stringify(m[ns]));
        expect(hit, `${locale}.json ${ns}: "${hit?.[0]}"`).toBeNull();
      }
    }
  });

  it("nor the three keys the paired door added to a shared namespace", () => {
    for (const [locale, m] of [["en", EN], ["de", DE]] as const) {
      for (const key of MAILBOX_KEYS) {
        const value = m.mailboxes?.[key];
        expect(value, `${locale}.json is missing mailboxes.${key}`).toBeTruthy();
        const hit = SLOP.exec(value!);
        expect(hit, `${locale}.json mailboxes.${key}: "${hit?.[0]}"`).toBeNull();
      }
    }
  });

  /**
   * AND THE CONSTANT IN THE SOURCE, not only the catalogue.
   *
   * `DOOR_COPY` falls back to an English constant in `door-copy.ts` whenever no catalogue is set
   * — which is the resting state in two dozen unit tests AND in a window whose locale has not
   * loaded yet. A word banned from `en.json` and left in the constant would be a word the product
   * still says, on the first frame of a cold start.
   */
  it("nor the English constant the window falls back to", () => {
    for (const [key, value] of Object.entries(DOOR_COPY)) {
      if (typeof value !== "string") continue;
      const hit = SLOP.exec(value);
      expect(hit, `door-copy.ts ${key}: "${hit?.[0]}"`).toBeNull();
    }
  });

  it("POSITIVE CONTROL — the sweep bites on the sentences it exists to stop", () => {
    /* A guard nobody has watched fail is not evidence. These four are the shapes that would
       actually be written into a setup screen. */
    expect(SLOP.test("Pairing is seamless — just paste the link")).toBe(true);
    expect(SLOP.test("a powerful way to share your mailbox")).toBe(true);
    expect(SLOP.test("Simply paste the pairing link.")).toBe(true);
    expect(SLOP.test("koppelt sich nahtlos mit deinem anderen Computer")).toBe(true);
    /* …and not on ordinary words that merely contain a stem, so it cannot fire on innocent copy. */
    expect(SLOP.test("simple, seams, die Mühe lohnt sich, power")).toBe(false);
  });

  /**
   * THE SWEEP IS NOT VACUOUS. A namespace renamed or a catalogue moved would make every case
   * above pass over an empty object.
   */
  it("the namespaces it sweeps are the real ones and are not empty", () => {
    expect(Object.keys(EN.desktopDoor!).length).toBeGreaterThan(200);
    expect(Object.keys(EN.host!).length).toBeGreaterThan(80);
    expect(Object.keys(DOOR_COPY).length).toBeGreaterThan(200);
  });
});

/**
 * ═══ EVERY SENTENCE THE PAIRED DOOR ADDED IS IN BOTH CATALOGUES ════════════════════════════
 *
 * The web app's general copy census already requires that every key the
 * CODE READS exists in both — it reads the `liveCopy` tables and the `t("…")` calls out of the
 * source. This list is the other direction: the keys this slice is REQUIRED to have added,
 * named explicitly, so that a key deleted along with its last call site is caught as a missing
 * feature rather than passing as a tidied-up unused string.
 *
 * It is written out rather than derived, and that is the point of it. A list computed from the
 * source would agree with the source by construction and could never disagree with it.
 */
const PAIRED_DOOR_KEYS = [
  // the tile and the card
  /* `hostLinkPlaceholder` is NOT on this list, and its absence is the rule rather than an
     oversight: it is a URL example (`https://…/pair#…`), deliberately byte-identical in both
     catalogues, and the translation case below would refuse it correctly. `desktop-door-copy`
     holds it in the six-key "deliberately identical" set instead, which is where the exemption
     belongs. */
  "doorHostName", "doorHostSay", "hostAskLead", "hostLink", "hostLinkHint",
  "hostCheck", "hostChecking", "hostReached", "hostReachedLanBefore", "hostReachedLanAfter",
  "hostReachedTs", "hostPairLead", "hostPair", "hostPairing",
  // every refusal, window-side and engine-side
  "hostLinkMissing", "hostLinkShape", "hostRefuseCleartext", "hostRefuseNoPin",
  "hostRefusePinChanged", "hostRefuseNotOhmail", "hostRefuseNotServing", "hostRefuseManaged",
  "hostRefuseServer", "hostRefuseSpent", "hostRefuseUnreachable",
  // the standing line
  "hostFootStale", "hostFootStaleWhy", "hostFootUnknown", "hostCheckLan", "hostCheckTs",
  "hostFootSettings",
  // the revoked notice
  "gateUnpaired", "gatePairAgain", "gateOwn",
  // Settings -> Desktop
  "mailboxWhyViaHost", "doorHostWhyLan", "doorHostWhyTs", "credHostLabel", "credHostLiveValue",
  "credHostLiveWhy", "credHostOutValue", "credHostOutWhy", "credHostCheckingWhy",
  "connLabel", "connCurrentValue", "connCurrentWhy", "connStaleValue", "connStaleWhy",
  "connUnknownValue", "installPairAgain", "installPairAgainWhy",
  // setting this machine up on its own
  "takeoverLabel", "takeoverAction", "takeoverWhy", "takeoverLead", "takeoverRoster",
  "takeoverRest", "takeoverRosterUnknown",
  // the wording that differs on this door
  "installSwitchWhyHost", "installSignOutWhyHost", "installSignOutConfirmWhyHost",
  // Settings -> About
  "aboutDoorHostValue", "aboutDoorHostWhy",
] as const;

describe("the paired door's sentences exist, in both languages", () => {
  it("every key is in en.json and de.json", () => {
    const missing: string[] = [];
    for (const key of PAIRED_DOOR_KEYS) {
      if (typeof EN.desktopDoor?.[key] !== "string") missing.push(`en desktopDoor.${key}`);
      if (typeof DE.desktopDoor?.[key] !== "string") missing.push(`de desktopDoor.${key}`);
    }
    expect(missing, "these render as a raw dotted key, or not at all").toEqual([]);
  });

  it("and the window's fallback constant knows every one of them", () => {
    /* `DOOR_COPY` is what renders before a catalogue is set — a cold start, and every bare unit
       render in this suite. A key in the catalogue and not in the constant is `undefined` on the
       first frame. */
    const missing = PAIRED_DOOR_KEYS.filter(
      (key) => !Object.prototype.hasOwnProperty.call(DOOR_COPY, key),
    );
    expect(missing, "in the catalogue but not in the window's fallback table").toEqual([]);
  });

  it("the German is a translation and not a copy", () => {
    /* Every one of these is a sentence rather than a name or a URL shape, so every one of them
       must actually differ. `hostLinkPlaceholder` is deliberately excluded above for that reason
       — it is a URL example, and translating it would make it stop matching what it exemplifies. */
    const untranslated = PAIRED_DOOR_KEYS.filter(
      (key) => EN.desktopDoor?.[key] === DE.desktopDoor?.[key],
    );
    expect(untranslated, "these are byte-identical in both catalogues").toEqual([]);
  });

  it("and the two host-pane additions, plus the two edited mint leads", () => {
    for (const key of ["keyLabel", "keyWhy", "mintedLead", "mintedLeadFor"]) {
      expect(typeof EN.host?.[key], `en host.${key}`).toBe("string");
      expect(typeof DE.host?.[key], `de host.${key}`).toBe("string");
      expect(EN.host?.[key], `host.${key} is not translated`).not.toBe(DE.host?.[key]);
    }
    /* The mint leads were EDITED rather than added: they used to say "the device's camera",
       which named no device a person could act on. They name both routes now. */
    expect(EN.host?.mintedLead).toContain("another computer");
    expect(EN.host?.mintedLeadFor).toContain("that computer");
  });
});
