import type { EngineMessage, TagEntity as TagDTO } from "@ohmail/wire";
import "./_tz-zurich";
import { afterAll, describe, expect, it } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, useTranslations, type AbstractIntlMessages } from "next-intl";
import { FixturesAdapter, DEMO_NOW } from "@ohmail/testing/adapter";
import { TAG_HUES } from "@ohmail/ui";
import {
  AGO_COPY, DEFAULT_RESURFACE_TIME, PLACE_LABEL, agoStamp, avatarOf, clockOf, composedLocalInput, dayAt, dayEnd,
  dayNine, dayStamp, dayValue, displayTime, firstDayAt, firstName, forwardedToNames, fullDateTime, hueOf,
  localInputValue, metaLine, nextFridayNine, nextWeekAt, nextWeekNine, placeLabel, recipientRows, resurfaceClock,
  resurfaceHorizons, resurfaceLabel, rowAddress, rowStamp, scheduleLabel, sendLaterMornings, senderName,
  sentAvatarOf, sentRowRecipient, tagsOfMessage, todayEvening, tomorrowAt, tomorrowNine, waterlineStamp,
  withheldCopyKey, writtenDateTime, writtenInstant, type ResurfaceHorizon,
} from "@ohmail/app-logic/text/format";
import { DEFAULT_LOCALE, fillFrom, setActiveCatalog, setActiveFormatZone } from "../app/shell/locale";
import { useRowBadgeCopy, useSentLabel, type RowBadgeCopy, type SentLabel } from "@ohmail/app-logic/text/row-copy";
import { setFormatWords, type Translator } from "@ohmail/app-logic/text";
import en from "../messages/en.json";
import de from "../messages/de.json";

/**
 * THE ROWS' WORDS, BYTE FOR BYTE, IN BOTH LANGUAGES. Every sentence, stamp, label and hue the old shell's formatting
 * module gives a list row, an open letter's head and a resurface or send-later chooser, over the demo world's own
 * letters and tags (and five letters that reach the branches the world holds none of), read three ways: with nothing
 * set (English, the machine's zone), with the English catalogue in one zone, with the German catalogue in another.
 * The three readings were written once, on the tree before the words' lift, into `row-words/`; a lift that changes one
 * byte a person reads turns this red. The badges' words and the sent label, which the rows take from two hooks beside
 * the module, are read the same three ways into `row-words/row-copy-*.txt`, written before those hooks were cut.
 * Nothing here reads source.
 */

const EN = en as Record<string, unknown>;
/** German as a host sets it: English filled underneath, as `loadCatalog` does. */
const GERMAN = fillFrom(EN, de as Record<string, unknown>);

const NOW = DEMO_NOW;
const OWN = "hello@milabrunner.example";

async function world(): Promise<{ messages: EngineMessage[]; tags: TagDTO[] }> {
  const answer = await new FixturesAdapter().sync({ since: "0", limit: 2000 } as never);
  const of = <T,>(type: string): T[] =>
    answer.changes.creates.filter((c) => c.type === type).map((c) => c.entity as T);
  const tags = of<TagDTO>("tag");
  /* A hue an older build stored, which the clamp paints moss. */
  tags.push({ id: "tag-old-hue", name: "Old", hue: "teal" } as TagDTO);
  const messages = of<EngineMessage>("message");
  const first = messages[0]!;
  const to = [
    { name: "Nora Lindt", address: "nora@lindt.example" },
    { name: "", address: "ben@lichtgrat.example" },
  ];
  messages.push(
    { ...first, id: "x-sent", folder: "Sent", to, cc: [{ name: "Mila", address: OWN }] } as unknown as EngineMessage,
    { ...first, id: "x-sent-one", folder: "Sent", to: to.slice(1), cc: [] } as unknown as EngineMessage,
    { ...first, id: "x-undated", date: null, labels: ["tag-old-hue", ...first.labels] } as unknown as EngineMessage,
    { ...first, id: "x-junk", folder: "ohmail/Quarantine", withheld: "junk_filed" } as unknown as EngineMessage,
    { ...first, id: "x-far", date: "2025-12-24T23:30:00.000Z", folder: "Archive/2025" } as unknown as EngineMessage,
  );
  return { messages, tags };
}

const horizon = (h: ResurfaceHorizon | null): string => (h ? `${h.iso} ${h.time} ${h.verdict}` : "none");

/** One line a letter: every word its row, its head and its stamps read, in the order a reader meets them. */
function letterLine(m: EngineMessage, tags: TagDTO[], locale: string): string {
  const sent = sentRowRecipient(m);
  const avatar = avatarOf(m);
  const shown = rowStamp(m, NOW, false);
  const flipped = rowStamp(m, NOW, true);
  const rows = recipientRows(m, [OWN]);
  const at = m.date ?? "";
  return [
    m.id,
    senderName(m),
    rowAddress(m) ?? "-",
    firstName(m),
    `${avatar.avatarInitial} hue ${avatar.avatarHue}`,
    sent ? `${sent.name}+${sent.extra} ${sentAvatarOf(sent).avatarInitial} hue ${sentAvatarOf(sent).avatarHue}` : "-",
    forwardedToNames(m) ?? "-",
    displayTime(m, NOW),
    fullDateTime(m),
    writtenInstant(m) ?? "-",
    writtenDateTime(m),
    `${shown.time}/${shown.timeTitle ?? "-"}/${shown.timeSpoken}`,
    `${flipped.time}/${flipped.timeTitle ?? "-"}/${flipped.timeSpoken}`,
    metaLine(placeLabel(m.folder), displayTime(m, NOW)),
    withheldCopyKey((m as { withheld?: never }).withheld, m.folder, null),
    `to:${rows.to.map((r) => `${r.me ? "me" : ""}${r.address}`).join(",")} cc:${rows.cc.length} ${rows.empty}`,
    tagsOfMessage(m, tags).map((t) => `${t.name}:${hueOf(t, TAG_HUES)}`).join(",") || "-",
    at ? clockOf(at) : "-",
    at ? resurfaceLabel(at, NOW) : "-",
    at ? scheduleLabel(at, NOW) : "-",
    at ? `${agoStamp(at, NOW.getTime()).rel} | ${agoStamp(at, NOW.getTime()).abs}` : "-",
    dayStamp(at || null),
    at ? dayValue(at) : "-",
    at ? localInputValue(at) : "-",
    at ? waterlineStamp(at, NOW, locale) : "-",
  ].join(" | ");
}

/** The words that are not a letter's: the places' names, the young age, and every chooser's horizon. */
function choosersLines(): string[] {
  const evening = todayEvening(NOW);
  const typed = composedLocalInput("2026-10-25T02:30", new Date("2026-10-25T00:10:00.000Z"));
  const both = resurfaceHorizons(NOW, "07:30");
  const mornings = sendLaterMornings(NOW);
  return [
    `places | ${Object.entries(PLACE_LABEL).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    `places by folder | ${["INBOX", "ohmail/News", "ohmail/Receipts", "ohmail/Screener", "ohmail/Screened", "ohmail/Quarantine", "Archive/Q1"].map(placeLabel).join(", ")}`,
    `young | ${AGO_COPY.justNow} | ${agoStamp(new Date(NOW.getTime() - 20_000).toISOString(), NOW.getTime()).rel}`,
    `older | ${[90, 7200, 200_000].map((s) => agoStamp(new Date(NOW.getTime() - s * 1000).toISOString(), NOW.getTime()).rel).join(", ")}`,
    `hour | ${DEFAULT_RESURFACE_TIME} ${JSON.stringify(resurfaceClock("25:00"))} ${JSON.stringify(resurfaceClock("06:15"))}`,
    `tomorrow | ${horizon(tomorrowAt(NOW, "07:30"))} | ${horizon(tomorrowAt(NOW, null))} | ${tomorrowNine(NOW)}`,
    `first day | ${horizon(firstDayAt(NOW, "23:59"))} | ${horizon(firstDayAt(NOW, null))}`,
    `next week | ${horizon(nextWeekAt(NOW, "07:30"))} | ${nextWeekNine(NOW)} | ${nextFridayNine(NOW)}`,
    `both | ${horizon(both.tomorrow)} | ${horizon(both.nextWeek)}`,
    `mornings | ${mornings.tomorrow} | ${mornings.monday ?? "none"}`,
    `evening | ${evening.instant.toISOString()} ${evening.hour}:${evening.minute} ${evening.verdict} | ${scheduleLabel(evening.instant.toISOString(), NOW)}`,
    `picked | ${horizon(dayAt("2026-10-25", "02:30"))} | ${horizon(dayAt("2026-03-29", "02:30"))} | ${dayNine("2026-08-03")} | ${dayEnd("2026-08-03")}`,
    `typed | ${typed ? `${typed.instant.toISOString()} ${typed.verdict}` : "none"} | ${composedLocalInput("not a time") ?? "none"}`,
    `far | ${scheduleLabel("2026-12-02T17:00:00.000Z", NOW)} | ${resurfaceLabel("2026-07-31T07:00:00.000Z", NOW)} | ${resurfaceLabel("later", NOW)}`,
  ];
}

async function reading(locale: string): Promise<string> {
  const { messages, tags } = await world();
  return [...choosersLines(), ...messages.map((m) => letterLine(m, tags, locale))].join("\n") + "\n";
}

/** A phrase with each of its numbers written apart («1,234» messages), so that no line reads as a mailbox's count. */
const apart = (phrase: string): string => phrase.replace(/\d+(?:[.,]\d+)*/g, (n) => `«${n}»`);

/**
 * The words a row takes from the two hooks beside the module, read inside the catalogue's provider as a view reads
 * them: the badges' words (each count at the plural's edges and at one the locale groups, written apart) and every
 * letter's sent label with its circle.
 */
async function rowCopyReading(locale: string, catalog: Record<string, unknown>, timeZone: string): Promise<string> {
  const { messages } = await world();
  const lines: string[] = [];
  function Probe(): null {
    const copy = useRowBadgeCopy(useTranslations("message"));
    const sentLabelOf = useSentLabel(useTranslations("ohbox"));
    const counts = [0, 1, 2, 1234];
    const marks: Array<[number, number]> = [[1, 0], [2, 1], [5, 5], [1234, 1]];
    lines.push(
      `protected | ${copy.protectedLabel}`,
      `held | ${counts.map((n) => apart(copy.held(n))).join(" / ")}`,
      `thread | ${counts.map((n) => apart(copy.thread(n))).join(" / ")}`,
      `marks | ${marks.map(([n, unread]) => apart(copy.marks(n, unread))).join(" / ")}`,
      `spoken | ${copy.spoken.unread} / ${copy.spoken.read} / ${copy.spoken.attachment}`,
      ...messages.map((m) => {
        const sent = sentLabelOf(m);
        return `${m.id} | ${sent ? `${sent.label} | ${sent.avatar.avatarInitial} hue ${sent.avatar.avatarHue}` : "-"}`;
      }),
    );
    return null;
  }
  renderToStaticMarkup(
    h(NextIntlClientProvider, { locale, messages: catalog as AbstractIntlMessages, timeZone, children: h(Probe) }),
  );
  return lines.join("\n") + "\n";
}

afterAll(() => {
  setActiveCatalog(DEFAULT_LOCALE, null);
  setActiveFormatZone(null);
});

describe("the rows' words read as they did, byte for byte", () => {
  it("with nothing set: English, in the machine's own zone", async () => {
    await expect(await reading("en")).toMatchFileSnapshot("./row-words/at-rest.txt");
  });

  it("in English, with the English catalogue, in New York", async () => {
    setActiveCatalog("en", EN);
    setActiveFormatZone("America/New_York");
    await expect(await reading("en")).toMatchFileSnapshot("./row-words/english.txt");
  });

  it("in German, with the German catalogue, in Auckland", async () => {
    setActiveCatalog("de", GERMAN);
    setActiveFormatZone("Pacific/Auckland");
    await expect(await reading("de")).toMatchFileSnapshot("./row-words/german.txt");
  });
});

describe("the rows' badges and sent labels read as they did, byte for byte", () => {
  it("with nothing set: the English catalogue, in the machine's own zone", async () => {
    setActiveCatalog(DEFAULT_LOCALE, null);
    setActiveFormatZone(null);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await expect(await rowCopyReading("en", EN, zone)).toMatchFileSnapshot("./row-words/row-copy-at-rest.txt");
  });

  it("in English, with the English catalogue, in New York", async () => {
    setActiveCatalog("en", EN);
    setActiveFormatZone("America/New_York");
    await expect(await rowCopyReading("en", EN, "America/New_York")).toMatchFileSnapshot(
      "./row-words/row-copy-english.txt",
    );
  });

  it("in German, with the German catalogue, in Auckland", async () => {
    setActiveCatalog("de", GERMAN);
    setActiveFormatZone("Pacific/Auckland");
    await expect(await rowCopyReading("de", GERMAN, "Pacific/Auckland")).toMatchFileSnapshot(
      "./row-words/row-copy-german.txt",
    );
  });
});

describe("the rows' words read what they are handed", () => {
  const LETTER = { date: "2026-07-29T09:12:00.000Z", sortAt: "2026-07-29T09:12:00.000Z" } as EngineMessage;

  it("the locale, the zone and the catalogue come from whoever hands them, not from the shell's own register", () => {
    setActiveCatalog(DEFAULT_LOCALE, null);
    setActiveFormatZone(null);
    setFormatWords({
      locale: () => "de",
      zone: () => "Asia/Tokyo",
      translatorOf: (namespace) => (namespace === "place" ? (key) => `«${key}»` : null),
    });
    try {
      expect(PLACE_LABEL.receipts).toBe("«receipts»");
      expect(placeLabel("ohmail/Receipts")).toBe("«receipts»");
      expect(AGO_COPY.justNow).toBe("just now");
      expect(clockOf(LETTER.date!)).toBe("18:12");
      expect(fullDateTime(LETTER)).toBe("Mi 29 Jul 2026, 18:12");
    } finally {
      setFormatWords(null);
    }
    /* Nothing handed: English, the machine's own zone (this file pins it to Zurich). */
    expect(PLACE_LABEL.receipts).toBe("Receipts");
    expect(clockOf(LETTER.date!)).toBe("11:12");
    expect(fullDateTime(LETTER)).toBe("Wed 29 Jul 2026, 11:12");
  });

  it("the catalogue a host hands by setActiveCatalog alone reaches the rows' words", () => {
    setActiveFormatZone(null);
    setFormatWords(null);
    setActiveCatalog("de", GERMAN);
    try {
      expect(PLACE_LABEL.receipts).toBe("Belege");
      expect(placeLabel("ohmail/Receipts")).toBe("Belege");
    } finally {
      setActiveCatalog(DEFAULT_LOCALE, null);
      setFormatWords(null);
    }
  });
});

describe("the rows' badges and sent labels read the translator they are handed", () => {
  it("their words come from the translator the caller hands, with no catalogue's provider around them", async () => {
    const { messages } = await world();
    const handed: Translator = (key, values) => `${key}(${Object.values(values ?? {}).join(",")})`;
    const seen: { copy?: RowBadgeCopy; sent?: SentLabel | null } = {};
    function Probe(): null {
      seen.copy = useRowBadgeCopy(handed);
      seen.sent = useSentLabel(handed)(messages.find((m) => m.id === "x-sent")!);
      return null;
    }
    renderToStaticMarkup(h(Probe));
    expect(seen.copy?.protectedLabel).toBe("rowProtected()");
    expect(seen.copy?.held(3)).toBe("rowHeld(3)");
    expect(seen.copy?.marks(5, 2)).toBe("rowMarks(5,2)");
    expect(seen.copy?.spoken).toEqual({ unread: "rowUnread()", read: "rowRead()", attachment: "rowAttachment()" });
    expect(seen.sent).toEqual({ label: "rowSentToMore(Nora Lindt,1)", avatar: { avatarInitial: "N", avatarHue: 25 } });
  });
});

describe("a tag's hue is clamped to the hues it is handed", () => {
  const tag = (hue: string): TagDTO => ({ id: "t", name: "T", hue }) as TagDTO;

  it("a hue the handed list holds is kept, any other paints moss", () => {
    const hues = ["moss", "ochre"] as const;
    expect(hueOf(tag("ochre"), hues)).toBe("ochre");
    expect(hueOf(tag("rosewood"), hues)).toBe("moss");
    expect(hueOf(tag("teal"), hues)).toBe("moss");
  });
});
