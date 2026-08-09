"use client";

/**
 * THE CONVERSATION, RENDERED — ONE ROW PER MESSAGE, COLLAPSIBLE.
 *
 * ── WHAT WAS WRONG ──────────────────────────────────────────────────────────────────────
 *
 * Threading reached the mirror and the reader never showed it: opening a message that was one
 * of three on its thread rendered one body and no thread count. The data half shipped; the UI
 * half was never in scope. That half is here now — and then a second problem appeared once it
 * worked: a thread of ordinary business letters rendered as a tall stack of full letters, each
 * complete, with the reader made to scroll past the ones they had read to reach the one they
 * wanted. Every message legible, and the thread as a whole unreadable.
 *
 * ── COLLAPSE OVER LOADED BODIES ─────────────────────────────────────────────────────────────
 *
 * A conversation renders one collapsible ROW per message. This replaces an earlier design that
 * rendered every message in full, one stacked under the next — legible per message, unreadable
 * as a thread. Collapse is safe here for one specific reason, and the distinction is exact:
 *
 *   · Every message's body is LOADED on open (`MessagePane` fires one `hydrateThread` for the
 *     whole conversation), so a collapsed row is a message already in hand, one press from being
 *     read, with NO fetch on expand.
 *   · Every message is an individually-visible ROW carrying its own sender, stamp and one-line
 *     peek — never a "3 older messages" count standing in for mail the reader cannot reach.
 *
 * Nothing is withheld and nothing is aggregated behind a count. The anti-placeholder guard in
 * `conversation.test.ts` holds that line: the collapsed default must render exactly
 * conversation-length distinct rows, and a mutation that aggregates older ones behind a count
 * goes red. A comment asserting the opposite of the behaviour is a well-known failure shape,
 * which is why this describes what the code does rather than what it used to.
 *
 * ── ONE LIST, ONE DENSITY, ONE PLACE ─────────────────────────────────────────────────────
 *
 * A sibling renders as {@link MessageCard} — the Blanc `.hmail` card the Screener uses for held
 * mail, so "a message rendered inside another message" looks the same wherever the product does
 * it. Collapsed it is a single button row; expanded it wears the same {@link MessageHeader} the
 * focused message wears and draws its body through the same {@link MessageBody}, so a sibling
 * inherits the sanitizer, the sandboxed frame, remote-content blocking and dark adaptation with
 * nothing re-implemented and nothing to keep in step.
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
 * Which rows are open, and the toggle that opens them, come down as props from `MessagePane` —
 * the one place that holds the whole thread. `ConversationEntries` maps its slice of the
 * conversation to cards and asks for nothing; the body hydration and the scroll anchor both live
 * in `MessagePane` for the same reason (this list is mounted TWICE per thread, above and below
 * the focused message, so an effect here would fire twice for one open).
 */
import { MessageCard, subjectKey } from "./MessageCard";
import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";

/** How deep this conversation is. */
export function ConversationHead({ count }: { count: number }) {
  const t = useTranslations("reply");
  return <p className="conv-head num">{t("conversationCount", { count })}</p>;
}

export function ConversationEntries({
  messages,
  threadSubject,
  now,
  expanded,
  onToggle,
}: {
  /**
   * The entries to render, OLDEST FIRST — the SIBLINGS only. The opened message keeps the
   * full message anatomy and is rendered by `MessagePane` itself, between the two halves of
   * this list, which is what makes "which one am I reading" answerable without a legend.
   */
  messages: EngineMessage[];
  /** The subject already on screen as the message's own heading — see `subjectKey`. */
  threadSubject?: string;
  now: Date;
  /** Which sibling ids are unfolded — owned by `MessagePane`. */
  expanded: ReadonlySet<string>;
  /** Fold or unfold one sibling. */
  onToggle: (id: string) => void;
}) {
  if (messages.length === 0) return null;
  const alreadySaid = threadSubject ? subjectKey(threadSubject) : null;

  return (
    <>
      {messages.map((m) => (
        <MessageCard
          key={m.id}
          message={m}
          now={now}
          collapsed={!expanded.has(m.id)}
          onToggle={() => onToggle(m.id)}
          // A renamed branch of a thread prints its own heading; a "Re: …" of the same subject
          // does not repeat under the h2 that already says it.
          showSubject={alreadySaid !== subjectKey(m.subject)}
        />
      ))}
    </>
  );
}
