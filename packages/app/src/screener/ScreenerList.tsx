/**
 * THE SCREENER'S LIST: its head with the three sections, the rows, what an empty section says, and Show more senders.
 * It reads the one model from `ScreenerAbove` and never makes one; its keys stand while it has them, and the
 * keyboard's zones are declared here: the arrows walk the senders as `j` and `k` do, and the list has no reading zone
 * (a sender is decided, not read). On one column the open sender stands over the list.
 */
import { useSwitchEnded } from "@ohmail/app-logic/session/ui-vitals";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { quarantineShelf, shelfRowMatches } from "@ohmail/app-logic/press/quarantine-shelf";
import { GroupHeading, Sheet } from "@ohmail/ui/mail";
import { useOptionalKeyBindings } from "@ohmail/app-logic/keys";
import { useZoneNav } from "@ohmail/app-logic/keys/zone-nav";
import {
  emptyOf,
  screenerListSteps,
  useJunkView,
  useScreenerView,
  PILE_VERB_KEY,
  viewSender,
  type ScreenerState,
  type ScreenerView,
} from "@ohmail/app-logic/screener";
import { useEntered, useFrame, useSelectionBar } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import { useCursorRowInView } from "../place-list/ListColumn.js";
import {
  segmentOf,
  useScreener,
  useScreenerAbove,
  useScreenerBeside,
  type ScreenerSegment,
} from "./contract.js";
import { BulkDecision } from "./asks/BulkDecision.js";
import { Unsubscribe } from "./asks/Unsubscribe.js";
import { Empty } from "./list/Empty.js";
import { Head } from "./list/Head.js";
import { Junk } from "./list/Junk.js";
import { QuarantineMove } from "./list/QuarantineMove.js";
import { Notices } from "./list/Notices.js";
import { Rows } from "./list/Rows.js";
import { Tail } from "./list/Tail.js";
import { Tools } from "./list/Tools.js";
import { PullScroll } from "../touch/index.js";
import { JunkLetter } from "./held/JunkLetter.js";
import type { ScreenerJunkItem } from "./ports.js";
import { Failed } from "./sender/Failed.js";
import { keptVerbs } from "./sender/Kept.js";
import { Sender, type SenderWindow } from "./sender/Sender.js";
import { useText, type Text } from "../text/index.js";
import { useKeyWords } from "./words.js";
import "./screener.css";

import { SelectionFoot } from "../place-list/SelectionFoot.js";
import { useRowContact } from "../place-list/use-row-contact.js";
import { useRowSelection } from "../place-list/use-row-selection.js";

const PICK_DECISIONS = [
  { id: "ohbox", icon: "ohbox" },
  { id: "reads", icon: "news" },
  { id: "receipts", icon: "receipts" },
  { id: "screened", icon: "screenout" },
] as const;

const NO_SPAM: ScreenerState["spam"] = [];
const NO_JUNK: readonly ScreenerJunkItem[] = [];
const NO_BODY = (): void => undefined;

/** Where the list stands: leaving the place or the section commits what waits in the undo window, at once. */
export function useStanding(place: string, sub: string | null): void {
  const { standing } = useScreenerAbove();
  const where = `${place}/${segmentOf(sub)}`;
  useEffect(() => {
    standing(where);
  }, [standing, where]);
  useEffect(() => () => standing(null), [standing]);
}

function useScreenerList({ route, plan, keysHere }: PaneProps) {
  const model = useScreener();
  const beside = useScreenerBeside();
  const above = useScreenerAbove();
  const { commands } = useFrame();
  const words = useKeyWords();
  const t = useText("screener");
  const phoneWindow = useRef<SenderWindow | null>(null);
  const listScroller = useRef<HTMLDivElement>(null);
  const [shelfPicked, setShelfPicked] = useState(false);
  const segment = segmentOf(route.sub);
  useStanding(route.place, route.sub);
  const go = useCallback(
    (to: ScreenerSegment) => commands.go({ place: "screener", sub: to === "waiting" ? null : to }),
    [commands],
  );
  const select = useCallback((id: string | null) => above.select(segment, id), [above, segment]);
  const selectJunk = useCallback((key: string | null) => above.select("junk", key), [above]);
  const oneColumn = plan.columns === 1;
  const senderOpen = route.words.sender === "open";
  const setSenderOpen = useCallback(
    (open: boolean) => {
      if (open === senderOpen) return;
      commands.go(
        { place: "screener", sub: route.sub, words: open ? { sender: "open" } : {} },
        open ? { history: "preview" } : { history: "dismiss-preview", replace: true },
      );
    },
    [commands, route.sub, senderOpen],
  );
  const { junk } = beside;
  const junkOn = segment === "spam" && junk !== NONE;
  const spam = useMemo(() => {
    if (!junkOn || !junk.held) return NO_SPAM;
    return quarantineShelf(model.spam, junk.held.ids).filter((row) =>
      shelfRowMatches(row, junk.search.query),
    );
  }, [junkOn, junk, model.spam]);
  const quarantine = junkOn && spam.length > 0 && (shelfPicked || junk.visible.length === 0);
  const state = useMemo(() => (junkOn ? { ...model, spam } : model), [model, spam, junkOn]);
  useEffect(() => {
    if (!junkOn || spam.length === 0) setShelfPicked(false);
  }, [junkOn, spam.length]);
  const view = useScreenerView({
    state,
    segment,
    selected: above.selected(segment),
    select,
    go,
    undo: beside.undo,
    words,
    oneColumn,
    reader: { open: senderOpen, setOpen: setSenderOpen },
  });
  const keptCursor = segment !== "waiting" && (!junkOn || quarantine) && !view.full ? view.openId : null;
  useCursorRowInView(keptCursor, listScroller);
  const entered = useEntered();
  useEffect(() => {
    const id = entered.letter;
    if (id === null || junkOn) return;
    const row = view.rows
      .map(viewSender)
      .find((sender) => sender.id === id || sender.held.some((letter) => letter.id === id));
    if (row) {
      view.select(row.id, null, id);
      entered.taken();
    }
  }, [entered, view, junkOn]);
  const junkView = useJunkView({
    active: junkOn && !quarantine,
    rows: junk === NONE ? NO_JUNK : junk.visible,
    selected: above.selected("junk"),
    select: selectJunk,
    openBody: junk === NONE ? NO_BODY : junk.openBody,
    words,
    go,
    undo: beside.undo,
    oneColumn,
  });
  const count = view.rows.length + view.decided.length;
  const ready = junkOn
    ? junk.phase !== "loading"
    : emptyOf(segment, model, beside.facts, count).kind !== "loading";
  useSwitchEnded(route, ready);
  const walked = junkOn && !quarantine ? junkView : view;
  useOptionalKeyBindings(keysHere ? walked.keys : []);
  useZoneNav(useText("shortcuts"), { list: screenerListSteps(words, walked.step) });
  /* The queue's first page is asked again when the Screener opens, once: the model makes this function anew on
     every draw. */
  const reread = useRef(model.rereadWaiting);
  reread.current = model.rereadWaiting;
  useEffect(() => {
    reread.current();
  }, []);
  /* The reading column reads what the list shows; written after each draw, cleared when the list leaves. */
  useLayoutEffect(() => {
    above.cell.write({ ...view, quarantine });
  });
  useEffect(() => () => above.cell.write(null), [above.cell]);
  /* On one column an open sender stands over the list, and the dock leaves for its panel. */
  useSelectionBar(view.full || junkView.full);
  return {
    t,
    segment,
    go,
    phoneWindow,
    listScroller,
    setShelfPicked,
    view,
    junk: junkOn ? junk : null,
    junkView,
    quarantine,
  };
}

/** The selection bar's decisions over picked waiting senders. */
function waitingVerbs(view: ScreenerView, ids: readonly string[], t: Text) {
  return PICK_DECISIONS.map(({ id, icon }) => ({
    id,
    icon,
    label: t(PILE_VERB_KEY[id]),
    disabled: view.decidePicked === undefined,
    onPress: () => view.decidePicked?.(ids, id),
  }));
}

/** On a phone the rows stand on the list's sheet, as the Ohbox's do; with room at its foot for the dock. */
function OnSheet({ phone, picking, children }: { phone: boolean; picking: boolean; children: ReactNode }) {
  if (!phone) return children;
  return (
    <Sheet kind="plain" phoneListPadding={picking ? "top" : "dock"}>
      {children}
    </Sheet>
  );
}

export function ScreenerList(pane: PaneProps) {
  const { t, segment, go, phoneWindow, listScroller, setShelfPicked, view, junk, junkView, quarantine } =
    useScreenerList(pane);
  const junkOn = junk !== null;
  const [providerOpen, setProviderOpen] = useState(false);
  const providerReady =
    junk?.phase === "ready" &&
    junk.nextCursor === null &&
    junk.mailboxes.length > 0 &&
    junk.mailboxes.every((mailbox) => mailbox.window === "ok");
  const shelfFirst = providerReady && junk.items.length === 0 && view.rows.length > 0;
  const spamCount = providerReady && !junk.search.query ? junk.items.length + view.rows.length : undefined;
  useEffect(() => {
    if (segment !== "spam") setProviderOpen(false);
  }, [segment]);
  const model = useScreener();
  const selection = useRowSelection(view.rows.map(viewSender), segment);
  const contact = useRowContact();
  const selected = view.rows.filter((row) => selection.ids.includes(viewSender(row).id));
  const verbs =
    segment === "waiting" ? waitingVerbs(view, selection.ids, t) : keptVerbs(model, segment, selected, t);
  const foot = <SelectionFoot selection={selection} verbs={verbs} />;
  const asks = (
    <>
      <BulkDecision view={view} />
      <Unsubscribe view={view} />
    </>
  );
  /* On a phone an open sender takes the whole screen: while none does, no row is drawn open. */
  const phone = pane.plan.device === "phone";
  if (junkOn && junkView.full && junkView.open !== null)
    return <JunkLetter junk={junk} item={junkView.open} onBack={junkView.close} />;
  if (view.full && (!junkOn || quarantine))
    return (
      <>
        {view.failedOpen !== null ? (
          <Failed view={view} letter={view.failedOpen} />
        ) : (
          <Sender key={`${segment}:${view.openId ?? ""}`} view={view} phoneWindow={phoneWindow} />
        )}
        {asks}
      </>
    );
  return (
    <div className="sc-list">
      <Head view={view} go={go} spamCount={spamCount} />
      <Notices view={view} />
      {junkOn && junk.sweep ? <QuarantineMove sweep={junk.sweep} /> : null}
      <PullScroll className="sc-scroll" scroller={listScroller}>
        <OnSheet phone={phone} picking={selection.ids.length > 0}>
          {junkOn ? (
            <>
              <Tools
                view={view}
                junkCount={spamCount ?? null}
                extra={
                  shelfFirst
                    ? {
                        label: t(providerOpen ? "hideSpamSearch" : "junkSearchLabel"),
                        onPress: () => {
                          if (providerOpen) junk.search.setQuery("");
                          setProviderOpen(!providerOpen);
                        },
                      }
                    : undefined
                }
              />
              {!shelfFirst || providerOpen ? (
                <Junk
                  junk={junk}
                  view={{
                    ...junkView,
                    select: (key) => {
                      setShelfPicked(false);
                      junkView.select(key);
                    },
                  }}
                />
              ) : null}
              {view.rows.length > 0 ? (
                <>
                  {!shelfFirst ? (
                    <GroupHeading count={String(view.rows.length)}>{t("quarantineShelf")}</GroupHeading>
                  ) : null}
                  <Rows
                    label={t(shelfFirst ? "segSpam" : "quarantineShelf")}
                    contact={contact}
                    selection={selection}
                    view={{
                      ...view,
                      openId: quarantine ? view.openId : null,
                      select: (id) => {
                        setShelfPicked(true);
                        view.select(id);
                      },
                    }}
                  />
                </>
              ) : null}
            </>
          ) : (
            <>
              <Tools view={view} touch={pane.plan.pointer === "coarse"} />
              <Rows view={view} scroller={listScroller} selection={selection} contact={contact} />
              <Empty view={view} />
              {segment === "waiting" ? <Tail /> : null}
            </>
          )}
        </OnSheet>
      </PullScroll>
      {foot}
      {contact.card}
      {asks}
    </div>
  );
}
