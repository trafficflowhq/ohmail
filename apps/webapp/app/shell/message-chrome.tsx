"use client";

/**
 * The two things a rendered message needs from the shell, and why they are a context.
 *
 * `MessagePane` is mounted in TWO places at once whenever the reader is open — the Ohbox's
 * reading column and the reader sheet both render the selected message. If each owned its
 * own reply draft, the two editors would hold different text and whichever one you happened
 * to be looking at would be the one that lost it. So the draft lives in `AppShell` and both
 * panes read the same value; the same goes for which sender's screening popover is open.
 *
 * A context rather than props because the read column's `MessagePane` is three components
 * deep inside `OhboxView`, and threading five more parameters through a view that already
 * takes fifteen would make the seam harder to see, not easier.
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

export interface MessageChrome {
  /**
   * THE READER'S OWN ADDRESSES, so the message header can fold a recipient that IS the reader
   * to "me" rather than printing their own address back at them.
   *
   * It rides the chrome for the same reason `conversationOf` and `bodyOf` do: `MessagePane` is
   * mounted TWICE while the reader is open and holds no engine hook of its own, and the answer
   * has one source — `GET /mailboxes`, resolved once in `AppShell` (`ownAddresses`). A default
   * of `[]` is a real answer, not a stub: a surface with no mailbox facts (the desktop shell, a
   * test) recognises the reader nowhere, so every recipient renders in full, which is the honest
   * degradation. `recipientSummary` case-folds both sides.
   */
  ownAddresses: readonly string[];
  /**
   * THE FOLDERS FOUNDATION FLAG, as the shell knows it (`consent.foldersEnabled`) — the gate on
   * the reader's Delete verb (FOLDERS-SPEC.md §16.3/§16.7: the verb ships behind "Use folders";
   * flag-off is the pre-verb reader, byte-identical to before the verb existed).
   *
   * It rides the chrome for the reason everything here does: `MessagePane` is mounted from six
   * surfaces and holds no consent hook of its own. OPTIONAL, and absent means OFF — a
   * provider-less mount (the desktop shell, a bare test) renders no destructive verb, which is
   * the honest degradation and exactly the flag-off ceremony. Both halves of the verb — the
   * menu entry and the confirm strip — gate on it independently, so a stale open confirm cannot
   * dispatch after the flag goes off (the mobile reader holds the same pair).
   */
  foldersEnabled?: boolean;
  /**
   * DOES THE MIRROR HOLD THIS MESSAGE — the Delete verb's second gate. The reader can show
   * rows the mirror deliberately does not hold (an off-mirror archive hit opened from Search),
   * and `message_delete` is an engine mutation over a local row: offered there it would be a
   * control that always fails (the engine rejects a mutation with no local effect before the
   * wire). ABSENT means "assume held" — every mount that offers the verb wires it; the demo
   * and provider-less mounts never reach it because `foldersEnabled` is already off there.
   */
  mirrorHolds?: (messageId: string) => boolean;
  /**
   * ABSOLUTE-TIME DISPLAY — a session-and-view-scoped preference on the reader's stamps.
   *
   * Every stamp in the open message shows the relative form by default ("09:12", "Mon"), with the
   * exact instant on hover. Clicking any one of them flips ALL of them to the absolute form at
   * once — so a reader comparing dates across a thread sees them all in the same shape rather than
   * hovering each. It rides the chrome for the reason the rest of this context does: the stamp is
   * rendered by `MessageHeader`/`MessageCard`, which are mounted several deep and hold no shell
   * state of their own, and there may be more than one stamp on screen (the focused message plus
   * its siblings) that must agree.
   *
   * DELIBERATELY NOT PERSISTED and reset on every view switch (see `AppShell`): it is a momentary
   * "let me read the exact dates on THIS" gesture, not a setting. A default of `false` is the
   * resting state, so a pane with no shell behind it (the inert default) simply always shows
   * relative and its stamp does nothing on click.
   */
  absoluteTime: boolean;
  onToggleAbsoluteTime: () => void;
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
   * OPEN THE REPLY EDITOR ON A SPECIFIC MESSAGE — the seam every panel's ⋯ menu answers with.
   *
   * The focused message's own Reply travels the pane's `onAction("reply")` prop, which the shell
   * resolves against the focused id. A panel's header menu (`MessageHeader`) retargets the editor
   * by id through here instead — the same `openReply(messageId)` the shell already runs for the
   * focused case.
   *
   * `all` answers EVERYONE on the message — the same flag `AppShell.openReply(id, true)` takes,
   * so widening this signature is compatible with the shell that already exists. The menu offers
   * the Reply-all item only where `replyAllRecipients(message, ownAddresses)` returns an
   * envelope, resolved PER PANEL — the predicate the pill and the send path resolve, so what a
   * panel offers and what would leave the account are one decision, and a 1:1 message offers no
   * Reply all anywhere.
   *
   * OPTIONAL, so the inert default and every provider-less mount keep compiling; the menu item
   * is simply ABSENT until the shell wires it — and a chrome with neither this nor `forward`
   * renders no ⋯ trigger at all, which is the honest degradation for a surface with no reply
   * machine behind it (the desktop shell, a bare test).
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
   * THE REPLY'S SUBJECT AS EDITED — `null` while the derived `Re:` subject stands, which keeps
   * the untouched reply's wire byte-identical. Held here for the mounted-twice reason every
   * peer above states; `onReplySubject` absent renders the subject as plain text, never a dead
   * control.
   */
  replySubjectEdit: string | null;
  onReplySubject?: (subject: string) => void;
  /**
   * THE HOST'S OWN CEILING ON WHAT A SEND FROM THIS WINDOW CAN CARRY — `AppShell`'s
   * `sendSurfaceMaxTotalBytes` prop, forwarded so the reply editor's attach control states and
   * refuses against the same `min(surface, SIZE)` the send will enforce (`composeAttachCap`).
   * It rides the chrome for the reason the files above do: the pane is mounted TWICE while the
   * reader is open, and two readings of one ceiling is how the two editors' sentences drift.
   * OPTIONAL, and absent — the inert default, every browser tab, every bare harness — means
   * "not declared", which `composeAttachCap` resolves to the strict constant; `null` is the
   * desktop's standalone door declaring there is no request body between the form and the
   * SMTP dial.
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
   * THE ACCOUNT'S OWN NAME FOR ONE OF ITS ADDRESSES, or null when it has none — what the "me"
   * chip in the recipients block wears instead of the sender's spelling of the reader.
   *
   * The answer is `GET /mailboxes`' `displayName`, resolved in `AppShell` from the same facts
   * `ownAddresses` comes from, and it rides the chrome for the same reason they do: the header
   * is rendered inside both `MessagePane` mounts and holds no mailbox hook of its own. A
   * FUNCTION of the address rather than one string, because an account can hold several
   * mailboxes under different labels and the chip folds a SPECIFIC own address.
   *
   * OPTIONAL, and null is a real answer either way: a mailbox with no label, the desktop
   * shell, the demo and every bare harness all have no name to offer, and the chip then shows
   * the bare address — the honest fallback, never an invented one.
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
   * OPEN THE SCREENING SHEET FOR `address` — the contact popover's Screener-settings verb, and
   * the one entry that must NOT collapse to {@link MessageChrome.openSenderMenu} alone: that
   * call resolves the SENDER of `messageId`, while a chip names a To/Cc person. `AppShell`
   * fills this with its widened `openSenderMenu(messageId, anchor, address)`, so the sheet
   * opens on the CHIP's address with the message as its anchor into the mirror.
   *
   * OPTIONAL for the same reason `writeTo` is: where no screening machine exists the item is
   * ABSENT, never dead. (`openSenderMenu` itself stays required-with-a-noop for the sender
   * line's sake, which is why it cannot serve as this item's presence signal.)
   */
  screenAddress?: (messageId: string, address: string, anchor: HTMLElement | null) => void;
  /**
   * OPEN THE QUICK-LOOK PREVIEW for one attachment on `messageId`. The pane dispatches a tile
   * press here for a type this app can render (image, PDF, text) and to `attachments.open`
   * (download) for everything else.
   *
   * The overlay's state lives in `AppShell` — beside the reader and the reply run — so it can
   * derive-close when the selected message changes and the engine revokes the object URLs the
   * overlay was rendering. It travels through the chrome, and not as a prop, for the reason the
   * rest of this context does: `MessagePane` is mounted twice while the reader is open. Inert in
   * the default chrome, so a pane with no shell behind it simply does nothing on a preview press.
   */
  openAttachmentPreview: (messageId: string, attachmentId: string) => void;
  /**
   * The conversation this message belongs to, oldest first — `threadOf`, wired to the live
   * engine. Empty when there is no conversation; see the selector.
   *
   * It arrives through the chrome rather than as a prop for the reason this whole context
   * exists: `MessagePane` is mounted in TWO places at once (the Ohbox read column and the
   * reader sheet), one of them three components deep inside a view that already takes
   * fifteen props. A FUNCTION rather than a resolved array because the two mounts hold
   * different messages, and because `MessagePane` must not acquire an engine hook of its
   * own — `useEngine()` throws outside `EngineProvider` and `test/ohbox-read-state.test.ts`
   * mounts `OhboxView` without one.
   */
  conversationOf: (messageId: string) => EngineMessage[];
  /**
   * THE MESSAGE'S TEXT, AND WHAT THAT TEXT IS — `bodyOf` wired to the live mirror.
   *
   * It travels with `conversationOf` and for the identical reason: `MessagePane` is mounted
   * TWICE while the reader is open, one of those mounts is three components deep inside a
   * view that already takes fifteen props, and the pane must not acquire an engine hook of
   * its own — `useEngine()` throws outside `EngineProvider`, and `test/ohbox-read-state.test.ts`
   * mounts `OhboxView` without one.
   *
   * A FUNCTION, so the two mounts can hold different messages and so the answer is read at
   * render time from the current mirror. What it must NOT be is a resolved string: `state`
   * is the whole point, and a pane that received only text could not tell a fetch in flight
   * from a completed one — which is the failure that shipped the first time.
   */
  bodyOf: (message: EngineMessage) => MessageBody;
  /**
   * ASK AGAIN — the reading pane's only way out of a failed body.
   *
   * Reads and Receipts recover for free: collapsing and re-expanding a card fires
   * `onToggle(true)`, and scrolling back to it makes it current again. The Ohbox pane has
   * neither — the shell hydrates on the SELECTED id, so a message whose body 500'd stays
   * failed until the user selects something else and comes back. That is a dead end reachable
   * by one transient server error, so the failed note carries a control rather than only a
   * sentence.
   *
   * It goes through the chrome for the same reason `bodyOf` does: the pane must not hold an
   * engine hook.
   */
  hydrateBody: (messageId: string, opts?: { retry?: boolean; urgent?: boolean }) => void;
  /**
   * ASK FOR A WHOLE CONVERSATION AT ONCE — one request, not one per sibling.
   *
   * `ConversationEntries` used to loop `hydrateBody` over the sibling ids from a single effect,
   * which is N requests through a four-wide limiter: the tail of an eight-message thread did not
   * start until a full round trip had finished. The engine's batch call replaces the loop, and it
   * has to arrive through the chrome for the same reason `hydrateBody` does — the entries render
   * inside `MessagePane`, which may not hold an engine hook.
   *
   * The DEFAULT IS INERT (a mount with no engine has nothing to ask), and the engine's own
   * fallback covers a client whose adapter serves no batch route, so a caller never has to choose
   * between this and the single-message call.
   */
  hydrateThread: (messageIds: string[]) => void;
  /**
   * THE FILES ON THIS MESSAGE, or ABSENT when this client cannot open attachments.
   *
   * It travels here for the third time for the same reason `conversationOf` and `bodyOf` do,
   * and this one is the strongest case of the three: the pane is mounted TWICE while the
   * reader is open, both mounts hold the SAME message, and each fetched byte is a `blob:` URL
   * that must be minted once and revoked once. Two panes owning their own copies would open
   * two IMAP connections for one press and leak whichever URL the losing mount held.
   *
   * ── OPTIONAL, AND ABSENCE IS A REAL ANSWER ────────────────────────────────────────────
   *
   * `undefined` means "this client has no attachment service" — `?demo=1` (fixtures, and a
   * self-contained surface makes no external request), the desktop shell, and any test that
   * mounts a view without an
   * `EngineProvider`. The pane renders NO STRIP for it rather than an empty one, because an
   * empty strip is a different claim: it says this message has no files. A "Download all"
   * button over an archive nothing can build is exactly the shape of control this gap exists
   * to remove, pointed the other way.
   *
   * It is NOT optional in the sense of "the shell may forget it". `test/attachments-wired.test.ts`
   * asserts that `AppShell` supplies it and that the live engine can answer — a capability
   * that silently stays unsupplied on the live path only is this gap's own failure, and it
   * has already happened twice on this seam (`fetchBody`, `searchServer`).
   */
  attachments?: AttachmentsChrome;
  /**
   * HOW A BLOCKED IMAGE MAY BE LOADED, or ABSENT when it may not be.
   *
   * It travels here for the same reason `attachments` does and the case is identical: the
   * pane is mounted TWICE while the reader is open, both mounts hold the same message, and
   * two copies of "has this reader consented" is how one pane loads the pictures and the
   * other keeps showing placeholders.
   *
   * ── ABSENCE IS A REAL ANSWER, AND IT IS THE ONE THAT SHIPPED UNTIL NOW ────────────────
   *
   * `undefined` means this client cannot proxy an image — `?demo=1` (fixtures, zero network),
   * the desktop shell, a test with no API. `MessageBody` renders NO "Show images" button for
   * it rather than a dead one, which is exactly the state `MessageBody.tsx`'s header
   * describes: *"the consent button is therefore absent rather than dead"*.
   *
   * It is NOT optional in the sense of "the shell may forget it". A capability that stays
   * unsupplied on the LIVE path only is the wiring bug this seam has already shipped twice
   * (`fetchBody`, `searchServer`), and `remote-images.test.ts` builds the real pane to assert
   * the rendered frame routes through the proxy rather than that a function exists.
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
 * ── HOW LONG "STILL COMING" MAY BE SAID BEFORE IT STOPS BEING TRUE ──────────────────────────
 *
 * The engine's own deadline plus a margin. `BODY_FETCH_TIMEOUT_MS` is the point at which a body
 * request is aborted and turned into a `failed` record, so a spinner is a true statement for that
 * long and no longer; the margin covers the queue (four bodies in the air at once, so a fifth
 * legitimately waits behind one full deadline) and the mirror write that follows.
 *
 * DERIVED, NOT CHOSEN. A number picked here would silently stop matching the engine the first
 * time that deadline moved, and the failure mode of being too short is a Retry button offered
 * over a request that was about to succeed.
 */
export const BODY_STALL_MS = BODY_FETCH_TIMEOUT_MS * 2 + 3_000;

/**
 * ── A SPINNER MUST HAVE AN END, AND THIS IS THE ONE THAT DOES NOT DEPEND ON BEING RIGHT ─────
 *
 * Every path the engine takes deliberately ends in `ready` or `failed`: the fetch is bounded by a
 * deadline, the batch's throw fans out to a `failed` record per id, and a message nobody will ask
 * for is now recognised by the surfaces before they promise a request. That reasoning has been
 * wrong before — a protected message on a live account sat under "Loading the full message…" for
 * the life of the tab because two halves of the codebase read two different predicates — and it
 * can be wrong again in a way nothing here anticipates: `putBody` reaches IndexedDB, IndexedDB
 * refuses (a full quota, a private window, a version change), and BOTH the ready write and the
 * failure write are swallowed by design. The record then keeps saying `loading` for ever and no
 * further mirror bump is coming to re-drive it.
 *
 * So this is a bound on the SENTENCE rather than on any particular cause. Once a surface has
 * claimed a body is coming for longer than one could possibly be, it says the other true thing
 * instead — that it could not be loaded — and offers the Retry that re-asks. `retry: true` is
 * the arm that bypasses the failed-guard, so the way out is real and not another no-op.
 *
 * `waiting` false resets it: a body that arrives clears the claim, and a reader who selects
 * another message starts the clock again rather than inheriting the last one's.
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
