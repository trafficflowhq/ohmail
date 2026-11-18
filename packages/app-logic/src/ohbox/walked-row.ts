/**
 * THE OPEN CONVERSATION'S SQUARES IN ITS LIST ROW (owner 2026-10-24: "I want the focus in the list as well"): the
 * same squares as the column beside the reader, oldest first, with the reader's ring read from the visit's walk
 * channel, so it stands on the same square in both at every moment; a press scrolls the reader exactly as a press
 * on the column does. With no reader on screen (closed, or a phone's list under a put-away sheet) the row keeps its
 * ring where the person stopped, and a press opens the row the row's own way and lands on that message.
 *
 * The squares are the conversation AS IT STANDS (`conversationOf`), never the reader's last picture: closed, a reply
 * that arrives gets its square and a Mark unread turns them, as on the row's own marks. Only the place (the ring) is
 * the walk's. Only the walked row reads anything here: every other row's answer is null and stays null on a step.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useMemo, useState, useSyncExternalStore } from "react";
import { isOwnOutbound, type ThreadMark } from "@ohmail/client-engine";
import type { ThreadWalkChannel, ThreadWalkSnapshot } from "../reading/thread-walk-channel.js";

export interface WalkedSquares {
  /** One mark a message, oldest first: the conversation as it stands. */
  marks: readonly ThreadMark[];
  /** The square the reader is on, counted from 0; null before the reader has measured. */
  here: number | null;
  /** A press on square `index`: the reader on screen jumps there, else the row opens and lands there. */
  jump: (index: number) => void;
}

export interface WalkedRowModel {
  walk: ThreadWalkChannel;
  stripOpen: (target: EngineMessage) => void;
  conversationOf?: (messageId: string) => readonly EngineMessage[];
}

const markOf = (m: EngineMessage): ThreadMark => (m.unread ? "unread" : isOwnOutbound(m) ? "mine" : "read");

/**
 * The walked conversation's squares for a row, or null when the walk is not this row's (or has fewer than two
 * messages). `marks` are the row's own marks: when they change, the conversation is asked again.
 */
export function useWalkedSquares(
  model: WalkedRowModel,
  row: { members: readonly EngineMessage[]; openTarget: EngineMessage },
  marks?: readonly ThreadMark[],
): WalkedSquares | null {
  const { walk, stripOpen, conversationOf } = model;
  const mine = (): ThreadWalkSnapshot | null => {
    const s = walk.get();
    return s !== null && s.messages.some((m) => row.members.some((r) => r.id === m.id)) ? s : null;
  };
  const snap = useSyncExternalStore(walk.subscribe, mine, mine);
  /* The snapshot the squares are drawn from, held until what they draw changes (the conversation the walk is
     anchored on, its members and kinds, the row's marks): a ring step publishes a new snapshot of the same drawing,
     so the whole-conversation read below is made once a change of the drawing, never once a step. */
  const drawing =
    snap === null
      ? null
      : [
          snap.openedId ?? snap.messages[0]?.id ?? "",
          snap.messages.map((m) => `${m.id}:${markOf(m)}`).join(" "),
          marks?.join(" ") ?? "",
        ].join("\n");
  const [held, setHeld] = useState({ drawing, snap });
  if (held.drawing !== drawing) setHeld({ drawing, snap });
  const messages = useMemo((): readonly EngineMessage[] => {
    const drawn = held.snap;
    if (drawn === null) return [];
    const anchor = drawn.openedId ?? drawn.messages[0]?.id ?? null;
    const now = anchor !== null && conversationOf ? conversationOf(anchor) : [];
    return now.length > 0 ? now : drawn.messages;
  }, [held, conversationOf]);
  const kinds = useMemo(() => messages.map(markOf), [messages]);
  if (snap === null || messages.length < 2) return null;
  const at = snap.here === null ? -1 : messages.findIndex((m) => m.id === snap.here);
  const target = row.openTarget;
  return {
    marks: kinds,
    here: at < 0 ? null : at,
    jump: (index) => {
      const id = messages[index]?.id;
      if (id === undefined) return;
      if (walk.press(id)) return;
      walk.pending = id;
      stripOpen(target);
    },
  };
}
