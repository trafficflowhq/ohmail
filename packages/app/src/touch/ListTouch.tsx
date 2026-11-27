/**
 * A LIST UNDER A FINGER: wrapped around what stands inside the list's scroller, it listens there for a row's swipe
 * and, at the top of a phone layout, for a pull. The paper moves over a waiting mark while the scroller keeps
 * its layout. The end of the run clears the glass's inset on touch devices.
 */
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { PULL_FIRE, PULL_HOLD, PULL_HOLD_CAP_MS } from "@ohmail/app-logic/touch";
import { pullMark } from "@ohmail/tokens";
import { Button } from "@ohmail/ui/base";
import { PullMark } from "@ohmail/ui/mail";
import { FrameContext } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import { useText } from "../text/index.js";
import type { ListTouchProps } from "./contract.js";
import { createListTouch, type ListLive, type ListTouchStore } from "./list-touch.js";
import { ListTouchContext } from "./use-row-swipe.js";
import "./touch.css";

/**
 * Whether the spinner holds: from a release that pulled while that pull runs, at most {@link PULL_HOLD_CAP_MS}. Read
 * in the render itself, so the room never closes for a frame between the release and the hold. A release seen while
 * no pull runs is over at once, so a pull started later by the rail or `p` holds no room it did not ask for; a count
 * left from before a remount is over too.
 */
function useHold(asked: number, busy: boolean): boolean {
  const [over, setOver] = useState(asked);
  useEffect(() => {
    if (!busy) setOver(asked);
  }, [busy, asked]);
  useEffect(() => {
    if (asked <= over) return;
    const cap = setTimeout(() => setOver(asked), PULL_HOLD_CAP_MS);
    return () => clearTimeout(cap);
  }, [asked, over]);
  return asked > over && busy;
}

function PullBeats({ center }: { center: number }) {
  const style = {
    "--pull-rest-opacity": pullMark.restOpacity,
    "--pull-rest-scale": pullMark.restScale,
    transform: `translate(-50%, calc(${center}px - 50%))`,
  } as CSSProperties;
  return (
    <span className="tc-pull-beats" data-pull-mark="" style={style}>
      {pullMark.beats.map((beat) => (
        <i key={beat} className="tc-pull-beat" style={{ "--pull-beat": beat } as CSSProperties} />
      ))}
    </span>
  );
}

/**
 * The room a pull opens at the list's top, with the kit's waiting mark in it: under the finger the mark grows to the
 * point where letting go pulls; let go there, the room holds and the mark runs until the pull is over. A list scrolled
 * on during the hold keeps its rows where they stand when the room closes.
 */
function PullRoom({
  store,
  busy,
  scroller,
}: {
  store: ListTouchStore;
  busy: boolean;
  scroller: ListTouchProps["scroller"];
}) {
  const distance = useSyncExternalStore(store.subscribe, store.pullOf, store.pullOf);
  const finger = distance !== null;
  const down = distance ?? 0;
  const asked = useSyncExternalStore(store.subscribe, store.askedOf, store.askedOf);
  const held = useHold(asked, busy);
  const wasHeld = useRef(held);
  const offset = Math.max(down, held ? PULL_HOLD : 0);
  /* If a person scrolled on during the wait, absorb the offset in the scroll position as the transform closes. */
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const snap = wasHeld.current && !held && el.scrollTop > 0;
    el.style.setProperty("--pull-offset", offset === 0 ? "none" : `0 ${offset}px`);
    el.toggleAttribute("data-pull-direct", finger || snap);
    if (snap) el.scrollTop = Math.max(0, el.scrollTop - PULL_HOLD);
    wasHeld.current = held;
  }, [finger, offset, held, scroller]);
  useEffect(() => {
    const el = scroller.current;
    return () => {
      el?.style.removeProperty("--pull-offset");
      el?.removeAttribute("data-pull-direct");
    };
  }, [scroller]);
  return (
    <div className="tc-pull" aria-hidden="true" data-held={held ? "" : undefined}>
      {held ? (
        <PullBeats center={offset / 2} />
      ) : down > 0 ? (
        <div className="tc-pull-drag">
          <PullMark pulled={down} armed={down >= PULL_FIRE} fullAt={PULL_FIRE} />
        </div>
      ) : null}
    </div>
  );
}

export function ListTouch({
  scroller,
  off = false,
  rowSwipe = true,
  pull,
  run = true,
  children,
}: ListTouchProps) {
  const frame = useContext(FrameContext)?.api;
  const touch = frame?.plan.pointer === "coarse";
  const compact = frame?.plan.columns === 1;
  const t = useText("sync");
  const [store] = useState(createListTouch);
  const live = useRef<ListLive>({ off, pull });
  live.current = { off, pull };
  const pulls = pull !== NONE;
  const touchPull = touch && frame?.plan.device === "phone" && pulls;
  const touchRows = touch && rowSwipe;
  const mailbox = pull === NONE ? undefined : pull.result?.mailboxId;
  const quietFeedback = touchPull && (pull.busy || pull.result?.key === "pullCurrent");
  const feedback =
    pull !== NONE && (pull.busy || pull.result)
      ? t(pull.busy ? "pulling" : (pull.result?.key ?? "pull"))
      : null;
  useEffect(() => {
    const el = scroller.current;
    if ((!touchRows && !touchPull) || !el) return;
    return store.attach(el, () => live.current, { swipe: touchRows, pull: touchPull });
  }, [touchRows, scroller, store, touchPull]);
  /* One shape in both cases, so a change of pointer never mounts the list's content again. */
  return (
    <ListTouchContext.Provider value={touchRows ? store : null}>
      {touchPull ? <PullRoom store={store} busy={pull.busy} scroller={scroller} /> : null}
      {touchPull ? (
        <span className="oh-vh" role="status">
          {feedback}
        </span>
      ) : null}
      {(touch || compact) && pull !== NONE && feedback !== null && !quietFeedback ? (
        <div className="tc-pull-notice" aria-live={touchPull ? undefined : "polite"}>
          <Button
            kind="quiet"
            size="s"
            icon="pull"
            disabled={pull.busy}
            onPress={() => {
              if (mailbox) frame?.commands.go({ place: "settings", sub: "mailboxes", words: { mailbox } });
              else pull.run();
            }}
          >
            {feedback}
          </Button>
        </div>
      ) : null}
      {children}
      {touch && run ? <div className="tc-run" aria-hidden="true" /> : null}
    </ListTouchContext.Provider>
  );
}
