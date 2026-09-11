"use client";

/**
 * Replying inside the message. Reply used to navigate `#/ohbox` → `#/compose`, taking the message off
 * the screen at the moment you started answering it; this renders inside `<article class="msg">`, so
 * the subject, sender line and body stay put and the editor opens underneath. The conversation above
 * is the pane's, not this component's — an earlier `.reply-context` scroller repeated the focused
 * body, and the reader scrolled past a duplicate to reach the textarea — so this is head + textarea +
 * actions + status, scrolled into view on open. The payload never changed: sending is
 * `{inReplyTo, body}` with `body` exactly what was typed (`http-adapter.ts` `mailSend`); no quoted
 * original leaves the account. The draft is the client's own `localStorage` scratch per message.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslations } from "next-intl";
import { chordKeys, useBinding, useModGlyph } from "./keymap";
import { replySubject } from "@ohmail/client-engine";
import type {
  AddressBookEntry,
  ComposeAttachment,
  EmailAddress,
  EngineMessage,
} from "@ohmail/client-engine";
import { Button, Kbd, TextField } from "@ohmail/ui";
import { ComposeAttach, composeAttachCap } from "../components/ComposeAttach";
import { rowAddress, senderName } from "./format";
import { displayAddress } from "./idn";
import { canSend, sendStateFor, sendVerb, type SendState } from "./mail-send";
import { parseRecipients, type MailSend } from "./compose";
import { forwardEnvelopePlan, forwardSend } from "./forward-send";
import { HeldSendResolve } from "../components/HeldSendResolve";
import { RichEditor } from "./RichEditor";
import type { RichValue } from "./rich-text";
import type { DraftReplyControl, DraftedReply } from "./draft-reply";
import { SendStatus } from "./SendStatus";
import { useMailboxFacts } from "./MailStateProvider";
import {
  formatRecipientChips,
  optionsFromFacts,
  replyAllRecipients,
  replyEnvelopeOnWire,
  replyEnvelopePlan,
  replyRecipients,
  resolveReplyFrom,
  type ReplyEnvelopeEdit,
} from "./compose-from";
import {
  RecipientField,
  focusMovedChip,
  gatedInvalid,
  moveRecipient,
  type RecipientMove,
  type RecipientRow,
} from "./RecipientField";
import { SignatureBlock } from "./SignatureBlock";
import { SIG_FOLLOWING, type SignatureState } from "./signature";
import { durableSessionSet } from "./durable";

/*
 * The scratch-buffer helpers and `canSend` used to live here and now live in `mail-send.ts`,
 * with the send machine that consumes them — clearing the buffer is part of what "the send
 * landed" means, and `canSend` is shared with Compose. Keeping them here while
 * `mail-send.ts` imported them would also have made a real import cycle out of what used to
 * be a type-only one.
 */

/**
 * What the shell hands the editor about a drafted reply: the control that buys one, and the
 * one that has arrived and has not been placed yet.
 *
 * `pending` is separate from the control's own phases on purpose. The purchase is FINISHED by
 * then — the action is spent and the text exists — and what is left is a question about the
 * editor's contents that only the person typing in it can answer. Folding it into the control
 * would put "you already wrote something" on the same axis as "this costs one AI action",
 * where a cancel would read as cancelling a spend that has already happened.
 */
export interface DraftReplyChrome {
  control: DraftReplyControl;
  /** A draft that arrived into an editor that already had text, and the message it answers. */
  pending: { draft: DraftedReply; messageId: string } | null;
  /** Place it. `replace` drops what was typed; `append` puts the draft below it. */
  resolve: (mode: "replace" | "append") => void;
}

/**
 * The panel's height is the user's, within bounds — the drag, the keyboard arrows on the separator,
 * and the stored value read back on the next open all go through this clamp (a height dragged on a
 * tall window must not reopen taller than the window someone has now). The floor keeps the chrome
 * usable; the ceiling is the viewport's minus air, because a panel taller than the screen is chrome
 * nobody can reach. The CSS `max-height` on `.reply` states the same bound declaratively; this clamp
 * keeps the inline style honest before the stylesheet has to catch it.
 */
export const REPLY_PANEL_MIN_PX = 220;
export const REPLY_PANEL_VIEWPORT_MARGIN_PX = 48;
export function clampReplyHeight(px: number, viewportPx: number): number {
  const max = Math.max(REPLY_PANEL_MIN_PX, viewportPx - REPLY_PANEL_VIEWPORT_MARGIN_PX);
  return Math.min(Math.max(Math.round(px), REPLY_PANEL_MIN_PX), max);
}

/**
 * SESSION-scoped on purpose: a panel height is a working posture, not a setting. It survives
 * closing and reopening the editor (the cheap half the request asked for) and dies with the
 * tab. `sessionStorage` can throw in a private window; a panel that cannot remember its height
 * still resizes, so every access is fenced.
 */
const REPLY_HEIGHT_KEY = "ohmail.reply.panelHeight";
function readStoredReplyHeight(): number | null {
  try {
    const raw = window.sessionStorage.getItem(REPLY_HEIGHT_KEY);
    const n = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? clampReplyHeight(n, window.innerHeight) : null;
  } catch {
    return null;
  }
}
function storeReplyHeight(px: number): void {
  // A panel that cannot remember still resizes; the refusal is announced once.
  durableSessionSet(REPLY_HEIGHT_KEY, String(px), "reply.panelHeight");
}

export function InlineReply({
  message,
  mode = "reply",
  replyAll = false,
  value,
  send = { phase: "idle" },
  onChange,
  onClose,
  onSend,
  draftReply,
  envelope = null,
  onEnvelope,
  book = [],
  fromId = null,
  onFrom,
  attachments = [],
  onAttachments,
  sendSurfaceMaxTotalBytes,
  signatures,
  signaturesHtml,
  sig = SIG_FOLLOWING,
  onSig,
  subjectEdit = null,
  onSubject,
  heldResolve = null,
}: {
  message: EngineMessage;
  /**
   * A REPLY, OR A FORWARD — the chrome's `replyMode`, defaulted so every existing mount is a
   * plain reply. Forward mode changes exactly two things, both stated where they happen: the
   * audience is the user's to pick (the recipient rows open at once, empty, and Send stays
   * locked until one parses — see `forwardEnvelopePlan`), and the lock judges the forward
   * mutation (`forwardSend`: `forwardOf`, no `inReplyTo`) instead of the reply's. The body,
   * the From resolution, the attachments and the send machinery are the same editor.
   */
  mode?: "reply" | "forward";
  /**
   * ANSWER EVERYONE ON THE MESSAGE, not the sender alone. The head then names the reply-all
   * envelope — `replyAllRecipients`, the same pure call `AppShell.sendReply` resolves for the
   * wire — so what the editor claims and what leaves the account are one decision. When that
   * call returns `null` (the audience degenerates to the plain reply's), the head AND the send
   * both fall back to the plain path, for the same reason from the same function.
   */
  replyAll?: boolean;
  /**
   * BOTH HALVES — the markup and the plain rendering of it. `text` is what `canSend` judges
   * and what the optimistic row shows; `html` is what goes on the wire when there is any.
   * See `rich-text.ts`, which owns the storage rules for the same pair.
   */
  value: RichValue;
  /** How the send is going — see `mail-send.ts`. Defaults to idle for panes with no shell. */
  send?: SendState;
  onChange: (next: RichValue) => void;
  onClose: () => void;
  onSend: () => void;
  /**
   * The AI drafter's offer, rendered above the editor the draft lands in. Deliberately not a modal:
   * compose was moved out of a dialog because the keyboard could not leave it, and a purchase
   * confirmation would put one back over the message being answered. What is being bought is text for
   * this editor, so the price and the destination share the screen and cancelling leaves the
   * half-written reply untouched. Optional, because this component is mounted bare in more than one
   * harness and in the desktop shell, where there is no drafter to offer.
   */
  draftReply?: DraftReplyChrome;
  /**
   * THE USER'S EDIT OF THE AUDIENCE, or `null` while the computed one stands — held by the
   * SHELL (like `replyBody`, and for the identical reason: `MessagePane` is mounted twice
   * while the reader is open, and two copies of who a reply goes to is how the visible head
   * and the sent envelope stop being one object). `null` means the head below renders the
   * computed audience and the wire carries the computed envelope, exactly as before this
   * field existed.
   */
  envelope?: ReplyEnvelopeEdit | null;
  /**
   * Report an edit. ABSENT means this surface has nowhere to keep one — the inert chrome, a
   * bare harness — and then the head stays a plain statement rather than a dead button.
   */
  onEnvelope?: (next: ReplyEnvelopeEdit) => void;
  /** `addressBook(reader)` for the recipient rows' suggestions. Empty where no mirror is. */
  book?: readonly AddressBookEntry[];
  /**
   * THE SENDER THE USER PICKED ON THIS REPLY, or `null` while the derived one stands — held by
   * the SHELL (like `envelope`, and for the identical reason: `MessagePane` is mounted twice while
   * the reader is open, and two copies of who a reply comes FROM is how the visible From line and
   * the sent `mailboxId` stop being one object). It feeds `resolveReplyFrom` here so the line and
   * the wire read one resolution, and it is per-message: the shell drops it when the editor
   * retargets, so a pick never rides to somebody else's mail.
   */
  fromId?: string | null;
  /**
   * Report a From pick. ABSENT means this surface cannot hold one — the inert chrome, a bare
   * harness, the desktop shell — and then the From line stays a plain statement rather than a
   * selector nothing is listening to, exactly as before this field existed.
   */
  onFrom?: (mailboxId: string) => void;
  /**
   * FILES TO RIDE THE SEND — held by the SHELL beside the reply body (mounted-twice again) and
   * carried onto the `mail_send` mutation, never into the `localStorage` reply scratch: the bytes
   * are zero-at-rest exactly as compose's are (`ComposeAttachment`). Empty on a plain reply.
   */
  attachments?: readonly ComposeAttachment[];
  /**
   * Report an attachment-list change. ABSENT means this surface has nowhere to keep files — the
   * inert chrome and every provider-less mount — and then no attach control is rendered at all,
   * rather than a dead one.
   */
  onAttachments?: (next: ComposeAttachment[]) => void;
  /**
   * THE HOST'S OWN CEILING on what a send from this window can carry — threaded from
   * `AppShell.sendSurfaceMaxTotalBytes` through the chrome, and handed with the resolved
   * From's `SIZE` announcement to {@link composeAttachCap}, which holds the whole rule. ABSENT
   * (every browser tab, every bare harness) resolves to the strict constant exactly as before
   * this prop existed; `null` is the desktop's standalone door, where the sending mailbox's
   * own announcement governs.
   */
  sendSurfaceMaxTotalBytes?: number | null;
  /**
   * THE ACCOUNT'S STORED SIGNATURES, server-confirmed — handed down only once the shell's
   * consent read has answered (`signaturesKnown`). ABSENT means "cannot know" (the inert
   * chrome, a bare harness, the desktop's standalone door), and then no block renders: a block
   * drawn from a guess would serialize words the account may not sign with.
   */
  signatures?: Readonly<Record<string, string>>;
  /**
   * THE ACCOUNT'S STORED SIGNATURE MARKUP, server-confirmed — `useConsentState().signaturesHtml`,
   * handed down beside {@link signatures} and gated on the same flag (mail 0098). Only the
   * mailboxes whose signature has formatting appear; an absent KEY is "this signature is plain",
   * and an absent MAP is "this surface cannot know", which the block reads as the plain shape.
   */
  signaturesHtml?: Readonly<Record<string, string>>;
  /**
   * THE SIGNATURE BLOCK'S STATE for this message — held by the SHELL (mounted-twice, like
   * `envelope` and `fromId`) and reset when the editor retargets: a removal belongs to the
   * message it was struck on. Defaults to `following`, the resting state.
   */
  sig?: SignatureState;
  /** Report a strike or an inline edit. ABSENT ⇒ nowhere to keep one ⇒ no block at all. */
  onSig?: (next: SignatureState) => void;
  /**
   * THE SUBJECT AS EDITED, or `null` while the derived one (`Re:` + the parent's) stands —
   * held by the SHELL for the mounted-twice reason every peer above states. `null` keeps the
   * wire byte-identical to the untouched reply: no `subject` rides the mutation and
   * `Engine.enrich` derives it exactly as before.
   */
  subjectEdit?: string | null;
  /**
   * Report a subject edit. ABSENT means this surface has nowhere to keep one — the inert
   * chrome, a bare harness — and then the subject renders as the plain sentence it always
   * was rather than a control nothing is listening to.
   */
  onSubject?: (subject: string) => void;
  /**
   * THE HELD REPLY'S WAY OUT — the row the hold is about, and where the reader's answer goes.
   *
   * A reply whose send the server took and never confirmed leaves its row at `unverified`. Drafts
   * listed it with the two verbs; this editor showed nothing, so the one surface the reader would
   * reach for had no way to settle it. `null` for every editor that is not holding such a row.
   */
  heldResolve?: {
    draftId: string;
    onResolve: (draftId: string, outcome: "arrived" | "not_arrived") => void;
  } | null;
}) {
  const t = useTranslations("reply");
  /** `compose` owns the forwarding honesty line — one sentence, both surfaces. */
  const tc = useTranslations("compose");
  const box = useRef<HTMLDivElement>(null);

  /**
   * Drag-to-resize. `null` means nobody has dragged this session and the stylesheet's default posture
   * stands (`.reply` in app.css); a number is the user's height, clamped through
   * {@link clampReplyHeight} on every write and on the read back, and mirrored to `sessionStorage` so
   * reopening keeps the posture. The inline style sets both `height` and `min-height`: the default
   * floor is taller than the drag floor and `min-height` outranks `height`, so without the override a
   * panel dragged small would spring back. No transition rides the drag — direct manipulation is its
   * own motion, so there is nothing for `prefers-reduced-motion` to neutralize.
   */
  const [panelPx, setPanelPx] = useState<number | null>(() =>
    typeof window === "undefined" ? null : readStoredReplyHeight(),
  );
  const setPanelHeight = (px: number): void => {
    const next = clampReplyHeight(px, window.innerHeight);
    setPanelPx(next);
    storeReplyHeight(next);
  };
  /**
   * Where a resize starts from: the user's own height when one is set (it IS the rendered
   * height then — the inline style), otherwise whatever the stylesheet's default posture
   * rendered. Stated in that order because they only differ where layout does not run
   * (jsdom renders every box 0 tall), and there the set height is the truthful base.
   */
  const currentPanelPx = (): number => panelPx ?? box.current?.offsetHeight ?? 0;
  const dragFrom = useRef<{ y: number; h: number } | null>(null);
  const onGripPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    dragFrom.current = { y: e.clientY, h: currentPanelPx() };
    // jsdom has no pointer capture; the window listeners below are the mechanism, capture is
    // only the nicety that keeps the cursor owned while it leaves the grip.
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const move = (ev: PointerEvent): void => {
      const from = dragFrom.current;
      if (!from || !box.current) return;
      // Up is taller: the grip is the TOP edge, so the height grows by how far the pointer rose.
      setPanelHeight(from.h + (from.y - ev.clientY));
    };
    const up = (): void => {
      dragFrom.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  /** The separator is focusable, so the keyboard gets the same resize the pointer has. */
  const onGripKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    // The grip lives inside the reading column, where the zone walk (`zone-nav.tsx`) reads
    // ↑/↓ as "scroll the message" — without this stop one press would resize AND scroll.
    // `stopImmediatePropagation` on the NATIVE event, because in the deployed App Router
    // React and the registry are sibling listeners on `document` and `stopPropagation`
    // cannot stop a sibling (MoreMenu measured this on the deployed build).
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    setPanelHeight(currentPanelPx() + (e.key === "ArrowUp" ? 24 : -24));
  };

  /**
   * Which address is answering. A reply goes out from the mailbox the message arrived in
   * (`Engine.enrich` derives it from the parent); the editor now says so. The same pure call
   * `AppShell.sendReply` makes, over the same options, so the sentence and the id on the wire are one
   * decision; `resolveReplyFrom` returns nothing when the facts cannot be seen (Desktop, demo, a pane
   * mounted with no provider) and no line renders — a From line is a claim. The mirror's `"mailbox"`
   * entities are deliberately not consulted: reading them needs `useEngine()`, which throws outside
   * an `EngineProvider`, and the substitution this line exists to show is a fact only
   * `GET /mailboxes` holds — the fixture rows carry no status.
   */
  const facts = useMailboxFacts();
  const options = facts ? optionsFromFacts(facts) : [];
  // NO RECIPIENTS IN THIS CALL, and that is the rule rather than an omission: a reply answers
  // from the mailbox the message ARRIVED IN, so who it is addressed to has no say. The compose
  // surface's domain match (`domainMatchedFrom`) is deliberately not reachable from here.
  const from = resolveReplyFrom(options, message.mailboxId, fromId ?? null);
  // `useId`, not a static id: this editor is mounted twice while the reader is open, and a
  // duplicate `id`/`for` pair would tie the label to whichever select the document walked to first.
  const fromSelectId = useId();

  /**
   * WHO THIS IS ADDRESSED TO. `enrich` answers `[parent.from]` by default, which is yourself on
   * a message you sent — so on a self-authored message (a thread you started, or your own turn
   * in one) the head would read "To: <you>" while the wire, corrected in `AppShell.sendReply`,
   * goes to the correspondent. `replyRecipients` closes that gap here so the head names the same
   * recipient the send carries; it returns `null` for the ordinary case and when the facts are
   * unreadable, and then the head falls back to the sender exactly as before.
   */
  const recipients = replyRecipients(message, options.map((o) => o.address));
  const target = recipients?.[0] ?? null;

  /**
   * The subject, editable in place (replies only). Derived at send (`Re:` + the parent's, the
   * `replySubject` rule), it renders as plain text in the head — on almost every reply it is a fact,
   * not a decision. Clicking edits it in place and exposes the full subject: the `Re:` prefix is part
   * of the text, derived exactly once and never re-stacked. The value lives on the shell
   * (`subjectEdit`, mounted-twice rule); only "is the input open" is local, and it closes when the
   * editor retargets. Threading never depends on this text — the server sends
   * `In-Reply-To`/`References` from the parent row whatever the subject says (`send-service.ts`).
   */
  const outgoingSubject = subjectEdit ?? replySubject(message.subject);
  const [editingSubject, setEditingSubject] = useState(false);
  useEffect(() => { setEditingSubject(false); }, [message.id]);
  // The head names people; the ENVELOPE is `recipients` itself, which `AppShell.sendReply` reads
  // and which is never touched here. So the two lines below are decoded for display (`idn.ts`) and
  // the comparison that decides whether the address adds anything stays on the stored strings.
  const toName = target ? target.name ?? displayAddress(target.address) : senderName(message);
  const toAddr = target
    ? (target.name && target.name !== target.address ? displayAddress(target.address) : undefined)
    : rowAddress(message);

  /**
   * THE REPLY-ALL ENVELOPE, when this editor was opened as one — see the `replyAll` prop. The
   * same options feed it that feed the plain head above, so both heads and the wire read one
   * set of facts. `null` (a 1:1 message, or an audience the facts cannot enlarge) falls back
   * to the plain head below rather than claiming an "all" that is one person.
   */
  const all = replyAll ? replyAllRecipients(message, options.map((o) => o.address)) : null;
  const nameOf = (r: { name: string | null; address: string }): string =>
    r.name ?? displayAddress(r.address);

  /**
   * The audience is always editable. The head that names it is a button; pressing it turns the
   * computed audience into three editable recipient rows (To, Cc, Bcc — the same chip field every
   * compose surface uses), prefilled with exactly what the head claimed (`formatRecipientLine` over
   * the same `all`/`recipients` the sentences rendered). From that press the user's strings are the
   * envelope (`replyEnvelopePlan`) — a reply's computed audience is a default, not a cage. Untouched
   * (`envelope === null`) nothing changes: the wire carries the computed envelope byte-for-byte, and
   * `test/inline-reply.test.ts` pins the mutation's exact key set for that case.
   */
  const expand = onEnvelope === undefined
    ? undefined
    : (): void => {
        // A forward derives NO audience — its rows open empty (the shell seeds them on open;
        // this is the bare-mount way in, and it must not smuggle the reply's derivation in).
        if (mode === "forward") {
          onEnvelope({ to: "", cc: "", bcc: "" });
          return;
        }
        const to = all ? all.to : recipients ?? [message.from];
        // The trailing separator is what makes every prefilled entry a CHIP rather than text
        // sitting in the input — see `formatRecipientChips`, which is the shared rule for
        // every surface that seeds a recipient field from settled addresses.
        onEnvelope({
          to: formatRecipientChips(to),
          cc: formatRecipientChips(all ? all.cc : []),
          bcc: "",
        });
      };

  /**
   * Bring the editor to the reader. The conversation is the real thread inside the scrolling column (no
   * scroller of its own — app.css), so on a deep thread the editor can open below the fold. `focus()` scrolls
   * only the caret, so the box is scrolled separately with `block: "end"`: the bottom edge — the Send/Cancel
   * row — lands on screen, not merely the head. `scrollIntoView` is optional-chained on the method, not only
   * the node; jsdom lacks it (see `test/body-open.test.ts`). Focus is the editor's own job: `RichEditor`
   * focuses on mount with `autoFocus`, and keying it on the message id remounts it when the pane swaps — a new
   * message gets its own empty document and undo history. Reaching in through the handle would race:
   * `immediatelyRender: false` means there is no editor at all during the commit this effect runs in.
   */
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: "end" });
  }, [message.id]);


  const inFlight = send.phase === "sending" || send.phase === "queued";
  const verb = sendVerb(send, "reply");
  // LOCKED, not merely styled: `disabled` is what stops a second key being minted. Shared
  // with the state machine — see `canSend`. The mutation it judges carries the SAME envelope
  // fields `AppShell.sendReply` will put on the wire (`replyEnvelopePlan` over the same
  // options and the same edit — one derivation, two consumers), so the button and the machine
  // cannot reach different verdicts; an untouched reply still judges `{inReplyTo, body}` plus
  // the computed audience, which `canSend`'s reply branch never refuses when non-empty.
  // `body: value.text` and not the markup: `canSend` refuses an empty body, and an empty
  // ProseMirror document is `<p></p>` — four characters that would light Send up on a reply
  // nobody has written. The plain rendering is the only half that answers "is there anything
  // here", which is the same rule `isRichEmpty` states.
  const envPlan =
    mode === "forward"
      ? forwardEnvelopePlan(envelope, options.map((o) => o.address))
      : replyEnvelopePlan(message, options.map((o) => o.address), replyAll, envelope);
  /** Is the send chord bound here (a provider stands above)? Gates the Send button's keycap. */
  const sendChord = useBinding("mod+Enter");
  const mod = useModGlyph();
  /**
   * THE MUTATION AS IT WOULD GO OUT RIGHT NOW — built once, judged by `canSend` and read by the
   * status line's own narrowing. It was inlined into the `canSend` call; the status line needs the
   * same value (an unresolved send parks the message it belongs to and must not put a warning
   * above a different one — see `sendStateFor`), and two builders would be two answers.
   */
  const wouldSend: MailSend = mode === "forward"
    ? // The forward mutation, via the same builder `AppShell.sendReply`'s forward arm uses —
      // one derivation, so the lock and the wire cannot disagree. `canSend`'s non-reply
      // branch is the gate that keeps Send locked until a recipient parses AND a sending
      // mailbox resolves.
      forwardSend(message, {
        body: value.text,
        // The resolved sender, or the mailbox the message ARRIVED in — the same default
        // `enrich` derives for a reply. Facts can be unreadable (the demo, the desktop's
        // bare panes), and a forward that can never send there would be a dead control.
        mailboxId: from.mailboxId ?? message.mailboxId,
        plan: envPlan,
      })
    : {
        kind: "mail_send",
        inReplyTo: message.id,
        body: value.text,
        ...replyEnvelopeOnWire(envPlan),
      };
  const locked = !canSend(send, wouldSend);

  /**
   * THE FROM CONTROL, BUILT ONCE — the same `<select>` whether it stands in the collapsed
   * caption or in the opened recipients stack, because it is the same decision: which address
   * answers. Two renderings of one control, never two controls.
   */
  const fromSelect = onFrom && from.choices.length > 1 ? (
    <span className="c-select">
      <select
        id={fromSelectId}
        className="c-input"
        value={from.mailboxId ?? ""}
        disabled={inFlight}
        onChange={(e) => onFrom(e.target.value)}
      >
        {/* Value is the mailbox id, label the address a human reads — the shape
            `ComposeView` uses. Sendable choices only, so a disconnected address is never
            offered and the wire cannot carry one the server would refuse. */}
        {from.choices.map((o) => (
          <option key={o.id} value={o.id}>{displayAddress(o.address)}</option>
        ))}
      </select>
    </span>
  ) : null;
  const fromSub = from.substituted ? (
    <span className="reply-from-sub">
      {from.substitutedFrom
        ? t("fromSubstituted", { was: displayAddress(from.substitutedFrom) })
        : t("fromSubstitutedUnknown")}
    </span>
  ) : null;

  /**
   * From, inside the opened recipients stack — the first row, in the compose header's own `.c-field`
   * grammar, so From, To, Cc and Bcc share one label gutter and one input line. As a caption below the
   * stack it broke twice at once: the inline label put the value at a different indent than every
   * other row, and opening Cc/Bcc grew the stack above it inside the old scrolling dock — the From
   * line read as disappearing the moment Cc/Bcc switched on. As a `flex: none` row of the pinned
   * chrome nothing the stack does can displace it. Rendered exactly when the collapsed caption would
   * have been (`from.address !== null` — a From line is a claim), with the same substitution note.
   */
  const fromRow = from.address !== null ? (
    <div className="c-field reply-from-row">
      <label htmlFor={fromSelectId}>{t("fromLabel")}</label>
      {fromSelect ?? (
        <output id={fromSelectId} className="c-static">{displayAddress(from.address)}</output>
      )}
      {fromSub}
    </div>
  ) : null;

  /** The head's own sentence — shared by the static head and the button that opens the edit. */
  const headContent = mode === "forward" ? (
    // A forward names NO audience until the user picks one — a head that claimed a recipient
    // here would be inventing the exact default `forwardEnvelopePlan` refuses to derive.
    <b>{t("forwardHead")}</b>
  ) : all ? (
    <>
      <b>{t("toAll", { names: all.to.map(nameOf).join(", ") })}</b>
      {/* The Cc line, only when the envelope carries one — an empty "Cc" is a claim. */}
      {all.cc.length > 0 ? <small>{t("ccLine", { names: all.cc.map(nameOf).join(", ") })}</small> : null}
    </>
  ) : (
    <>
      <b>{t("to", { name: toName })}</b>
      {/* Only when it adds something — see `rowAddress`. */}
      {toAddr ? <small>{toAddr}</small> : null}
    </>
  );

  return (
    <div
      className="reply"
      data-reply-for={message.id}
      ref={box}
      /* Both `height` AND `min-height`, or a drag below the stylesheet's default floor
         silently springs back — see the state's own note. `undefined` leaves the default
         posture entirely to the stylesheet. */
      style={
        panelPx !== null
          ? { height: `${panelPx}px`, minHeight: `${REPLY_PANEL_MIN_PX}px` }
          : undefined
      }
    >
      {/* THE GRIP — the panel's top edge is the handle that sets its height. A separator in
          the ARIA sense (it splits the conversation above from the editor below and is
          focusable), so the keyboard has the same control the pointer does: arrows nudge,
          the drag is free. `aria-valuenow` only once a height exists — before the first drag
          the posture is the stylesheet's clamp, and announcing a number would be inventing
          one. */}
      <div
        className="reply-grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t("resize")}
        tabIndex={0}
        aria-valuemin={REPLY_PANEL_MIN_PX}
        aria-valuemax={
          typeof window === "undefined"
            ? undefined
            : Math.max(REPLY_PANEL_MIN_PX, window.innerHeight - REPLY_PANEL_VIEWPORT_MARGIN_PX)
        }
        aria-valuenow={panelPx ?? undefined}
        onPointerDown={onGripPointerDown}
        onKeyDown={onGripKeyDown}
      >
        <span className="reply-grip-bar" aria-hidden="true" />
      </div>

      {envelope !== null && onEnvelope ? (
        <ReplyRecipients
          envelope={envelope}
          onEnvelope={onEnvelope}
          book={book}
          disabled={inFlight}
          fromRow={fromRow}
        />
      ) : expand ? (
        // The head IS the way in: pressing the audience opens it for editing. A button and
        // not a div-with-onClick, because "recipients always editable" has to be true from
        // the keyboard too. The hint is part of the accessible name, so a screen reader
        // hears what pressing does rather than only whom the reply addresses.
        <button type="button" className="reply-head reply-head-btn" onClick={expand} disabled={inFlight}>
          {headContent}
          <span className="reply-head-edit">{t("editRecipients")}</span>
        </button>
      ) : (
        <div className="reply-head">{headContent}</div>
      )}

      {/* THE SUBJECT — plain text until pressed, an input while editing; see the note at
          `outgoingSubject`. Replies only: a forward carries its own `Fwd:` subject through
          `forwardSend` and its head already explains itself. Absent `onSubject` (the inert
          chrome, a bare harness) renders the plain sentence rather than a dead control. */}
      {mode === "reply" && onSubject ? (
        editingSubject ? (
          <TextField
            shape="line"
            className="reply-subject-input"
            type="text"
            aria-label={t("subjectAria")}
            value={outgoingSubject}
            disabled={inFlight}
            autoFocus
            onChange={(e) => onSubject(e.target.value)}
            onBlur={() => setEditingSubject(false)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== "Escape") return;
              // Escape closes the INPUT, not the editor — the escape cascade's innermost rule.
              // Native stopImmediatePropagation because the keymap registry is a sibling
              // listener on `document` (the grip's measured reason, two blocks up).
              e.preventDefault();
              e.stopPropagation();
              e.nativeEvent.stopImmediatePropagation();
              setEditingSubject(false);
            }}
          />
        ) : (
          <button
            type="button"
            className="reply-subject"
            disabled={inFlight}
            onClick={() => setEditingSubject(true)}
          >
            <span className="reply-subject-text">{outgoingSubject}</span>
            <span className="reply-subject-hint">{t("editSubject")}</span>
          </button>
        )
      ) : null}

      {/* THE FORWARDING HONESTY LINE — `compose.forwardingNote`, the compose surface's own
          sentence, because the fact is the same fact: the body here is the user's note, and
          the quoted original plus its attachments are added by the SERVER at send. Without
          it the editor shows an empty body and reasonably reads as forwarding nothing. */}
      {mode === "forward" ? (
        <p className="reply-forwarding">{tc("forwardingNote")}</p>
      ) : null}

      {/* FROM — a control when there is a choice, otherwise the sentence. This used to be
          static text on the premise that a reply's sender is a fact; it is editable when the
          account genuinely has one. A reply still has a right answer (the address the sender
          wrote to), so the derived one LEADS: the selector is offered only with more than one
          sendable address AND a shell that can hold a pick (`onFrom`). One address, or a surface
          that cannot keep an override, renders the plain statement; no facts renders nothing —
          a From line is a claim. A pick and the substitution notice are mutually exclusive by
          construction: an honored pick makes `from.substituted` false (`resolveReplyFrom`), so
          choosing an address silences the "answers from the address above" line — re-announcing
          it would claim the user was overruled when they were obeyed. */}
      {/* Collapsed head only: while the recipients stack is open, From stands as its FIRST
          row (`fromRow` above) — one aligned block, never a caption trailing a stack that can
          grow over it. */}
      {from.address !== null && (envelope === null || !onEnvelope) ? (
        <p className="reply-from">
          {fromSelect ? (
            <span className="reply-from-pick">
              <label htmlFor={fromSelectId} className="reply-from-label">{t("fromLabel")}</label>
              {fromSelect}
            </span>
          ) : (
            <span>{t("from", { address: displayAddress(from.address) })}</span>
          )}
          {fromSub}
        </p>
      ) : null}

      {draftReply ? <DraftReplyCard chrome={draftReply} messageId={message.id} /> : null}

      {/* NO QUOTED CONTEXT HERE. It was a `.reply-context` scroller between the head and the
          editor; the conversation it held is the pane's, above — see the header.

          KEYED ON THE MESSAGE. ProseMirror owns a document, a selection and an undo history,
          and none of the three belongs to the next message the pane swaps to. The key is also
          what makes `autoFocus` mean "focus the reply you just opened" rather than "focus the
          first reply ever opened in this pane". */}
      <RichEditor
        key={message.id}
        className="reply-editor"
        /* AND ITS SCREEN-READER TWIN, on the same branch. A sighted reader saw "Write your
           message…" on a forward while a screen reader still heard "Reply body" for the same
           field — half-applied by construction, so both halves move together. The Reply Run's
           overlay keeps `reply.editorAria`: that surface is only ever a reply. */
        ariaLabel={mode === "forward" ? t("forwardEditorAria") : t("editorAria")}
        /* THE PLACEHOLDER FOLLOWS THE MODE, like `forwardHead` and the forwarding note above.
           One key served both, so a forward — which has no reply in it — invited the author to
           "Write your reply…". The forward's sentence is the compose editor's own, because it is
           the same act: a message of your own, above the one being passed on. */
        placeholder={mode === "forward" ? t("forwardPlaceholder") : t("placeholder")}
        autoFocus
        value={value}
        /* The text is never taken away from the author, not even mid-send: a failed send
           whose draft had been cleared would be a reply the user has to write twice. It stops
           taking INPUT, which is the textarea's `readOnly` this replaces. */
        editable={!inFlight}
        onChange={onChange}
      />

      {/* THE SIGNATURE — the same distinct, removable block Compose renders, below the
          writing area (`SignatureBlock`; `signature.ts` owns the model). On a reply there is
          no quoted history in the outgoing body at all, and on a forward the server appends
          the quote AFTER the body it is handed — so the signature the block shows always sits
          ABOVE any quoted history in what the recipient reads. Rendered only where the shell
          can hold its state (`onSig`) AND the stored signatures are server-confirmed. */}
      {onSig && signatures !== undefined ? (
        <SignatureBlock
          sig={sig}
          onSig={onSig}
          signatures={signatures}
          signaturesHtml={signaturesHtml}
          mailboxId={from.mailboxId}
          disabled={inFlight}
        />
      ) : null}

      {/* ATTACHMENTS — files ride the send, never the account and never the scratch buffer
          (`compose-from`/`mail-send`: the reply buffer serialises only the body). Rendered only
          where the shell can hold the bytes (`onAttachments`); the cap follows the resolved From,
          so switching the sender moves the ceiling exactly as it does in compose. Disabled
          mid-send like every other input. */}
      {onAttachments ? (
        <ComposeAttach
          attachments={[...attachments]}
          onChange={onAttachments}
          disabled={inFlight}
          maxTotalBytes={composeAttachCap(from.maxMessageBytes, sendSurfaceMaxTotalBytes)}
          /* The reply panel takes pastes and drops exactly as compose does — a pasted picture
             is an attachment, not a silent nothing (`ComposeAttach.dropZone`). */
          dropZone={box}
        />
      ) : null}

      <div className="reply-actions">
        <Button
          variant="primary"
          disabled={locked}
          aria-busy={send.phase === "sending" || undefined}
          // THE BUTTON CARRIES THE LANE'S PHASE — see `sendVerb`. It is the same attribute and the
          // same word on both send surfaces, because "sent" and "queued" differ by whether the
          // mail is gone and a surface may not reach its own verdict about that.
          data-send={verb.attr}
          onClick={() => onSend()}
        >
          {t(verb.key)}
          {/* The verb's chord, from the live registry — the action-bar law (§12): an action
              button wears its keycap always; a provider-less mount has no binding, no cap. */}
          {sendChord ? <Kbd>{chordKeys("mod+Enter", mod).join(" ")}</Kbd> : null}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t("cancel")}
        </Button>
        <span className="reply-hint">
          <Kbd>esc</Kbd> {t("hintEsc")}
        </span>
      </div>

      <SendStatus send={sendStateFor(send, wouldSend)} scope="reply" />
      {/* THE VERBS SIT WHERE THE SENTENCE IS, and off the SAME narrowed state: an unresolved send
          on this lane that does not name this message puts no warning up, so it must offer no
          answer either. The row is the shell's; this component dispatches nothing itself. */}
      {heldResolve !== null && sendStateFor(send, wouldSend).phase === "unverified" ? (
        <HeldSendResolve draftId={heldResolve.draftId} onResolve={heldResolve.onResolve} />
      ) : null}
    </div>
  );
}

/**
 * The drafter's card — the price before the spend, then the one question the spend leaves open.
 * It says what it costs in the unit the plan is sold in: "15 credits". This used to say the
 * reverse ("'1 AI action', never credits"), which was right while every action cost one credit;
 * weighted debits ended that — a draft is fifteen against a classification's one, so quoting
 * "1 action" would name a number the server does not charge. The number is
 * `DRAFT_REPLY_COST_CREDITS`, what the route charges per accepted request — not a figure derived
 * from a balance this tab holds. Whether the account can afford it is the server's decision;
 * a refusal arrives as the server's own sentence, rendered verbatim (`draft-reply.ts`).
 */

/**
 * And it never clobbers what somebody wrote: a draft landing in an empty editor goes straight
 * in; one landing on a half-written reply asks — replace, or add below — and the editor keeps
 * its text until answered. No third option to dismiss, because the action is already paid for
 * by the time this appears and throwing the result away behind a small button is not something
 * to make easy. Nothing here sends and nothing dispatches a mutation: a generated draft is not
 * an answered message — the Reply Run's debt is discharged by a send settling and nothing else
 * (`onSendSettled`), which is why this card can only put text in a box.
 */
function DraftReplyCard({
  chrome,
  messageId,
}: {
  chrome: DraftReplyChrome;
  messageId: string;
}) {
  const t = useTranslations("draftReply");
  const { control, pending, resolve } = chrome;

  // The placement question wins when both could render: the purchase is over, and the offer
  // it came from has already closed itself.
  if (pending && pending.messageId === messageId) {
    return (
      <div className="dr-card" role="group" aria-label={t("replaceTitle")}>
        <b className="dr-title">{t("replaceTitle")}</b>
        <p className="dr-body">{t("replaceBody")}</p>
        <div className="dr-btns">
          <Button variant="primary" onClick={() => resolve("append")}>{t("append")}</Button>
          <Button onClick={() => resolve("replace")}>{t("replace")}</Button>
        </div>
      </div>
    );
  }

  // An offer belongs to the message it was opened on. Without this the card would follow the
  // reader to whatever message it was pointed at next, still quoting a price for the first one.
  if (control.phase === "closed" || control.messageId !== messageId) return null;

  const running = control.phase === "running";
  return (
    <div className="dr-card" role="group" aria-label={t("offerTitle")}>
      <b className="dr-title">{t("offerTitle")}</b>
      <p className="dr-body">{t("offerBody")}</p>
      <div className="dr-btns">
        <Button variant="primary" disabled={running} onClick={control.confirm}>
          {t("confirm")}
        </Button>
        <Button variant="ghost" disabled={running} onClick={control.cancel}>
          {t("cancel")}
        </Button>
      </div>
      {/* Whatever the server said, verbatim — an empty balance, a message the drafter is not
          allowed to read, no model connected on this deployment. Each is a different actionable
          fact and none of them is inferable from a status code. */}
      {control.notice ? (
        <p className="dr-note" role="status">{control.notice}</p>
      ) : null}
    </div>
  );
}

/**
 * The opened audience — To, Cc, Bcc as the same chip rows Compose has, over the edit strings
 * the shell holds. The markup deliberately mirrors `ComposeView`'s header rows (`.c-field`, the
 * label gutter, the error line under its row) because "wherever this appears" means the SAME
 * field, not a cousin. What differs is only what must: ids come from `useId` (this editor is
 * mounted twice while the reader is open, and `compose-to` may exist on another route's DOM),
 * and invalid entries are parsed here from the strings, gated by the same still-typing rule
 * (`gatedInvalid`).
 */

/**
 * Cc and Bcc are already open — no second click. Opening this stack IS the "change recipients"
 * act, so all three rows show at once. The compose form's fold (`ccBccOpen`) does not apply
 * here, and used to: the head press revealed a To row with a second `Cc/Bcc` toggle inside it,
 * so reaching a blind copy from a reply took two clicks about one decision. The rows keep
 * whatever the user leaves in them — the strings are the shell's envelope state, so nothing
 * here can fold a row back over its contents. Cross-row moves (drag, Alt+arrows) land in ONE
 * `onEnvelope` via `moveRecipient`, for the reason `ComposeView.moveChip` states: two onChange
 * calls would each spread a stale copy of the other row.
 */
function ReplyRecipients({
  envelope,
  onEnvelope,
  book,
  disabled,
  fromRow = null,
}: {
  envelope: ReplyEnvelopeEdit;
  onEnvelope: (next: ReplyEnvelopeEdit) => void;
  book: readonly AddressBookEntry[];
  disabled: boolean;
  /**
   * The From row, composed by `InlineReply` (which owns the resolution and the pick), rendered
   * FIRST so the opened audience reads as one aligned stack: From, To, Cc, Bcc, every row in
   * the `.c-field` grammar with the shared label gutter. `null` where a From line would be a
   * claim nobody can back (no mailbox facts).
   */
  fromRow?: ReactNode;
}) {
  const t = useTranslations("compose");
  const base = useId();
  const [focused, setFocused] = useState<Record<RecipientRow, boolean>>({
    to: false, cc: false, bcc: false,
  });

  const move = (mv: RecipientMove): void => {
    const next = moveRecipient(envelope, mv);
    if (!next) return;
    onEnvelope(next);
    focusMovedChip(`${base}-${mv.to}`, mv.entry);
  };

  const row = (r: RecipientRow): ReactNode => {
    const shown = gatedInvalid(envelope[r], focused[r], parseRecipients(envelope[r]).invalid);
    const errId = `${base}-${r}-error`;
    return (
      <>
        <div className="c-field">
          <label htmlFor={`${base}-${r}`}>{t(r)}</label>
          <RecipientField
            id={`${base}-${r}`}
            value={envelope[r]}
            onChange={(next) => onEnvelope({ ...envelope, [r]: next })}
            book={book}
            disabled={disabled}
            invalid={shown.length > 0}
            describedBy={shown.length > 0 ? errId : undefined}
            onFocusChange={(f) => setFocused((cur) => ({ ...cur, [r]: f }))}
            row={r}
            onMove={move}
          />
        </div>
        {shown.length > 0 ? (
          <p className="c-error" id={errId}>{t("toInvalid", { entries: shown.join(", ") })}</p>
        ) : null}
      </>
    );
  };

  return (
    <div className="reply-rcpt">
      {/* From leads the stack — who this answers AS, then whom it answers TO. Every row below
          shares the `.c-field` gutter: one aligned block, all three recipient rows open. */}
      {fromRow}
      {row("to")}
      {row("cc")}
      {row("bcc")}
    </div>
  );
}
