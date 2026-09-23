/**
 * Drafts — what you started and have not sent. The rows come off the mirror
 * like every other list (`live.ts#liveDrafts` over the shared `draftsList` selector), so a
 * message begun on the web is here — and, for the first time on this phone, so is a send the
 * server could not confirm: until this screen existed that answer was said once in a toast and
 * then nowhere, while the row held the only copy of a message that may never have been
 * delivered. The verbs are on the row's card (`src/ui/DraftReader.tsx`); this screen lists.
 */
import { View } from "react-native";
import { Copy } from "../../src/copy";
import { usePullToSync } from "../../src/state/pull";
import { listSurface } from "../../src/state/surface";
import { useWorld, type WorldDraft } from "../../src/state/world";
import { Empty, Panel, Rule, Screen, Scroller, TapRow, Tail, Txt } from "../../src/ui/base";
import { DetailBar } from "../../src/ui/chrome";
import { DraftReader } from "../../src/ui/DraftReader";
import { heldSentence } from "../../src/ui/draft-card";
import { Gated } from "../../src/ui/Gated";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { SkeletonList } from "../../src/ui/Skeleton";
import { useLocale } from "../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../src/ui/ErrorBoundary";

/** Gated like the tabs — a deep-linked route must not render the empty world. */
export default function DraftsScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <SurfaceBoundary surface="drafts">
      <Gated>
        <DraftsBody />
      </Gated>
    </SurfaceBoundary>
  );
}

function DraftsBody() {
  const w = useWorld();
  const pull = usePullToSync();
  const { open, openRow, close } = useListDetail((id) => `/drafts/${id}`);
  const rows = w.drafts;
  /* Unknown ≠ empty (`state/surface.ts`): before this mirror has settled a drain, no rows means
     NOT KNOWN, and "Nothing half-written" would be a claim about the account made from an empty
     database. The silhouette stands until a drain has completed here at least once. */
  const surface = listSurface({ settled: w.boot.settled, count: rows.length });

  const list = (
    <Screen>
      <DetailBar title={Copy.draftsTitle} />
      <Scroller bounded refresh={pull}>
        <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
          <Txt variant="h1">{Copy.draftsTitle}</Txt>
          {/* A sentence, not a bare figure — and the held count is the fact this screen
              exists for, so the head carries it where a person scans first. */}
          <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>
            {w.boot.settled
              ? Copy.draftsMeta(rows.length, rows.filter((r) => r.state !== "open").length)
              : " "}
          </Txt>
        </View>

        <Panel style={{ paddingBottom: 10 }}>
          {surface === "skeleton" ? (
            <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
              <SkeletonList rows={2} stalled={w.boot.syncFailure} />
            </View>
          ) : surface === "empty" ? (
            <Empty title={Copy.draftsEmptyTitle} hint={Copy.draftsEmptyHint} />
          ) : (
            rows.map((row, i) => (
              <View key={row.id}>
                {i > 0 ? <Rule inset={18} /> : null}
                <DraftRow row={row} onPress={() => openRow(row.id)} />
              </View>
            ))
          )}
        </Panel>
        <Tail>{Copy.draftsExplainer}</Tail>
      </Scroller>
    </Screen>
  );

  return (
    <ListDetail
      open={open}
      onClose={close}
      toRoute={(id) => `/drafts/${id}`}
      list={list}
      renderDetail={(id, ctx) => <DraftReader id={id} onClose={ctx.onClose} />}
    />
  );
}

function DraftRow({ row, onPress }: { row: WorldDraft; onPress: () => void }) {
  return (
    <TapRow
      onPress={onPress}
      accessibilityRole="button"
      /* The row's whole fact, spoken: what it is about, to whom, and — the half that matters —
         what is known about a send nobody has confirmed. `row-spoken.ts`'s discipline. */
      accessibilityLabel={
        row.heldSays === null
          ? Copy.ariaLabelDetail(row.subject, row.to === "" ? Copy.scheduledNoRecipient : row.to)
          : Copy.ariaLabelDetail(row.subject, heldSentence(row.heldSays))
      }
      style={{ paddingHorizontal: 18, paddingVertical: 12, gap: 4 }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
        <Txt variant="rowSender" style={{ flexShrink: 1 }} numberOfLines={1}>
          {row.subject}
        </Txt>
        <View style={{ flex: 1 }} />
        <Txt variant="caption" tone="ink3" tabular numberOfLines={1}>
          {row.when}
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
      {/* A HELD SEND IS NOT AN ORDINARY DRAFT and the list says so where a person is scanning
          it, not only inside the card: the whole reason this destination exists on the phone. */}
      {row.heldSays !== null ? (
        <Txt variant="caption" tone="ink" style={{ paddingTop: 2 }}>
          {heldSentence(row.heldSays)}
        </Txt>
      ) : null}
    </TapRow>
  );
}
