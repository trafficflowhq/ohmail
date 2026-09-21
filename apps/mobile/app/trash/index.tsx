/**
 * Trash — mail deleted in ohmail, and the one place it can be put back (the 0.20 review's
 * delete-recovery finding; the webapp's `TrashView` is the reference, `FolderView`'s
 * composition one surface over). The rows are
 * OFF-MIRROR by construction — a delete tombstones the row in every mirror — so this screen
 * holds the page itself (`actions.trashList`), one flat list in the server's order (newest
 * deletion first), and arriving IS the ask: the first page loads on mount, and the state dies
 * with the screen, so no visit renders yesterday's Trash. Unavailable is its own sentence and
 * never an empty list; a failed page renders the failure and a retry, never "empty".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { Copy } from "../../src/copy";
import { type WorldTrashRow } from "../../src/state/live";
import { holdTrashRows } from "../../src/state/trash-hold";
import { useWorld } from "../../src/state/world";
import { Empty, Panel, Screen, Scroller, TapRow, Tail, Txt } from "../../src/ui/base";
import { DetailBar } from "../../src/ui/chrome";
import { Gated } from "../../src/ui/Gated";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { MailRow } from "../../src/ui/MailRow";
import { SkeletonList } from "../../src/ui/Skeleton";
import { TrashReader } from "../../src/ui/TrashReader";
import { useLocale } from "../../src/i18n/LocaleProvider";

/** Gated like the tabs: a restored route must land on the connect flow, not an empty list. */
export default function TrashScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <Gated>
      <TrashBody />
    </Gated>
  );
}

function TrashBody() {
  const w = useWorld();
  const { open, openRow, close } = useListDetail((mid) => `/trash/${mid}`);
  const [items, setItems] = useState<WorldTrashRow[]>([]);
  const [loading, setLoading] = useState(false);
  /** `null` renders no failure; the empty string renders the surface's own sentence — the
   *  webapp `trash-page.ts` distinction, kept: most server text is written for a log. */
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);
  /* The cursor in a ref — read inside `loadMore`, never rendered (the webapp's own note). */
  const cursor = useRef<string | null>(null);
  const inFlight = useRef(false);
  const trashList = w.actions.trashList;

  const loadMore = useCallback(() => {
    if (inFlight.current || exhausted) return;
    inFlight.current = true;
    setLoading(true);
    void trashList(cursor.current)
      .then((page) => {
        if (page.state === "unavailable") {
          // The transport went away between the gate and the ask — nothing failed, nothing to
          // retry; `w.trash.available` reads false on the next render and the screen says so.
          setExhausted(true);
          return;
        }
        if (page.state === "failed") {
          setError(page.say ?? "");
          return;
        }
        setError(null);
        const reset = cursor.current === null;
        // The pushed detail route reads rows from the hold — page one replaces it.
        holdTrashRows(page.items, reset);
        /* Append, de-duplicated by id — the keyset shifts when a delete lands between two
           pages, so a row can legitimately arrive twice; the copy on screen wins. */
        setItems((prev) => {
          const base = reset ? [] : prev;
          const seen = new Set(base.map((r) => r.mail.id));
          return [...base, ...page.items.filter((r) => !seen.has(r.mail.id))];
        });
        cursor.current = page.nextCursor;
        if (page.nextCursor === null) setExhausted(true);
      })
      .finally(() => {
        inFlight.current = false;
        setLoading(false);
      });
  }, [trashList, exhausted]);

  /* Arriving is the ask — the whole view IS the list, so the first page loads unbidden. */
  useEffect(() => {
    loadMore();
    // Only the mount edge: `loadMore`'s identity moves with `exhausted`, and re-running on
    // that would ask for page one again the moment the walk finished.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onRestored = (id: string) => setItems((prev) => prev.filter((r) => r.mail.id !== id));

  if (!w.trash.available) {
    return (
      <Screen>
        <DetailBar title={Copy.trashTitle} />
        <Scroller>
          <Empty title={Copy.trashUnavailable} hint={Copy.trashFoot} />
        </Scroller>
      </Screen>
    );
  }

  const list = (
    <Screen>
      <DetailBar title={Copy.trashTitle} />
      <Scroller>
        <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 }}>
          <Txt variant="h1">{Copy.trashTitle}</Txt>
        </View>

        {error !== null ? (
          <Panel style={{ paddingHorizontal: 6, paddingVertical: 8 }}>
            <Txt variant="note" tone="ink3" style={{ paddingHorizontal: 8, paddingBottom: 6 }}>
              {error === "" ? Copy.trashListFailed : error}
            </Txt>
            <TapRow accessibilityRole="button" accessibilityLabel={Copy.trashRetry} onPress={loadMore} style={{ paddingHorizontal: 8, paddingVertical: 10 }}>
              <Txt variant="button" tone="accent">{Copy.trashRetry}</Txt>
            </TapRow>
          </Panel>
        ) : items.length > 0 ? (
          <>
            <Panel style={{ paddingBottom: 4 }}>
              {items.map((r) => (
                <MailRow key={r.mail.id} m={r.mail} onPress={() => openRow(r.mail.id)} />
              ))}
              {!exhausted ? (
                <TapRow
                  accessibilityRole="button"
                  accessibilityLabel={Copy.trashShowOlder}
                  onPress={loadMore}
                  style={{ paddingHorizontal: 14, paddingVertical: 12 }}
                >
                  {/* The label holds while a page is in flight — `inFlight` makes the press a
                      no-op, and a swapped-in word here would claim a state the row is not in. */}
                  <Txt variant="button" tone="accent">
                    {Copy.trashShowOlder}
                  </Txt>
                </TapRow>
              ) : null}
            </Panel>
            <Tail>{Copy.trashFoot}</Tail>
          </>
        ) : loading || !exhausted ? (
          /* Neither sentence may be said yet — the server has not finished answering, and
             "Trash is empty" about a list nobody has heard back about is a claim. */
          <Panel style={{ paddingBottom: 4 }}>
            <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
              <SkeletonList stalled={false} />
            </View>
          </Panel>
        ) : (
          <>
            <Empty title={Copy.trashEmptyTitle} hint={Copy.trashEmptyHint} />
            <Tail>{Copy.trashFoot}</Tail>
          </>
        )}
      </Scroller>
    </Screen>
  );

  return (
    <ListDetail
      open={open}
      onClose={close}
      toRoute={(mid) => `/trash/${mid}`}
      list={list}
      renderDetail={(mid, ctx) => (
        <TrashReader id={mid} onRestored={onRestored} onClose={ctx.onClose} />
      )}
    />
  );
}
