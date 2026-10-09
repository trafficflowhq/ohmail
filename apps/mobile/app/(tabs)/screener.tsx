/**
 * Screener — the consent gate, and the heart of the product.
 *
 * On the phone this is the list half only: three shelves (waiting, screened
 * out, spam) of senders. Tapping a sender opens the mail itself plus the
 * decision bar, full screen — you never decide about a sender you cannot see.
 * A row's AI suggestion badge renders only where the server sent one: no
 * classifier runs client-side, and a row without a suggestion honestly has
 * none. The shelf's rows go through `MailList`, which mounts a window of them.
 */
import { useState } from "react";
import { View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Copy } from "../../src/copy";
import { useTheme } from "../../src/theme";
import { destDone, type ScreenerSeg } from "../../src/state/model";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { relayMarkFor, type RelayMark } from "../../src/state/relay";
import { useEngineQueuesAsk, useWorld, type ScreenerRow } from "../../src/state/world";
import { Badge, Empty, Screen, Tail, TapRow, Txt } from "../../src/ui/base";
import { TopBar } from "../../src/ui/chrome";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { MailList } from "../../src/ui/MailList";
import { SenderDetail } from "../../src/ui/SenderDetail";
import { Segmented } from "../../src/ui/Segmented";
import { SkeletonList } from "../../src/ui/Skeleton";
import { useLocale } from "../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../src/ui/ErrorBoundary";
import { noneOrganized } from "../../src/ui/not-organizing";

/**
 * The three empty states, READ WHEN THE SCREEN RENDERS rather than when this module is imported.
 *
 * This was a plain table of `Copy.*` values, which made it a table of ENGLISH values: a deck getter
 * read at module scope is evaluated once, at import, in whatever language the register held at that
 * moment — decided by import order, not by the reader. The `useLocale()` subscription three lines
 * below could not help, because there was nothing left to re-read. `test/copy-census.test.ts` now
 * fails on any module-scope `Copy.` read anywhere in the tree.
 */
function emptyFor(seg: ScreenerSeg): { title: string; hint: string } {
  switch (seg) {
    case "waiting": return { title: Copy.waitingEmptyTitle, hint: Copy.waitingEmptyHint };
    case "screened": return { title: Copy.screenedEmptyTitle, hint: Copy.screenedEmptyHint };
    case "spam": return { title: Copy.spamEmptyTitle, hint: Copy.spamEmptyHint };
  }
}

export default function ScreenerScreen() {
  return (
    <SurfaceBoundary surface="screener">
      <ScreenerBody />
    </SurfaceBoundary>
  );
}

function ScreenerBody() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  const w = useWorld();
  // The waiting queue's first page is the engine's; it is asked when this screen is shown.
  useFocusEffect(useEngineQueuesAsk());
  const pull = usePullToSync();
  /* The shelf can arrive as a param: the pushed sender route migrates here when the window
     gains a second pane, naming the shelf its selection belongs to. */
  const params = useLocalSearchParams<{ seg?: string }>();
  const [seg, setSeg] = useState<ScreenerSeg>(
    params.seg === "screened" || params.seg === "spam" ? params.seg : "waiting",
  );
  /* Two panes: a sender row SELECTS and the decision view opens beside the shelves (the
     prototype's reading slot); one pane: it pushes, as ever. */
  const { open, openRow, close } = useListDetail(
    (key) => `/sender/${seg}/${encodeURIComponent(key)}`,
  );
  /* "First-time senders knock here" is false where nothing organizes any mailbox: the waiting shelf says that
     instead, once the mailbox read has answered (`known`), never on a guess. */
  const notYet = seg === "waiting" && w.mailboxes.known && noneOrganized(w.mailboxes.rows);
  const empty = notYet
    ? {
        title: Copy.waitingNotYetTitle,
        hint: Copy.waitingNotYetHint,
        action: { label: Copy.waitingNotYetPress, onPress: () => router.push("/settings") },
      }
    : emptyFor(seg);
  const { waiting, screened, spam, meta, waitingPending } = w.screener;
  // Unknown ≠ empty, per SEGMENT: the active shelf's own count against the one settled fact.
  const shelves: Record<ScreenerSeg, ScreenerRow[]> = { waiting, screened, spam };
  const rows = shelves[seg];
  /* …and the WAITING shelf has a second way of being unknown over a settled mirror: this phone
     derived it, and the account's cutline answer has not landed, so it was withheld rather than
     guessed wide (`state/live.ts#WorldScreener.waitingPending`). Only that shelf — the other two
     are decided by rules the answer has no say in. */
  const surface = listSurface({
    settled: w.boot.settled,
    count: rows.length,
    pending: seg === "waiting" && waitingPending,
  });
  const shelfEmpty = surface === "empty" ? (
    <Empty {...empty} />
  ) : (
    <SkeletonList
      kind="screener"
      {...(surface === "pending" ? { note: Copy.cutlinePending } : { stalled: w.boot.syncFailure })}
    />
  );

  const renderRow = (row: ScreenerRow) => {
    if (seg === "waiting") {
      const mark = relayMarkFor(row.address, w.screener.relayed, w.mailboxes.organizer?.name ?? null);
      return <WaitingRow row={row} mark={mark} onPress={() => openRow(row.routeKey)} />;
    }
    if (seg === "screened") {
      return (
        <TapRow
          onPress={() => openRow(row.routeKey)}
          accessibilityRole="button"
          style={{ paddingHorizontal: 12, paddingVertical: 12 }}
        >
          <Txt variant="rowSubject" numberOfLines={1}>
            {row.address}
          </Txt>
          <Txt variant="hint" tone="ink3" style={{ marginTop: 4 }}>
            {Copy.screenedNote(row.screenedOn, row.held.length)}
          </Txt>
        </TapRow>
      );
    }
    return (
      <TapRow
        onPress={() => openRow(row.routeKey)}
        accessibilityRole="button"
        style={{ paddingHorizontal: 12, paddingVertical: 12 }}
      >
        <Txt variant="rowSubjectSeen" tone="ink2" numberOfLines={1}>
          {row.address}
        </Txt>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
          {row.detection ? <Badge icon="shield">{row.detection}</Badge> : null}
          <Badge>{Copy.heldCaption(row.held.length)}</Badge>
        </View>
      </TapRow>
    );
  };

  const list = (
    <Screen>
      <TopBar />
      <MailList
        groups={[{ key: seg, rows, padTop: 8 }]}
        rowKey={(row) => row.routeKey}
        renderRow={renderRow}
        rowInset={6}
        refresh={pull}
        head={
          <>
            <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 14 }}>
              <Txt variant="h1">{Copy.screener}</Txt>
              <Txt variant="meta" tone="ink3" style={{ marginTop: 4 }}>
                {metaWhen(surface, meta) ?? " "}
              </Txt>
            </View>

            <Segmented
              style={{ marginHorizontal: 10, marginBottom: 14 }}
              value={seg}
              onChange={(v) => {
                // A routeKey is a fact only on its own shelf — a selection never crosses one.
                if (open !== null) close();
                setSeg(v);
              }}
              segments={[
                // Counts speak only over a settled mirror — a "0" badge beside a shelf that is
                // still rendering its skeleton would be an invented count (`state/surface.ts`).
                { value: "waiting", label: Copy.segWaiting, ...(w.boot.settled ? { count: waiting.length } : {}) },
                { value: "screened", label: Copy.segScreened, ...(w.boot.settled ? { count: screened.length } : {}) },
                { value: "spam", label: Copy.segSpam, ...(w.boot.settled ? { count: spam.length } : {}) },
              ]}
            />
          </>
        }
        empty={shelfEmpty}
        foot={
          rows.length > 0 && seg === "screened" ? <Tail>{Copy.screenerNothingDeleted}</Tail>
          : rows.length > 0 && seg === "spam" ? <Tail>{Copy.spamNote}</Tail>
          : null
        }
      />
    </Screen>
  );

  return (
    <ListDetail
      open={open}
      onClose={close}
      toRoute={(key) => `/sender/${seg}/${encodeURIComponent(key)}`}
      list={list}
      renderDetail={(key, ctx) => (
        <SenderDetail seg={seg} routeKey={key} inPane={ctx.inPane} onClose={ctx.onClose} />
      )}
    />
  );
}

function WaitingRow({ row, mark, onPress }: { row: ScreenerRow; mark: RelayMark | null; onPress: () => void }) {
  const t = useTheme();
  const aria = Copy.senderRowAria(row.name, row.address, row.held.length);
  return (
    <TapRow
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={mark ? `${aria} ${mark.text}` : aria}
      style={{ paddingHorizontal: 12, paddingVertical: 12 }}
    >
      <View style={{ flexDirection: "row", gap: 12 }}>
        <View
          style={[
            {
              width: 34,
              height: 34,
              borderRadius: 17,
              backgroundColor: t.c.float,
              alignItems: "center",
              justifyContent: "center",
            },
            t.lift("l0"),
          ]}
        >
          <Txt variant="settingsLabel" tone={row.dull ? "ink3" : "ink2"}>
            {row.initial}
          </Txt>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Txt
              variant={row.dull ? "rowSenderSeen" : "rowSender"}
              tone={row.dull ? "ink2" : "ink"}
              numberOfLines={1}
              style={{ flexShrink: 1 }}
            >
              {row.name}
            </Txt>
            <View style={{ flex: 1 }} />
            <Txt variant="caption" tone="ink3" tabular>
              {row.time}
            </Txt>
          </View>
          <Txt variant="caption" tone="ink3" numberOfLines={1} style={{ marginTop: 1 }}>
            {row.address}
          </Txt>
          <Txt
            variant={row.dull ? "rowSubjectSeen" : "rowSubject"}
            tone={row.dull ? "ink2" : "ink"}
            numberOfLines={1}
            style={{ marginTop: 5 }}
          >
            {row.newestSubject}
          </Txt>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 7 }}>
            {row.ai ? (
              <Badge icon="spark" tone="accent">
                {Copy.aiSuggests(destDone(row.ai.dest), row.ai.confidence)}
              </Badge>
            ) : null}
            <Badge>{Copy.heldCaption(row.held.length)}</Badge>
          </View>
          {/* THE DECISION THIS PHONE SENT, until the organizer answers it (`state/relay.ts`). */}
          {mark ? (
            <Txt variant="caption" tone={mark.kind === "refused" ? "ink" : "ink3"} style={{ marginTop: 6 }}>
              {mark.text}
            </Txt>
          ) : null}
        </View>
      </View>
    </TapRow>
  );
}
