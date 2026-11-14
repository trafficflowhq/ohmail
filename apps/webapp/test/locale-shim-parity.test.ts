import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_LOCALE, activeTranslator, fillFrom, liveCopy, setActiveCatalog, setActiveFormatZone,
} from "../app/shell/locale";
import { AGO_COPY, PLACE_LABEL, resurfaceLabel } from "../app/shell/format";
import { COPY as MAIL_BODY_COPY } from "../app/letter-body/MessageBody";
import { COPY as BODY_TEXT_COPY } from "../app/letter-body/BodyText";
import { COPY as ATTACHMENT_COPY } from "../app/components/AttachmentStrip";
import { COPY as PREVIEW_COPY } from "../app/components/AttachmentPreview";
import { COPY as ICS_COPY } from "../app/components/IcsEventCard";
import { AWAY_COPY } from "../app/shell/AwayResponderRow";
import { AWAY_NOTICE_COPY } from "../app/shell/AwayNotice";

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
 * The five tables, their namespace, and the English text each one is held against.
 *
 * `PLACE_LABEL` is the odd one out and is listed anyway: it is a `Record<string, string>` rather than
 * a table with function members, and it is the most-repeated copy in the product — the badge on
 * every search hit, the "→ News" in every move menu, the "Moved to Receipts." in every toast.
 */
const TABLES: Array<{ name: string; ns: string; table: Record<string, unknown> }> = [
  { name: "MessageBody.COPY", ns: "mailBody", table: MAIL_BODY_COPY },
  { name: "BodyText.COPY", ns: "bodyText", table: BODY_TEXT_COPY },
  { name: "AttachmentStrip.COPY", ns: "attachments", table: ATTACHMENT_COPY },
  { name: "AttachmentPreview.COPY", ns: "attachmentPreview", table: PREVIEW_COPY },
  { name: "IcsEventCard.COPY", ns: "icsEvent", table: ICS_COPY },
  { name: "AwayResponderRow.AWAY_COPY", ns: "away", table: AWAY_COPY },
  { name: "AwayNotice.AWAY_NOTICE_COPY", ns: "away", table: AWAY_NOTICE_COPY },
  { name: "format.PLACE_LABEL", ns: "place", table: PLACE_LABEL },
  { name: "format.AGO_COPY", ns: "relativeTime", table: AGO_COPY },
];

afterEach(() => {
  // Every case that sets a catalogue must put the register back, or the next test file in the same
  // worker inherits German. The register is module state by design (see `locale.ts`), so cleaning it
  // up is the price of that design and is paid here rather than hoped for.
  setActiveCatalog(DEFAULT_LOCALE, null);
});

describe("the non-hook copy tables and the catalogue say the same thing", () => {
  it.each(TABLES)("$name covers exactly the $ns namespace", ({ ns, table }) => {
    const catalogue = EN[ns];
    expect(catalogue, `en.json has no ${ns} namespace`).toBeDefined();
    const inTable = Object.keys(table).sort();
    const inCatalogue = Object.keys(catalogue!).sort();

    // `away` is shared by two tables, so each covers a SUBSET and the union must be the whole.
    if (ns === "away") {
      const missing = inTable.filter((k) => !inCatalogue.includes(k));
      expect(missing, `keys in the constant with no ${ns} entry: ${missing.join(", ")}`).toEqual([]);
      return;
    }
    expect(inTable, `${ns}: the constant and en.json disagree about which keys exist`)
      .toEqual(inCatalogue);
  });

  it("the two away tables together cover the whole away namespace", () => {
    const union = [...Object.keys(AWAY_COPY), ...Object.keys(AWAY_NOTICE_COPY)].sort();
    expect(union).toEqual(Object.keys(EN.away!).sort());
  });

  /**
   * THE AWAY NAMESPACE, RENDERED — because nothing above runs the ICU compiler over it.
   *
   * Key presence plus the byte compare already imply the plain sentences match. What neither sees
   * is whether a sentence FORMATS: a message the compiler refuses answers EMPTY through
   * `getMessageFallback` and reaches the screen that way, and the four parameterised ones here
   * (`notice`, `untilOn`, `untilPast`, `hostNote`) carry `select` rather than `plural`, so
   * `locale-catalog.test.ts`'s formatting case skips every one of them. `away.applied` is what
   * made the gap visible: a key the pane renders through `t("applied")` and the constants did not
   * carry, which nothing had ever rendered to notice.
   *
   * So each key is rendered twice through `activeTranslator` — `createTranslator`, which is what
   * `useTranslations` is built on — over the catalogue and over the kept constants, and the two
   * must be the same non-empty sentence, in English and in German.
   */
  const AWAY_ARGS: Record<string, Record<string, unknown>> = {
    /* Declared, not inferred: nothing can read an ICU argument list off a sentence, and a key
       whose args were forgotten renders EMPTY on both sides, which would compare equal. The
       non-empty assertion below is what refuses that. */
    untilOn: { date: "5 Aug 2026" },
    untilPast: { date: "5 Aug 2026" },
    hostNote: { host: "the other computer" },
    notice: { audience: "everyone", piles: "in Ohbox", throttle: "per_day" },
  };

  const renderAway = (
    locale: "en" | "de", catalogue: unknown, keys: readonly string[],
  ): Record<string, string> => {
    // One translator per catalogue, so the two sides are taken one after the other: the register
    // holds ONE catalogue and `setActiveCatalog` drops the per-namespace cache. The locale travels
    // with the catalogue because ICU resolves plural and ordinal categories from it, not from the
    // message.
    setActiveCatalog(locale, { away: catalogue } as never);
    const t = activeTranslator("away");
    expect(t, "the register did not build an away translator").not.toBeNull();
    const out: Record<string, string> = {};
    for (const key of keys) out[key] = t!(key, AWAY_ARGS[key] ?? {});
    return out;
  };

  it("every away key renders the SAME sentence from the catalogue and from the kept constants", () => {
    const keys = Object.keys(EN.away!).sort();
    const kept = { ...AWAY_COPY, ...AWAY_NOTICE_COPY };

    const fromCatalogue = renderAway(DEFAULT_LOCALE, EN.away, keys);
    const fromConstants = renderAway(DEFAULT_LOCALE, kept, keys);

    // ANTI-VACUITY: an unrenderable message answers "" on BOTH sides and would compare equal, so
    // the comparison is only worth its exit code with this in front of it.
    const blank = keys.filter((k) => fromCatalogue[k] === "" || fromConstants[k] === "");
    expect(blank, `these away messages rendered EMPTY: ${blank.join(", ")}`).toEqual([]);

    const drift = keys.filter((k) => fromCatalogue[k] !== fromConstants[k]).map(
      (k) => `away.${k}: catalogue "${fromCatalogue[k]}" vs constant "${fromConstants[k]}"`,
    );
    expect(drift, `the two render paths disagree:\n  ${drift.join("\n  ")}`).toEqual([]);
  });

  it("and it renders German, so a key the German catalogue lacks cannot hide behind English", () => {
    const keys = Object.keys(EN.away!).sort();
    const german = renderAway("de", (GERMAN as Record<string, unknown>).away, keys);
    const blank = keys.filter((k) => german[k] === "");
    expect(blank, `these away messages rendered EMPTY in German: ${blank.join(", ")}`).toEqual([]);
    // The state the away pane reports after another install takes the edit — the key this case was
    // written for — in the reader's own language.
    expect(german.applied).toBe(DE.away!.applied);
    expect(german.applied).not.toBe(EN.away!.applied);
  });

  it.each(TABLES)("$name's plain sentences are byte-identical to en.json", ({ ns, table }) => {
    const catalogue = EN[ns]!;
    const drift: string[] = [];
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== "string") continue; // interpolated entries are functions; see below
      if (catalogue[key] !== value) {
        drift.push(`${ns}.${key}: catalogue "${catalogue[key]}" vs constant "${value}"`);
      }
    }
    expect(drift, `the fallback and the catalogue have drifted:\n  ${drift.join("\n  ")}`).toEqual([]);
  });

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
    expect(ATTACHMENT_COPY.downloadAll).toBe("Alle herunterladen");
    expect(PREVIEW_COPY.close).toBe("Schließen");
  });

  it("an interpolated sentence keeps its number and takes the German plural", () => {
    setActiveCatalog("de", GERMAN as never);
    expect(ATTACHMENT_COPY.count(1)).toBe("1 Anhang");
    expect(ATTACHMENT_COPY.count(4)).toBe("4 Anhänge");
    expect(MAIL_BODY_COPY.blockedMany(3)).toContain("3");
    expect(ATTACHMENT_COPY.idle("2,3 MB")).toContain("2,3 MB");
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
