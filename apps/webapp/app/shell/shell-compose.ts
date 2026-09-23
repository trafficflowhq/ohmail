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
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { useTranslations } from "next-intl";
import {
  addressBook,
  draftBodyKnown,
  forwardSubject,
  pressVerdict,
  replySubject,
  sendAndDone,
  sendAndDonePlanFor,
  sendingMailboxId,
  type ComposeAttachment,
  type EngineDraft,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
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
  readComposeDraft,
  readComposeRow,
  writeComposeDraft,
  writeComposeRow,
  writeComposeSession,
  type ComposeFields,
  type ComposePrefill,
  type MailSend as MailSendMutation,
} from "./compose";
import {
  reopenWouldOverwrite,
  useComposeAutosave,
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
import { useDraftReply, type DraftedReply } from "./draft-reply";
import { forwardEnvelopePlan, forwardSend } from "./forward-send";
import {
  COMPOSE_SEND_KEY,
  heldRowUnverified,
  inlineForwardKey,
  promoteOrphanedReplyLane,
  readReplyDraft,
  readReplyMeta,
  REPLY_DRAFT_PREFIX,
  SEND_IN_FLIGHT_PHASES,
  sendPendingInDurableOutbox,
  sendPendingInOutbox,
  useMailSend,
  writeReplyDraft,
  writeReplyMeta,
  type LanePromotionPlan,
  type SendState,
} from "./mail-send";
import type { MailboxFacts } from "./mail-state";
import { readColumnHidden } from "./narrow";
import { appendRich, EMPTY_RICH, isRichEmpty, type RichValue } from "./rich-text";
import { go, type Route } from "./routing";
import { attachSendLockDraft, discardDecision, holdOf, releaseSendLockForRow } from "./send-lock";
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

export interface ShellComposeInput {
  engine: OhmailEngine;
  /** The mirror as it is — `engine.read()` from the render, never re-read here. */
  reader: EntityReader;
  t: ReturnType<typeof useTranslations>;
  toast: ToastFn;
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
  /** Below 900px the reading column is hidden, so an open reply opens the reader too. */
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
}

/** The record the shell composes with. Consumers destructure it: a memo may not depend on it. */
export type ShellCompose = ReturnType<typeof useShellCompose>;

export function useShellCompose({
  engine, reader, t, toast, route, consent, facts, mailboxes, drafts, ownAddresses,
  fallbackMailboxId, replyTo, setReplyTo, setReaderFor, fr, setFr, setFrDone, setFrValues,
  setOhboxSel, mailtoDraft, onMailtoDraftSeeded, presented, mutateAndReport, toastWithUndo,
}: ShellComposeInput) {
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
  useEffect(() => {
    // A FORWARD OPENS WITH THE ROWS ALREADY SHOWING, EMPTY — its audience is the user's to
    // pick and never derived (`forwardEnvelopePlan`), so a collapsed head would name nobody
    // and hide the one thing Send is waiting for. A reply keeps `null`: the computed audience
    // stands until the head is pressed, exactly as before.
    setReplyEnvelope(replyMode === "forward" ? { to: "", cc: "", bcc: "" } : null);
  }, [replyTo, replyAll, replyMode]);
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
  /**
   * RETARGETING HYDRATES RATHER THAN BLIND-RESETS: closing a half-written
   * reply nulls `replyTo`, and a reset that forgot the per-message meta made Escape drop the
   * retitled subject and resurrect a struck signature while the body survived. The meta lives
   * beside the body scratch under the same lane key (`replyMetaKey`), written by the two
   * setters below and cleared by `settle` — so close-and-reopen restores all three halves of
   * the editor or none, and a settled send spends them together.
   */
  useEffect(() => {
    setReplyFromId(null);
    setReplyAttachments([]);
    if (replyTo !== null) {
      const meta = readReplyMeta(replyMode === "forward" ? inlineForwardKey(replyTo) : replyTo);
      setReplySig(meta.sig ?? SIG_FOLLOWING);
      // The subject edit is the REPLY's; a forward carries its own `Fwd:` subject.
      setReplySubjectEdit(replyMode === "reply" ? meta.subject ?? null : null);
    } else {
      setReplySig(SIG_FOLLOWING);
      setReplySubjectEdit(null);
    }
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
  useEffect(() => {
    const saved = readComposeDraft();
    if (saved.to || saved.subject || saved.body) setCompose(saved);
  }, []);
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
    // The mode travels with the open, never separately: a Reply press while a reply-all
    // editor is up on the same message is an explicit narrowing, and vice versa.
    setReplyAll(all);
    setReplyMode("reply");
    setReplyTo(messageId);
    setReplyBody(readReplyDraft(messageId));
    // MOBILE. Under 900px the reading column is `display:none` (app.css), so an inline
    // reply would mount into a pane nobody can see and `r` would look broken — measured on
    // the shipped build at 390px. There, the reader IS the open message, so open it.
    if (readColumnHidden()) setReaderFor(messageId);
  });

  /**
   * The inline forward — the reply dock in forward mode, inside the thread.
   * Replaces the navigation `forwardMessage` used to make (forwarding one
   * message of a conversation meant leaving it for the compose screen).
   * The wire is unchanged — the same `mail_send { forwardOf }`, the server
   * builds the quote and streams the original's attachments, recipients are
   * the user's — only the surface moved: the reply's editor, docked at the
   * thread's foot. The `no_forward` refusal stays client-side courtesy AND
   * server-side law.
   */
  const openForward = useStableCallback((messageId: string) => {
    const m = engine.read().get<EngineMessage>("message", messageId);
    if (!m) return;
    if (m.sensitivity?.no_forward) {
      toast(t("compose.forwardRefused"));
      return;
    }
    setReplyAll(false);
    setReplyMode("forward");
    setReplyTo(messageId);
    setReplyBody(readReplyDraft(replyDraftKey("forward", messageId)));
    // The same mobile rule `openReply` states: below 900px the dock lives in the reader.
    if (readColumnHidden()) setReaderFor(messageId);
  });

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
    void (async () => {
      if (await mailSend.withdraw(lane) === "already_sent") {
        toast(t("compose.cancelAlreadySent"));
        return;
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
   * WHAT A DEAD PARENT STILL LETS A PROMOTED LANE NAME — the mailbox, the subject, the audience.
   * `null` ⇒ nothing can place it, and the lane is left exactly as it is rather than cleared.
   *
   * The audience is the PLAIN reply's, never reply-all: the lane has never held recipients, so
   * widening one nobody asked for would put a half-written sentence in front of a room. With no
   * parent at all (a window that loads after the tombstone) there is neither audience nor subject
   * to derive — the row carries the words, and the compose form is where the rest is filled in.
   */
  const promotionPlanFor = useStableCallback(
    (lane: string, parentId: string, parent: EngineMessage | null): LanePromotionPlan | null => {
      /* `sendingMailboxId` is the COMPOSE fallback, and that is what this row is: a draft the
         person will address and send from the compose form, not a reply going out now. */
      const mailboxId = parent?.mailboxId ?? sendingMailboxId(engine.read());
      if (!mailboxId) return null;
      const meta = readReplyMeta(lane);
      const forward = lane !== parentId;
      const subject = meta.subject
        ?? (parent ? (forward ? forwardSubject(parent.subject) : replySubject(parent.subject)) : "");
      const to = !forward && parent ? (replyRecipients(parent, ownAddresses) ?? [parent.from]) : [];
      return { mailboxId, subject, to };
    },
  );

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
    // Same mobile rule `openReply` states: under 900px the reading column is display:none,
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

  const draftReply = useDraftReply({ onDraft });

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
  /** Late-bound for the same reason as {@link settleComposeRef} — see below where it is assigned. */
  const openMessageRef = useRef<(m: EngineMessage) => void>(() => {});
  /**
   * WHICH DRAFT ROW SEEDED WHICH REPLY EDITOR — `message id → draft id`, written by `openDraft`
   * when a reply draft opens in its message's own inline editor. The inline reply has no
   * autosave, so a send from that editor creates its own row; without this map the seeded row
   * would survive the delivery as a phantom draft — the sent message sitting in Drafts under
   * "haven't sent", reopenable with Send live. Entries leave when the send settles (discarded
   * below) or when the row is discarded from the Drafts list (`discardDraft`).
   */
  const replySeedDrafts = useRef(new Map<string, string>());
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
    if (key.startsWith("fwd:")) {
      const forwarded = key.slice(4);
      // Close ONLY the editor this settlement is about: a late forward confirmation must not
      // take down a REPLY the user has since opened on the same message.
      setReplyTo((cur) =>
        cur === forwarded && replyModeRef.current === "forward" ? null : cur,
      );
      return;
    }
    // A reply seeded from a draft row settled: the row's message has been delivered (the send
    // wrote its own row), so the seed is a phantom draft now — see `replySeedDrafts`.
    const seeded = replySeedDrafts.current.get(key);
    if (seeded) {
      replySeedDrafts.current.delete(key);
      void engine.mutate({ kind: "draft_discard", draftId: seeded });
      writeReplyMeta(`draft:${seeded}`, {}); // the phantom row's block state dies with it
    }
    // A reply settled. `key` is the answered message's id (`sendKeyOf`), which is exactly the row
    // that should move from "New for you" to "Earlier" — so hand it to the Ohbox for the gesture.
    setReplyDone({ messageId: key, at: new Date().toISOString() });
    // The mirror-image of the fwd: guard above: a late REPLY confirmation must not close a
    // FORWARD newly opened on the same message.
    setReplyTo((cur) => (cur === key && replyModeRef.current === "reply" ? null : cur));
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
  /**
   * SEND + DONE — THE ARMED LANES.
   *
   * A press of the second action records the release it earned, keyed by the send lane it
   * pressed on; the send machine answers that lane when the engine confirms the message or when
   * the send reaches a terminal outcome that is not a delivery, and the entry is spent either
   * way. The PLAN is read at the press and not at the answer, which is the whole point of
   * holding it: it names the section the source is in NOW, and the send itself releases a pin
   * as it settles — an inverse read afterwards would put the row back where the send left it.
   */
  const sendDoneArm = useRef(new Map<string, SendAndDonePlan>());

  /**
   * The lane a reply or a forward of this message sends on — the same derivation
   * `MessagePane` hands the editor and `sendKeyOf` builds the key from.
   */
  const replyLaneOf = useStableCallback((messageId: string): string =>
    replyMode === "forward" ? inlineForwardKey(messageId) : messageId);

  /**
   * THE SEND MACHINE'S ANSWER FOR AN ARMED LANE. `accepted` is the engine's confirmation and
   * nothing weaker; the intent is what refuses to dispatch anything without it, here as on the
   * phone. Answering `true` tells the lane the shell has spoken for this send, so the ordinary
   * "Reply sent." is not raised and replaced — one press, one sentence.
   */
  const onSendOutcome = useStableCallback((key: string, _m: MailSendMutation, accepted: boolean): boolean => {
    const plan = sendDoneArm.current.get(key);
    if (plan === undefined) return false;
    sendDoneArm.current.delete(key);
    void sendAndDone({
      plan,
      // The acceptance, read where the send machine knows it. A refused send reaches this
      // door too, and the intent is what makes it dispatch nothing.
      send: () => Promise.resolve(accepted),
      // THE ROW'S OWN DONE DOOR — `mutateAndReport` with no sentence of its own, exactly as
      // the `resurface_done` arm dispatches it, so a refusal is said in the same words.
      dispatch: (mu) => mutateAndReport(mu, null),
    }).then((out) => {
      /* The one sentence this press earns, with the way back: Undo puts the row into the
         section it left. A refused release has already said so in its own words. */
      if (out.kind === "sent_and_done") toastWithUndo(t("reply.toastSentAndDone"), plan.undo);
    });
    return accepted;
  });

  const mailSend = useMailSend(engine, toast, onSendSettled, onSendOutcome);
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
  const sendReply = useStableCallback((messageId: string) => {
    if (messageId !== replyTo) return;
    /* A PLAIN SEND DISARMS THE LANE. Send + Done arms it again immediately after calling this
       (see `pressSendAndDone`); a press that is refused at the door leaves an entry no answer
       will ever spend, and the next plain Send on the same lane must not inherit it. */
    sendDoneArm.current.delete(replyLaneOf(messageId));
    const parent = reader.get<EngineMessage>("message", messageId) ?? null;
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
      mailSend.send(
        // The signature seals into the forward's note, and the server appends the quoted
        // original AFTER the body it is handed (`send-service.ts`) — so the block the editor
        // showed sits ABOVE the quoted history in what the recipient reads.
        withSignature(forwardSend(parent, {
          body: replyBody.text,
          ...(replyBody.html ? { html: replyBody.html } : {}),
          // The resolved sender, or the receiving mailbox — the editor's lock judged the
          // same fallback (`InlineReply`), so the button and the wire agree everywhere the
          // facts are unreadable.
          mailboxId: from.mailboxId ?? parent.mailboxId,
          ...(replyAttachments.length > 0 ? { attachments: replyAttachments } : {}),
          plan: forwardEnvelopePlan(replyEnvelope, fromOptions.map((o) => o.address)),
        }), sigText, sigHtml),
        { surface: "inline" },
      );
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
    mailSend.send(withSignature({
      kind: "mail_send",
      inReplyTo: messageId,
      // The PLAIN half in `body`, always — it is what `canSend` judges and what the
      // optimistic row shows. The markup, when there is any, goes in `html` and the adapter
      // sends it INSTEAD of `body`, so the recipient's plaintext part is the server's own
      // rendering of the same markup rather than this client's second opinion.
      body: replyBody.text,
      ...(replyBody.html ? { html: replyBody.html } : {}),
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
    }, sigText, sigHtml), { heldRow: heldReplyRow(messageId) });
  });

  /**
   * SEND + DONE, PRESSED — the SAME send, and the release armed behind it.
   *
   * `sendReply` is called unchanged and unwrapped: there is one path to SMTP, and the lock, the
   * empty-body guard and the whole failure surface belong to it. The plan is read BEFORE the
   * press (the pre-press mirror is what Undo restores) and armed AFTER it, because `sendReply`
   * disarms the lane on its way in. A source the engine's rule declines is an ordinary Send —
   * the button is not offered there, and a keyboard press falls through to the same place.
   */
  const pressSendAndDone = useStableCallback((messageId: string) => {
    const plan = sendAndDonePlanFor(presented, messageId);
    const lane = replyLaneOf(messageId);
    sendReply(messageId);
    if (plan !== null) sendDoneArm.current.set(lane, plan);
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
    onCleared: (toList) => {
      setCompose(EMPTY_COMPOSE);
      setOhboxSel(null);
      go(toList);
    },
  });
  settleComposeRef.current = autosave.settleCompose;
  releaseDraftIdRef.current = autosave.draftId;
  releaseBindingRef.current = autosave.release;
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
   * And opening a reply does not adopt: the inline editor has no autosave — a per-message scratch buffer — so there
   * is nothing to adopt the id INTO, and adopting it into the COMPOSE hook would point the next compose at a reply
   * row. The draft's text seeds the editor, the row stays, and sending creates its own row — stated because it is the
   * one place the "one row birth-to-sent" rule does not yet reach.
   */
  /**
   * ── THE UNCONFIRMED REPLY ROW THIS MESSAGE ALREADY HAS ──────────────────────────────────
   *
   * The inline reply editor is a per-message scratch buffer and carries no row, so its press asked
   * the hold about `null` and got `free` — while the row the previous press created sat at
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
  const openDraft = useStableCallback((d: EngineDraft) => {
    void openDraftDecision(d, {
      readDraftBody: (id) => engine.readDraftBody(id),
      openWithBody: (row, body) => { openDraftWithBody(row, body); },
      unavailable: () => { toast(t("drafts.bodyUnavailable")); },
    });
  });
  /**
   * OPEN A DRAFT WHOSE TEXT IS KNOWN. `body` is a parameter and not read off the row, so the
   * type carries the invariant: this door cannot be reached with a body the mirror does not
   * hold — {@link openDraft} above is the one that decides.
   */
  const openDraftWithBody = useStableCallback(
    (d: EngineDraft, body: string) => {
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
      if (parent && !parked) {
        /* The message's own inline editor, seeded with what was written. `openMessageRef` and
           not `openMessage` directly: that callback needs the screener row map and the consent
           partition and is therefore declared far below this one, so the reference is late-bound
           for the same reason `settleComposeRef` is. */
        setReplyBody({ text: body, html: "" });
        setReplyTo(parent.id);
        /* REMEMBER WHICH ROW SEEDED THIS EDITOR. The inline reply has no autosave, so the send
           will create its own row — and without this note the seeded row would stay in Drafts
           as a copy of a message that has been delivered, reopenable with Send live: the
           double-send bait. `onSendSettled` discards it when a reply to THIS message confirms. */
        replySeedDrafts.current.set(parent.id, d.id);
        openMessageRef.current(parent);
        return;
      }
      // `formatRecipientChips`, never a bare join: the seeded string must end in a separator
      // or the LAST stored recipient reopens as raw text in the input — no ×, typing appends
      // to the address — while the others are chips.
      const seeded: ComposeFields = {
        to: formatRecipientChips(d.to),
        cc: formatRecipientChips(d.cc),
        bcc: formatRecipientChips(d.bcc),
        subject: d.subject,
        body,
        // NO `html`. The row stores the markup the server derived its plain part FROM, and the
        // mirror's `EngineDraft` does not carry it — seeding the rich editor from `body` would
        // silently flatten a formatted draft to text and then save the flattening back over it.
        // Plain text is the honest reading of what this client holds.
        html: "",
        fromMailboxId: d.mailboxId,
        // No `forwardOf`, and it cannot be otherwise: `forwardOf` rides the SEND request, never
        // the draft row (`send-service.ts` reads it from the request body), so the `drafts`
        // table has no column to remember it and an `EngineDraft` carries nothing to read back.
        // A forward abandoned to autosave and reopened is therefore a plain compose whose
        // subject still says "Fwd:" — the honest reading of what the account stored, and better
        // than the alternative: quoting the original into the draft body would put a copy of
        // somebody else's message — possibly a redacted sensitive one — into a stored row, the
        // exact thing the server-side quote prevents. Recorded because the fix is a schema
        // change, not a line in this function.

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
        autosave.adopt(d.id, seeded);
      }
      go("compose");
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
    const state = mailSend.stateOf(lane);
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
  const discardDraft = useStableCallback(
    (draftId: string) => {
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
      /* ── NOTHING IS FORGOTTEN BEFORE THE SERVER HAS ANSWERED — invariant T ─────────────────
         The three statements below used to run the moment the mutation was dispatched, on the
         assumption that a delete asked for is a delete done. It is not: a send can reserve the row
         between the local check above and this request reaching the server (the service decides
         under the row lock), and the 409 that comes back RESTORES the row in the mirror — while
         the binding had already been dropped. The compose then sat populated with that message's
         text holding no row, and two seconds later wrote a second one for it.
         So the release, the block state and the reply seed all move inside the CONFIRMED branch,
         and the refusal restores the binding instead. */
      void engine.mutate({ kind: "draft_discard", draftId }).then((res) => {
        if (res.status === "rolled_back" && res.error?.code === "send_recorded") {
          /* A SEND STILL RUNNING, said by the server under its row lock — the row comes back, so
             the compose that was bound to it is bound to it again, and the row says why. */
          settleComposeRef.current({ kind: "restoredBy409", rowId: draftId });
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
            break;
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
          releaseSendLockForRow(
            COMPOSE_SEND_KEY, draftId,
            heldRow !== null && heldRow === draftId ? composeSessionId() : null,
          );
        }
        writeReplyMeta(`draft:${draftId}`, {});
        // The compose form may be holding the very row that was just deleted — discarding from the
        // list while it is open would otherwise leave autosave PATCHing a row that is gone, and
        // the next pause would report a 404 nobody could act on.
        if (releaseDraftIdRef.current === draftId) releaseBindingRef.current();
        // The reply editor may be holding it too — a settle after this delete must not delete twice.
        for (const [msgId, dId] of replySeedDrafts.current) {
          if (dId === draftId) replySeedDrafts.current.delete(msgId);
        }
      });
    },
  );
  /* `autosave.draftId` goes on the mutation, so Send uses the row autosave already wrote instead
     of creating a second one — the whole point of one draft from first keystroke to delivery. */
  const plan = useMemo(
    () => composePlan(compose, composeMailbox, autosave.draftId),
    [compose, composeMailbox, autosave.draftId],
  );
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
    const withWhen = (m: MailSendMutation): MailSendMutation =>
      sendAt ? { ...m, sendAt } : m;
    /**
     * NO FRESH-KEY RESEND AFTER AN UNVERIFIED SEND. This used to shed the draft id and send again. Every part of that
     * was the duplicate: a send with no draft id creates a NEW draft, `useMailSend` mints a NEW key for it, and the
     * server's uniqueness is `(account_id, idempotency_key)` — so the second reservation collides with nothing and
     * both can deliver the same message. `unverified` is terminal-UNKNOWN, not failed. The reservation may already
     * have gone. The send therefore parks: `canSend` refuses while the phase stands, the durable lock keeps the
     * original key rather than releasing it, and the person is shown that it needs checking. A retry that reuses the
     * key is safe; nothing here may invent a new one.
     */
    mailSend.send(withWhen(withSignature(plan.mutation, sigText, sigHtml)));
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
      if (await mailSend.withdraw(COMPOSE_SEND_KEY) === "already_sent") {
        toast(t("compose.cancelAlreadySent"));
        return;
      }
      if (autosave.draftId) writeReplyMeta(`draft:${autosave.draftId}`, {});
      void autosave.discard();
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
      if (flushed.kind === "failed") {
        setComposeCloseRefusal(
          flushed.reason === null
            ? t("compose.closeNotSaved")
            : t("compose.closeNotSavedReason", { reason: flushed.reason }),
        );
        return;
      }
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
    (address: string, name?: string) => {
      const seeded: ComposeFields = {
        ...EMPTY_COMPOSE,
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
      go("compose");
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
    go("compose");
    onMailtoDraftSeeded?.();
  }, [mailtoDraft, autosave, go, onMailtoDraftSeeded]);
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
    cancelSchedule,
    closeCompose,
    closeReply,
    compose,
    composeCloseRefusal,
    composeFrom,
    discardDraft,
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
    sendReply,
    setReplyAttachments,
    setReplyEnvelope,
    setReplyFromId,
    toggleReply,
    writeTo,
  };
}
