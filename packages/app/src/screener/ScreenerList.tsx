/**
 * THE SCREENER'S LIST: its head with the three sections, the rows, what an empty section says, and Show more senders.
 * It reads the one model from `ScreenerAbove` and never makes one; its keys stand while it has them, and the
 * keyboard's zones are declared here: the arrows walk the senders as `j` and `k` do, and the list has no reading zone
 * (a sender is decided, not read). On one column the open sender stands over the list.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useOptionalKeyBindings } from "@ohmail/app-logic/keys";
import { useZoneNav } from "@ohmail/app-logic/keys/zone-nav";
import {
  screenerListSteps,
  useJunkView,
  useScreenerView,
  viewSender,
  type ScreenerState,
} from "@ohmail/app-logic/screener";
import { useEntered, useFrame, useSelectionBar } from "../frame/commands.js";
import type { PaneProps } from "../frame/contract.js";
import { NONE } from "../host/index.js";
import {
  segmentOf,
  useScreener,
  useScreenerAbove,
  useScreenerBeside,
  type ScreenerSegment,
} from "./contract.js";
import { AllSpam } from "./asks/AllSpam.js";
import { Unsubscribe } from "./asks/Unsubscribe.js";
import { Empty } from "./list/Empty.js";
import { Head } from "./list/Head.js";
import { Junk } from "./list/Junk.js";
import { Notices } from "./list/Notices.js";
import { Rows } from "./list/Rows.js";
import { Tail } from "./list/Tail.js";
import { Tools } from "./list/Tools.js";
import { JunkLetter } from "./held/JunkLetter.js";
import type { ScreenerJunkItem } from "./ports.js";
import { Failed } from "./sender/Failed.js";
import { Sender } from "./sender/Sender.js";
import { useText } from "../text/index.js";
import { useKeyWords } from "./words.js";
import "./screener.css";

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

export function ScreenerList({ route, plan, keysHere }: PaneProps) {
  const model = useScreener();
  const beside = useScreenerBeside();
  const above = useScreenerAbove();
  const { commands } = useFrame();
  const words = useKeyWords();
  const segment = segmentOf(route.sub);
  useStanding(route.place, route.sub);
  const go = useCallback(
    (to: ScreenerSegment) => commands.go({ place: "screener", sub: to === "waiting" ? null : to }),
    [commands],
  );
  const select = useCallback((id: string | null) => above.select(segment, id), [above, segment]);
  const selectJunk = useCallback((key: string | null) => above.select("junk", key), [above]);
  const oneColumn = plan.columns === 1;
  const { junk } = beside;
  /* With the mail server's Junk handed, the third section is that folder, and Spam's own senders are not listed. */
  const junkOn = segment === "spam" && junk !== NONE;
  const state = useMemo(() => (junkOn ? { ...model, spam: NO_SPAM } : model), [model, junkOn]);
  const view = useScreenerView({
    state,
    segment,
    selected: above.selected(segment),
    select,
    go,
    undo: beside.undo,
    words,
    oneColumn,
  });
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
    active: junkOn,
    rows: junk === NONE ? NO_JUNK : junk.visible,
    selected: above.selected("junk"),
    select: selectJunk,
    openBody: junk === NONE ? NO_BODY : junk.openBody,
    words,
    go,
    undo: beside.undo,
    oneColumn,
  });
  const walked = junkOn ? junkView : view;
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
    above.cell.write(view);
  });
  useEffect(() => () => above.cell.write(null), [above.cell]);
  /* On one column an open sender stands over the list, and the dock leaves for its panel. */
  useSelectionBar(view.full || junkView.full);
  const asks = (
    <>
      <AllSpam view={view} />
      <Unsubscribe view={view} />
    </>
  );
  if (junkOn && junkView.full && junkView.open !== null)
    return <JunkLetter junk={junk} item={junkView.open} onBack={junkView.close} />;
  if (view.full)
    return (
      <>
        {view.failedOpen !== null ? <Failed view={view} letter={view.failedOpen} /> : <Sender view={view} />}
        {asks}
      </>
    );
  return (
    <div className="sc-list">
      <Head view={view} go={go} />
      <Notices view={view} />
      <div className="sc-scroll">
        {junkOn ? (
          <Junk junk={junk} view={junkView} />
        ) : (
          <>
            <Tools view={view} />
            <Rows view={view} />
            <Empty view={view} />
            {segment === "waiting" ? <Tail /> : null}
          </>
        )}
      </div>
      {asks}
    </div>
  );
}
