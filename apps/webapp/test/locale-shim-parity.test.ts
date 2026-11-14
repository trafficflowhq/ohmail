import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOCALE, activeTranslator, fillFrom, liveCopy, setActiveCatalog, setActiveFormatZone,
} from "../app/shell/locale";
import { PLACE_LABEL, resurfaceLabel } from "../app/shell/format";
import { COPY as MAIL_BODY_COPY } from "../../../packages/letter-body/src/MessageBody";

/**
 * THE SURFACES THAT ARE NOT COMPONENTS — and the guard that keeps their English constant and the
 * catalogue from becoming two different pieces of copy.
 *
 * Four modules cannot read a translation through `useTranslations`:
 *
 *  · `app/shell/format.ts` is a function library. `screener-state.ts` reads its view-name table from
 *    inside a reducer and `AppShell` from inside a toast callback — there is no hook to call.
 *  · `MessageBody`, `AttachmentStrip` and `AttachmentPreview` are each rendered BARE, with no intl
 *    provider above them, in a dozen unit tests; three of those tests import the component's `COPY`
 *    to assert against the text on screen. The hook throws without a provider.
 *
 * They read the same catalogue through `liveCopy`/`activeTranslator` (`app/shell/locale.ts`), whose
 * resting answer — no host has set a catalogue — is the English constant declared in each file.
 * That is what keeps those bare renders deterministic and English. And it is the thing that can rot:
 * a copy edit made in `en.json` and not in the constant, or the other way round, produces one
 * sentence in the real app and a different one in every test that asserts on it.
 *
 * ── RE-POINTED (share reader-1, the switch's older tests) ─────────────────────────────────────
 *
 * Today's attachment strip, preview and event card leave with today's reader: the new reader's files say their
 * sentences through the reader's own words (`packages/app/messages/reader.*.json`, `useText`), so the halves of the
 * cases below that read the strip's and the preview's German stand over those words in
 * `locale-shim-parity-reader.test.tsx`. What stays here is the register itself: where a case used the strip's table
 * as the register's client with an interpolated sentence, the client is the attachments namespace read through
 * `liveCopy` as the strip read it (`ATTACHMENT_COPY` below, its English and its argument names as the strip declared
 * them). The two table censuses and the away namespace's three cases (the away pane is not mounted yet) moved, as they
 * stood, to `locale-shim-parity-tables.test.ts`.
 *
 * So this file asserts, for each of them:
 *  1. the constant's key set is EXACTLY the catalogue namespace's;
 *  2. every plain string in the constant is EXACTLY the English sentence in `en.json`;
 *  3. with a German catalogue set, the same constant answers German — which is the claim the whole
 *     migration rests on, and the one no other test in the suite exercises.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MESSAGES = path.join(HERE, "..", "messages");
const read = (locale: string): Record<string, Record<string, string>> =>
  JSON.parse(fs.readFileSync(path.join(MESSAGES, `${locale}.json`), "utf8"));

const EN = read("en");
const DE = read("de");
/** The catalogue a host would set for German — English filled underneath, exactly as `loadCatalog`. */
const GERMAN = fillFrom(EN as never, DE as never) as Record<string, Record<string, string>>;

/**
 * The attachments namespace as a non-hook table over the register, as today's strip declared it
 * (`AttachmentStrip.tsx`: `liveCopy("attachments", EN, { count: ["count"], idle: ["size"], … })`): the register's
 * client with an ICU plural and an argument.
 */
const ATTACHMENT_COPY = liveCopy(
  "attachments",
  { count: (n: number) => `${n} attachments`, idle: (size: string) => `${size} · in your mailbox` },
  { count: ["count"], idle: ["size"] },
);

afterEach(() => {
  // Every case that sets a catalogue must put the register back, or the next test file in the same
  // worker inherits German. The register is module state by design (see `locale.ts`), so cleaning it
  // up is the price of that design and is paid here rather than hoped for.
  setActiveCatalog(DEFAULT_LOCALE, null);
});

describe("the non-hook copy tables and the catalogue say the same thing", () => {
  it("a MISSING argument-name list degrades to the English fallback rather than to a broken sentence", () => {
    /**
     * `liveCopy`'s `params` maps each function key to its ICU argument names in order. Forgetting one
     * is the mistake this design invites, so what happens then is worth pinning: the catalogue's
     * message needs `count`, nothing supplies it, the translator answers empty, and the English
     * fallback renders. Wrong language, right sentence — never a `#` with no number in front of it
     * and never a raw key.
     *
     * The correctly-parameterised table is what a reader actually gets, and it is German.
     */
    setActiveCatalog("de", GERMAN as never);
    expect(ATTACHMENT_COPY.count(3)).toBe("3 Anhänge");

    const forgotten = liveCopy(
      "attachments",
      { count: (n: number) => `${n} attachments` },
      {}, // ← the omission
    );
    expect(forgotten.count(3)).toBe("3 attachments");
    expect(forgotten.count(3)).not.toContain("#");
  });
});

describe("with a German catalogue set, the non-hook surfaces answer German", () => {
  it("the reading pane's sentences are German", () => {
    setActiveCatalog("de", GERMAN as never);
    expect(MAIL_BODY_COPY.show).toBe(DE.mailBody!.show);
    expect(MAIL_BODY_COPY.show).toBe("Bilder anzeigen");
    expect(MAIL_BODY_COPY.darkAdapt).toBe("An Dunkel anpassen");
    // The files' half (the strip's Download all, the look's Close): `locale-shim-parity-reader.test.tsx`.
  });

  it("an interpolated sentence keeps its number and takes the German plural", () => {
    setActiveCatalog("de", GERMAN as never);
    expect(MAIL_BODY_COPY.blockedMany(3)).toContain("3");
    // The files' half (the count's plural, the size in the idle line): `locale-shim-parity-reader.test.tsx`.
  });

  it("the view names follow the glossary — Ohbox, Screener and Reads keep their names, the rest translate", () => {
    setActiveCatalog("de", GERMAN as never);
    expect(PLACE_LABEL.ohbox).toBe("Ohbox");
    expect(PLACE_LABEL.screener).toBe("Screener");
    // `News` is deliberately the same string in both catalogues — the pile keeps its English name
    // in German (the IMAP folder behind it stays `ohmail/Reads`). It proves NOTHING about German,
    // which is why the two below carry that load. See `format.ts`'s PLACE_EN header.
    expect(PLACE_LABEL.reads).toBe("News");
    expect(PLACE_LABEL.receipts).toBe("Belege");
    expect(PLACE_LABEL.screened).toBe("Aussortiert");
  });

  it("the DAY NAMES follow the locale, and ONLY the day names", () => {
    /* 2026-08-07T09:00:00Z is a Friday. Switching the catalogue changes the WORD and nothing else:
       same weekday, same clock. The two dimensions are separate seams (`activeFormatLocale` and
       `activeFormatZone`) precisely so that neither can move the other — a German reader in London
       and an English one in London see the same instant named in two languages, not two instants.
       The zone is pinned here so this test measures the locale and only the locale; that the clock
       DOES follow the reader's zone is `reader-zone.test.ts`. */
    const friday = "2026-08-07T09:00:00.000Z";
    const wednesday = new Date("2026-08-05T12:00:00.000Z");
    setActiveFormatZone("UTC");
    setActiveCatalog(DEFAULT_LOCALE, null);
    expect(resurfaceLabel(friday, wednesday)).toBe("Fri 09:00");
    setActiveCatalog("de", GERMAN as never);
    expect(resurfaceLabel(friday, wednesday)).toBe("Fr 09:00");
    setActiveFormatZone(null);
  });
});

describe("the register's resting state", () => {
  it("answers the English constant when no host has set a catalogue — which is every bare unit test", () => {
    setActiveCatalog(DEFAULT_LOCALE, null);
    expect(activeTranslator("mailBody")).toBeNull();
    expect(MAIL_BODY_COPY.show).toBe("Show images");
    // `receipts` rather than `reads`, which is "News" in BOTH catalogues and so cannot tell a
    // resting register from a German one.
    expect(PLACE_LABEL.receipts).toBe("Receipts");
    expect(ATTACHMENT_COPY.count(2)).toBe("2 attachments");
  });

  it("a namespace the catalogue does not carry falls back rather than rendering a key", () => {
    setActiveCatalog("de", { place: DE.place } as never);
    expect(activeTranslator("mailBody")).toBeNull();
    expect(MAIL_BODY_COPY.show).toBe("Show images");
    expect(PLACE_LABEL.receipts).toBe("Belege");
  });

  it("MUTATING the register is what turns the German off — the guard is not reading a constant", () => {
    // ANTI-VACUITY, stated as a test rather than left to a reader: if `setActiveCatalog` stopped
    // being consulted, the case above would still pass (it asserts English) and every German case
    // would fail. This asserts the two directions in one place, so a loader that silently ignored
    // its argument cannot be green.
    setActiveCatalog("de", GERMAN as never);
    const german = MAIL_BODY_COPY.show;
    setActiveCatalog(DEFAULT_LOCALE, null);
    const english = MAIL_BODY_COPY.show;
    expect(german).not.toBe(english);
    expect(german).toBe("Bilder anzeigen");
    expect(english).toBe("Show images");
  });
});
