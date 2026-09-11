"use client";

/**
 * The two things a rendered message needs from the shell, and why they are a context. `MessagePane`
 * is mounted in TWO places at once whenever the reader is open — the Ohbox's reading column and the
 * reader sheet both render the selected message. If each owned its own reply draft, the two editors
 * would hold different text and whichever one you looked at lost it: the draft lives in `AppShell`
 * and both panes read the same value; likewise the open screening popover. A context rather than
 * props because the read column's pane is three components deep inside a view that already takes
 * fifteen.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  BODY_FETCH_TIMEOUT_MS,
  type AddressBookEntry,
  type ComposeAttachment,
  type EngineMessage,
  type MessageBody,
} from "@ohmail/client-engine";
import type { AttachmentsChrome } from "./attachments";
import type { SendState } from "./mail-send";
import { EMPTY_RICH, type RichValue } from "./rich-text";
import type { DraftReplyChrome } from "./InlineReply";
import { SIG_FOLLOWING, type SignatureState } from "./signature";
import type { ReplyEnvelopeEdit } from "./compose-from";
import type { RemoteImagesChrome } from "./remote-images";

/**
 * The three sub-rows that can take the action bar's place. Declared HERE and not in
 * `MessagePane` because the chrome carries the open one (see `barPanel`), and the pane
 * importing the chrome's type is the direction that cannot cycle.
 */
export type MessageBarPanel = "move" | "resurface" | "delete";

export interface MessageChrome {
  /**
   * The reader's own addresses, so the header can fold a recipient that IS
   * the reader to "me". Rides the chrome for `conversationOf`'s reason:
   * `MessagePane` is mounted twice and holds no engine hook, and the answer
   * has one source — `GET /mailboxes`, resolved once in `AppShell`
   * (`ownAddresses`). A default of `[]` is a real answer, not a stub: a
   * surface with no mailbox facts (the desktop shell, a test) recognises
   * the reader nowhere, so every recipient renders in full — the honest
   * degradation. `recipientSummary` case-folds both sides.
   */
  ownAddresses: readonly string[];
  /**
   * The folders foundation flag, as the shell knows it (`consent.foldersEnabled`). NO LONGER THE
   * DELETE GATE, and no consumer reads it today: it used to gate both halves of the reader's
   * Delete, and that was wrong — delete files to the server's own \Trash, a system folder, so the
   * USER-folders foundation was never a fact about the verb; a folders-off account could delete a
   * picked pile and not the row under its cursor. `mirrorHolds` below is the whole gate now. Kept
   * as the chrome's declared copy of a foundation fact (`folders-rail.test.tsx` pins the supply); a
   * later reader must not read it as a delete gate.
   */
  foldersEnabled?: boolean;
  /**
   * Does the mirror hold this message — the Delete verb's ONLY gate now. The reader can show rows
   * the mirror deliberately does not hold (an off-mirror archive hit from Search), and
   * `message_delete` is an engine mutation over a local row: offered there it always fails. Absent
   * and `false` are different answers, and absent decides: ABSENT means "this shell has no mirror
   * probe" (the desktop shell, a bare mount) and ADMITS — `!== false`, `forwardAdmitted`'s reading;
   * `false` means "answered no for this row" and refuses. A shell that cannot answer is not a shell
   * whose mail may not be deleted — the mutation path still polices the row.
   */
  mirrorHolds?: (messageId: string) => boolean;
  /**
   * Absolute-time display — a session-and-view-scoped preference on the reader's stamps. Clicking
   * any stamp flips ALL of them to the absolute form at once, so a reader comparing dates across a
   * thread sees one shape rather than hovering each. It rides the chrome because the stamp is
   * rendered by `MessageHeader`/`MessageCard`, mounted several deep with no shell state, and more
   * than one stamp on screen must agree. Deliberately not persisted, reset on every view switch
   * (`AppShell`): a momentary gesture, not a setting. Default `false`, so a pane with no shell
   * shows relative and its stamp does nothing on click.
   */
  absoluteTime: boolean;
  onToggleAbsoluteTime: () => void;
  /**
   * The action bar's open destination panel (Move / Resurface / the delete confirm), shared across
   * every mount of the bar — the reply-draft argument applied to a strip: the focused message's bar
   * renders in the reading column AND the reader sheet, and a panel opened by key in one had to be
   * visible in the one being looked at. Keyed by message id so a panel can never render over a
   * different message's bar; the shell clears it when focus moves. Optional with a no-op setter
   * absent, so the inert default and provider-less mounts keep compiling — the bar falls back to
   * nothing open.
   */
  barPanel?: { messageId: string; panel: MessageBarPanel } | null;
  setBarPanel?: (next: { messageId: string; panel: MessageBarPanel } | null) => void;
  /** The message id whose inline reply editor is open, if any. */
  replyTo: string | null;
  /**
   * Whether that editor answers EVERYONE on the message (reply all) rather than the sender
   * alone. Set by the open (`AppShell.openReply(id, true)`); meaningful only while `replyTo`
   * is non-null. OPTIONAL, and absent means a plain reply — the inert default and every
   * provider-less mount keep compiling, exactly as `openReply` does.
   */
  replyAll?: boolean;
  /**
   * WHAT THE OPEN EDITOR IS — a reply, or a forward. Set by the open (`AppShell.openReply` /
   * `openForward`), meaningful only while `replyTo` is non-null, and OPTIONAL with absent
   * meaning `"reply"` for the same compatibility reason `replyAll` is. One editor, two modes,
   * because a forward is the reply's sibling inside the thread now (it used to leave for the
   * compose screen): the same dock, the same body, the same From and attachments machinery —
   * only the audience (user-picked, never derived) and the wire (`forwardOf`, no `inReplyTo`)
   * differ, and both differences derive from this one field.
   */
  replyMode?: "reply" | "forward";
  /**
   * Open the reply editor on a specific message — the seam every panel's ⋯ menu answers with. The
   * focused message's own Reply travels the pane's `onAction("reply")`; a panel's header menu
   * retargets by id through here — the same `openReply(messageId)` the shell already runs. `all`
   * answers everyone on the message (the flag `AppShell.openReply(id, true)` takes); the menu
   * offers Reply-all only where `replyAllRecipients` returns an envelope, resolved per panel — what
   * a panel offers and what would leave the account are one decision. Optional: the item is ABSENT
   * until wired, and a chrome with neither this nor `forward` renders no ⋯ trigger at all — honest
   * for a surface with no reply machine.
   */
  openReply?: (messageId: string, all?: boolean) => void;
  /**
   * FORWARD `messageId` — the entry each panel's ⋯ menu calls. The shell answers it with the
   * INLINE forward now (`AppShell.openForward`: the reply dock in forward mode, inside the
   * thread), not with a navigation to the compose screen — leaving the conversation to forward
   * one of its messages was the reported defect. OPTIONAL for the same reason `openReply` is:
   * absent where there is no compose seam, and an absent verb is an absent menu item rather
   * than a dead one.
   */
  forward?: (messageId: string) => void;
  /**
   * OPEN THE SUBJECT-RULE SHEET for `messageId` — dispatched from the message title press.
   *
   * A stub seam: the sheet behind it is a later slice, and this component provides only the call
   * so that later work wires the panel in without touching the viewer. OPTIONAL, and the title is
   * rendered as a plain heading until it is present — never a dead control.
   */
  openSubjectRule?: (messageId: string) => void;
  /** Both halves of what is typed in it — the markup and its plain rendering. */
  replyBody: RichValue;
  onReplyBody: (next: RichValue) => void;
  /**
   * THE REPLY'S AUDIENCE AS EDITED — `null` while the computed envelope stands.
   *
   * It travels with `replyBody` and for the identical reason: the pane is mounted TWICE
   * while the reader is open, and two copies of who a reply goes to is how one editor's
   * head and the other's envelope stop agreeing. `onReplyEnvelope` is OPTIONAL like
   * `openReply` — absent on the inert default, and then `InlineReply` renders the head as a
   * plain statement rather than a dead button.
   */
  replyEnvelope: ReplyEnvelopeEdit | null;
  onReplyEnvelope?: (next: ReplyEnvelopeEdit) => void;
  /**
   * THE REPLY'S SENDER AS PICKED — `null` while the derived one (the mailbox the message arrived
   * in) stands. It travels with `replyEnvelope` and for the identical reason: the pane is mounted
   * TWICE while the reader is open, and two copies of which address answers is how the visible
   * From line and the sent `mailboxId` stop agreeing. `onReplyFrom` is OPTIONAL like `openReply` —
   * absent on the inert default, and then `InlineReply` renders the From line as a plain statement
   * rather than a selector nothing is listening to.
   */
  replyFromId: string | null;
  onReplyFrom?: (mailboxId: string) => void;
  /**
   * THE FILES THIS REPLY WILL CARRY — held here beside the reply body (mounted-twice again) and
   * put on the `mail_send` mutation, never in the `localStorage` scratch. A default of `[]` is the
   * resting state; `onReplyAttachments` is OPTIONAL, and its absence is what makes `InlineReply`
   * render no attach control at all rather than a dead one.
   */
  replyAttachments: readonly ComposeAttachment[];
  onReplyAttachments?: (next: ComposeAttachment[]) => void;
  /**
   * THE REPLY'S SIGNATURE BLOCK STATE — held here beside the body (mounted-twice again) and
   * serialized by `sendReply` from the SAME derivation the block renders (`signature.ts`).
   * `onReplySig` is OPTIONAL like its peers: absent on the inert default, and then the editor
   * renders no block at all rather than one nothing is listening to.
   */
  replySig: SignatureState;
  onReplySig?: (next: SignatureState) => void;
  /**
   * THE ACCOUNT'S STORED SIGNATURES, server-confirmed — `useConsentState().signatures`, handed
   * down only once `signaturesKnown` is true. ABSENT means "cannot know", and then no block
   * renders anywhere in the pane.
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
   * THE REPLY'S SUBJECT AS EDITED — `null` while the derived `Re:` subject stands, which keeps
   * the untouched reply's wire byte-identical. Held here for the mounted-twice reason every
   * peer above states; `onReplySubject` absent renders the subject as plain text, never a dead
   * control.
   */
  replySubjectEdit: string | null;
  onReplySubject?: (subject: string) => void;
  /**
   * The host's own ceiling on what a send from this window can carry — `AppShell`'s
   * `sendSurfaceMaxTotalBytes`, forwarded so the reply editor's attach control states and refuses
   * against the same `min(surface, SIZE)` the send will enforce (`composeAttachCap`). Rides the
   * chrome because the pane is mounted twice and two readings of one ceiling is how the two
   * editors' sentences drift. Optional: absent means "not declared" (resolves to the strict
   * constant); `null` is the desktop's standalone door declaring there is no request body between
   * the form and the SMTP dial.
   */
  sendSurfaceMaxTotalBytes?: number | null;
  /**
   * `addressBook(reader)` for the reply's recipient rows — the same ranked, local-mirror
   * candidates the compose To field offers. Absent ⇒ no suggestions, which is a cold mirror
   * and every engine-less mount, and the rows still take typed addresses.
   */
  addressBook?: readonly AddressBookEntry[];
  closeReply: () => void;
  /**
   * Send the open reply to `messageId`. It takes the id rather than closing over
   * `replyTo` because a confirmation can arrive long after the editor moved on, and the
   * outcome belongs to the message that was answered, not to whatever is on screen now.
   */
  sendReply: (messageId: string) => void;
  /** Where that message's send has got to — see `mail-send.ts` for why it has four states. */
  replySendState: (messageId: string) => SendState;
  /**
   * THE HELD REPLY'S WAY OUT, or `null` when this message has no unconfirmed reply row.
   *
   * A reply the server took and never confirmed leaves its row at `unverified`. The Drafts list
   * offered the reader the two answers; the editor they actually open offered none, so the row was
   * a dead end from the surface it is reached from. Absent on the inert chrome, which sends
   * nothing and therefore holds nothing.
   */
  replyHeldResolve?: (messageId: string) => {
    draftId: string;
    onResolve: (draftId: string, outcome: "arrived" | "not_arrived") => void;
  } | null;
  /**
   * The AI drafter's offer and the draft waiting to be placed, or absent where there is no
   * drafter — the desktop shell and every harness that mounts a pane without the shell.
   *
   * It travels with the reply draft and for the same reason: `MessagePane` is mounted TWICE
   * while the reader is open, and an offer held per-pane would be two offers, each able to
   * spend an AI action the other one did not know about.
   */
  draftReply?: DraftReplyChrome;
  /** Open the screening popover for `messageId`, anchored on `anchor`. */
  openSenderMenu: (messageId: string, anchor: HTMLElement | null) => void;
  /**
   * The account's own name for one of its addresses, or null when it has none — what the "me" chip
   * wears instead of the sender's spelling of the reader. The answer is `GET /mailboxes`'
   * `displayName`, resolved in `AppShell` from the same facts as `ownAddresses`, riding the chrome
   * for the same reason. A FUNCTION of the address rather than one string: an account can hold
   * several mailboxes under different labels and the chip folds a specific own address. Optional;
   * null is a real answer (no label, the desktop shell, the demo, bare harnesses) and the chip
   * shows the bare address — the honest fallback.
   */
  ownNameOf?: (address: string) => string | null;
  /**
   * PREFILL A NEW MESSAGE to `address` — the contact popover's Write verb.
   *
   * Filled by `AppShell` (compose seeded with the recipient, then the route change), which is
   * the only place a compose form exists. OPTIONAL, and absence is the INERT-CHROME RULE at
   * work: a surface with no compose machine behind it (a bare harness, a provider-less mount)
   * OMITS the Write item rather than rendering a dead one — the same degradation `openReply`
   * and `forward` already follow one interface entry up.
   */
  writeTo?: (address: string, name?: string) => void;
  /**
   * Open the screening sheet for `address` — the contact popover's Screener-settings verb, and the
   * one entry that must NOT collapse to {@link MessageChrome.openSenderMenu} alone: that call
   * resolves the SENDER of `messageId`, while a chip names a To/Cc person. `AppShell` fills this
   * with its widened `openSenderMenu(messageId, anchor, address)`, so the sheet opens on the CHIP's
   * address. Optional for `writeTo`'s reason: where no screening machine exists the item is absent,
   * never dead (`openSenderMenu` stays required-with-a-noop for the sender line's sake, so it
   * cannot signal presence).
   */
  screenAddress?: (messageId: string, address: string, anchor: HTMLElement | null) => void;
  /**
   * Open the quick-look preview for one attachment on `messageId`. The pane
   * dispatches a tile press here for a type this app can render (image,
   * PDF, text) and to `attachments.open` (download) for everything else.
   * The overlay's state lives in `AppShell` — beside the reader and the
   * reply run — so it can derive-close when the selected message changes
   * and the engine revokes the object URLs it was rendering. Through the
   * chrome, not a prop, because `MessagePane` is mounted twice. Inert in
   * the default chrome: no shell, nothing happens on a preview press.
   */
  openAttachmentPreview: (messageId: string, attachmentId: string) => void;
  /**
   * The conversation this message belongs to, oldest first — `threadOf`,
   * wired to the live engine; empty when there is no conversation. Through
   * the chrome rather than a prop for the reason this context exists:
   * `MessagePane` is mounted in two places, one three components deep in a
   * fifteen-prop view. A FUNCTION rather than a resolved array because the
   * two mounts hold different messages, and the pane must not acquire an
   * engine hook of its own — `useEngine()` throws outside `EngineProvider`,
   * and `test/ohbox-read-state.test.ts` mounts `OhboxView` without one.
   */
  conversationOf: (messageId: string) => EngineMessage[];
  /**
   * The message's text, and what that text IS — `bodyOf` wired to the live
   * mirror. Travels with `conversationOf` for the identical reason: the
   * pane is mounted twice, one mount is deep inside a fifteen-prop view,
   * and the pane must not acquire an engine hook. A FUNCTION, so the two
   * mounts can hold different messages and the answer is read at render
   * time from the current mirror. What it must NOT be is a resolved string:
   * `state` is the whole point — a pane receiving only text could not tell
   * a fetch in flight from a completed one, the failure that shipped first.
   */
  bodyOf: (message: EngineMessage) => MessageBody;
  /**
   * Ask again — the reading pane's only way out of a failed body. Reads and
   * Receipts recover for free (collapse and re-expand a card fires
   * `onToggle(true)`); the Ohbox pane has neither — the shell hydrates on
   * the SELECTED id, so a message whose body 500'd stays failed until the
   * user selects something else and comes back. A dead end reachable by one
   * transient server error, so the failed note carries a control rather
   * than only a sentence. Through the chrome for `bodyOf`'s reason: the
   * pane must not hold an engine hook.
   */
  hydrateBody: (messageId: string, opts?: { retry?: boolean; urgent?: boolean }) => void;
  /**
   * Ask for a whole conversation at once — one request, not one per sibling. `ConversationEntries`
   * used to loop `hydrateBody` over the sibling ids from one effect: N requests through a four-wide
   * limiter, so an eight-message thread's tail waited a full round trip to start. The engine's
   * batch call replaces the loop, arriving through the chrome for `hydrateBody`'s reason — the
   * entries render inside `MessagePane`, which may not hold an engine hook. The default is inert,
   * and the engine's own fallback covers a client whose adapter serves no batch route, so a caller
   * never chooses between this and the single call.
   */
  hydrateThread: (messageIds: string[]) => void;
  /**
   * The files on this message, or ABSENT when this client cannot open attachments — the strongest
   * case of the mounted-twice rule: both mounts hold the SAME message, and each fetched byte is a
   * `blob:` URL that must be minted once and revoked once; two owners would open two IMAP
   * connections for one press and leak the loser's URL. `undefined` means "no attachment service"
   * (`?demo=1`, the desktop shell, engine-less tests) and the pane renders NO STRIP rather than an
   * empty one — an empty strip claims this message has no files. Not optional as in "the shell may
   * forget it": `test/attachments-wired.test.ts` asserts `AppShell` supplies it — this seam has
   * shipped that wiring bug twice (`fetchBody`, `searchServer`).
   */
  attachments?: AttachmentsChrome;
  /**
   * How a blocked image may be loaded, or ABSENT when it may not be. Same mounted-twice case as
   * `attachments`: two copies of "has this reader consented" is how one pane loads the pictures and
   * the other keeps placeholders. `undefined` means this client cannot proxy an image (`?demo=1`,
   * the desktop shell, no API) and `MessageBody` renders NO "Show images" button rather than a dead
   * one. Not optional as in "the shell may forget it" — that wiring bug shipped twice on this seam
   * (`fetchBody`, `searchServer`), and `remote-images.test.ts` builds the real pane to assert the
   * rendered frame routes through the proxy.
   */
  remoteImages?: RemoteImagesChrome;
}

const noop = (): void => {};

/**
 * The default is INERT rather than throwing: `MessagePane` also renders in the desktop
 * shell and in tests that mount a view directly, and neither should have to know that a
 * reply editor exists in order to show a message.
 */
const MessageChromeContext = createContext<MessageChrome>({
  ownAddresses: [],
  absoluteTime: false,
  onToggleAbsoluteTime: noop,
  replyTo: null,
  replyBody: EMPTY_RICH,
  onReplyBody: noop,
  replyEnvelope: null,
  replyFromId: null,
  replyAttachments: [],
  replySig: SIG_FOLLOWING,
  replySubjectEdit: null,
  closeReply: noop,
  sendReply: noop,
  replySendState: () => ({ phase: "idle" }),
  openSenderMenu: noop,
  openAttachmentPreview: noop,
  conversationOf: () => [],
  /**
   * The inert default is the PRE-HYDRATION expression, `body ?? snippet`, reported honestly:
   * a mount with no engine behind it has no way to fetch anything, so a message that carries
   * its own body is `full` (the fixture world, and the desktop shell) and one that does not
   * is a `snippet` — never `full`, which would be this default quietly re-introducing the
   * exact claim this change exists to remove.
   */
  bodyOf: (message) =>
    message.body !== undefined
      ? { text: message.body, state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }
      : { text: message.snippet, state: "snippet", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null },
  hydrateBody: noop,
  hydrateThread: noop,
});

export function MessageChromeProvider({
  value,
  children,
}: {
  value: MessageChrome;
  children: ReactNode;
}) {
  return <MessageChromeContext.Provider value={value}>{children}</MessageChromeContext.Provider>;
}

export function useMessageChrome(): MessageChrome {
  return useContext(MessageChromeContext);
}

/**
 * How long "still coming" may be said before it stops being true: the
 * engine's own deadline plus a margin. `BODY_FETCH_TIMEOUT_MS` is when a
 * body request is aborted and turned into a `failed` record, so a spinner
 * is a true statement for that long and no longer; the margin covers the
 * queue (four bodies in the air, so a fifth legitimately waits one full
 * deadline) and the mirror write that follows. Derived, not chosen: a
 * number picked here would silently stop matching the engine when that
 * deadline moved, and too short offers Retry over a request about to succeed.
 */
export const BODY_STALL_MS = BODY_FETCH_TIMEOUT_MS * 2 + 3_000;

/**
 * A spinner must have an end, and this is the one that does not depend on being right. Every engine path
 * deliberately ends in `ready` or `failed` — and that reasoning has been wrong before (a protected
 * message sat under "Loading…" for the life of a tab because two halves read two predicates), and can be
 * wrong again: `putBody` reaches IndexedDB, which can refuse (quota, private window), and both the ready
 * and failure writes are swallowed by design — the record says `loading` for ever. So this bounds the
 * SENTENCE: past the longest a body could take, the pane says it could not be loaded and offers the Retry
 * that re-asks (`retry: true` bypasses the failed-guard). `waiting` false resets it: an arrived body
 * clears the claim; selecting another message restarts the clock.
 */
export function useBodyStalled(key: string, waiting: boolean): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!waiting) return;
    const timer = setTimeout(() => setStalled(true), BODY_STALL_MS);
    return () => clearTimeout(timer);
  }, [key, waiting]);
  return stalled;
}
