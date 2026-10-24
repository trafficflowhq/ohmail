"use client";

/**
 * THE OPEN CONVERSATION'S SQUARES IN ITS LIST ROW (owner 2026-10-24: "I want the focus in the list
 * as well") — the same squares as the column beside the reader, oldest first, in one row under the
 * preview (`MessageRow` `follow`, beside the row's button, never in it). The ring is the reader's,
 * read from the visit's channel, so it stands on the same square in both at every moment; a press
 * scrolls the reader exactly as a press on the column does. With no reader on screen (closed, or a
 * phone's list under a put-away sheet) the row keeps its ring where the person stopped, and a press
 * opens the row the row's own way and lands on that message. A long conversation scrolls sideways
 * inside the row; the ring's square is kept in view.
 *
 * The squares are the conversation AS IT STANDS (`conversationOf`), never the reader's last picture:
 * closed, a reply that arrives gets its square and a Mark unread turns them, as on the row's own
 * marks, which the strip hides. Only the place (the ring) is the walk's.
 */
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isOwnOutbound, type EngineMessage } from "@ohmail/client-engine";
import { ThreadMarksBar, marksKeys } from "./ThreadMarks";
import type { ThreadWalkChannel, ThreadWalkSnapshot } from "./thread-walk-channel";

export function ThreadStrip({ channel, members, onOpen, conversationOf, marks }: {
  channel: ThreadWalkChannel;
  /**
   * The ids the row stands for. Every conversation's row carries a strip, drawn only while the walked
   * conversation is this row's: the row's markup stays one shape, so opening the conversation never
   * remounts the row's button (and never takes its focus).
   */
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
  const bar = useRef<HTMLDivElement | null>(null);
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

  useLayoutEffect(() => {
    const b = bar.current;
    if (!b || here === null || b.scrollWidth <= b.clientWidth) return;
    const q = b.querySelector<HTMLElement>(`.tm-mb[data-for="${CSS.escape(here)}"]`);
    if (!q) return;
    const left = q.offsetLeft; // the strip is its squares' offset parent (app.css)
    if (left < b.scrollLeft) b.scrollLeft = left;
    else if (left + q.offsetWidth > b.scrollLeft + b.clientWidth) b.scrollLeft = left + q.offsetWidth - b.clientWidth;
  }, [here]);

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
      barRef={bar}
    />
  );
}
