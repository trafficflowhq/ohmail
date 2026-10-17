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
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { shellFrameOf } from "./source-anchor.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import {
  MemoryMirrorStore,
  feedPartition,
  waterlineIdOf,
  type EngineMessage,
  type FeedPartition,
  type Folder,
  type SyncChange,
} from "@ohmail/client-engine";

import EN from "../messages/en.json";
import DE from "../messages/de.json";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const src = (rel: string): string => fs.readFileSync(path.join(REPO, rel), "utf8");

type Locale = "en" | "de";
const CATALOGUE: Record<Locale, unknown> = { en: EN, de: DE };

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

/**
 * The keys that match `BARE_NEW` and are not waterline sentences. Named rather than waived, and
 * the "no exemption has rotted" case below deletes a row the day its string moves — which is how
 * this table went from two rows to one: `ohbox.meta` was exempted while it still counted unread
 * under the word "new", and moved into `UNREAD_KEYS` when it took the noun.
 */
const BARE_NEW_EXEMPT: Record<string, string> = {
  "ohbox.newSince":
    "The chip on a RESURFACED CONVERSATION, counting the messages that arrived after the pin "
    + "went up. A per-row fact with its own referent — this conversation, since you asked to see "
    + "it again — and neither the waterline nor a mailbox unread count, so neither word would be "
    + "true. The face is two words because a badge face is; the sentence it stands for is "
    + "`ohbox.newSinceTitle`, which the badge carries as its title and the row speaks.",
  "desktopDoor.notifyNewMail":
    "A push notification about mail that has just ARRIVED, which is a third fact and not a "
    + "standing count: the number is the messages that came in, and \"new\" is what they are. "
    + "No waterline and no read state is involved, so there is no second word to confuse it with.",
};

/* German only: "neue Absender" is the German for first-time senders (English "first-time
   senders", which this pattern never matches). The number counts SENDERS waiting in the Screener,
   not messages, so neither the waterline nor unread applies; "neu" is what the senders are. */
const BARE_NEW_EXEMPT_DE: Record<string, string> = {
  "ohbox.doorbellAria": "A count of first-time SENDERS waiting in the Screener (\"# neue Absender warten\"), not of messages.",
  "ohbox.emptyScreenerHint": "A count of first-time SENDERS waiting in the Screener, not of messages.",
  "screener.metaWaiting": "A count of first-time SENDERS waiting in the Screener, not of messages.",
  "screener.metaWaitingOnDevice": "A count of first-time SENDERS waiting in the Screener, not of messages.",
};

describe("the catalogues keep the waterline and unread apart", () => {
  it("the sweep can fire, and does not fire on ordinary copy", () => {
    /* The pattern is the whole guard, so it is pinned by example in both directions — a sweep
       that matches nothing passes over a catalogue full of the defect. */
    for (const yes of ["{count} new", "{count, number} new", "{count} neu", "one {# new}"]) {
      expect(BARE_NEW.test(yes), `${yes} is the shape being ended`).toBe(true);
    }
    for (const no of ["{count} unread", "New", "{count} newer messages", "Nothing new"]) {
      expect(BARE_NEW.test(no), `${no} is not the shape being ended`).toBe(false);
    }
  });

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

      it("no other key writes a bare \"new\" beside a count", () => {
        const hits: string[] = [];
        const walk = (o: unknown, prefix: string): void => {
          if (o == null || typeof o !== "object") return;
          for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
            const dotted = prefix ? `${prefix}.${k}` : k;
            if (typeof v === "string") {
              if (BARE_NEW.test(v) && !(WATERLINE_KEYS as readonly string[]).includes(dotted)
                  && !(dotted in BARE_NEW_EXEMPT)
                  && !(locale === "de" && dotted in BARE_NEW_EXEMPT_DE)) {
                hits.push(`${dotted}  ${JSON.stringify(v)}`);
              }
            } else walk(v, dotted);
          }
        };
        walk(CATALOGUE[locale], "");
        expect(
          hits,
          "a count is being rendered with a bare \"new\" beside it. If it is the waterline, say "
            + "so in the sentence and add the key to WATERLINE_KEYS; if it is an unread count, "
            + "say \"unread\"; if it is neither, add a row to BARE_NEW_EXEMPT saying which.",
        ).toEqual([]);
      });

      it("every exemption still matches a live string", () => {
        const exempt = { ...BARE_NEW_EXEMPT, ...(locale === "de" ? BARE_NEW_EXEMPT_DE : {}) };
        for (const [key, why] of Object.entries(exempt)) {
          const s = at(CATALOGUE[locale], key);
          expect(typeof s, `${locale} ${key} is exempted but gone — delete the row`).toBe("string");
          expect(BARE_NEW.test(s as string), `${locale} ${key} no longer needs its exemption`)
            .toBe(true);
          expect(why.length, `${key} has no reason`).toBeGreaterThan(40);
        }
      });
    });
  }
});

describe("the surfaces read the shared sentence, not a copy of it", () => {
  const READS = src("apps/webapp/app/views/ReadsView.tsx");
  const RECEIPTS = src("apps/webapp/app/views/ReceiptsView.tsx");
  /* The rail's badges moved with the rail to `shell-keys.tsx` (ARCH-022 L6). */
  const SHELL = shellFrameOf("railGroupsWithHints").source;

  it("both streams render their header through `stream.newSince`", () => {
    for (const [name, s] of [["ReadsView", READS], ["ReceiptsView", RECEIPTS]] as const) {
      expect(s, `${name} does not read the stream namespace`)
        .toContain('useTranslations("stream")');
      /* Two header slots per view: the list pane's `meta` and the mobile stream's `.meta.num`. */
      expect((s.match(/ts\("newSince", \{ count: \w+ \}\)/g) ?? []).length, `${name} header slots`)
        .toBe(2);
      /* And neither still carries its own copy of the sentence under a `meta` key. */
      expect(/t\("meta"/.test(s), `${name} still reads its own meta key`).toBe(false);
    }
  });

  it("the rail's two stream badges read the tooltip that says the same thing", () => {
    expect(SHELL).toContain('title: t("rail.readsTitle", { count: readsNew })');
    expect(SHELL).toContain('title: t("rail.readsTitle", { count: receiptsNew })');
  });

});

/* ══ 2. THE RENDER ═══════════════════════════════════════════════════════════════════════════ */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS = {
  escape: (s: string) => s.replace(/["\\]/g, (c) => `\\${c}`),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MockIO {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const NOW = new Date("2026-08-20T12:00:00.000Z");
/** Descending, one hour apart — index order is display order, newest first. */
const d = (i: number): string =>
  new Date(Date.UTC(2026, 7, 20, 9, 0, 0) - i * 3_600_000).toISOString();

let seq = 0;
function msg(id: string, i: number, unread: boolean, folder: Folder): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
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
async function pile(): Promise<FeedPartition> {
  const rows: EngineMessage[] = [
    ...Array.from({ length: 12 }, (_, i) => msg(`n${i}`, i, true, "ohmail/News")),
    msg("a0", 12, false, "ohmail/News"),
    ...Array.from({ length: 3 }, (_, i) => msg(`o${i}`, 13 + i, true, "ohmail/News")),
  ];
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(rows.map((m) => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })) as SyncChange[]);
  await store.putLocal("view_meta", waterlineIdOf("reads"), { newestSeenId: "a0", at: d(12) });
  return feedPartition(store, "reads");
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

async function mountReads(locale: Locale, partition: FeedPartition): Promise<void> {
  const { ReadsView } = await import("../app/views/ReadsView.js");
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale, messages: CATALOGUE[locale] as never, timeZone: "UTC", now: NOW,
        children: h(KeymapProvider as never, {
          children: h(ReadsView as never, {
    settled: true, owed: false,
            partition, tags: [], now: NOW, cur: null, onCur: () => {},
            aiChip: null, chipState: null, onChipState: () => {}, markSeen: () => {},
            bodyOf: (m: { snippet: string }) => ({ text: m.snippet, state: "snippet" }),
            hydrateBody: () => {}, jumpTo: null, onJumped: () => {},
            onLeaveSeen: () => {}, onMarkAllRead: () => {},
          } as never),
        } as never),
      }),
    );
  });
}

describe("the two numbers on one screen never share a word", () => {
  beforeAll(() => {
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIO;
  });

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
      await mountReads(locale, await pile());

      /* Both header slots: the list pane's own and the narrow stream's. */
      const metas = Array.from(host!.querySelectorAll(".vhead .meta, .stream-top .meta.num"))
        .map((e) => e.textContent);
      expect(metas.length, "neither header slot rendered").toBeGreaterThan(0);
      for (const m of metas) expect(m).toBe(want.head);

      /* The unread figure is the Mark-all-read label, and it wears the other word. */
      const btn = host!.querySelector<HTMLButtonElement>("button.mark-all-read");
      expect(btn, "no mark-all-read control over a pile with unread mail").not.toBeNull();
      expect(btn!.getAttribute("aria-label")).toBe(want.unread);

      /* And nothing anywhere on the surface puts either number under the other's word. */
      const text = host!.textContent ?? "";
      const aria = Array.from(host!.querySelectorAll("[aria-label]"))
        .map((e) => e.getAttribute("aria-label") ?? "").join(" | ");
      for (const forbidden of want.never) {
        expect(`${text} | ${aria}`.includes(forbidden), `the surface says "${forbidden}"`)
          .toBe(false);
      }
    });
  }
});
