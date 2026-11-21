/** @vitest-environment jsdom */
/**
 * ═══ TWO FACTS, TWO WORDS — the reading streams' count says which one it is ══════════════════
 *
 * The Reads and Receipts header, and the rail badge beside them, count the WATERLINE: mail that
 * arrived since this reader last left the stream (`FeedPartition.newCount` — fresh AND still
 * unread on the server). For a year the sentence over that number was "{count} new", which is
 * also the phrasing this app uses for an UNREAD count. One word, two facts, and nothing on
 * screen to tell them apart:
 *
 *   · a reader who has read nothing sees "0 new" over a stream full of unread mail — the line
 *     is at the top because they never left it, and every row below is unread;
 *   · a reader who has read everything here but has unread mail below the line sees a count
 *     that demands attention for one fact while the rows show the other.
 *
 * So the number keeps its derivation and the sentence names it: "12 new since you were here".
 * The unread figure keeps its own word ("unread"/"ungelesen" — `markAll.aria`, `rail.ohboxTitle`).
 *
 * ── WHAT THIS FILE GUARDS, IN TWO DIRECTIONS ───────────────────────────────────────────────
 *
 * 1. THE CATALOGUES. Every key a waterline count is rendered through carries the "since" clause,
 *    in both languages, and no unread key wears the word "new". A SWEEP over the whole catalogue
 *    then catches the NEXT key that writes a bare "new" beside a count: it must be a waterline
 *    key or a named exemption with a reason. Two exemptions exist and both are reasoned below.
 * 2. THE RENDER. The header and the Mark-all-read control are mounted over one pile holding both
 *    numbers at once, in English and in German, and each number is asserted to appear ONLY with
 *    its own word. A source assertion cannot do this: the first draft of the badge's own guard
 *    asserted the source said `count: newCount` and a mutation that kept the name while changing
 *    the value sailed through (`cross-surface-convergence.test.tsx` records that).
 *
 * ── THE FIXTURE'S ARITHMETIC, WHICH IS NOT THE ROW'S ───────────────────────────────────────
 *
 * The row that asked for this describes the defect as "'12 new' beside 3 unread". That pair is no
 * longer representable and it is worth saying why rather than quietly picking other numbers: the
 * header's count USED to be the positional `freshCount`, which can stand at 12 over a pile with
 * three unread rows. It is now `newCount` — fresh AND unread — so the waterline count can never
 * exceed the pile's unread count. The closest pile that holds both of the row's numbers is the
 * one below: twelve unread arrivals above the line (the waterline count, 12) and three unread
 * rows below it (mail the waterline does not count, 3). The unread figure the surface renders is
 * therefore 15, and 15 ≠ 12 is what makes the two statements tell each other apart.
 *
 * The derivation itself is not touched here and is not this file's subject — `selectors.ts` owns
 * it and `cross-surface-convergence.test.tsx` owns its agreement across surfaces.
 */
import type { EngineMessage, Folder } from "@ohmail/wire";
import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, onTestFinished } from "vitest";
import * as live from "./fixtures/live-walk-shell.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MemoryMirrorStore,
  OhmailEngine,
  feedPartition,
  waterlineIdOf,
  type FeedPartition,
  type SyncChange,
} from "@ohmail/client-engine";

import FRAME_EN from "../../../packages/app/messages/frame.en.json";
import FRAME_DE from "../../../packages/app/messages/frame.de.json";
import NEWS_EN from "../../../packages/app/messages/news.en.json";
import NEWS_DE from "../../../packages/app/messages/news.de.json";
import OHBOX_EN from "../../../packages/app/messages/ohbox.en.json";
import OHBOX_DE from "../../../packages/app/messages/ohbox.de.json";
import SETTINGS_EN from "../../../packages/app/messages/settings.en.json";
import SETTINGS_DE from "../../../packages/app/messages/settings.de.json";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const src = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

type Locale = "en" | "de";
const CATALOGUE = {
  en: { ...FRAME_EN, ...NEWS_EN, ...OHBOX_EN, ...SETTINGS_EN },
  de: { ...FRAME_DE, ...NEWS_DE, ...OHBOX_DE, ...SETTINGS_DE },
};

const at = (root: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>(
    (o, k) => (o != null && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined),
    root,
  );

/* ══ 1. THE CATALOGUES ═══════════════════════════════════════════════════════════════════════ */

/**
 * Every catalogue key a WATERLINE count is rendered through. Adding a surface that shows the
 * waterline means adding its key here, and the assertions below then require the clause.
 */
const WATERLINE_KEYS = [
  "stream.newSince",   // the Reads and Receipts pile header, list side and stream side
  "rail.readsTitle",   // the rail badge's tooltip, for both streams
  "markAll.ariaFresh", // Mark-all-read's label when the line stands over nothing unread
] as const;

/** Every catalogue key an UNREAD count is rendered through. */
const UNREAD_KEYS = [
  "markAll.aria",     // Mark-all-read's label whenever the pile holds unread mail
  "rail.ohboxTitle",  // the Ohbox badge's tooltip
  /* The Ohbox pile header (`OhboxView`, from `unreadIds.length`). It said "{count} new" for two
     releases, on the recorded ground that the form matched the Reads header — and it stopped
     matching the moment Reads began naming the waterline, which left one word standing for two
     facts on two adjacent piles. It carries the noun now, so this key belongs in this list
     rather than in the exemptions below, where it sat for exactly one commit. */
  "ohbox.meta",
] as const;

/** The clause that names the waterline, per language. */
const SINCE: Record<Locale, string> = {
  en: "since you were here",
  de: "seit deinem letzten Besuch",
};

/**
 * The word that names unread, per language. German inflects it — `markAll.aria` says
 * "ungelesenen" — so the German arm is deliberately a stem and not a whole word: an anchored
 * `\bungelesen\b` reported that the German label does not say unread at all, which was the
 * guard failing on correct copy.
 */
const UNREAD_WORD: Record<Locale, RegExp> = { en: /\bunread\b/, de: /ungelesen/ };

/**
 * A COUNT WITH A BARE "NEW" BESIDE IT — the shape being ended. `{count}` in any of its ICU
 * spellings, or a plural arm's `#`, immediately followed by the word.
 */
const BARE_NEW = /(\{count[^{}]*\}|#)\s+(new|New|neu|neue|neues|Neu|Neue|Neues)\b/;

/* The exemptions of the bare-"new" sweep moved with it to `waterline-word-catalogue.test.ts`. */

describe("the catalogues keep the waterline and unread apart", () => {
  /* The sweep for a bare "new" beside a count, its exemptions and the Ohbox's rail tooltip moved to
     `waterline-word-catalogue.test.ts`, over the catalogue the new shell draws its words from. */
  for (const locale of ["en", "de"] as const) {
    describe(locale, () => {
      it("every waterline sentence names the waterline", () => {
        for (const key of WATERLINE_KEYS) {
          const s = at(CATALOGUE[locale], key);
          expect(typeof s, `${locale} ${key} is missing`).toBe("string");
          expect(s as string, `${locale} ${key} does not name the waterline`)
            .toContain(SINCE[locale]);
        }
      });

      it("no waterline sentence borrows the word for unread", () => {
        for (const key of WATERLINE_KEYS) {
          expect(UNREAD_WORD[locale].test(at(CATALOGUE[locale], key) as string), `${locale} ${key}`)
            .toBe(false);
        }
      });

      it("every unread figure says unread, and never says new", () => {
        for (const key of UNREAD_KEYS) {
          const s = at(CATALOGUE[locale], key);
          expect(typeof s, `${locale} ${key} is missing`).toBe("string");
          expect(UNREAD_WORD[locale].test(s as string), `${locale} ${key} does not say unread`)
            .toBe(true);
          expect(BARE_NEW.test(s as string), `${locale} ${key} writes a bare "new"`).toBe(false);
        }
      });

      it("the rail's tooltip says exactly what the header says", () => {
        /* Two keys, one sentence — the rail namespace and the stream namespace do not cross in
           `next-intl`, and a second copy of one sentence is how the pane and the rail came to
           disagree before (the "3 new" beside a rail saying "1" report). Pinned equal so a
           lane editing one is refused rather than shipping a drift nobody can see. */
        expect(at(CATALOGUE[locale], "rail.readsTitle"))
          .toBe(at(CATALOGUE[locale], "stream.newSince"));
      });
    });
  }
});

describe("the surfaces read the shared sentence, not a copy of it", () => {
  const STREAM = src("packages/app/src/stream/StreamList.tsx");

  it("both streams render their header through `stream.newSince`", () => {
    for (const place of ["news", "receipts"]) {
      const seat = src(`packages/app/src/${place}/place.ts`);
      expect(seat, `${place} renders its list through the shared stream`).toContain("List: StreamList");
    }
    expect(STREAM).toContain('useText("stream")');
    expect(STREAM).toContain('since("newSince", { count: model.newCount })');
    const phone = STREAM.slice(STREAM.indexOf('if (plan.device === "phone")'));
    expect(phone).toContain("{head}");
    expect(phone).toContain("head={head}");
    expect(/t\("meta"/.test(STREAM)).toBe(false);
  });

  it("the rail's two stream badges read the tooltip that says the same thing", async () => {
    const el = await mountNews("en", true);
    for (const [name, count] of [["News", 12], ["Receipts", 1]] as const) {
      const badge = within(el).getByRole("button", { name: new RegExp(`^${name} ${count}$`) });
      const sentence = `${count} new since you were here`;
      const titles = [...badge.querySelectorAll("[title]"), badge].map((node) => node.getAttribute("title"));
      expect.soft(titles, name).toContain(sentence);
    }
  });

});

/* ══ 2. THE RENDER ═══════════════════════════════════════════════════════════════════════════ */

const NOW = new Date("2026-08-20T12:00:00.000Z");
/** Descending, one hour apart — index order is display order, newest first. */
const d = (i: number): string =>
  new Date(Date.UTC(2026, 7, 20, 9, 0, 0) - i * 3_600_000).toISOString();

let seq = 0;
function msg(id: string, i: number, unread: boolean, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: id, address: `${id}@example.com` },
    to: [], cc: [], date: d(i), folder, snippet: `snippet ${id}`, unread,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: d(i),
  };
}

/**
 * TWELVE UNREAD ARRIVALS ABOVE THE LINE, THREE UNREAD ROWS BELOW IT.
 *
 * `a0` is the anchor and is READ, because the cut is exclusive and the anchor sits below the
 * line. So: `newCount` 12 (the waterline), and 15 unread over the pile.
 */
async function pileStore(withReceipt = false): Promise<MemoryMirrorStore> {
  const rows: EngineMessage[] = [
    ...Array.from({ length: 12 }, (_, i) => msg(`n${i}`, i, true, "ohmail/News")),
    msg("a0", 12, false, "ohmail/News"),
    ...Array.from({ length: 3 }, (_, i) => msg(`o${i}`, 13 + i, true, "ohmail/News")),
  ];
  if (withReceipt) rows.push(msg("purchase", 1, true, "ohmail/Receipts"));
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rows.map((m) => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })) as SyncChange[]);
  await store.putLocal("view_meta", waterlineIdOf("reads"), { newestSeenId: "a0", at: d(12) });
  return store;
}

async function pile(): Promise<FeedPartition> {
  return feedPartition(await pileStore(), "reads");
}

async function mountNews(locale: Locale, withReceipt = false): Promise<HTMLElement> {
  live.installShellEnv();
  onTestFinished(live.teardownShellEnv);
  localStorage.clear();
  live.answerConsentWith({ foldersEnabledAt: live.ISO });
  window.location.hash = "#/reads";
  const store = await pileStore(withReceipt);
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: live.ISO,
      }),
      mutate: async () => ({ changes: [], seq: null }),
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
  await engine.start();
  return live.mountShell([live.mailbox({ lastSyncAt: live.ISO })], { engine, locale });
}

function menuIn(el: HTMLElement, locale: Locale) {
  const list = within(within(el).getByRole("region", { name: "News" }));
  const header = within(list.getByRole("banner"));
  fireEvent.click(header.getByRole("button", { name: locale === "en" ? "List" : "Liste" }));
  const label = locale === "en"
    ? /^(Mark all read|Mark all \d+ unread)/
    : /^(Alles als gelesen markieren|Alle \d+ ungelesenen)/;
  return { header, markAll: screen.getByRole("menuitem", { name: label }) };
}

describe("the two numbers on one screen never share a word", () => {
  it("the pile really does hold both numbers — 12 above the line, 15 unread", async () => {
    /* The fixture is the subject here: a render case over a pile that holds only one of the two
       numbers cannot tell a swap from a pass, and this is the arithmetic the header note above
       explains. */
    const part = await pile();
    expect(part.newCount).toBe(12);
    expect(part.fresh).toHaveLength(12);
    expect([...part.fresh, ...part.seen].filter((m) => m.unread)).toHaveLength(15);
  });

  const EXPECT: Record<Locale, { head: string; unread: string; never: readonly string[] }> = {
    en: {
      head: "12 new since you were here",
      unread: "Mark all 15 unread messages read",
      /* The row's own two mis-readings, and the swap of each number onto the other's word. */
      never: ["12 unread", "3 new", "15 new", "12 new messages", "Nothing new"],
    },
    de: {
      head: "12 neue seit deinem letzten Besuch",
      unread: "Alle 15 ungelesenen Nachrichten als gelesen markieren",
      never: ["12 ungelesen", "3 neue", "15 neue", "Nichts Neues"],
    },
  };

  for (const locale of ["en", "de"] as const) {
    it(`${locale}: the header says which count it is, and the control says the other`, async () => {
      const want = EXPECT[locale];
      const el = await mountNews(locale);
      const { header, markAll } = menuIn(el, locale);
      expect(header.getByText(want.head)).toBeTruthy();
      expect.soft(markAll.getAttribute("aria-label")).toBe(want.unread);

      const text = el.textContent ?? "";
      const aria = Array.from(el.querySelectorAll("[aria-label]"))
        .map((e) => e.getAttribute("aria-label") ?? "").join(" | ");
      for (const forbidden of want.never) {
        expect(`${text} | ${aria}`.includes(forbidden), `the surface says "${forbidden}"`)
          .toBe(false);
      }
    });
  }
});

describe("the two counts in the mounted News list", () => {
  for (const locale of ["en", "de"] as const) {
    it(`${locale}: the header names arrivals since the visit and the menu shows the unread figure`, async () => {
      const el = await mountNews(locale);
      const { header, markAll } = menuIn(el, locale);
      const expected = locale === "en" ? "12 new since you were here" : "12 neue seit deinem letzten Besuch";
      expect(header.getByText(expected)).toBeTruthy();
      expect(within(markAll).getByText("15")).toBeTruthy();
    });
  }
});

/* The list's foot states the read rule: an item turns read once it rests in the stream, and a
   list scroll reads nothing (#415). It used to say scrolling past marked it seen. */
describe("the News list's foot names the read rule the stream runs", () => {
  const RULE: Record<Locale, { says: readonly string[]; never: RegExp }> = {
    en: { says: ["rests on screen", "quick scroll past leaves it unread"], never: /scrolling past[^.]*marks/i },
    de: { says: ["auf dem Bildschirm stehen bleibt", "Vorbeiscrollen lässt ihn ungelesen"], never: /Vorbeiscrollen markiert/ },
  };

  for (const locale of ["en", "de"] as const) {
    it(`${locale}: the foot says what rests turns read and a quick scroll reads nothing`, async () => {
      const el = await mountNews(locale);
      const list = within(el).getByRole("region", { name: "News" });
      const foot = within(list).queryAllByRole("paragraph").at(-1)?.textContent ?? "";
      /* The stream's foot carries no explanatory sentence. */
      for (const s of RULE[locale].says) expect(foot).not.toContain(s);
      expect(foot).not.toMatch(RULE[locale].never);
      /* The demo's About text tells the same rule. */
      const about = at(CATALOGUE[locale], "about.p2") as string;
      expect(about).toContain(RULE[locale].says[0]);
      expect(about).not.toMatch(RULE[locale].never);
    });
  }
});
