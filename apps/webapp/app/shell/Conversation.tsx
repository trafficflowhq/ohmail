"use client";

/**
 * The conversation, rendered — one full-body panel per message. Threading reached the mirror and
 * the reader never showed it; after two shapes (a stack inside one article, then collapsible peek
 * rows) a thread is a column of PANELS — every message full-width on the canvas, oldest first, the
 * wrapper the one scroller, so nothing on a thread is one press away from being mail. Panels over
 * LOADED bodies: `MessagePane` fires one `hydrateThread` for the whole conversation, so this mapper
 * draws mail in hand — no fetch per panel, no placeholder; the anti-placeholder guard
 * (`test/conversation.test.ts`) holds exactly conversation-length distinct panels, each body on
 * screen, and any peek row or "N earlier" aggregate goes red.
 */

/**
 * One flat list with the focused panel slotted in: the opened message's panel is composed by
 * `MessagePane` (it owns the focused body expression, the protected rule, the attachment strip) and
 * handed in as `focusedPanel`; every other message renders as {@link MessageCard}, and "which one
 * am I reading" is a position in one column, marked by `aria-current`. The `ConversationLimit`
 * note ("your own replies are not here") is gone: the worker watches Sent now, and a claim that
 * has stopped being true is not a caveat, it is an error — the residual limit is a history depth,
 * recorded beside the ingest constant that sets it. State lives above; this component asks nothing.
 */
import { Fragment, type ReactNode } from "react";
import { MessageCard } from "./MessageCard";
import type { EngineMessage } from "@ohmail/client-engine";

export function ConversationPanels({
  messages,
  focusedId,
  focusedPanel,
  now,
}: {
  /** The WHOLE conversation, OLDEST FIRST — the focused message included. */
  messages: EngineMessage[];
  /** Which message was opened. Its panel is `focusedPanel`; the id is never remapped. */
  focusedId: string;
  /**
   * The opened message's panel, composed by `MessagePane` — the full anatomy with the
   * protected rule decided first, the hydrated body and the attachment strip.
   */
  focusedPanel: ReactNode;
  now: Date;
}) {
  if (messages.length === 0) return null;

  return (
    <>
      {messages.map((m) =>
        m.id === focusedId ? (
          // A keyed Fragment, so the focused panel lands FLAT in the column — the wrapper's
          // direct-child geometry (`.conv > …`) must see one article per message.
          <Fragment key={m.id}>{focusedPanel}</Fragment>
        ) : (
          // Every panel prints its own true subject in its header (SUBJECT-D, `MessageHeader`);
          // the normalized-key suppression that once decided which panel earned a heading is
          // deleted with the thread lede it compared against.
          <MessageCard key={m.id} message={m} now={now} />
        ),
      )}
    </>
  );
}
