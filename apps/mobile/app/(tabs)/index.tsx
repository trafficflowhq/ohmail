/**
 * Ohbox — mail from people you said Yes to.
 *
 * The list splits new / previously seen and never re-sorts under the reader.
 * The split is the engine's own rows (`ohboxRows`), one per conversation —
 * new-for-you / earlier, plus the resurfaced pin group above both (mail whose
 * "show me this again" moment has come). The screen renders what `useWorld()` answers and holds no logic of
 * its own. An empty mailbox renders an honest empty state, never sample mail.
 * The rows go through `MailList`, which mounts a window of them, not the mailbox.
 */
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { useFocusEffect, useIsFocused } from "expo-router";
import { Copy } from "../../src/copy";
import {
  onOrganizerState, organizerStateVersion, readingAtConnectSaid, sayReadingAtConnect,
} from "../../src/engine/organizer-session";
import { heldWhileHidden } from "../../src/state/held-while-hidden";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { useEngineQueuesAsk, useWorld, type World, type WorldMail, type WorldUnscreened } from "../../src/state/world";
import { Button, Empty, Panel, Screen, Tail, Txt } from "../../src/ui/base";
import { Doorbell, TopBar } from "../../src/ui/chrome";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { MailList, type ListGroup } from "../../src/ui/MailList";
import { MailRow } from "../../src/ui/MailRow";
import { MarkAllRead } from "../../src/ui/MarkAllRead";
import { MessageReader } from "../../src/ui/MessageReader";
import { OrganizerStrip } from "../../src/ui/OrganizerStrip";
import { SkeletonList } from "../../src/ui/Skeleton";
import { readingAtConnectLine } from "../../src/ui/standalone-form";
import { useLocale } from "../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../src/ui/ErrorBoundary";

export default function OhboxScreen() {
  return (
    <SurfaceBoundary surface="ohbox">
      <OhboxBody />
    </SurfaceBoundary>
  );
}

function OhboxBody() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  const w = useWorld();
  // The offer and the doorbell come from the engine's queue reads, asked when this screen is shown.
  useFocusEffect(useEngineQueuesAsk());
  const pull = usePullToSync();
  /* Two panes: a row SELECTS and the reader opens beside the list; one pane: it pushes, as
     ever. The selection is the route's `open` param — `src/ui/list-detail.tsx` is the rule. */
  const { open, openRow, close } = useListDetail((id) => `/message/${id}`);
  /* Under a pushed reader this screen is hidden: it keeps what it showed (`held-while-hidden.ts`). */
  const focused = useIsFocused();
  const kept = useRef<{ ohbox: World["ohbox"]; doorbell: World["doorbell"] } | null>(null);
  const shown = heldWhileHidden(focused, kept.current, () => ({ ohbox: w.ohbox, doorbell: w.doorbell }));
  kept.current = shown;
  const { resurfaced, fresh, seen, total, meta } = shown.ohbox;
  /* WHO ORGANIZES THIS MAILBOX, said where the connect lands when it is not this phone. Scoped to
     the standalone session: the notice is about the engine in this app, never another account. */
  useSyncExternalStore(
    useCallback((cb: () => void) => onOrganizerState(cb), []),
    organizerStateVersion,
    organizerStateVersion,
  );
  const reading = w.standalone ? readingAtConnectSaid() : null;

  // Unknown ≠ empty: before this mirror has ever settled a drain, a zero-row Ohbox shows
  // the shape of what is coming, never "All quiet" — `state/surface.ts` is the whole rule.
  const surface = listSurface({ settled: w.boot.settled, count: total });

  const groups: ListGroup<WorldMail>[] = [
    { key: "resurfaced", title: Copy.groupResurfaced, rows: resurfaced },
    { key: "fresh", title: Copy.groupNew, rows: fresh },
    { key: "seen", title: Copy.groupSeen, rows: seen },
  ];

  const list = (
    <Screen>
      <TopBar />
      <MailList
        groups={groups}
        rowKey={(m) => m.rowKey ?? m.id}
        renderRow={(m) => <MailRow m={m} onPress={() => openRow(m.id)} swipe />}
        rowInset={6}
        refresh={pull}
        head={
          <>
            <ViewHeadOhbox
              meta={metaWhen(surface, meta)}
              unread={shown.ohbox.unreadIds.length}
              onMarkAll={() => w.actions.markAllSeen(shown.ohbox.unreadIds)}
            />
            {reading ? (
              <Panel style={{ paddingVertical: 14, paddingHorizontal: 18, marginBottom: 12 }}>
                <Txt variant="note" tone="ink2" accessibilityRole="text">
                  {readingAtConnectLine(reading)}
                </Txt>
                <Button
                  label={Copy.stripDismiss}
                  variant="quiet"
                  onPress={() => sayReadingAtConnect(null)}
                  style={{ marginTop: 8, alignSelf: "flex-start" }}
                />
              </Panel>
            ) : null}
            <UnscreenedOffer offer={shown.ohbox.unscreened} screen={w.actions.screenUnscreened} />
            {/* Who organizes this mailbox, where it is news — the Settings card's own claim. */}
            <OrganizerStrip />
            <Doorbell initials={shown.doorbell.initials} count={shown.doorbell.count} />
          </>
        }
        empty={
          surface === "skeleton" ? (
            <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
              <SkeletonList stalled={w.boot.syncFailure} />
            </View>
          ) : surface === "empty" ? (
            <Empty title={Copy.ohboxEmptyTitle}
              /* NO MAIL AND NOTHING READABLE ARE NOT THE SAME EMPTY SCREEN. The hint below
                 promised that mail "lands here as it syncs", which is false for a mailbox whose
                 first sync produced nothing — and that mailbox looked exactly like a quiet one.
                 The engine's own answer chooses (`live.ts#firstSyncSay`); `null` and every other
                 verdict keep the ordinary line. */
              hint={w.boot.firstSync === "nothingReadable"
                ? Copy.ohboxEmptyNothingReadable
                : Copy.ohboxEmptyHint}
            />
          ) : null
        }
        foot={surface === "content" ? <Tail>{Copy.ohboxTail(total)}</Tail> : null}
      />
    </Screen>
  );

  return (
    <ListDetail
      open={open}
      onClose={close}
      toRoute={(id) => `/message/${id}`}
      list={list}
      renderDetail={(id, ctx) => <MessageReader id={id} inPane={ctx.inPane} onClose={ctx.onClose} />}
    />
  );
}

/**
 * MAIL FROM SENDERS NOBODY DECIDED ABOUT, STILL IN THE INBOX ON THE SERVER — the web's offer, in the
 * card the reading notice above uses. Mail that was in the Inbox when the phone connected stays in
 * the Ohbox; nothing moves until this is pressed, and the press is the web's route.
 */
function UnscreenedOffer({ offer, screen }: { offer: WorldUnscreened | null; screen: () => Promise<boolean> }) {
  const [pressing, setPressing] = useState(false);
  if (offer === null) return null;
  const press = (): void => {
    if (pressing) return;
    setPressing(true);
    void screen().finally(() => setPressing(false));
  };
  return (
    <Panel style={{ paddingVertical: 14, paddingHorizontal: 18, marginBottom: 12 }}>
      <Txt variant="note" tone="ink2" accessibilityRole="text">{Copy.unscreenedLead(offer.total)}</Txt>
      <Button
        label={Copy.unscreenedAll(offer.total)}
        variant="solid"
        disabled={pressing}
        onPress={press}
        style={{ marginTop: 8, alignSelf: "flex-start" }}
      />
    </Panel>
  );
}

function ViewHeadOhbox({
  meta,
  unread,
  onMarkAll,
}: {
  meta: string | undefined;
  unread: number;
  onMarkAll: () => void;
}) {
  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 14 }}>
      <View style={{ flexDirection: "row", alignItems: "center" }}>
        <Txt variant="h1">{Copy.ohbox}</Txt>
        <View style={{ flex: 1 }} />
        {/* Renders nothing over a cleared list — the component's own rule. */}
        <MarkAllRead unreadCount={unread} onPress={onMarkAll} />
      </View>
      {/* Silenced over a skeleton (`metaWhen`): "0 unread of 0" about an unread mirror
          would be an invented count. The line keeps its slot so nothing shifts. */}
      <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>
        {meta ?? " "}
      </Txt>
    </View>
  );
}
