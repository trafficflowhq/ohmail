/**
 * Search — ONE list, the webapp SearchView's contract in the one-pane shape: the mirror's instant
 * index paints first, the store's page (`state/store-views.ts#useStoreSearch`) then replaces it in
 * place, and the rest is History's list mechanism — fixed-height slots, pages by the store's
 * cursor as they scroll into view, at most three held. The SIMILAR tier stands under its own
 * heading and only when nothing matched exactly; the verdict says what was searched and how fast.
 * An address-shaped query that settles empty offers the address door: All · From them · To them.
 */
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { TextInput, View } from "react-native";
import { router } from "expo-router";
import { Copy } from "../src/copy";
/* The engine is reached through the seam, never from a screen — `privacy.test.ts`'s
   allow-list is the rule, and the direction union rides out with the rest. */
import { addressShaped, type AddressDirection } from "../src/state/live";
import { useStoreSearch } from "../src/state/store-views";
import { useWorld } from "../src/state/world";
import { useTheme } from "../src/theme";
import { Empty, Screen, Tap, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Gated } from "../src/ui/Gated";
import { MailList, type ListGroup } from "../src/ui/MailList";
import { MailRow } from "../src/ui/MailRow";
import { Segmented } from "../src/ui/Segmented";
import { useLocale } from "../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";
import type { WorldMail } from "../src/state/world";

/** One store slot's height — History's, so a scroll offset is a slot without measuring. */
const SLOT_PX = 84;

/** A row of the one list: the device's own, or a store slot read at render. */
type Row = { key: string; device: WorldMail } | { key: string; slot: number };

/** Gated like the tabs — a deep-linked route must not render the empty world. */
export default function SearchScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <SurfaceBoundary surface="search">
      <Gated>
        <SearchBody />
      </Gated>
    </SurfaceBoundary>
  );
}

function SearchBody() {
  const t = useTheme();
  const w = useWorld();
  const [q, setQ] = useState("");
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

  const trimmed = q.trim();
  const answer = addr === null ? w.search.query(q) : null;
  const around = addr !== null ? w.search.address(addr, dir) : null;
  const deviceIds = useMemo(() => (answer?.items ?? []).map((m) => m.id), [answer]);
  /* THE WHOLE-MAILBOX PASS — its page replaces the device's paint, rows on screen first. */
  const store = useStoreSearch(addr === null ? q : "", deviceIds);
  /* The store's slots, as positions only: a row is read per slot from the walker's cache. */
  const slots = useMemo(() => Array.from({ length: store.length }, (_, i): Row => ({ key: `slot-${i}`, slot: i })), [store.length]);
  const deviceRows = (list: readonly WorldMail[]): Row[] => list.map((m) => ({ key: m.id, device: m }));
  const shownItems: Row[] = store.ready ? (store.tier === "exact" ? slots : []) : deviceRows(answer?.items ?? []);
  const shownSimilar: Row[] = store.ready ? (store.tier === "similar" ? slots : []) : deviceRows(answer?.similar ?? []);
  const found = store.ready && store.totalExact ? Math.max(store.total, store.length) : shownItems.length + shownSimilar.length;
  /** Where slot 0 sits in the scroll content, learnt from its own frame. */
  const top = useRef(0);
  const door = answer !== null ? addressShaped(trimmed) : null;
  const verdict = addr !== null ? null : store.verdict === "searching" ? Copy.searchWholeSearching
    : store.verdict === "ready"
      ? `${store.totalExact ? Copy.searchWhole(store.total) : Copy.searchWholeAtLeast(store.total)}${store.ms !== null ? ` · ${Copy.searchServerMs(store.ms)}` : ""}`
      : store.verdict === "unanswered" ? Copy.searchUnanswered : null;

  /* EVERY ROW GOES THROUGH THE WINDOW. One address can hold thousands of this mailbox's
     messages — `messagesWith` returns all of them, unsliced — so the results are a `MailList`
     like every other list on the phone rather than a scroll view that mounts the answer whole.
     One list per screen: the branch below decides its groups, its head and its empty state. */
  const groups: ListGroup<Row>[] =
    around !== null && addr !== null
      ? [{ key: "around", rows: deviceRows(around.items) }]
      : answer !== null && trimmed !== "" && (shownItems.length > 0 || shownSimilar.length > 0)
        ? [
            {
              key: "results",
              title: Copy.searchResultsHead(found),
              rows: shownItems,
            },
            { key: "similar", title: Copy.searchSimilarHead, note: Copy.searchSimilarHint, rows: shownSimilar },
          ]
        : [];

  return (
    <Screen>
      <DetailBar title={Copy.search} />
      <View style={{ paddingHorizontal: 12, paddingBottom: 8 }}>
        <TextInput
          value={addr ?? q}
          onChangeText={(text) => {
            // Typing is a new question — it leaves the address view and asks the index.
            setAddr(null);
            setQ(text);
          }}
          autoFocus
          placeholder={Copy.searchPlaceholder}
          placeholderTextColor={t.c.ink3}
          accessibilityLabel={Copy.search}
          autoCapitalize="none"
          autoCorrect={false}
          style={[
            t.type.body,
            {
              color: t.c.ink,
              backgroundColor: t.c.tint2,
              borderRadius: t.radius.pill,
              paddingHorizontal: 14,
              paddingVertical: 9,
            },
          ]}
        />
      </View>
      <MailList
        groups={groups}
        rowKey={(r) => r.key}
        renderRow={(r): ReactElement => {
          if ("device" in r) {
            return <MailRow m={r.device} onPress={() => router.push(`/message/${r.device.id}`)} />;
          }
          const m = store.rowAt(r.slot);
          return (
            <View style={{ height: m === "gone" ? 0 : SLOT_PX, overflow: "hidden" }}>
              {m === "gone" ? null : m === null ? (
                <View style={{ flex: 1, justifyContent: "center", gap: 8, paddingHorizontal: 12 }}>
                  <View style={{ height: 10, width: "46%", borderRadius: 5, backgroundColor: t.c.tint2 }} />
                  <View style={{ height: 10, width: "72%", borderRadius: 5, backgroundColor: t.c.tint2 }} />
                </View>
              ) : (
                <MailRow
                  m={m}
                  onPress={() => {
                    const src = store.sourceAt(r.slot);
                    if (src) w.store.open(src);
                    router.push(`/message/${m.id}`);
                  }}
                />
              )}
            </View>
          );
        }}
        onRowFrame={(r, frame) => { if ("slot" in r && r.slot === 0) top.current = frame.y; }}
        /* The slots on screen are asked for; near the end of the list, the store's next page. */
        onScroll={(e) => {
          const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
          const first = Math.floor(Math.max(0, contentOffset.y - top.current) / SLOT_PX);
          store.want(Math.max(0, first - 8), first + Math.ceil(layoutMeasurement.height / SLOT_PX) + 9);
          if (contentOffset.y + layoutMeasurement.height >= contentSize.height - 480) store.loadMore();
        }}
        scrollEventThrottle={100}
        rowInset={6}
        surface={around !== null || (answer !== null && trimmed !== "")}
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
            </View>
          ) : verdict !== null ? (
            /* ── THE VERDICT — what was searched, and how fast ──────────────────────────── */
            <View style={{ paddingHorizontal: 14, paddingTop: 8, paddingBottom: 4, gap: 4 }}>
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
              {store.bounded ? (
                <Txt variant="note" tone="ink3">{Copy.searchBounded(store.length)}</Txt>
              ) : null}
            </View>
          ) : null
        }
        empty={
          around !== null && addr !== null ? (
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
          ) : answer !== null && trimmed === "" ? null : answer !== null ? (
            answer.indexing && !store.ready ? (
              /* Not yet ≠ nothing: the index is still filling (`indexingResult`'s whole rule). */
              <Empty title={Copy.searchIndexing} hint={verdict ?? ""} />
            ) : store.verdict === "searching" ? null : (
              <>
                <Empty title={Copy.searchEmptyTitle} hint="" />
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
          ) : null
        }
      />
    </Screen>
  );
}
