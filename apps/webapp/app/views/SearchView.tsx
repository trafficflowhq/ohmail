"use client";

/**
 * SEARCH — TWO PASSES, AND IT SAYS WHICH ONE IT IS ON.
 *
 *  1. **This device, instantly.** `engine.search()` is synchronous over the mirror: lexical +
 *     prefix, with trigram fuzzy as a SEPARATE tier ("invoce" finds the invoice, under a
 *     heading that says these are guesses). It answers on every keystroke with
 *     no round trip, and that is not negotiable — it is the whole reason the local index
 *     exists.
 *  2. **The whole archive, a moment later.** `engine.searchServer()` runs `GET /search` — the
 *     `websearch_to_tsquery` + `word_similarity` RRF ranking over `message_bodies.body_tsv`,
 *     which was mounted, spend-classed `read`, contract-tested and had ZERO callers on any
 *     surface. Its hits EXTEND the local ones; they never replace them.
 *
 * ── WHY THE SENTENCE UNDER THE BOX IS THE POINT ──────────────────────────────────────────
 *
 * This view used to offer the archive on Enter and answer with a toast: *"Searching the
 * server archive isn't wired up yet. These local results are complete."* They were not. The
 * local index reads subject, sender and the ≤200-character `snippet` — `m.body` is a
 * fixtures-only extra the wire `MessageDTO` has no field for — and a mail body is routinely
 * many times longer than 200 characters, so most of the stored text is not on the device at
 * all. A term past character 200 of a live-shaped row was simply not findable.
 *
 * So the scope line is not decoration. Local results arrive first and are shown first, and
 * for as long as they are all we have the view says exactly that; when the archive answers it
 * says that instead; when the archive refuses it says so and offers the retry. There is no
 * moment at which the count of hits is left to imply the corpus.
 *
 * A client with no archive behind it — `?demo=1`, and the desktop tier, whose master is the
 * IMAP mailbox — gets its own sentence rather than a hidden failure. `serverSearchAvailable()`
 * is false there and nothing is requested, which is what keeps the demo at zero network.
 *
 * ── AND WHY THE GUESSES ARE IN THEIR OWN SECTION ─────────────────────────────────────────
 *
 * The two arms used to be one score, so a trigram guess weighted by the subject field could
 * outrank a literal match found in a body. Measured on the demo corpus: `graphite` put "Fotos
 * vom Grat" above the message that actually says the word, and `invoce` returned twenty rows
 * for a query with one answer — nineteen of them reached through the two-letter word `in`.
 *
 * The rule that replaced it is `@trafficflow/core/search-rank`'s, and each door applies it to
 * its own half: matches first, guesses only when there are no matches, never interleaved. This
 * view applies it once more to the MERGED list, which is the composition neither door can do —
 * see the merge below for why the obvious version of that is worse than no rule at all.
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

/** Rows rendered. Unchanged; it is now STATED when there are more (see `resultsShown`). */
const SHOWN = 12;

/**
 * ═══ ORDERING THE MERGED LIST ═══════════════════════════════════════════════════════════════
 *
 * The sort control is not merely a parameter forwarded to the archive. This view shows TWO
 * arms — the device's own index first, the archive's extras appended — so passing `sort` to the
 * server and leaving the merge alone would put twelve relevance-ranked local hits above the
 * date-ordered ones. The reader picks "Newest first" and the top of the list does not move.
 * That is worse than not offering the control.
 *
 * So the server orders its half (which decides WHICH rows come back — the thing only it can do,
 * because it holds the whole corpus) and this comparator orders what ends up on screen.
 *
 * ── `mailbox` IS THE ONE THIS CLIENT CANNOT COMPUTE ─────────────────────────────────────────
 *
 * A message carries `mailboxId`, never the address. `"mailbox"` is not a `/sync` entity type
 * (`selectors.ts`), so a Cloud mirror holds no mailbox rows at all and there is nothing on this
 * device to resolve the id against — the address exists only on the server. The comparator
 * therefore orders by the position each mailbox first takes in the ARCHIVE's answer, which is
 * address order because the server sorted it that way. A local hit from a mailbox the archive
 * did not mention sorts after the ones it did, newest-first among themselves: honest, and the
 * only alternative is ordering by raw uuid, which looks sorted and is not.
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
   * WHERE EACH MESSAGE IS PRESENTED — a folder, or `null` for History.
   *
   * Search reads the engine's own index, which is built over the mirror as the mail server has
   * it, and that is right: a message must be findable by what it says, not by which pile the
   * consent model puts it in. But the CHIP on a hit answers "where do I go to find this
   * again?", and for a History message the folder is the INBOX while the place is History —
   * so a chip derived from the folder alone would send somebody to a pile the message is not
   * presented in.
   *
   * A map rather than a projected reader, deliberately: wrapping the index would change what
   * is searchable, and mail in History has to stay searchable.
   *
   * Absent on a host with no consent partition (the desktop's fixture shell), where every
   * message presents in its own folder and the folder is the honest answer.
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
   * THE ORDER, remembered per account and per device.
   *
   * `storageOwner()` in a `useMemo` with no deps rather than at module scope: it reads a cookie,
   * so it must not run while this module is being evaluated on the server, and the account
   * cannot change without a remount. On a door with no cookie the host supplies the identity
   * instead (`storage-owner.ts`), so the desktop keeps one order per MAILBOX rather than one
   * order shared by the whole install; a surface with genuinely no account still gets the
   * `local` key — see `searchSortKey`.
   *
   * Deliberately NOT a server setting. This is chrome, it is legitimately per-machine, and the
   * alternative costs a column, a migration and a request on every change of a dropdown.
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
   * ═══ MERGE: TWO DOORS, TWO TIERS, AND THE RULE APPLIED TO THE JOIN ═══════════════════════
   *
   * Each door decides its OWN tier: the local index knows whether its exact arm found anything
   * on this device, and the archive knows whether its lexical arm found anything in the corpus.
   * Neither knows about the other, so the composition has to happen here — and getting it wrong
   * in the obvious way would be worse than not tiering at all.
   *
   * The obvious way: render each door's similar rows whenever that door had no exact ones. On a
   * device holding a thin mirror that is a near-certainty — the local index returns guesses,
   * the archive returns three real matches, and the screen shows both, with the guesses first
   * because the local pass answers first. The reader sees exactly the interleaving the tier
   * rule exists to remove.
   *
   * So the two exact halves are merged, the two similar halves are merged, and `showSimilar` is
   * asked ONCE about the merged exact count. One rule, one answer, at the level the reader is
   * actually looking at.
   *
   * ── THE NOISE FLOOR THAT USED TO BE HERE IS GONE, AND THAT IS NOT A REMOVAL ─────────────
   *
   * This memo used to filter the local hits: keep a row only if it carried a non-fuzzy match or
   * a fuzzy one against a term of four characters or more. That was the right rule in the wrong
   * place — it applied to the LOCAL arm only, so the archive's half was never floored, and a
   * view is not where a ranking decides what counts as a match. It is now
   * `MIN_FUZZY_TERM_LEN` in `@trafficflow/core/search-rank`, applied inside the index where
   * the arm runs, which is what lets both doors be held to it.
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
   * ═══ THE KEYBOARD PATH THAT DID NOT EXIST ════════════════════════════════════════════
   *
   * Reported as "search does not allow a message to be opened". Taken literally that is wrong
   * — every hit is a real `<button>` and has always been clickable.
   * What was true is that **this view declared zero bindings**. In a product whose own `?`
   * sheet is generated from a keyboard registry, the one surface you reach by pressing `/`
   * and then typing could be left only with a mouse. That is the defect.
   *
   * ── THE CURSOR IS VISIBLE, WHICH IS THE HALF THAT IS NOT THE BINDING ────────────────
   *
   * `at` is an index into the RENDERED rows, clamped rather than remembered: the list is
   * re-derived on every keystroke and when the archive lands, so an index held across those
   * changes would point at a different message than the one that was highlighted. Reset to
   * the top whenever the question changes — a cursor that survived the query would be
   * pointing into an answer to something else.
   *
   * ── AND `j`/`k` ARE DELIBERATELY NOT BOUND HERE ─────────────────────────────────────
   *
   * The ruling is explicit: `j`/`k` follow PILE order, never search-hit order. They are the
   * two most-used keys, their meaning is per-view and tested, and a search-session cursor
   * that survived navigation is exactly the sort of hidden cross-view state this shell avoids. Arrow keys
   * are the ones the box's own focus makes available (`inInput`), and after ↵ opens a hit
   * the pile's own `j`/`k` take over from where the message actually lives.
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
          /* ── AND THE CARET GOES BACK IN THE BOX, WHICH CLEARING ALONE DOES NOT DO ────────
           *
           * The sentence this binding is documented by is "clear the search — again to leave",
           * and clearing is only half of it: the person who got here with ↓ has focus on a HIT
           * ROW, and clearing the query removes every row from the DOM. Focus then falls to
           * `<body>`, where `isTypingTarget` is false — so the next letter typed is not typed
           * at all, it is dispatched as a BINDING. Measured: after Escape on a non-empty
           * result, typing the next question ran the shell's global verbs (`c` opened Compose)
           * instead of asking it.
           *
           * So the box is re-focused whenever the query is what was cleared. Not on the
           * LEAVE arm: that hands the screen back to the view `/` was pressed in, and focusing
           * a box on a view being unmounted is a caret in a field nobody can see. */
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
       * `disabled` WHEN THERE IS NOTHING TO OPEN — a statement to the `?` sheet, not a
       * guard, and it is worth being exact about which.
       *
       * `SearchBox` fires `onSubmit` from its own `onKeyDown` (that is how Enter re-asks the
       * archive), and the registry's dispatcher does not stop it: `preventDefault` suppresses
       * the browser's default, not another listener. So the two DO both run when a hit is
       * open — harmless, because the view unmounts on navigation and the archive effect's
       * cleanup cancels its own debounce before it can spend anything.
       *
       * What this line buys is that the sheet reads "open the result where it lives" as inert
       * on an empty search, which is the registry's rule for every other binding in the
       * product: listed because it exists, greyed because there is nothing to act on.
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
   * THE HONEST SENTENCE. One of five, and one of them is always on screen while a query is.
   *
   * `scopeDevice` is the load-bearing one: it is what the view says while only local results
   * are in hand, and it names the three fields the local index actually reads.
   *
   * ── IT USED TO BREAK AT ZERO, AND THE BREAK WAS A CONTRADICTION ────────────────────────
   *
   * On an empty index the pane rendered **"Nothing on this device."** and, directly beneath it, "…plus the full text of
   * **none**." — the plural's `=0` arm. Two sentences one line apart, the first saying the
   * device holds nothing and the second describing in detail what it holds. Nobody would write
   * that; it was assembled.
   *
   * So the DEVICE half is suppressed when the mirror is empty, and only the ARCHIVE clause
   * renders. `coverage.messages`, not `coverage.full`: `full` is a subset, and a device holding
   * 400 messages of which none is hydrated still holds subjects, senders and previews — the
   * sentence is true and worth saying. It is `messages === 0` that makes the whole claim vacuous.
   *
   * ── AND THE COUNT IT NAMED WAS NOT THE COUNT THE READER WOULD COUNT ────────────────────
   *
   * It said "the 6 you have opened" after three deliberate opens, because the Screener's held
   * previews hydrate a body too and `coverage.full` counts every hydration. Both numbers are
   * correct and they measure different things, which is the one situation where printing the
   * number is worse than not printing it — the reader can check it, and it will not match. The
   * sentence keeps the FACT (this device holds the full text only of what has been opened) and
   * drops the arithmetic.
   *
   * The five arms and their order are untouched. The mid-flight → settled transition was walked
   * and found true at every moment; it is the part of this that works.
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
  ) : (
    <>{t("scopeArchive", { total: current.total })}</>
  );

  return (
    <section className="view col view-search">
      <div className="vhead">
        <h1>{t("title")}</h1>
        {/*
          THE ORDER CONTROL. `.vhead-action` is the header row's existing right-aligned slot and
          `.c-select` its existing borderless-with-a-caret select treatment (`app.css`) — reused
          rather than invented, because a second visual language for a dropdown in a header is
          how a design system stops being one.

          A native `<select>` and not a `SegmentedControl`: five options do not fit a segmented
          row at the widths this view is used at, and the native control brings its own keyboard
          handling, its own mobile presentation and its own label association for free.

          Hidden while the box is empty — there is no order to choose for no results, and the
          control would be the only thing on an otherwise empty screen.
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
                    THE SIMILAR SECTION — typo-tolerant guesses, under a heading that says so.

                    It exists because the alternative to showing these rows is not showing them,
                    and a misspelt query would then answer "nothing" while the message the reader
                    is looking for sits one letter away. What the heading buys is that the reader
                    is never asked to work out which rows are which: an unlabelled guess mixed
                    into matches is a wrong answer wearing a right answer's clothes.

                    Rendered only when `similarOn` — merged exact count at the floor — so under
                    today's rule this block and the rows above it are never both on screen.
                    `data-similar` is what the ranking table asserts against; `.results-head`
                    takes the existing 12px/--ink2 treatment rather than inventing a class in a
                    stylesheet another slice owns.
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
 * ═══ ONE RESULT ROW — the name, the address, the subject, and which of them is the control ═══
 *
 * A result used to print its sender as `from.name ?? address`, so wherever a name existed the
 * address was invisible, and the whole row was one `<button>` that opened the message. Two things
 * change here, and they are one decision:
 *
 *  1. THE ADDRESS IS ON EVERY ROW. Line one is the name and line two the address, in the address
 *     type the list rows and stream cards already use (11.5px, `--ink3`); with no name the address
 *     takes line one at the name's weight, so a nameless row does not open with a whisper.
 *     `displayAddress` decodes an internationalized domain for the face, as everywhere else.
 *
 *  2. THE ADDRESS IS A LINK to `#/address/<addr>` — everything from and to that person. On a list
 *     row or a stream card the address pixels belong to the screening popover (`sender-hit.ts`
 *     answers non-null there, and the popover offers the address view as one of its rows). Here
 *     `senderHitOf` answers null, so the address itself is the way in — `test/address-control-
 *     census.test.tsx` renders each surface and asks, rather than assuming. A real `<a href>` and
 *     not a click handler: the hash is what the router reads, the link can be copied or opened
 *     beside, and nothing in the shell has to be wired for it to be true.
 *
 * ── WHY THE ROW IS NO LONGER ONE BUTTON ─────────────────────────────────────────────────────
 *
 * A button may not contain interactive content; a link inside one is invalid in the spec,
 * flattened by assistive technology and inconsistent between engines. So the row is a
 * `<div class="hit">` holding three things in reading order — the name line, the address link and
 * a `<button class="hit-open">` around the subject whose `::after` is stretched over the whole row
 * (`search-keys.css`). Pressing anywhere that is not the address opens the message, exactly as
 * before; the address sits above the stretch and navigates. Tab reaches the address and then the
 * open control, which is the reading order and also the DOM order. `.hit`'s own rules in
 * `packages/ui` (the radius, the hover lift, the pointer) apply unchanged to the div, so the row
 * looks as it did with one more line in it.
 *
 * `here` is the address whose view this row already stands in (the address view passes its own):
 * that row's address is printed, not linked — a control that navigates to the page that is open
 * is a control that does nothing.
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
