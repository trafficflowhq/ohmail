"use client";

/**
 * WHICH STREAM CARDS ARE NEAR THE SCREEN — the cards that mount their rendered viewer
 * (`StreamCardMemo.viewer`). Every mounted card used to build one: a sanitize pass and a framed
 * document per card, forty-five frames in the commit a press into News made. Now a card builds
 * its viewer once the stream's lookahead (`StreamShell.onApproach`, one viewport each way) has
 * reported it, and keeps it while it stays mounted; a card the window sheds leaves the set.
 *
 * ONE FRAMED DOCUMENT PER FRAME. A framed document is parsed, laid out and measured on load, and
 * six of them in one commit held a WebKit frame for over 100 ms on every first visit. So the set
 * opens with the top {@link NEAR_SEED} cards of the opening slice, which are on screen; the rest of
 * the slice and every card the lookahead reports wait in a queue, and one joins per painted frame,
 * in a transition. The queue moves only while the cards are drawn (`armed`).
 */
import { startTransition, useCallback, useEffect, useRef, useState } from "react";
import { afterPaint } from "./visit";

/** The opening cards near from the first render: the top of a stream that starts at the top. */
export const NEAR_SEED = 2;

export interface StreamNear {
  near: ReadonlySet<string>;
  /** `StreamShell.onApproach`: the reported cards join the queue, none twice. */
  onApproach: (ids: string[]) => void;
}

export function useStreamNear(
  mounted: readonly string[],
  opening: readonly string[],
  armed: boolean,
  getRoot: () => HTMLElement | null,
  /** While true (the stream is flying, `StreamWindow.inFlight`) the queue waits. */
  held?: () => boolean,
): StreamNear {
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set(opening.slice(0, NEAR_SEED)));
  const nearRef = useRef(near);
  nearRef.current = near;
  const queue = useRef<string[]>([]);
  /** The pump's waiting step, and the id its last step added. */
  const pending = useRef<(() => void) | null>(null);
  const inFlight = useRef<string | null>(null);
  /** Bumped when the queue gains an id: a commit, which wakes the pump below. */
  const [, setQueued] = useState(0);
  const enqueue = useCallback((ids: readonly string[]) => {
    let added = false;
    for (const id of ids) {
      if (nearRef.current.has(id) || queue.current.includes(id)) continue;
      queue.current.push(id);
      added = true;
    }
    if (added) setQueued((n) => n + 1);
  }, []);
  const mountedKey = mounted.join("\u0000");
  const openingKey = opening.join("\u0000");
  /* Pruned to the mounted cards; the opening slice queues while it is mounted. */
  useEffect(() => {
    const here = new Set(mounted);
    queue.current = queue.current.filter((id) => here.has(id));
    if (inFlight.current !== null && !here.has(inFlight.current)) inFlight.current = null;
    setNear((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (here.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
    enqueue(opening.filter((id) => here.has(id)));
    // The keys stand for the arrays' contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mountedKey, openingKey]);
  /* THE PUMP: once the frame that drew the last one has painted, the next queued card joins. One
     at a time: the next waits until the commit that added the last is in. While the stream is
     held it takes nothing and looks again on the next frame, with no commit. */
  const heldRef = useRef(held);
  heldRef.current = held;
  const pump = useRef<() => void>(() => {});
  pump.current = () => {
    if (!armed || pending.current || queue.current.length === 0) return;
    if (inFlight.current !== null && !nearRef.current.has(inFlight.current)) return;
    let ran = false;
    const cancel = afterPaint(getRoot(), () => {
      ran = true;
      pending.current = null;
      if (heldRef.current?.() && typeof requestAnimationFrame === "function") {
        const frame = requestAnimationFrame(() => {
          pending.current = null;
          pump.current();
        });
        pending.current = () => cancelAnimationFrame(frame);
        return;
      }
      let id = queue.current.shift();
      while (id !== undefined && nearRef.current.has(id)) id = queue.current.shift();
      if (id === undefined) return;
      inFlight.current = id;
      startTransition(() => setNear((prev) => (prev.has(id) ? prev : new Set(prev).add(id))));
    });
    if (!ran) pending.current = cancel;
  };
  useEffect(() => pump.current());
  /* A visit's end (or the stream disarmed) drops a waiting step; the next visit starts its own. */
  useEffect(
    () => () => {
      pending.current?.();
      pending.current = null;
      inFlight.current = null;
    },
    [armed],
  );
  return { near, onApproach: enqueue };
}
