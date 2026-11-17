/**
 * A LIST UNDER A FINGER: wrapped around what stands inside the list's scroller, it listens there for a row's swipe
 * and, at the list's top, for a pull. It draws no element of its own around the content: under a finger a room the
 * pull opens above it and the end of the run below it (the glass's inset, so the last row comes clear); under a
 * mouse nothing at all. Touch is on where the frame's plan says the pointer is coarse.
 */
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { FrameContext } from "../frame/commands.js";
import { NONE } from "../host/index.js";
import type { ListTouchProps } from "./contract.js";
import { createListTouch, type ListLive, type ListTouchStore } from "./list-touch.js";
import { ListTouchContext } from "./use-row-swipe.js";
import "./touch.css";

/** The room a pull opens at the list's top: a height and nothing else, until the kit draws the pull's mark. */
function PullRoom({ store }: { store: ListTouchStore }) {
  const down = useSyncExternalStore(store.subscribe, store.pullOf, store.pullOf);
  return <div className="tc-pull" aria-hidden="true" style={{ height: down }} />;
}

export function ListTouch({ scroller, off = false, pull, children }: ListTouchProps) {
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
      {touch && pulls ? <PullRoom store={store} /> : null}
      {children}
      {touch ? <div className="tc-run" aria-hidden="true" /> : null}
    </ListTouchContext.Provider>
  );
}
