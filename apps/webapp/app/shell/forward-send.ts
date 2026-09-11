"use client";

/**
 * The inline forward's plan and wire — one derivation for the lock and the send. A forward is the reply editor's
 * sibling now (reported from real use), and this module is the forward's half of the discipline `replyEnvelopePlan`
 * states: `InlineReply` judges the Send lock with these two functions and `AppShell.sendReply`'s forward arm builds
 * the mutation from them, so the button and the envelope cannot reach different verdicts.
 */

/**
 * On the wire (`mail_send.forwardOf`): `inReplyTo: null`, the original's id in `forwardOf`, recipients the USER
 * picked, the user's note as body — the quoted original and its attachments are the SERVER's to assemble (a
 * client-built quote is the seam a redacted body would escape through), and `compose.forwardingNote` says what rides
 * along. Recipients are never derived: seeding the original's sender is how "forward this to my colleague" becomes a
 * reply nobody meant, so the untouched plan carries `to: []`, which `canSend` refuses, and the editor opens with the
 * recipient rows showing.
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
