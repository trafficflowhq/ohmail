"use client";

/**
 * A LETTER ANSWERED IN ITS READING STREAM (owner 2026-10-26, "reply in place"). News and Receipts at
 * rest are the stream of cards, untouched. Reply is the one moment a letter changes: it becomes the
 * Ohbox's conversation where its card stood — the paper, the head, the bar and the same reply dock
 * (`MessagePane` in its `stream` form) — and the reply joins it as a second panel once sent. No
 * sheet, and nothing outside the editor changes while typing.
 *
 * A letter stays in place while it is the reply's host, and after that while its conversation holds
 * an own reply that joined during this visit or one of its sends is still on its way. A letter left
 * with nothing sent gets its card back, as it stood. All of it is per visit: a pile shown again is
 * today's stream.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { isOwnOutbound, type EngineMessage, type TagDTO } from "@ohmail/client-engine";
import { MessagePane, type MessageAction } from "./MessagePane";
import { useMessageChrome } from "./message-chrome";
import { inlineForwardKey, type SendPhase } from "./mail-send";
import { createThreadWalkChannel, type ThreadWalkChannel } from "./thread-walk-channel";
import type { StreamHandle } from "./StreamShell";
import { useStableCallback } from "./stable-callback";
import { useVisit } from "./visit";

/**
 * WHICH PILE LETTER HOSTS THE OPEN EDITOR: the reply's target when the pile holds it, else the pile
 * letter in the target's conversation (a panel's own Reply, on the reader's reply). `prefer` picks
 * among several (a letter already in place); `null` when the pile holds none of it. The shell asks
 * the same function whether a press may skip the reader sheet.
 */
export function streamHostOf(
  replyTo: string | null,
  pileHas: (id: string) => boolean,
  conversationOf: (id: string) => readonly EngineMessage[],
  prefer?: (id: string) => boolean,
): string | null {
  if (replyTo === null) return null;
  if (pileHas(replyTo)) return replyTo;
  const held = conversationOf(replyTo).filter((m) => pileHas(m.id)).map((m) => m.id);
  return (prefer ? held.find(prefer) : undefined) ?? held[0] ?? null;
}

/**
 * Does News or Receipts on screen answer this message in place: the view's own rule
 * ({@link streamHostOf}), for the shell, which then raises no reader sheet. Stable.
 */
export function useInPlaceHost({ view, seedOwed, partition, receipts, conversationOf }: {
  view: string;
  seedOwed: boolean;
  partition: { fresh: readonly EngineMessage[]; seen: readonly EngineMessage[] };
  receipts: readonly EngineMessage[];
  conversationOf: (id: string) => readonly EngineMessage[];
}): (messageId: string) => boolean {
  return useStableCallback((messageId: string): boolean => {
    const pile = seedOwed ? null
      : view === "reads" ? [...partition.fresh, ...partition.seen]
      : view === "receipts" ? receipts
      : null;
    if (pile === null) return false;
    const ids = new Set(pile.map((m) => m.id));
    return streamHostOf(messageId, (id) => ids.has(id), conversationOf) !== null;
  });
}

/**
 * Does a letter that is no longer the host stay in place: an own reply joined its conversation
 * since it entered (`members`), or one of its sends is neither idle nor failed.
 */
export function keepInPlace(
  conversation: readonly EngineMessage[],
  members: readonly string[],
  phases: readonly SendPhase[],
): boolean {
  if (conversation.some((m) => isOwnOutbound(m) && !members.includes(m.id))) return true;
  return phases.some((p) => p !== "idle" && p !== "failed");
}

interface Entry {
  /** The conversation's ids when the letter entered. */
  members: string[];
  /** The send lanes opened while in place (a reply's and a forward's). */
  lanes: Set<string>;
  walk: ThreadWalkChannel;
  /** Opens so far, and the last one the stream revealed: an arrival runs once per open. */
  opened: number;
  landed: number;
}

export interface StreamInPlace {
  /** The letter's conversation, for its card's place; `undefined` draws the card. */
  inPlace: (m: EngineMessage) => ReactNode | undefined;
  /** A letter in place, for its list row: the newest member and the squares' channel. */
  rowOf: (id: string) => { newest: EngineMessage; members: string[]; walk: ThreadWalkChannel } | null;
  /** The shell's own (stable), for the row's squares. */
  conversationOf: (id: string) => readonly EngineMessage[];
}

export function useStreamInPlace({
  pileHas,
  stamp,
  streamRef,
  tags,
  now,
  onAction,
}: {
  pileHas: (id: string) => boolean;
  /** Moves with the mirror (the view's pile): the conversations are asked again on a new one. */
  stamp: unknown;
  streamRef: RefObject<StreamHandle | null>;
  tags: TagDTO[];
  now: Date;
  onAction?: (action: MessageAction, m: EngineMessage) => void;
}): StreamInPlace {
  const chrome = useMessageChrome();
  const entries = useRef(new Map<string, Entry>());
  const lastReplyTo = useRef<string | null>(null);
  /** The host whose editor this render closes: its shrink must not move the cursor. */
  const lastHost = useRef<string | null>(null);
  const closing = useRef<{ id: string; land: boolean } | null>(null);
  const visiting = useRef(false);
  const [, bump] = useState(0);

  /* One conversation read per letter in place and mirror version. */
  const cache = useRef<{ stamp: unknown; map: Map<string, readonly EngineMessage[]> }>({ stamp, map: new Map() });
  if (cache.current.stamp !== stamp) cache.current = { stamp, map: new Map() };
  const conversationOf = (id: string): readonly EngineMessage[] => {
    let c = cache.current.map.get(id);
    if (c === undefined) {
      c = chrome.conversationOf(id);
      cache.current.map.set(id, c);
    }
    return c;
  };

  useVisit(
    () => {
      visiting.current = true;
      // An editor already open when the pile is shown: draw it.
      if (chrome.replyTo !== null) bump((n) => n + 1);
    },
    () => {
      visiting.current = false;
      entries.current = new Map();
      lastReplyTo.current = null;
      lastHost.current = null;
      closing.current = null;
    },
  );

  const replyTo = chrome.replyTo;
  const host = visiting.current
    ? streamHostOf(replyTo, pileHas, conversationOf, (id) => entries.current.has(id))
    : null;
  if (visiting.current && replyTo !== lastReplyTo.current) {
    lastReplyTo.current = replyTo;
    if (lastHost.current !== null && lastHost.current !== host) {
      closing.current = { id: lastHost.current, land: replyTo === null };
    }
    lastHost.current = host;
    if (host !== null && replyTo !== null) {
      let e = entries.current.get(host);
      if (!e) {
        const conv = conversationOf(host);
        e = {
          members: conv.length > 0 ? conv.map((m) => m.id) : [host],
          lanes: new Set(),
          walk: createThreadWalkChannel(),
          opened: 0,
          landed: 0,
        };
        entries.current.set(host, e);
      }
      e.lanes.add(replyTo).add(inlineForwardKey(replyTo));
      e.opened += 1;
    }
  }

  const shown = new Set<string>();
  for (const [id, e] of entries.current) {
    if (id === host) shown.add(id);
    else if (keepInPlace(conversationOf(id), e.members, [...e.lanes].map((l) => chrome.replySendState(l).phase))) shown.add(id);
  }

  /* A letter that left gets its card back for good; a new open lands the editor in view. A close
     holds the letter's own top while the cursor is on it (the hold loop would anchor the card below
     and pull it down past the reading line); a card given back by Esc whose head is above the port
     lands at the line. */
  useLayoutEffect(() => {
    const closed = closing.current;
    closing.current = null;
    if (closed) streamRef.current?.hold(closed.id, closed.land && !shown.has(closed.id));
    for (const [id, e] of entries.current) {
      if (!shown.has(id)) {
        entries.current.delete(id);
        continue;
      }
      if (e.landed !== e.opened) {
        e.landed = e.opened;
        streamRef.current?.reveal(id);
      }
    }
  });

  const scroller = useMemo<RefObject<HTMLElement | null>>(
    () => ({ get current() { return streamRef.current?.element() ?? null; } }),
    [streamRef],
  );

  return {
    inPlace: (m) => {
      const e = shown.has(m.id) ? entries.current.get(m.id) : undefined;
      if (!e) return undefined;
      return (
        <MessagePane
          message={m}
          tags={tags}
          now={now}
          onAction={(a) => onAction?.(a, m)}
          scroller={scroller}
          stream={{ walk: e.walk, arriving: e.landed !== e.opened }}
        />
      );
    },
    rowOf: (id) => {
      const e = shown.has(id) ? entries.current.get(id) : undefined;
      if (!e) return null;
      const conv = conversationOf(id);
      const newest = conv[conv.length - 1];
      return newest ? { newest, members: conv.map((m) => m.id), walk: e.walk } : null;
    },
    conversationOf: chrome.conversationOf,
  };
}
