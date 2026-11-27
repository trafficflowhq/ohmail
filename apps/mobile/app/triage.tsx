/**
 * Piles — Answer Later, Parked, Resurface.
 *
 * Paper gives the three piles a shared heading and a compact switcher. Counts
 * are derived from the items, so each pile names what it holds.
 */
import { MailAppearance } from "../src/theme/mail";
import { useReplyRun } from "@ohmail/app-logic/piles/reply-run";
import { useEffect, useState } from "react";
import { BackHandler, View, type ViewStyle } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Copy } from "../src/copy";
import { usePullToSync } from "../src/state/pull";
import { useTheme } from "../src/theme";
import { useWorld } from "../src/state/world";
import { pileParam, pileTitle, type PileKind } from "../src/state/model";
import { Badge, Button, Panel, Screen, Scroller, TapRow, Txt, ViewHead } from "../src/ui/base";
import { DetailBar, PaneTop, TopBar } from "../src/ui/chrome";
import { YieldToMore } from "../src/ui/more-move";
import { MailAvatar } from "../src/ui/MailAvatar";
import { MailCalendarSwitch } from "../src/ui/MailCalendarSwitch";
import { MailPlaceDock } from "../src/ui/MailPlaceDock";
import { MessageReader } from "../src/ui/MessageReader";
import { Gated } from "../src/ui/Gated";
import { Icon, type IconName } from "../src/ui/Icon";
import { SkeletonList } from "../src/ui/Skeleton";
import { Segmented } from "../src/ui/Segmented";
import { useLocale } from "../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../src/ui/ErrorBoundary";

const PILE_ICON: Record<string, IconName> = {
  replyLater: "clock",
  setAside: "pause",
  resurface: "up",
};

/** Gated like the tabs — a deep-linked route must not render the empty world. */
export default function TriageScreen({ inPane = false, pile }: {
  inPane?: boolean;
  /** In More's pane, the pile its row named (the route reads its own param). */
  pile?: string;
}) {
  /* Subscribed to the language, so a switch in Settings redraws this screen instead of
     waiting for the next navigation — see `src/i18n/LocaleProvider.tsx`. */
  useLocale();
  return (
    <SurfaceBoundary surface="triage">
      <MailAppearance>
        <Gated>
          <TriageBody inPane={inPane} pile={pile} />
        </Gated>
      </MailAppearance>
    </SurfaceBoundary>
  );
}

function TriageBody(props: { inPane: boolean; pile?: string }) {
  const world = useWorld();
  return <TriageMail key={world.worldKey} {...props} />;
}

function TriageMail({ inPane, pile }: { inPane: boolean; pile?: string }) {
  const t = useTheme();
  const w = useWorld();
  const pull = usePullToSync();
  // Unknown ≠ empty (`state/surface.ts`): before this mirror has settled a drain, a pile
  // with no items shows the row silhouette, never "Nothing here" — and the derived counts
  // and meta stay silent for the same reason (a "0" over a skeleton is an invented count).
  const settled = w.boot.settled;
  /* More's pile entries name their pile: that pile alone, under its own title. */
  const param = useLocalSearchParams<{ pile?: string }>().pile;
  const only = pileParam(inPane ? pile : param);
  const [picked, setPicked] = useState<PileKind>("replyLater");
  const tabs = t.mail === true && only === null;
  const shown = only ?? (tabs ? picked : null);
  const piles = shown === null ? w.piles : w.piles.filter((p) => p.kind === shown);
  const itemStyle: ViewStyle = {
    paddingHorizontal: 12, paddingVertical: 11,
    ...(t.mail ? { flexDirection: "row", alignItems: "center", gap: 12 } : {}),
  };

  const [runId, setRunId] = useState<string | null>(null);
  const ids = w.piles.find((p) => p.kind === "replyLater")?.items.flatMap((item) => item.messageId ? [item.messageId] : []) ?? [];
  const run = useReplyRun(ids, { openId: runId, open: setRunId, write: () => undefined, close: () => setRunId(null) });
  const runState = run.state;
  useEffect(() => {
    if (runState === null) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => { runState.exit(); return true; });
    return () => sub.remove();
  }, [runState]);
  if (runState !== null) {
    return <MessageReader key={runState.at} id={runState.at} inPane={inPane} runReply={runState} onClose={runState.exit} />;
  }

  const page = (
    <Screen>
      {/* The page carries its own heading, so the bar carries only the way back. */}
      {inPane ? <PaneTop /> : t.mail ? <TopBar /> : <DetailBar /> }
      <Scroller bounded refresh={pull} head={
        <>
          {t.mail ? (
            <ViewHead title={only === null ? Copy.triage : pileTitle(only)}
              leading={inPane ? undefined : <MailCalendarSwitch />}
              right={shown === "replyLater" && run.canStart ? (
                <Button label={Copy.replyRunStart} icon="spark" variant="quiet" style={{ backgroundColor: t.c.tint2 }} onPress={run.start} />
              ) : null}
            />
          ) : (
            <View style={{ paddingHorizontal: 12, paddingTop: 4, paddingBottom: 16 }}>
              <Txt variant="h1">{only === null ? Copy.triage : pileTitle(only)}</Txt>
              {only === null ? (
                <Txt variant="meta" tone="ink3" tabular style={{ marginTop: 4 }}>{settled ? w.pilesMeta : " "}</Txt>
              ) : null}
            </View>
          )}
          {tabs && w.piles.length > 0 ? (
            <Segmented
              value={picked}
              onChange={setPicked}
              segments={w.piles.map((p) => ({
                value: p.kind, label: p.title, ...(settled ? { count: p.items.length } : {}),
              }))}
              style={{ marginHorizontal: 6, marginBottom: 12 }}
            />
          ) : null}
        </>
      }>
        {piles.map((p, pi) => (
          <View key={p.kind} style={{ marginBottom: 16 }}>
            {/*
              `.pile-stack::before/::after` — two sheets of paper under the top
              one, each narrower than the sheet above it and carrying the
              `sheetEdge` shadow (which points *upward*: light falls between
              sheets, not onto them). A pile that is literally a stack is the
              one place Blanc lets a surface be decorative, because the shape
              is the meaning.
            */}
            {!t.mail ? <View style={{ alignItems: "center" }}>
              <View
                style={[
                  {
                    height: 7,
                    width: "88%",
                    borderTopLeftRadius: t.radius.card,
                    borderTopRightRadius: t.radius.card,
                    backgroundColor: t.c.panel,
                  },
                  t.lift("sheetEdge"),
                ]}
              />
              <View
                style={[
                  {
                    height: 7,
                    width: "94%",
                    marginTop: -1,
                    borderTopLeftRadius: t.radius.card,
                    borderTopRightRadius: t.radius.card,
                    backgroundColor: t.c.panel,
                  },
                  t.lift("sheetEdge"),
                ]}
              />
            </View> : null}
            <PileRows flat={t.mail} radius={t.radius.card}>
              {t.mail ? null : <>
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 8,
                  paddingHorizontal: 18,
                  paddingTop: 16,
                  paddingBottom: 4,
                }}
              >
                <Icon name={PILE_ICON[p.kind]} size={14} color={t.c.accentInk} />
                <Txt variant="pileTitle">{p.title}</Txt>
                <View style={{ flex: 1 }} />
                {settled || p.items.length > 0 ? <Badge>{p.items.length}</Badge> : null}
              </View>
              <Txt variant="hint" tone="ink3" style={{ paddingHorizontal: 18 }}>
                {p.note}
              </Txt>
              </>}

              <View style={{ paddingHorizontal: 6, paddingTop: 8 }}>
                {p.items.length === 0 && !settled ? (
                  // The standing first-sync failure speaks ONCE, on the top pile — three
                  // repeats of one sentence down the stack would be noise about one fact.
                  <SkeletonList rows={2} stalled={pi === 0 ? w.boot.syncFailure : null} />
                ) : p.items.length === 0 ? (
                  <Txt variant="note" tone="ink3" style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
                    {Copy.pileEmpty}
                  </Txt>
                ) : (
                  p.items.map(({ id, messageId, memberIds, title, subtitle, preview, resurfaceAt, mailbox }) => {
                    const content = (
                      <>
                        {t.mail ? <MailAvatar person={{ name: title, address: title }} mailbox={mailbox} /> : null}
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}>
                            <Txt variant="rowSender" style={{ flexShrink: 1 }} numberOfLines={1}>
                              {title}
                            </Txt>
                            <View style={{ flex: 1 }} />
                            {resurfaceAt ? (
                              <Txt variant="caption" tone="accent" tabular>
                                {resurfaceAt}
                              </Txt>
                            ) : null}
                          </View>
                          {subtitle ? (
                            <Txt variant="rowSubjectSeen" tone="ink2" numberOfLines={1} style={{ marginTop: 2 }}>
                              {subtitle}
                            </Txt>
                          ) : null}
                          {preview ? (
                            <Txt variant="meta" tone="ink3" numberOfLines={1} style={{ marginTop: 1 }}>
                              {preview}
                            </Txt>
                          ) : null}
                        </View>
                      </>
                    );
                    return messageId ? (
                      <TapRow key={id} accessibilityRole="button"
                        accessibilityLabel={mailbox ? [title, subtitle, preview, resurfaceAt, Copy.deliveredTo(mailbox.name)].filter(Boolean).join(". ") : undefined}
                        style={itemStyle}
                        onPress={() => router.push(`/message/${messageId}${(memberIds?.length ?? 0) > 1 ? "?member=thread" : ""}`)}>
                        {content}
                      </TapRow>
                    ) : (
                      <View key={id} accessible style={itemStyle}>{content}</View>
                    );
                  })
                )}
              </View>
            </PileRows>
          </View>
        ))}
      </Scroller>
    </Screen>
  );
  return (
    <YieldToMore paneKey={inPane ? null : only === null ? "triage" : `triage:${only}`}>
      {t.mail && !inPane ? <MailPlaceDock>{page}</MailPlaceDock> : page}
    </YieldToMore>
  );
}

function PileRows({ flat, radius, children }: { flat?: boolean; radius: number; children: React.ReactNode }) {
  const style = { paddingBottom: 10, marginTop: -1 };
  return flat ? <View style={style}>{children}</View> : <Panel radius={radius} style={style}>{children}</Panel>;
}
