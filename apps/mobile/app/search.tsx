/**
 * Search — ONE list, the webapp SearchView's contract in the one-pane shape: the mirror's instant
 * index paints first, the store's page (`state/store-views.ts#useStoreSearch`) then replaces it in
 * place, and the rest is History's list mechanism — slots measured off their own rows, pages by
 * the store's cursor as they scroll into view, at most three held. The SIMILAR tier stands under
 * its own heading and only when nothing matched exactly; the verdict says what was searched and
 * how fast. An address-shaped query that settles empty offers the address door: All · From them ·
 * To them — the device's rows, then the archive's (`useAddressArchive`), as the web address view.
 */
import { MailAppearance, mailColors, mailSize } from "../src/theme/mail";
import type { EngineMessage as StoreMessage } from "@ohmail/wire";
import { peopleFor, type RestingSearchPerson } from "@ohmail/app-logic/search/people";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactElement } from "react";
import { Platform, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Copy } from "../src/copy";
/* The engine is reached through the seam, never from a screen — `privacy.test.ts`'s
   allow-list is the rule, and the direction union rides out with the rest. */
import { useNetworkNow } from "../src/net/network-door";
import { addressShaped, unansweredSaid, type AddressDirection } from "../src/state/live";
import { partReachSaid, searchCountLine } from "../src/state/search-count";
import { useSearchMailboxTotal } from "../src/state/search-overview";
import { useAddressArchive, useStoreSearch } from "../src/state/store-views";
import { useWorld } from "../src/state/world";
import { useTheme } from "../src/theme";
import { Empty, Screen, Tap, Txt, ViewHead } from "../src/ui/base";
import { Icon } from "../src/ui/Icon";
import { MailPlaceDock } from "../src/ui/MailPlaceDock";
import { DetailBar, PaneTop, TopBar } from "../src/ui/chrome";
import { Gated } from "../src/ui/Gated";
import { MailList, type ListGroup } from "../src/ui/MailList";
import { MailRow } from "../src/ui/MailRow";
import { SlotHeights } from "../src/ui/history-slot";
import { SearchFacets } from "../src/ui/SearchFacets";
import { SearchSort } from "../src/ui/SearchSort";
import { SearchHeading, SearchPersonRow } from "../src/ui/SearchPeople";
import { phoneSearchQuestion, type SearchFilters, type SearchOrder } from "../src/state/search-facets";
import { Segmented } from "../src/ui/Segmented";
import { useLocale } from "../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
import { holdReader, holdWhileOpen } from "../src/ui/reader-held";
import { ReleaseOnReturn } from "../src/ui/more-pane";
import type { WorldMail } from "../src/state/world";

/** A row of the one list: the device's own, a store slot read at render, or one only the archive holds. */
type Row =
  | { key: string; device: WorldMail }
  | { key: string; slot: number }
  | { key: string; archive: StoreMessage; mail: WorldMail }
  | { key: string; person: RestingSearchPerson }
  | { key: string; heading: ReactElement };

const NO_FILTERS: SearchFilters = {};
const NO_PEOPLE: readonly RestingSearchPerson[] = [];

/** Gated like the tabs — a deep-linked route must not render the empty world. */
export default function SearchScreen({ inPane = false }: { inPane?: boolean }) {
  return (
    <SurfaceBoundary surface="search">
      <MailAppearance>
        <Gated>
          <SearchBody inPane={inPane} />
        </Gated>
      </MailAppearance>
    </SurfaceBoundary>
  );
}

function SearchBody({ inPane }: { inPane: boolean }) {
  const t = useTheme();
  const paper = t.mail ? mailColors(t) : null;
  const locale = useLocale();
  const w = useWorld();
  const network = useNetworkNow();
  const searchField = useRef<TextInput>(null);
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [allPeople, setAllPeople] = useState(false);
  const { folder } = useLocalSearchParams<{ folder?: string }>();
  const [filters, setFilters] = useState<SearchFilters>(() => typeof folder === "string" && folder.trim() !== "" ? { folder } : NO_FILTERS);
  const [pickedOrder, setOrder] = useState<SearchOrder>("relevance");
  /** The address view this screen switched into — the empty state's door. Typing leaves it. */
  const [addr, setAddr] = useState<string | null>(null);
  const [dir, setDir] = useState<AddressDirection>("any");

  /*
   * Build the index off the keystroke path, ONCE per visit. `w.search.warm` is a fresh closure
   * on every world derivation, and a settled build bumps the revision the world memo watches —
   * so depending on its IDENTITY warmed, re-derived, warmed again and spun the JS thread at
   * 124% with the screen frozen (measured on the device, 2026-09-20). The ref keeps the latest
   * closure without making it a dependency.
   */
  const warm = useRef(w.search.warm);
  warm.current = w.search.warm;
  useEffect(() => {
    warm.current();
  }, []);
  /* A result opened from here stays over Search, on two panes too: Back returns to the query. In
     More's pane only while that result is open: the pane stays mounted behind the other tabs. */
  useEffect(() => {
    return inPane ? undefined : holdWhileOpen(Symbol("search"));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one place per mount
  }, []);
  const [paneHold] = useState(() => Symbol("search-pane"));
  const openMessage = (id: string) => {
    if (inPane) holdReader(paneHold, true);
    router.push(`/message/${id}`);
  };

  const trimmed = q.trim();
  const order = t.mail && trimmed === "" && pickedOrder !== "date_desc" ? "relevance" : pickedOrder;
  const question = addr === null ? phoneSearchQuestion(trimmed, filters, order) : null;
  const resting = t.mail === true && addr === null && trimmed === "" && question === null;
  const mailboxTotal = useSearchMailboxTotal(resting);
  const people = t.mail && addr === null && !filters.sender && !filters.to && !addressShaped(trimmed)
    ? w.search.people
    : NO_PEOPLE;
  const meant = useMemo(() => {
    if (resting || trimmed === "" || people.length === 0) return resting ? people : [];
    const entries = new Map(people.map((entry) => [entry.person, entry]));
    return peopleFor(trimmed, [...entries.keys()]).map((person) => entries.get(person)!);
  }, [people, resting, trimmed]);
  const few = resting ? 5 : 3;
  const questionKey = JSON.stringify(question);
  const answer = addr === null ? (question?.filters || question?.sort ? w.search.query(q, undefined, filters, order) : w.search.query(q)) : null;
  const around = addr !== null ? w.search.address(addr, dir) : null;
  const archive = useAddressArchive(addr, dir);
  /* The archive's rows only under All or the direction it answered (`address-view.ts`'s rule). */
  const extras = useMemo((): Row[] => {
    if (around === null || archive.state !== "ready" || !(dir === "any" || dir === archive.direction)) return [];
    const held = new Set(around.items.map((m) => m.id));
    return archive.items.filter((m) => !held.has(m.id))
      .map((m) => ({ key: `archive:${m.id}`, archive: m, mail: w.store.rowOf(m, false) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archive, dir, around?.items]);
  const archiveSaid = archive.state === "searching" ? Copy.searchWholeSearching
    : archive.state === "failed" ? unansweredSaid(network, "search", archive.cause)
      : archive.state !== "ready" ? null
        : archive.direction === dir
          ? Copy.searchAddressArchive(archive.total, archive.importing, archive.atLeast, false)
          : dir === "to" ? Copy.searchAddressArchiveNoRecipients
            : Copy.searchAddressArchive(archive.total, archive.importing, archive.atLeast, true);
  const deviceIds = useMemo(() => (answer?.items ?? []).map((m) => m.id), [answer]);
  /* THE WHOLE-MAILBOX PASS — its page replaces the device's paint, rows on screen first. */
  const store = useStoreSearch(addr === null ? q : "", deviceIds, addr === null ? filters : NO_FILTERS, order);
  /* The store's slots, as positions only: a row is read per slot from the walker's cache. */
  const slots = useMemo(() => Array.from({ length: store.length }, (_, i): Row => ({ key: `slot-${i}`, slot: i })), [store.length]);
  const deviceRows = (list: readonly WorldMail[]): Row[] => list.map((m) => ({ key: m.id, device: m }));
  const shownItems: Row[] = store.ready ? (store.tier === "exact" ? slots : []) : deviceRows(answer?.items ?? []);
  const shownSimilar: Row[] = store.ready ? (store.tier === "similar" ? slots : []) : deviceRows(answer?.similar ?? []);
  const found = store.ready && store.totalExact ? Math.max(store.total, store.length) : shownItems.length + shownSimilar.length;
  const firstResult = paper && addr === null ? (shownItems[0] ?? shownSimilar[0])?.key : undefined;
  const cursorFace = paper ? {
    backgroundColor: paper.hover, borderColor: paper["ctl-ring"], borderWidth: 1, borderRadius: t.radius.row,
  } : undefined;
  /** Where slot 0 sits in the scroll content, learnt from its own frame. */
  const top = useRef(0);
  /* History's slot rule (`history-slot.ts`), one ledger per question: a slot index is a hit of it. */
  const heights = useMemo(() => new SlotHeights(), [questionKey, addr]);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const onRowHeight = useCallback((i: number, height: number) => {
    if (heights.record(i, height)) redraw();
  }, [heights]);
  const door = answer !== null && !question?.filters ? addressShaped(trimmed) : null;
  /* Where a part inside a word is looked for: the store's empty and closest-words answers only. */
  const partsSaid = partReachSaid(trimmed, store);
  const verdict = addr !== null ? null : store.verdict === "searching" ? Copy.searchWholeSearching
    : store.verdict === "ready"
      ? `${searchCountLine(store)}${store.ms !== null ? ` · ${Copy.searchServerMs(store.ms)}` : ""}`
      : store.verdict === "unanswered" ? unansweredSaid(network, "search", store.cause) : null;

  const showVerdict = verdict !== null && (!t.mail || store.verdict !== "ready"
    || store.importing || store.bounded || !store.totalExact || store.indexedPercent !== null);
  const notice = showVerdict ? (
    <View style={{ paddingHorizontal: mailSize.edge, paddingTop: mailSize.inset, paddingBottom: mailSize.rowInset, gap: mailSize.rowInset }}>
      {store.verdict === "unanswered" ? (
        <Tap onPress={store.retry} accessibilityRole="button">
          <Txt variant="note" tone="ink3">{verdict} <Txt variant="note" tone="accent">{Copy.searchWholeRetry}</Txt></Txt>
        </Tap>
      ) : (
        <Txt variant="note" tone="ink3" tabular>{verdict}</Txt>
      )}
      {store.indexedPercent !== null ? (
        <Txt variant="note" tone="ink3">{Copy.searchIndexingProgress(store.indexedPercent)}</Txt>
      ) : null}
      {store.verdict === "ready" && store.importing ? (
        <Txt variant="note" tone="ink3">{Copy.searchSyncing}</Txt>
      ) : null}
      {store.bounded ? (
        <Txt variant="note" tone="ink3">{Copy.searchBounded(store.length)}</Txt>
      ) : null}
    </View>
  ) : null;

  /* EVERY ROW GOES THROUGH THE WINDOW. One address can hold thousands of this mailbox's
     messages — `messagesWith` returns all of them, unsliced — so the results are a `MailList`
     like every other list on the phone rather than a scroll view that mounts the answer whole.
     One list per screen: the branch below decides its groups, its head and its empty state. */
  const resultCount = new Intl.NumberFormat(locale).format(store.ready && !store.totalExact ? store.about ?? store.total : found);
  const resultStamp = store.ready && !store.totalExact && store.about === null ? `${resultCount}+` : resultCount;
  const resultHeading = (key: string, title: string, rows: Row[], note?: string): Row[] => {
    if (!t.mail || rows.length === 0) return rows;
    const first = rows[0];
    const firstSlot = first && "slot" in first ? store.rowAt(first.slot) : null;
    const hot = firstSlot && firstSlot !== "gone" ? firstSlot.unread : rows.some((row) => "device" in row && row.device.unread);
    return [{
      key,
      heading: <>
        <SearchHeading title={title} count={resultStamp} hot={hot}
          aside={<SearchSort order={order} onOrder={setOrder} emptyWords={trimmed === ""} />} />
        {note ? <Txt variant="caption" tone="ink2" style={{ paddingHorizontal: mailSize.edge - mailSize.rowInset }}>{note}</Txt> : null}
      </>,
    }, ...rows];
  };
  const messageGroups: ListGroup<Row>[] =
    around !== null && addr !== null
      ? [{ key: "around", rows: [...deviceRows(around.items), ...extras] }]
      : answer !== null && (trimmed !== "" || question !== null) && (shownItems.length > 0 || shownSimilar.length > 0)
        ? [
            {
              key: "results",
              title: t.mail ? undefined : Copy.searchResultsHead(found),
              rows: resultHeading("results-heading", Copy.searchResults, shownItems),
            },
            {
              key: "similar", title: t.mail && shownItems.length === 0 ? undefined : Copy.searchSimilarHead,
              note: t.mail && shownItems.length === 0 ? undefined
                : `${store.ready && store.importing ? Copy.searchSimilarHintSynced : Copy.searchSimilarHint}${partsSaid ? ` ${Copy.searchPartReach}` : ""}`,
              rows: shownItems.length === 0
                ? resultHeading("similar-heading", Copy.searchSimilarHead, shownSimilar, partsSaid ? Copy.searchPartReach : undefined)
                : shownSimilar,
            },
          ]
        : [];
  const groups: ListGroup<Row>[] = meant.length === 0 ? messageGroups : [
    {
      key: "people",
      padTop: resting ? mailSize.rowInset : 0,
      rows: [
        {
          key: "people-heading",
          heading: <SearchHeading title={Copy.searchPeople} count={String(meant.length)}
            aside={meant.length > few ? (
              <Tap accessibilityRole="button" accessibilityState={{ expanded: allPeople }}
                accessibilityLabel={allPeople ? Copy.searchFewer : Copy.searchAll}
                onPress={() => setAllPeople((current) => !current)} style={{ padding: mailSize.inset }}>
                <Txt variant="caption" tone="ink2">{allPeople ? Copy.searchFewer : Copy.searchAll}</Txt>
              </Tap>
            ) : undefined} />,
        },
        ...(allPeople ? meant : meant.slice(0, few)).map((person) => ({ key: `person:${person.person.address}`, person })),
      ],
    },
    ...messageGroups,
  ];

  const empty = around !== null && addr !== null ? archive.state === "searching" ? null : (
      <Empty
        title={
          dir === "from"
            ? Copy.searchAddressEmptyFrom(addr)
            : dir === "to"
              ? Copy.searchAddressEmptyTo(addr)
              : Copy.searchAddressEmptyAny(addr)
        }
        hint=""
      />
    ) : answer !== null && trimmed === "" && question === null ? null : answer !== null ? (
      answer.indexing && !store.ready ? (
        /* Not yet ≠ nothing: the index is still filling (`indexingResult`'s whole rule). */
        <Empty title={Copy.searchIndexing} hint={verdict ?? ""} />
      ) : store.verdict === "searching" || store.verdict === "unfinished" ? null : (
        <>
          <Empty title={Copy.searchEmptyTitle} hint={store.ready ? Copy.searchDepth : ""} />
          {partsSaid ? (
            <Txt variant="note" tone="ink3" style={{ paddingHorizontal: 16, paddingTop: 8 }}>{Copy.searchPartReach}</Txt>
          ) : null}
          {door !== null ? (
            /* THE ADDRESS DOOR — the web's empty-state sentence, and here it IS the
               door: the press opens the two scopes it names. */
            <Tap
              onPress={() => {
                setAddr(door);
                setDir("any");
              }}
              accessibilityRole="button"
              accessibilityLabel={Copy.searchEmptyAddressScopes(door)}
              style={{ paddingHorizontal: 16, paddingVertical: 10 }}
            >
              <Txt variant="note" tone="accent">
                {Copy.searchEmptyAddressScopes(door)}
              </Txt>
            </Tap>
          ) : null}
        </>
      )
    ) : null;

  const emptyUnderPeople = meant.length > 0 && messageGroups.every((group) => group.rows.length === 0) ? empty : null;
  const page = (
    <Screen>
      {inPane ? <PaneTop /> : t.mail ? <TopBar /> : <DetailBar title={Copy.search} />}
      {t.mail ? <ViewHead title={Copy.search} style={{ paddingBottom: mailSize.inset }} /> : null}
      {inPane ? <ReleaseOnReturn token={paneHold} /> : null}
      <View style={{ paddingHorizontal: 12, paddingBottom: t.mail ? 16 : 8 }}>
        <View style={paper ? {
          minHeight: 48, flexDirection: "row", alignItems: "center", paddingHorizontal: 12,
          borderRadius: t.radius.row, backgroundColor: paper.soft, gap: 8, borderWidth: 2,
          borderColor: focused ? paper.focus : paper["btn-ring"],
        } : undefined}>
        {t.mail ? <Icon name="search" color={t.c.ink2} size={20} /> : null}
        <TextInput
          ref={searchField}
          maxFontSizeMultiplier={t.textCap}
          disableFullscreenUI
          keyboardAppearance={t.scheme}
          value={addr ?? q}
          onChangeText={(text) => {
            // Typing is a new question — it leaves the address view and asks the index.
            setAddr(null);
            setQ(text);
            setAllPeople(false);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          autoFocus={!t.mail}
          returnKeyType="search"
          placeholder={Copy.searchPlaceholder}
          placeholderTextColor={t.mail ? t.c.ink2 : t.c.ink3}
          accessibilityLabel={Copy.search}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            paper && (addr ?? q) !== "" ? t.type.bodyMedium : t.type.body,
            {
              color: t.c.ink,
              backgroundColor: t.mail ? "transparent" : t.c.tint2,
              borderRadius: t.radius.pill,
              paddingHorizontal: t.mail ? 0 : 14,
              paddingVertical: 9,
              flex: t.mail ? 1 : undefined,
              minWidth: 0,
            },
            t.mail && Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : null,
          ]}
        />
        {t.mail && store.verdict === "ready" && store.ms !== null && addr === null
          ? <Txt variant="caption" tone="ink3" tabular>{Copy.searchServerMs(store.ms)}</Txt> : null}
        {t.mail && (addr ?? q) !== "" ? (
          <Tap accessibilityRole="button" accessibilityLabel={Copy.searchClear}
            onPress={() => { setAddr(null); setQ(""); setAllPeople(false); searchField.current?.focus(); }} style={{ padding: 6 }}>
            <Icon name="x" size={14} color={t.c.ink2} />
          </Tap>
        ) : null}
        </View>
        {addr === null ? <SearchFacets filters={filters} order={order} locale={locale}
          onFilters={(value) => { setAllPeople(false); setFilters(value); }} onOrder={setOrder} /> : null}
      </View>
      <MailList
        groups={groups}
        rowKey={(r) => r.key}
        topFor={addr === null ? `q:${questionKey ?? trimmed}` : `a:${dir}:${addr}`}
        renderRow={(r): ReactElement => {
          if ("heading" in r) return r.heading;
          if ("person" in r) return <SearchPersonRow entry={r.person} resting={resting} onPick={() => {
            searchField.current?.blur();
            setQ("");
            setAllPeople(false);
            setAddr(r.person.person.address);
            setDir("any");
          }} />;
          if ("device" in r) {
            const row = <MailRow m={r.device} searchTerm={t.mail ? trimmed : undefined} onPress={() => openMessage(r.device.id)} />;
            return r.key === firstResult ? <View style={cursorFace}>{row}</View> : row;
          }
          if ("archive" in r) {
            return <MailRow m={r.mail} searchTerm={t.mail ? trimmed : undefined} onPress={() => { w.store.open(r.archive); openMessage(r.archive.id); }} />;
          }
          const m = store.rowAt(r.slot);
          return (
            <View style={{ height: m === "gone" ? 0 : heights.heightOf(r.slot), overflow: "hidden" }}>
              {m === "gone" ? <View onLayout={() => onRowHeight(r.slot, 0)} /> : m === null ? (
                <View style={{ flex: 1, justifyContent: "center", gap: 8, paddingHorizontal: 12 }}>
                  <View style={{ height: 10, width: "46%", borderRadius: 5, backgroundColor: t.c.tint2 }} />
                  <View style={{ height: 10, width: "72%", borderRadius: 5, backgroundColor: t.c.tint2 }} />
                </View>
              ) : (
                <View onLayout={(e) => onRowHeight(r.slot, e.nativeEvent.layout.height)} style={r.key === firstResult ? cursorFace : undefined}>
                  <MailRow
                    m={m}
                    searchTerm={t.mail ? trimmed : undefined}
                    onPress={() => {
                      const src = store.sourceAt(r.slot);
                      if (src) w.store.open(src);
                      openMessage(m.id);
                    }}
                  />
                </View>
              )}
            </View>
          );
        }}
        onRowFrame={(r, frame) => { if ("slot" in r && r.slot === 0) top.current = frame.y; }}
        /* The slots on screen are asked for; near the end of the list, the store's next page. */
        onScroll={(e) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
          const y = Math.max(0, contentOffset.y - top.current);
          const first = heights.indexAt(y, store.length);
          store.want(Math.max(0, first - 8), heights.indexAt(y + layoutMeasurement.height, store.length) + 10);
          if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 480) store.loadMore();
        }}
        scrollEventThrottle={100}
        rowInset={6}
        avoidKeyboard
        surface={t.mail || around !== null || (answer !== null && (trimmed !== "" || question !== null))}
        foot={resting && mailboxTotal !== null ? (
          <Txt tone="ink2" style={{ paddingHorizontal: mailSize.edge, paddingVertical: mailSize.inset * 2 }}>
            {Copy.searchMailboxTotal(mailboxTotal)}
          </Txt>
        ) : t.mail ? <>{emptyUnderPeople}{notice}</> : null}
        head={
          around !== null && addr !== null ? (
            /* ── THE ADDRESS VIEW — the device's half, three directions, all three counts ───── */
            <View style={{ paddingHorizontal: 14, paddingTop: 12, paddingBottom: 4 }}>
              {/* The group carries the question; the three tabs carry the answers. */}
              <View accessibilityRole="tablist" accessibilityLabel={Copy.searchAddressToggleAria}>
                <Segmented
                  fill={false}
                  segments={[
                    { value: "any", label: Copy.searchAddressAll },
                    { value: "from", label: Copy.searchAddressFrom },
                    { value: "to", label: Copy.searchAddressTo },
                  ]}
                  value={dir}
                  onChange={setDir}
                />
              </View>
              {/* The three counts, always all three — the toggle can say what each holds. */}
              <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 8 }}>
                {Copy.searchAddressCounts(around.counts.any, around.counts.from, around.counts.to)}
              </Txt>
              {/* The archive's half, its own line: what it holds, or why it said nothing. */}
              {archiveSaid !== null ? (
                <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>{archiveSaid}</Txt>
              ) : null}
              {archive.state === "failed" ? (
                <Tap onPress={archive.retry} accessibilityRole="button" accessibilityLabel={Copy.searchWholeRetry}>
                  <Txt variant="note" tone="accent">{Copy.searchWholeRetry}</Txt>
                </Tap>
              ) : null}
            </View>
          ) : t.mail ? null : notice
        }
        empty={meant.length === 0 ? empty : null}
      />
    </Screen>
  );
  return t.mail && !inPane ? <MailPlaceDock onSearch={() => searchField.current?.focus()}>{page}</MailPlaceDock> : page;
}
