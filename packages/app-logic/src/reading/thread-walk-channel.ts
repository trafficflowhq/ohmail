"use client";

import { isOwnOutbound, type EngineMessage } from "@ohmail/client-engine";

/**
 * THE OPEN CONVERSATION'S PLACE, shared by its two sets of squares: the column beside the reader
 * (`ThreadMarks`, which walks it) and the strip in the conversation's list row (`ThreadStrip`, which
 * follows it). One current message, so the ring stands on the same square in both at every moment;
 * a press on either is the reader's one jump.
 *
 * The Ohbox owns one channel for its life and hands it to the reading column and the shell's sheet
 * on the visit's wiring. The snapshot outlives the reader: closed, the row keeps its squares ringed
 * where the person stopped, and a press there opens the row and lands on that message (`pending`,
 * taken by the next reader to measure it). The Ohbox clears it once another conversation is chosen.
 */
export interface ThreadWalkSnapshot {
  /** The conversation's messages in panel order, oldest first. */
  readonly messages: readonly EngineMessage[];
  /** The current message, or null before the reader has measured. */
  readonly here: string | null;
  /** The message the reader opened. */
  readonly openedId: string | null;
}

export interface ThreadWalkChannel {
  get(): ThreadWalkSnapshot | null;
  subscribe(listener: () => void): () => void;
  publish(next: ThreadWalkSnapshot): void;
  /**
   * The reader's jump, while a reader is on screen; the returned function unbinds this one only. The
   * latest bound answers (the sheet over the column), and the one under it again once that unbinds.
   */
  bindJump(jump: (id: string) => boolean): () => void;
  /** Jump the reader on screen to `id`: false when none is bound or it is not laid out. */
  press(id: string): boolean;
  /** A press made with no reader on screen, for the reader the row's open brings up. */
  pending: string | null;
  clear(): void;
}

const kindOf = (m: EngineMessage): string => (m.unread ? "u" : isOwnOutbound(m) ? "m" : "r");
const keyOf = (s: ThreadWalkSnapshot): string =>
  `${s.messages.map((m) => `${m.id}:${kindOf(m)}`).join(" ")}|${s.here ?? ""}|${s.openedId ?? ""}`;

export function createThreadWalkChannel(): ThreadWalkChannel {
  let snap: ThreadWalkSnapshot | null = null;
  let key = "";
  const jumps: Array<(id: string) => boolean> = [];
  const listeners = new Set<() => void>();
  const tell = (): void => { for (const l of [...listeners]) l(); };
  const channel: ThreadWalkChannel = {
    get: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(next) {
      const k = keyOf(next);
      if (snap !== null && k === key) return;
      snap = { messages: next.messages, here: next.here, openedId: next.openedId };
      key = k;
      tell();
    },
    bindJump(fn) {
      jumps.push(fn);
      return () => {
        const i = jumps.lastIndexOf(fn);
        if (i >= 0) jumps.splice(i, 1);
      };
    },
    press: (id) => jumps[jumps.length - 1]?.(id) ?? false,
    pending: null,
    clear() {
      channel.pending = null;
      if (snap === null) return;
      snap = null;
      key = "";
      tell();
    },
  };
  return channel;
}
