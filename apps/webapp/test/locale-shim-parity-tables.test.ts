import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TextProvider, useText } from "@ohmail/app/text";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readerEn from "../../../packages/app/messages/reader.en.json";
import readerDe from "../../../packages/app/messages/reader.de.json";
import { DEFAULT_LOCALE, activeTranslator, fillFrom, setActiveCatalog } from "../app/shell/locale";
import { AGO_COPY, PLACE_LABEL } from "../app/shell/format";
import { COPY as MAIL_BODY_COPY } from "../../../packages/letter-body/src/MessageBody";
import { COPY as BODY_TEXT_COPY } from "../../../packages/letter-body/src/BodyText";

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
 * The Away pane reads the host's catalogue through the shared text provider. Their cases also
 * exercise that reader against the established Away keys and the browser's catalogue formatter.
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
 * The tables, their namespaces, and the English text each one is held against.
 *
 * `PLACE_LABEL` is the odd one out and is listed anyway: it is a `Record<string, string>` rather than
 * a table with function members, and it is the most-repeated copy in the product — the badge on
 * every search hit, the "→ News" in every move menu, the "Moved to Receipts." in every toast.
 */
const TABLES: Array<{ name: string; ns: string; table: Record<string, unknown> }> = [
  { name: "MessageBody.COPY", ns: "mailBody", table: MAIL_BODY_COPY },
  { name: "BodyText.COPY", ns: "bodyText", table: BODY_TEXT_COPY },
  { name: "Reader files", ns: "attachments", table: readerEn.attachments },
  { name: "Reader preview", ns: "attachmentPreview", table: readerEn.attachmentPreview },
  { name: "Reader calendar file", ns: "icsEvent", table: readerEn.icsEvent },
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

    expect(inTable, `${ns}: the constant and en.json disagree about which keys exist`)
      .toEqual(inCatalogue);
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

  const AWAY_KEYS = [
    "title", "on", "off", "bodyLabel", "audienceLabel",
    "screenedIn", "everyone", "screenedInNote", "everyoneNote", "throttleLabel",
    "always", "per_message", "per_day", "per_week", "pilesLabel",
    "pileOhbox", "pileReads", "pileReceipts", "pileScreener", "pileOhboxNote",
    "pileScreenerNote", "pilesNote", "never", "untilLabel", "untilNone",
    "untilPick", "untilClear", "untilOn", "untilPast", "untilExpired",
    "localNote", "phoneNote", "hostNote", "save", "saving", "saved",
    "asked", "applied", "changedElsewhere", "failed", "failedStillOn",
    "failedStillOff", "incomplete", "unreachable", "unsavedStillOff", "unsavedStillOn",
    "leaveAsk", "leaveDiscard", "leaveKeep", "notice", "noticePileOhbox",
    "noticePileReads", "noticePileReceipts", "noticePileScreener", "noticeNone", "noticeSettings",
  ];

  it("the Away catalogue keeps every established key", () => {
    expect([...AWAY_KEYS].sort()).toEqual(Object.keys(EN.away!).sort());
  });

  // Exercise parameterized sentences as well as the plain strings.
  const AWAY_ARGS: Record<string, Record<string, string>> = {
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

  function renderMountedAway(locale: "en" | "de", catalogue: Record<string, string>, keys: readonly string[]) {
    const rendered: Record<string, string> = {};
    function ReadAway() {
      const t = useText("away");
      for (const key of keys) rendered[key] = t(key, AWAY_ARGS[key]);
      return null;
    }
    renderToStaticMarkup(createElement(TextProvider, {
      locale, messages: { away: catalogue }, timeZone: "UTC", children: createElement(ReadAway),
    }));
    return rendered;
  }

  it("every away key renders the SAME sentence from the catalogue and from the shared text reader", () => {
    const keys = Object.keys(EN.away!).sort();
    const fromCatalogue = renderAway(DEFAULT_LOCALE, EN.away, keys);
    const fromPane = renderMountedAway(DEFAULT_LOCALE, EN.away!, keys);

    const blank = keys.filter((k) => fromCatalogue[k] === "" || fromPane[k] === "");
    expect(blank, `these away messages rendered EMPTY: ${blank.join(", ")}`).toEqual([]);

    const drift = keys.filter((k) => fromCatalogue[k] !== fromPane[k]).map(
      (k) => `away.${k}: catalogue "${fromCatalogue[k]}" vs shared reader "${fromPane[k]}"`,
    );
    expect(drift, `the two render paths disagree:\n  ${drift.join("\n  ")}`).toEqual([]);
  });

  it("and it renders German, so a key the German catalogue lacks cannot hide behind English", () => {
    expect(readerDe.attachments).toEqual(DE.attachments);
    expect(readerDe.attachmentPreview).toEqual(DE.attachmentPreview);
    expect(readerDe.icsEvent).toEqual(DE.icsEvent);
    const keys = Object.keys(EN.away!).sort();
    const german = renderMountedAway("de", DE.away!, keys);
    const baseline = renderAway("de", GERMAN.away, keys);
    const blank = keys.filter((k) => german[k] === "");
    expect(blank, `these away messages rendered EMPTY in German: ${blank.join(", ")}`).toEqual([]);
    expect(german).toEqual(baseline);
    // The state the away pane reports after another install takes the edit, in the reader's own language.
    expect(german.applied).toBe(DE.away!.applied);
    expect(german.applied).not.toBe(EN.away!.applied);
  });
});
