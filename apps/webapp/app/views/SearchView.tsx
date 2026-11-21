"use client";

/**
 * Search in today's shell — the markup over Search's behaviour (`useSearchList`, `@ohmail/app-logic/search`): ONE
 * list, the device's index painting first and the store's page replacing it in place, every pass ending in one of
 * three verdicts. Nothing here decides; it draws the model and hands back what the person did.
 */
import { Fragment, useMemo, useRef, type ReactElement, type ReactNode, type RefObject } from "react";
import { useTranslations } from "next-intl";
import {
  SERVER_SEARCH_SORTS,
  type OhmailEngine,
  type SearchHit as EngineSearchHit,
  type ServerSearchSort,
} from "@ohmail/client-engine";
import { Facets, SearchBox, type FacetGroup } from "@ohmail/ui";
import {
  PAGE_AHEAD_PX,
  useSearchList,
  type SearchFacetGroup,
  type SearchFacetItem,
  type SearchVerdict,
} from "@ohmail/app-logic/search";
import { displayTime, metaLine, PLACE_LABEL, placeLabel } from "../shell/format";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { addressHref } from "../shell/address-view";
import { useZoneNav } from "@ohmail/app-logic/keys/zone-nav";
import { useFocusFollows } from "@ohmail/app-logic/keys/focus-follows";
import { useScopeHere } from "@ohmail/app/frame/scope";
import "./search-keys.css";

export { ARCHIVE_TIMEOUT_MS } from "@ohmail/app-logic/search";

type Matched = Extract<SearchVerdict, { kind: "matched" }>;

export function SearchView({
  engine,
  now,
  query,
  onQuery,
  onOpen,
  placeOf,
  onExit,
  junkSaid = null,
  junkReadable = false,
}: {
  engine: OhmailEngine;
  /**
   * NOT READ: the list keys its own pass on the engine's derived stamp and the index's revision. Kept only so the
   * mounts that still hand them compile until this file leaves for the new list.
   */
  version?: number;
  /** NOT READ, as `version`. */
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
   * somebody to a pile the message is not in. Absent on a host with no consent partition, where the
   * folder is the honest answer.
   */
  placeOf?: ReadonlyMap<string, string | null>;
  /**
   * ESCAPE'S SECOND PRESS — leave Search, back to the view it was opened over. The shell owns
   * navigation (it remembers where `/` was pressed), the list owns the key. With no exit the key
   * stops at clearing the box.
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
  /* THE ZONE MODEL: Search's keys are inert where the rail owns the keys (`useZoneIs` in the list's keys). */
  useZoneNav(useTranslations("shortcuts"), {});

  /**
   * The scope the order is remembered under: the shell's this view is drawn in (`useScopeHere`), so the desktop
   * keeps one order per MAILBOX and the paired page one per pairing. Drawn in no shell (`false`), the order holds for
   * the mount and is stored nowhere.
   */
  const scope = useScopeHere() ?? false;
  const rootRef = useRef<HTMLElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  /* The box this view puts the caret back in. `SearchBox` forwards no ref, so it is found inside this view's root. */
  const boxRef = useMemo<RefObject<HTMLInputElement | null>>(() => ({
    get current() {
      return rootRef.current?.querySelector<HTMLInputElement>(".search-box input") ?? null;
    },
  }), []);
  /* Today's screen asks by words and its facets: it offers no person, unread or days. */
  const m = useSearchList({
    engine, scope, query, onQuery, onOpen, onExit: onExit ?? "none", boxRef, scrollerRef, t, searchBy: "words",
  });

  /* Search stands in for the view it was opened over: leaving it gives focus back to its opener. */
  useFocusFollows(rootRef, { enter: false });

  /* A COUNT IS NEVER CUT FROM ITS WORD, NOR A TIME FROM ITS UNIT. On a phone the line broke as
     "109" / "ms" and "936" / "matched". The phrase after the sentence's dash ("936 matched",
     "about 690 matched") and the time go in one unbreakable span; the sentence before it wraps. */
  const countWhole = (sentence: string, ms: string | null) => {
    const cut = sentence.lastIndexOf(" — ");
    const head = cut < 0 ? "" : sentence.slice(0, cut + 3);
    const tail = cut < 0 ? sentence : sentence.slice(cut + 3);
    return <>{head}<span className="nobr">{tail}{ms !== null ? ` · ${ms}` : null}</span></>;
  };
  /* THE TIME SAID IS THE WAIT A PERSON HAD, measured at the paint. Until it is measured, none. */
  const waited = (v: Matched) => (v.waitedMs !== null ? t("scopeServerMs", { ms: v.waitedMs }) : null);
  /* Whose mail, how many, and whether closest words: exact, else "about N", else the page's bound. */
  const sentence = (v: Matched): string => {
    const n = v.count.n;
    const exact = v.count.kind === "exact";
    const about = v.count.kind === "about";
    switch (v.scope) {
      case "mirror":
        return exact ? t(v.near ? "scopeMirrorNear" : "scopeMirror", { total: n })
          : about ? t("scopeMirrorAbout", { total: n })
            : t(v.near ? "scopeMirrorNearAtLeast" : "scopeMirrorAtLeast", { total: n });
      case "synced":
        return exact ? t(v.near ? "scopeSyncedNear" : "scopeSynced", { total: n })
          : about ? t("scopeSyncedAbout", { total: n })
            : t(v.near ? "scopeSyncedNearAtLeast" : "scopeSyncedAtLeast", { total: n });
      case "whole":
        return exact ? t(v.near ? "scopeWholeNear" : "scopeWhole", { total: n })
          : about ? t("scopeWholeAbout", { total: n })
            : t(v.near ? "scopeWholeNearAtLeast" : "scopeWholeAtLeast", { total: n });
    }
  };
  /* The retry stays: a stated dead end with no way out of it is half a sentence. */
  const retry = (
    <button type="button" className="btn ghost" onClick={m.retry}>
      {t("scopeWholeRetry")}
    </button>
  );
  /** The device's index has not caught up: every sentence says so. */
  const device = m.indexing ? <>{t("scopeIndexing")} </> : null;
  const verdictLine = (v: SearchVerdict): ReactNode => {
    switch (v.kind) {
      case "none":
        return null;
      case "device":
      case "unfinished":
        return device;
      case "searching":
        return <>{device}{t("scopeWholeSearching")}</>;
      case "noStore":
        return <>{device}{t("scopeNoArchive")}</>;
      case "unanswered":
        return <>{t(v.refused ? "scopeFailed" : "scopeUnanswered")}{" "}{retry}</>;
      case "matched":
        /* A paired computer's mirror answered for the account: the retry asks the account again. */
        return v.scope === "mirror" ? <>{countWhole(sentence(v), waited(v))}{" "}{retry}</> : <>{countWhole(sentence(v), waited(v))}</>;
      default:
        return v satisfies never;
    }
  };
  const line = verdictLine(m.verdict);
  const scopeLine = line === null ? null : (
    <>
      {line}
      {m.storeIndexing !== null ? (
        <span className="search-indexing" data-testid="search-indexing">
          {" "}{t("indexing", { percent: m.storeIndexing })}
        </span>
      ) : null}
      {m.syncing ? (
        <span className="search-indexing" data-testid="search-syncing">{" "}{t("syncing")}</span>
      ) : null}
      {m.bounded !== null ? (
        <span className="search-bounded" data-testid="search-bounded">
          {" "}{t("bounded", { count: m.bounded })}
        </span>
      ) : null}
    </>
  );

  /* The facets, named: a folder by its place's name, a sender and the files as the list names them. */
  const titleOf = (group: SearchFacetGroup["group"]): string =>
    group === "from" ? t("facetFrom") : group === "folder" ? t("facetFolder") : t("facetRefine");
  const nameOf = (it: SearchFacetItem): string =>
    it.pick.group === "folder" ? PLACE_LABEL[it.pick.key] ?? it.pick.key : it.label;
  const shownFacets: FacetGroup[] = m.facets.map((g) => ({
    title: titleOf(g.group),
    items: g.items.map((it) => ({
      label: nameOf(it),
      ...(it.count !== null ? { count: it.count } : {}),
      ...(m.filtered ? { pressed: it.pressed } : {}),
    })),
  }));
  const onFacet = (groupTitle: string, label: string) => {
    const it = m.facets.find((g) => titleOf(g.group) === groupTitle)?.items.find((x) => nameOf(x) === label);
    if (it) m.pick(it.pick);
  };

  const similarHead = (
    <div className="results-head" data-similar="head">
      <b>{t("similarHead")}</b> {m.similarSynced ? t("similarHintSynced") : t("similarHint")}
      {m.partsSaid ? <span data-testid="search-part-reach"> {t("partReach")}</span> : null}
    </div>
  );
  const cur = (i: number) => (i === m.cursor ? { "aria-current": "true" as const } : {});

  /* THE STORE'S LIST — the walker's slots in the window: a row, a placeholder until its page lands
     (asked again by its own cursor after an eviction), or nothing where the row was deleted. */
  const storeSlots: ReactElement[] = [];
  for (let i = m.window.start; m.listing === "store" && i < m.window.end; i++) {
    const s = m.slotAt(i);
    if (s.kind === "gone") storeSlots.push(<div key={`g${i}`} data-index={i} className="hit-gone" aria-hidden />);
    else if (s.kind === "owed") storeSlots.push(<div key={`p${i}`} data-index={i} className="hit-w hit-ghost" aria-hidden />);
    else {
      storeSlots.push(
        <div
          key={s.hit.message.id}
          data-index={i}
          className={i === m.cursor ? "hit-w cur" : "hit-w"}
          data-hit={s.hit.message.id}
          role="listitem"
          aria-setsize={m.setSize}
          aria-posinset={i + 1}
          {...(m.similar ? { "data-similar": "hit" } : {})}
          {...cur(i)}
        >
          <SearchHitRow hit={s.hit} now={now} onOpen={onOpen} placeOf={placeOf} />
        </div>,
      );
    }
  }
  /* THE DEVICE'S PAINT, whole: the matches, then the closest words under their heading. */
  const deviceRows: ReactNode[] = [];
  for (let i = 0; m.listing === "device" && i < m.length; i++) {
    const s = m.slotAt(i);
    if (s.kind !== "hit") continue;
    if (i === m.similarFrom) deviceRows.push(<Fragment key="similar-head">{similarHead}</Fragment>);
    deviceRows.push(
      <div
        key={s.hit.message.id}
        className={i === m.cursor ? "hit-w cur" : "hit-w"}
        data-hit={s.hit.message.id}
        {...(s.similar ? { "data-similar": "hit" } : {})}
        {...cur(i)}
      >
        <SearchHitRow hit={s.hit} now={now} onOpen={onOpen} placeOf={placeOf} />
      </div>,
    );
  }

  /* Near the end of the list, the next store page; past the walk's bound, the person's scroll looks further. */
  const onScroll = (e: { currentTarget: HTMLElement }) => {
    const el = e.currentTarget;
    if (el.scrollTop + el.clientHeight < el.scrollHeight - PAGE_AHEAD_PX) return;
    m.nearEnd();
  };

  return (
    <section ref={rootRef} className="view col view-search">
      <div className="vhead">
        <h1>{t("title")}</h1>
        {/* The order: a native `<select>` (five options do not fit a segmented row at these widths). Hidden while
            the box is empty — no order to choose for no results. */}
        {m.text === "" ? null : (
          <div className="vhead-action c-select search-sort">
            <label htmlFor="search-sort">{t("sortLabel")}</label>
            <select
              id="search-sort"
              value={m.sort}
              onChange={(e) => m.setSort(e.target.value as ServerSearchSort)}
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
            onChange={m.type}
            /* Enter re-asks the ARCHIVE, at once. */
            onSubmit={m.submit}
            placeholder={t("placeholder")}
            ariaLabel={t("aria")}
            autoFocus
          />
          {/* Typed scopes are searched as words; say so rather than answer "0". */}
          {m.operatorsTyped ? (
            <p className="results-head" data-testid="search-no-operators">{t("noOperators")}</p>
          ) : null}
          {m.text === "" ? null : m.egg ? (
            <div className="empty">
              <span className="glyph">🤍</span>
              <b>{t("eggTitle")}</b>
              {t("eggHint")}
            </div>
          ) : m.length === 0 ? (
            /* "Nothing here" is a claim too, and its size depends on which pass has answered: the scope line is
               rendered INSIDE the empty state, so an empty result while the archive is still running never reads as
               an empty corpus. "Nothing matched." stands only where the verdict says no count; while the device is
               still indexing, its own title outranks both. */
            <div className="empty">
              <span className="glyph">🌫</span>
              {m.indexing ? <b>{t("emptyTitleIndexing")}</b> : m.settledEmpty ? <b>{t("emptyTitle")}</b> : null}
              {scopeLine}
              {m.nothingMatched ? <p className="empty-reach" data-testid="search-depth">{t("scopeDepth")}</p> : null}
              {/* The address door, offered for an address-shaped query: its view holds the scopes. */}
              {m.addressOnly ? (
                <a className="empty-addr" data-testid="search-empty-address" href={addressHref(m.text)}>
                  {t("emptyAddressScopes", { address: displayAddress(m.text) })}
                </a>
              ) : null}
              {/* …and the pass that does not exist: nothing here ever searched the provider's Junk folder. */}
              {junkSaid !== null ? (
                <p className="empty-junk" data-testid="search-junk-scope">
                  {junkSaid === "unnamed" ? t("junkScopeUnnamed") : t("junkScope", { folder: junkSaid.named })}
                  {junkReadable ? <> {ts("junkElsewhere")}</> : null}
                </p>
              ) : null}
              {m.partsSaid ? <p className="empty-reach" data-testid="search-part-reach">{t("partReach")}</p> : null}
            </div>
          ) : (
            <>
              {/* The verdict carries the count and the time whenever the archive answered; the bare head stands
                  only where it has none, or a facet filters what is shown. */}
              {m.counts && !m.filtered ? null : (
                <div className="results-head num">
                  <span className="nobr">
                    <b>{t("resultsHead", { count: m.found })}</b>
                    {m.headMs !== null ? t("resultsMeta", { ms: m.headMs }) : null}
                  </span>
                  {m.filtered ? <> · {t("filtered")}</> : null}
                </div>
              )}
              <div className="results-head">{scopeLine}</div>
              <div className="search-cols">
                {/* The hits are real buttons that keep their own focusability, and the box keeps DOM focus so typing
                    continues; the cursor is a wrapper class plus `aria-current`. */}
                <div>
                  {m.listing === "store" ? (
                    <>
                      {m.similarFrom !== null ? similarHead : null}
                      <div role="list" aria-label={t("title")}>
                        <div aria-hidden data-window-top="" style={{ height: m.window.padTop }} />
                        {storeSlots}
                        {m.window.padBottom > 0 ? <div aria-hidden style={{ height: m.window.padBottom }} /> : null}
                      </div>
                    </>
                  ) : deviceRows}
                </div>
                <Facets groups={shownFacets} onPick={onFacet} />
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
