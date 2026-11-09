/**
 * THE PHONE HAS A HISTORY PLACE, AND IT HOLDS EXACTLY WHAT THE SCREENER DOES NOT.
 *
 * ── THE DEFECT ────────────────────────────────────────────────────────────────────────────
 *
 * The cutline retires a sender nobody ever screened once their mail is old and read: the
 * partition sets `placeOf` to `null`, `presentationReader` deletes the row from the projected
 * mirror, and every list on this phone renders that projection. The browser catches those rows
 * in a place of its own (`apps/webapp/app/views/HistoryView.tsx`); the phone had no such surface,
 * so the retired half of a mailbox was in NO LIST AT ALL — not the Screener, not the Ohbox, not
 * a folder. Opening one by id said "no longer here", because the projection is what the reading
 * screen looked it up in.
 *
 * ── WHAT IS DRIVEN HERE ───────────────────────────────────────────────────────────────────
 *
 * Real senders' mail in the gate folder on a real loopback server, drained by the real engine
 * through `bootEngine`, read through the screens' own selectors. Every arm below asserts the
 * SAME partition's two halves against each other: `liveScreener(world.reader)` and
 * `liveHistory(raw, world.history)`. There is no renderer in this suite, so the route, the nav
 * entry and the deep-link gate are asserted over their own source.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FOLDER_OF_VIEW, type EngineMessage, type EntityReader } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  liveHistory,
  liveMessage,
  liveScreener,
  presentedWorld,
  screeningAnswered,
  SCREENING_UNANSWERED,
  SCREENING_UNSUPPLIED,
  type WorldView,
} from "../src/state/live";
import { Copy, DECKS } from "../src/copy";
import { LOCALES } from "../src/i18n/locale";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const view: WorldView = { now: NOW, zone: "UTC" };

/**
 * THE ACCOUNT'S OWN ANSWER, and it is the one that retires anybody: a real baseline plus the
 * window mode. `all_time` — the mode the base lane's fixture uses — files NOBODY into History
 * (`cutlineFor` answers `-Infinity`), so a fixture carrying it cannot watch this surface fill.
 */
const ACCOUNT = { dormancyDays: 60, baselineAt: "2026-01-01T00:00:00.000Z", scope: "window" } as const;
/** …as the posture the world layer is in once the consent read has landed. */
const ANSWERED = screeningAnswered(ACCOUNT);

/** Recent and unread: active under this window, so its sender waits at the gate. */
const RECENT = "2026-08-20T08:00:00.000Z";
/** Old and read: before `baseline - 60d` (2025-11-02), so its sender is retired to History. */
const OLD = "2024-02-01T08:00:00.000Z";

const world = sqlWorld();
const deps: MobileEngineDeps = {
  openExecutor: world.open,
  deleteDatabase: world.drop,
  uuid: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
};

function at(fake: ReturnType<typeof mailServer>, id: string, sender: number, date: string, unread: boolean): void {
  fake.addMessage(dto(id, {
    subject: id,
    folder: FOLDER_OF_VIEW.screener,
    from: { name: `Stranger ${sender}`, address: `stranger${sender}@fake.test` },
    date,
    unread,
  }));
}

async function bootOn(fake: ReturnType<typeof mailServer>, origin: string) {
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error(`boot refused: ${boot.kind === "refused" ? boot.reason : ""}`);
  await boot.verifyIdentity();
  await boot.engine.start();
  return boot;
}

/** Both arms of ONE partition, the way the world layer derives them. */
function bothArms(reader: EntityReader) {
  const parted = presentedWorld(reader, NOW, false, ANSWERED);
  return {
    waiting: liveScreener(parted.reader, view).waiting,
    history: liveHistory(reader, parted.history, view),
  };
}

describe("the Screener's waiting senders and History's mail are one partition, two arms", () => {
  it("N waiting and M retired account for every sender the gate holds", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      // Two senders recent and unread (N = 2); three old and read (M = 3, one message each).
      at(fake, "w-1", 1, RECENT, true);
      at(fake, "w-2", 2, RECENT, true);
      at(fake, "h-3", 3, OLD, false);
      at(fake, "h-4", 4, OLD, false);
      at(fake, "h-5", 5, OLD, false);
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();
      // The server holds five senders' mail at the gate; the cutline decides which half is which.
      expect(reader.list<EngineMessage>("message")).toHaveLength(5);

      const { waiting, history } = bothArms(reader);
      expect(waiting.map((r) => r.address).sort()).toEqual([
        "stranger1@fake.test", "stranger2@fake.test",
      ]);
      expect(history.items.map((m) => m.id).sort()).toEqual(["h-3", "h-4", "h-5"]);
      expect(history.total).toBe(3);
      // N + M is the whole gate: nothing was dropped into a surface that does not exist, and
      // nothing is listed twice.
      expect(waiting.length + history.total).toBe(5);
      const twice = history.items.filter((m) =>
        waiting.some((r) => r.address === m.from.address));
      expect(twice, "a sender in both lists — the partition was read twice").toEqual([]);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("History is newest first, and carries the browser's count line", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      at(fake, "h-old", 3, "2024-01-01T08:00:00.000Z", false);
      at(fake, "h-mid", 4, "2024-06-01T08:00:00.000Z", false);
      at(fake, "h-new", 5, "2025-01-01T08:00:00.000Z", false);
      const boot = await bootOn(fake, origin);
      const { history } = bothArms(boot.engine.read());
      expect(history.items.map((m) => m.id)).toEqual(["h-new", "h-mid", "h-old"]);
      // The meta line the screen renders, which is the world's `Copy.historyMeta(total)`.
      expect(Copy.historyMeta(history.total)).toBe("3 messages");
      expect(Copy.historyMeta(1)).toBe("1 message");
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("A SENDER WHO WRITES AGAIN LEAVES HISTORY FOR THE SCREENER, and takes their mail", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      at(fake, "w-1", 1, RECENT, true);
      at(fake, "h-3", 3, OLD, false);
      const boot = await bootOn(fake, origin);

      const before = bothArms(boot.engine.read());
      expect(before.waiting.map((r) => r.address)).toEqual(["stranger1@fake.test"]);
      expect(before.history.items.map((m) => m.id)).toEqual(["h-3"]);

      // Stranger 3 writes again. The promise `historyEmptyHint` makes in words: they go to the
      // Screener and BRING THIS MAIL WITH THEM — so `h-3` must leave History too, on the row
      // whose decision it informs.
      at(fake, "w-3", 3, RECENT, true);
      await boot.engine.syncOnce();

      const after = bothArms(boot.engine.read());
      expect(after.waiting.map((r) => r.address).sort()).toEqual([
        "stranger1@fake.test", "stranger3@fake.test",
      ]);
      expect(after.history.items, "the old mail stayed behind in History").toEqual([]);
      const three = after.waiting.find((r) => r.address === "stranger3@fake.test");
      expect(three?.held.map((h) => h.id).sort(), "the held bag did not bring the old mail")
        .toEqual(["h-3", "w-3"]);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("an account whose answer retires nobody has an EMPTY History, and keeps everybody at the gate", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      at(fake, "h-3", 3, OLD, false);
      at(fake, "h-4", 4, OLD, false);
      const boot = await bootOn(fake, origin);
      const reader = boot.engine.read();
      const parted = presentedWorld(reader, NOW, false, screeningAnswered({
        dormancyDays: ACCOUNT.dormancyDays,
        baselineAt: ACCOUNT.baselineAt,
        scope: "all_time",
      }));
      // `all_time` is the mode's whole promise: every unruled sender queues, nothing is retired.
      expect(liveScreener(parted.reader, view).waiting).toHaveLength(2);
      const history = liveHistory(reader, parted.history, view);
      expect(history.items).toEqual([]);
      expect(history.total).toBe(0);
      /* …and the same for the two postures with no answer behind them, which partition at
         `all_time` for this reason: neither may invent a window, so neither retires anybody.
         What separates them is whether an answer is still coming — `cutlinePending`, which is
         what the screens mark. */
      const unanswered = presentedWorld(reader, NOW, false, SCREENING_UNANSWERED);
      expect(liveHistory(reader, unanswered.history, view).total).toBe(0);
      expect(unanswered.cutlinePending).toBe(true);
      const unsupplied = presentedWorld(reader, NOW, false, SCREENING_UNSUPPLIED);
      expect(liveHistory(reader, unsupplied.history, view).total).toBe(0);
      expect(unsupplied.cutlinePending).toBe(false);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });
});

describe("a History row states where it actually is, and opens", () => {
  it("the row wears the SERVER's folder as its place chip — nothing has moved", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      at(fake, "h-3", 3, OLD, false);
      const boot = await bootOn(fake, origin);
      const row = bothArms(boot.engine.read()).history.items[0]!;
      // The gate folder is where this message physically sits, and the chip says so. A pile
      // label would be the one place in the product that shows mail somewhere other than its
      // folder without admitting to it.
      expect(row.historyPlace).toBe(FOLDER_OF_VIEW.screener);
      expect(row.folder).toBe(FOLDER_OF_VIEW.screener);
      // Read by construction: an unread message makes its sender active, so it is never here.
      expect(row.unread).toBe(false);
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });

  it("OPENING IT WORKS — the reading screen reads past the projection that dropped it", async () => {
    const fake = mailServer();
    const origin = await listen(fake.server);
    try {
      at(fake, "h-3", 3, OLD, false);
      const boot = await bootOn(fake, origin);
      const v: WorldView = { ...view, screening: ANSWERED };

      // The projection has no such message — that IS History — so a reading screen that only
      // looked there said "no longer here" over mail the list was showing.
      const parted = presentedWorld(boot.engine.read(), NOW, false, ANSWERED);
      expect(parted.reader.get<EngineMessage>("message", "h-3")).toBeUndefined();

      const opened = liveMessage(boot.engine, "h-3", v);
      expect(opened, "a History row could not be opened").toBeDefined();
      expect(opened!.subject).toBe("h-3");
      expect(opened!.historyPlace).toBe(FOLDER_OF_VIEW.screener);
      // A row the projection DOES hold is untouched by the new arm: no `historyPlace`, so the
      // reading screen titles it by its place exactly as before.
      at(fake, "w-1", 1, RECENT, true);
      await boot.engine.syncOnce();
      const ordinary = liveMessage(boot.engine, "w-1", v);
      expect(ordinary?.historyPlace).toBeUndefined();
      boot.store.close();
    } finally {
      fake.server.close();
    }
  });
});

/* ── the surfaces, read as source (there is no renderer in this suite) ───────────────────── */

const src = (p: string) => readFileSync(fileURLToPath(new URL(`../${p}`, import.meta.url)), "utf8");

describe("the History place is reachable, and gated like every other mail route", () => {
  const route = src("app/history.tsx");

  it("the route is GATED — a deep link must not render the empty world", () => {
    /* `ohmail://history` (and a route restored after the session ended) mounts this screen
       without the tabs layout ever focusing. Ungated it would paint the empty world's "Nothing
       has settled here yet" at an unpaired phone, with no way out. `app/triage.tsx`'s rule. */
    expect(route).toContain('import { Gated } from "../src/ui/Gated";');
    expect(route).toMatch(/<Gated>\s*<HistoryBody inPane=\{inPane\} \/>\s*<\/Gated>/);
  });

  it("renders the browser's explainer above the list, and the rest behind the disclosure", () => {
    expect(route).toContain("Copy.historyExplainer}");
    expect(route).toContain("Copy.historyExplainerMoreLabel");
    expect(route).toContain("Copy.historyExplainerMore}");
    // The disclosure announces its state, the way `app/standalone.tsx`'s does.
    expect(route).toContain("accessibilityState={{ expanded: more }}");
  });

  it("draws the empty state, the rows and the tail — and no unread grouping", () => {
    expect(route).toContain("Copy.historyEmptyTitle");
    expect(route).toContain("Copy.historyEmptyHint");
    expect(route).toContain("Copy.historyTail(h.total)");
    expect(route).toContain("<MailRow");
    /* NO NEW / EARLIER split: History is one timeline, newest first (ARCHIVE-024). */
    expect(route).not.toContain("Copy.groupNew");
    expect(route).not.toContain("Copy.groupSeen");
  });

  it("the More screen carries the nav entry, with the rail's title and subtitle and NO count", () => {
    const more = src("app/(tabs)/more.tsx") +
      /* The rows moved into the shared MoreNav (the drawer mounts the same list). */
      src("src/ui/MoreNav.tsx");
    /* The entry navigates through the pair's own `go` (it closes the drawer first), and `go`
       is the push — the mechanism moved, the destination did not. */
    expect(more).toContain('go("/history")');
    expect(more).toContain("router.push(path)");
    expect(more).toContain("label={Copy.history}");
    expect(more).toContain("sub={Copy.historyNavSub}");
    /* The count is absent DELIBERATELY (the browser's `rail-history.test.tsx` holds the same
       absence): History is all read, so a number beside it would claim attention. This asserts
       the History entry's own props, not the file — Scheduled below it does carry a count. */
    const entry = more.slice(more.indexOf("label={Copy.history}"));
    expect(entry.slice(0, entry.indexOf("/>")), "the History entry grew a count")
      .not.toContain("count=");
  });

  it("the reading screen titles a History message History, not the Ohbox it is not in", () => {
    const screen = src("src/ui/MessageReader.tsx");
    /* The reading view is `MessageReader` now — the route and the two-pane surfaces mount it.
       History still wins the title, and it is still read FIRST — a dormant undecided sender's
       held mail is both retired and at the gate, and the surface it was opened from is History.
       The gate arm sits between History and the folder leaf (`screener-gate-partition.test.ts`
       owns it); this assertion keeps History's own position in the chain. */
    expect(screen).toContain("m.historyPlace ? Copy.history :");
    expect(screen).toContain("m.folderLeaf ?? placeName(m.place)");
  });

  it("the row's place chip is the message's own field, in the place tone", () => {
    const row = src("src/ui/MailRow.tsx");
    expect(row).toContain('{m.historyPlace ? <Badge tone="place">{m.historyPlace}</Badge> : null}');
    // …and the badge strip has to be drawn at all for a row whose only badge is the chip.
    expect(row).toContain("|| !!m.historyPlace");
  });
});

/** Every History key the screens read. Listed once; both assertions below walk it. */
const HISTORY_KEYS = [
  "history", "historyNavSub", "historyMeta", "historyExplainer", "historyExplainerMore",
  "historyExplainerMoreLabel", "historyEmptyTitle", "historyEmptyHint", "historyTail",
] as const;

describe("the copy is the browser's, in both languages", () => {
  /** One deck member as a SENTENCE, whether it is a string or a counted function. */
  const say = (locale: (typeof LOCALES)[number], key: string): string => {
    const member = (DECKS[locale] as unknown as Record<string, unknown>)[key];
    return typeof member === "function" ? (member as (n: number) => string)(3) : member as string;
  };

  it("every History key is a real sentence in every language this build carries", () => {
    /* `copy-parity.test.ts` holds the equalities against `messages/en.json` / `de.json` — this
       is the narrower question that file cannot ask about keys it does not know exist yet: is
       each of them present, and does it say anything at all? */
    expect(LOCALES.length, "no locales — the walk below proves nothing").toBeGreaterThan(1);
    for (const locale of LOCALES) {
      for (const key of HISTORY_KEYS) {
        expect(say(locale, key).trim(), `${locale}.${key} renders nothing`).not.toBe("");
      }
    }
  });

  it("NEVER says Archive — in any language, on any of its sentences", () => {
    /* The hard stop, as a check. "Archive" is a verb in every other mail client — an action
       this mail never received — and a mailbox with a real server-side Archive folder would be
       shown a view by that name whose contents are not that folder's. Both stems, so the German
       "Archiv" cannot slip through an English-only match. */
    for (const locale of LOCALES) {
      for (const key of HISTORY_KEYS) {
        expect(say(locale, key), `${locale}.${key} says Archive`).not.toMatch(/archiv/i);
      }
    }
    // The matcher really does catch the word it is watching for — otherwise every line above
    // passes for a reason that has nothing to do with the rule.
    expect("Archived mail", `the census cannot see the word it bans`).toMatch(/archiv/i);
    expect("Archivierte Post").toMatch(/archiv/i);
  });

  it("the phone's History screen reads the deck, never a literal of its own", () => {
    /* `copy-census.test.ts` is the general rule; this is the one screen's own instance of it,
       because a sentence typed into the route is a sentence German cannot reach. */
    const route = src("app/history.tsx");
    /* Two keys are read somewhere else and named here so the walk stays total: the nav entry's
       second line belongs to the More screen, and the count line is composed in the world layer
       (`Copy.historyMeta(history.total)`) so the screen renders ONE number rather than deriving
       a second from the rows it happens to hold. */
    const elsewhere: Record<string, string> = {
      historyNavSub: "src/ui/MoreNav.tsx",
      historyMeta: "src/state/world-projection.ts",
    };
    for (const key of HISTORY_KEYS) {
      const where = elsewhere[key] ?? "app/history.tsx";
      expect(src(where), `${key} has no call site in ${where}`).toContain(`Copy.${key}`);
      if (where !== "app/history.tsx") continue;
      expect(route, `${key} has no call site on the History screen`).toContain(`Copy.${key}`);
    }
  });
});
