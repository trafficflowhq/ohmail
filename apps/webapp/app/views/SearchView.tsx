"use client";

/**
 * Search — two passes, and it says which one it is on: this device instantly (`engine.search()`,
 * synchronous over the mirror, per keystroke), then the whole archive (`engine.searchServer()` →
 * `GET /search`), whose hits EXTEND the local ones, never replace them. The scope line is the
 * point: the local index reads subject, sender and the ≤200-char snippet, so the view says what was
 * searched at every moment; a client with no archive (`?demo=1`, the desktop) gets its own
 * sentence, nothing requested. Guesses live in their own tier (`@trafficflow/core/search-rank`):
 * matches first, guesses only when there are none — applied here once more to the MERGED list.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  folderLeaf,
  SERVER_SEARCH_SORTS,
  VIEW_OF_FOLDER,
  type EngineMessage,
  type LocalSearchResult,
  type OhmailEngine,
  type SearchHit as EngineSearchHit,
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
import "./search-keys.css";

interface Filter {
  group: string;
  label: string;
}

/**
 * Derived rather than imported: `packages/client-engine/src/index.ts` is the barrel and it is
 * held by another slice, so `ServerSearchOutcome` is not re-exported yet. `Awaited<ReturnType<…>>`
 * is the same type by construction and cannot drift from the method it describes.
 */
type ServerOutcome = Awaited<ReturnType<OhmailEngine["searchServer"]>>;

/** What the archive pass is doing FOR THE QUERY CURRENTLY IN THE BOX. */
type Archive =
  | { state: "searching" }
  /** `tier` says whether these rows are matches or typo-tolerant guesses — see the merge below. */
  | { state: "ready"; items: EngineMessage[]; total: number; tier: "exact" | "similar" }
  | { state: "failed"; error: string }
  /** The request has been out for {@link ARCHIVE_TIMEOUT_MS} and has not answered — see below. */
  | { state: "timeout" }
  | { state: "unavailable" };

/** A hit and where it came from — the archive-only ones are marked on screen. */
interface MergedHit {
  hit: EngineSearchHit;
  /** True when the archive returned it and this device's mirror does not hold the row. */
  archiveOnly: boolean;
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
 * How long "Searching the whole archive…" may stand — the ceiling on the `searching` state.
 * Reported: the sentence never resolved — `searching` was a state only a SETTLED promise could
 * replace, and `searchServer` never rejects, which is no shape at all for a request that does not
 * come back (a dropped connection, a sleeping device). Fifteen seconds: several times the slowest
 * honest `GET /search`, short enough that the person still has the question in mind. A LATE answer
 * still wins — the timer replaces the sentence, it does not cancel the request: the sentence is
 * about this request, not the session.
 */
export const ARCHIVE_TIMEOUT_MS = 15_000;

/** Rows rendered. Unchanged; it is now STATED when there are more (see `resultsShown`). */
const SHOWN = 12;

/**
 * Ordering the merged list. The sort control is not merely forwarded: this view shows two arms —
 * the device's hits first, the archive's appended — so passing `sort` to the server alone would
 * leave twelve relevance-ranked local hits above the date-ordered ones ("Newest first" and the top
 * does not move). The server orders its half (it decides WHICH rows come back); this comparator
 * orders what is on screen. `mailbox` is the one order this client cannot compute: a message
 * carries `mailboxId`, never the address, and a Cloud mirror holds no mailbox rows — so the
 * comparator uses the position each mailbox first takes in the ARCHIVE's answer (address order,
 * because the server sorted it); unmentioned mailboxes sort after, newest-first among themselves.
 */
type SortRank = ReadonlyMap<string, number>;

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

/**
 * The displayed order for one sort. `relevance` returns the merged list UNTOUCHED — the local
 * arm's own ranking followed by the archive's, exactly as before this control existed.
 */
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
  onServerSearch,
  onExit,
}: {
  engine: OhmailEngine;
  version: number;
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
   * @deprecated The archive is searched by this view now, so nothing calls this. It is still
   * declared because `app/shell/AppShell.tsx` still passes it and that file belongs to another
   * slice; delete the prop and the call together when the shell is free. It must NOT be given
   * a job in the meantime — the toast it is bound to is the claim this change removed.
   */
  onServerSearch?: () => void;
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
}) {
  const t = useTranslations("search");
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
  }, [engine, trimmed, version]);

  // ── the archive pass ──────────────────────────────────────────────────────
  //
  // Keyed by the query it answers. A result for a query the user has since edited is
  // DISCARDED rather than rendered: two passes over one box means the slow one can land after
  // the question changed, and showing it would attach the archive's answer to the wrong words.
  const [archive, setArchive] = useState<{ q: string; outcome: Archive } | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const available = engine.serverSearchAvailable();

  useEffect(() => {
    // A single character is not a question. `tokenize` in the engine drops tokens shorter than
    // two characters, so the local arm already ignores it; asking the archive would be a
    // round trip whose answer nothing on this screen could use.
    if (trimmed.length < 2) {
      setArchive(null);
      return;
    }
    if (!available) {
      setArchive({ q: trimmed, outcome: { state: "unavailable" } });
      return;
    }
    let live = true;
    setArchive({ q: trimmed, outcome: { state: "searching" } });
    /*
     * The ceiling, armed with the state it bounds — and it fires ONLY on a state still `searching`
     * for this same query. That condition is the whole mechanism, deliberately the only one: a
     * `clearTimeout` in the settled `.then` beside it was a second way of saying the same thing,
     * measured unwatchable — removing it left every case green, and a later reader would have taken
     * the redundant one for a guarantee. A late answer still wins (it overwrites what this wrote);
     * an answer that arrived before the ceiling is never reported as unanswered. The cleanup clears
     * the timer on every query, sort and retry change.
     */
    const ceiling = setTimeout(() => {
      if (!live) return;
      setArchive((prev) =>
        prev !== null && prev.q === trimmed && prev.outcome.state === "searching"
          ? { q: trimmed, outcome: { state: "timeout" } }
          : prev,
      );
    }, ARCHIVE_TIMEOUT_MS);
    const timer = setTimeout(() => {
      // `searchServer` never rejects — the outcome is a value the UI renders, so there is no
      // unhandled promise here and no error boundary over somebody's mailbox.
      void engine.searchServer(trimmed, { sort }).then((outcome: ServerOutcome) => {
        if (!live) return;
        setArchive({
          q: trimmed,
          outcome:
            outcome.state === "ready"
              ? { state: "ready", items: outcome.items, total: outcome.total, tier: outcome.tier }
              : outcome.state === "failed"
                ? { state: "failed", error: outcome.error }
                : { state: "unavailable" },
        });
      });
    }, ARCHIVE_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
      clearTimeout(ceiling);
    };
    // `sort` is a dependency: changing the order is a NEW QUESTION for the archive, not a
    // re-presentation of the old answer. The server holds the whole corpus and decides which
    // rows come back for a given order — re-sorting the previous page would keep showing the
    // most RELEVANT fifty in date order, which is the same defect the service arm exists to
    // avoid, moved to the client.
  }, [engine, trimmed, available, retryTick, sort]);

  /** The archive's answer, but only while it still belongs to what is in the box. */
  const current: Archive | null = archive && archive.q === trimmed ? archive.outcome : null;

  /**
   * WHICH MAILBOX CAME FIRST IN THE ARCHIVE'S ANSWER — the only address order this device has.
   *
   * Built from the server's item order, which under `sort=mailbox` is address-ascending. Empty
   * whenever the archive has not answered (or cannot), and the comparator degrades to date
   * order rather than to a uuid comparison that would look sorted without being.
   */
  const mailboxRank: SortRank = useMemo(() => {
    const rank = new Map<string, number>();
    if (current?.state !== "ready") return rank;
    for (const item of current.items) {
      if (!rank.has(item.mailboxId)) rank.set(item.mailboxId, rank.size);
    }
    return rank;
  }, [current]);

  /**
   * Merge: two doors, two tiers, and the rule applied to the join. Each door decides its OWN tier
   * and neither knows about the other. The obvious composition — render each door's similar rows
   * whenever that door had no exact ones — puts local guesses above the archive's three real
   * matches (the guesses answer first): exactly the interleaving the tier rule removes. So the two
   * exact halves are merged, the two similar halves are merged, and `showSimilar` is asked ONCE
   * about the merged exact count. The old noise floor here is gone but not removed: it was the
   * right rule in the wrong place (local arm only) and now lives as `MIN_FUZZY_TERM_LEN` in
   * `@trafficflow/core/search-rank`, inside the index, holding both doors to it.
   */
  const { exactRaw, similarRaw } = useMemo(() => {
    const reader = current?.state === "ready" ? engine.read() : null;
    const exact: MergedHit[] = (result?.items ?? []).map((hit) => ({ hit, archiveOnly: false }));
    const similar: MergedHit[] = (result?.similar ?? []).map((hit) => ({ hit, archiveOnly: false }));
    const seen = new Set([...exact, ...similar].map((m) => m.hit.message.id));

    if (current?.state === "ready" && reader) {
      const into = current.tier === "similar" ? similar : exact;
      for (const item of current.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        // PREFER THE MIRROR'S OWN ROW. It carries the optimistic overlay and this device's
        // triage/flag state; the wire item is a snapshot from before whatever the user just
        // did. The wire item is the fallback for a row the mirror does not hold — which on a
        // Cloud account means a bootstrap still draining, since `/sync` mirrors every message.
        const mine = reader.get<EngineMessage>("message", item.id);
        into.push({
          hit: { message: mine ?? item, score: 0, matches: [] },
          archiveOnly: mine === undefined,
        });
      }
    }
    return { exactRaw: exact, similarRaw: similar };
  }, [result, current, engine]);

  /**
   * IS THERE A SIMILAR SECTION AT ALL — decided on the UNFILTERED exact count, deliberately.
   *
   * Asking after the facet filter would mean clicking "From · Anna" on a list of real matches
   * could empty the exact half and make a block of typo guesses appear underneath, which is a
   * narrowing gesture producing MORE rows. The facet narrows what is shown; it does not change
   * what the corpus answered.
   */
  const similarOn = showSimilar(exactRaw.length) && similarRaw.length > 0;

  /**
   * The lists as they are READ — each tier merged, then put in the chosen order. `relevance`
   * passes them through untouched, so the pre-existing behaviour is the identity case rather
   * than a re-derivation of it. Ordered SEPARATELY: a sort reorders within a tier and can never
   * lift a similar row past an exact one, which is the invariant the whole change is about.
   */
  const merged: MergedHit[] = useMemo(
    () => orderMerged(exactRaw, sort, mailboxRank),
    [exactRaw, sort, mailboxRank],
  );
  const mergedSimilar: MergedHit[] = useMemo(
    () => (similarOn ? orderMerged(similarRaw, sort, mailboxRank) : []),
    [similarRaw, similarOn, sort, mailboxRank],
  );

  const applyFilter = (list: MergedHit[]) => {
    if (!filter) return list;
    return list.filter(({ hit: { message: m } }) => {
      // Must match how the facets below are keyed, leaf fallback included.
      if (filter.group === "folder")
        return (VIEW_OF_FOLDER[m.folder] ?? folderLeaf(m.folder)) === filter.label;
      if (filter.group === "from")
        // Keyed on the same expression the facet below builds, decode included — the label is an
        // in-tab comparison key and never leaves the client, so decoding it is safe as long as
        // BOTH sides do it. One side alone and a sender facet would match nothing on an IDN.
        return (m.from.name ?? displayAddress(m.from.address)) === filter.label;
      if (filter.group === "refine") return m.hasAttachments;
      return true;
    });
  };

  const items = useMemo(() => applyFilter(merged), [merged, filter]);
  const similarItems = useMemo(() => applyFilter(mergedSimilar), [mergedSimilar, filter]);

  /**
   * Facets are counted over what is ON SCREEN, not over `result.facets`.
   *
   * The engine's facets describe the local arm alone. Once the archive lands, rendering them
   * beside a longer list would put "From · Anna · 3" above seven visible Anna results — a
   * smaller, quieter version of exactly the claim this change exists to remove. Counted from
   * the merged tiers (before the facet filter, so clicking one does not zero the others), and
   * the similar half is counted only when it is being rendered — a facet count that includes
   * rows nobody can see is the same defect one level down.
   */
  const facetSource = useMemo(
    () => (similarOn ? [...merged, ...mergedSimilar] : merged),
    [merged, mergedSimilar, similarOn],
  );
  const facetGroups: FacetGroup[] = useMemo(() => {
    if (!result) return [];
    const senders = new Map<string, number>();
    const folders = new Map<string, number>();
    let attachments = 0;
    for (const { hit: { message: m } } of facetSource) {
      const who = m.from.name ?? displayAddress(m.from.address);
      senders.set(who, (senders.get(who) ?? 0) + 1);
      // View id where a view exists, else the folder's LEAF — never the raw namespaced path,
      // which is what would otherwise reach the screen for a folder this client has no view for.
      const view = VIEW_OF_FOLDER[m.folder] ?? folderLeaf(m.folder);
      folders.set(view, (folders.get(view) ?? 0) + 1);
      if (m.hasAttachments) attachments++;
    }
    const groups: FacetGroup[] = [];
    if (senders.size) {
      groups.push({
        title: t("facetFrom"),
        items: [...senders.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([label, count]) => ({ label, count })),
      });
    }
    if (folders.size) {
      groups.push({
        title: t("facetFolder"),
        items: [...folders.entries()].map(([view, count]) => ({
          label: PLACE_LABEL[view] ?? view,
          count,
        })),
      });
    }
    if (attachments > 0) {
      groups.push({
        title: t("facetRefine"),
        items: [{ label: t("facetAttachment"), count: attachments }],
      });
    }
    return groups;
  }, [result, facetSource, t]);

  const onFacet = (groupTitle: string, label: string) => {
    const group =
      groupTitle === t("facetFrom")
        ? "from"
        : groupTitle === t("facetFolder")
          ? "folder"
          : "refine";
    // Facet labels arrive display-formatted; map folders back to view ids.
    const value =
      group === "folder"
        ? (Object.entries(PLACE_LABEL).find(([, v]) => v === label)?.[0] ?? label)
        : label;
    setFilter((f) =>
      f && f.group === group && f.label === value ? null : { group, label: value },
    );
  };

  const isEgg =
    trimmed.toLowerCase() === "blanc" && items.length === 0 && similarItems.length === 0;

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
  const shownExact = items.slice(0, SHOWN);
  const shownSimilar = similarItems.slice(0, Math.max(0, SHOWN - shownExact.length));
  const shown = [...shownExact, ...shownSimilar];
  /** How many rows the two tiers hold in total — what the count under the box is about. */
  const found = items.length + similarItems.length;
  const [at, setAt] = useState(0);
  // Reset on the ORDER too, not only on the query. The cursor is an index into the rendered
  // rows; reordering them under a held index leaves it pointing at a different message than the
  // one that was highlighted, which is the same reason it resets when the question changes.
  useEffect(() => setAt(0), [trimmed, sort]);
  const cursor = shown.length === 0 ? -1 : Math.min(at, shown.length - 1);

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
      disabled: shown.length === 0 || zone !== "list",
      run: () => setAt((i) => Math.min(i + 1, shown.length - 1)),
    },
    {
      chord: "ArrowUp",
      group: "navigate",
      label: t("keyPrev"),
      inInput: true,
      disabled: shown.length === 0 || zone !== "list",
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
        const target = shown[cursor];
        if (target) onOpen(target.hit);
      },
    },
  ];
  useKeyBindings(keys);

  /**
   * The honest sentence — one of six, one always on screen while a query is. `scopeDevice` is load-bearing:
   * what the view says while only local results are in hand, naming the three fields the index reads. It used
   * to break at zero: "Nothing on this device." directly above "…plus the full text of none." — assembled, not
   * written. So the device half is suppressed when the mirror is empty (`coverage.messages === 0`, not `full` —
   * a device with 400 unhydrated messages still holds subjects and previews, and the sentence is worth saying).
   * The opened-count is gone: Screener previews hydrate bodies too, so "the 6 you have opened" never matched
   * what a reader would count — the fact stays, the arithmetic goes. The sixth arm, `timeout`, was the
   * unrepresentable state ({@link ARCHIVE_TIMEOUT_MS}).
   */
  const device = !result || result.coverage.messages === 0 ? null : <>{t("scopeDevice")} </>;
  const scope = !result ? null : current === null || current.state === "searching" ? (
    <>
      {device}
      {t("scopeSearching")}
    </>
  ) : current.state === "unavailable" ? (
    <>
      {device}
      {t("scopeNoArchive")}
    </>
  ) : current.state === "failed" ? (
    <>
      {t("scopeFailed", { reason: current.error })}{" "}
      <button type="button" className="btn ghost" onClick={() => setRetryTick((n) => n + 1)}>
        {t("scopeRetry")}
      </button>
    </>
  ) : current.state === "timeout" ? (
    /*
     * A SIXTH ARM, and it is the one that was missing. It carries the same retry the refusal
     * arm does: a stated dead end with no way out of it is half a sentence. `device` is kept —
     * the local results ARE what is on screen and the reader is entitled to know what they
     * cover, exactly as in the `searching` and `unavailable` arms.
     */
    <>
      {device}
      {t("scopeArchiveTimeout")}{" "}
      <button type="button" className="btn ghost" onClick={() => setRetryTick((n) => n + 1)}>
        {t("scopeRetry")}
      </button>
    </>
  ) : (
    <>{t("scopeArchive", { total: current.total })}</>
  );

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
      <div className="scroller">
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
          ) : shown.length === 0 ? (
            /* "Nothing here" is a claim too, and its size depends on which pass has answered.
               The scope line is rendered INSIDE the empty state for that reason: an empty
               result while the archive is still running must not read as an empty corpus. */
            <div className="empty">
              <span className="glyph">🌫</span>
              <b>{current?.state === "ready" ? t("emptyTitleAll") : t("emptyTitle")}</b>
              {scope}
            </div>
          ) : (
            <>
              <div className="results-head num">
                <b>{t("resultsHead", { count: found })}</b>
                {t("resultsMeta", { ms: tookMs })}
                {/* The list is capped at 12 rows and always was. That was quiet when only the
                    local arm fed it; with the archive merged in the gap between the count and
                    the rows widens, so it is stated. */}
                {found > SHOWN ? <> · {t("resultsShown", { shown: SHOWN })}</> : null}
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
                  {shownExact.map(({ hit, archiveOnly }, i) => (
                    <div
                      key={hit.message.id}
                      className={i === cursor ? "hit-w cur" : "hit-w"}
                      data-hit={hit.message.id}
                      {...(i === cursor ? { "aria-current": "true" as const } : {})}
                    >
                      <SearchHitRow hit={hit} now={now} onOpen={onOpen} archiveOnly={archiveOnly} placeOf={placeOf} />
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
                  {shownSimilar.length > 0 ? (
                    <>
                      <div className="results-head" data-similar="head">
                        <b>{t("similarHead")}</b> {t("similarHint")}
                      </div>
                      {shownSimilar.map(({ hit, archiveOnly }, i) => {
                        const rowAt = shownExact.length + i;
                        return (
                          <div
                            key={hit.message.id}
                            className={rowAt === cursor ? "hit-w cur" : "hit-w"}
                            data-hit={hit.message.id}
                            data-similar="hit"
                            {...(rowAt === cursor ? { "aria-current": "true" as const } : {})}
                          >
                            <SearchHitRow hit={hit} now={now} onOpen={onOpen} archiveOnly={archiveOnly} placeOf={placeOf} />
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
  archiveOnly,
  placeOf,
  here,
}: {
  hit: EngineSearchHit;
  now: Date;
  onOpen: (hit: EngineSearchHit) => void;
  /** The archive returned it and this device's mirror has no row for it — say so. */
  archiveOnly: boolean;
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
    archiveOnly ? t("hitArchiveOnly") : null,
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
