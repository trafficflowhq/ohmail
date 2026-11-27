/**
 * Screener — the consent gate, and the heart of the product.
 *
 * On the phone this is the list half only: three shelves (waiting, screened
 * out, spam) of senders. Tapping a sender opens their mail and full decision
 * controls. Paper phones can also choose a destination directly on a waiting
 * row. Advice appears only when the server sent a filing suggestion. The
 * shelf's rows go through `MailList`, which mounts a window of them.
 */
import { SCREENER_ACKNOWLEDGEMENTS } from "@ohmail/app-logic/consent/screener-acknowledgements";
import { screenerMode } from "@ohmail/app-logic/mail-state/mail-state";
import { postureRefusal, rulesPostureOf, screenerPressRefused } from "@ohmail/app-logic/press/rules-posture";
import { DECISION_ORDER, DECISION_QUIET } from "@ohmail/app-logic/screener/decision";
import { displayAddress, displayDomainLabel } from "@ohmail/app-logic/text/idn";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Copy } from "../../src/copy";
import { useTheme } from "../../src/theme";
import { destDone, destLabel, domainOf, screenerSegParam, type Destination, type ScreenerSeg } from "../../src/state/model";
import { usePullToSync } from "../../src/state/pull";
import { listSurface, metaWhen } from "../../src/state/surface";
import { relayMarkFor, type RelayMark } from "../../src/state/relay";
import { useWorld, type ScreenerRow, type World, type WorldScreener } from "../../src/state/world";
import { Badge, Button, Empty, Panel, Screen, Tail, Tap, TapRow, Txt, ViewHead } from "../../src/ui/base";
import { HeadingEnd } from "../../src/ui/HeadingEnd";
import { Icon } from "../../src/ui/Icon";
import { MailCalendarSwitch } from "../../src/ui/MailCalendarSwitch";
import { MailAvatar } from "../../src/ui/MailAvatar";
import { MailRowByline } from "../../src/ui/MailRowByline";
import { mailColors, mailSize } from "../../src/theme/mail";
import { TopBar } from "../../src/ui/chrome";
import { ListDetail, useListDetail } from "../../src/ui/list-detail";
import { MailList } from "../../src/ui/MailList";
import { MailListMenu } from "../../src/ui/MailListMenu";
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
import { usePosture } from "../../src/ui/posture";

type RowMenu = {
  world: string;
  key: string;
  mailboxId: ScreenerRow["mailboxId"];
  scope: ScreenerRow["scope"];
  unsubscribe?: { dest: "screened" | "spam"; ids: readonly string[]; senders: number; certain: boolean };
};
type RowChoice = {
  expanded: boolean;
  open: () => void;
  accept?: { label: string; press: () => void };
};

function acceptsDecisions(mailboxes: World["mailboxes"]): boolean {
  const facts = mailboxes.known ? mailboxes.rows.map((row) => ({
    ...row,
    status: row.status ?? undefined,
    organizerRole: row.organizerRole ?? undefined,
    organizedBy: row.organizedBy ? { ...row.organizedBy, since: null } : null,
  })) : null;
  return !screenerPressRefused({ ...screenerMode(facts), pressRefusal: postureRefusal(rulesPostureOf(facts)) });
}

/** A newer letter from the same sender may stand in for the opening row in the same mailbox and scope. */
function matchingRow(world: World, target: RowMenu | null): ScreenerRow | undefined {
  if (target?.world !== world.worldKey) return;
  return world.screener.waiting.find((row) =>
    row.routeKey === target.key && row.mailboxId === target.mailboxId && row.scope === target.scope);
}

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
  const locale = useLocale();
  const w = useWorld();
  const t = useTheme();
  const { sizeClass } = usePosture();
  const compactPaper = t.mail === true && sizeClass === "compact";
  /* The live session the impersonation line reads through; none, no line. */
  const conn = useConnection();
  const session = conn.state.k === "live" ? conn.state.session : null;
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
    ? { title: say.title, hint: say.hint, action: { label: say.press,
      onPress: () => router.push({ pathname: "/settings", params: { pane: "mailboxes" } }) } }
    : t.mail ? { title: Copy.mailEmptyTitle } : emptyFor(seg);
  const { waiting, screened, spam, meta, waitingPending } = w.screener;
  const [suggestedOnly, setSuggestedOnly] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [rowMenu, setRowMenu] = useState<RowMenu | null>(null);
  useEffect(() => setRowMenu(null), [seg, w.worldKey]);
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
  const segmentCount = (count: number, settled: boolean) => settled && (count > 0 || !compactPaper) ? count : undefined;
  const allowed = useMemo(() => acceptsDecisions(w.mailboxes), [w.mailboxes]);
  const canChoose = compactPaper && seg === "waiting" && allowed && !firstPass && !waitingPending;
  const menuRow = canChoose ? matchingRow(w, rowMenu) : undefined;
  useEffect(() => {
    if (rowMenu !== null && menuRow === undefined) setRowMenu(null);
  }, [rowMenu, menuRow]);
  const currentChoice = useRef({ canChoose, rowMenu });
  currentChoice.current = { canChoose, rowMenu };
  const availableRow = (target: RowMenu | null) =>
    currentChoice.current.canChoose ? matchingRow(latest.current, target) : undefined;
  const currentMenuRow = () => currentChoice.current.rowMenu === rowMenu ? availableRow(rowMenu) : undefined;
  const unsubscribe = menuRow ? rowMenu?.unsubscribe : undefined;
  const claim = menuRow ? w.actions.unsubClaimOf(menuRow, waiting) : "none";
  const unsubscribeLabel = (dest: "screened" | "spam") =>
    dest === "spam" ? Copy.screenChooseUnsubSpam : Copy.screenChooseUnsubScreened;
  const unsubscribeTitle = unsubscribe ? unsubscribeLabel(unsubscribe.dest) : undefined;
  const flavor = session?.profile.flavor;
  const unsubscribeFrom = flavor === "managed" || flavor === "selfhost" ? Copy.screenChooseUnsubService
    : (flavor === "desktop-host" || flavor === "local") && !session?.standalone ? Copy.screenChooseUnsubComputer : null;
  const pickDestination = (target: RowMenu, dest: Destination, source: "menu" | "suggestion" | "confirmed") => {
    const live = latest.current;
    const row = source === "suggestion" ? availableRow(target) : currentMenuRow();
    if (!row || (source === "suggestion" && row.ai?.dest !== dest)) return;
    const peers = live.screener.waiting;
    const ids = DECISION_QUIET.has(dest) ? live.actions.unsubscribeIdsOf(row, peers) : [];
    if (dest === "screened" || dest === "spam") {
      const kind = dest === "spam" ? "spamUnsubscribe" : "screenOutUnsubscribe";
      if (source === "confirmed") {
        const asked = target.unsubscribe;
        if (asked?.dest !== dest) return;
        const granted = ids.filter((id) => asked.ids.includes(id));
        setRowMenu(null);
        live.screenerConfirmation?.remember(kind);
        live.actions.decide(row, dest, false, peers, granted);
        return;
      }
      const accepted = ((live.screenerConfirmation?.acknowledged ?? 0) & SCREENER_ACKNOWLEDGEMENTS[kind]) !== 0;
      // The warning is a question about the filing, even when the mirror cannot grant a request.
      const claimAtPress = live.actions.unsubClaimOf(row, peers);
      if (claimAtPress !== "none" && !accepted) {
        const certain = claimAtPress === "sends";
        const domain = domainOf(row.routeKey).toLowerCase();
        const senders = row.scope === "domain"
          ? peers.filter((peer) => domainOf(peer.routeKey).toLowerCase() === domain).length
          : 1;
        setRowMenu({ ...target, unsubscribe: { dest, ids, senders, certain } });
        return;
      }
    }
    setRowMenu(null);
    live.actions.decide(row, dest, false, peers, ids);
  };
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
      const target = { world: w.worldKey, key: row.routeKey, mailboxId: row.mailboxId, scope: row.scope };
      const destination = row.ai?.dest;
      const accept = destination === undefined ? undefined : {
        label: (destination === "screened" || destination === "spam") && w.actions.unsubClaimOf(row, waiting) !== "none"
          ? unsubscribeLabel(destination)
          : destLabel(destination),
        press: () => pickDestination(target, destination, "suggestion"),
      };
      return (
        <View>
          <WaitingRow row={row} mark={mark} compact={compactPaper} onPress={() => openRow(row.routeKey)}
            choose={canChoose ? {
              expanded: menuRow?.routeKey === row.routeKey,
              open: () => { if (availableRow(target)) setRowMenu(target); },
              accept,
            } : undefined} />
          {row.ai && !compactPaper ? (
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
    return (
      <ScreenerCard
        row={row}
        seen
        compact={compactPaper}
        accessibilityLabel={Copy.senderRowAria(row.name, row.address, row.held.length, row.detection)}
        onPress={() => openRow(row.routeKey)}
      >
        {seg === "spam" && row.detection ? <Badge icon="shield">{row.detection}</Badge> : null}
      </ScreenerCard>
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
        fitSurface={compactPaper}
        refresh={pull}
        head={
          <>
            <ViewHead style={{ paddingTop: 8, paddingBottom: 14 }} title={Copy.screener} attention={waiting.length > 0}
              leading={t.mail && !compactPaper ? <MailCalendarSwitch /> : undefined} meta={t.mail ? undefined : metaWhen(surface, meta) ?? " "} />

            <Segmented
              style={{ marginHorizontal: 10, marginBottom: 14 }}
              value={seg}
              onChange={(v) => {
                // A routeKey is a fact only on its own shelf — a selection never crosses one.
                if (open !== null) close();
                setRowMenu(null);
                setSeg(v);
              }}
              segments={[
                // Counts speak only over a settled mirror — a "0" badge beside a shelf that is
                // still rendering its skeleton would be an invented count (`state/surface.ts`).
                { value: "waiting", label: Copy.segWaiting, count: segmentCount(waiting.length, w.boot.settled && !firstPass && !waitingPending) },
                { value: "screened", label: Copy.segScreened, count: segmentCount(screened.length, w.boot.settled) },
                { value: "spam", label: Copy.segSpam, count: segmentCount(spam.length, w.boot.settled) },
              ]}
            />
            {seg === "waiting" ? <FailedLetters letters={w.screener.failedAtGate} onFile={w.actions.fileFailed} /> : null}
            {/* What ohmail filed to Spam for claiming a company: one line, Review, Put back and OK. */}
            {seg === "waiting" && session !== null ? <ImpersonationNotice session={session} spamMark={spamMark} /> : null}
          </>
        }
        sheetHead={
          <>
            {seg === "waiting" && t.mail ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
                {suggested > 0 || suggestedOnly ? (
                  <Button label={`${suggestedOnly ? Copy.screenSuggestions : Copy.searchAll} ▾`}
                    variant="quiet" style={{ backgroundColor: t.c.tint2 }}
                    onPress={() => setFilterOpen(true)} />
                ) : (
                  <View style={{ flexDirection: "row", gap: mailSize.rowInset, alignItems: "baseline" }}>
                    <Txt variant="sectionLabel">
                      {compactPaper && w.boot.settled && waiting.length > 0 && !firstPass && !waitingPending
                        ? <HeadingEnd variant="sectionLabel" hot>{Copy.searchAll}</HeadingEnd> : Copy.searchAll}
                    </Txt>
                    {w.boot.settled && !firstPass ? <Txt variant="railCount" tone="ink2">{String(waiting.length)}</Txt> : null}
                  </View>
                )}
                <View style={{ flex: 1 }} />
                {suggested > 0 ? <Button label={Copy.screenApplyShort(suggested)} accessibilityLabel={Copy.screenApplySuggestions(suggested)}
                  variant="solid" onPress={() => startApply()} /> : null}
                <MailListMenu />
              </View>
            ) : seg === "waiting" && suggested > 0 ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingBottom: 12 }}>
                <Button label={suggestedOnly ? Copy.searchAll : Copy.screenSuggestions}
                  variant="quiet" onPress={() => setSuggestedOnly(!suggestedOnly)} />
                <Button label={Copy.screenApplySuggestions(suggested)} onPress={() => startApply()} />
              </View>
            ) : null}
          </>
        }
        empty={shelfEmpty}
        foot={
          rows.length > 0 && seg === "screened" ? <Tail>{Copy.screenerNothingDeleted}</Tail>
          : rows.length > 0 && seg === "spam" ? <Tail>{Copy.spamNote}</Tail>
          : null
        }
      />
      <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} label={Copy.searchAll} phoneMenu={t.mail === true}>
        <SheetRow label={Copy.searchAll} on={!suggestedOnly} onPress={() => { setSuggestedOnly(false); setFilterOpen(false); }} />
        <SheetRow label={Copy.screenSuggestions} on={suggestedOnly} onPress={() => { setSuggestedOnly(true); setFilterOpen(false); }} />
      </Sheet>
      <Sheet open={menuRow !== undefined} onClose={() => setRowMenu(null)} phoneMenu
        label={unsubscribeTitle ?? Copy.screenChoosePlace}
        confirmation={rowMenu && unsubscribe && unsubscribeTitle ? {
          note: Copy.screenChooseUnsubFinal,
          action: {
            label: unsubscribe.certain ? unsubscribeTitle : Copy.screenChooseUnsubContinue,
            onPress: () => pickDestination(rowMenu, unsubscribe.dest, "confirmed"),
          },
        } : undefined}>
        {menuRow && unsubscribe && unsubscribeTitle ? (
          <>
            <Txt variant="body">
              {menuRow.scope === "domain"
                ? Copy.screenChooseUnsubDomain(unsubscribeTitle, displayDomainLabel(menuRow.address), unsubscribe.senders, unsubscribe.certain)
                : Copy.screenChooseUnsubSender(unsubscribeTitle, displayAddress(menuRow.address), unsubscribe.certain)}
            </Txt>
            {unsubscribeFrom ? <Txt variant="body">{unsubscribeFrom}</Txt> : null}
          </>
        ) : rowMenu && menuRow ? (
          <>
            {DECISION_ORDER.map((dest) => {
              const note = [
                menuRow.ai?.dest === dest ? Copy.screenPlaceSuggested(
                  new Intl.NumberFormat(locale, { style: "percent" }).format(menuRow.ai.confidence),
                ) : null,
                claim !== "none" && DECISION_QUIET.has(dest) ? Copy.screenPlusUnsubscribe : null,
              ].filter(Boolean).join(" · ");
              return <SheetRow key={dest} label={destLabel(dest)} detail={note || undefined}
                onPress={() => pickDestination(rowMenu, dest, "menu")} />;
            })}
            <SheetRow label={Copy.actionScreening} onPress={() => {
              const row = currentMenuRow();
              if (!row) return;
              setRowMenu(null);
              openRow(row.routeKey);
            }} />
          </>
        ) : null}
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

function WaitingRow({ row, mark, compact, choose, onPress }: {
  row: ScreenerRow; mark: RelayMark | null; compact: boolean; choose?: RowChoice; onPress: () => void;
}) {
  const t = useTheme();
  // THE IDENTITY FACT, drawn and spoken on the row as on the web's, not only once the row is opened.
  const claim = row.checked ? Copy.senderCheckChip(row.checked.brand) : null;
  const aria = Copy.senderRowAria(row.name, row.address, row.held.length, claim ?? "");
  return (
    <ScreenerCard row={row} seen={row.dull} compact={compact} choose={choose} onPress={onPress}
      accessibilityLabel={mark ? `${aria} ${mark.text}` : aria}
      suggestion={t.mail === true && row.ai !== null}
    >
      {claim ? <Badge icon="shield">{claim}</Badge> : null}
      {row.ai && !t.mail ? (
        <Badge icon="spark" tone="accent">
          {Copy.aiSuggests(destDone(row.ai.dest), row.ai.confidence)}
        </Badge>
      ) : null}
      {mark ? (
        <Txt variant="caption" tone={mark.kind === "refused" ? "ink" : "ink3"}>
          {mark.text}
        </Txt>
      ) : null}
    </ScreenerCard>
  );
}

function ScreenerCard({ row, seen, compact, choose, onPress, accessibilityLabel, suggestion, children }: {
  row: ScreenerRow;
  seen: boolean;
  compact: boolean;
  choose?: RowChoice;
  onPress: () => void;
  accessibilityLabel: string;
  suggestion?: boolean;
  children?: ReactNode;
}) {
  const t = useTheme();
  const [choiceWidth, setChoiceWidth] = useState(0);
  const preview = row.newestPreview ?? row.held.at(-1)?.body.slice(0, 160).trim().replace(/\s+/g, " ");
  const label = [accessibilityLabel, row.newestSubject, row.time,
    row.mailboxLabel ? Copy.deliveredTo(row.mailboxLabel) : undefined].filter(Boolean).join(". ");
  const address = compact ? displayAddress(row.address) : row.address;
  const name = compact && row.name === row.address ? address : row.name;
  // Native accepts hex alpha for Paper's eight-percent slot tint.
  const pick = { backgroundColor: `${mailColors(t).ink}14`, borderRadius: 6, minHeight: 22, justifyContent: "center" as const };
  return (
    <View>
      <TapRow
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={{
          paddingHorizontal: mailSize.edge - mailSize.rowInset,
          paddingVertical: mailSize.inset,
          minHeight: mailSize.row,
          flexDirection: "row",
          alignItems: "center",
          gap: mailSize.inset,
        }}
      >
        <MailAvatar person={{ name, address: row.address }} unread={!seen} mailbox={compact ? undefined : row.mailbox} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <MailRowByline name={name} address={address} time={row.time} seen={seen}
            keepAddress={compact} mailbox={compact ? undefined : row.mailboxLabel}>
            {row.held.length > 1 ? <Badge>{Copy.screenHeldShort(row.held.length)}</Badge> : null}
          </MailRowByline>
          {row.newestSubject ? (
            <Txt variant={seen ? "rowSubjectSeen" : "rowSubject"} tone={seen ? "ink2" : "ink"} numberOfLines={1}>
              {row.newestSubject}
            </Txt>
          ) : null}
          <View style={{ paddingRight: choose ? Math.max(75, choiceWidth + 4) : suggestion ? "36%" : undefined, minHeight: choose ? 22 : undefined }}>
            {preview ? <Txt variant="body" tone="ink2" numberOfLines={1}>{preview}</Txt> : null}
            <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: mailSize.inset }}>
              {children}
            </View>
          </View>
        </View>
      </TapRow>
      {choose ? (
        <View onLayout={({ nativeEvent }) => setChoiceWidth(nativeEvent.layout.width)}
          style={{ position: "absolute", right: mailSize.edge - mailSize.rowInset, bottom: mailSize.inset,
            flexDirection: "row", alignItems: "center", gap: 1, maxWidth: "45%" }}>
          {choose.accept && row.ai ? (
            <Tap accessibilityRole="button" accessibilityLabel={choose.accept.label}
              onPress={choose.accept.press} style={{ ...pick, flexShrink: 1, paddingHorizontal: 6,
                flexDirection: "row", alignItems: "center", gap: 6, borderTopRightRadius: 0, borderBottomRightRadius: 0 }}>
              <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.c.accent }} />
              <Txt variant="button" numberOfLines={1} style={{ flexShrink: 1 }}>{destLabel(row.ai.dest)}</Txt>
            </Tap>
          ) : null}
          <Tap accessibilityRole="button" accessibilityLabel={Copy.screenChoosePlace} accessibilityState={{ expanded: choose.expanded }}
            hitSlop={5} onPress={choose.open}
            style={{ ...pick, flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6,
              ...(choose.accept ? { borderTopLeftRadius: 0, borderBottomLeftRadius: 0 } : {}) }}>
            {choose.accept ? null : <Txt variant="button" tone="ink2">{Copy.screenChoose}</Txt>}
            <View style={{ transform: [{ rotate: "90deg" }] }}><Icon name="chev" size={10} color={t.c.ink2} /></View>
          </Tap>
        </View>
      ) : null}
    </View>
  );
}
