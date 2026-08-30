/**
 * SCHEDULED — the messages waiting for their appointment (Send later, mail 0077).
 *
 * The webapp puts this group above its Drafts list, because there it is one of two things a
 * message can be while it is not sent. This app composes only replies and forwards and has no
 * Drafts view to put it above, so the appointments get their own destination in the More tab's
 * idiom — a place with real numbers, reached from the rail-shaped list, never a tile.
 *
 * The row's whole content is a promise about time, so the time is the row's stamp: when it
 * SENDS, in the reader's own clock, not when it was written. One verb — Cancel send — and one
 * ceremony around it: the ask is the row's own control, the answer is the SERVER's, and only a
 * confirmed cancellation says "cancelled" (`live.ts#cancelSchedule` holds the three outcomes).
 *
 * WHAT IS DELIBERATELY ABSENT: the webapp's Edit, which is cancel-then-open. There is no draft
 * editor on this phone to open a cancelled row into, so the screen says where the message goes
 * instead of offering a verb that leads nowhere (`Copy.scheduledEditNote`).
 */
import { useState } from "react";
import { View } from "react-native";
import { Copy } from "../src/copy";
import { usePullToSync } from "../src/state/pull";
import { useWorld, type WorldScheduled } from "../src/state/world";
import { Button, Panel, Rule, Screen, Scroller, Txt } from "../src/ui/base";
import { DetailBar } from "../src/ui/chrome";
import { Gated } from "../src/ui/Gated";
import { SkeletonList } from "../src/ui/Skeleton";

/** Gated like the tabs — a deep-linked route must not render the empty world. */
export default function ScheduledScreen() {
  return (
    <Gated>
      <ScheduledBody />
    </Gated>
  );
}

function ScheduledBody() {
  const w = useWorld();
  const pull = usePullToSync();
  // Unknown ≠ empty (`state/surface.ts`): before this mirror has settled a drain, no rows means
  // NOT KNOWN, and "Nothing scheduled" would be a claim about the account made from an empty
  // database. The silhouette stands until a drain has completed here at least once.
  const settled = w.boot.settled;
  const rows = w.scheduled;

  return (
    <Screen>
      <DetailBar title={Copy.scheduled} />
      <Scroller refresh={pull}>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
          <Txt variant="h1">{Copy.scheduled}</Txt>
          <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>
            {settled ? `${rows.length}` : " "}
          </Txt>
        </View>
        <Panel style={{ paddingBottom: 10 }}>
          {rows.length === 0 && !settled ? (
            <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
              <SkeletonList rows={2} stalled={w.boot.syncFailure} />
            </View>
          ) : rows.length === 0 ? (
            <Txt variant="note" tone="ink3" style={{ paddingHorizontal: 18, paddingVertical: 16 }}>
              {Copy.scheduledEmpty}
            </Txt>
          ) : (
            <>
              {rows.map((row, i) => (
                <View key={row.id}>
                  {i > 0 ? <Rule inset={18} /> : null}
                  <ScheduledRow row={row} />
                </View>
              ))}
              {/* The stated degradation, once at the foot rather than on every row. */}
              <Rule inset={18} />
              <Txt variant="caption" tone="ink3" style={{ paddingHorizontal: 18, paddingTop: 10, lineHeight: 16 }}>
                {Copy.scheduledEditNote}
              </Txt>
            </>
          )}
        </Panel>
      </Scroller>
    </Screen>
  );
}

function ScheduledRow({ row }: { row: WorldScheduled }) {
  const w = useWorld();
  /**
   * The cancel is DISABLED while its own dispatch is in flight, never hidden: a second press
   * would mint a second Idempotency-Key for the same intent. It re-arms on any outcome —
   * including the refusal — because a refused cancel is a thing the reader may reasonably try
   * again once the claim window has resolved one way or the other.
   */
  const [asking, setAsking] = useState(false);

  return (
    <View style={{ paddingHorizontal: 18, paddingVertical: 12, gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <Txt variant="rowSender" style={{ flexShrink: 1 }} numberOfLines={1}>
          {row.subject}
        </Txt>
        <View style={{ flex: 1 }} />
        {/* The APPOINTMENT is the stamp — `Sends Fri 18:00`, or the honest "time unknown" form
            for a row whose `sendAt` the mirror does not carry (see `liveScheduled`). */}
        <Txt variant="caption" tone="accent" tabular numberOfLines={1}>
          {row.when === null ? Copy.scheduledWhenUnknown : Copy.scheduledWhen(row.when)}
        </Txt>
      </View>
      <Txt variant="caption" tone="ink3" numberOfLines={1}>
        {row.to === "" ? Copy.scheduledNoRecipient : row.to}
      </Txt>
      {row.preview !== "" ? (
        <Txt variant="caption" tone="ink2" numberOfLines={2}>
          {row.preview}
        </Txt>
      ) : null}
      {/* A KEPT APPOINTMENT THAT FAILED speaks the SERVER's own sentence, quoted — a refusal
          the reader can act on is worth more than a sentence of ours that generalises it. */}
      {row.failure !== null ? (
        <Txt variant="caption" tone="ink" style={{ paddingTop: 2 }}>
          {Copy.scheduleFailedNote(row.failure)}
        </Txt>
      ) : null}
      <View style={{ flexDirection: "row", paddingTop: 6 }}>
        <Button
          label={Copy.scheduledCancel}
          variant={asking ? "plain" : "quiet"}
          onPress={
            asking
              ? undefined
              : () => {
                setAsking(true);
                void w.actions.cancelSchedule(row.id).finally(() => setAsking(false));
              }
          }
        />
      </View>
    </View>
  );
}
