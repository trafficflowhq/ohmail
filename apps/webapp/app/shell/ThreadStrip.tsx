"use client";

/**
 * THE OPEN CONVERSATION'S SQUARES IN ITS LIST ROW (owner 2026-10-24: "I want the focus in the list
 * as well") — the same squares as the column beside the reader, oldest first, in one row under the
 * preview (`MessageRow` `follow`, beside the row's button, never in it). The ring is the reader's,
 * read from the visit's channel, so it stands on the same square in both at every moment; a press
 * scrolls the reader exactly as a press on the column does. With no reader on screen (closed, or a
 * phone's list under a put-away sheet) the row keeps its ring where the person stopped, and a press
 * opens the row the row's own way and lands on that message. A conversation longer than the row
 * stands a window over it that follows the ring (`ThreadMarksBar`); nothing scrolls.
 *
 * The squares are the conversation AS IT STANDS (`conversationOf`), never the reader's last picture:
 * closed, a reply that arrives gets its square and a Mark unread turns them, as on the row's own
 * marks. Only the place (the ring) is the walk's. The host gives the strip only to the walked row
 * ({@link useWalkedRow}), and a row with a strip draws none of its own squares: one strip per row.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { isOwnOutbound, type EngineMessage } from "@ohmail/client-engine";
import { ThreadMarksBar, marksKeys } from "./ThreadMarks";
import type { ThreadWalkChannel, ThreadWalkSnapshot } from "./thread-walk-channel";

const walkedKey = (channel: ThreadWalkChannel): string => channel.get()?.messages.map((m) => m.id).join("\n") ?? "";

/**
 * Which rows are the walked conversation's, for the host that decides each row's `follow`. It changes
 * when the walk changes conversation or members, never on a ring step.
 */
export function useWalkedRow(channel: ThreadWalkChannel): (members: readonly string[]) => boolean {
  const key = useSyncExternalStore(channel.subscribe, () => walkedKey(channel), () => walkedKey(channel));
  return useMemo(() => {
    const ids = new Set(key === "" ? [] : key.split("\n"));
    return (members) => members.some((id) => ids.has(id));
  }, [key]);
}

export function ThreadStrip({ channel, members, onOpen, conversationOf, marks }: {
  channel: ThreadWalkChannel;
  /** The ids the row stands for; the strip draws only while the walked conversation is this row's. */
  members: readonly string[];
  /** The row's own open — the press's way in when no reader is on screen. */
  onOpen: () => void;
  /** The conversation as it stands, by any of its messages; absent, the walk's published messages. */
  conversationOf?: (messageId: string) => readonly EngineMessage[];
  /** The row's own marks: when they change, the conversation is asked again. */
  marks?: readonly string[];
}) {
  const mine = (): ThreadWalkSnapshot | null => {
    const s = channel.get();
    return s !== null && s.messages.some((m) => members.includes(m.id)) ? s : null;
  };
  const snap = useSyncExternalStore(channel.subscribe, mine, mine);
  const [stop, setStop] = useState<string | null>(null);
  /* One whole-conversation read per change of what the squares draw (the walk's members and kinds,
     the row's marks), never per ring step. */
  const anchor = snap === null ? null : snap.openedId ?? snap.messages[0]?.id ?? null;
  const drawn = snap === null ? "" : snap.messages.map((m) => `${m.id}:${m.unread ? "u" : isOwnOutbound(m) ? "m" : "r"}`).join(" ");
  const rowMarks = marks?.join(" ") ?? "";
  const messages = useMemo((): readonly EngineMessage[] => {
    if (snap === null) return [];
    const now = anchor !== null && conversationOf ? conversationOf(anchor) : [];
    return now.length > 0 ? now : snap.messages;
    // `snap` is read through `drawn`; a ring step alone asks nothing.
  }, [anchor, drawn, rowMarks, conversationOf]); // eslint-disable-line react-hooks/exhaustive-deps
  const here = snap?.here !== undefined && snap.here !== null && messages.some((m) => m.id === snap.here) ? snap.here : null;

  if (!snap || messages.length < 2) return null;
  const ids = messages.map((m) => m.id);
  const tabStop = stop !== null && ids.includes(stop) ? stop : here ?? ids[ids.length - 1] ?? null;
  const press = (id: string): void => {
    setStop(id);
    if (channel.press(id)) return;
    channel.pending = id;
    onOpen();
  };
  return (
    <ThreadMarksBar
      axis="x"
      messages={messages}
      here={here}
      tabStop={tabStop}
      onJump={press}
      onKey={marksKeys("x", setStop)}
    />
  );
}
