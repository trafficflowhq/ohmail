"use client";

/**
 * THE INLINE FORWARD'S PLAN AND WIRE — one derivation for the lock and the send.
 *
 * A forward used to be reachable only by leaving the thread for the compose screen; it is the
 * reply editor's sibling now (reported from real use: "it should happen inside the thread"), and
 * this module is the forward's half of the discipline `replyEnvelopePlan` states for replies —
 * `InlineReply` judges the Send lock with these two functions and `AppShell.sendReply`'s forward
 * arm builds the mutation from them, so the button and the envelope cannot reach different
 * verdicts.
 *
 * WHAT A FORWARD IS ON THE WIRE (`types.ts`, `mail_send.forwardOf`): `inReplyTo: null`, the
 * original's id in `forwardOf`, recipients the USER picked, and the user's own note as the body.
 * The quoted original and its attachments are the SERVER's to assemble — a client-built quote is
 * the seam a redacted sensitive body would escape through — so nothing here reads the original's
 * body, and the editor's honesty line (`compose.forwardingNote`) says what will ride along.
 *
 * ── RECIPIENTS ARE NEVER DERIVED ────────────────────────────────────────────────────────────
 *
 * `forwardMessage` (the compose seed) states the rule: a forward goes to somebody the user
 * picks, and seeding the original's sender is how "forward this to my colleague" becomes a
 * reply nobody meant to send. So the untouched plan carries `to: []` — which `canSend`'s
 * non-reply branch REFUSES — and the editor opens with the recipient rows already showing.
 * An edit parses through the reply plan's own edited path (`replyEnvelopePlan` with no parent:
 * the parent only feeds the DERIVED arm, which a forward never takes), keeping the compose
 * form's whole-envelope-or-nothing typo rule.
 */
import { forwardSubject, type ComposeAttachment, type EngineMessage } from "@ohmail/client-engine";
import {
  replyEnvelopePlan,
  replyEnvelopeOnWire,
  type ReplyEnvelopeEdit,
  type ReplyEnvelopePlan,
} from "./compose-from";
import type { MailSend } from "./compose";

/** The forward's audience: the user's edit, or the refusable empty set — never a derivation. */
export function forwardEnvelopePlan(
  edit: ReplyEnvelopeEdit | null,
  ownAddresses: readonly string[],
): ReplyEnvelopePlan {
  if (edit === null) {
    return { to: [], cc: null, bcc: null, invalid: { to: [], cc: [], bcc: [] } };
  }
  return replyEnvelopePlan(null, ownAddresses, false, edit);
}

/**
 * The forward mutation, exactly as the wire carries it. `mailboxId` is REQUIRED by
 * `canSend`'s non-reply branch (a forward has no parent-derived sender the way `enrich`
 * gives a reply one), so an unresolvable From keeps Send locked rather than minting a send
 * the server would have to guess an identity for.
 */
export function forwardSend(
  parent: Pick<EngineMessage, "id" | "subject">,
  input: {
    body: string;
    html?: string;
    mailboxId?: string;
    attachments?: readonly ComposeAttachment[];
    plan: ReplyEnvelopePlan;
  },
): MailSend {
  return {
    kind: "mail_send",
    inReplyTo: null,
    forwardOf: parent.id,
    subject: forwardSubject(parent.subject),
    body: input.body,
    ...(input.html ? { html: input.html } : {}),
    ...(input.mailboxId ? { mailboxId: input.mailboxId } : {}),
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: [...input.attachments] }
      : {}),
    // The plan's `to` is never null for a forward (empty when untouched — the refusable
    // shape), so unlike a reply the recipient set always travels and `enrich` never derives one.
    ...replyEnvelopeOnWire(input.plan),
  };
}
