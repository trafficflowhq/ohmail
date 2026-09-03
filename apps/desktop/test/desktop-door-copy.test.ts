import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_LOCALE, fillFrom, setActiveCatalog } from "../../webapp/app/shell/locale";
import { DOOR_COPY, machineWord } from "../src/door-copy.js";
import { bootSentence } from "../src/BootStatus.js";
import { errorSentence } from "../src/GateBoundary.js";
import { afterRequestSentence, stateValue } from "../src/DesktopDefaultMail.js";
import { mailboxRowWhy } from "../src/install-role.js";
import { desktopPaneLabel } from "../src/DesktopSettings.js";

/**
 * ═══ THE STANDALONE WINDOW'S OWN WORDS, HELD AGAINST THE CATALOGUE ════════════════════════
 *
 * The gap this closes: with Language = Deutsch, everything OUTSIDE the shared shell was English.
 * The door chooser a fresh install opens with, the gate's apology, Settings → Desktop and
 * Settings → About, the boot line, the mailto ask — 112 strings the census could see across nine
 * files, plus fifty more inside helper functions no scan of JSX positions could reach. A German
 * install picked its mailbox in English and then went on in German.
 *
 * They are `desktopDoor` in `messages/{en,de}.json` now, read through `door-copy.ts`'s
 * `DOOR_COPY` — `liveCopy`, not `useTranslations`, because half of these sentences are produced
 * by functions that are not components (`bootSentence`, `errorSentence`, `credentialLine`) and
 * the other half render bare in two dozen unit tests with no intl provider above them.
 *
 * ── WHAT THIS FILE IS FOR, AND IT IS NOT A SECOND RENDER TEST ─────────────────────────────
 *
 * `liveCopy`'s resting answer is the English constant in the module. That is what keeps those
 * bare renders deterministic — and it is the thing that can rot: a copy edit made in `en.json`
 * and not in the constant (or the other way round) puts one sentence in the app and a different
 * one in every test that asserts on it, with nothing failing. So, exactly as this repository
 * already does for the reading pane's own non-hook copy tables:
 *
 *   1. the constant's key set is EXACTLY the namespace's, both directions;
 *   2. every plain sentence is byte-identical to `en.json`;
 *   3. with a German catalogue set, the same table answers German — the claim the whole
 *      translation rests on, and the one no render test in this suite exercises.
 *
 * The MISSING half — a key present in English and absent in German — is covered elsewhere and
 * deliberately not repeated here: a census over the whole interface reads every `liveCopy`
 * table's key set out of the source and requires each key in BOTH catalogues, so that gap is
 * red there rather than silently English here.
 */
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (locale: string): Record<string, Record<string, string>> =>
  JSON.parse(fs.readFileSync(path.join(REPO, `apps/webapp/messages/${locale}.json`), "utf8"));

const EN = read("en");
const DE = read("de");
/** What a host sets for German: English filled underneath, exactly as `DesktopLocale` does. */
const GERMAN = fillFrom(EN as never, DE as never) as Record<string, Record<string, string>>;

afterEach(() => {
  // Module state by design (see `locale.ts`), so putting it back is this file's job — otherwise
  // the next test file in the same worker inherits German.
  setActiveCatalog(DEFAULT_LOCALE, null);
});

describe("the desktop window's copy table and the catalogue say the same thing", () => {
  it("covers exactly the desktopDoor namespace", () => {
    const catalogue = EN.desktopDoor;
    expect(catalogue, "en.json has no desktopDoor namespace").toBeDefined();
    expect(Object.keys(DOOR_COPY).sort()).toEqual(Object.keys(catalogue!).sort());
    // Not vacuous: this is the whole standalone window, not a corner of it.
    expect(Object.keys(catalogue!).length).toBeGreaterThan(140);
  });

  it("the plain sentences are byte-identical to en.json", () => {
    const drift: string[] = [];
    for (const [key, value] of Object.entries(DOOR_COPY)) {
      // Interpolated entries are functions; their ICU message is asserted by rendering, below.
      if (typeof value !== "string") continue;
      if (EN.desktopDoor![key] !== value) {
        drift.push(`desktopDoor.${key}: catalogue "${EN.desktopDoor![key]}" vs constant "${value}"`);
      }
    }
    expect(drift, `the fallback and the catalogue have drifted:\n  ${drift.join("\n  ")}`).toEqual([]);
  });

  it("German is a full translation — no key falls through to the English sentence", () => {
    const untranslated = Object.entries(EN.desktopDoor!)
      .filter(([key, value]) => {
        const german = DE.desktopDoor![key];
        if (typeof german !== "string" || german === "") return true;
        return german === value;
      })
      .map(([key]) => key);
    /* Four keys are DELIBERATELY identical, and each is a name rather than a sentence: two
       platform words that are proper nouns, the product's own name, and a URL. Everything else
       being different is what makes this case worth running — a namespace copy-pasted from
       English into de.json would light up every row. */
    expect(untranslated.sort()).toEqual(
      ["doorCloudName", "machineMac", "machinePc", "paneLabel", "serverOriginPlaceholder"].sort(),
    );
  });
});

describe("with a German catalogue set, the standalone window answers German", () => {
  it("the door chooser, the gate and Settings → About", () => {
    setActiveCatalog("de", GERMAN as never);
    expect(DOOR_COPY.chooserTitle).toBe("Welches Postfach ist das?");
    expect(DOOR_COPY.gateCannotOpen).toBe("ohmail kann dein Postfach nicht öffnen");
    expect(DOOR_COPY.aboutLicence).toBe("Lizenz");
    expect(DOOR_COPY.installSignOutConfirm).toBe("Von diesem Postfach abmelden?");
  });

  it("the interpolated sentences render their values, in German", () => {
    setActiveCatalog("de", GERMAN as never);
    expect(DOOR_COPY.doorLocalName("Mac")).toBe("Auf diesem Mac");
    expect(DOOR_COPY.serverReached("ohmail.example.com", "anna@example.com"))
      .toBe("ohmail.example.com erreicht. Anmeldung als anna@example.com.");
    /* THE APOSTROPHE CASE. `{machine}'s keychain` puts an ASCII apostrophe next to a closing
       brace, which is where ICU's quoting rule bites if it bites at all — a run of literal text
       must come back literal. Rendered, not reasoned about. */
    expect(DOOR_COPY.credReadyWhy("Mac"))
      .toBe("Mit einem Schlüssel aus dem Schlüsselbund dieses Mac versiegelt, und es funktioniert.");
    expect(DOOR_COPY.engineNoKey("PC")).toBe("Der Schlüsselspeicher dieses PC hat nicht geantwortet");
    expect(DOOR_COPY.notifyNewMail(1)).toBe("Eine neue Nachricht für dich.");
    expect(DOOR_COPY.notifyNewMail(4)).toBe("4 neue Nachrichten für dich.");
    expect(DOOR_COPY.errorRefused("503")).toBe("Die Anfrage wurde abgelehnt (503).");
  });

  it("the same ICU messages render in English when no catalogue is set", () => {
    expect(DOOR_COPY.doorLocalName("PC")).toBe("On this PC");
    expect(DOOR_COPY.notifyNewMail(1)).toBe("One new message for you.");
    expect(DOOR_COPY.notifyNewMail(4)).toBe("4 new messages for you.");
    expect(DOOR_COPY.credReadyWhy("Mac")).toBe("Sealed under a key in this Mac's keychain, and working.");
  });

  /**
   * THE FIVE SURFACES THAT ARE NOT COMPONENTS. Each is a pure function some pane calls during
   * its render, and each was a switch over English literals; a hook could not have reached any
   * of them. Driven here through the catalogue rather than through a render, which is the only
   * way to see that the German actually arrives.
   */
  it("the boot line, the error sentence, the mailto row, the mailbox row and the pane label", () => {
    setActiveCatalog("de", GERMAN as never);
    expect(bootSentence("replaying_wal")).toBe("Letzte Änderungen werden nachgezogen…");
    expect(bootSentence("a phase this build has never heard of"))
      .toBe("Postfach wird geöffnet…");
    expect(errorSentence(new Error(""))).toBe("Etwas ist schiefgegangen und hat nicht gesagt, was.");
    expect(afterRequestSentence("settings-opened", "not-default"))
      .toBe("Die Windows-Einstellungen sind offen — wähle dort ohmail unter Standard-Apps.");
    expect(stateValue("not-default")).toBe("Eine andere App");
    // The brand is not a key and stays the brand.
    expect(stateValue("default")).toBe("ohmail");
    expect(mailboxRowWhy(null)).toBe("Das Postfach, das diese ohmail-Installation organisiert.");
    expect(mailboxRowWhy({ name: "ohmail Cloud" }))
      .toBe("Das Postfach, das diese ohmail-Installation liest. Organisiert wird es von ohmail Cloud.");
    expect(desktopPaneLabel()).toBe("Desktop");
  });

  /**
   * THE MACHINE'S OWN WORD. "Mac" and "PC" are proper nouns and travel; "computer" is an
   * ordinary noun and does not — German capitalises it. The test runner imports `platform.ts`
   * from source, where no bundler folded `__OHMAIL_PLATFORM__` in, so `MACHINE_WORD` resolves as
   * an unrecognised platform does and this is the "computer" arm.
   */
  it("the machine's word is translated too", () => {
    expect(machineWord()).toBe("computer");
    setActiveCatalog("de", GERMAN as never);
    expect(machineWord()).toBe("Computer");
  });
});
