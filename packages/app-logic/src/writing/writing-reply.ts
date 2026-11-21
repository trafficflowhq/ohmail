/**
 * THE OPEN REPLY, AS THE SCREEN READS IT: planned with the helpers the composer's send builds it with
 * (`replyEnvelopePlan`, `forwardSend`, `resolveReplyFrom`), so the fold, the lines, the From line and Send's gate are
 * one derivation with the wire.
 */
import type { EngineMessage } from "@ohmail/wire";
import { forwardSubject, replySubject, type FromOption, type OhmailEngine } from "@ohmail/client-engine";
import type { MailSend } from "./compose.js";
import { inlineForwardKey, sendRefusal, sendStateFor } from "./mail-send.js";
import {
  formatRecipientChips,
  replyAllRecipients,
  replyEnvelopeOnWire,
  replyEnvelopePlan,
  replyRecipients,
  resolveReplyFrom,
} from "./compose-from.js";
import { forwardEnvelopePlan, forwardSend } from "./forward-send.js";
import type { ShellCompose } from "./shell-compose.js";

export interface ReplyContext {
  readonly engine: OhmailEngine;
  readonly replyTo: string | null;
  /** The account's sendable addresses (the mailbox facts' options); empty while they cannot be seen. */
  readonly options: readonly FromOption[];
}

/** The open reply, planned; null when none is open or its letter is not in the mirror. */
export function replyOf(compose: ShellCompose, ctx: ReplyContext) {
  if (ctx.replyTo === null) return null;
  const mode = compose.replyMode;
  const message =
    ctx.engine.read().get<EngineMessage>("message", ctx.replyTo) ??
    (mode === "forward" ? ctx.engine.verbRead().get<EngineMessage>("message", ctx.replyTo) : undefined);
  if (!message) return null;
  const own = ctx.options.map((o) => o.address);
  const from = resolveReplyFrom(ctx.options, message.mailboxId, compose.replyFromId);
  const files = compose.replyAttachments;
  const withFiles = files.length > 0 ? { attachments: [...files] } : {};
  const body = compose.replyBody.text;
  const send = compose.replySendState(mode === "forward" ? inlineForwardKey(message.id) : message.id);
  /* What the reply draws is the lane's state as it applies to THIS reply (`sendStateFor`): a send nobody could confirm
     warns over the reply it belongs to alone. Its refusal reads the lane's state as it stands, the send's own rule. */
  const base = { messageId: message.id, from: { ...from, domainMatched: false } };
  if (mode === "forward") {
    const plan = forwardEnvelopePlan(compose.replyEnvelope, own);
    const wire = compose.replyForwardFiles?.plan.wire;
    const would = forwardSend(message, {
      body,
      mailboxId: from.mailboxId ?? message.mailboxId,
      ...withFiles,
      plan,
      ...(wire !== undefined ? { forwardParts: wire } : {}),
    });
    return {
      ...base,
      mode,
      audience: "forward" as const,
      seed: { to: "", cc: "", bcc: "" },
      invalid: plan.invalid,
      subject: { value: forwardSubject(message.subject), editable: false },
      send: sendStateFor(send, would),
      refusal: sendRefusal(send, would),
      held: null,
    };
  }
  const plan = replyEnvelopePlan(message, own, compose.replyAll, compose.replyEnvelope);
  const all = compose.replyAll ? replyAllRecipients(message, own) : null;
  const to = all ? all.to : (replyRecipients(message, own) ?? [message.from]);
  const cc = all ? all.cc : [];
  const would: MailSend = {
    kind: "mail_send",
    inReplyTo: message.id,
    body,
    ...withFiles,
    ...replyEnvelopeOnWire(plan),
  };
  return {
    ...base,
    mode,
    audience: { to: to.map(personOf), cc: cc.map(personOf) },
    seed: { to: formatRecipientChips(to), cc: formatRecipientChips(cc), bcc: "" },
    invalid: plan.invalid,
    subject: { value: compose.replySubjectEdit ?? replySubject(message.subject), editable: true },
    send: sendStateFor(send, would),
    refusal: sendRefusal(send, would),
    held: compose.heldReplyRow(message.id),
  };
}

const personOf = (p: {
  name?: string | null;
  address: string;
}): { name: string | null; address: string } => ({
  name: p.name ?? null,
  address: p.address,
});
