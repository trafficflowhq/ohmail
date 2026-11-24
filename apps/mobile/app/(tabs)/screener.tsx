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
import { SCREENER_ACKNOWLEDGEMENTS } from "@ohmail/app-logic/consent/screener-acknowledgements";
import { useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { Copy } from "../../src/copy";
import { useTheme } from "../../src/theme";
import { destDone, screenerSegParam, type ScreenerSeg } from "../../src/state/model";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { relayMarkFor, type RelayMark } from "../../src/state/relay";
import { useEngineQueuesAsk, useWorld, type ScreenerRow, type WorldScreener } from "../../src/state/world";
import { Badge, Button, Empty, Panel, Screen, Tail, Tap, TapRow, Txt, ViewHead } from "../../src/ui/base";
import { Icon } from "../../src/ui/Icon";
import { MailCalendarSwitch } from "../../src/ui/MailCalendarSwitch";
import { MailAvatar } from "../../src/ui/MailAvatar";
import { mailSize } from "../../src/theme/mail";
import { TopBar } from "../../src/ui/chrome";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { MailList } from "../../src/ui/MailList";
import { SenderDetail } from "../../src/ui/SenderDetail";
import { Segmented } from "../../src/ui/Segmented";
import { SkeletonList } from "../../src/ui/Skeleton";
import { useLocale } from "../../src/i18n/LocaleProvider";
import { SurfaceBoundary } from "../../src/ui/ErrorBoundary";
import { noneOrganizedWhy, notOrganizingSay } from "../../src/ui/not-organizing";
import { firstPassWithholds } from "../../src/state/seed-offer";
import { standaloneHereFor } from "../../src/engine/organizer-session";
import { useConnection } from "../../src/net/connection";
import { ImpersonationNotice } from "../../src/ui/ImpersonationNotice";
import { Sheet, SheetRow } from "../../src/ui/Sheet";
import { applySuggestions, planSuggestions, type SuggestedDecision } from "../../src/ui/screener-batch";
import { spamLettersMark } from "../../src/ui/impersonation-notice";

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
  const t = useTheme();
  /* The live session the impersonation line reads through; none, no line. */
  const conn = useConnection();
  const session = conn.state.k === "live" ? conn.state.session : null;
  // The waiting queue's first page is the engine's; it is asked when this screen is shown.
  useFocusEffect(useEngineQueuesAsk());
  const pull = usePullToSync();
  /* The shelf can arrive as a param: the pushed sender route migrates here when the window
     gains a second pane, naming the shelf its selection belongs to. */
  const params = useLocalSearchParams<{ seg?: string }>();
  const asked = screenerSegParam(params.seg);
  const [seg, setSeg] = useState<ScreenerSeg>(asked ?? "waiting");
  /* …and while mounted: the Ohbox's where-line links to a shelf by the same param. */
  useEffect(() => {
    if (asked !== null) setSeg(asked);
  }, [asked]);
  /* Two panes: a sender row SELECTS and the decision view opens beside the shelves (the
     prototype's reading slot); one pane: it pushes, as ever. */
  const { open, openRow, close } = useListDetail(
    (key) => `/sender/${seg}/${encodeURIComponent(key)}`,
  );
  /* "First-time senders knock here" is false where nothing organizes any mailbox: the waiting shelf says that
     instead, once the mailbox read has answered (`known`), never on a guess. */
  const notYet = seg === "waiting" && w.mailboxes.known ? noneOrganizedWhy(w.mailboxes.rows) : null;
  /* The Ohbox's knock slot says the same sentence (`notOrganizingSay`), so the two cannot differ. */
  const say = notYet === null ? null : notOrganizingSay(notYet);
  const empty = say !== null
    ? { title: say.title, hint: say.hint, action: { label: say.press, onPress: () => router.push("/settings") } }
    : t.mail ? { title: Copy.mailEmptyTitle } : emptyFor(seg);
  const { waiting, screened, spam, meta, waitingPending } = w.screener;
  const [suggestedOnly, setSuggestedOnly] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<{ worldKey: string; plan: SuggestedDecision[] } | null>(null);
  const latest = useRef(w);
  latest.current = w;
  const applying = useRef(false);
  const unsubscribeRequests = (plan: SuggestedDecision[]) =>
    new Set(plan.flatMap((item) => item.unsubscribe)).size;
  const startApply = (only?: string) => {
    const plan = planSuggestions(waiting, w.actions.unsubscribeIdsOf).filter((item) => only === undefined || item.row.routeKey === only);
    if (!plan.length || applying.current) return;
    const draft = { worldKey: w.worldKey, plan };
    if (unsubscribeRequests(plan) > 0 &&
        ((w.screenerConfirmation?.acknowledged ?? 0) & SCREENER_ACKNOWLEDGEMENTS.applySuggestions)) {
      void applyPlan(draft);
    } else {
      setConfirmation(draft);
    }
  };
  const applyPlan = async (draft: NonNullable<typeof confirmation>) => {
    if (applying.current || latest.current.worldKey !== draft.worldKey) return;
    applying.current = true;
    setConfirmation(null);
    try {
      await applySuggestions(
        draft.plan,
        () => latest.current.worldKey === draft.worldKey ? latest.current.screener.waiting : [],
        (...args) => latest.current.actions.decide(...args),
      );
    } finally {
      applying.current = false;
    }
  };
  const requests = confirmation ? unsubscribeRequests(confirmation.plan) : 0;
  const confirmApply = () => {
    if (confirmation === null || applying.current || latest.current.worldKey !== confirmation.worldKey) return;
    if (requests > 0) w.screenerConfirmation?.remember("applySuggestions");
    void applyPlan(confirmation);
  };
  const suggested = planSuggestions(waiting, w.actions.unsubscribeIdsOf).length;
  // What the Spam count follows: a filing moves it, and the impersonation line asks again.
  const spamMark = useMemo(() => spamLettersMark(spam), [spam]);
  // Unknown ≠ empty, per SEGMENT: the active shelf's own count against the one settled fact.
  const shelves: Record<ScreenerSeg, ScreenerRow[]> = { waiting, screened, spam };
  // "Nobody is waiting" over a first import the gate has not judged yet is a claim nobody made.
  const firstPass = firstPassWithholds(waiting.length, w.mailboxes, Date.now(), standaloneHereFor(w));
  const rows = seg === "waiting" && suggestedOnly ? waiting.filter((row) => row.ai !== null) : shelves[seg];
  /* …and the WAITING shelf has a second way of being unknown over a settled mirror: this phone
     derived it, and the account's cutline answer has not landed, so it was withheld rather than
     guessed wide (`state/live.ts#WorldScreener.waitingPending`). Only that shelf — the other two
     are decided by rules the answer has no say in. */
  const surface = listSurface({
    settled: w.boot.settled,
    count: rows.length,
    pending: seg === "waiting" && (waitingPending || firstPass),
  });
  const shelfEmpty = surface === "empty" ? (
    <Empty {...empty} />
  ) : (
    <SkeletonList
      kind="screener"
      {...(surface === "pending" ? { note: firstPass ? Copy.waitingFirstPass : Copy.cutlinePending } : { stalled: w.boot.syncFailure })}
    />
  );

  const renderRow = (row: ScreenerRow) => {
    if (seg === "waiting") {
      const mark = relayMarkFor(row.address, w.screener.relayed, w.mailboxes.organizer?.name ?? null);
      return (
        <View>
          <WaitingRow row={row} mark={mark} onPress={() => openRow(row.routeKey)} />
          {row.ai ? (
            <Tap
              accessibilityRole="button" onPress={() => startApply(row.routeKey)}
              accessibilityLabel={Copy.screeningResolveGo(destDone(row.ai.dest))}
              style={t.mail ? {
                position: "absolute", right: 12, bottom: 10, maxWidth: "36%",
                backgroundColor: t.c.tint2, borderRadius: t.radius.pill, paddingHorizontal: 10, paddingVertical: 4,
              } : { alignSelf: "flex-end", paddingHorizontal: 16, paddingBottom: 8, minHeight: 32 }}
            >
              <Txt variant="caption" tone="accent">{t.mail ? `• ${destDone(row.ai.dest)}` : Copy.screeningResolveGo(destDone(row.ai.dest))}</Txt>
            </Tap>
          ) : null}
        </View>
      );
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
            <ViewHead style={{ paddingTop: 8, paddingBottom: 14 }} title={Copy.screener} attention={waiting.length > 0}
              leading={t.mail ? <MailCalendarSwitch /> : undefined} meta={t.mail ? undefined : metaWhen(surface, meta) ?? " "} />

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
                { value: "waiting", label: Copy.segWaiting, ...(w.boot.settled && !firstPass ? { count: waiting.length } : {}) },
                { value: "screened", label: Copy.segScreened, ...(w.boot.settled ? { count: screened.length } : {}) },
                { value: "spam", label: Copy.segSpam, ...(w.boot.settled ? { count: spam.length } : {}) },
              ]}
            />
            {seg === "waiting" && t.mail ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
                <Button label={`${suggestedOnly ? Copy.screenSuggestions : Copy.searchAll} ▾`}
                  variant="quiet" style={{ backgroundColor: t.c.tint2 }}
                  onPress={() => setFilterOpen(true)} />
                <View style={{ flex: 1 }} />
                <Button label={Copy.screenApplyShort(suggested)} accessibilityLabel={Copy.screenApplySuggestions(suggested)}
                  disabled={suggested === 0} variant="solid" onPress={() => startApply()} />
                <Tap accessibilityRole="button" accessibilityLabel={Copy.actionMore} onPress={() => setFilterOpen(true)}
                  style={{ padding: 8 }}><Txt variant="button">⋯</Txt></Tap>
              </View>
            ) : seg === "waiting" && suggested > 0 ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
                <Button label={suggestedOnly ? Copy.searchAll : Copy.screenSuggestions}
                  variant="quiet" onPress={() => setSuggestedOnly(!suggestedOnly)} />
                <Button label={Copy.screenApplySuggestions(suggested)} onPress={() => startApply()} />
              </View>
            ) : null}
            {seg === "waiting" ? <FailedLetters letters={w.screener.failedAtGate} onFile={w.actions.fileFailed} /> : null}
            {/* What ohmail filed to Spam for claiming a company: one line, Review, Put back and OK. */}
            {seg === "waiting" && session !== null ? <ImpersonationNotice session={session} spamMark={spamMark} /> : null}
          </>
        }
        empty={shelfEmpty}
        foot={
          rows.length > 0 && seg === "screened" ? <Tail>{Copy.screenerNothingDeleted}</Tail>
          : rows.length > 0 && seg === "spam" ? <Tail>{Copy.spamNote}</Tail>
          : null
        }
      />
      <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} label={Copy.searchAll}>
        <SheetRow label={Copy.searchAll} on={!suggestedOnly} onPress={() => { setSuggestedOnly(false); setFilterOpen(false); }} />
        <SheetRow label={Copy.screenSuggestions} on={suggestedOnly} onPress={() => { setSuggestedOnly(true); setFilterOpen(false); }} />
      </Sheet>
      <Sheet open={confirmation !== null && confirmation.worldKey === w.worldKey} onClose={() => setConfirmation(null)}
        label={Copy.screenApplySuggestions(confirmation?.plan.length ?? 0)}>
        {requests > 0 ? <Txt variant="body" tone="ink2" style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
          {Copy.screenBulkUnsubscribe(requests)}
        </Txt> : null}
        <SheetRow label={Copy.screenApplySuggestions(confirmation?.plan.length ?? 0)} onPress={confirmApply} />
      </Sheet>
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

/**
 * HELD LETTERS THEIR PROVIDER FAILED, WITH NO WAITING ROW (the web's header block): each said with the
 * check that failed and decided alone — Spam, or the Ohbox as the person's own placement.
 */
function FailedLetters({ letters, onFile }: {
  letters: WorldScreener["failedAtGate"]; onFile: (id: string, to: "spam" | "ohbox") => void;
}) {
  const t = useTheme();
  if (letters.length === 0) return null;
  return (
    <View accessibilityRole="summary" accessibilityLabel={Copy.failedAria}>
      <Panel style={{ marginHorizontal: 6, marginBottom: 12, padding: 14, gap: 14 }}>
        {letters.map((f) => (
          <View key={f.id} style={{ gap: 6 }}>
            <Txt variant="caption" tone="ink3" numberOfLines={1}>{f.from.address}</Txt>
            <Txt variant="rowSubject" numberOfLines={2}>{f.subject}</Txt>
            <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
              <View style={{ marginTop: 2 }}>
                <Icon name="shield" size={13} color={t.c.accentInk} />
              </View>
              <Txt variant="note" tone="ink" style={{ flex: 1 }}>{Copy.senderCheckFailed(f.from.address)}</Txt>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button label={f.own ? Copy.failedNotFromYou : Copy.failedNotFromThem} onPress={() => onFile(f.id, "spam")} />
              <Button label={f.own ? Copy.failedFromYou : Copy.failedFromThem} variant="quiet" onPress={() => onFile(f.id, "ohbox")} />
            </View>
          </View>
        ))}
      </Panel>
    </View>
  );
}

function WaitingRow({ row, mark, onPress }: { row: ScreenerRow; mark: RelayMark | null; onPress: () => void }) {
  const t = useTheme();
  // THE IDENTITY FACT, drawn and spoken on the row as on the web's, not only once the row is opened.
  const claim = row.checked ? Copy.senderCheckChip(row.checked.brand) : null;
  const aria = Copy.senderRowAria(row.name, row.address, row.held.length, claim ?? "");
  return (
    <TapRow
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={mark ? `${aria} ${mark.text}` : aria}
      style={{
        paddingHorizontal: mailSize.edge - mailSize.rowInset,
        paddingVertical: mailSize.inset,
        minHeight: mailSize.row,
        flexDirection: "row",
        alignItems: "center",
        gap: mailSize.inset,
      }}
    >
      <MailAvatar person={{ name: row.name, address: row.address }} unread />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: mailSize.inset }}>
          <Txt
            variant={row.dull ? "rowSenderSeen" : "rowSender"}
            tone={row.dull ? "ink2" : "ink"}
            numberOfLines={1}
            style={{ flexShrink: 0, maxWidth: "55%" }}
          >
            {row.name}
          </Txt>
          {row.held.length > 1 ? <Badge>{t.mail ? Copy.screenHeldShort(row.held.length) : Copy.heldCaption(row.held.length)}</Badge> : (
            <Txt variant="caption" tone="ink2" numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}>
              {row.address}
            </Txt>
          )}
          <View style={{ flex: 1 }} />
          <Txt variant="caption" tone="ink2" tabular>{row.time}</Txt>
        </View>
        <Txt variant={row.dull ? "rowSubjectSeen" : "rowSubject"} tone={row.dull ? "ink2" : "ink"} numberOfLines={1}>
          {row.newestSubject}
        </Txt>
        <View style={{ flexDirection: "row", alignItems: "center", gap: mailSize.inset, paddingRight: t.mail && row.ai ? 90 : 0 }}>
          <Txt variant="body" tone="ink2" numberOfLines={1} style={{ flex: 1 }}>
            {row.held.at(-1)?.body.slice(0, 160).trim().replace(/\s+/g, " ")}
          </Txt>
          {claim ? <Badge icon="shield">{claim}</Badge> : null}
          {row.ai && !t.mail ? (
            <Badge icon="spark" tone="accent">
              {Copy.aiSuggests(destDone(row.ai.dest), row.ai.confidence)}
            </Badge>
          ) : null}
        </View>
        {/* THE DECISION THIS PHONE SENT, until the organizer answers it (`state/relay.ts`). */}
        {mark ? (
          <Txt variant="caption" tone={mark.kind === "refused" ? "ink" : "ink3"} style={{ marginTop: 6 }}>
            {mark.text}
          </Txt>
        ) : null}
      </View>
    </TapRow>
  );
}
