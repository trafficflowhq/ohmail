"use client";

/**
 * REPLY, COMPOSE, DRAFTS AND SENDS — everything that puts words on the wire.
 *
 * One module because they are one path with four entrances: the inline reply, the compose form,
 * a draft row reopened, and a mailto: click the operating system handed the host. They share the
 * send doors (`useMailSend`, the send lock, `onSendSettled`), the signature and From resolution,
 * and the autosaved row. The seven effects keep the order they had. `replyTo` stays the shell's —
 * the route transition closes the editor — and arrives here as an input. Lifted out of
 * `AppShell.tsx` unchanged (ARCH-022).
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import type { useTranslations } from "next-intl";
import {
  addressBook,
  draftBodyKnown,
  forwardPress,
  forwardSubject,
  pressVerdict,
  replySubject,
  intentOf,
  sendAndDonePlanFor,
  sendingMailboxId,
  type ComposeAttachment,
  type EmailAddress,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type ForwardAsk,
  type EntityReader,
  type KeptAsNewDraft,
  type MutationResult,
  type OhmailEngine,
  type SendAndDonePlan,
  type TriagePileEntry,
} from "@ohmail/client-engine";
import { type ToastFn } from "@ohmail/ui";
import {
  clearComposeDraft,
  composePlan,
  composeSessionId,
  EMPTY_COMPOSE,
  parseRecipients,
  readComposeDraft,
  readComposeRow,
  takeRecoveredComposer,
  whenComposerReady,
  writeComposeDraft,
  writeComposeRow,
  writeComposeSession,
  type ComposeFields,
  type ComposePrefill,
  type MailSend as MailSendMutation,
} from "./compose";
import {
  discardKeepsRow,
  reopenWouldOverwrite,
  ownDraftDiscard,
  sigOf,
  useComposeAutosave,
  worthSaving,
  type ComposeFate,
  type ComposeFlush,
} from "./compose-autosave";
import {
  formatRecipientChips,
  optionsFromFacts,
  optionsFromMirror,
  replyEnvelopeOnWire,
  replyEnvelopePlan,
  replyRecipients,
  resolveComposeFrom,
  resolveReplyFrom,
  type ReplyEnvelopeEdit,
} from "./compose-from";
import type { ConsentState } from "./consent-state";
import { useDraftReply, type DraftedReply, type DraftReplyWire } from "./draft-reply";
import { dropCopy, handleOf, twins } from "./draft-creates";
import { accountSigOf, useReplyAutosave, type ReplyDraftForm } from "./reply-autosave";
import { forwardEnvelopePlan, forwardSend } from "./forward-send";
import { attachmentBytes, useForwardFiles, type ForwardFilesPlan } from "./forward-files";
import {
  clearReplyLane,
  COMPOSE_SEND_KEY,
  heldRowUnverified,
  inlineForwardKey,
  promoteOrphanedReplyLane,
  readReplyDraft,
  readReplyMeta,
  replyDockState,
  REPLY_DRAFT_PREFIX,
  REPLY_META_PREFIX,
  SEND_IN_FLIGHT_PHASES,
  sendLockOwed,
  sendPendingInDurableOutbox,
  sendPendingInOutbox,
  useMailSend,
  writeReplyDraft,
  writeReplyMeta,
  type LaneEnvelope,
  type LanePromotionPlan,
  type OutcomeDetail,
  type RefusedRow,
  type ReplyEditorMeta,
  type SendPhase,
  type SendState,
} from "./mail-send";
import type { MailboxFacts } from "./mail-state";
import { readColumnHidden } from "./narrow";
import { appendRich, EMPTY_RICH, isRichEmpty, type RichValue } from "./rich-text";
import { go, type Route } from "./routing";
import { sendLine, sendLineValues } from "./SendStatus";
import { documentHidden } from "./document-hidden";
import { attachSendLockDraft, discardDecision, holdOf, releaseSendLockForRow } from "./send-lock";
import { releaseSendAndDone } from "./send-release";
import type { DiscardRefusal } from "../views/DraftsView";
import {
  effectiveSignature,
  effectiveSignatureHtml,
  SIG_FOLLOWING,
  withSignature,
  type SignatureState,
} from "./signature";
import { useStableCallback } from "./stable-callback";
import type { OhboxReplyDone } from "../views/OhboxView";
import type { MailboxEntity } from "../views/SettingsView";
import type { SupportSeed } from "./HelpContactPane";

/** How long a Not sent notice stands; a second ending inside it widens it to a count. */
const NOT_SENT_TOAST_MS = 8000;

/**
 * WHETHER A DRAFT MAY BE OPENED YET — a named unit for the reason `makeHydrateBody` is.
 *
 * A bounded sync page can carry a draft row without its text, and the stale-resume freshen
 * applies page 1 over the mirror on every session older than five minutes. Seeded as "" that row
 * is an empty editor whose next autosave PUT replaces what the person wrote. So an unknown body
 * is fetched (`GET /drafts/:id`, one read) and the editor opens only with the text in hand; a
 * read that cannot answer opens nothing and says so, because every other arm shows the message
 * as shorter than it is.
 */
export async function openDraftDecision(
  draft: EngineDraft,
  io: {
    readDraftBody: (draftId: string) => Promise<string | null>;
    openWithBody: (draft: EngineDraft, body: string) => void;
    unavailable: () => void;
  },
): Promise<void> {
  if (draftBodyKnown(draft)) {
    /* `?? ""` is unreachable past the predicate and is the type's, not a default: an empty string
       is a KNOWN body and takes this arm, which is what lets somebody clear a draft. */
    io.openWithBody(draft, draft.body ?? "");
    return;
  }
  const text = await io.readDraftBody(draft.id);
  if (text === null) { io.unavailable(); return; }
  io.openWithBody({ ...draft, body: text }, text);
}

/** No queued edit kept as a new draft, as one stable value. */
const NO_KEPT: readonly KeptAsNewDraft[] = [];
/**
 * The engine's own subscribe, one function per engine, so the kept-as-new list's store keeps its
 * subscription across renders without a memoized closure in this frame (the render-scope census).
 */
const KEPT_SUBSCRIBERS = new WeakMap<OhmailEngine, (cb: () => void) => () => void>();
function keptSubscriber(engine: OhmailEngine): (cb: () => void) => () => void {
  let subscribe = KEPT_SUBSCRIBERS.get(engine);
  if (subscribe === undefined) {
    subscribe = (cb) => engine.subscribe(cb);
    KEPT_SUBSCRIBERS.set(engine, subscribe);
  }
  return subscribe;
}

/** A send that ended without delivery while no surface showed its lane — see `sayUnshownEnding`. */
interface UnshownEnding { lane: string; ended: SendState; left: RefusedRow | undefined }

/**
 * NOT SENT, AND KEPT IN DRAFTS — the only endings the count notice may fold together, because that
 * is what its sentence says: a refusal (`failed`) that named the row it left.
 */
function keptNotSent(e: UnshownEnding): boolean {
  return e.ended.phase === "failed" && e.left !== undefined;
}

/** A send from the row its lane's refused send left (`replyRows`), or the send as built. */
function withLaneRow(row: string | null, m: MailSendMutation): MailSendMutation {
  return row === null ? m : { ...m, draftId: row };
}

export interface ShellComposeInput {
  engine: OhmailEngine;
  /** The mirror as it is — `engine.read()` from the render, never re-read here. */
  reader: EntityReader;
  t: ReturnType<typeof useTranslations>;
  toast: ToastFn;
  /** The host's draft request path; absent on web, where the Cloud client remains the default. */
  draftReplyWire?: DraftReplyWire;
  /** Only `view`, and only so the autosave knows whether the compose form is on screen. */
  route: Pick<Route, "view">;
  /** The three signature members, gated together by `signaturesKnown` — see `consent-state.ts`. */
  consent: Pick<ConsentState, "signatures" | "signaturesHtml" | "signaturesKnown">;
  /** `GET /mailboxes` as the roster reported it, or `null` for "we cannot see" — the From list. */
  facts: MailboxFacts[] | null;
  /** The mirror's own mailbox rows, the From list's fallback where there are no facts. */
  mailboxes: MailboxEntity[];
  drafts: EngineDraft[];
  ownAddresses: string[];
  fallbackMailboxId: string | null;
  /**
   * THE INLINE REPLY'S ID — the shell's state, not this module's. The route transition closes the
   * editor with every other overlay (`shell-open-state.ts`), so the shell owns it and both hooks
   * read it; this one opens, retargets and closes through the setter.
   */
  replyTo: string | null;
  setReplyTo: Dispatch<SetStateAction<string | null>>;
  /** Below 700px the reading column is hidden, so an open reply opens the reader too. */
  setReaderFor: Dispatch<SetStateAction<string | null>>;
  /** The Reply Run's cursor — a settled send advances it. */
  fr: { step: number; items: TriagePileEntry[] } | null;
  setFr: Dispatch<SetStateAction<{ step: number; items: TriagePileEntry[] } | null>>;
  setFrDone: Dispatch<SetStateAction<Set<string>>>;
  setFrValues: Dispatch<SetStateAction<Record<string, RichValue>>>;
  setOhboxSel: Dispatch<SetStateAction<string | null>>;
  /** The mirror as the views see it — Send + Done reads the source's section from it at the press. */
  presented: EntityReader;
  /** The row's own Done door, with no sentence of its own — `resurface_done` dispatches the same way. */
  mutateAndReport: (m: EngineMutation, sentence: string | null) => Promise<boolean>;
  /** The one sentence a Send + Done press earns, with the way back. */
  toastWithUndo: (sentence: string, inverses: EngineMutation[]) => void;
  /** The host's mailto: click, or nothing. Required fields: an absent one selects no branch. */
  mailtoDraft: ComposePrefill | null | undefined;
  onMailtoDraftSeeded: (() => void) | undefined;
  /**
   * May a send from this mailbox leave its editor at once (`send-handoff.ts`), read at the press?
   * Absent: never, and every send waits in its editor as before.
   */
  mayHandOffFor?: (mailboxId: string | null) => boolean;
}

/** The record the shell composes with. Consumers destructure it: a memo may not depend on it. */
export type ShellCompose = ReturnType<typeof useShellCompose>;

export function useShellCompose({
  engine, reader, t, toast, draftReplyWire, route, consent, facts, mailboxes, drafts, ownAddresses,
  fallbackMailboxId, replyTo, setReplyTo, setReaderFor, fr, setFr, setFrDone, setFrValues,
  setOhboxSel, mailtoDraft, onMailtoDraftSeeded, presented, mutateAndReport, toastWithUndo, mayHandOffFor,
}: ShellComposeInput) {
  /** The route as it is now, for an ending that arrives after the person moved on. */
  const routeViewRef = useRef(route.view);
  routeViewRef.current = route.view;
  /**
   * Whether the open editor answers EVERYONE on the message (reply all). Set by every open —
   * `openReply(id, all)` — and read only while `replyTo` is non-null, so a stale `true` after
   * a close can never address anybody. The RECIPIENTS are not stored: `sendReply` resolves
   * `replyAllRecipients` at send time from the same facts the head renders, which is what
   * keeps the claim on screen and the envelope on the wire one decision.
   */
  const [replyAll, setReplyAll] = useState(false);
  /**
   * WHAT THE OPEN EDITOR IS — a reply, or the inline forward. Set by every open (`openReply`,
   * `openForward`), read only while `replyTo` is non-null (the `replyAll` discipline), and it
   * decides the editor's face (`InlineReply.mode`), the scratch-buffer key (`replyDraftKey` —
   * a half-written reply and a forward note on the SAME message are different texts), and
   * which mutation `sendReply` builds.
   */
  const [replyMode, setReplyMode] = useState<"reply" | "forward">("reply");
  /**
   * THE FORWARD'S ASK, per open: which message it is, why it was flagged (`forwardPress`), and
   * whether the person confirmed. `null` for a forward that needs no ask. The send carries
   * `forwardConfirmed` only for the message this names, confirmed; the dock shows the ask until then.
   */
  const [forwardGate, setForwardGate] = useState<
    { id: string; ask: ForwardAsk; confirmed: boolean; seed: EngineMessage | null } | null
  >(null);
  const [replyBody, setReplyBody] = useState<RichValue>(EMPTY_RICH);
  /**
   * THE REPLY'S AUDIENCE AS EDITED — `null` while the computed envelope stands, which is
   * every reply whose head nobody pressed. It lives HERE beside `replyBody` because the pane
   * is mounted twice, and it RESETS whenever the editor retargets or changes mode: an edit
   * belongs to the message (and the audience) it was made on, and carrying it to the next
   * reply would address somebody else's mail with it. The effect covers every path that
   * moves `replyTo` — open, close, settle, forward, the Reply Run — without each of them
   * having to remember.
   */
  const [replyEnvelope, setReplyEnvelope] = useState<ReplyEnvelopeEdit | null>(null);
  /** What a reply row held beside its text — the audience and the sender — for the open to restore. */
  const adoptedEdits = useRef<{ lane: string; envelope: ReplyEnvelopeEdit | null; fromId: string | null } | null>(null);
  /**
   * THE PRESS A HAND-OFF CLOSED ITS EDITOR ON, per lane, until it is delivered, withdrawn or pressed
   * again; `row` is the row its refusal left. Closing the dock reset its audience, files and From, so
   * every door back to the lane gets them from here ({@link pressBackOf}): the foot line's Open, the
   * toast's, Reply pressed again in the reader, the lane's own row opened from Drafts. Before, only
   * the foot line's Open did, and a refusal reopened any other way was sent a second time to the
   * computed sender, from the default address, without its files. The compose lane keeps its press
   * for its files, which no row stores.
   */
  const handedPress = useRef(new Map<string, { m: MailSendMutation; row: string | null }>());
  /**
   * THE ONE RESTORE: what a dock opening on `id` in `mode` gets back from its lane's handed-off press,
   * or `null`. Body, subject and signature are the lane's scratch, so the signature is never doubled;
   * a reply whose press named nobody stood on the computed audience, and does again.
   */
  const pressBackOf = useStableCallback((id: string, mode: "reply" | "forward"): {
    envelope: ReplyEnvelopeEdit | null; attachments: ComposeAttachment[]; fromId: string | null;
  } | null => {
    const back = handedPress.current.get(mode === "forward" ? inlineForwardKey(id) : id);
    if (back === undefined) return null;
    const m = back.m;
    const parent = reader.get<EngineMessage>("message", id) ?? null;
    const named = mode === "forward" || m.to !== undefined || m.cc !== undefined || m.bcc !== undefined;
    return {
      envelope: named ? {
        to: formatRecipientChips(m.to ?? (mode === "forward" || parent === null ? [] : [parent.from])),
        cc: formatRecipientChips(m.cc ?? []), bcc: formatRecipientChips(m.bcc ?? []),
      } : null,
      attachments: m.attachments ?? [],
      fromId: m.mailboxId !== undefined && m.mailboxId !== parent?.mailboxId ? m.mailboxId : null,
    };
  });
  useEffect(() => {
    // A FORWARD OPENS WITH THE ROWS ALREADY SHOWING, EMPTY — its audience is the user's to
    // pick and never derived (`forwardEnvelopePlan`), so a collapsed head would name nobody
    // and hide the one thing Send is waiting for. A reply keeps `null`: the computed audience
    // stands until the head is pressed, exactly as before.
    setReplyEnvelope(replyMode === "forward" ? { to: "", cc: "", bcc: "" } : null);
    // …or, once, the audience held by the reply row this open adopted (`adoptReplyRow`).
    const adopted = adoptedEdits.current;
    if (adopted?.lane !== replyTo) return;
    adoptedEdits.current = { ...adopted, envelope: null };
    if (replyMode === "reply" && adopted.envelope !== null) setReplyEnvelope(adopted.envelope);
  }, [replyTo, replyAll, replyMode]);
  /* …and a lane whose handed-off press is still owed back opens with that press's audience. Keyed on
     the open alone, so a Reply / Reply all switch on the open dock still widens or narrows it. */
  useEffect(() => {
    const back = replyTo === null ? null : pressBackOf(replyTo, replyMode);
    if (back !== null && back.envelope !== null) setReplyEnvelope(back.envelope);
  }, [replyTo, replyMode]);
  /**
   * THE REPLY'S PICKED SENDER and THE FILES IT WILL CARRY — both PER-MESSAGE and both stored
   * nowhere. The From pick overrides the mailbox the message arrived in (`resolveReplyFrom`); the
   * attachments ride the `mail_send` mutation and NEVER the `localStorage` reply scratch, which
   * serialises only the body (`mail-send.ts`). They live HERE beside `replyBody` for the
   * mounted-twice reason, and they RESET on `replyTo` alone — not on `replyAll` like the envelope:
   * a From choice and a file belong to the MESSAGE, and toggling reply/reply-all is still the same
   * message answered from the same address with the same files. Closing the editor and a settled
   * send both null `replyTo`, so this one effect is also the close and the post-send clear.
   */
  const [replyFromId, setReplyFromId] = useState<string | null>(null);
  const [replyAttachments, setReplyAttachments] = useState<ComposeAttachment[]>([]);
  /**
   * THE REPLY'S SIGNATURE BLOCK STATE and ITS SUBJECT AS EDITED — both per-message, both
   * stored nowhere (the reply scratch serialises only the body). The signature follows the
   * resolved sender until the reader strikes or edits the block (`signature.ts`); the subject
   * is `null` while the derived `Re:` one stands, which keeps the untouched reply's wire
   * byte-identical. They live HERE for the mounted-twice reason and RESET with the pick and
   * the files below: a strike and a retitle belong to the message they were made on.
   */
  const [replySig, setReplySig] = useState<SignatureState>(SIG_FOLLOWING);
  const [replySubjectEdit, setReplySubjectEdit] = useState<string | null>(null);
  /** The inline forward's kept files once one was removed — the lane meta's, else the lane row's. */
  const [replyForwardParts, setReplyForwardParts] = useState<string[] | null>(null);
  const [replyForwardSaid, setReplyForwardSaid] = useState(false);
  /**
   * RETARGETING HYDRATES RATHER THAN BLIND-RESETS: closing a half-written
   * reply nulls `replyTo`, and a reset that forgot the per-message meta made Escape drop the
   * retitled subject and resurrect a struck signature while the body survived. The meta lives
   * beside the body scratch under the same lane key (`replyMetaKey`), written by the two
   * setters below and cleared by `settle` — so close-and-reopen restores all three halves of
   * the editor or none, and a settled send spends them together.
   */
  useEffect(() => {
    const adopted = adoptedEdits.current;
    if (adopted?.lane === replyTo) adoptedEdits.current = null;
    const back = replyTo === null ? null : pressBackOf(replyTo, replyMode);
    setReplyFromId(back !== null ? back.fromId : replyMode === "reply" && adopted?.lane === replyTo ? adopted.fromId : null);
    setReplyAttachments(back?.attachments ?? []);
    if (replyTo !== null) {
      const meta = readReplyMeta(replyMode === "forward" ? inlineForwardKey(replyTo) : replyTo);
      setReplySig(meta.sig ?? SIG_FOLLOWING);
      // The subject edit is the REPLY's; a forward carries its own `Fwd:` subject.
      setReplySubjectEdit(replyMode === "reply" ? meta.subject ?? null : null);
      setReplyForwardParts(replyMode === "forward" ? meta.forwardParts ?? null : null);
    } else {
      setReplySig(SIG_FOLLOWING);
      setReplySubjectEdit(null);
      setReplyForwardParts(null);
    }
    setReplyForwardSaid(false);
  }, [replyTo, replyMode]);
  /** The two persisting setters — state and scratch move together, or a reopen lies. */
  const onReplySig = useStableCallback((next: SignatureState) => {
    setReplySig(next);
    if (replyTo === null) return;
    const lane = replyMode === "forward" ? inlineForwardKey(replyTo) : replyTo;
    writeReplyMeta(lane, {
      ...readReplyMeta(lane),
      ...(next.kind === "following" ? { sig: undefined } : { sig: next }),
    });
  });
  const onReplySubject = useStableCallback((subject: string) => {
    setReplySubjectEdit(subject);
    if (replyTo === null) return;
    const lane = replyMode === "forward" ? inlineForwardKey(replyTo) : replyTo;
    writeReplyMeta(lane, { ...readReplyMeta(lane), subject });
  });
  /**
   * The compose form lives up here rather than in `ComposeView`: the view
   * is mounted only while `#/compose` is the route, so state inside it is
   * erased by navigating away and back — a message written twice. Same
   * reason the reply body is held here, and it lets one `onSendSettled`
   * clear whichever surface delivered. The `localStorage` mirror on top is
   * for a reload, read after mount (`persisted-ui.ts`: an initializer read
   * makes server and client render different markup, and React keeps the
   * server's — the saved draft would be read and silently discarded).
   */
  const [compose, setCompose] = useState<ComposeFields>(EMPTY_COMPOSE);
  /**
   * THE FORM, READ BY A CALLBACK THAT OUTLIVES THE RENDER IT WAS MADE IN.
   *
   * `openDraft` has to know whether there is unsaved text on screen before it opens a held row
   * over it, and putting `compose` in that callback's dependency array would rebuild it on every
   * keystroke — a memoized callback pins its whole render scope, and this file is where a
   * megabyte-per-hour retention chain was measured. The ref is the shape that rule prescribes.
   */
  const composeRef = useRef<ComposeFields>(EMPTY_COMPOSE);
  composeRef.current = compose;
  /**
   * WHY THE COMPOSER IS STILL HERE after a press that asked it to close — `closeCompose`'s
   * sentence, standing in the composer's own note row rather than passing as a toast, because
   * the composer staying open is otherwise indistinguishable from a key that never registered.
   * Cleared by the next edit and by every exit that succeeds.
   */
  const [composeCloseRefusal, setComposeCloseRefusal] = useState<string | null>(null);
  /**
   * THE COMPOSER OPENED ON A MESSAGE LEFT UNFINISHED — `#/compose` resumes it, and says so. Decided
   * as the view opens: a door that put a message there on purpose (a draft opened, Write, a mail
   * link) marks `composeSeeded` first. Declared ABOVE the restore below, which sets it on a reload.
   */
  const [composeResumed, setComposeResumed] = useState(false);
  const composeSeeded = useRef(false);
  const onComposeView = route.view === "compose";
  useEffect(() => {
    if (!onComposeView) { setComposeResumed(false); return; }
    setComposeResumed(!composeSeeded.current && worthSaving(composeRef.current));
    composeSeeded.current = false;
  }, [onComposeView]);
  /** `autosave.restored`, late-bound like {@link settleComposeRef} below. */
  const restoredRef = useRef<() => void>(() => {});
  useEffect(() => whenComposerReady(() => {
    const saved = readComposeDraft();
    if (saved.to || saved.subject || saved.body) {
      // The account may not hold it (a tab closed inside the pause, or died): written at this open.
      restoredRef.current();
      setCompose(saved);
      setComposeResumed(true);
    }
    if (takeRecoveredComposer()) toast(t("compose.recoveredFromClosedTab"));
  }), []);
  /**
   * THE INLINE REPLY.
   *
   * Opening it does NOT change the route and does not close the reader: that is the whole
   * complaint. The draft is restored from `localStorage` on open, so a reload lands you
   * back in the same half-written sentence.
   */
  /**
   * The scratch-buffer key for the OPEN editor. A forward's note and a half-written reply to
   * the same message are different texts with different fates, so they must not share a
   * `localStorage` slot — the prefix is the whole of the separation, and both sides of it
   * (the open's read, `onReplyBody`'s write) derive it from here.
   */
  const replyDraftKey = useStableCallback((mode: "reply" | "forward", messageId: string): string =>
    mode === "forward" ? inlineForwardKey(messageId) : messageId);

  const openReply = useStableCallback((messageId: string, all = false) => {
    const open = (body: RichValue): void => {
      // The mode travels with the open, never separately: a Reply press while a reply-all
      // editor is up on the same message is an explicit narrowing, and vice versa.
      setReplyAll(all);
      setReplyMode("reply");
      setReplyTo(messageId);
      setReplyBody(body);
      // MOBILE. Under 700px the reading column is `display:none` (app.css), so an inline
      // reply would mount into a pane nobody can see and `r` would look broken — measured on
      // the shipped build at 390px. There, the reader IS the open message, so open it.
      if (readColumnHidden()) setReaderFor(messageId);
    };
    const scratch = readReplyDraft(messageId);
    // The creates this lane stored before a reload count again once this engine shows them.
    replyAutosave.restore(messageId);
    // THE ACCOUNT'S ROW FOR THIS REPLY, written here or on another device, is what Reply opens.
    const row = laneRowOf(messageId) === null ? accountReplyRow(messageId) : null;
    const meta = readReplyMeta(messageId);
    const named = row === null && laneRowOf(messageId) === null ? meta.row : undefined;
    // Sent from another device (no record of this browser's names it): ended as a delete ends it.
    const hold = named === undefined ? null : holdOf(engine, { lane: messageId, draftId: named.id, session: null });
    const sentElsewhere = hold !== null && hold.kind === "parked" && hold.by === "status" && hold.status === "sent";
    if (row === null && named !== undefined && (sentElsewhere || engine.read().get("draft", named.id) == null)) {
      /* THE ROW THIS LANE LAST WROTE IS NOT IN THE MIRROR: deleted elsewhere while ohmail was closed,
         its words are not saved again; words it never held are kept as a new draft, and said. */
      void (sentElsewhere || engine.store?.isTombstoned?.("draft", named.id) === true
        ? Promise.resolve("gone" as const)
        : engine.draftOnServer(named.id)
      ).then((answer) => {
        if (answer !== "gone") { open(scratch); return; }
        const copy = sigOf(scratch.text.trim());
        replyAutosave.forget(messageId);
        if (isRichEmpty(scratch) || named.holds === copy) {
          clearReplyLane(messageId);
          open(EMPTY_RICH);
          return;
        }
        if (named.pending === copy) {
          /* A SAVE OF THESE WORDS WAITED UNSEEN when the row went: they may be the row's, so they are
             shown and not saved again until they change. The meta stays, so a reload does the same. */
          replyAutosave.asSaved(messageId, scratch.text);
          if (!sentElsewhere) toast(t("reply.deletedElsewhere"));
          open(scratch);
          return;
        }
        writeReplyMeta(messageId, { ...meta, row: undefined });
        toast(t(sentElsewhere ? "reply.sentElsewhereKept" : "reply.deletedElsewhereKept"));
        open(scratch);
      });
      return;
    }
    if (row === null) { open(scratch); return; }
    void openDraftDecision(row, {
      readDraftBody: (id) => engine.readDraftBody(id),
      openWithBody: (d, text) => open(adoptReplyRow(messageId, d, text, scratch, all)),
      unavailable: () => {
        // A row whose text cannot be read is neither written over nor twinned.
        unreadableRows.current.add(messageId);
        toast(t("drafts.bodyUnavailable"));
        open(scratch);
      },
    });
  });

  /**
   * The inline forward — the reply dock in forward mode, inside the thread, on the same
   * `mail_send { forwardOf }` wire (the server quotes the original and streams its attachments).
   * FORWARD IS ALWAYS OFFERED (`forwardPress`): a `no_forward` message opens the dock on its
   * one-sentence ask, and a row the mirror does not hold has its body fetched through the reader's
   * door first. The server still refuses an unconfirmed `no_forward` forward.
   */
  const openForward = useStableCallback((messageId: string, seed?: EngineMessage) => {
    const held = engine.read().get<EngineMessage>("message", messageId);
    const m = held ?? engine.verbRead().get<EngineMessage>("message", messageId)
      ?? (seed?.id === messageId ? seed : undefined);
    if (!m) return;
    const press = forwardPress(m, held != null);
    const open = () => {
      setForwardGate(press.ask === null && held != null
        ? null
        : { id: messageId, ask: press.ask ?? "sensitive", confirmed: press.ask === null, seed: held ? null : m });
      setReplyAll(false);
      setReplyMode("forward");
      setReplyTo(messageId);
      setReplyBody(readReplyDraft(replyDraftKey("forward", messageId)));
      // The same mobile rule `openReply` states: below 700px the dock lives in the reader.
      if (readColumnHidden()) setReaderFor(messageId);
    };
    if (!press.fetch) { open(); return; }
    void engine.hydrateBody(messageId, { urgent: true }).catch(() => undefined).then(open);
  });

  /** The person answered the ask: the dock shows the editor, and the send carries the confirmation. */
  const confirmForward = useStableCallback(() => {
    setForwardGate((g) => (g && g.id === replyToRef.current ? { ...g, confirmed: true } : g));
  });
  /** The ask on screen now — only for the open forward it names, until it is confirmed. */
  const forwardAsk: ForwardAsk | null =
    forwardGate && !forwardGate.confirmed && replyMode === "forward" && replyTo === forwardGate.id
      ? forwardGate.ask
      : null;

  /**
   * CLOSING THE DOCK CANCELS ITS SEND, because the button says Cancel. `cancelCompose` has
   * withdrawn a queued send since the composer got one; this dock, whose ghost button carries the
   * same word, left the intent standing on the outbox — so a reply somebody had cancelled still
   * went on the next reconnect. The SCRATCH IS NOT TOUCHED, which is the one thing closing this
   * dock has never done: the text stays and the reply reopens with it. `already_sent` withdraws
   * nothing, so the dock stays open and the reader is told rather than shown an empty pane over a
   * delivery nobody can take back.
   */
  const closeReply = useStableCallback(() => {
    const target = replyToRef.current;
    if (target === null) { setReplyTo(null); return; }
    const lane = replyModeRef.current === "forward" ? inlineForwardKey(target) : target;
    const waitedToGo = mailSend.stateOf(lane).phase === "queued";
    void (async () => {
      const said = await mailSend.withdraw(lane);
      if (said === "already_sent") {
        toast(t("compose.cancelAlreadySent"));
        return;
      }
      // Sent from another window on an older version: nothing cancelled, the dock stays and says so.
      if (said === "elsewhere") {
        toast(t("compose.cancelElsewhere"));
        return;
      }
      // The disk did not take the Cancel: the dock and its words stay, and pressing again asks again.
      if (said === "unknown") {
        toast(t("compose.cancelUnknown"));
        return;
      }
      // The server could not be asked about a send that may have left: held, and the Cancel stays owed.
      if (said === "unreachable") {
        toast(t("compose.cancelUnreachable"));
        return;
      }
      // A send withdrawn before the wire: the words it took from the outbox's create are a draft again.
      if (waitedToGo) {
        // Withdrawn as an outcome would end it: a create the press held is the reply's again.
        replyAutosave.notSent(lane);
        replyAutosave.cancelled(lane);
        handedPress.current.delete(lane);
      }
      setReplyTo(null);
    })();
  });

  /**
   * Reply is a toggle on the verbs that say "Reply" — the pill and `r`/`⇧R`.
   * Pressing the verb that opened the editor closes it; the draft survives,
   * as it survives Cancel and Escape. The MODE is part of the identity:
   * Reply pressed while a reply-all editor is up is an explicit narrowing,
   * not a close — only the same verb on the same message toggles.
   * Retargeting paths (a panel's ⋯ menu, a sibling's footer verbs, the
   * drafter) stay on `openReply`: "reply to THIS message" is not a toggle.
   */
  const toggleReply = useStableCallback((messageId: string, all = false) => {
    // The MODE is part of the editor's identity: Reply pressed while the FORWARD dock is up on
    // the same message is a switch to the reply, not a close — only the same verb on the same
    // message in the same mode toggles.
    if (replyTo === messageId && replyAll === all && replyMode === "reply") {
      setReplyTo(null);
      return;
    }
    openReply(messageId, all);
  });

  const onReplyBody = useStableCallback((next: RichValue) => {
    setReplyBody(next);
    // The mode-aware key — a forward note must never overwrite a reply draft. See
    // `replyDraftKey`.
    if (replyTo) writeReplyDraft(replyDraftKey(replyMode, replyTo), next);
  });

  /* ── buying a drafted reply ───────────────────────────────────────────────────────────── */

  /**
   * WHAT IS IN THE EDITOR RIGHT NOW, as refs.
   *
   * `onDraft` runs when the server answers, which can be seconds after the press, and the
   * person who pressed is usually still typing. A callback closed over `replyBody` would be
   * holding the text as it was at press time, so "add the draft below what I wrote" would
   * silently drop every keystroke made while the request was out. Refs are read at call time,
   * which is the only moment the question has a correct answer — and they also let `onDraft`
   * be identity-stable, so the confirm button is not rebound on every keystroke.
   */
  const replyBodyRef = useRef(replyBody);
  replyBodyRef.current = replyBody;
  const replyToRef = useRef(replyTo);
  replyToRef.current = replyTo;
  /** The mode, readable from settle handlers and draft arrivals — same idiom as `replyToRef`. */
  const replyModeRef = useRef(replyMode);
  replyModeRef.current = replyMode;

  /* ── a parent another mail client took away ───────────────────────────────────────────── */

  /**
   * WHAT A PROMOTED LANE NAMES — the envelope it was written under, then what the dead parent still
   * says, then nothing. `null` ⇒ nothing can place it, and the lane is left exactly as it is.
   *
   * Without an envelope (a lane from before it) the audience is the PLAIN reply's, never reply-all:
   * widening one nobody asked for would put a half-written sentence in front of a room. With no
   * parent either there is neither audience nor subject — the compose form is where they are filled.
   */
  const promotionPlanFor = useStableCallback(
    (lane: string, parentId: string, parent: EngineMessage | null): LanePromotionPlan | null => {
      const meta = readReplyMeta(lane);
      const env = meta.envelope;
      /* `sendingMailboxId` is the COMPOSE fallback, and that is what this row is: a draft the
         person will address and send from the compose form, not a reply going out now. */
      const mailboxId = env?.mailboxId ?? parent?.mailboxId ?? sendingMailboxId(engine.read());
      if (!mailboxId) return null;
      const forward = lane !== parentId;
      const subject = meta.subject ?? env?.subject
        ?? (parent ? (forward ? forwardSubject(parent.subject) : replySubject(parent.subject)) : "");
      const to = env ? env.to : !forward && parent ? (replyRecipients(parent, ownAddresses) ?? [parent.from]) : [];
      return { mailboxId, subject, to, cc: env?.cc ?? [], bcc: env?.bcc ?? [], rowId: heldLaneRow(lane, meta) };
    },
  );

  /**
   * THE ROW THIS BROWSER HOLDS FOR A LANE, and nobody moved since it last saw it: a promotion writes
   * the words into it rather than beside it, or one reply is two rows. A row another device wrote,
   * or one that moved, is not this lane's to write over.
   */
  const heldLaneRow = (lane: string, meta: ReplyEditorMeta): string | null => {
    const held = laneRowOf(lane);
    if (held !== null) return held;
    const row = meta.row;
    const d = row ? drafts.find((x) => x.id === row.id) : undefined;
    if (!row || !d || d.updatedAt !== row.at) return null;
    // `holdOf` parks every row past `draft`, so a free row is an ordinary draft.
    return holdOf(engine, { lane, draftId: d.id, session: null }).kind === "free" ? d.id : null;
  };

  /**
   * PROMOTE EVERY LANE THESE DEAD IDS HOLD — the reply's and the inline forward's, because a
   * forwarded note is somebody's own writing too and dropping one of a pair is half a fix.
   *
   * Called from the engine's removal signal, which fires BEFORE the page is applied: that is the
   * last instant `parent` can be read, and every field but the text comes from it.
   */
  const promoteLanesOf = useStableCallback((ids: readonly string[]) => {
    for (const id of ids) {
      const parent = engine.read().get<EngineMessage>("message", id) ?? null;
      const wasOpen = replyToRef.current === id;
      for (const lane of [id, inlineForwardKey(id)]) {
        /* A LANE WHOSE SEND IS ALREADY ON ITS WAY IS NOT PROMOTED, and this is the write-site
           census's rule, not a new one: a row created for a message that may already have been
           delivered is the double-send bait. Three witnesses, the same three the compose create
           gate asks — the in-memory queue, the durable outbox, and a record the jar holds for this
           lane. The lane is LEFT, so `settle` still clears it when the send lands. */
        if (
          sendPendingInOutbox(engine, lane)
          || sendPendingInDurableOutbox(engine, lane)
          || holdOf(engine, { lane, draftId: null, session: null }).kind !== "free"
        ) continue;
        // A reply the account already holds as a row with these words is a draft already.
        const kept = lane === id ? accountReplyRow(id) : null;
        if (kept?.body != null && kept.body.trim() === readReplyDraft(lane).text.trim()) {
          clearReplyLane(lane);
          continue;
        }
        void promoteOrphanedReplyLane(
          lane, id, promotionPlanFor(lane, id, parent),
          (m) => engine.mutate(m as EngineMutation),
        ).then((outcome) => {
          if (outcome !== "promoted" || !wasOpen) return;
          // The editor's host is already unmounting; what is owed is the sentence saying where
          // the words went, and `replyTo` released so it does not keep naming a dead message.
          setReplyTo(null);
          toast(t("reply.toastSavedAsDraft"));
        });
      }
    }
  });

  /**
   * A LANE ITS SEND HELD OFF, HANDED BACK once that send failed for good: the promotion skipped it
   * while the send was out, and with the parent gone nothing else reaches its words. A delivered
   * send clears the lane first, and an unverified one keeps its hold, so neither is promoted.
   */
  const handBackLane = useStableCallback((lane: string) => {
    if (lane === COMPOSE_SEND_KEY) return;
    const parentId = lane.startsWith("fwd:") ? lane.slice("fwd:".length) : lane;
    if (engine.messageIsGone(parentId)) promoteLanesOf([parentId]);
  });

  /** Every lane this window holds is judged at most once per mount — see the effect below. */
  const orphanScanDone = useRef(false);

  /**
   * THE TWO WAYS A LANE IS ORPHANED, AND THEY PARTITION THE CASES. A window that is OPEN when the
   * delete arrives learns it from the removal signal; a window that was closed then — a second
   * tab, tomorrow's reload — learns it from the mirror it hydrates, which is this scan.
   *
   * IT ASKS FOR A TOMBSTONE AND NEVER FOR ABSENCE: `prune` removes rather than tombstones, so a
   * parent that is merely not here is ordinary mail outside this device's window, and promoting on
   * that would turn every small mirror into a draft-making machine.
   */
  useEffect(() => {
    const scan = (): void => {
      if (orphanScanDone.current) return;
      orphanScanDone.current = true;
      let keys: string[] = [];
      try { keys = Object.keys(window.localStorage); } catch { return; } // storage blocked
      const dead = new Set<string>();
      for (const k of keys) {
        if (!k.startsWith(REPLY_DRAFT_PREFIX)) continue;
        const lane = k.slice(REPLY_DRAFT_PREFIX.length);
        const parentId = lane.startsWith("fwd:") ? lane.slice("fwd:".length) : lane;
        // A lane whose remainder is still namespaced belongs to a surface with its own row.
        if (parentId.length === 0 || parentId.includes(":")) continue;
        if (engine.messageIsGone(parentId)) dead.add(parentId);
      }
      if (dead.size > 0) promoteLanesOf([...dead]);
    };
    return engine.subscribe(scan);
  }, [engine, promoteLanesOf]);

  useEffect(() => engine.onMessagesRemoved(promoteLanesOf), [engine, promoteLanesOf]);

  /**
   * A DRAFT THAT ARRIVED ON TOP OF SOMETHING ALREADY WRITTEN, and has not been placed yet.
   *
   * It is NOT cleared when the editor closes. The AI action has been spent by the time this
   * exists, and dropping the result because somebody pressed Escape would be charging for
   * something and then throwing it away — reopening the reply on that message asks the
   * question again. It is cleared when the question is answered, and when a send for that
   * message settles, which is the one moment the draft is genuinely moot.
   */
  const [pendingDraft, setPendingDraft] =
    useState<{ draft: DraftedReply; messageId: string } | null>(null);

  /** Open the reply on `messageId` and put `next` in it — memory, buffer and mobile alike. */
  const placeDraft = useStableCallback((messageId: string, next: RichValue) => {
    // An arriving draft keeps the audience the editor already has on this message — a
    // reply-all someone bought a draft for must not silently narrow to the sender alone —
    // and resets to a plain reply when it opens the editor on a different message.
    setReplyAll((prev) => replyToRef.current === messageId && prev);
    // A drafted REPLY places into a REPLY editor, whatever the dock is doing right now: with
    // the forward dock up on the same message, placing into `replyBody` without flipping the
    // mode would put generated reply text into the forward's note and send it as one. The
    // forward's own note is safe in its `fwd:` scratch.
    setReplyMode("reply");
    setReplyTo(messageId);
    setReplyBody(next);
    writeReplyDraft(messageId, next);
    // Same mobile rule `openReply` states: under 700px the reading column is display:none,
    // so an editor mounted there is one nobody can see.
    if (readColumnHidden()) setReaderFor(messageId);
  });

  /**
   * The draft arrives. It goes into the editor and nowhere else: no
   * mutation, nothing sent, no triage state moved — a generated draft is
   * not an answered message, and the Reply Run's debt is discharged by a
   * send settling and nothing else (`onSendSettled`); asserted in
   * `draft-reply-wiring.test.tsx`. An empty editor takes the draft
   * directly; a non-empty one is asked, and keeps its text until answered.
   */
  const onDraft = useStableCallback((draft: DraftedReply, messageId: string) => {
    // The FORWARD dock's body is not "existing reply text": when the open editor is the
    // forward on this message, the reply's own scratch is the honest source.
    const existing =
      replyToRef.current === messageId && replyModeRef.current === "reply"
        ? replyBodyRef.current
        : readReplyDraft(messageId);
    if (isRichEmpty(existing)) {
      placeDraft(messageId, draft);
      return;
    }
    // The reply is opened either way, so the question is asked beside the text it is about
    // rather than in a dialog over a message that is not on screen.
    placeDraft(messageId, existing);
    setPendingDraft({ draft, messageId });
  });

  const draftReply = useDraftReply({ onDraft, wire: draftReplyWire });

  const resolveDraft = useStableCallback((mode: "replace" | "append") => {
    if (!pendingDraft) return;
    const { draft, messageId } = pendingDraft;
    const existing =
      replyToRef.current === messageId && replyModeRef.current === "reply"
        ? replyBodyRef.current
        : readReplyDraft(messageId);
    placeDraft(messageId, mode === "replace" ? draft : appendRich(existing, draft));
    setPendingDraft(null);
  });

  const draftReplyChrome = useMemo(
    () => ({ control: draftReply, pending: pendingDraft, resolve: resolveDraft }),
    [draftReply, pendingDraft, resolveDraft],
  );

  /**
   * Sending. The state machine, retry driver and triage clear live in `mail-send.ts`; this only
   * says what "settled" means to the shell. For a reply: close the editor only if it is still
   * open on that same message — a retry's confirmation can arrive after the user moved on, and
   * closing then would discard a different half-written reply. For a compose: empty the form
   * (the localStorage half is cleared by the send machine itself). A Reply Run step is
   * discharged HERE and only here: the press only sends, `settle` calls this on a confirmation
   * and nothing else, so a step is left behind only by a reply that exists — two discharge
   * rules is how a FAILED send still clears the debt.
   */
  /**
   * The autosave hook's endings, through refs — not decoration:
   * `onSendSettled` and `discardDraft` are declared here and
   * `useComposeAutosave` is called two hundred lines below (it needs the
   * resolved From options). Naming `autosave` directly in a callback body
   * is a temporal-dead-zone reference TypeScript accepts inside a closure
   * but cannot join a dependency array. The refs are assigned once the hook
   * exists (`attachments.ts`'s shape). `settleComposeRef` is invariant T's
   * one function — every ending of a bound compose goes through it.
   */
  const settleComposeRef = useRef<(fate: ComposeFate) => void>(() => {});
  const releaseDraftIdRef = useRef<string | null>(null);
  const releaseBindingRef = useRef<() => void>(() => {});
  const composeNotSentRef = useRef<() => void>(() => {});
  /** Late-bound for the same reason as {@link settleComposeRef} — see below where it is assigned. */
  const openMessageRef = useRef<(m: EngineMessage, opts?: { reply?: boolean }) => void>(() => {});
  /**
   * WHICH DRAFT ROW SEEDED WHICH REPLY EDITOR — `message id → draft id`, written by `openDraft`
   * when a reply draft opens in its message's own inline editor. The lane takes that row and the
   * send goes from it; should a send go without it (the row held at the press), the seeded row
   * would survive the delivery as a phantom draft — the sent message sitting in Drafts under
   * "haven't sent", reopenable with Send live. Entries leave when the send settles (discarded
   * below unless it was the row sent) or when the row is discarded from the Drafts list.
   */
  const replySeedDrafts = useRef(new Map<string, string>());
  /**
   * THE ROW A REFUSED REPLY LEFT, per lane (`message id`, or `fwd:<id>`) — the compose lane's
   * `refusedWithRow`, for the lane that held no row when it sent. The lane's next press sends
   * THAT row, so one message stays one draft. `seen` is whether the mirror has listed it: a row
   * taken before the drain is still the row, and one the mirror listed and then lost is gone.
   */
  const replyRows = useRef(new Map<string, { row: string; seen: boolean; rev?: string }>());
  /**
   * WHICH DRAFT A LANE'S PRESS WENT WITH — its row and the row that seeded its editor, as they stood
   * at the press. A settlement arriving after another reply draft was opened into the same dock (from
   * Drafts, or the account's row) is not about that draft, and its seed and row are not the
   * settlement's to discard or forget — see `onSendSettled`.
   */
  const pressRows = useRef(new Map<string, { row: string | null; seed: string | null }>());
  /**
   * THE SEED LEAVES once the message has a row of its own — a confirmed send's, or the row a
   * refused send left — and never when it IS that row (`keep`): that one holds the message.
   */
  const dropReplySeed = useStableCallback((key: string, keep: string | null | undefined) => {
    const seeded = replySeedDrafts.current.get(key);
    if (!seeded || seeded === keep) return;
    replySeedDrafts.current.delete(key);
    void engine.mutate({ kind: "draft_discard", draftId: seeded });
    writeReplyMeta(`draft:${seeded}`, {}); // the phantom row's block state dies with it
  });
  /*
   * The compose recovery is gone, and its absence is the fix. `recoverySeed`
   * seeded an `unverified` or stranded `sending` draft's text into a FRESH
   * row — exactly what invariant S(2) forbids: a message whose first send
   * may already be delivered, re-sent under a key the server cannot
   * recognise. Such a row is PARKED now (`holdOf` parks every non-`draft`
   * status), so the branch cannot be entered and the ref and its clears are
   * removed rather than left as a dead arm. Instead: the row is listed in
   * Drafts with the warning, and Try again replays the ORIGINAL key — the one repeat the server can recognise.
   */

  /**
   * The reply that most recently settled, handed to `OhboxView` for the animate-to-Earlier gesture
   * — the Ohbox's one deliberate mid-session move: the answered row slides to "Earlier" and is
   * marked read. Set only for a reply: a compose answers nothing and moves no row out of "New for
   * you".
   */
  const [replyDone, setReplyDone] = useState<OhboxReplyDone | null>(null);

  const onSendSettled = useStableCallback((
    key: string, m: MailSendMutation, aboutThisCompose: boolean,
  ) => {
    // Delivered: nothing is owed back to a door any more.
    handedPress.current.delete(key);
    if (key === COMPOSE_SEND_KEY) {
      /* Invariant T(b), and this is the one implementation of it: the live
         confirmed path and the reload path both call `settleCompose` now
         (they used to clear the compose in different statements and
         drifted — a delivered message sat in the composer). It RELEASES
         when the send used the row and DISCARDS when it did not
         (`autosave.settled`'s judgement): deleting a row the send used
         would destroy the account's record of an outgoing mail, while a
         send pressed before the first save made its own row. The surface
         half — emptying the form, arriving at the list — is `onCleared`. */
      settleComposeRef.current({
        kind: "sentByMirror", rowId: m.draftId ?? null, toList: m.sendAt ? "drafts" : "ohbox",
        /* WHETHER THIS SETTLEMENT IS ABOUT THE MESSAGE ON SCREEN, carried from the press — see
           `useMailSend`'s `sentFor`. Without it this arm acts on whatever compose is open, and
           the person watches the draft they are writing lose its row and its text because an
           unrelated send finished. */
        aboutThisCompose,
      });
      /**
       * And the message is sent, so the compose is over. It used to stay on screen after a
       * confirmed send — an emptied form and a toast, the reader wondering whether to press
       * Send again. Navigate on the CONFIRMATION, not the press: by then the engine has
       * materialised the optimistic Sent copy from the server's `{status:"sent"}` answer, so
       * the Ohbox this lands on already holds the message ("Earlier" ranks a sent message by
       * its send time). A failed send never reaches here — the compose stays put with its text.
       * The selection clears too: arriving with an earlier visit's message open would put a
       * stranger's mail in the reading column.
       */
      return;
    }
    /**
     * AN INLINE FORWARD SETTLED — close the dock and nothing else. A forward is NOT an answer:
     * it marks nothing read, discharges no triage debt (`settle`'s discharge lives in the
     * reply branch), and hands the Ohbox no `replyDone` gesture — forwarding a message to a
     * colleague is not being done with it. The scratch note is already cleared by `settle`
     * (the lane doubles as the suffix).
     */
    /* THE LANE HOLDS ANOTHER DRAFT NOW: one was opened into this dock since the press (another seed
       or row is bound). Everything below that judges the lane's rows or closes its editor would act on
       that draft — the seed's discard deleted its row — so none of it runs; what the delivery itself
       means (the answered message, the Reply Run) still does. Only a binding counts: the lane's own
       row leaving Drafts (the send's `sending` flip, drained mid-flight) binds nothing. */
    const atPress = pressRows.current.get(key);
    pressRows.current.delete(key);
    const other = (now: string | null | undefined, then: string | null): boolean => now != null && now !== then;
    const moved = atPress !== undefined && (
      other(replySeedDrafts.current.get(key), atPress.seed) || other(replyRows.current.get(key)?.row, atPress.row)
    );
    // The lane's row was the one sent; nothing is left to send from.
    if (!moved) replyRows.current.delete(key);
    if (key.startsWith("fwd:")) {
      const forwarded = key.slice(4);
      // Close ONLY the editor this settlement is about: a late forward confirmation must not
      // take down a REPLY the user has since opened on the same message.
      if (!moved) setReplyTo((cur) => (cur === forwarded && replyModeRef.current === "forward" ? null : cur));
      return;
    }
    if (!moved) {
      // A reply seeded from a draft row settled: the row's message has been delivered (the send
      // wrote its own row), so the seed is a phantom draft now — see `replySeedDrafts`.
      dropReplySeed(key, m.draftId);
      replyAutosave.settled(key, m.draftId ?? null);
      replyAutosave.forget(key);
      dropPriorRow(key, m.draftId ?? null);
    }
    // A reply settled. `key` is the answered message's id (`sendKeyOf`), which is exactly the row
    // that should move from "New for you" to "Earlier" — so hand it to the Ohbox for the gesture.
    setReplyDone({ messageId: key, at: new Date().toISOString() });
    // The mirror-image of the fwd: guard above: a late REPLY confirmation must not close a
    // FORWARD newly opened on the same message.
    if (!moved) setReplyTo((cur) => (cur === key && replyModeRef.current === "reply" ? null : cur));
    // A reply to this message has been delivered, so a drafted alternative to it is moot.
    // This is the ONLY thing that discards an unplaced draft other than answering the
    // question, because the AI action behind it has already been spent.
    setPendingDraft((p) => (p?.messageId === key ? null : p));

    /**
     * Guarded on the item the run is STANDING ON, not on "a run is open". A confirmation can arrive from a flush
     * minutes after the press — by which time the user may have skipped past that message, or closed the run and
     * started a second one over a fresh snapshot of a pile that has moved. Advancing on the key alone would step over
     * a message nobody answered, which is the same lie in a rarer form. A late confirmation for a message the run is
     * no longer on still discharges the debt (`settle` does that), and simply does not move a cursor that has gone
     * elsewhere. `fr` is closed over rather than read from a ref because `useMailSend` re-points `settledRef` on
     * every render, so what runs here is always the latest committed run.
     */
    const item = fr ? fr.items[fr.step] : undefined;
    if (!fr || !item || item.messageId !== key) return;
    setFrDone((s) => new Set(s).add(key));
    // The typed text is spent. `settle` has already removed the `localStorage` half.
    setFrValues((vals) => {
      if (!(key in vals)) return vals;
      const { [key]: _delivered, ...rest } = vals;
      return rest;
    });
    setFr({ ...fr, step: fr.step + 1 });
  });
  /*
   * SEND + DONE: the INTENT a press earned rides the SEND ITSELF, on its outbox row, and comes back
   * on its confirmation (`OutcomeDetail.andDone`) — a later boot's replay included. The release
   * and its Undo are read when it comes back (`releaseSendAndDone`), from the Ohbox as it is then.
   */

  /**
   * A LANE TAKES THE ROW ITS REFUSED SEND LEFT, when it holds none. The row the editor was seeded
   * from is that message's older copy, and it leaves as it does when the reply confirms.
   */
  const takeLaneRow = useStableCallback((lane: string, rowId: string) => {
    if (laneRowOf(lane) !== null) return;
    replyRows.current.set(lane, { row: rowId, seen: false });
    replyAutosave.rebind(lane);
    dropReplySeed(lane, rowId);
  });
  /** The lane's row while the hold leaves it free to send from; forgotten once the mirror loses it. */
  const laneRowOf = useStableCallback((lane: string): string | null => {
    const held = replyRows.current.get(lane);
    if (held === undefined) return null;
    // The listed drafts lag the mirror by a render: a row just taken is in the mirror first.
    if (drafts.some((x) => x.id === held.row)) held.seen = true;
    else if (held.seen && engine.read().get<EngineDraft>("draft", held.row) === undefined) {
      replyRows.current.delete(lane);
      return null;
    }
    return holdOf(engine, { lane, draftId: held.row, session: null }).kind === "free" ? held.row : null;
  });

  /**
   * THE ROW A LANE STORED BEFORE A DOOR BOUND ITS OWN CREATE'S ROW: the same message's older copy. It goes
   * once the send from the bound row is confirmed, and only while it holds what this tab last wrote.
   */
  const priorRows = useRef(new Map<string, { id: string; holds: string | undefined; from: string }>());
  const dropPriorRow = useStableCallback((lane: string, sentRow: string | null) => {
    const prior = priorRows.current.get(lane);
    priorRows.current.delete(lane);
    if (prior === undefined || sentRow !== prior.from) return;
    const d = engine.store?.get<EngineDraft>("draft", prior.id);
    if (typeof d?.body !== "string" || sigOf(d.body.trim()) !== prior.holds) return;
    // `holdOf` parks every row past `draft`, so a free row is an ordinary draft.
    if (holdOf(engine, { lane, draftId: prior.id, session: null }).kind !== "free") return;
    dropCopy(engine, lane, prior.id, sentRow);
  });
  /** Lanes whose account row could not be read at the open: nothing writes for them. */
  const unreadableRows = useRef(new Set<string>());
  /** The account's reply row for a message — the newest one still a draft and free to write. */
  const accountReplyRow = useStableCallback((messageId: string): EngineDraft | null => {
    let best: EngineDraft | null = null;
    for (const d of drafts) {
      // `holdOf` parks every row past `draft`, so a free row is an ordinary draft.
      if (d.inReplyToMessageId !== messageId) continue;
      if (holdOf(engine, { lane: messageId, draftId: d.id, session: null }).kind !== "free") continue;
      // A row a create of this reply made, still to be judged beside the reply's row, is not that row.
      if (replyAutosave.ownsRow(messageId, d.id)) continue;
      if (best === null || d.updatedAt > best.updatedAt) best = d;
    }
    return best;
  });
  /**
   * THE LANE TAKES THE ROW, and the editor its text: the row's, unless this browser holds typing the
   * row has not had yet (it last wrote this row, which has not moved since). Typing this browser never
   * saved beside a row written elsewhere writes over neither: it opens as its own reply. `scratch`
   * null is an explicit open of the row. The audience, sender and subject live on the row only.
   */
  const adoptReplyRow = useStableCallback((
    lane: string, d: EngineDraft, text: string, scratch: RichValue | null, all: boolean,
  ): RichValue => {
    const meta = readReplyMeta(lane);
    replyAutosave.restore(lane);
    // A row still waiting on its create has a local id: the lane binds the create, never that id.
    const handle = handleOf(engine, d);
    const create = handle.kind === "create" ? handle.key : null;
    const id = handle.kind === "row" ? handle.id : d.id;
    const ours = create === null ? meta.row?.id === id || replyAutosave.ownsRow(lane, id) : replyAutosave.owns(lane, create);
    const moved = create === null && meta.row?.id === id && meta.row.at !== d.updatedAt;
    // A door into the reply the lane already holds keeps the lane's newest words, never the row's older ones.
    const shown = scratch ?? (ours && !moved ? readReplyDraft(lane) : null);
    const rowWins = shown === null || isRichEmpty(shown) || moved;
    if (!rowWins && !ours && shown!.text.trim() !== text.trim()) return shown!;
    if (rowWins) replyAutosave.opened(lane);
    // The row's own markup seeds the editor and the baseline: a reply opened plain from a formatted
    // row could not be saved or sent.
    const rowHtml = typeof d.html === "string" ? d.html : "";
    const fields = { mailboxId: d.mailboxId, subject: d.subject, body: text, html: rowHtml, to: d.to, cc: d.cc, bcc: d.bcc };
    const own = create === null && replyAutosave.ownsRow(lane, id);
    if (own) {
      // The row a create of this lane made is taken, never rebound past.
      replyAutosave.takeOwn(lane, id);
      const was = meta.row;
      if (was !== undefined && was.id !== id && was.made === true) {
        if (twins(accountSigOf(engine, was.id), accountSigOf(engine, id))) dropCopy(engine, lane, was.id, null);
        else priorRows.current.set(lane, { id: was.id, holds: was.holds, from: id });
      }
    }
    // The version the lane's words are based on: the row's as this door reads it.
    const rev = (handle.kind === "row" ? handle.revision : null) ?? d.contentRevision ?? undefined;
    if (create === null) {
      // The row the lane last stored is the same message: its creates still waiting stay its own.
      if (!own && replyRows.current.get(lane)?.row !== id && meta.row?.id !== id) replyAutosave.rebind(lane);
      replyRows.current.set(lane, { row: id, seen: true, ...(rev ? { rev } : {}) });
    } else if (!ours) {
      replyRows.current.delete(lane);
      replyAutosave.awaits(lane, create, fields);
    }
    const parent = reader.get<EngineMessage>("message", lane) ?? null;
    const derived = parent ? replySubject(parent.subject) : d.subject;
    const subject = rowWins || meta.subject === undefined ? (d.subject !== derived ? d.subject : undefined) : meta.subject;
    const at = engine.read().get<EngineDraft>("draft", id)?.updatedAt ?? d.updatedAt;
    // Bound to a create, the lane holds no row yet: a row named before is another draft now.
    writeReplyMeta(lane, {
      ...readReplyMeta(lane), subject,
      row: create === null
        ? {
          id, at, holds: sigOf(text.trim()), ...(own || (meta.row?.id === id && meta.row.made) ? { made: true as const } : {}),
          ...(rev ? { rev } : {}),
        }
        : undefined,
    });
    const plan = replyEnvelopePlan(parent, ownAddresses, all, null);
    const who = (xs: readonly EmailAddress[]): string => xs.map((a) => a.address.toLowerCase()).join(",");
    const edited = parent !== null && (who(d.to) !== who(plan.to ?? [parent.from])
      || who(d.cc) !== who(plan.cc ?? []) || d.bcc.length > 0);
    adoptedEdits.current = {
      lane,
      envelope: edited ? { to: formatRecipientChips(d.to), cc: formatRecipientChips(d.cc), bcc: formatRecipientChips(d.bcc) } : null,
      fromId: parent !== null && d.mailboxId !== parent.mailboxId ? d.mailboxId : null,
    };
    const body = rowWins ? { text, html: rowHtml } : shown!;
    if (rowWins) writeReplyDraft(lane, body);
    if (rowWins || shown!.text.trim() === text.trim()) {
      replyAutosave.baseline(lane, fields);
    }
    return body;
  });

  /**
   * THE SEND MACHINE'S ANSWER, and for Send + Done the release of the intent it carries. `accepted`
   * is the engine's confirmation and nothing weaker: without it nothing is dispatched. `true` is a
   * release made — the shell has spoken for this send, and `settle` neither discharges the reply's
   * debt nor raises "Reply sent." over it. One press, one sentence.
   */
  /**
   * ROWS AN UNSHOWN ENDING LEFT, with the line it said: the Drafts list says it on the row until the
   * message is sent or discarded, and the row with it leaves the list. Opening it is not sending it.
   * The toast can be replaced or missed; this cannot.
   */
  const [notSentRows, setNotSentRows] = useState<ReadonlyMap<string, string>>(() => new Map());
  /**
   * The composer holds a message other than this row, with something in it worth keeping: not one
   * whose own send is carrying its words now (it waits read-only, and its send and row keep them).
   */
  const composerHoldsOther = useStableCallback((rowId: string): boolean =>
    autosave.draftId !== rowId && reopenWouldOverwrite(composeRef.current, EMPTY_COMPOSE)
    && !(mailSend.pressHere(COMPOSE_SEND_KEY) && SEND_IN_FLIGHT_PHASES.has(mailSend.stateOf(COMPOSE_SEND_KEY).phase)));
  /**
   * WHERE AN UNSHOWN ENDING'S OPEN GOES; `false` when nothing opened. A reply or forward opens its own
   * editor, which holds the words the press sent (the row can hold older ones when the save was
   * refused); the row only when that editor holds nothing. A letter opens by the row its refusal
   * left, with its own press's files (`m`): the composer stands for it only while it holds that row.
   * Never into the composer over a different message being written.
   */
  const openNotSent = useStableCallback((lane: string, left: RefusedRow | undefined, m?: MailSendMutation): boolean => {
    const row = left === undefined ? undefined : drafts.find((d) => d.id === left.rowId);
    const blocked = (): boolean => {
      if (row === undefined || !composerHoldsOther(row.id)) return false;
      toast(t("compose.notSentOpenBlocked"));
      return true;
    };
    if (lane === COMPOSE_SEND_KEY) {
      if (row === undefined || autosave.draftId === row.id) {
        go("compose");
        return true;
      }
      if (blocked()) return false;
      openDraft(row, m?.attachments);
      return true;
    }
    const forward = lane.startsWith(inlineForwardKey(""));
    const id = forward ? lane.slice(inlineForwardKey("").length) : lane;
    const parent = reader.get<EngineMessage>("message", id);
    if (parent && (forward || row === undefined || !isRichEmpty(readReplyDraft(lane)))) {
      // A dock closed at the hand-off gets its audience, files and From back as it opens (`pressBackOf`).
      if (forward) openForward(id); else openReply(id);
      openMessageRef.current(parent, { reply: true });
      return true;
    }
    if (row === undefined) return false;
    // `openDraft` takes the composer for a row whose parent is not here.
    const inReader = row.inReplyToMessageId != null && reader.get<EngineMessage>("message", row.inReplyToMessageId) != null;
    if (!inReader && blocked()) return false;
    openDraft(row);
    return true;
  });
  /** Endings held while the window is hidden, all said at the next visible edge. */
  const heldEndings = useRef<UnshownEnding[]>([]);
  /**
   * What the standing notice covers, so a second ending widens it rather than replacing it. `own`:
   * it says one ending's own line ({@link keptNotSent}), which no count replaces while it stands.
   */
  const lastSaid = useRef<{ at: number; lanes: ReadonlySet<string>; own: boolean } | null>(null);
  const onVisibleRef = useRef<(() => void) | null>(null);
  useEffect(() => () => {
    heldEndings.current = [];
    if (onVisibleRef.current) document.removeEventListener("visibilitychange", onVisibleRef.current);
  }, []);
  /** One ending's own line, with the way back to its lane. */
  const sayEnding = useStableCallback(({ lane, ended, left }: UnshownEnding) => {
    const line = sendLine(ended, false);
    if (line === null) return;
    const scope = lane === COMPOSE_SEND_KEY ? "compose" : "reply";
    toast(t(`${scope}.${line.key}`, sendLineValues()), {
      action: t(`${scope}.notSentOpen`),
      onAction: () => { lastSaid.current = null; openNotSent(lane, left); },
      duration: NOT_SENT_TOAST_MS,
    });
  });
  const sayEndings = useStableCallback((list: readonly UnshownEnding[]) => {
    if (list.length === 0) return;
    const now = Date.now();
    const standing = lastSaid.current !== null && now - lastSaid.current.at < NOT_SENT_TOAST_MS ? lastSaid.current : null;
    /* AN ENDING THE COUNT MAY NOT NAME SAYS ITS OWN LINE, and its instruction outranks the count: an
       unverified send may have been delivered, a duplicate's first copy went or is going, and a refusal
       that named no row left nothing in Drafts. The latest such ending takes the notice; the kept ones
       beside it carry their line on their Drafts rows (`notSentRows`). */
    const own = [...list].reverse().find((e) => !keptNotSent(e));
    if (own !== undefined) {
      lastSaid.current = { at: now, lanes: new Set([own.lane]), own: true };
      sayEnding(own);
      return;
    }
    // A standing ending's own line is not replaced by a count, nor widened into one.
    if (standing?.own === true) return;
    const lanes = new Set([...(standing?.lanes ?? []), ...list.map((e) => e.lane)]);
    lastSaid.current = { at: now, lanes, own: false };
    if (lanes.size > 1) {
      toast(t("compose.notSentMany", { count: lanes.size }), {
        action: t("compose.notSentOpen"),
        onAction: () => { lastSaid.current = null; go("drafts"); },
        duration: NOT_SENT_TOAST_MS,
      });
      return;
    }
    sayEnding(list[list.length - 1]!);
  });
  /**
   * A SEND THAT ENDED WITHOUT DELIVERY WHILE NO SURFACE SHOWED ITS LANE: the line its editor would
   * say, as a toast with the way back, and on its Drafts row until it is sent or discarded. Without it a reply
   * pressed and left said nothing at all.
   */
  const markNotSentRow = useStableCallback((lane: string, ended: SendState, left: RefusedRow | undefined) => {
    const line = sendLine(ended, false);
    if (line === null || left === undefined) return;
    const said = t(`${lane === COMPOSE_SEND_KEY ? "compose" : "reply"}.${line.key}`, sendLineValues());
    setNotSentRows((was) => new Map(was).set(left.rowId, said));
  });
  const sayUnshownEnding = useStableCallback((lane: string, ended: SendState, left: RefusedRow | undefined) => {
    const line = sendLine(ended, false);
    if (line === null) return;
    const scope = lane === COMPOSE_SEND_KEY ? "compose" : "reply";
    if (left !== undefined) {
      const said = t(`${scope}.${line.key}`, sendLineValues());
      setNotSentRows((was) => new Map(was).set(left.rowId, said));
    }
    if (!documentHidden()) { sayEndings([{ lane, ended, left }]); return; }
    heldEndings.current.push({ lane, ended, left });
    if (onVisibleRef.current !== null) return;
    const onVisible = (): void => {
      if (documentHidden()) return;
      document.removeEventListener("visibilitychange", onVisible);
      onVisibleRef.current = null;
      const held = heldEndings.current;
      heldEndings.current = [];
      sayEndings(held);
    };
    onVisibleRef.current = onVisible;
    document.addEventListener("visibilitychange", onVisible);
  });

  const onSendOutcome = useStableCallback((
    key: string, _m: MailSendMutation, accepted: boolean, phase?: SendPhase, detail?: OutcomeDetail,
  ): boolean => {
    /* A COMPOSE SAVE REFUSED BECAUSE THE ROW MOVED ELSEWHERE: that row is the other version's, so it
       is neither marked not sent nor taken; the composer forks and says so once. */
    const changedRow = !accepted && detail?.ended?.code === "draft_changed" && !key.startsWith("fwd:");
    const changed = changedRow && key === COMPOSE_SEND_KEY;
    const leftRow = changedRow ? undefined : detail?.left;
    if (!accepted && detail?.ended !== undefined && detail.shown === false) {
      // The foot line says it, with Open: only the Drafts row is marked, no toast says it again.
      if (detail.line === true) markNotSentRow(key, detail.ended, leftRow);
      else sayUnshownEnding(key, detail.ended, leftRow);
    }
    if (!accepted && phase === "failed") handBackLane(key);
    // The row a refusal left is the lane's own: the Drafts door to it gets the press back too.
    const owed = handedPress.current.get(key);
    if (!accepted && owed !== undefined && leftRow !== undefined) owed.row = leftRow.rowId;
    // Withdrawn before the wire, once the server answered a Cancel it owed: the words are a draft again.
    if (!accepted && phase === "idle") {
      handedPress.current.delete(key);
      replyAutosave.cancelled(key);
    }
    // Cancelled in another window: the dock showing that send closes as its own Cancel closes it.
    if (!accepted && phase === "idle" && replyToRef.current !== null) {
      const target = replyToRef.current;
      if ((replyModeRef.current === "forward" ? inlineForwardKey(target) : target) === key) setReplyTo(null);
    }
    // A compose send refused for good names its row, and the composer takes it — one draft, not two.
    const left = detail?.left;
    if (!accepted && left !== undefined && key === COMPOSE_SEND_KEY) {
      settleComposeRef.current({ kind: changed ? "changedElsewhere" : "refusedWithRow", ...left });
    }
    // …and so does a reply or forward lane: its next press sends that row instead of making one.
    // A reply's row changed elsewhere is the other version's: the lane lets go, and its words fork once the phase settles.
    if (!accepted && left !== undefined && key !== COMPOSE_SEND_KEY && changedRow) {
      replyChanged(key, left.rowId);
      setTimeout(() => replyAutosave.fork(key), 0);
    } else if (!accepted && left !== undefined && key !== COMPOSE_SEND_KEY) takeLaneRow(key, left.rowId);
    // Nothing went: a create the press took back too late is the message's row again, or a copy.
    if (!accepted && phase === "failed" && key === COMPOSE_SEND_KEY) composeNotSentRef.current();
    if (!accepted && (phase === "failed" || phase === "idle") && key !== COMPOSE_SEND_KEY) replyAutosave.notSent(key);
    const intent = detail?.andDone;
    if (intent === undefined || !accepted) return false;
    /* The release read NOW, from the Ohbox as presented — and the row's own Done door
       dispatches it, so a refused step is said in the same words. Nothing to release
       answers `false`, and the send's ordinary sentence is said instead. */
    return releaseSendAndDone({
      presented,
      intent,
      dispatch: (mu) => mutateAndReport(mu, null),
      say: (undo) => toastWithUndo(t("reply.toastSentAndDone"), undo),
    });
  });

  /** The strip's Try again hands its confirmed result here — see `send-release.tsx`. */
  const releaseConfirmed = useStableCallback((res: MutationResult) => {
    if (res.status !== "confirmed" || res.andDone === undefined) return;
    // The key is the send's own: a confirmed release reads no lane, only the intent.
    onSendOutcome(res.key, { kind: "mail_send" } as unknown as MailSendMutation, true, undefined, { andDone: res.andDone });
  });

  /** The composer's binding epoch, late-bound like {@link settleComposeRef}: the sent beat's mark. */
  const composeEpochRef = useRef<() => number>(() => 0);
  const mailSend = useMailSend(
    engine, toast, onSendSettled, onSendOutcome,
    (key) => (key === COMPOSE_SEND_KEY ? composeEpochRef.current() : null),
  );
  /**
   * The body comes from REACT STATE, not from `readReplyDraft`. Private mode refuses the
   * `localStorage` write, so re-reading the scratch buffer at press time would send an empty
   * reply — or, with the empty guard in place, refuse to send at all — for anyone browsing
   * privately. The editor is only reachable while `replyTo` is this message, so the guard
   * below is a belt on the same waistband.
   */
  /**
   * WHICH ADDRESSES THIS ACCOUNT CAN SEND FROM. The rule is `compose-from.ts`; this is the one place the two sources
   * of mailboxes are reconciled. `GET /mailboxes` when we have it — it is the only source that knows an address is
   * `disabled`, and the only one with a `createdAt` to order by. The mirror's `"mailbox"` entities otherwise, which
   * is the demo: `"mailbox"` is not an `EntityType` in the change log, so those rows exist only where the
   * FixturesAdapter seeded them. An EMPTY list is "nothing can be named", and every consumer below renders no From
   * line and puts nothing extra on the wire rather than guessing. That is the demo without fixtures, and a Cloud tab
   * before its first poll lands — NOT the Desktop, whose window supplies the same probe on both doors.
   */
  const fromOptions = useMemo(
    () => (facts ? optionsFromFacts(facts) : optionsFromMirror(mailboxes)),
    [facts, mailboxes],
  );

  /**
   * THE INLINE REPLY IS A ROW ON THE ACCOUNT — `reply-autosave.ts`. The form is what the row
   * would hold: the typed body (the signature seals at the send), the subject, the audience as
   * the editor shows it (valid addresses only, as the compose form stores them) and the sender.
   */
  const replyParent = replyTo !== null && replyMode === "reply"
    ? reader.get<EngineMessage>("message", replyTo) ?? null
    : null;
  let replyForm: ReplyDraftForm | null = null;
  if (replyParent !== null) {
    const plan = replyEnvelopePlan(replyParent, ownAddresses, replyAll, null);
    const typed = (line: string): EmailAddress[] => parseRecipients(line).addresses;
    replyForm = {
      lane: replyParent.id,
      threadId: replyParent.threadId ?? null,
      mailboxId: resolveReplyFrom(fromOptions, replyParent.mailboxId, replyFromId).mailboxId ?? replyParent.mailboxId,
      subject: replySubjectEdit ?? replySubject(replyParent.subject),
      subjectEdited: replySubjectEdit !== null,
      body: replyBody.text,
      html: replyBody.html,
      to: replyEnvelope ? typed(replyEnvelope.to) : plan.to ?? [replyParent.from],
      cc: replyEnvelope ? typed(replyEnvelope.cc) : plan.cc ?? [],
      bcc: replyEnvelope ? typed(replyEnvelope.bcc) : [],
    };
  }
  /** Lanes whose last write the outbox took, until the mirror's row holds it. */
  const pendingLanes = useRef(new Set<string>());
  /** The row version a lane's words are based on: held in memory, or stored beside the lane (a reload). */
  const replyBaseOf = (lane: string, row: string): string | null => {
    const held = replyRows.current.get(lane);
    if (held?.row === row && held.rev) return held.rev;
    const r = readReplyMeta(lane).row;
    return r?.id === row ? r.rev ?? null : null;
  };
  /**
   * THE LANE'S ROW MOVED ELSEWHERE: it holds the other version now, so the lane lets go of it, and it is
   * never a seed or prior row to discard. A waiting edit of the lane's own the engine already kept as a
   * new draft is the lane's row next, so one message stays two rows, never three.
   */
  const replyChanged = useStableCallback((lane: string, row: string) => {
    replyRows.current.delete(lane);
    if (replySeedDrafts.current.get(lane) === row) replySeedDrafts.current.delete(lane);
    const prior = priorRows.current.get(lane);
    if (prior !== undefined && (prior.id === row || prior.from === row)) priorRows.current.delete(lane);
    const meta = readReplyMeta(lane);
    const own = replyAutosave.waitedOf(lane);
    const kept = (typeof engine.keptAsNewDrafts === "function" ? engine.keptAsNewDrafts() : [])
      .filter((k) => k.from === row && k.row !== null && own.has(k.key)).at(-1);
    if (kept?.row) {
      const rev = kept.revision ?? engine.read().get<EngineDraft>("draft", kept.row)?.contentRevision ?? undefined;
      replyRows.current.set(lane, { row: kept.row, seen: false, ...(rev ? { rev } : {}) });
      const at = engine.read().get<EngineDraft>("draft", kept.row)?.updatedAt ?? "";
      writeReplyMeta(lane, { ...meta, row: { id: kept.row, at, ...(rev ? { rev } : {}) } });
    } else if (meta.row?.id === row) writeReplyMeta(lane, { ...meta, row: undefined });
    replyAutosave.rebind(lane);
  });
  const replyAutosave = useReplyAutosave(engine, replyForm, {
    rowOf: (lane) => laneRowOf(lane),
    // A send of this reply on its way, a row held for it, or a row it holds and may not write now.
    refuses: (lane) => SEND_IN_FLIGHT_PHASES.has(mailSend.stateOf(lane).phase)
      || sendPendingInOutbox(engine, lane)
      || sendPendingInDurableOutbox(engine, lane)
      || heldReplyRow(lane) !== null
      || (replyRows.current.has(lane) && laneRowOf(lane) === null)
      || (unreadableRows.current.has(lane) && accountReplyRow(lane) !== null),
    baseOf: (lane, row) => replyBaseOf(lane, row),
    changed: (lane, row) => replyChanged(lane, row),
    forked: (_lane, kept) => { toast(t(kept ? "reply.changedElsewhere" : "reply.changedElsewhereUnsaved")); },
    took: (lane, row, text, confirmed, made, revision) => {
      const was = replyRows.current.get(lane);
      const meta = readReplyMeta(lane);
      // A queued write keeps its base: the adapter moves it along this client's own saves when it lands.
      const rev = confirmed ? revision : was?.row === row ? was.rev : meta.row?.id === row ? meta.row.rev : undefined;
      replyRows.current.set(lane, { row, seen: true, ...(rev ? { rev } : {}) });
      const at = engine.read().get<EngineDraft>("draft", row)?.updatedAt;
      const mine = made || (meta.row?.id === row && meta.row.made === true);
      // A queued write is not known to land: the row holds what it last confirmed, the write is pending.
      const holds = confirmed ? sigOf(text.trim()) : meta.row?.id === row ? meta.row.holds : undefined;
      const pending = confirmed ? undefined : sigOf(text.trim());
      if (pending !== undefined) pendingLanes.current.add(lane);
      if (at) {
        writeReplyMeta(lane, {
          ...meta,
          row: {
            id: row, at, ...(holds !== undefined ? { holds } : {}), ...(pending !== undefined ? { pending } : {}),
            ...(mine ? { made: true as const } : {}), ...(rev ? { rev } : {}),
          },
        });
      }
    },
  });
  /* EVERY LANE'S STORED CREATES ARE JUDGED FROM THE MOUNT, shown or not: a reload's replayed create
     is not left standing beside the reply's row until Reply is pressed. */
  useEffect(() => whenComposerReady(() => {
    let keys: string[] = [];
    try { keys = Object.keys(window.localStorage); } catch { return; } // storage blocked
    for (const k of keys) {
      if (!k.startsWith(REPLY_META_PREFIX)) continue;
      const lane = k.slice(REPLY_META_PREFIX.length);
      if ((readReplyMeta(lane).creates ?? []).length > 0) replyAutosave.restore(lane);
    }
  }), []);
  /* A QUEUED WRITE HAS LANDED once the confirmed mirror's row holds its words (never the overlaid
     list, which shows a queued write at once): they are what the row holds. */
  useEffect(() => {
    for (const lane of pendingLanes.current) {
      const row = readReplyMeta(lane).row;
      if (row?.pending === undefined) { pendingLanes.current.delete(lane); continue; }
      const d = engine.store?.get?.<EngineDraft>("draft", row.id);
      if (d == null || d.body === null || sigOf(d.body.trim()) !== row.pending) continue;
      pendingLanes.current.delete(lane);
      // The row holds the lane's words now: its version is their base.
      const rev = d.contentRevision ?? row.rev;
      const held = replyRows.current.get(lane);
      if (held?.row === row.id && rev) held.rev = rev;
      writeReplyMeta(lane, {
        ...readReplyMeta(lane), row: {
          id: row.id, at: d.updatedAt, holds: row.pending, ...(row.made ? { made: true as const } : {}), ...(rev ? { rev } : {}),
        },
      });
    }
  }, [drafts]);

  /**
   * THE LANE KEEPS THE ENVELOPE IT IS WRITTEN UNDER — sender, subject on screen, audience as shown —
   * while it holds text, so a promotion after the parent is gone sends the words to the same people
   * (`promotionPlanFor`). A reply reads it off the form above, a forward off the rows it typed.
   */
  const forwardParent = replyTo !== null && replyMode === "forward"
    ? reader.get<EngineMessage>("message", replyTo) ?? null
    : null;
  const typedLine = (line: string): EmailAddress[] => parseRecipients(line).addresses;
  const laneEnvelope: { lane: string; envelope: LaneEnvelope } | null = replyForm !== null && replyForm.mailboxId
    ? {
      lane: replyForm.lane,
      envelope: { mailboxId: replyForm.mailboxId, subject: replyForm.subject, to: replyForm.to, cc: replyForm.cc, bcc: replyForm.bcc },
    }
    : forwardParent !== null
      ? {
        lane: inlineForwardKey(forwardParent.id),
        envelope: {
          mailboxId: resolveReplyFrom(fromOptions, forwardParent.mailboxId, replyFromId).mailboxId ?? forwardParent.mailboxId,
          subject: forwardSubject(forwardParent.subject),
          to: typedLine(replyEnvelope?.to ?? ""), cc: typedLine(replyEnvelope?.cc ?? ""), bcc: typedLine(replyEnvelope?.bcc ?? ""),
        },
      }
      : null;
  /* THE INLINE FORWARD'S FILES — the lane meta's list, else the lane row's (`forward-files.ts`). */
  const fwdLaneRow = forwardParent !== null ? laneRowOf(inlineForwardKey(forwardParent.id)) : null;
  const replyForward = useForwardFiles(engine, forwardParent?.id ?? null, {
    kept: replyForwardParts ?? (fwdLaneRow !== null ? drafts.find((x) => x.id === fwdLaneRow)?.forwardParts ?? null : null),
    addedBytes: attachmentBytes(replyAttachments),
    maxMessageBytes: forwardParent !== null
      ? resolveReplyFrom(fromOptions, forwardParent.mailboxId, replyFromId).maxMessageBytes : null,
    refusedCode: forwardParent !== null ? mailSend.stateOf(inlineForwardKey(forwardParent.id)).code ?? null : null,
  });
  const removeReplyPart = useStableCallback((id: string) => {
    if (forwardParent === null || replyForward === null) return;
    const next = replyForward.kept.filter((k) => k !== id);
    setReplyForwardParts(next);
    setReplyForwardSaid(false);
    const lane = inlineForwardKey(forwardParent.id);
    writeReplyMeta(lane, { ...readReplyMeta(lane), forwardParts: next });
  });
  const replyForwardFiles: { plan: ForwardFilesPlan; onRemove: (id: string) => void; said: boolean } | null =
    replyForward === null ? null : { plan: replyForward, onRemove: removeReplyPart, said: replyForwardSaid };
  const laneEnvelopeKey = laneEnvelope === null || isRichEmpty(replyBody) ? null : JSON.stringify(laneEnvelope);
  useEffect(() => {
    if (laneEnvelopeKey === null) return;
    const { lane, envelope } = JSON.parse(laneEnvelopeKey) as { lane: string; envelope: LaneEnvelope };
    writeReplyMeta(lane, { ...readReplyMeta(lane), envelope });
  }, [laneEnvelopeKey]);

  /**
   * The body comes from REACT STATE, not from `readReplyDraft`: private mode refuses the `localStorage` write, so
   * re-reading the scratch buffer at press time would send an empty reply — or refuse to send at all — for anyone
   * browsing privately. The editor is only reachable while `replyTo` is this message, so the guard below is a belt on
   * the same waistband. It names a mailbox only to OVERRIDE one: a reply sends from the mailbox the message arrived
   * in, already derived by `Engine.enrich` from the parent, so the ordinary case adds nothing. `mailboxId` is
   * attached only when the resolved sender is NOT the parent's — the parent's mailbox is disabled or gone and
   * `resolveReplyFrom` named a substitute (`InlineReply` saying so on screen), or the reader picked an address in the
   * From selector (`replyFromId`); wire and sentence come from the same call over the same override.
   */

  /**
   * When nothing can be named the field stays off — `sendingMailboxId`'s newest-message guess is a COMPOSE fallback
   * and must never reach a reply.
   */

  /**
   * The envelope reads `ownAddresses`, and it must be the CURRENT one: a callback that captured
   * it once would answer with the identity the account had when the closure was made — on a
   * cold tab the empty list, the unknown-reader envelope — for as long as the closure lived.
   * `useStableCallback` makes that unrepresentable rather than a dependency array: the body is
   * rebuilt every render and reached through a ref, so there is no capture to go stale and no
   * list of names to keep in step with the reads above.
   */
  /**
   * The hand-off for a dock: close only the dock that pressed (a reply or forward opened since on
   * another message stays), and keep its press for every door back to the lane (`pressBackOf`).
   */
  const handOffDock = (lane: string, messageId: string, mode: "reply" | "forward") => (m: MailSendMutation): void => {
    handedPress.current.set(lane, { m, row: null });
    setReplyTo((cur) => (cur === messageId && replyModeRef.current === mode ? null : cur));
  };
  /* The one door both presses take: `andDone` is Send + Done's release, `null` a plain Send. */
  const sendReply = useStableCallback((messageId: string, andDone: SendAndDonePlan | null = null) => {
    const withDone = <T extends object>(o: T): T => (andDone !== null ? { ...o, andDone } : o);
    if (messageId !== replyTo) return;
    // A forward of a row the mirror does not hold reads the row its open resolved (`openForward`).
    const fwdGate = replyMode === "forward" && forwardGate?.id === messageId ? forwardGate : null;
    const parent = reader.get<EngineMessage>("message", messageId)
      ?? (replyMode === "forward"
        ? engine.verbRead().get<EngineMessage>("message", messageId) ?? fwdGate?.seed ?? null
        : null);
    const parentMailbox = parent?.mailboxId ?? null;
    const from = resolveReplyFrom(fromOptions, parentMailbox, replyFromId);
    /**
     * THE SIGNATURE, DERIVED EXACTLY AS THE BLOCK RENDERS IT — same state, same map, same
     * resolved sender — and sealed into the mutation by `withSignature` at THIS press, so a
     * send mid-edit ships the block's current text and never a torn mix. `null` (struck,
     * empty, sender stores none, signatures not yet server-confirmed) leaves the mutation
     * byte-identical to one built before signatures existed.
     */
    const sigText = effectiveSignature(
      replySig,
      consent.signaturesKnown ? consent.signatures : {},
      from.mailboxId,
    );
    /**
     * AND THE MARKUP HALF, from the SAME state and the SAME resolved sender (mail 0098). It is
     * non-null only while the block is showing what the mailbox stores, which is exactly when
     * the block renders the document rather than the text — so the html part of the message
     * carries what was on screen. `null` takes the escaped-text path, byte-identical to the
     * send this line did not exist for.
     */
    const sigHtml = effectiveSignatureHtml(
      replySig,
      consent.signaturesKnown ? consent.signaturesHtml : {},
      from.mailboxId,
    );
    /**
     * THE INLINE FORWARD'S ARM — the same builder the editor's lock judged
     * (`forwardSend`/`forwardEnvelopePlan`, one derivation), sent on the INLINE surface so
     * the outcome lands on the dock's own lane (`inlineForwardKey`) rather than the compose
     * form's. Recipients are the user's edit alone; the server quotes the original and
     * streams its attachments (`mail_send.forwardOf`). Nothing below this block changes for
     * a reply.
     */
    if (replyMode === "forward") {
      if (!parent) return;
      // An unanswered ask sends nothing: the dock shows the ask, not an editor, until confirmed.
      if (fwdGate !== null && !fwdGate.confirmed) return;
      // Files still being read, or too large: said in place of sending.
      if (replyForward?.refusal) {
        setReplyForwardSaid(true);
        return;
      }
      const fwdLane = inlineForwardKey(messageId);
      const fwdRow = laneRowOf(fwdLane);
      const fwdHandOff = mayHandOffFor?.(from.mailboxId ?? parent.mailboxId) === true
        ? handOffDock(fwdLane, messageId, "forward") : undefined;
      const atPress = { row: replyRows.current.get(fwdLane)?.row ?? null, seed: null };
      const went = mailSend.send(
        // The signature seals into the forward's note, and the server appends the quoted
        // original AFTER the body it is handed (`send-service.ts`) — so the block the editor
        // showed sits ABOVE the quoted history in what the recipient reads.
        withLaneRow(fwdRow, withSignature(forwardSend(parent, {
          body: replyBody.text,
          html: replyBody.html ? replyBody.html : null,
          // The resolved sender, or the receiving mailbox — the editor's lock judged the
          // same fallback (`InlineReply`), so the button and the wire agree everywhere the
          // facts are unreadable.
          mailboxId: from.mailboxId ?? parent.mailboxId,
          ...(replyAttachments.length > 0 ? { attachments: replyAttachments } : {}),
          plan: forwardEnvelopePlan(replyEnvelope, fromOptions.map((o) => o.address)),
          confirmed: fwdGate?.confirmed === true && parent.sensitivity?.no_forward === true,
          // The kept files, only once one was removed — the plan the dock's rows were drawn from.
          ...(replyForward?.wire !== undefined ? { forwardParts: replyForward.wire } : {}),
        }), sigText, sigHtml)),
        withDone({ surface: "inline" as const, ...(fwdHandOff ? { handOff: fwdHandOff } : {}) }),
      );
      // A new press owes back nothing of the last; its own hand-off keeps it (`handOffDock`).
      if (went) {
        handedPress.current.delete(fwdLane);
        pressRows.current.set(fwdLane, atPress);
      }
      return;
    }
    // WHO IT IS ADDRESSED TO — `replyEnvelopePlan`, ONE derivation for the head, the lock and this wire. Untouched
    // (`replyEnvelope === null`) it is exactly the old inline resolution: `replyAllRecipients` for a reply-all (the
    // same call that let the button render), `replyRecipients` for the self-authored plain case, nothing otherwise so
    // `Engine.enrich` keeps deriving `[parent.from]` — and never a Bcc, which no reply derives. EDITED, the user's
    // strings are the envelope: To/Cc/Bcc parsed by the compose form's own parser, a typo emptying the whole set so
    // `canSend` refuses it (the same rule `composePlan` enforces, arriving on the same predicate). `ownAddresses`,
    // and NOT `fromOptions` — which is what this line used to pass, and the sentence above ("the same call that let
    // the button render") was true of the call and false of its argument.

    // `fromOptions` answers "what may this account send AS": it falls back to the MIRROR's mailbox rows where `GET
    // /mailboxes` is absent, which is exactly the demo and the desktop shell. `ownAddresses` falls back to `[]`
    // there. So on those two surfaces the bar's predicate computed with an unknown reader while this line computed
    // with a known one, and a self-authored message could show Reply all over an envelope the send then resolved to
    // the plain reply. One question, one source.
    const plan = replyEnvelopePlan(parent, ownAddresses, replyAll, replyEnvelope);
    // A row still held for this message is the hold's to judge, never a row to send from.
    const laneRow = heldReplyRow(messageId) === null ? laneRowOf(messageId) : null;
    // The version the lane's words are based on: a row moved elsewhere refuses the send.
    const laneBase = laneRow !== null ? replyBaseOf(messageId, laneRow) : null;
    // The text this press sends is not saved again, and a create still in the air is undone.
    const unseal = replyAutosave.seal(messageId);
    // Healthy: the dock closes once the send is on disk, and the sidebar's foot finishes it.
    const replyHandOff = mayHandOffFor?.(from.mailboxId ?? parentMailbox) === true
      ? handOffDock(messageId, messageId, "reply") : undefined;
    const atPress = { row: replyRows.current.get(messageId)?.row ?? null, seed: replySeedDrafts.current.get(messageId) ?? null };
    const went = mailSend.send(withSignature({
      kind: "mail_send",
      inReplyTo: messageId,
      // THE ROW A REFUSED SEND LEFT, when this lane took one: sent again rather than made again.
      ...(laneRow !== null ? { draftId: laneRow } : {}),
      ...(laneBase !== null ? { ifContentRevision: laneBase } : {}),
      // The PLAIN half in `body`, always — it is what `canSend` judges and what the
      // optimistic row shows. The markup, when there is any, goes in `html` and the adapter
      // sends it INSTEAD of `body`, so the recipient's plaintext part is the server's own
      // rendering of the same markup rather than this client's second opinion.
      body: replyBody.text,
      html: replyBody.html ? replyBody.html : null,
      // OVERRIDE ENRICH ONLY TO CHANGE THE SENDER. `Engine.enrich` derives the parent's mailbox
      // (`engine.ts:1899`), so the ordinary reply attaches NOTHING and the envelope is unchanged
      // byte-for-byte. `mailboxId` rides only when the resolved sender is genuinely NOT the
      // parent's — a substitution (parent gone/disabled) or an explicit pick of a different
      // address. The last term is what keeps a bare default off the wire: with no facts and no
      // pick, `resolveReplyFrom` still names a fallback id, and forcing THAT would put a guess on
      // the wire the old `from.substituted` path left to `enrich` — which is the byte-identity
      // the untouched-reply guard pins.
      ...(from.mailboxId !== null &&
          from.mailboxId !== parentMailbox &&
          (from.substituted || replyFromId !== null)
        ? { mailboxId: from.mailboxId }
        : {}),
      // FILES, when the user attached any — carried to the send request and stored nowhere
      // (`ComposeAttachment`). Absent on a plain reply, so the untouched mutation is unchanged.
      ...(replyAttachments.length > 0 ? { attachments: replyAttachments } : {}),
      // THE SUBJECT, only when the reader retitled it — `null` attaches nothing, so the
      // untouched reply's mutation stays byte-identical and `Engine.enrich` derives the
      // `Re:` subject exactly as before. Threading never reads this text: the server sends
      // `In-Reply-To`/`References` from the parent row whatever the subject says.
      ...(replySubjectEdit !== null ? { subject: replySubjectEdit } : {}),
      ...replyEnvelopeOnWire(plan),
    }, sigText, sigHtml), withDone({
      heldRow: heldReplyRow(messageId),
      ...(replyHandOff ? { handOff: replyHandOff } : {}),
    }));
    // The send carries the words and makes its own row: a create the pause left on the outbox goes.
    // A new press owes back nothing of the last; its own hand-off keeps it (`handOffDock`).
    if (went) {
      replyAutosave.sending(messageId);
      handedPress.current.delete(messageId);
      pressRows.current.set(messageId, atPress);
    } else {
      // Refused at the door: nothing was sent, and the lane's waiting create is still its row.
      unseal();
    }
  });

  /**
   * SEND + DONE, PRESSED — the SAME send through the same door, carrying its intent. There is one
   * path to SMTP, and the lock, the empty-body guard and the whole failure surface belong to it.
   * The press names the source and the members it saw; the release is read at the confirmation. A
   * source the engine's rule declines is an ordinary Send — the button is not offered there.
   */
  const pressSendAndDone = useStableCallback((messageId: string) => {
    const offered = sendAndDonePlanFor(presented, messageId);
    sendReply(messageId, offered === null ? null : intentOf(offered, messageId));
  });

  /**
   * THE COMPOSE PLAN — the mutation, the rejected recipients and the empty-subject note, all derived in one place
   * from the form (`compose.ts`). The mailbox is resolved here rather than left to `Engine.enrich`, even though
   * enrich would fill a value: the BUTTON has to know whether a mailbox exists, because offering Send on an account
   * with nothing to send from is the inert affordance Compose used to be. One derivation, two consumers — the same
   * discipline as `canSend`. AND IT IS NO LONGER `sendingMailboxId` THAT DECIDES: `sendingMailboxId` answers with the
   * mailbox of the account's NEWEST MESSAGE, which on an account with two connected addresses flips the From line
   * every time the other one receives mail.
   */

  /**
   * It survives only as the last resort for the case `resolveComposeFrom` cannot speak to — no facts and no seeded
   * mirror rows — where it is still better than refusing to send, and where there is no From line on screen for it to
   * contradict.
   */
  /**
   * ── AND THE RECIPIENT MOVES IT, WHILE NOBODY HAS PICKED ─────────────────────────────────
   *
   * `compose.to` is passed so a message addressed to a domain this account itself sends from
   * leaves from THAT address (`domainMatchedFrom`) — the two-businesses case, where the oldest
   * connected mailbox is the wrong company half the time. It is still a derived default: nothing
   * writes `compose.fromMailboxId`, so it re-derives as the recipients change and the selector
   * overrides it, and the id reaches the wire through `composeMailbox` below exactly as the
   * oldest-connected default does. One resolution, one From line, one `mailboxId`.
   */
  const composeFrom = useMemo(
    () => resolveComposeFrom(fromOptions, compose.fromMailboxId, compose.to),
    [fromOptions, compose.fromMailboxId, compose.to],
  );
  const composeMailbox = composeFrom.mailboxId ?? fallbackMailboxId;
  /**
   * THE COMPOSE LANE'S LAST PRESS LET GO OF ITS COMPOSER (`sendCompose`'s hand-off): the person was
   * sent on at the press, and wherever they are when it settles is theirs — the composer opened on it
   * again included (it empties there, and stays).
   */
  const composeHandedOff = useRef(false);
  /**
   * THE COMPOSE FORM IS A ROW ON THE ACCOUNT — see `compose-autosave.ts`.
   *
   * `active` is the route, so a timer armed by the last keystroke cannot write a draft after the
   * user has left. It stays armed while Compose is open and nowhere else; leaving mid-sentence
   * loses at most the last two seconds to the account, and nothing at all to the local buffer,
   * which is written on every keystroke and is what a reload restores from.
   */
  const autosave = useComposeAutosave({
    engine,
    fields: compose,
    mailboxId: composeMailbox,
    /* A reopened draft whose mailbox cannot send resolves to a substitute; autosave leaves the
       row's own mailbox alone, and Send (or a pick) writes the new one. */
    keepRowMailbox: composeFrom.substituted,
    active: route.view === "compose",
    /* THE PRESS-BEFORE-FIRST-SAVE RACE, CLOSED FROM THE WRITE SIDE. While a send of this surface's
       message is on the wire, the armed save must not CREATE a row: the send that carried none
       makes the adapter create one, and a create here would be the second row for one message.
       Read off the lane's live phase rather than a ref, so it clears with the outcome.

       AND OFF THE DURABLE OUTBOX BESIDE IT, which is the half a phase cannot supply: React state
       starts empty on every mount, so a RELOAD inside that window came back with no row, no phase
       and no reason to wait — and the timer created the second row while the replay was still
       carrying the first. `derived` is in this component's render path, so the read re-runs as the
       queue drains. */
    sendInFlight: SEND_IN_FLIGHT_PHASES.has(mailSend.stateOf(COMPOSE_SEND_KEY).phase)
      || sendPendingInOutbox(engine, COMPOSE_SEND_KEY)
      /* AND THE WINDOW NEITHER OF THOSE CAN SEE: a send restored from the last session leaves the
         queue BEFORE it is dispatched, so the outbox reads empty for the whole replay — measured —
         while the composer holds the text whose fate is being decided. The record answers it and
         releases itself at the settle. */
      || mailSend.restoredPending(COMPOSE_SEND_KEY),
    /* THE SURFACE HALF OF INVARIANT T's CLEAR. The hook owns the binding and ends it; emptying
       the form, dropping the reading selection and arriving at the list are this component's
       state, so they are passed in rather than moved. A SEND-LATER confirm lands on the Drafts
       view's Scheduled group — the Ohbox has nothing to show for mail that has not left, and
       arriving at a list that visibly holds the promise is what makes "Scheduled for Fri 18:00"
       a fact rather than a toast. */
    // A fork off screen is said by a toast; on screen the composer's own alert says it.
    onForked: (kept) => {
      if (routeViewRef.current !== "compose") toast(t(kept ? "compose.changedElsewhere" : "compose.changedElsewhereUnsaved"));
    },
    onKeptAsNew: () => { toast(t("compose.keptAsNewElsewhere")); },
    onKeptSent: () => { toast(t("compose.sentElsewhereMovedToDrafts")); },
    onCleared: (toList) => {
      setCompose(EMPTY_COMPOSE);
      // A send that finished after the person moved on (the hand-off) leaves them where they are.
      if (routeViewRef.current !== "compose" || composeHandedOff.current) return;
      setOhboxSel(null);
      go(toList);
    },
    onEmptied: () => {
      setCompose(EMPTY_COMPOSE);
      setComposeResumed(false);
    },
  });
  settleComposeRef.current = autosave.settleCompose;
  // The engine's kept-as-new-draft list, handed to the composer on each change: it takes its own.
  const keptAsNew = useSyncExternalStore(keptSubscriber(engine),
    () => (typeof engine.keptAsNewDrafts === "function" ? engine.keptAsNewDrafts() : NO_KEPT), () => NO_KEPT);
  const keptToComposer = useRef(autosave.keptAsNew);
  keptToComposer.current = autosave.keptAsNew;
  useEffect(() => { if (keptAsNew.length > 0) keptToComposer.current(keptAsNew); }, [keptAsNew]);
  composeEpochRef.current = autosave.epochNow;
  restoredRef.current = autosave.restored;
  releaseDraftIdRef.current = autosave.draftId;
  releaseBindingRef.current = autosave.release;
  composeNotSentRef.current = autosave.notSent;
  /**
   * THE BLOCK STATE FOLLOWS THE ROW. While autosave holds a row, the compose
   * form's signature state mirrors into the editor meta under `draft:<rowId>` — the handle a
   * reload cannot lose — so reopening the same row from Drafts (before or after a reload)
   * restores a struck or edited block. `following` stores nothing: absence IS the resting
   * state, and the meta dies with the row (`settle`, discard, cancel).
   */
  useEffect(() => {
    if (!autosave.draftId) return;
    const sig = compose.sig;
    writeReplyMeta(
      `draft:${autosave.draftId}`,
      sig && sig.kind !== "following" ? { sig } : {},
    );
  }, [autosave.draftId, compose.sig]);

  /**
   * The drafts list, and the two things a row can do. `draftsList` lists what the user can
   * still act on: `draft` rows, plus `unverified` and stranded-`sending` ones — a send that did
   * not confirm holds the only copy of its text, and hiding it made an undelivered message
   * invisible on every surface; `sent` rows and live sends stay out. Opening one: a draft that
   * answers a message THIS DEVICE HOLDS opens in that message's inline editor, where its
   * conversation is on screen; anything else opens in Compose. `repliesHere` is the same
   * predicate the row is labelled from, so badge and destination cannot disagree.
   */

  /**
   * Opening a compose draft ADOPTS its id, so the next autosave PUTs the opened row rather than creating a second
   * beside it. Opening an UNCONFIRMED send does NOT adopt, with two endings: a row this browser holds no unresolved
   * record for is STRANDED (another device sent it, or the record was resolved) — the server refuses to send a row
   * past `draft` again, so the text is recovered into a fresh row (`recoverySeed`) and the stranded one discarded
   * once the fresh send confirms; a row this browser IS still waiting on is PARKED — no fresh row, no fresh session,
   * the record's identity restored and Send refused with the warning. The parked branch decides from the RECORD,
   * never the row's status.
   */

  /**
   * And opening a reply adopts the row into the REPLY lane, never the compose hook (which would point the next
   * compose at a reply row): the inline reply writes that row after a pause and sends from it (`adoptReplyRow`).
   */
  /**
   * ── THE UNCONFIRMED REPLY ROW THIS MESSAGE ALREADY HAS ──────────────────────────────────
   *
   * The inline reply's lane holds only a row the hold leaves free, so its press asked the hold
   * about `null` and got `free` — while the row the previous press created sat at
   * `unverified` and the Drafts list said so. This is the only name that surface has for it.
   *
   * `status !== "draft"` because an ordinary draft cannot be held, and `draftsList` is the same
   * reading the Drafts door shows, so the two doors cannot disagree about which row is held.
   */
  const heldReplyRow = useStableCallback((messageId: string): string | null =>
    drafts.find((d) => d.inReplyToMessageId === messageId && d.status !== "draft")?.id ?? null);
  const draftRepliesHere = useStableCallback(
    (d: EngineDraft): boolean =>
      d.inReplyToMessageId != null && reader.get<EngineMessage>("message", d.inReplyToMessageId) != null,
  );
  /**
   * A DRAFT IS NEVER OPENED WITH A BODY THIS CLIENT DOES NOT HAVE: A bounded sync page can carry a draft row without
   * its text (`EngineDraft.body` is `null` then), and the resume freshen applies page 1 over the mirror on every
   * session older than five minutes. Seeded as "" that row becomes an empty editor, and autosave's next PUT writes
   * the blank over what the person actually wrote. So the text is asked for — `GET /drafts/:id`, one read, the route
   * the AI draft already reads back — and the editor opens only once it has arrived. If it cannot be had, the draft
   * does not open and the row says so; a refusal is the only honest arm, because every other one presents a message
   * as shorter than it is.
   */
  const openDraft = useStableCallback((d: EngineDraft, files?: ComposeAttachment[]) => {
    void openDraftDecision(d, {
      readDraftBody: (id) => engine.readDraftBody(id),
      openWithBody: (row, body) => { openDraftWithBody(row, body, files); },
      unavailable: () => { toast(t("drafts.bodyUnavailable")); },
    });
  });
  /**
   * OPEN A DRAFT WHOSE TEXT IS KNOWN. `body` is a parameter and not read off the row, so the
   * type carries the invariant: this door cannot be reached with a body the mirror does not
   * hold — {@link openDraft} above is the one that decides. `pressed`: the files of the press that
   * left this row, when the door holds that press ({@link openNotSent}); no row stores them.
   */
  const openDraftWithBody = useStableCallback(
    (d: EngineDraft, body: string, pressed?: ComposeAttachment[]) => {
      const parent = d.inReplyToMessageId
        ? reader.get<EngineMessage>("message", d.inReplyToMessageId)
        : null;
      /**
       * THE HOLD IS ASKED FIRST, AND THE REPLY ARM IS WHY: This used to be computed BELOW the reply arm, which meant
       * a held REPLY never reached it: a draft whose parent message is in the mirror was seeded straight into the
       * inline reply editor with Send live, and `replySeedDrafts` marked it for discard on the next confirmed reply.
       * So the one row that must not be re-sent — a message we could not confirm the delivery of — was the one row
       * that opened with a Send button and a second copy of its text, while the same draft opened from the Drafts
       * list was correctly parked. The row in the report that found this IS a reply, which is how it slipped past
       * every check. Moving the read above the arm makes the hold a property of OPENING THE ROW rather than of which
       * surface happens to open it.
       */

      /**
       * A held reply now takes the held view below — the banner, the two verbs, the frozen text — like any other held
       * row.
       */
      const heldRow = readComposeRow();
      const hold = holdOf(engine, {
        lane: COMPOSE_SEND_KEY,
        draftId: d.id,
        session: heldRow !== null && heldRow === d.id ? composeSessionId() : null,
      });
      const parked = hold.kind !== "free";
      const handle = handleOf(engine, d);
      // The composer's own letter, its first save still on its way: the newest words stay on screen.
      if (!parent && handle.kind === "create" && autosave.holdsCreate(handle.key)) {
        composeSeeded.current = true;
        go("compose");
        return;
      }
      if (parent && !parked) {
        /* The lane's handed-off press comes back with its own refused row only: any other reply
           draft opened into the dock is another message, and keeps its own audience. */
        const owed = handedPress.current.get(parent.id);
        if (owed !== undefined && owed.row !== d.id) handedPress.current.delete(parent.id);
        /* The message's own inline editor, seeded with what was written. `openMessageRef` and
           not `openMessage` directly: that callback needs the screener row map and the consent
           partition and is therefore declared far below this one, so the reference is late-bound
           for the same reason `settleComposeRef` is. */
        // The lane takes the row: the reply's pauses write it and its Send sends it.
        setReplyBody(adoptReplyRow(parent.id, d, body, null, false));
        // A REPLY, whatever the dock last was: a forward left open would send this text as one.
        setReplyAll(false);
        setReplyMode("reply");
        /* REMEMBER WHICH ROW SEEDED THIS EDITOR. The send goes from it; one that went without it
           would leave it in Drafts as a copy of a delivered message, reopenable with Send live:
           the double-send bait. `onSendSettled` discards it then, never the row it sent. */
        // A row still waiting on its create is the lane's to settle when it lands (`awaits`).
        const seed = handleOf(engine, d);
        if (seed.kind === "row") replySeedDrafts.current.set(parent.id, seed.id);
        else replySeedDrafts.current.delete(parent.id);
        // The editor opens WITH the message, past the route transition that closes overlays.
        openMessageRef.current(parent, { reply: true });
        return;
      }
      /* THE ROW A HANDED-OFF SEND'S REFUSAL LEFT gets that press's files back: no row stores them,
         and the composer that held them has moved on (or holds them still, and is replaced here). */
      const owedFiles = [...handedPress.current].find(([, p]) => p.row === d.id);
      if (owedFiles !== undefined) handedPress.current.delete(owedFiles[0]);
      const files = parked ? [] : owedFiles?.[1].m.attachments ?? pressed ?? [];
      // `formatRecipientChips`, never a bare join: the seeded string must end in a separator
      // or the LAST stored recipient reopens as raw text in the input — no ×, typing appends
      // to the address — while the others are chips.
      const seeded: ComposeFields = {
        ...(files.length > 0 ? { attachments: files } : {}),
        to: formatRecipientChips(d.to),
        cc: formatRecipientChips(d.cc),
        bcc: formatRecipientChips(d.bcc),
        subject: d.subject,
        body,
        // The row's own markup. Opened as plain text, a formatted draft could be neither saved nor
        // sent. A row whose html the sync page left out opens plain, and the engine
        // then keeps its save from flattening it (`Engine.enrich`).
        html: typeof d.html === "string" ? d.html : "",
        fromMailboxId: d.mailboxId,
        // THE ROW'S FORWARD: a forward kept as a draft reopens as a forward, and its
        // send carries the original — an id, never a copy of the original's words, which the
        // server quotes itself.
        forwardOf: d.forwardOfMessageId ?? null,
        // The files it keeps, as the row holds them (another device's choice included).
        forwardParts: d.forwardOfMessageId ? d.forwardParts ?? null : null,

        // The signature block's state survives exactly as far as this device knows it (review
        // rounds 1–3). The `drafts` row stores prose and no block state, so a draft reopened
        // from ANOTHER device re-offers the block in its resting `following` state — visibly,
        // strikeable again, never silently inside the prose. On THIS device the state lives in
        // the editor meta under the ROW's id (`draft:<id>`, see `ReplyEditorMeta`) — the one
        // handle that survives a reload and names the same message; rounds 2–3 killed both
        // weaker keys (the in-memory autosave id, empty after reload; a content key, since
        // local and server-derived text legitimately differ). The meta lane leads; the
        // in-memory state is the fallback for the row autosave still holds, because storage can
        // refuse (a private window) and a same-session reopen must not resurrect a struck block.
        ...((): Partial<ComposeFields> => {
          if (d.status !== "draft") return {};
          // LIVE STATE IS AUTHORITATIVE for the row the composer still holds:
          // storage can hold an OLDER value than what is on screen right now if a later write
          // was refused (quota exhaustion is the measured case), and `??` would prefer that
          // stale stored value over the newer in-memory edit. Only for a row autosave does NOT
          // hold — a different device's draft, or a stranded row this session never opened —
          // does the stored meta speak at all.
          const sig = autosave.draftId === d.id ? compose.sig : readReplyMeta(`draft:${d.id}`).sig;
          return sig && sig.kind !== "following" ? { sig } : {};
        })(),
      };
      /**
       * IS THIS ROW A MESSAGE WE ARE STILL WAITING TO LEARN THE FATE OF?: Asked FIRST — before the form is touched —
       * because it decides which of the doors below this is, and one of them does not open at all. `holdOf` and not a
       * reading of its own: the SAME question is asked when a reload brings this surface back (`compose-autosave.ts`)
       * and when Send is pressed, and the three answering differently was a duplicate delivery each time. It answers
       * with the record's own names as well as a verdict, because "yes" is not enough here — the parked branch has to
       * put the message's identity BACK, which means knowing what it was. THE SESSION IS ASKED ABOUT ONLY WHEN THE
       * ROW BEING OPENED IS THE ONE THIS COMPOSE IS HOLDING. Passing it unconditionally would park every draft in the
       * account behind one unresolved send, because the session names whichever message the composer has open.
       */

      /**
       * Passing it NEVER misses the message whose record names a session and no row: a send pressed before the first
       * save has only `compose:<session>`, autosave then creates the row moments later, and nothing had attached it
       * to the record — so the row that appears in Drafts belonged to a parked message that the row alone could not
       * identify. `readComposeRow` is the link: that row IS this compose's row, so this compose's session speaks for
       * it.
       */
      /**
       * AND IT DOES NOT OPEN OVER SOMETHING SOMEBODY IS STILL WRITING: The parked door deliberately does NOT re-mint
       * the compose session or clear the scratch buffer — that is what keeps the reopened message recognisable as
       * itself. The cost is that `writeComposeDraft` below then overwrites the buffer of whatever WAS on screen, and
       * that buffer is the only copy of a message the account has not been given yet. Measured on the release
       * candidate: write s2, reopen the held s1, and s2's text was gone with nothing having asked. Saving s2 first is
       * not the alternative — that is a write, and this door has no business writing a row on the way through. So the
       * reopen is REFUSED and says why. Only against unsaved text, and only for a row this composer is not already
       * holding: reopening the very row on screen changes nothing about it.
       */
      if (parked && reopenWouldOverwrite(composeRef.current, seeded)) {
        toast(t("drafts.heldReopenBlocked"));
        return;
      }
      const openSeeded = (): void => {
        setCompose(seeded);
        /**
         * A DIFFERENT MESSAGE, SO A DIFFERENT COMPOSE SESSION. The id is what parks an unresolved send (`compose.ts`),
         * and leaving it in place made one session span every draft this surface opened: a send of the FIRST one that
         * came back unverified then parked whichever draft replaced it, with the warning above a refused Send button.
         * Cleared before the new buffer is written, so the next read of `composeSessionId` mints a fresh id. NOT for a
         * parked row, and that exception is the whole of the defect above. Re-minting is what makes the reopened
         * message a NEW one, and a new message is exactly what the record must not be told: both names it carries — the
         * row and the session — would be off the message at once, the park could not recognise it, Send would light up,
         * and one press would deliver a second copy under a fresh key. Measured end to end, recipient total 2.
         */

        /**
         * `unknown` keeps the session for the same reason, on weaker evidence: this browser cannot read its own record,
         * so it cannot say the message is new either.
         */
        if (!parked) clearComposeDraft();
        writeComposeDraft(seeded);
        if (parked) {
          /**
           * The held message, reopened as itself. No new row, no re-minted session, nothing released and nothing
           * deleted: the record still names this message, so `canSend` refuses the press and the surface shows the
           * sentence that is true about it. Not adopted either, whatever the row's status: a row past `draft` refuses
           * every PUT (`SendService` reserves only from `status='draft'`), and a row still at `draft` is deliberately
           * not adopted, so this branch has ONE behaviour rather than two that differ by a status nobody on this path
           * acts on.
           */

          /**
           * This is also where the recovery door used to be: a stranded `sending` row took a third branch that seeded
           * the text into a FRESH row and sent that — invariant S(2) forbids it (the row whose send is most likely in
           * flight is the last one to send again), and `holdOf` calls every non-`draft` status parked, so the branch is
           * unreachable and gone rather than left as a dead arm.
           */

          /**
           * The identity is RESTORED, not merely left alone. "Left alone" was true only for the door the user came
           * through immediately: any door in between (writing to a contact, a mail link) legitimately mints a new
           * session, so the browser arrives back holding NEITHER of the record's names — the park was recognised but
           * presented under a session the record never heard of: no warning, Send live, one press, a second copy. So
           * both names go back: the record's own session (what `canSend` compares against), and the row, HELD
           * (`writeComposeRow`) and not adopted — the composer takes no row, so nothing PUTs to it and a Discard cannot
           * delete it, while the save effect's create block reads the held id and mints nothing beside it.
           */

          /**
           * `autosave.release()` first, because it clears the held row on its way past and would otherwise erase what
           * is written next; a hold with no session of its own leaves the current session standing — it is named by its
           * row, which is the id being held.
           */
          autosave.release();
          writeComposeRow(hold.kind === "parked" ? hold.draftId ?? d.id : d.id);
          if (hold.kind === "parked" && hold.session != null) writeComposeSession(hold.session);
        } else {
          /* FREE, so it is an ordinary draft and it is adopted: the next autosave PATCHes the row
             that was opened rather than creating a second one beside it. `holdOf` answers `free`
             only for a row the mirror positively calls `draft`, so there is no second arm here for
             a status this branch would have to decide about. */
          // A letter whose first save is still on its way is bound by that create, never its local id.
          if (handle.kind === "create") autosave.awaitCreate(handle.key, seeded);
          else autosave.adopt(handle.id, seeded, handle.revision);
        }
        composeSeeded.current = true;
        go("compose");
      };
      /* WORDS ON SCREEN NO SAVE HOLDS (a refused save): the composer's own save goes first. Still unheld,
         the row they are bound to opens with them on screen, and another row is not opened over them. */
      if (!parked && reopenWouldOverwrite(composeRef.current, seeded)) {
        void autosave.flush().then(() => {
          if (autosave.holdsOnScreen()) openSeeded();
          else if (readComposeRow() === d.id) { composeSeeded.current = true; go("compose"); }
          else toast(t("drafts.reopenBlockedUnsaved"));
        });
        return;
      }
      openSeeded();
    },
  );
  /**
   * THE SCHEDULED SENDS (mail 0077), and their two verbs: The list is every `scheduled` draft, soonest first
   * (`scheduledSendsList`). CANCEL flips the row back to an ordinary draft; the interesting outcome is the refusal —
   * the server's claim got there first and the mail is leaving — which is reported in its own sentence rather than
   * pretending the cancel landed (the overlay rolls back with the rejection, so the row on screen never falsely reads
   * "cancelled"). EDIT is cancel-then-open, in that order and gated on the cancel confirming, because a `scheduled`
   * row is frozen on the server (`DraftsService.update` refuses it) and adopting one for autosave would point every
   * PUT at a 409.
   */
  /**
   * ONLY `confirmed` IS A CANCELLATION. `queued` means the wire refused retryably and the intent is parked — the
   * appointment STILL EXISTS server-side and its clock is still running, so saying "cancelled" (or opening the editor
   * over it) would be the row promising something the server has not done, on the one surface whose whole content is
   * a promise about time. The queued sentence says exactly that state; `rolled_back` is the server's own refusal (the
   * claim won — "already being sent"). The overlay follows the same truth: a queued mutation keeps its optimistic
   * effect, so the row shows un-scheduled while the banner says the cancel has not landed — user-always-wins, with
   * the sentence carrying the doubt.
   */
  const cancelOutcomeToast = useStableCallback((res: { status: string }) => {
    toast(res.status === "confirmed"
      ? t("drafts.scheduleCancelled")
      : res.status === "queued"
        ? t("drafts.scheduleCancelQueued")
        : t("drafts.scheduleCancelTooLate"));
  });
  const cancelSchedule = useStableCallback(
    (draftId: string) => {
      void engine.mutate({ kind: "draft_schedule_cancel", draftId }).then(cancelOutcomeToast);
    },
  );
  const editScheduled = useStableCallback(
    (d: EngineDraft) => {
      void engine.mutate({ kind: "draft_schedule_cancel", draftId: d.id }).then((res) => {
        // A newer press about this row replaced the cancel: it owns the sentence.
        if (res.status === "superseded") return;
        if (res.status !== "confirmed") {
          // NOT opened: adopting a row whose appointment may still stand would point autosave
          // at a frozen row (409 per PUT) and let edits race a send the user believes stopped.
          cancelOutcomeToast(res);
          return;
        }
        // The row is a plain draft now, confirmed; hand `openDraft` the same reading so it
        // ADOPTS rather than treating the row as a stranded send.
        openDraft({ ...d, status: "draft", sendAt: null });
      });
    },
  );
  /**
   * A PERSON ANSWERS FOR A SEND WE COULD NOT CONFIRM: The one sanctioned exit from the hold, and the reason a held
   * row is no longer a dead end. It asks `holdOf` NOTHING, deliberately: every other write site in this shell asks
   * the predicate because it is about to change a message somebody may already have received, and this one is the
   * opposite — it is how the reader tells us WHICH of those two worlds we are in. Gating it on the hold would make
   * the hold unliftable, which is the defect. No toast on success. The row itself is the answer: it either leaves the
   * list (`arrived`) or turns into an ordinary draft with Discard live (`not_arrived`), and saying so in a toast as
   * well would be narrating what the reader can see. A refusal is reported, because that is the case where the screen
   * does NOT change.
   */
  /** Rows this session has already released the durable record for — see the latch below. */
  const resolvedRows = useRef<Set<string>>(new Set<string>());
  const resolveHeldSend = useStableCallback(
    (draftId: string, outcome: "arrived" | "not_arrived") => {
      void engine.mutate({ kind: "draft_resolve", draftId, outcome }).then((res) => {
        // A newer answer about this row replaced this one: it owns the sentence.
        if (res.status === "superseded") return;
        if (res.status !== "confirmed") {
          /* A resolve that did not land leaves the row held; the overlay has already rolled back,
             so the note above it still reads "not confirmed" and the verbs are still there. The
             server refuses a send that may STILL BE RUNNING by name, and that refusal gets its own
             sentence: "it failed" and "not yet" are different things to be told. */
          toast(t(res.error?.code === "send_still_running"
            ? "drafts.resolveStillRunning"
            : "drafts.resolveFailed"));
          return;
        }
        /* THE DURABLE RECORD IS SPENT, AND IT LEAVES BY THE ONE DOOR. The server has answered for
           this row, so the jar entry that was holding the message must go — through the same
           `releaseSendLockForRow` the settled compose uses, never a second release path. Without
           it `holdOf` went on answering `parked` from the record and the row a person had just
           resolved was still undiscardable on this browser. The SESSION is passed only for the row
           this compose is holding — `discardDraft`'s rule, for its reason. */
        if (resolvedRows.current.has(draftId)) return;
        /* THE LATCH, and it is load-bearing: a second confirm for this row arriving late (a
           double-tap, a replayed verb) would release whatever record names the row AT THAT MOMENT
           — and by then a fresh send of the recovered text may have minted one. Freeing a key a
           request is still carrying is how the next press mints a second one. Released once. */
        resolvedRows.current.add(draftId);
        const heldRow = readComposeRow();
        releaseSendLockForRow(
          COMPOSE_SEND_KEY, draftId,
          heldRow !== null && heldRow === draftId ? composeSessionId() : null,
          sendLockOwed(engine),
        );
      });
    },
  );
  /**
   * SEND THE WORDS AGAIN, from the Drafts list: the server's answer `not_arrived` frees the row to
   * an ordinary draft (the ledger records the attempt as failed), the durable record is released,
   * and only then does the message open — in front of the person, with Send live. Never a blind
   * re-send from a list: sending stays a decision taken while looking at the message. A refusal
   * leaves the row held and says so; the open is not attempted on a row the server did not free.
   */
  const sendAgain = useStableCallback((d: EngineDraft) => {
    void engine.mutate({ kind: "draft_resolve", draftId: d.id, outcome: "not_arrived" }).then((res) => {
      if (res.status === "superseded") return;
      if (res.status !== "confirmed") {
        toast(t(res.error?.code === "send_still_running"
          ? "drafts.resolveStillRunning"
          : "drafts.resolveFailed"));
        return;
      }
      if (!resolvedRows.current.has(d.id)) {
        resolvedRows.current.add(d.id);
        const heldRow = readComposeRow();
        releaseSendLockForRow(
          COMPOSE_SEND_KEY, d.id,
          heldRow !== null && heldRow === d.id ? composeSessionId() : null,
          sendLockOwed(engine),
        );
      }
      openDraft({ ...d, status: "draft", sendError: null, sendAt: null });
    });
  });
  /**
   * ── WHERE A LANE'S REPLY HAS GOT TO, THE ROW INCLUDED ───────────────────────────────────
   *
   * `mailSend.stateOf` alone reads the durable RECORD, which a sweep, a seven-day TTL or another
   * device can leave this browser without — and the reply reported in the field had been held for
   * a month. The server's `unverified` on the row is the witness that outlives all three, so the
   * same projection the compose form renders through is applied here.
   *
   * A forward's lane (`fwd:<id>`) names no reply row, so it passes through untouched.
   */
  const replySendState = useStableCallback((lane: string): SendState => {
    const state = replyDockState(engine, mailSend.stateOf(lane), lane);
    const row = heldReplyRow(lane);
    if (row === null) return state;
    return heldRowUnverified(
      state, row, holdOf(engine, { lane, draftId: row, session: null }), null, lane,
    );
  });
  /**
   * THE LAST REFUSED DISCARD, AND WHY — rendered by the Drafts list in that row as a sentence and
   * focused there. Stamped rather than cleared: the effect that reads it fires once per press, and
   * a value left standing can only be re-read by another press, which carries its own stamp.
   */
  const [discardRefusal, setDiscardRefusal] = useState<DiscardRefusal | null>(null);
  /**
   * Empty the composer and every reply lane bound to this row, with their stored copies. `create`:
   * the row's first save is still on its way, and the editors that claim it end with it.
   */
  const emptyEditorsOf = useStableCallback((draftId: string, heldRow: string | null, create: string | null = null) => {
    const composer = create !== null ? autosave.holdsCreate(create) : releaseDraftIdRef.current === draftId || heldRow === draftId;
    if (composer) {
      // A create ends with its message: taken back, or dropped when it lands.
      if (create !== null) void autosave.discard();
      else releaseBindingRef.current();
      setCompose(EMPTY_COMPOSE);
      clearComposeDraft();
      setComposeCloseRefusal(null);
    }
    const row = engine.read().get<EngineDraft>("draft", draftId) ?? null;
    const lanes = new Set<string>();
    for (const [lane, seed] of replySeedDrafts.current) if (seed === draftId) lanes.add(lane);
    for (const [lane, held] of replyRows.current) if (held.row === draftId) lanes.add(lane);
    for (const lane of [row?.inReplyToMessageId, row?.forwardOfMessageId ? inlineForwardKey(row.forwardOfMessageId) : null]) {
      if (lane && readReplyMeta(lane).row?.id === draftId) lanes.add(lane);
      if (lane && create !== null && replyAutosave.owns(lane, create)) lanes.add(lane);
    }
    for (const lane of lanes) {
      replySeedDrafts.current.delete(lane);
      replyRows.current.delete(lane);
      replyAutosave.forget(lane);
      clearReplyLane(lane);
      setReplyTo((cur) => (cur !== null && (replyModeRef.current === "forward" ? inlineForwardKey(cur) : cur) === lane ? null : cur));
    }
  });
  const discardDraft = useStableCallback(
    (listed: string) => {
      /* A ROW WHOSE FIRST SAVE IS STILL ON ITS WAY has a local id the server never held: the create
         is taken back, and every editor claiming it ends with it. One that already landed is its row. */
      const shown = engine.read().get<EngineDraft>("draft", listed);
      const handle = shown !== undefined ? handleOf(engine, shown) : null;
      if (handle?.kind === "create") {
        emptyEditorsOf(listed, readComposeRow(), handle.key);
        if (typeof engine.withdrawQueued === "function") void engine.withdrawQueued(handle.key).catch(() => undefined);
        return;
      }
      const draftId = handle?.kind === "row" ? handle.id : listed;
      const discardRow = (withdrew: boolean): void => {
        /**
         * THE LIST'S DELETE ASKS THE HOLD, AND THE SERVER DECIDES. `discardDecision` keeps two refusals
         * on this side — a row still `sending`, a jar this browser cannot read — each rendered in the
         * row. Every other hold goes to the wire: the server admits the discard of an `unverified` row
         * and refuses a running send by name (409 `send_recorded`), which comes back as the same
         * rendered sentence. THE SESSION IS ASKED ABOUT ONLY FOR THE ROW THIS COMPOSE IS HOLDING —
         * `openDraft`'s rule: passing it unconditionally would park every draft behind one send.
         */
        const heldRow = readComposeRow();
        const hold = holdOf(engine, {
          lane: COMPOSE_SEND_KEY,
          draftId,
          session: heldRow !== null && heldRow === draftId ? composeSessionId() : null,
        });
        const decision = discardDecision(hold);
        if (decision.kind === "refuse") {
          setDiscardRefusal({ draftId, why: decision.why, at: Date.now() });
          return;
        }
        /* DISCARD DISCARDS: every editor holding this row is emptied before the request goes, its
           stored copy too, or the words come back on the next Compose, Reply or reload. A refusal
           below leaves the row in Drafts, where it can be opened again. */
        // Read before the emptying spends the session, for the release once the server answers.
        const session = heldRow !== null && heldRow === draftId ? composeSessionId() : null;
        emptyEditorsOf(draftId, heldRow);
        // THIS PAGE'S OWN DELETE: its tombstone may land before the answer lets go of the editor.
        ownDraftDiscard(draftId, true);
        let queued = false;
        void engine.mutate({ kind: "draft_discard", draftId }).then((res) => {
          queued = res.status === "queued";
          if (res.status === "rolled_back" && res.error?.code === "send_recorded") {
            // A send still running, said by the server under its row lock: the row stays, and says why.
            setDiscardRefusal({ draftId, why: "still-sending", at: Date.now() });
            return;
          }
          /**
           * EVERY OTHER ENDING SAYS WHY, AND THE SWITCH IS TOTAL. `if (res.status !== "confirmed") return;`
           * stood here and swallowed three of the four endings while the engine had already put the row
           * back with the rejection's own sentence on the result for this surface to say. The `never` arm
           * is the point: a fourth answer cannot be added without this site being made to answer for it.
           * It switches on the VERDICT, because `pressVerdict` is the one place the statuses are read.
           */
          const v = pressVerdict(res);
          switch (v.kind) {
            case "refused": {
              /* The engine dropped the overlay and the row is back (`engine.ts` — "the local effect rolls
                 back VISIBLY, once"). The server's sentence is quoted, `scheduleFailedNote`'s treatment:
                 `conflict` names cancelling the schedule, and a 403/500 names itself. */
              const reason = v.refusal?.message?.trim();
              toast(reason
                ? t("drafts.discardRefused", { reason })
                : t("drafts.discardRefusedUnnamed"));
              return;
            }
            case "queued":
              /* `retry`: the overlay is KEPT and the verb replays under the same key, so the row is gone
                 here and not there. `organizer`: the optimistic paint went back, so the row is on screen
                 and the request is recorded for whichever install organizes this mailbox. Told as
                 "not yet" either way, never as done. */
              toast(v.wait === "organizer" ? t("drafts.discardAwaitingOrganizer") : t("drafts.discardQueued"));
              return;
            case "applied":
              if (withdrew) toast(t("drafts.discardedNotSent"));
              break;
            case "silent":
              // A newer press about this draft owns the sentence.
              return;
            default: {
              /* The gate is the BINDING, evaluated by `tsc`: a fourth `PressVerdict` makes this line
                 a type error at this site. The toast is only the belt for a build that got past it,
                 and it is the most conservative of the sentences rather than one nobody can reach —
                 a state the product cannot enter is a state no guard can be watched fail in. */
              const unhandled: never = v;
              void unhandled;
              toast(t("drafts.discardRefusedUnnamed"));
              return;
            }
          }
          // The row's life ends; the block state keyed to it goes with it — and so does the durable
          // record this browser held for it: the server has answered for the row, so the jar entry
          // leaves by the one door, once (`resolveHeldSend`'s latch, for its reason).
          if (!resolvedRows.current.has(draftId)) {
            resolvedRows.current.add(draftId);
            releaseSendLockForRow(COMPOSE_SEND_KEY, draftId, session, sendLockOwed(engine));
          }
          writeReplyMeta(`draft:${draftId}`, {});
        }).then(() => {
          // Forgotten once the answer above has been handled; a queued delete is still this page's.
          if (!queued) ownDraftDiscard(draftId, false);
        });
      };
      /* A SEND WAITING ON THIS ROW IS CANCELLED FIRST: a row deleted under it left the send to fail on its
         next try. On its way, or a Cancel nobody could confirm, nothing is deleted. */
      const waiting = (typeof engine.waitingSends === "function" ? engine.waitingSends() : [])
        .filter((w) => w.draftId === draftId || (w.draftId === null && w.paintId === listed));
      if (waiting.length === 0) { discardRow(false); return; }
      void (async () => {
        for (const w of waiting) {
          const said = await mailSend.withdrawKey(w.key);
          if (said === "already_sent") { setDiscardRefusal({ draftId, why: "still-sending", at: Date.now() }); return; }
          if (said !== "close") { setDiscardRefusal({ draftId, why: "cancel-unknown", at: Date.now() }); return; }
        }
        // A send with no row of its own: nothing is left to delete.
        if (waiting.every((w) => w.draftId === null)) { toast(t("drafts.discardedNotSent")); return; }
        discardRow(true);
      })();
    },
  );
  /* `autosave.draftId` goes on the mutation, so Send uses the row autosave already wrote instead
     of creating a second one — the whole point of one draft from first keystroke to delivery. */
  /* THE ORIGINAL'S FILES ON A COMPOSED FORWARD — the form's own list, else the bound row's, so another
     device's choice is honoured live until something is removed here (`forward-files.ts`). */
  const composeRowParts = autosave.draftId !== null
    ? drafts.find((x) => x.id === autosave.draftId)?.forwardParts ?? null
    : null;
  const composeForward = useForwardFiles(engine, compose.forwardOf ?? null, {
    kept: compose.forwardParts ?? composeRowParts,
    addedBytes: attachmentBytes(compose.attachments ?? []),
    maxMessageBytes: composeFrom.maxMessageBytes,
    refusedCode: mailSend.stateOf(COMPOSE_SEND_KEY).code ?? null,
  });
  const composeWire = composeForward?.wire;
  const composeWireKey = composeWire === undefined ? "" : composeWire.join(",");
  const plan = useMemo(
    () => composePlan({ ...compose, forwardParts: composeWire ?? null }, composeMailbox, autosave.draftId),
    // `composeWireKey` stands for the list, which is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [compose, composeMailbox, autosave.draftId, composeWireKey],
  );
  /** A press refused for the forward's files: said in place of sending, until something changes. */
  const [composeForwardSaid, setComposeForwardSaid] = useState(false);
  const removeComposePart = useStableCallback((id: string) => {
    if (composeForward === null) return;
    const next = (compose.forwardParts ?? composeRowParts ?? composeForward.kept).filter((k) => k !== id);
    setComposeForwardSaid(false);
    onComposeFields({ ...compose, forwardParts: next });
  });
  const onComposeFields = useStableCallback((next: ComposeFields) => {
    setCompose(next);
    writeComposeDraft(next);
    // The close's refusal was about the text as it stood; an edit makes it a stale sentence.
    setComposeCloseRefusal(null);
  });
  /**
   * A SECOND PRESS AFTER `unverified` IS A FRESH SEND, AND IT HAS TO BUILD A FRESH ROW. The warning's contract
   * ("check your Sent folder before retrying") predates autosave, and autosave silently broke it for Compose: the
   * plan still carried the row's id, the row is `unverified`, and `SendService` refuses any key on a row past `draft`
   * — so the retry answered 409 "cannot be sent from status 'unverified'" forever. The press releases the stranded
   * row (kept, as the record of the unconfirmed first attempt — it is in Drafts saying so) and sends WITHOUT a row
   * id, so the adapter writes a fresh draft and a fresh reservation: exactly what the inline reply has always done.
   * When this send confirms, `onSendSettled` discards the stranded copy. AND THIS PATH IS NOT REACHED FOR A MESSAGE
   * THIS BROWSER IS STILL WAITING ON.
   */

  /**
   * "The next press is a deliberate fresh send" was the whole contract once and is no longer: while an unresolved
   * record names the message, `canSend` refuses the press, so there is no second press to build a row for. What
   * arrives here is a message with no such record — the stranded row above, or a record already resolved. A fresh
   * send of a message whose outcome nobody knows is precisely the duplicate delivery, and it is refused rather than
   * rebuilt.
   */
  const sendCompose = useStableCallback((sendAt?: string) => {
    /**
     * THE SIGNATURE, DERIVED EXACTLY AS THE BLOCK RENDERS IT — the form's own state, the server-confirmed map, and
     * the SAME `composeFrom.mailboxId` the block was handed — sealed at this press by `withSignature`, so a send
     * mid-edit ships the block's current text and never a torn mix. `null` (struck, empty, sender stores none,
     * signatures not yet confirmed) leaves the mutation byte-identical to one built before signatures existed.
     * Deliberately NOT serialized into `plan.mutation` itself: `canSend` judges the TYPED body, and a signature must
     * never light Send up over an empty message.
     */

    /**
     * SEND LATER (mail 0077) is the SAME press with `sendAt` on the mutation — the one send machine keeps its lock
     * and its rules, the adapter turns the field into an appointment instead of a delivery, and the recovery branch
     * below applies identically (a recovered unverified message may be scheduled as legitimately as it may be
     * resent).
     */
    // A forward whose files are still being read, or too large, answers in words and sends nothing.
    if (composeForward?.refusal) {
      setComposeForwardSaid(true);
      return;
    }
    const sigText = effectiveSignature(
      compose.sig ?? SIG_FOLLOWING,
      consent.signaturesKnown ? consent.signatures : {},
      composeFrom.mailboxId,
    );
    // The markup half, same state, same resolved sender (mail 0098) — see the reply arm above.
    const sigHtml = effectiveSignatureHtml(
      compose.sig ?? SIG_FOLLOWING,
      consent.signaturesKnown ? consent.signaturesHtml : {},
      composeFrom.mailboxId,
    );
    // The version the words on screen are based on rides too: the send's save states it, so a row
    // moved elsewhere refuses the edit and sends nothing.
    const based = autosave.baseNow();
    const withWhen = (m: MailSendMutation): MailSendMutation => {
      const at = sendAt ? { ...m, sendAt } : m;
      return based !== null && at.draftId ? { ...at, ifContentRevision: based } : at;
    };
    /**
     * NO FRESH-KEY RESEND AFTER AN UNVERIFIED SEND. This used to shed the draft id and send again. Every part of that
     * was the duplicate: a send with no draft id creates a NEW draft, `useMailSend` mints a NEW key for it, and the
     * server's uniqueness is `(account_id, idempotency_key)` — so the second reservation collides with nothing and
     * both can deliver the same message. `unverified` is terminal-UNKNOWN, not failed. The reservation may already
     * have gone. The send therefore parks: `canSend` refuses while the phase stands, the durable lock keeps the
     * original key rather than releasing it, and the person is shown that it needs checking. A retry that reuses the
     * key is safe; nothing here may invent a new one.
     */
    /* HEALTHY, AND NOT SEND LATER: the composer lets go once the send is on disk and the sidebar's foot
       finishes it. The form, the buffer and the session stay bound to this message until it settles.
       Its press is kept for the files a door back to its row would otherwise lose (`handedPress`). */
    const handOff = !sendAt && mayHandOffFor?.(composeMailbox ?? null) === true
      ? (m: MailSendMutation): void => {
        handedPress.current.set(COMPOSE_SEND_KEY, { m, row: null });
        composeHandedOff.current = true;
        if (routeViewRef.current !== "compose") return;
        setOhboxSel(null);
        go("ohbox");
      }
      : undefined;
    // The send carries the words and makes its own row: a create the pause left on the outbox goes.
    if (mailSend.send(withWhen(withSignature(plan.mutation, sigText, sigHtml)), handOff ? { handOff } : undefined)) {
      autosave.sending();
      handedPress.current.delete(COMPOSE_SEND_KEY);
      composeHandedOff.current = false;
    }
  });

  /**
   * ABANDONING THE COMPOSE — the row, the buffer and the form, in that order. `ComposeView` decides whether to ask
   * first (`worthSaving`); this is what happens once the answer is yes, and it has to be the shell's because the
   * draft id is. All three copies of the message are named here on purpose — the account row (`autosave.discard`),
   * the `localStorage` scratch buffer (`clearComposeDraft`) and the in-memory form — because leaving any one of them
   * is a message the user threw away coming back: the row would sit in Drafts, and the buffer would refill the form
   * the next time Compose opened. `discard` is not awaited. It is fire-and-forget for the same reason `discardDraft`
   * above is: the delete is queued through the engine, which owns the retry, and holding the view open until the wire
   * answers would make leaving a message feel like a network operation.
   */
  /** Whether Discard would keep the composer's row, and why — the question and the press ask it. */
  const discardKeepsCompose = useStableCallback((): "held" | "unknown" | null => {
    const row = autosave.draftId ?? readComposeRow();
    return discardKeepsRow(holdOf(engine, { lane: COMPOSE_SEND_KEY, draftId: row, session: composeSessionId() }), row);
  });
  const cancelCompose = useStableCallback(() => {
    void (async () => {
      /**
       * CANCEL CANCELS, AND THE SEND IS THE FIRST THING IT CANCELS. A queued send is an intent
       * standing on the outbox, which the next reconnect or the next boot delivers; abandoning
       * the compose used to leave it there, so a message somebody had cancelled still went.
       * Withdrawn before the row and the buffer go, or it would race its own cleanup.
       *
       * `already_sent` withdraws nothing — the request has left this device — so the compose
       * stays as it is and the reader is told. Emptying the form over a delivery nobody can take
       * back would be the product claiming to have cancelled something it did not.
       */
      /* ONLY THIS MESSAGE'S SEND: the composer may hold the next message while the last one waits on
         the outbox (the hand-off left it at the press), and throwing this one away withdraws nothing
         of that one's. */
      const own = mailSend.pressHere(COMPOSE_SEND_KEY);
      const said = own ? await mailSend.withdraw(COMPOSE_SEND_KEY) : "close";
      if (said === "already_sent") {
        toast(t("compose.cancelAlreadySent"));
        return;
      }
      // Nothing was cancelled: the compose stays as it is, and pressing again asks again.
      if (said === "unknown") {
        toast(t("compose.cancelUnknown"));
        return;
      }
      // The server could not be asked about a send that may have left: held, and the Cancel stays owed.
      if (said === "unreachable") {
        toast(t("compose.cancelUnreachable"));
        return;
      }
      /* A HELD ROW IS KEPT, AND THE PRESS SAYS SO — `discard` releases it rather than deleting it,
         and closing in silence after a question that promised a delete left the person thinking it
         was gone. Asked before the discard, which spends the binding it reads. */
      const keeps = discardKeepsCompose();
      // This message's own press, withdrawn or thrown away with it, owes no door anything.
      if (own) handedPress.current.delete(COMPOSE_SEND_KEY);
      if (autosave.draftId) writeReplyMeta(`draft:${autosave.draftId}`, {});
      void autosave.discard();
      if (keeps !== null) toast(t(keeps === "held" ? "compose.discardHeld" : "compose.discardUnknown"));
      setCompose(EMPTY_COMPOSE);
      clearComposeDraft();
      setComposeCloseRefusal(null);
      go("ohbox");
    })();
  });

  /**
   * LEAVING THE COMPOSER SAVES WHAT IS IN IT FIRST — Escape and the close control, the two exits
   * that are NOT a discard. "Saved to your drafts after a moment" was false for the length of the
   * debounce: Escape inside those two seconds cancelled the armed save with its timer. The write
   * is AWAITED here so a refusal can keep the composer standing with a sentence rather than close
   * over a message nothing holds; `flush` is the pause's own write and answers `nothing` for the
   * refusals the composer already states, so only `failed` stops the exit. Every other way out
   * takes the hook's belt, which cannot stay open and does not need to.
   */
  const closing = useRef(false);
  const closeCompose = useStableCallback(() => {
    if (closing.current) return;
    closing.current = true;
    void (async () => {
      let flushed: ComposeFlush = { kind: "nothing" };
      try {
        flushed = await autosave.flush();
      } finally {
        closing.current = false;
      }
      // A body past the ceiling is a message the account cannot hold: its note says how to shorten it.
      if (flushed.kind === "tooLong") {
        setComposeCloseRefusal(t("compose.closeNotSaved"));
        return;
      }
      if (flushed.kind === "failed") {
        setComposeCloseRefusal(
          flushed.reason === null
            ? t("compose.closeNotSaved")
            : t("compose.closeNotSavedReason", { reason: flushed.reason }),
        );
        return;
      }
      // The words were kept as a new draft beside a version changed elsewhere: said as the composer goes.
      if (flushed.kind === "forked") toast(t("compose.changedElsewhere"));
      setComposeCloseRefusal(null);
      go("ohbox");
    })();
  });

  /**
   * WRITE TO ONE PERSON — the contact popover's Write verb (viewer redesign). A NEW message with the To line
   * prefilled, in the same `Name <address>` shape `openDraft`'s `line()` writes and `parseRecipients` reads back. The
   * ADDRESS is the stored wire form — the chip decodes only its face — so what reaches the envelope is what the
   * mirror holds. IT RELEASES THE AUTOSAVE FIRST: This seeds a NEW message. Without the release, `composePlan` would
   * still carry the `draftId` of whatever the form last held — an unrelated draft, possibly one opened from the
   * drafts list — so this send would overwrite that row and send from it. `openDraft` adopts for exactly the opposite
   * reason; this is the same rule read the other way round.
   */

  /**
   * (The rule used to be stated on `forwardMessage`, the compose-seeding forward this shell no longer has — Forward
   * is the thread's inline dock now, `openForward`, and never touches the compose form at all.)
   */
  const writeTo = useStableCallback(
    (address: string, name?: string, more?: Pick<ComposeFields, "subject" | "body" | "diag">) => {
      const seeded: ComposeFields = {
        ...EMPTY_COMPOSE,
        // Settings › Help & contact's Write to us: the subject and the diagnostics block in the body.
        ...more,
        // The chips form: a prefilled recipient is settled, so it must open as a chip, not as
        // raw text in the input — the same rule as `openDraft`.
        to: formatRecipientChips([{ name: name ?? null, address }]),
      };
      /* ── A NEW-MESSAGE DOOR MUST NOT ORPHAN A HELD MESSAGE ───────────────────────────────
         This re-mints the compose session (below), which is right for a new message and is how a
         held one loses a name: a send pressed before the first save is recorded as
         `compose:<session>` alone, so once that session is replaced the record names nothing this
         browser can find, the row sits in Drafts looking ordinary, and reopening it takes the
         ordinary door with Send live. Binding the row the surface is holding onto the record
         first leaves the park reachable by ROW, which is the name that survives every door. */
      const openNew = (): void => {
        const outgoing = readComposeRow();
        const held = holdOf(engine, {
          lane: COMPOSE_SEND_KEY, draftId: outgoing, session: composeSessionId(),
        });
        if (held.kind === "parked" && held.session !== null) {
          attachSendLockDraft(COMPOSE_SEND_KEY, [`compose:${held.session}`], outgoing);
        }
        autosave.release();
        setCompose(seeded);
        // A NEW message, so a new compose session — see `openDraft` and `compose.ts`. Without it
        // this message inherited the identity of whatever the form last held, and an unresolved
        // send of THAT message parked this one: the unconfirmed warning, and Send refused, over a
        // message nobody had ever pressed Send on.
        clearComposeDraft();
        writeComposeDraft(seeded);
        // An open inline reply would otherwise sit under the compose the route change opens —
        // one editor at a time.
        setReplyTo(null);
        composeSeeded.current = true;
        go("compose");
      };
      // Words on screen no save holds are not replaced: `openDraft`'s rule.
      if (reopenWouldOverwrite(composeRef.current, seeded)) {
        void autosave.flush().then(() => {
          if (!autosave.holdsOnScreen()) { toast(t("drafts.reopenBlockedUnsaved")); return; }
          openNew();
        });
        return;
      }
      openNew();
    },
  );

  /**
   * A MAILTO CLICK, DELIVERED — the host's `mailtoDraft` prop becoming the compose form. The same five steps as
   * `writeTo`, for the same reasons, one field at a time: release first (or the plan still carries an unrelated
   * draft's id and the send overwrites that row), drop any recovery, seed, persist, close an open inline reply,
   * navigate. Recipients go through the chip formatter so a prefilled address opens settled rather than as raw text;
   * the body is plain text and `html` stays empty, `openDraft`'s rule for a body with no stored HTML. An EFFECT
   * rather than a handler because the trigger is a prop from outside this tree — the OS handed the host a link, the
   * host handed the fields down. `onMailtoDraftSeeded` tells the host to drop its copy, so a remount cannot seed the
   * same click twice over whatever the person typed since.
   */
  useEffect(() => {
    if (!mailtoDraft) return;
    const chips = (list: string[]): string =>
      formatRecipientChips(list.map((address) => ({ name: null, address })));
    const seeded: ComposeFields = {
      ...EMPTY_COMPOSE,
      to: chips(mailtoDraft.to),
      cc: chips(mailtoDraft.cc),
      bcc: chips(mailtoDraft.bcc),
      subject: mailtoDraft.subject,
      body: mailtoDraft.body,
    };
    // The same binding `writeTo` does, for the same reason and in the same order — this door is
    // that one, opened by the operating system rather than by a click inside the app.
    const outgoing = readComposeRow();
    const held = holdOf(engine, {
      lane: COMPOSE_SEND_KEY, draftId: outgoing, session: composeSessionId(),
    });
    if (held.kind === "parked" && held.session !== null) {
      attachSendLockDraft(COMPOSE_SEND_KEY, [`compose:${held.session}`], outgoing);
    }
    autosave.release();
    setCompose(seeded);
    // A new compose session, for the reason `writeTo` states — this door is the same one, opened
    // by the operating system rather than by a click inside the app.
    clearComposeDraft();
    writeComposeDraft(seeded);
    setReplyTo(null);
    composeSeeded.current = true;
    go("compose");
    onMailtoDraftSeeded?.();
  }, [mailtoDraft, autosave, go, onMailtoDraftSeeded]);

  /** Settings › Help & contact's Write to us: `writeTo`'s door, with the subject and the block. */
  const writeSupport = useStableCallback((seed: SupportSeed) => {
    writeTo(seed.to, undefined, { subject: seed.subject, body: seed.body, diag: seed.diag });
  });
  /**
   * The address book for the reply's recipient rows — the same ranked selector the compose
   * To field builds, derived when a reply OPENS rather than per keystroke or per delta: the
   * set of people this account has corresponded with does not change while somebody types a
   * name, which is `ComposeView`'s own once-per-mount reasoning keyed to the editor instead
   * of the route. Own addresses are excluded for the reason compose excludes the sender:
   * suggesting somebody their own address as a recipient is noise.
   */
  const replyBook = useMemo(
    () => (replyTo !== null ? addressBook(engine.read(), { exclude: ownAddresses }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, replyTo, ownAddresses],
  );

  return {
    cancelCompose,
    discardKeepsCompose,
    cancelSchedule,
    closeCompose,
    closeReply,
    compose,
    composeResumed,
    composeCloseRefusal,
    confirmForward,
    forwardAsk,
    composeFrom,
    discardDraft,
    notSentRows,
    draftRepliesHere,
    draftReply,
    draftReplyChrome,
    editScheduled,
    heldReplyRow,
    discardRefusal,
    sendAgain,
    mailSend,
    onComposeFields,
    onReplyBody,
    onReplySig,
    onReplySubject,
    openDraft,
    openForward,
    openMessageRef,
    openReply,
    plan,
    pressSendAndDone,
    releaseConfirmed,
    replyAll,
    replyAttachments,
    replyBody,
    replyBook,
    replyDone,
    replyEnvelope,
    replyFromId,
    replyMode,
    replySendState,
    replySig,
    replySubjectEdit,
    resolveHeldSend,
    sendCompose,
    openNotSent,
    composeElsewhere: autosave.elsewhere,
    composeSaveRefused: autosave.saveRefused,
    composeForwardFiles: composeForward === null ? null
      : { plan: composeForward, onRemove: removeComposePart, said: composeForwardSaid },
    replyForwardFiles,
    sendReply,
    setReplyAttachments,
    setReplyEnvelope,
    setReplyFromId,
    toggleReply,
    writeTo,
    writeSupport,
  };
}
