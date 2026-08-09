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
import { BODY_FETCH_TIMEOUT_MS, type EngineMessage, type MessageBody } from "@ohmail/client-engine";
import type { AttachmentsChrome } from "./attachments";
import type { SendState } from "./mail-send";
import { EMPTY_RICH, type RichValue } from "./rich-text";
import type { DraftReplyChrome } from "./InlineReply";
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
  /** The message id whose inline reply editor is open, if any. */
  replyTo: string | null;
  /** Both halves of what is typed in it — the markup and its plain rendering. */
  replyBody: RichValue;
  onReplyBody: (next: RichValue) => void;
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
   * own — `useEngine()` throws outside `EngineProvider` and `ohbox-read-state.test.ts`
   * mounts `OhboxView` without one.
   */
  conversationOf: (messageId: string) => EngineMessage[];
  /**
   * THE MESSAGE'S TEXT, AND WHAT THAT TEXT IS — `bodyOf` wired to the live mirror.
   *
   * It travels with `conversationOf` and for the identical reason: `MessagePane` is mounted
   * TWICE while the reader is open, one of those mounts is three components deep inside a
   * view that already takes fifteen props, and the pane must not acquire an engine hook of
   * its own — `useEngine()` throws outside `EngineProvider`, and `ohbox-read-state.test.ts`
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
   * It is NOT optional in the sense of "the shell may forget it". `attachments-wired.test.ts`
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
  replyTo: null,
  replyBody: EMPTY_RICH,
  onReplyBody: noop,
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
   * exact claim the slice exists to remove.
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
