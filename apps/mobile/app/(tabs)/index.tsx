/**
 * Ohbox — mail from people you said Yes to.
 *
 * The list splits new / previously seen and never re-sorts under the reader.
 * The split is the engine's own `ohboxView` — new-for-you / earlier, plus the
 * resurfaced pin group above both (mail whose "show me this again" moment has
 * come). The screen renders what `useWorld()` answers and holds no logic of
 * its own. An empty mailbox renders an honest empty state, never sample mail.
 */
import { View } from "react-native";
import { Copy } from "../../src/copy";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { useWorld, type WorldMail } from "../../src/state/world";
import { Empty, Panel, Screen, Scroller, Section, Tail, Txt } from "../../src/ui/base";
import { Doorbell, TopBar } from "../../src/ui/chrome";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { MailRow } from "../../src/ui/MailRow";
import { MessageReader } from "../../src/ui/MessageReader";
import { SkeletonList } from "../../src/ui/Skeleton";
import { useLocale } from "../../src/i18n/LocaleProvider";

export default function OhboxScreen() {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  const w = useWorld();
  const pull = usePullToSync();
  /* Two panes: a row SELECTS and the reader opens beside the list; one pane: it pushes, as
     ever. The selection is the route's `open` param — `src/ui/list-detail.tsx` is the rule. */
  const { open, openRow, close } = useListDetail((id) => `/message/${id}`);
  const { resurfaced, fresh, seen, total, meta } = w.ohbox;
  // Unknown ≠ empty: before this mirror has ever settled a drain, a zero-row Ohbox shows
  // the shape of what is coming, never "All quiet" — `state/surface.ts` is the whole rule.
  const surface = listSurface({ settled: w.boot.settled, count: total });

  const group = (rows: WorldMail[]) => (
    <View style={{ paddingHorizontal: 6 }}>
      {rows.map((m) => (
        <MailRow key={m.id} m={m} onPress={() => openRow(m.id)} />
      ))}
    </View>
  );

  const list = (
    <Screen>
      <TopBar />
      <Scroller refresh={pull}>
        <ViewHeadOhbox meta={metaWhen(surface, meta)} />
        <Doorbell initials={w.doorbell.initials} count={w.doorbell.count} />

        <Panel style={{ paddingBottom: 4 }}>
          {surface === "skeleton" ? (
            <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
              <SkeletonList stalled={w.boot.syncFailure} />
            </View>
          ) : surface === "empty" ? (
            <Empty
              glyph="📭"
              title={Copy.ohboxEmptyTitle}
              /* NO MAIL AND NOTHING READABLE ARE NOT THE SAME EMPTY SCREEN. The hint below
                 promised that mail "lands here as it syncs", which is false for a mailbox whose
                 first sync produced nothing — and that mailbox looked exactly like a quiet one.
                 The engine's own answer chooses (`live.ts#firstSyncSay`); `null` and every other
                 verdict keep the ordinary line. */
              hint={w.boot.firstSync === "nothingReadable"
                ? Copy.ohboxEmptyNothingReadable
                : Copy.ohboxEmptyHint}
            />
          ) : (
            <>
              {resurfaced.length > 0 ? (
                <>
                  <Section style={{ paddingTop: 18 }}>{Copy.groupResurfaced}</Section>
                  {group(resurfaced)}
                </>
              ) : null}

              {fresh.length > 0 ? (
                <>
                  <Section style={resurfaced.length === 0 ? { paddingTop: 18 } : undefined}>
                    {Copy.groupNew}
                  </Section>
                  {group(fresh)}
                </>
              ) : null}

              {seen.length > 0 ? (
                <>
                  <Section>{Copy.groupSeen}</Section>
                  {group(seen)}
                </>
              ) : null}

              <Tail>{Copy.ohboxTail(total)}</Tail>
            </>
          )}
        </Panel>
      </Scroller>
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

function ViewHeadOhbox({ meta }: { meta: string | undefined }) {
  return (
    <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 14 }}>
      <Txt variant="h1">{Copy.ohbox}</Txt>
      {/* Silenced over a skeleton (`metaWhen`): "0 unread of 0" about an unread mirror
          would be an invented count. The line keeps its slot so nothing shifts. */}
      <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>
        {meta ?? " "}
      </Txt>
    </View>
  );
}
