"use client";

/**
 * THE CONVERSATION, RENDERED — ONE FULL-BODY PANEL PER MESSAGE.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * Threading reached the mirror and the reader never showed it: opening a message that was one
 * of three on its thread rendered one body and no thread count. The data half shipped; the UI
 * half was never in scope. That half is here. It then went through two shapes: a stack of full
 * letters inside ONE article (legible per message, unreadable as a thread), then collapsible
 * peek rows over loaded bodies. The peek rows are gone with the viewer redesign: a thread is a
 * column of PANELS now — every message a full-width panel on the canvas, oldest first, the
 * wrapper the one scroller — so nothing on a thread is one press away from being mail.
 *
 * ── PANELS OVER LOADED BODIES ───────────────────────────────────────────────────────────
 *
 * Every panel's body is already LOADED when it renders (`MessagePane` fires one `hydrateThread`
 * for the whole conversation), so this mapper draws mail that is in hand — no fetch per panel,
 * no placeholder for mail the reader cannot reach. The anti-placeholder guard in
 * `conversation.test.ts` holds the stronger line the redesign bought: exactly
 * conversation-length distinct panels, each with its body ON SCREEN, and any peek row,
 * "N earlier" aggregate or count line goes red.
 *
 * ── ONE LIST, FLAT, WITH THE FOCUSED PANEL SLOTTED IN ───────────────────────────────────
 *
 * The mapper walks the WHOLE conversation once, oldest first. The opened message's panel is
 * composed by `MessagePane` (it owns the focused body expression, the protected rule and the
 * attachment strip) and handed in as `focusedPanel`; every other message renders as
 * {@link MessageCard}. One list rather than the old above/below split, so "which one am I
 * reading" is a position in one column, marked by `aria-current` on the focused panel.
 *
 * ── BOTH SIDES OF THE THREAD ────────────────────────────────────────────────────────────
 *
 * This used to render a `ConversationLimit` note saying the user's own replies were not in
 * `messages` at all, because `Sent` was unwatched. The worker watches it now, so the note and the
 * string behind it are gone: they became false the moment the worker shipped, and a claim that
 * has stopped being true is not a caveat, it is an error. The residual limit is a HISTORY DEPTH
 * (the newest `DEFAULT_SENT_HISTORY_MESSAGES` of Sent), recorded beside the ingest constant that
 * sets it rather than stated on every conversation.
 *
 * ── STATE LIVES ABOVE, THIS COMPONENT IS RENDER-ONLY ────────────────────────────────────────
 *
 * The body hydration and the open-at-latest scroll anchor both live in `MessagePane` — the one
 * place that holds the whole thread. This mapper asks for nothing.
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
