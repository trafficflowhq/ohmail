"use client";

/**
 * TODAY'S REPLY EDITOR, ONE WIRING: the forward's ask, else `InlineReply` with every prop off the chrome. Today's
 * reading pane mounts it at a thread's foot, and the new reader's reply sheet mounts the same element after a
 * conversation's last letter; never both for one letter on screen. It leaves when the new reader writes its reply in
 * a sheet of its own.
 */
import type { EngineMessage } from "@ohmail/client-engine";
import { inlineForwardKey } from "@ohmail/app-logic/writing/mail-send";
import { ForwardAskStrip } from "./ForwardAsk";
import { InlineReply } from "./InlineReply";
import { useMessageChrome } from "./message-chrome";

export function TodaysReplyEditor({
  replyTarget,
  stream,
}: {
  /** The message the open editor answers (or forwards): a member of the conversation on screen. */
  replyTarget: EngineMessage;
  /** A letter answered in its reading stream: the stream lands the editor and focuses it on its arrival. */
  stream?: { arriving: boolean };
}) {
  const chrome = useMessageChrome();
  return chrome.forwardAsk && chrome.replyMode === "forward" ? (
    <ForwardAskStrip
      ask={chrome.forwardAsk}
      onConfirm={() => chrome.confirmForward?.()}
      onCancel={chrome.closeReply}
    />
  ) : (
    <InlineReply
      /* THE TARGET, not the focused message — see `replyTarget`. The editor takes the
         message it is answering and nothing else: the `to` line, the draft key, `canSend`
         and the send-state lane all follow the member the ⋯ menu named. */
      message={replyTarget}
      /* A reply, or the inline forward — the chrome's one mode field. */
      mode={chrome.replyMode ?? "reply"}
      /* Whether this editor answers EVERYONE on the message — set by the open
         (`openReply(id, true)`), read here so the head names the same audience the
         send will carry. Absent chrome field means a plain reply. */
      replyAll={chrome.replyAll === true}
      value={chrome.replyBody}
      /* The dock's own lane: a forward's outcome lands on `fwd:<id>` (see `sendKeyOf`), so the
         button's "Sending…" and the failure it may show are THIS editor's and never the compose
         form's. */
      send={chrome.replySendState(
        (chrome.replyMode ?? "reply") === "forward" ? inlineForwardKey(replyTarget.id) : replyTarget.id,
      )}
      showing={chrome.replySendShowing ?? null}
      onChange={chrome.onReplyBody}
      onClose={chrome.closeReply}
      onSend={() => chrome.sendReply(replyTarget.id)}
      /* SEND + DONE, offered by the SHELL or not at all — the engine's one rule, asked about
         the message this editor is answering. `null`/absent renders the plain Send. */
      onSendAndDone={chrome.sendReplyAndDone?.(replyTarget.id) ?? null}
      /* THE HELD REPLY'S TWO VERBS — the row this message's unconfirmed reply left behind, and
         where the reader's answer goes. Only for a reply: a forward has no such row, and the
         editor renders the verbs only while its own sentence says the send is unconfirmed. */
      heldResolve={(chrome.replyMode ?? "reply") === "forward"
        ? null
        : chrome.replyHeldResolve?.(replyTarget.id) ?? null}
      /* The audience, editable: the edit strings and their reporter live on the chrome
         beside the body (mounted-twice — `message-chrome.tsx`), and the book feeds the
         rows' suggestions. `onEnvelope` absent on the inert chrome keeps the head a
         plain statement there. */
      envelope={chrome.replyEnvelope}
      onEnvelope={chrome.onReplyEnvelope}
      book={chrome.addressBook}
      /* WHICH ADDRESS ANSWERS — the pick and its reporter live on the chrome beside the body
         (mounted-twice), so the From line the reader sees and the `mailboxId` `sendReply`
         puts on the wire are one resolution. */
      fromId={chrome.replyFromId}
      onFrom={chrome.onReplyFrom}
      /* FILES ON THE REPLY — held on the chrome (mounted-twice again), carried to the send by
         `sendReply` and stored nowhere. `onAttachments` absent on the inert chrome renders no
         attach control there. */
      attachments={chrome.replyAttachments}
      onAttachments={chrome.onReplyAttachments}
      /* A forward's original files — the shell's plan, the one its send carries. */
      forwardFiles={(chrome.replyMode ?? "reply") === "forward" ? chrome.replyForwardFiles ?? null : null}
      /* THE SIGNATURE BLOCK — state on the chrome (mounted-twice), the stored map from the
         shell's consent read, serialized by `sendReply` from the same derivation the block
         renders. `onReplySig` absent on the inert chrome renders no block there. */
      signatures={chrome.signatures}
      /* The markup half, forwarded EXPLICITLY beside it. Both props are optional, so a
         missing forward here compiles and renders the plain shape for a signature the send
         carries as markup — a silent divergence no typecheck can see. */
      signaturesHtml={chrome.signaturesHtml}
      sig={chrome.replySig}
      onSig={chrome.onReplySig}
      /* THE SUBJECT, editable in place on a reply — the edit lives on the chrome
         (mounted-twice), `null` keeps the untouched wire byte-identical. */
      subjectEdit={chrome.replySubjectEdit}
      onSubject={chrome.onReplySubject}
      /* The host's ceiling on what a send can carry — the other half of the attach cap the
         editor states beside those files (`composeAttachCap(SIZE, THIS)`). Absent on the inert
         chrome and on every browser tab; `null` on the desktop's standalone door. */
      sendSurfaceMaxTotalBytes={chrome.sendSurfaceMaxTotalBytes}
      /* The AI drafter's offer renders inside the editor the draft lands in — see
         `InlineReply`. Absent where there is no drafter: the desktop shell, and any
         harness that mounts a pane without the shell. */
      /* Never in FORWARD mode: the drafter writes replies, so its card in the forward dock
         would place generated reply text into the forward's note. The offer returns with the
         reply editor; `placeDraft` flips the mode back for an arriving draft. */
      draftReply={(chrome.replyMode ?? "reply") === "forward" ? undefined : chrome.draftReply}
      /* In a stream the arrival is the stream's (`StreamHandle.reveal`). */
      land={stream ? false : undefined}
      focusOnOpen={stream ? stream.arriving : undefined}
    />
  );
}
