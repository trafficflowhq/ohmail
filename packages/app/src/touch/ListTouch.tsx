/**
 * A LIST UNDER A FINGER: wrapped around what stands inside the list's scroller, it listens there for a row's swipe
 * and, at the list's top, for a pull. It draws no element of its own around the content: under a finger a room the
 * pull opens above it and the end of the run below it (the glass's inset, so the last row comes clear); under a
 * mouse nothing at all. Touch is on where the frame's plan says the pointer is coarse.
 */
import { useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { PULL_FIRE } from "@ohmail/app-logic/touch";
import { Spinner } from "@ohmail/ui/base";
import { FrameContext } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import type { ListTouchProps } from "./contract.js";
import { createListTouch, type ListLive, type ListTouchStore } from "./list-touch.js";
import { ListTouchContext } from "./use-row-swipe.js";
import "./touch.css";

/** How far down the list stays while the pull it asked for runs, in px (the kit's `--s7`). */
export const PULL_HOLD = 48;
/** The longest the spinner holds: a pull still running then goes on unseen, and says its outcome when it lands. */
export const PULL_HOLD_CAP_MS = 15_000;

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
  const down = useSyncExternalStore(store.subscribe, store.pullOf, store.pullOf);
  const asked = useSyncExternalStore(store.subscribe, store.askedOf, store.askedOf);
  const held = useHold(asked, busy);
  const wasHeld = useRef(held);
  /* Closing under rows scrolled on: the room goes at once and the scroll takes its height back, so nothing moves. */
  const snap = wasHeld.current && !held && (scroller.current?.scrollTop ?? 0) > 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    if (wasHeld.current && !held && el && el.scrollTop > 0)
      el.scrollTop = Math.max(0, el.scrollTop - PULL_HOLD);
    wasHeld.current = held;
  }, [held, scroller]);
  const height = Math.max(down, held ? PULL_HOLD : 0);
  const near = held ? 1 : Math.min(1, down / PULL_FIRE);
  return (
    <div
      className="tc-pull"
      aria-hidden="true"
      data-finger={down > 0 || snap ? "" : undefined}
      data-held={held ? "" : undefined}
      style={{ height }}
    >
      {height > 0 ? (
        <span className="tc-pull-mark" style={{ opacity: near, transform: `scale(${0.5 + 0.5 * near})` }}>
          <Spinner />
        </span>
      ) : null}
    </div>
  );
}

export function ListTouch({ scroller, off = false, pull, run = true, children }: ListTouchProps) {
  const touch = useContext(FrameContext)?.api.plan.pointer === "coarse";
  const [store] = useState(createListTouch);
  const live = useRef<ListLive>({ off, pull });
  live.current = { off, pull };
  const pulls = pull !== NONE;
  useEffect(() => {
    const el = scroller.current;
    if (!touch || !el) return;
    return store.attach(el, () => live.current, pulls);
  }, [touch, scroller, store, pulls]);
  /* One shape in both cases, so a change of pointer never mounts the list's content again. */
  return (
    <ListTouchContext.Provider value={touch ? store : null}>
      {touch && pull !== NONE ? <PullRoom store={store} busy={pull.busy} scroller={scroller} /> : null}
      {children}
      {touch && run ? <div className="tc-run" aria-hidden="true" /> : null}
    </ListTouchContext.Provider>
  );
}
