"use client";

/**
 * SEARCH — TWO PASSES, AND IT SAYS WHICH ONE IT IS ON.
 *
 *  1. **This device, instantly.** `engine.search()` is synchronous over the mirror: lexical +
 *     prefix + trigram fuzzy ("invoce" finds the invoice). It answers on every keystroke with
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
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  folderLeaf,
  VIEW_OF_FOLDER,
  type EngineMessage,
  type LocalSearchResult,
  type OhmailEngine,
  type SearchHit as EngineSearchHit,
} from "@ohmail/client-engine";
import { Facets, SearchBox, SearchHit, type FacetGroup } from "@ohmail/ui";
import { displayTime, metaLine, PLACE_LABEL, placeLabel, senderName } from "../shell/format";
import { displayAddress } from "../shell/idn";
import { useKeyBindings, type KeyBinding } from "../shell/keymap";
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
  | { state: "ready"; items: EngineMessage[]; total: number }
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

export function SearchView({
  engine,
  version,
  now,
  query,
  onQuery,
  onOpen,
  placeOf,
  onServerSearch,
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
   * a job in the meantime — the toast it is bound to is the claim this slice removed.
   */
  onServerSearch?: () => void;
}) {
  const t = useTranslations("search");
  const [filter, setFilter] = useState<Filter | null>(null);

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
      void engine.searchServer(trimmed).then((outcome: ServerOutcome) => {
        if (!live) return;
        setArchive({
          q: trimmed,
          outcome:
            outcome.state === "ready"
              ? { state: "ready", items: outcome.items, total: outcome.total }
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
  }, [engine, trimmed, available, retryTick]);

  /** The archive's answer, but only while it still belongs to what is in the box. */
  const current: Archive | null = archive && archive.q === trimmed ? archive.outcome : null;

  // ── merge: local first, archive-only appended ─────────────────────────────
  const merged: MergedHit[] = useMemo(() => {
    // Relevance floor over the engine's recall: a hit must carry at least
    // one exact/prefix match, or a fuzzy match against a term long enough
    // to mean something ("invoce" → "invoice" stays; "in" noise goes).
    // It applies to the LOCAL arm only — the server ranked its own arm by RRF and did not
    // hand back per-token matches to floor against.
    const out: MergedHit[] = (result?.items ?? [])
      .filter((hit) => hit.matches.some((x) => !x.fuzzy || x.term.length >= 4))
      .map((hit) => ({ hit, archiveOnly: false }));
    const seen = new Set(out.map((m) => m.hit.message.id));

    if (current?.state === "ready") {
      const reader = engine.read();
      for (const item of current.items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        // PREFER THE MIRROR'S OWN ROW. It carries the optimistic overlay and this device's
        // triage/flag state; the wire item is a snapshot from before whatever the user just
        // did. The wire item is the fallback for a row the mirror does not hold — which on a
        // Cloud account means a bootstrap still draining, since `/sync` mirrors every message.
        const mine = reader.get<EngineMessage>("message", item.id);
        out.push({
          hit: { message: mine ?? item, score: 0, matches: [] },
          archiveOnly: mine === undefined,
        });
      }
    }
    return out;
  }, [result, current, engine]);

  const items = useMemo(() => {
    if (!filter) return merged;
    return merged.filter(({ hit: { message: m } }) => {
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
  }, [merged, filter]);

  /**
   * Facets are counted over the MERGED set, not over `result.facets`.
   *
   * The engine's facets describe the local arm alone. Once the archive lands, rendering them
   * beside a longer list would put "From · Anna · 3" above seven visible Anna results — a
   * smaller, quieter version of exactly the claim this slice exists to remove. Counted from
   * `merged` (before the facet filter, so clicking one does not zero the others).
   */
  const facetGroups: FacetGroup[] = useMemo(() => {
    if (!result) return [];
    const senders = new Map<string, number>();
    const folders = new Map<string, number>();
    let attachments = 0;
    for (const { hit: { message: m } } of merged) {
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
  }, [result, merged, t]);

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

  const isEgg = trimmed.toLowerCase() === "blanc" && items.length === 0;

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
  const shown = items.slice(0, SHOWN);
  const [at, setAt] = useState(0);
  useEffect(() => setAt(0), [trimmed]);
  const cursor = shown.length === 0 ? -1 : Math.min(at, shown.length - 1);

  const keys: KeyBinding[] = [
    {
      chord: "ArrowDown",
      group: "navigate",
      label: t("keyNext"),
      // The box has focus the moment this view mounts (`autoFocus`), so a binding without
      // this is a binding that never fires — the same reason Escape and ⌘K opt in.
      inInput: true,
      disabled: shown.length === 0,
      run: () => setAt((i) => Math.min(i + 1, shown.length - 1)),
    },
    {
      chord: "ArrowUp",
      group: "navigate",
      label: t("keyPrev"),
      inInput: true,
      disabled: shown.length === 0,
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
      disabled: cursor < 0,
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
          ) : items.length === 0 ? (
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
                <b>{t("resultsHead", { count: items.length })}</b>
                {t("resultsMeta", { ms: tookMs })}
                {/* The list is capped at 12 rows and always was. That was quiet when only the
                    local arm fed it; with the archive merged in the gap between the count and
                    the rows widens, so it is stated. */}
                {items.length > SHOWN ? <> · {t("resultsShown", { shown: SHOWN })}</> : null}
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
                  {shown.map(({ hit, archiveOnly }, i) => (
                    <div
                      key={hit.message.id}
                      className={i === cursor ? "hit-w cur" : "hit-w"}
                      data-hit={hit.message.id}
                      {...(i === cursor ? { "aria-current": "true" as const } : {})}
                    >
                      <Hit hit={hit} now={now} onOpen={onOpen} archiveOnly={archiveOnly} placeOf={placeOf} />
                    </div>
                  ))}
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

function Hit({
  hit,
  now,
  onOpen,
  archiveOnly,
  placeOf,
}: {
  hit: EngineSearchHit;
  now: Date;
  onOpen: (hit: EngineSearchHit) => void;
  /** The archive returned it and this device's mirror has no row for it — say so. */
  archiveOnly: boolean;
  placeOf?: ReadonlyMap<string, string | null>;
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

  return (
    <SearchHit
      who={senderName(m)}
      where={where}
      subject={subject}
      fuzzyNote={fuzzy ? t("fuzzyNote", { term: fuzzy.term }) : undefined}
      onPress={() => onOpen(hit)}
    />
  );
}
