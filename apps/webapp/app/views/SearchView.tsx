"use client";

/**
 * Search — ONE list. The mirror's instant index paints first (`engine.search()`, per keystroke);
 * the store's first page then REPLACES it in place — rows on screen that the store also returned
 * keep their places — and the rest is History's own list mechanism (`StoreSearchWalker`): pages by
 * the store's cursor, at most `HISTORY_PAGE_CACHE_ROWS` held, re-asked on the way back. Facets,
 * the count and the indexing progress are the store's, over the whole match set. Every pass ends
 * in one of three verdicts. Guesses keep their own tier (`search-rank`).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { useTranslations } from "next-intl";
import {
  folderLeaf,
  SERVER_SEARCH_SORTS,
  STORE_ANSWER_TIMEOUT_MS,
  StoreSearchWalker,
  VIEW_OF_FOLDER,
  type EngineMessage,
  type LocalSearchResult,
  type OhmailEngine,
  type SearchHit as EngineSearchHit,
  type ServerSearchFacets,
  type ServerSearchFilters,
  type ServerSearchSort,
} from "@ohmail/client-engine";
import { showSimilar } from "@trafficflow/core/search-rank";
import { Facets, SearchBox, type FacetGroup } from "@ohmail/ui";
import { displayTime, metaLine, PLACE_LABEL, placeLabel, senderName } from "../shell/format";
import { displayAddress } from "../shell/idn";
import { addressHref } from "../shell/address-view";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
import { useZoneNav } from "../shell/zone-nav";
import { storageOwner } from "../shell/storage-owner";
import { searchSortKey, usePersistedChoice } from "../shell/persisted-ui";
import { useListWindow } from "../shell/list-window";

/** One address and nothing else — the query shape whose empty state may offer the address door. */
const ADDRESS_QUERY = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
import { endSearch } from "../shell/ui-vitals";
import "./search-keys.css";

interface Filter {
  group: "folder" | "from" | "refine";
  label: string;
  /** The store's own key for this facet — the stored folder path or the sender address. */
  raw?: string;
}

/**
 * EVERY WAY THE PASS ENDS IS ONE OF THREE VERDICTS — matched, nothing matched, or the server did
 * not answer. A refusal renders the third, not the server's text: the text can carry what the
 * person typed, so the log line takes the CLASS the walker kept and the screen says what is on it.
 */
function logUnanswered(cause: string): void {
  console.warn("[search] the whole-mailbox pass did not answer:", cause);
}

/** A row of the device's first paint, before the store's page replaces it. */
interface MergedHit {
  hit: EngineSearchHit;
}

/**
 * One archive request per SETTLED query, never per keystroke.
 *
 * `GET /search` is `cost: "read"` and so is not gated for an unverified account, but the rule
 * against API cost with no revenue behind it is about volume, not class: a request per keystroke
 * would be ~7 RRF queries for the word
 * "invoice" against a table that joins `message_bodies`. The local pass is what covers the
 * typing; this covers the question.
 */
const ARCHIVE_DEBOUNCE_MS = 250;

/**
 * How long "Searching your whole mailbox…" may stand — the ceiling on the `searching` state.
 * Reported: the sentence never resolved — `searching` was a state only a SETTLED promise could
 * replace, and `searchServer` never rejects, which is no shape at all for a request that does not
 * come back (a dropped connection, a sleeping device). Fifteen seconds: several times the slowest
 * honest `GET /search`, short enough that the person still has the question in mind. A LATE answer
 * still wins — the timer replaces the sentence, it does not cancel the request: the sentence is
 * about this request, not the session.
 */
export const ARCHIVE_TIMEOUT_MS = STORE_ANSWER_TIMEOUT_MS;

/** How near the end of the list (px) the next store page is asked for. */
const PAGE_AHEAD_PX = 480;

/** The store's facet for a folder path, as the device keys it: a view id, else the leaf. */
const folderKeyOf = (folder: string): string =>
  (VIEW_OF_FOLDER as Record<string, string | undefined>)[folder] ?? folderLeaf(folder);

/**
 * Ordering the device's first paint under the chosen sort, so the top moves the moment the order
 * does; the store's page, which the store orders, then replaces it. `mailbox` is the one order this
 * client cannot compute — a message carries `mailboxId`, never the address — so over the device's
 * rows it degrades to date order, the store's answer being the one that orders by address.
 */
type SortRank = ReadonlyMap<string, number>;
const NO_RANK: SortRank = new Map();

/** Millis for ordering; a message with no `Date:` header sorts last in both directions. */
function stampOf(m: EngineMessage): number | null {
  if (!m.date) return null;
  const t = Date.parse(m.date);
  return Number.isFinite(t) ? t : null;
}

/** `a` before `b` by date, `dir` 1 for ascending. Undated always last, never first. */
function byDate(a: EngineMessage, b: EngineMessage, dir: 1 | -1): number {
  const ta = stampOf(a);
  const tb = stampOf(b);
  if (ta === null && tb === null) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return (ta - tb) * dir;
}

/** The displayed order for one sort. `relevance` returns the device's own ranking UNTOUCHED. */
function orderMerged(items: MergedHit[], sort: ServerSearchSort, mailboxRank: SortRank): MergedHit[] {
  if (sort === "relevance") return items;
  // `toSorted` is not available on every target this bundle supports; copy first so the memo
  // input is never mutated in place (React would not see the change, and the next render would
  // sort an already-sorted array — stable, but only by luck).
  const out = [...items];
  out.sort((x, y) => {
    const a = x.hit.message;
    const b = y.hit.message;
    if (sort === "date_desc") return byDate(a, b, -1) || a.id.localeCompare(b.id);
    if (sort === "date_asc") return byDate(a, b, 1) || a.id.localeCompare(b.id);
    if (sort === "sender") {
      const cmp = a.from.address.toLowerCase().localeCompare(b.from.address.toLowerCase());
      // Newest-first WITHIN a sender: address-major with arbitrary dates inside a block is not
      // a list anybody reads. Matches the server arm's own tiebreak.
      return cmp || byDate(a, b, -1) || a.id.localeCompare(b.id);
    }
    // mailbox — see the note above on why this is a rank and not a comparison of addresses.
    const ra = mailboxRank.get(a.mailboxId) ?? Number.MAX_SAFE_INTEGER;
    const rb = mailboxRank.get(b.mailboxId) ?? Number.MAX_SAFE_INTEGER;
    return ra - rb || byDate(a, b, -1) || a.id.localeCompare(b.id);
  });
  return out;
}

/**
 * THE QUERY BOX ITSELF, when this view has to put the caret back in it.
 *
 * A query rather than a ref because `SearchBox` is a `@ohmail/ui` composite that forwards none
 * — and because the selector is now read from TWO places (the mount-time select, and Escape's
 * clear), which is precisely when a hand-repeated selector string starts to drift. One
 * function, one selector, both callers.
 */
function searchBox(): HTMLInputElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLInputElement>(".view-search .search-box input");
}

export function SearchView({
  engine,
  version,
  now,
  query,
  onQuery,
  onOpen,
  placeOf,
  onExit,
  junkSaid = null,
  junkReadable = false,
  indexRev = 0,
}: {
  engine: OhmailEngine;
  version: number;
  /**
   * WHICH INDEX ANSWERED — {@link OhmailEngine.searchIndexRevision}, and the second half of the
   * local pass's key. `version` alone stopped being enough when the index started lagging the
   * mirror deliberately: a build settling changes what search can answer with no record having
   * moved, and a memo keyed on the mirror would hold the pre-build answer until the next drain.
   *
   * Defaulted rather than required so a fixture mount (`SearchView` driven directly by a test or
   * by the desktop's harness) stays a two-line call; such a mount has one engine and one index
   * for its lifetime, so a constant is the correct key for it and not a missing one.
   */
  indexRev?: number;
  now: Date;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (hit: EngineSearchHit) => void;
  /**
   * Where each message is presented — a folder, or `null` for History. Search reads the engine's
   * own index over the mirror as the mail server has it, rightly: a message must be findable by
   * what it says, not by which pile consent puts it in. But the CHIP answers "where do I go to find
   * this again?", and a History message's folder is the INBOX — a chip from the folder alone sends
   * somebody to a pile the message is not in. A map rather than a projected reader: wrapping the
   * index would change what is searchable, and History mail must stay searchable. Absent on a host
   * with no consent partition, where the folder is the honest answer.
   */
  placeOf?: ReadonlyMap<string, string | null>;
  /**
   * ESCAPE'S SECOND PRESS — leave Search, back to the view it was opened over.
   *
   * The shell owns navigation (it remembers where `/` was pressed), the view owns the key:
   * Escape is a VIEW binding here because the box holds focus (`autoFocus`) and only an
   * `inInput` binding can reach a key typed into it — while the shell's `overlay` Escape
   * still outranks this whenever a sheet, palette or reader is open on top. Optional so the
   * desktop's fixture mount is unchanged; with no exit the key stops at clearing the box.
   */
  onExit?: () => void;
  /**
   * WHAT THE EMPTY STATE SAYS ABOUT THE PROVIDER'S JUNK FOLDER ({@link junkFolderSaid}) — the
   * scope line's own rule, one folder further: `\Junk` is never mirrored, so no pass this view
   * runs can reach it and "Nothing here" is a claim about a corpus that excludes the one place
   * the provider puts the mail a person is most often hunting for. `null` renders nothing.
   */
  junkSaid?: { named: string } | "unnamed" | null;
  /** Can this build open that folder — drops the pointer sentence, keeps the statement. */
  junkReadable?: boolean;
}) {
  const t = useTranslations("search");
  /* The pointer lives in `screener`, beside the segment it names — one sentence, one translation. */
  const ts = useTranslations("screener");
  const [filter, setFilter] = useState<Filter | null>(null);

  /**
   * The order, remembered per account and per device. `storageOwner()` in a deps-less `useMemo`,
   * not module scope: it reads a cookie, so it must not run during server evaluation, and the
   * account cannot change without a remount. On a door with no cookie the host supplies the
   * identity (`storage-owner.ts`), so the desktop keeps one order per MAILBOX; a surface with no
   * account gets the `local` key (`searchSortKey`). Deliberately NOT a server setting: chrome,
   * legitimately per-machine, and the alternative costs a column, a migration and a request per
   * dropdown change.
   */
  const sortStorageKey = useMemo(() => searchSortKey(storageOwner()), []);
  const [sort, setSort] = usePersistedChoice<ServerSearchSort>(
    sortStorageKey,
    SERVER_SEARCH_SORTS,
    "relevance",
  );

  const trimmed = query.trim();
  const { result, tookMs } = useMemo(() => {
    if (!trimmed) return { result: null as LocalSearchResult | null, tookMs: 0 };
    const t0 = performance.now();
    const r = engine.search(trimmed);
    return { result: r, tookMs: Math.max(1, Math.round(performance.now() - t0)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, trimmed, version, indexRev]);

  /**
   * THE SEARCH MARK ENDS AT THE FIRST RESULTS — the budget's "first results < 500 ms", measured
   * from the keystroke the shell started it on. The LOCAL pass is what ends it: those rows are
   * what a person sees, and waiting for the archive would report a network round trip as the
   * search's latency on every query that has one. Silent when nothing was pending, so a render
   * for a query the mark already closed records nothing rather than a zero.
   */
  useEffect(() => {
    if (result !== null) endSearch();
  }, [result]);

  /**
   * FILL THE INDEX WHILE THE PERSON IS STILL TYPING THE FIRST WORD. The engine builds it in
   * slices off the keystroke path, so the cost of asking early is nothing and the answer is
   * there by the second character rather than after it. Idempotent — a build already in flight
   * is joined, a fresh index is left alone.
   */
  useEffect(() => {
    void engine.warmSearchIndex();
  }, [engine]);

  /** The index has not caught up with this mirror — every sentence below says so. */
  const indexing = result?.indexing ?? false;

  // ── the whole-mailbox pass: the store's pages, on the one list walker ─────────
  //
  // Keyed by the question it answers (query, sort, pressed facet). A new question drops the old
  // one's pages; an answer for a question since edited is never read.
  const walker = useMemo(() => new StoreSearchWalker(engine), [engine]);
  const rev = useSyncExternalStore(walker.subscribe, walker.revision, walker.revision);
  const [retryTick, setRetryTick] = useState(0);
  const available = engine.serverSearchAvailable();

  /** The store's own filter for a pressed facet — the narrowed question goes to the store. */
  const storeFilters: ServerSearchFilters | undefined = useMemo(() => {
    if (!filter) return undefined;
    if (filter.group === "folder" && filter.raw) return { folder: filter.raw };
    if (filter.group === "from" && filter.raw) return { sender: filter.raw };
    if (filter.group === "refine") return { hasAttachments: true };
    return undefined;
  }, [filter]);

  /** The device's rows at the moment the store's first page lands — they keep their places. */
  const deviceOrder = useRef<{ exact: string[]; similar: string[] }>({ exact: [], similar: [] });
  deviceOrder.current = {
    exact: (result?.items ?? []).map((h) => h.message.id),
    similar: (result?.similar ?? []).map((h) => h.message.id),
  };
  useEffect(() => {
    // A single character is not a question: the local arm ignores it, and so does the store.
    if (trimmed.length < 2) {
      walker.clear();
      return undefined;
    }
    walker.start(
      { query: trimmed, sort, ...(storeFilters ? { filters: storeFilters } : {}) },
      (tier) => (tier === "similar" ? deviceOrder.current.similar : deviceOrder.current.exact),
      ARCHIVE_DEBOUNCE_MS,
    );
    return () => walker.stop();
    // `sort` and the pressed facet are NEW QUESTIONS for the store, not re-presentations.
  }, [walker, trimmed, available, retryTick, sort, storeFilters]);
  useEffect(() => () => walker.clear(), [walker]);

  const passState = walker.state();
  const cause = walker.failureCause();
  const question = walker.question();
  useEffect(() => {
    if (cause !== null) logUnanswered(cause);
  }, [question, cause]);

  /** The store's reading of the match set, once its first page answered. */
  const ready = walker.info();
  const storeReady = ready !== null;
  const storeLength = storeReady ? walker.length() : 0;

  /** The device's hits by id: a store row the device also found keeps its highlighted words. */
  const deviceHits = useMemo(() => {
    const byId = new Map<string, EngineSearchHit>();
    for (const hit of [...(result?.items ?? []), ...(result?.similar ?? [])]) byId.set(hit.message.id, hit);
    return byId;
  }, [result]);
  const storeHitAt = (i: number): EngineSearchHit | "gone" | null => {
    const m = walker.rowAt(i);
    if (m === null || m === "gone") return m;
    return { message: m, score: 0, matches: deviceHits.get(m.id)?.matches ?? [] };
  };

  /**
   * THE DEVICE'S FIRST PAINT — its two tiers, ordered by the chosen sort. Once the store's page
   * lands the list IS the store's, walked a page at a time; this paint is gone.
   */
  const { exactRaw, similarRaw } = useMemo(() => ({
    exactRaw: (result?.items ?? []).map((hit): MergedHit => ({ hit })),
    similarRaw: (result?.similar ?? []).map((hit): MergedHit => ({ hit })),
  }), [result]);

  /**
   * IS THERE A SIMILAR SECTION AT ALL — decided on the UNFILTERED exact count, so a facet that
   * narrows the exact half can never make a block of guesses appear under it.
   */
  const similarOn = storeReady
    ? ready.tier === "similar" && storeLength > 0
    : showSimilar(exactRaw.length) && similarRaw.length > 0;

  const merged: MergedHit[] = useMemo(() => orderMerged(exactRaw, sort, NO_RANK), [exactRaw, sort]);
  const mergedSimilar: MergedHit[] = useMemo(
    () => (!similarOn || storeReady ? [] : orderMerged(similarRaw, sort, NO_RANK)),
    [similarRaw, similarOn, sort, storeReady],
  );

  /** A pressed facet narrows the device's first paint here; the store answers it by itself. */
  const applyFilter = (list: MergedHit[]) => {
    if (!filter) return list;
    return list.filter(({ hit: { message: m } }) => {
      if (filter.group === "folder") return folderKeyOf(m.folder) === filter.label;
      if (filter.group === "from") {
        return filter.raw !== undefined
          ? m.from.address.toLowerCase() === filter.raw.toLowerCase()
          : (m.from.name ?? displayAddress(m.from.address)) === filter.label;
      }
      if (filter.group === "refine") return m.hasAttachments;
      return true;
    });
  };

  const items = useMemo(() => (storeReady ? [] : applyFilter(merged)), [merged, filter, storeReady]);
  const similarItems = useMemo(() => (storeReady ? [] : applyFilter(mergedSimilar)), [mergedSimilar, filter, storeReady]);

  /**
   * THE FACETS ARE THE STORE'S once its summary lands — counts over the WHOLE match set, kept from
   * the unnarrowed question so pressing one does not zero the others. Before that, the device's
   * own, counted over what is on screen.
   */
  const [storeFacets, setStoreFacets] = useState<{ q: string; facets: ServerSearchFacets } | null>(null);
  useEffect(() => {
    if (ready?.facets && filter === null) setStoreFacets({ q: trimmed, facets: ready.facets });
  }, [ready?.facets, filter, trimmed]);
  const facets = storeFacets && storeFacets.q === trimmed ? storeFacets.facets : null;

  /** The rows a facet fallback may count: the device's paint, or the store's held pages. */
  const countedRows = (): EngineMessage[] => {
    if (!storeReady) return (similarOn ? [...merged, ...mergedSimilar] : merged).map(({ hit }) => hit.message);
    const out: EngineMessage[] = [];
    for (let i = 0; i < storeLength; i++) {
      const r = walker.rowAt(i);
      if (r !== null && r !== "gone") out.push(r);
    }
    return out;
  };

  const facetGroups: FacetGroup[] = useMemo(() => {
    if (!result) return [];
    const groups: FacetGroup[] = [];
    if (facets) {
      if (facets.sender.length) {
        groups.push({
          title: t("facetFrom"),
          items: facets.sender.slice(0, 5).map((x) => ({ label: displayAddress(x.address), count: x.count })),
        });
      }
      const folders = new Map<string, number>();
      for (const [path, count] of Object.entries(facets.folder)) {
        const key = folderKeyOf(path);
        folders.set(key, (folders.get(key) ?? 0) + count);
      }
      if (folders.size) {
        groups.push({
          title: t("facetFolder"),
          items: [...folders.entries()].map(([key, count]) => ({ label: PLACE_LABEL[key] ?? key, count })),
        });
      }
      if (facets.hasAttachments.true > 0) {
        groups.push({ title: t("facetRefine"), items: [{ label: t("facetAttachment"), count: facets.hasAttachments.true }] });
      }
      return groups;
    }
    const senders = new Map<string, number>();
    const folders = new Map<string, number>();
    let attachments = 0;
    for (const m of countedRows()) {
      const who = m.from.name ?? displayAddress(m.from.address);
      senders.set(who, (senders.get(who) ?? 0) + 1);
      const view = folderKeyOf(m.folder);
      folders.set(view, (folders.get(view) ?? 0) + 1);
      if (m.hasAttachments) attachments++;
    }
    if (senders.size) {
      groups.push({
        title: t("facetFrom"),
        items: [...senders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([label, count]) => ({ label, count })),
      });
    }
    if (folders.size) {
      groups.push({
        title: t("facetFolder"),
        items: [...folders.entries()].map(([view, count]) => ({ label: PLACE_LABEL[view] ?? view, count })),
      });
    }
    if (attachments > 0) {
      groups.push({ title: t("facetRefine"), items: [{ label: t("facetAttachment"), count: attachments }] });
    }
    return groups;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, facets, merged, mergedSimilar, similarOn, t, storeReady, storeLength, rev]);

  const onFacet = (groupTitle: string, label: string) => {
    const group: Filter["group"] =
      groupTitle === t("facetFrom") ? "from" : groupTitle === t("facetFolder") ? "folder" : "refine";
    // Labels arrive display-formatted: a folder maps back to its key, and — from the store's
    // facets — to the stored path and sender address the store filters on.
    const value = group === "folder"
      ? (Object.entries(PLACE_LABEL).find(([, v]) => v === label)?.[0] ?? label)
      : label;
    const raw = !facets ? undefined
      : group === "folder" ? Object.keys(facets.folder).find((p) => folderKeyOf(p) === value)
        : group === "from" ? facets.sender.find((x) => displayAddress(x.address) === label)?.address
          : undefined;
    setFilter((f) =>
      f && f.group === group && f.label === value ? null : { group, label: value, ...(raw !== undefined ? { raw } : {}) },
    );
  };


  /**
   * The keyboard path that did not exist. Reported as "search does not allow a message to be
   * opened" — every hit was always clickable; what was true is that this view declared ZERO
   * bindings, so the surface you reach by pressing `/` was mouse-only. The cursor is visible: `at`
   * indexes the RENDERED rows, clamped rather than remembered (the list re-derives per keystroke,
   * and an index held across that points at a different message), reset when the question changes.
   * `j`/`k` are deliberately NOT bound here — the ruling: they follow PILE order, never search-hit
   * order; arrows are what the box's own focus makes available (`inInput`), and after ↵ opens a hit
   * the pile's own `j`/`k` take over where the message lives.
   */
  /**
   * THE ROWS, AS ONE SEQUENCE — matches, then the guesses under their heading.
   *
   * The cursor is an index into what is RENDERED, so the two sections have to be one array or
   * ↓ would stop at the heading. `shownExact` takes the cap first and the similar rows take
   * what is left of it: under today's floor the two are mutually exclusive and `SHOWN - 0` is
   * `SHOWN`, but the arithmetic does not assume that, so a moved floor cannot make this list
   * longer than the cap it advertises.
   */
  const shownExact = items;
  const shownSimilar = similarItems;
  const shown = [...shownExact, ...shownSimilar];
  /** Slots in the list: the store's walked rows once it answered, else the device's paint. */
  const shownCount = storeReady ? storeLength : shown.length;
  const hitAt = (i: number): EngineSearchHit | "gone" | null =>
    (storeReady ? storeHitAt(i) : shown[i]?.hit ?? null);
  const isEgg = trimmed.toLowerCase() === "blanc" && shownCount === 0;
  /** The count on the result line: the store's own once it answered, else the rows on screen. */
  const found = storeReady && filter === null ? Math.max(ready.total, shownCount) : shownCount;
  const [at, setAt] = useState(0);
  // Reset on the ORDER too, not only on the query. The cursor is an index into the rendered
  // rows; reordering them under a held index leaves it pointing at a different message than the
  // one that was highlighted, which is the same reason it resets when the question changes.
  useEffect(() => setAt(0), [trimmed, sort]);
  const cursor = shownCount === 0 ? -1 : Math.min(at, shownCount - 1);

  /** The store's list is a window over the walker's slots; the device's paint renders whole. */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const win = useListWindow({ scrollerRef, count: storeLength });
  useEffect(() => {
    if (storeReady) walker.want(win.visibleStart, win.visibleEnd);
  }, [walker, storeReady, win.visibleStart, win.visibleEnd, rev]);
  /* The cursor stays on screen: a slot outside the rendered slice is scrolled to. */
  useEffect(() => {
    const el = scrollerRef.current;
    if (!storeReady || !el || cursor < 0) return;
    const top = win.offsetOf(cursor);
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - win.rowHeight) {
      el.scrollTop = Math.max(0, top - win.rowHeight);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor, storeReady]);

  /**
   * RE-ENTRY DOES NOT APPEND. The query is shell state so an answer survives a round-trip to
   * a hit — but the box also autofocuses with the caret at the end, so coming back and typing
   * a NEW question glued it onto the old one ("invoicetickets"). Selecting the kept text makes
   * the first keystroke replace it, which is both conventions at once: the old query is still
   * readable (and Enter still re-asks it), and typing starts fresh. Mount-only by design —
   * selecting on every query change would swallow the second character of live typing.
   */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const box = searchBox();
    if (box && box.value.trim() !== "") box.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * THE ZONE MODEL (`zone-nav.tsx`), and why this view gates its own keys on it. Search's
   * arrows, ↵ and Escape all carry `inInput` — the box holds focus from mount — which also
   * makes them fire with focus on a RAIL button (a non-typing target is always eligible).
   * Without the gate, ← into the rail would leave ↓ stepping results underneath and ↵
   * opening a hit instead of the rail row under the cursor. `zone !== "list"` declares them
   * inert exactly where the rail owns the keys; the `?` sheet reads the same statement.
   */
  const zone = useZoneNav({});

  const keys: KeyBinding[] = [
    /**
     * ESCAPE, IN TWO HONEST STEPS — the app's own sentence is "esc — Close what is open".
     * What is open here is first the QUESTION (a non-empty box: one press clears it, focus
     * stays, the caret is ready for the next thought) and then the VIEW (a second press —
     * or the first on an empty box — hands the screen back to wherever `/` was pressed).
     * `inInput` for the same reason the two arrows and ↵ below carry it: the box holds focus
     * from the moment this view mounts, so a binding without it would never fire. The shell's
     * `overlay`-scope Escape outranks this while anything is open on top, so a reader sheet
     * over Search still closes before the query is touched.
     */
    {
      chord: "Escape",
      group: "navigate",
      label: t("keyClose"),
      inInput: true,
      disabled: (trimmed === "" && onExit == null) || zone !== "list",
      run: () => {
        if (trimmed !== "") {
          onQuery("");
          /* And the caret goes back in the box, which clearing alone does
           * not do: the person who got here with ↓ has focus on a HIT ROW,
           * and clearing the query removes every row — focus falls to
           * `<body>`, where `isTypingTarget` is false, so the next letter is
           * dispatched as a BINDING (measured: after Escape on a non-empty
           * result, `c` opened Compose instead of asking). So the box is
           * re-focused whenever the query is what was cleared — not on the
           * LEAVE arm, which hands the screen back to the view `/` was
           * pressed in; focusing a box on an unmounting view is a caret in a
           * field nobody can see. */
          searchBox()?.focus();
        } else onExit?.();
      },
    },
    {
      chord: "ArrowDown",
      group: "navigate",
      label: t("keyNext"),
      // The box has focus the moment this view mounts (`autoFocus`), so a binding without
      // this is a binding that never fires — the same reason Escape and ⌘K opt in.
      inInput: true,
      disabled: shownCount === 0 || zone !== "list",
      run: () => setAt((i) => Math.min(i + 1, shownCount - 1)),
    },
    {
      chord: "ArrowUp",
      group: "navigate",
      label: t("keyPrev"),
      inInput: true,
      disabled: shownCount === 0 || zone !== "list",
      run: () => setAt((i) => Math.max(i - 1, 0)),
    },
    {
      chord: "Enter",
      group: "message",
      label: t("keyOpen"),
      inInput: true,
      /**
       * `disabled` when there is nothing to open — a statement to the `?` sheet, not a guard.
       * `SearchBox` fires `onSubmit` from its own `onKeyDown` (how Enter re-asks the archive), and
       * the dispatcher does not stop it: `preventDefault` suppresses the browser default, not
       * another listener — so both DO run when a hit is open, harmlessly (the view unmounts on
       * navigation and the archive effect's cleanup cancels its debounce). What this buys is the
       * sheet reading "open the result where it lives" as inert on an empty search — the registry's
       * rule: listed because it exists, greyed because nothing to act on.
       */
      disabled: cursor < 0 || zone !== "list",
      run: () => {
        // `shown[cursor]`, never `shown[0]`. The cursor is the whole point of the two
        // bindings above; opening the first hit regardless would make ↓ decoration.
        const target = hitAt(cursor);
        if (target !== null && target !== "gone") onOpen(target);
      },
    },
  ];
  useKeyBindings(keys);

  /**
   * The verdict, one always on screen while a query is: searching, matched / nothing matched,
   * or the server did not answer. Under it, while the store is still indexing, its progress;
   * on the last relevance page of a cut set, where the date orders walk everything.
   */
  const device = indexing ? <>{t("scopeIndexing")} </> : null;
  const verdict = !result ? null : trimmed.length < 2 ? device : passState === "idle" || passState === "searching" ? (
    <>
      {device}
      {t("scopeWholeSearching")}
    </>
  ) : passState === "unavailable" ? (
    <>
      {device}
      {t("scopeNoArchive")}
    </>
  ) : passState === "unanswered" || ready === null ? (
    /* The retry stays: a stated dead end with no way out of it is half a sentence. */
    <>
      {t("scopeUnanswered")}{" "}
      <button type="button" className="btn ghost" onClick={() => setRetryTick((n) => n + 1)}>
        {t("scopeWholeRetry")}
      </button>
    </>
  ) : ready.fromMirror ? (
    /* A desktop paired with ohmail Cloud whose account did not answer: its mirror did, and the
       sentence says whose mail that is. The retry asks the account again. */
    <>
      {ready.totalExact ? t("scopeMirror", { total: ready.total })
        : ready.about !== null ? t("scopeMirrorAbout", { total: ready.about })
          : t("scopeMirrorAtLeast", { total: ready.total })}
      {ready.ms !== null ? <> · {t("scopeServerMs", { ms: ready.ms })}</> : null}{" "}
      <button type="button" className="btn ghost" onClick={() => setRetryTick((n) => n + 1)}>
        {t("scopeWholeRetry")}
      </button>
    </>
  ) : (
    <>
      {/* Exact, else the estimate's "about N" (replaced in place by the summary), else the page's bound. */}
      {ready.totalExact ? t("scopeWhole", { total: ready.total })
        : ready.about !== null ? t("scopeWholeAbout", { total: ready.about })
          : t("scopeWholeAtLeast", { total: ready.total })}
      {ready.ms !== null ? <> · {t("scopeServerMs", { ms: ready.ms })}</> : null}
    </>
  );
  const scope = verdict === null ? null : (
    <>
      {verdict}
      {ready?.indexed ? (
        <span className="search-indexing" data-testid="search-indexing">
          {" "}{t("indexing", { percent: Math.floor((100 * ready.indexed.done) / ready.indexed.total) })}
        </span>
      ) : null}
      {ready?.bounded && walker.atEnd() ? (
        <span className="search-bounded" data-testid="search-bounded">
          {" "}{t("bounded", { count: storeLength })}
        </span>
      ) : null}
    </>
  );

  /* THE STORE'S LIST — the walker's slots in the window: a row, a placeholder until its page lands
     (asked again by its own cursor after an eviction), or nothing where the row was deleted. */
  const storeSlots: ReactElement[] = [];
  for (let i = win.start; storeReady && i < win.end; i++) {
    const hit = storeHitAt(i);
    if (hit === "gone") storeSlots.push(<div key={`g${i}`} data-index={i} className="hit-gone" aria-hidden />);
    else if (hit === null) storeSlots.push(<div key={`p${i}`} data-index={i} className="hit-w hit-ghost" aria-hidden />);
    else {
      storeSlots.push(
        <div
          key={hit.message.id}
          data-index={i}
          className={i === cursor ? "hit-w cur" : "hit-w"}
          data-hit={hit.message.id}
          {...(similarOn ? { "data-similar": "hit" } : {})}
          {...(i === cursor ? { "aria-current": "true" as const } : {})}
        >
          <SearchHitRow hit={hit} now={now} onOpen={onOpen} placeOf={placeOf} />
        </div>,
      );
    }
  }

  /* Near the end of the list, the next store page. */
  const onScroll = (e: { currentTarget: HTMLElement }) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - PAGE_AHEAD_PX) walker.more();
  };

  return (
    <section className="view col view-search">
      <div className="vhead">
        <h1>{t("title")}</h1>
        {/*
          The order control. `.vhead-action` is the header row's existing
          right-aligned slot and `.c-select` its existing select treatment —
          reused, because a second visual language for a dropdown in a
          header is how a design system stops being one. A native `<select>`
          rather than a `SegmentedControl`: five options do not fit a
          segmented row at these widths, and the native control brings its
          own keyboard handling, mobile presentation and label association.
          Hidden while the box is empty — no order to choose for no results.
        */}
        {trimmed === "" ? null : (
          <div className="vhead-action c-select search-sort">
            <label htmlFor="search-sort">{t("sortLabel")}</label>
            <select
              id="search-sort"
              value={sort}
              onChange={(e) => setSort(e.target.value as ServerSearchSort)}
            >
              {SERVER_SEARCH_SORTS.map((s) => (
                <option key={s} value={s}>
                  {t(`sort_${s}`)}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="scroller" ref={scrollerRef} onScroll={onScroll}>
        <div className="search-wrap">
          <SearchBox
            value={query}
            onChange={(v) => {
              setFilter(null);
              onQuery(v);
            }}
            /* Enter re-asks the ARCHIVE. It used to fire a toast claiming the archive was not
               wired up and that these results were complete; both halves of that were false. */
            onSubmit={() => {
              if (trimmed && !isEgg && available) setRetryTick((n) => n + 1);
            }}
            placeholder={t("placeholder")}
            ariaLabel={t("aria")}
            autoFocus
          />
          {trimmed === "" ? null : isEgg ? (
            <div className="empty">
              <span className="glyph">🤍</span>
              <b>{t("eggTitle")}</b>
              {t("eggHint")}
            </div>
          ) : shownCount === 0 ? (
            /* "Nothing here" is a claim too, and its size depends on which pass has answered.
               The scope line is rendered INSIDE the empty state for that reason: an empty
               result while the archive is still running must not read as an empty corpus. */
            <div className="empty">
              <span className="glyph">🌫</span>
              {/* "Nothing" is the wrong word for a device that has not finished looking. The
                  indexing arm outranks both settled titles for that reason. */}
              {/* No title while the store is still looking: "Nothing matched." is its answer to give. */}
              {indexing ? <b>{t("emptyTitleIndexing")}</b>
                : passState !== "idle" && passState !== "searching" ? <b>{t("emptyTitle")}</b> : null}
              {scope}
              {/* The address door, offered at the moment its two scopes apply. There is no typed
                  operator: an address is searched through `#/address/<addr>`, whose toggle holds
                  the scopes (All · From them · To them) — so the sentence names them and the link
                  opens the door. Only for an address-shaped query; anywhere else the offer would
                  be noise about a door the query cannot use. */}
              {ADDRESS_QUERY.test(trimmed) ? (
                <a className="empty-addr" data-testid="search-empty-address" href={addressHref(trimmed)}>
                  {t("emptyAddressScopes", { address: displayAddress(trimmed) })}
                </a>
              ) : null}
              {/* …and the pass that does not exist. No arm of `scope` can name the provider's
                  Junk folder, because nothing here ever searched it (JUNK-INVISIBLE). */}
              {junkSaid !== null ? (
                <span data-testid="search-junk-scope">
                  {junkSaid === "unnamed" ? t("junkScopeUnnamed") : t("junkScope", { folder: junkSaid.named })}
                  {junkReadable ? <> {ts("junkElsewhere")}</> : null}
                </span>
              ) : null}
            </div>
          ) : (
            <>
              <div className="results-head num">
                <b>{t("resultsHead", { count: found })}</b>
                {/* The time of the pass whose rows these are: the store's, once it answered. */}
                {t("resultsMeta", { ms: ready?.ms ?? tookMs })}
                {filter ? <> · {t("filtered")}</> : null}
              </div>
              {/* `.results-head` again rather than a new class: `app/app.css` and
                  `packages/ui` both belong to other slices right now, so this line takes the
                  12px/--ink2 treatment that already exists instead of shipping unstyled text.
                  A `.search-scope` rule of its own is owed. */}
              <div className="results-head">{scope}</div>
              <div className="search-cols">
                {/* `aria-activedescendant` is not used: the hits are real buttons that keep
                    their own focusability, and the box keeps DOM focus so typing continues
                    to filter. The cursor is a wrapper class plus `aria-current`, which is
                    what a screen reader can act on without moving focus off the input. */}
                <div>
                  {storeReady ? (
                    <>
                      {similarOn ? (
                        <div className="results-head" data-similar="head">
                          <b>{t("similarHead")}</b> {t("similarHint")}
                        </div>
                      ) : null}
                      {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
                      {storeSlots}
                      {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
                    </>
                  ) : null}
                  {storeReady ? null : shownExact.map(({ hit }, i) => (
                    <div
                      key={hit.message.id}
                      className={i === cursor ? "hit-w cur" : "hit-w"}
                      data-hit={hit.message.id}
                      {...(i === cursor ? { "aria-current": "true" as const } : {})}
                    >
                      <SearchHitRow hit={hit} now={now} onOpen={onOpen} placeOf={placeOf} />
                    </div>
                  ))}
                  {/*
                      The Similar section — typo-tolerant guesses, under a heading that says so. The alternative to
                      showing these rows is not showing them, and a misspelt query would then answer "nothing" while
                      the message sits one letter away. The heading means the reader never works out which rows are
                      which: an unlabelled guess mixed into matches is a wrong answer wearing a right answer's
                      clothes. Rendered only when `similarOn` — merged exact count at the floor — so this block and
                      the rows above it are never both on screen. `data-similar` is what the ranking table asserts
                      against; `.results-head` takes the existing 12px/--ink2 treatment.
                    */}
                  {!storeReady && shownSimilar.length > 0 ? (
                    <>
                      <div className="results-head" data-similar="head">
                        <b>{t("similarHead")}</b> {t("similarHint")}
                      </div>
                      {shownSimilar.map(({ hit }, i) => {
                        const rowAt = shownExact.length + i;
                        return (
                          <div
                            key={hit.message.id}
                            className={rowAt === cursor ? "hit-w cur" : "hit-w"}
                            data-hit={hit.message.id}
                            data-similar="hit"
                            {...(rowAt === cursor ? { "aria-current": "true" as const } : {})}
                          >
                            <SearchHitRow hit={hit} now={now} onOpen={onOpen} placeOf={placeOf} />
                          </div>
                        );
                      })}
                    </>
                  ) : null}
                </div>
                <Facets groups={facetGroups} onPick={onFacet} />
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * One result row — the name, the address, the subject, and which of them is the control. A result used to print its
 * sender as `from.name ?? address` (address invisible wherever a name existed) and the whole row was one `<button>`.
 * Two changes, one decision. The address is on EVERY row: line one the name, line two the address in the type the
 * list rows already use (11.5px, `--ink3`); with no name the address takes line one at the name's weight;
 * `displayAddress` decodes an internationalized domain, as everywhere else. And the address is a LINK to
 * `#/address/<addr>` — everything from and to that person. On a list row those pixels belong to the screening
 * popover, but here `senderHitOf` answers null, so the address itself is the way in (the address-control census
 * renders each surface and asks).
 */

/**
 * A real `<a href>`, not a click handler: the hash is what the router reads, and the link can be copied or opened
 * beside.
 */

/**
 * Why the row is no longer one button: a button may not contain interactive content — a link inside one is invalid,
 * flattened by assistive technology and inconsistent between engines. So the row is a `<div class="hit">` holding, in
 * reading order, the name line, the address link and a `<button class="hit-open">` around the subject whose `::after`
 * stretches over the whole row (`search-keys.css`). Pressing anywhere that is not the address opens the message; the
 * address sits above the stretch and navigates; Tab reaches the address then the open control, the reading order and
 * the DOM order. `.hit`'s rules in `packages/ui` apply unchanged. `here` is the address whose view this row already
 * stands in: that row's address is printed, not linked — a control that navigates to the open page does nothing.
 */
export function SearchHitRow({
  hit,
  now,
  onOpen,
  placeOf,
  here,
}: {
  hit: EngineSearchHit;
  now: Date;
  onOpen: (hit: EngineSearchHit) => void;
  placeOf?: ReadonlyMap<string, string | null>;
  /** The address whose view this row stands in, if any — its own address is not linked. */
  here?: string;
}) {
  const t = useTranslations("search");
  const m = hit.message;
  const fuzzy = hit.matches.find((x) => x.fuzzy);

  // Highlight the first exact/prefix-matched term inside the subject.
  const subject = useMemo(() => {
    const exact = hit.matches.find((x) => !x.fuzzy);
    if (!exact) return <>{m.subject}</>;
    const idx = m.subject.toLowerCase().indexOf(exact.term.toLowerCase());
    if (idx < 0) return <>{m.subject}</>;
    return (
      <>
        {m.subject.slice(0, idx)}
        <mark>{m.subject.slice(idx, idx + exact.term.length)}</mark>
        {m.subject.slice(idx + exact.term.length)}
      </>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hit]);

  // Joined, never concatenated: a message with no `Date:` header has no stamp, and the
  // template that spelled the separator itself rendered "Ohbox · " with nothing after it. See
  // `shell/format.ts`.
  //
  // THE PLACE, NOT THE FOLDER. `placeOf` holds `null` for a History message — a real answer
  // rather than a missing one, which is why the map is asked with `has` before `get`. A `??`
  // here would read "presented in History" and "this map says nothing about that id" alike,
  // and send a History hit to the Ohbox.
  const known = placeOf?.has(m.id) === true;
  const presented = known ? (placeOf as ReadonlyMap<string, string | null>).get(m.id)! : m.folder;
  const where = metaLine(
    known && presented === null ? t("hitHistory") : placeLabel(presented ?? m.folder),
    displayTime(m, now),
  );

  const name = m.from.name || null;
  const shownAddress = displayAddress(m.from.address);
  // Case-insensitive, as both doors match — `Anna@ACME.test` and `anna@acme.test` are one person.
  const isHere = here !== undefined && here.toLowerCase() === m.from.address.toLowerCase();
  const address = isHere ? (
    <span className="hit-addr">{shownAddress}</span>
  ) : (
    <a className="hit-addr" href={addressHref(m.from.address)}>
      {shownAddress}
    </a>
  );

  return (
    <div className="hit">
      <span className="top">
        {name ? <span className="who">{name}</span> : <span className="who">{address}</span>}
        <span className="where">{where}</span>
      </span>
      {name ? <span className="hit-under">{address}</span> : null}
      <button type="button" className="hit-open" onClick={() => onOpen(hit)}>
        <span className="subj">
          {subject}
          {fuzzy ? <span className="fuzzy">{t("fuzzyNote", { term: fuzzy.term })}</span> : null}
        </span>
      </button>
    </div>
  );
}
