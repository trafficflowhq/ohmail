"use client";

/**
 * The compose form becomes a row on the account. The scratch buffer stays and is not a duplicate: it is written
 * per keystroke and restores instantly on reload; this writes to the account on a two-second pause — a crashed
 * tab loses at most the buffer's last keystroke and the account's last two seconds. One row, first keystroke to
 * delivery: the first meaningful edit creates a `drafts` row and this hook adopts its server id; later saves
 * PUT it; Send carries the same `draftId`; Discard deletes it — no path leaves an abandoned row. A meaningful
 * edit is `writeComposeDraft`'s rule: text in a recipient field, subject or body (`html` does not count — an
 * empty document serialises to `<p></p>`). Debounced AND deduped: React re-renders for reasons unrelated to
 * typing, so the last saved value is remembered and an identical form writes nothing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { draftOverCeiling } from "@trafficflow/core/outbound-text";
import type { EmailAddress, EngineDraft, KeptAsNewDraft, OhmailEngine } from "@ohmail/client-engine";
import type { ComposeFields, ComposeRowHolds } from "./compose";
import { COMPOSE_SEND_KEY, composeBufferFingerprint, sendLockOwed, sendNamesRow, writeReplyMeta } from "./mail-send";
import { holdOf, releaseSendLockForRow, sendRecordNames, sendRecordsNaming, type Hold } from "./send-lock";
import {
  clearComposeDraft, composeSessionId, markComposeRowHolds, parseRecipients, readComposeDraft,
  readComposeCreates, readComposeRow, readComposeRowHolds, whenComposerReady, writeComposeCreates, writeComposeRow,
} from "./compose";
import {
  STORED_CREATES, copyGoes, createLive, dropCopy, landedOf, landingOf, type CreateClaim,
} from "./draft-creates";

/** How long the form must be still before it is written to the account. */
export const AUTOSAVE_DELAY_MS = 2_000;

/** An effect body run once the composer is settled; its cleanup ends the wait and the body. */
function afterComposerReady(body: () => (() => void) | void): () => void {
  let stop: (() => void) | void;
  const off = whenComposerReady(() => { stop = body(); });
  return () => {
    off();
    if (typeof stop === "function") stop();
  };
}

/**
 * Is there anything here worth a row? The same fields {@link writeComposeDraft} tests, for the
 * same reasons — see the header.
 */
export function worthSaving(f: ComposeFields): boolean {
  return (
    f.to.trim() !== "" ||
    (f.cc ?? "").trim() !== "" ||
    (f.bcc ?? "").trim() !== "" ||
    f.subject.trim() !== "" ||
    f.body.trim() !== ""
  );
}

/**
 * WHICH SENTENCE THE COMPOSE SURFACE OWES THE READER ABOUT SAVING — the promise, or the refusal.
 *
 * A named unit rather than a ternary in the view, because the two halves are a CLAIM and its
 * enforcement and they may not be able to disagree: "Saved to your drafts after a moment" stops
 * being true at exactly the byte the save door below stops writing, and a false promise beside a
 * silent refusal is the shape where a person loses what they wrote believing it was kept.
 * `compose-autosave.test.tsx` drives this and the door from one input and asserts they agree.
 */
export function draftNoteKey(fields: ComposeFields, saveRefused = false): "draftNote" | "bodyTooLong" | "draftNotSaved" {
  if (draftOverCeiling(fields.body, fields.html)) return "bodyTooLong";
  // The account refused the last save: what is on screen is not in Drafts.
  return saveRefused ? "draftNotSaved" : "draftNote";
}

/**
 * Would reopening a row write over what is on screen? The reopen writes the
 * row's stored fields over the form and the scratch buffer, and for a
 * PARKED message that buffer is the only copy of anything typed since (its
 * saves are refused). The old question — "is a DIFFERENT row on screen" —
 * answered no for the held message's own row, so its text went. This asks
 * about the buffer's DRIFT from the row instead. Recipients compare as
 * ADDRESSES, never chip text: the row stores parsed addresses, the buffer
 * holds what somebody typed, and a formatting round-trip is not an edit.
 */
export function reopenWouldOverwrite(buffer: ComposeFields, seeded: ComposeFields): boolean {
  const files = buffer.attachments?.length ?? 0;
  // Attachments count, which {@link worthSaving} does not: a compose holding only a file was
  // called empty and had the file dropped. Same idiom as the cancel confirmation's.
  if (!worthSaving(buffer) && files === 0) return false;
  if (files > (seeded.attachments?.length ?? 0)) return true;
  if (buffer.subject.trim() !== seeded.subject.trim()) return true;
  if (buffer.body.trim() !== seeded.body.trim()) return true;
  /* The parsed addresses AND what did not parse. A half-typed address lives in `invalid`, and it
     is text somebody typed: dropping it silently is the loss this predicate exists to refuse. */
  const addresses = (s: string): string => {
    const parsed = parseRecipients(s);
    return [
      ...parsed.addresses.map((a) => a.address.toLowerCase()),
      ...parsed.invalid.map((v) => v.trim()),
    ].sort().join(",");
  };
  return (["to", "cc", "bcc"] as const)
    .some((k) => addresses(buffer[k] ?? "") !== addresses(seeded[k] ?? ""));
}

/**
 * What is worth CREATING a row for — not the same question as {@link worthSaving}. A recipient is
 * not a message: every door that opens a compose with somebody in the To line (a contact's Write, a
 * `mailto:`) seeds a form `worthSaving` accepts, so the first pause POSTed a row with no subject
 * and no body — measured on the release candidate, the Drafts list filled with "(no subject)" rows.
 * A CREATE additionally requires something the person typed: a subject or a body. The UPDATE arm
 * keeps `worthSaving` unchanged — clearing the subject and body out of an existing row is an edit
 * to store — and that asymmetry is the whole rule (invariant S(1): a door-minted row is a second
 * row for an unstarted message). `html` is not counted: `<p></p>` would restore the write storm.
 */
export function worthCreating(f: ComposeFields): boolean {
  return f.subject.trim() !== "" || f.body.trim() !== "";
}

/**
 * The saved shape, as one string, so "has anything changed" is one comparison rather than five
 * that can be forgotten one at a time. It covers the TEXT the mutation carries; the sending
 * mailbox is tracked beside it (`savedMailbox` in the hook) rather than in here, because the
 * two have different sources — the text is the form's, the mailbox is the RESOLUTION's
 * (`resolveComposeFrom`), and folding the resolution into a signature of the form would make
 * "has the form changed" depend on an argument the form does not hold.
 */
function signatureOf(f: ComposeFields): string {
  return JSON.stringify([
    f.to, f.cc ?? "", f.bcc ?? "", f.subject, f.body, f.html ?? "", f.forwardOf ?? "",
    // The kept files only when there is a list, so every older buffer keeps its signature.
    ...(f.forwardOf && f.forwardParts ? [[...f.forwardParts].sort()] : []),
  ]);
}

/** {@link signatureOf} hashed, for the marker the buffer carries — the body is not stored twice. */
export function holdsSig(f: ComposeFields): string {
  return sigOf(signatureOf(f));
}

/** A string hashed (cyrb53). */
export function sigOf(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The fields a save writes, as the row holds them: a queued save has landed when the row reads the same. */
function rowShapeOf(r: {
  subject: string; body: string | null; html?: string | null; to: EmailAddress[]; cc: EmailAddress[]; bcc: EmailAddress[];
}, parts?: readonly string[] | null): string {
  const who = (xs: EmailAddress[]): string => xs.map((a) => a.address.toLowerCase()).join(",");
  // The kept files, when the save wrote a list: the row holds it only once that save landed.
  return JSON.stringify([
    r.subject, r.body, r.html || null, who(r.to), who(r.cc), who(r.bcc),
    ...(parts === undefined ? [] : [parts === null ? null : [...parts].sort()]),
  ]);
}

/**
 * ROWS THIS PAGE ASKED THE SERVER TO DELETE. Their tombstone is this page's own act arriving, never
 * "deleted on another device": the Drafts list can delete the row the editor holds, and the delta
 * lands before the list's answer lets go of the binding. `asked: false` when the delete was refused.
 */
const ownDiscards = new Set<string>();
export function ownDraftDiscard(draftId: string, asked: boolean): void {
  if (asked) ownDiscards.add(draftId);
  else ownDiscards.delete(draftId);
}

/** The engine's kept-as-new-draft entries already said, by the edit's key: each is said once. */
const keptSaid = new Set<string>();

/** The mirror put this row down on a delta — the authoritative delete. Absence alone is never one. */
function tombstoned(engine: OhmailEngine, draftId: string): boolean {
  try {
    return engine.store?.isTombstoned?.("draft", draftId) === true;
  } catch {
    return false;
  }
}

/**
 * How a bound compose's message ended — the input to {@link ComposeAutosave.settleCompose}. Two
 * arms are built; the third that invariant T names — the durable outbox settling a `mail_send`
 * whose owner died — is NOT here, deliberately and recorded: the engine keeps no settled-mutation
 * stream a later mount can read (`replayOutboxInner` discards results; `lateResults` is written
 * only on the timeout path; `flushPending()` is a destructive pull owned by `useMailSend.flush`).
 * Polling cannot recover a result that was never retained, so the seam is reported rather than
 * worked around.
 */
/**
 * WHAT THE COMPOSER'S DISCARD WILL DO WITH ITS ROW — `null` deletes it; otherwise the row is kept
 * for the hold and the answer names why. The same test {@link ComposeAutosave.discard} applies,
 * read before the press so the question and the press say what the discard does.
 */
export function discardKeepsRow(hold: Hold, row: string | null): "held" | "unknown" | null {
  if (row === null || hold.kind === "free") return null;
  return hold.kind === "parked" ? "held" : "unknown";
}

/** `kept`: for `changed`, the words on screen reached a new draft (its create confirmed or queued). */
export interface ComposeElsewhere { why: "sent" | "deleted" | "changed"; typedSince: boolean; earlier: boolean; kept: boolean }

export type ComposeFate =
  /**
   * The mirror shows the bound row `sent`. The server's terminal word, arriving on a mount that
   * did not issue the send — the tab that owned the answer died before it could clear anything.
   */
  | {
    kind: "sentByMirror";
    rowId: string | null;
    toList?: "ohbox" | "drafts";
    /**
     * IS THIS SETTLEMENT ABOUT THE MESSAGE THIS COMPOSER IS HOLDING? Decided by the road that
     * carries it, where the surface's names are still readable — the live path asks
     * {@link composeStillHolds} at the confirmation, before the clear that spends the session;
     * the reload path reads the row it is settling straight out of storage. Required rather than
     * optional: "nobody asked" and "no" are different statements, and reading the first as the
     * second is what let this arm clear a surface it was never about.
     */
    aboutThisCompose: boolean;
  }
  /**
   * A send was refused for good and its refusal names the row it was sent from — the adapter's own,
   * for a press that carried none. Nothing was delivered, so the row is an ordinary draft again and
   * this composer takes it, rather than its next pause writing a second row for the same message.
   */
  | { kind: "refusedWithRow"; rowId: string; aboutThisCompose: boolean }
  /**
   * A send's save was refused because the row moved off the version these words were written on
   * (another window or device saved since). The row is the other version's: let go, never
   * overwritten, and what is on screen becomes a new draft.
   */
  | { kind: "changedElsewhere"; rowId: string; aboutThisCompose: boolean };

/**
 * WHAT A FLUSH DID — {@link ComposeAutosave.flush}'s answer. `nothing` covers empty, unchanged,
 * and the refusals the composer states for as long as they stand (no mailbox to send from, a
 * parked message), so the close goes on. `saved` is the account holding it, or the outbox holding
 * it and on its way. `failed` is the write that was tried and did not land, and `tooLong` a body
 * past the ceiling the account refuses: a close stays on either, with the text and a sentence.
 */
export type ComposeFlush =
  | { kind: "nothing" }
  | { kind: "saved" }
  /** The row had moved elsewhere: what is on screen was saved as a new draft beside it. */
  | { kind: "forked" }
  | { kind: "tooLong" }
  | { kind: "failed"; reason: string | null };

export interface ComposeAutosave {
  /**
   * The row this compose IS, or `null` before the first save. Handed to `composePlan` so the
   * send reuses it, and to Discard so there is something to delete.
   */
  draftId: string | null;
  /**
   * Take over an existing draft — opening one from the Drafts list. The
   * caller sets the form fields; this adopts the id and marks the current
   * text as already-saved, so opening and closing a draft writes nothing.
   * The row must be in the mirror: `mutationEffects` answers no effects for
   * an unknown id and the engine reports `not_found` without touching the
   * wire — the right refusal (a draft another device deleted must not be
   * resurrected by a PUT), and safe only because the one caller is the
   * Drafts list, built from that same mirror. Deliberately no other caller.
   */
  adopt: (draftId: string, fields: ComposeFields, revision?: string | null) => void;
  /**
   * Forget the row without deleting it — after a send, when the row has become a sent message.
   * The next compose starts a new one.
   */
  release: () => void;
  /** Delete the row, if there is one. Returns once the mutation has been dispatched. */
  discard: () => Promise<void>;
  /**
   * M's fate became known — invariant T's one function. Every ending of a bound compose comes
   * through here, because three endings did not, each arriving at the same wrong state: fate
   * resolved, durable record tidied, compose still POPULATED behind an `idle` projection — after
   * which an ordinary press minted a fresh Idempotency-Key for a delivered message, or an ordinary
   * pause wrote a second row. `sentByMirror` IS the live confirmed path, not a second
   * implementation: `onSendSettled` calls this same function, so the reload arm cannot drift from
   * the live one again. It shows no "sent" beat; the live path does not either.
   */
  settleCompose: (fate: ComposeFate) => void;
  /**
   * WRITE WHAT IS PENDING, NOW — the debounce's own save, run early because the composer is
   * closing. It IS that save ({@link useComposeAutosave} has one write), so every refusal applies
   * unchanged; a close awaits the answer and stays put on `failed` and `tooLong`.
   */
  flush: () => Promise<ComposeFlush>;
  /**
   * THE PRESS WENT, carrying the words: every create the outbox still holds for this message (a
   * pause written offline) is taken back, so the send is its one row. Left there, it landed beside
   * the send on reconnect: the sent message stayed in Drafts, one press from a second copy.
   */
  sending: () => void;
  /**
   * The message's send was refused or withdrawn: a create its press took back too late is the
   * message's row again, or a second copy beside the row it now holds.
   */
  notSent: () => void;
  /** `key` is a create this composer claims for the message on screen. */
  holdsCreate: (key: string) => boolean;
  /**
   * A door opened a letter whose first save is still on its way (`key`): the composer binds that
   * create as a new message, and takes its row when it lands. `fields` is what the create carries.
   */
  awaitCreate: (key: string, fields: ComposeFields) => void;
  /**
   * The form was just restored from this browser's unit, which the account may not hold — a tab
   * closed inside the pause, or one that died. Written once at this open, wherever it landed, with
   * every refusal of the ordinary save; a door that replaces the form ends it.
   */
  restored: () => void;
  /**
   * A compose send confirmed — release the row if the send used it, DELETE it if the send made its
   * own. `sentDraftId` is the settled mutation's `draftId`: naming this hook's row, the row became
   * the sent message and is released. When the send carried NO id while this hook holds one, the
   * press beat the first save's round trip — the adapter made a second row and sent that, so the
   * row adopted here belongs to a delivered message: releasing it leaves a phantom in Drafts,
   * reopenable with Send live — a double-send invite no sync can detect. The window is real: press
   * Send inside the create's round trip. A create confirming AFTER the settle is the epoch guard's
   * case; this handles the one that confirmed BEFORE.
   */
  settled: (sentDraftId: string | null) => void;
  /**
   * THE ROW THIS COMPOSER HELD WAS SENT OR DELETED ON ANOTHER DEVICE — the mirror's `sent` with no
   * send of this browser's on record, or a delete the server stated (a `/sync` tombstone, or a 404
   * to this editor's own save). The row is let go of, so nothing is written to it again, and
   * `typedSince` says whether the form has moved off what the row held: that is saved as a NEW
   * draft by the ordinary pause. `earlier`: the words were typed before this page learned of it
   * (a tab closed or offline at the time), and are kept rather than cleared.
   */
  elsewhere: ComposeElsewhere | null;
  /**
   * The account refused the last save (`rolled_back`, not the row's own end): what is on screen is
   * not what Drafts holds, so the surface may not promise it is. Cleared by a save that lands or
   * queues, and by every door that takes or lets go of the row.
   */
  saveRefused: boolean;
  /**
   * WHICH MESSAGE THIS COMPOSER IS BOUND TO, as a number that moves whenever it takes or lets go of
   * one (`adopt`, `release` and the mount's adoption — the epoch a save in flight is judged by). A
   * send's settlement compares it across its sent beat (`useMailSend`'s `markOf`): moved means the
   * composer holds another message now, and nothing about it is the settlement's to clear.
   */
  epochNow: () => number;
  /** The row version the text on screen is based on, for the send's save; `null` = not known. */
  baseNow: () => string | null;
  /**
   * A save holds the words on screen: the row's, a create's, one waiting on the outbox, or a parked
   * send's (its row unchanged since, or the words its press carried, unchanged since).
   */
  holdsOnScreen: () => boolean;
  /** The mount's adoption of the row the last session held has answered (or there was none). */
  adoptionAnswered: () => boolean;
  /**
   * The composer's own confirmed save of the row it holds is exactly the words on screen. Claims,
   * an update on the outbox and a letter let go do not count: only a row the account holds.
   */
  rowHoldsOnScreen: () => boolean;
  /**
   * The letter on screen, whose send is on its way, is let go of: its binding ends, so a create its
   * press took back is dropped when it lands, as after a confirmed send.
   */
  endWaiting: () => void;
  /**
   * The engine's kept-as-new-draft list ({@link OhmailEngine.keptAsNewDrafts}), handed in by the surface
   * on each change: this composer takes its own, and each is said once.
   */
  keptAsNew: (entries: readonly KeptAsNewDraft[]) => void;
}

/**
 * @param active `false` whenever the compose form is not the thing the user is working on, which
 * is what stops a background timer writing a draft after the form has been cleared by a send.
 */
export function useComposeAutosave(opts: {
  engine: OhmailEngine;
  fields: ComposeFields;
  /** The resolved sending mailbox — a create with no mailbox is refused by the server. */
  mailboxId: string | null;
  /**
   * `mailboxId` is a SUBSTITUTE for the row's own mailbox, which can no longer send (a removed
   * mailbox keeps its drafts). An existing row keeps its mailbox: only Send or a pick moves it.
   * A create still carries the substitute, since there is no row to keep.
   */
  keepRowMailbox?: boolean;
  active: boolean;
  /**
   * IS A SEND OF THIS SURFACE'S MESSAGE ON THE WIRE RIGHT NOW?
   *
   * The press-before-first-autosave race, and it is a real window rather than a theoretical one:
   * the debounce is two seconds, a send takes a round trip, and a press at 1.9 s goes out carrying
   * no row at all. The adapter creates one and sends it; the armed save then fires and creates a
   * SECOND row for the same message. Only a CREATE is refused while this is `true` — see the
   * fire-time check — because an existing row is still this message's row.
   */
  sendInFlight?: boolean;
  /**
   * THE SURFACE HALF OF A CLEAR, injected because the hook does not own it.
   *
   * `settleCompose`'s `sentByMirror` arm is the live confirmed path, and that path empties the
   * form, drops the reading selection and returns to the list — none of which is this hook's
   * state. Passing them in as one callback keeps ONE implementation of "the compose is over"
   * without moving `setCompose`/`go` into a hook that has no business holding them.
   */
  onCleared?: (toList: "ohbox" | "drafts") => void;
  /** The surface empties its form: a restored letter whose row was deleted holds nothing new. */
  onEmptied?: () => void;
  /** A fork was tried: the row had moved elsewhere; `kept` = the words reached a new draft. */
  onForked?: (kept: boolean) => void;
  /** An edit that waited on the outbox was kept as a new draft, and no composer on screen says so. */
  onKeptAsNew?: () => void;
  /** Words written after a letter sent elsewhere were put away in Drafts, and the composer emptied. */
  onKeptSent?: () => void;
}): ComposeAutosave {
  const { engine, fields, mailboxId, active } = opts;
  const sendInFlight = opts.sendInFlight ?? false;
  /* Through a ref: `settleCompose` is handed to callbacks that outlive the render they were made
     in, and naming the prop directly would pin that render's whole scope. */
  const onClearedRef = useRef(opts.onCleared);
  onClearedRef.current = opts.onCleared;
  const onEmptiedRef = useRef(opts.onEmptied);
  onEmptiedRef.current = opts.onEmptied;
  const onForkedRef = useRef(opts.onForked);
  onForkedRef.current = opts.onForked;
  const onKeptAsNewRef = useRef(opts.onKeptAsNew);
  onKeptAsNewRef.current = opts.onKeptAsNew;
  const onKeptSentRef = useRef(opts.onKeptSent);
  onKeptSentRef.current = opts.onKeptSent;
  const activeRef = useRef(active);
  activeRef.current = active;
  /** The row version the form's words are based on — updates state it, so a moved row refuses them. */
  const base = useRef<string | null>(null);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const [draftId, setDraftId] = useState<string | null>(null);
  /** The signature of what the account holds. `null` = nothing has been written for this form. */
  const saved = useRef<string | null>(null);
  /**
   * THE MAILBOX THE ACCOUNT'S ROW HOLDS, as far as this tab knows — the identity half of
   * `saved`. Set by a successful save (the mailbox that rode it) and by `adopt` (the reopened
   * row's own, which `openDraft` seeds into `fromMailboxId`). A RESOLVED mailbox that has moved
   * off it is a change worth a write on its own: the pick otherwise lives only in this tab, the
   * row keeps the old identity, and that identity is what another device shows and what the
   * send dials if this tab never presses Send itself. `null` = unknown, and unknown deliberately
   * does not trigger — there is nothing to compare against, and the send-time PUT (which always
   * carries the current resolution) is the backstop.
   */
  const savedMailbox = useRef<string | null>(null);
  /**
   * WHAT THE ROW HOLDS AS A HASH ({@link holdsSig}) — the buffer's marker, and the one fact a reload
   * has when `saved` is unknown. `null` = not known.
   */
  const savedHash = useRef<string | null>(null);
  /** One save at a time: a second create while the first is in flight is a second row. */
  const inFlight = useRef(false);
  /**
   * Which form the in-flight save belongs to — bumped by `adopt`, `release` and `discard`. The
   * debounce is two seconds and a create takes a round trip, so a form can be abandoned WHILE its
   * first save is on the wire: press Discard or Send at 2.01 s, `release()` clears `draftId`, the
   * create then confirms, and the old code adopted its `entityId` — pointing the next compose at a
   * row nobody asked for, or leaving that row on the account with no surface that knows it (the
   * Drafts list grows a copy of a message you discarded). Cancel makes the window easy to hit,
   * which is why it is closed in the same slice.
   */
  const epoch = useRef(0);

  /**
   * THE FORM AS IT STOOD WHEN THIS SURFACE LET GO OF ITS MESSAGE — {@link release} writes it,
   * {@link adopt} clears it. The close's flush races `cancelCompose`: the discard releases the
   * row first, and a flush reading the form before the emptying lands would CREATE a row for the
   * message somebody just threw away. Held as the SIGNATURE and not a flag because a form typed
   * into since is a different message, and that one is still worth saving.
   */
  const abandonedAt = useRef<string | null>(null);
  /**
   * See {@link ComposeAutosave.elsewhere}. `at` is the signature of what the row held when the word
   * arrived; `null` = nothing on screen is the row's (words typed before this page learned of it).
   */
  const [elsewhereAt, setElsewhereAt] = useState<
    { why: "sent" | "deleted" | "changed"; rowId: string; at: string | null; earlier: boolean; kept?: boolean } | null
  >(null);
  /** A restored form the account may not hold yet — see {@link ComposeAutosave.restored}. */
  const openWrite = useRef(false);
  /**
   * AN UPDATE THE OUTBOX TOOK (offline) for the bound row, until the row is seen holding it: then
   * it is what the row holds, as if it had been answered `confirmed`.
   */
  const pendingLand = useRef<{ row: string; signature: string; hash: string; shape: string; parts?: boolean } | null>(null);
  /* THE ROW WAS DELETED ELSEWHERE WHILE A SAVE OF THESE WORDS WAITED UNSEEN: they may be the row's,
     so they are shown and not saved again until they change. Marked, so a reload does the same. */
  const keepUnsure = useCallback((rowId: string, f: ComposeFields, holds: ComposeRowHolds) => {
    const at = signatureOf(f);
    openWrite.current = false;
    abandonedAt.current = at;
    markComposeRowHolds({ ...holds, gone: true });
    setElsewhereAt({ why: "deleted", rowId, at, earlier: false });
  }, []);
  /** Late-bound: the claims are declared below. */
  const restoreClaimsRef = useRef<() => void>(() => {});
  const restored = useCallback(() => {
    restoreClaimsRef.current();
    const buffer = readComposeDraft();
    const holds = readComposeRowHolds();
    if (holds?.gone === true && holds.pending === holdsSig(buffer)) {
      keepUnsure(holds.row, buffer, holds);
      return;
    }
    // What the row held at this browser's last write is not written back over a newer version.
    if (holds !== null && holds.row === readComposeRow() && holds.sig === holdsSig(buffer)) return;
    openWrite.current = true;
  }, [keepUnsure]);
  const [saveRefused, setSaveRefused] = useState(false);
  /**
   * THE CREATES THIS COMPOSER CLAIMS ({@link CreateClaim}), by key: registered before the save's
   * await, kept while the outbox holds them, and decided by {@link landingOf} when they land. A Send
   * takes them back ({@link ComposeAutosave.sending}); one already on the wire waits for that send.
   */
  const claims = useRef(new Map<string, CreateClaim & { hash: string; mailbox: string | null }>());
  /** This composer's saves of its row the outbox holds (answered `queued`), by key: what each carried. */
  const waitingUpdates = useRef(new Map<string, { sig: string; hash: string; mailbox: string | null }>());
  /** One of them the engine kept as a new draft the server has not made yet: taken when it does. */
  const keptPending = useRef<{ key: string; sig: string; hash: string; mailbox: string | null } | null>(null);
  const sendsPressed = useRef(0);
  /** The binding the last Send was pressed under, until it is refused or withdrawn. */
  const pressedAt = useRef<number | null>(null);
  /** Bindings a discard or a confirmed send ended: their creates are dropped when they land. */
  const ended = useRef(new Set<number>());
  /** The row the last confirmed send went from — never a copy to delete. */
  const sentRow = useRef<string | null>(null);
  /** Writes counted; `reached` is the last one confirmed onto the row the composer holds. */
  const writeSeq = useRef(0);
  const reached = useRef<number | null>(null);
  /** The create whose own save is still awaiting its answer: that save decides it. */
  const inAirKey = useRef<string | null>(null);
  /** Keys a reload found stored, until this engine shows them live or a drain says they are not. */
  const storedKeys = useRef(new Set<string>());
  const resolveRef = useRef<() => void>(() => {});
  const createsOff = useRef<(() => void) | null>(null);
  const watchCreates = useCallback(() => {
    const waits = claims.current.size > 0 || storedKeys.current.size > 0;
    if (createsOff.current === null && waits) createsOff.current = engine.subscribe(() => resolveRef.current());
    else if (createsOff.current !== null && !waits) { createsOff.current(); createsOff.current = null; }
  }, [engine]);
  /** The message's claims, by key, beside its row in storage: a reload claims them again. */
  const storeClaims = useCallback(() => {
    const keys = [...claims.current].filter(([, c]) => c.binding === epoch.current).map(([k]) => k);
    writeComposeCreates(keys.slice(-STORED_CREATES));
  }, []);
  const unclaim = useCallback((key: string) => {
    if (claims.current.delete(key)) storeClaims();
  }, [storeClaims]);
  /** Take a create back; `hold`: for a Send, whose ending decides one already on the wire. */
  const takeBack = useCallback((key: string, hold: boolean) => {
    const c = claims.current.get(key);
    if (c === undefined) return;
    if (hold) c.held = true;
    if (typeof engine.withdrawQueued !== "function") { unclaim(key); return; }
    void engine.withdrawQueued(key)
      .then((said) => {
        if (said === "withdrawn" || (said === "gone" && landedOf(engine, key) === null)) unclaim(key);
        resolveRef.current();
      })
      .catch(() => undefined);
  }, [engine, unclaim]);
  const sending = useCallback(() => {
    sendsPressed.current += 1;
    pressedAt.current = epoch.current;
    // This message's creates only: one a replaced message left is still that message's words.
    for (const [key, c] of [...claims.current]) if (c.binding === epoch.current) takeBack(key, true);
  }, [takeBack]);

  const adopt = useCallback((id: string, f: ComposeFields, revision?: string | null) => {
    epoch.current += 1;
    reached.current = null;
    storeClaims();
    base.current = revision ?? null;
    pendingLand.current = null;
    waitingUpdates.current.clear();
    keptPending.current = null;
    openWrite.current = false;
    setDraftId(id);
    // DURABLY, because this hook's state does not survive a reload and the scratch buffer holding
    // the same message's text does — see `composeRowKey`.
    writeComposeRow(id);
    saved.current = signatureOf(f);
    savedHash.current = holdsSig(f);
    markComposeRowHolds({ row: id, sig: savedHash.current, ...(revision ? { rev: revision } : {}) });
    savedMailbox.current = f.fromMailboxId;
    // A row taken over is a message this surface holds again — see `abandonedAt`.
    abandonedAt.current = null;
    setElsewhereAt(null);
    setSaveRefused(false);
  }, []);

  /**
   * THE STANDING ADOPTION'S TEARDOWN, held so {@link release} can end it. The adoption below can
   * WAIT — on a reload the mirror is empty and the answer arrives with a notification — and that
   * wait used to outlive the composer that started it: released the row, opened another message,
   * and when the mirror finally spoke the old id was adopted into the new editor, whose next
   * autosave wrote its text over the old message.
   */
  const adoptOff = useRef<(() => void) | null>(null);

  const release = useCallback(() => {
    epoch.current += 1;
    reached.current = null;
    storeClaims();
    pendingLand.current = null;
    waitingUpdates.current.clear();
    keptPending.current = null;
    openWrite.current = false;
    /* THE CLOSE'S FLUSH MAY NOT RESURRECT THIS — see `abandonedAt`. Recorded here rather than at
       the doors: `discard` releases before it deletes, and every door that lets a message go
       passes through this one function. */
    abandonedAt.current = signatureOf(fieldsRef.current);
    /* A RELEASED COMPOSER SUBSCRIBES TO NOTHING — see {@link adoptOff}. Ended here rather than
       only in the effect's cleanup, which runs on unmount and says nothing about a composer that
       let go of its row while staying on screen. `adopted` is set with it: the question this
       surface was waiting on has an answer now, and the answer is that there is nobody to adopt
       into. */
    adoptOff.current?.();
    adoptOff.current = null;
    adopted.current = true;
    setDraftId(null);
    writeComposeRow(null);
    saved.current = null;
    savedHash.current = null;
    savedMailbox.current = null;
    base.current = null;
    setElsewhereAt(null);
    setSaveRefused(false);
  }, []);

  /**
   * LET GO OF A ROW ANOTHER DEVICE ENDED — sent or deleted. No delete, the form stays, the text the
   * row held is not written again, and anything typed after is the next pause's new row.
   */
  const letGo = useCallback((why: "sent" | "deleted" | "changed", rowId: string, kept?: { at: string }) => {
    /* WHAT THE ROW HELD AS FAR AS THIS TAB KNOWS, never the form: words typed here that never
       reached the row (a pause not yet run, a save refused offline) are text after it ended, and
       they are kept as the new draft by the next pause rather than counted as the row's. After a
       reload only the marker's hash may be known; known by neither, the form is kept (`null`) —
       unless a record of this browser's names the message: then the send was its own. */
    const form = signatureOf(fieldsRef.current);
    const own = why === "sent" && sendRecordNames(COMPOSE_SEND_KEY, rowId, composeSessionId());
    /* CHANGED: the row holds the other version now, never this tab's words, so nothing on screen is
       the row's and the buffer stays — unless those words were already kept as a new draft. */
    const at = why === "changed" ? kept?.at ?? null
      : saved.current ?? (own || savedHash.current === holdsSig(fieldsRef.current) ? form : null);
    const holds = readComposeRowHolds();
    const unsure = why === "deleted" && form !== at && holds !== null && holds.row === rowId
      && holds.pending === holdsSig(fieldsRef.current);
    release();
    if (unsure) {
      keepUnsure(rowId, fieldsRef.current, holds);
      return;
    }
    abandonedAt.current = at;
    // Nothing new on screen: the buffer is the row's letter, and a reload must not make it a draft.
    if (form === at && why !== "changed") clearComposeDraft();
    // Off screen, a letter sent elsewhere is not left in the composer: Compose would open it.
    if (why === "sent" && !activeRef.current) {
      void putAwayRef.current(rowId, at, null);
      return;
    }
    setElsewhereAt({ why, rowId, at, earlier: at === null, ...(why === "changed" ? { kept: kept !== undefined } : {}) });
  }, [release, keepUnsure]);
  /** Late-bound: the write it needs is declared below. */
  const putAwayRef = useRef<(rowId: string, at: string | null, from: ComposeFields | null) => Promise<void>>(async () => {});
  /** The mount found a letter sent elsewhere off screen: its words go once a sending mailbox is known. */
  const owedAway = useRef<{ rowId: string; from: ComposeFields } | null>(null);

  /**
   * The row this surface was holding when the tab died, adopted on mount. A reload restored the TEXT and
   * nothing about the row, so the first pause created one — one message under two rows, which unlocked
   * Send for an unverified send. It adopts only what the mirror calls a draft: an unknown id answers
   * `not_found` off the wire, and a row past `draft` is one the server refuses to send. A parked message
   * is neither adopted nor dropped ({@link holdOf} first; dropping minted the measured duplicate — the
   * same predicate `openDraft`'s parked door reads). "Mirror not loaded" is not "no such row": the mirror
   * is EMPTY at mount on a reload, so `unknown` WAITS — the engine's notifications drive the retry, and
   * every form-replacing door clears the stored id. Once.
   */
  const settledRef = useRef<(sentDraftId: string | null) => void>(() => {});
  /* LATE-BOUND, and not decoration: the adoption effect below is declared ABOVE `settleCompose`
     and its dependency array is `[engine]`, so naming the callback directly would capture the
     FIRST render's copy for the life of the mount — the temporal-dead-zone shape `AppShell` warns
     about one file over. The ref is assigned on every render, so the effect calls the current one. */
  const settleComposeRef = useRef<(fate: ComposeFate) => void>(() => {});
  const adopted = useRef(false);
  /* Not before this page knows which composer it is: a duplicated tab would adopt the original's
     row, and a dead tab's unit is taken by the same wait. */
  useEffect(() => afterComposerReady(() => {
    if (adopted.current) return;
    const held = readComposeRow();
    if (held === null) {
      adopted.current = true;
      return;
    }
    /** `true` = the question is answered, whichever way; `false` = the mirror cannot say yet. */
    const settle = (): boolean => {
      /**
       * ── ONE ADOPTER PER DRAFT ROW, AND THE REGISTRY IS `composeRowKey` ITSELF ─────────────
       *
       * `held` was read when the wait began. If this composer has since taken another row — or
       * let go of the one it had — then the id in hand belongs to a message nobody here is
       * holding, and adopting it would point every later save and every Discard at that message
       * while showing somebody else's text. Dropped BY NAME rather than retried: the question is
       * answered, and the answer is that this surface is not the one to answer it.
       */
      if (readComposeRow() !== held) {
        adopted.current = true;
        return true;
      }
      /* A message we are still waiting on is neither adopted nor dropped:
         the row is kept written down and the question left open. Dropping it
         let the next pause mint a second row for this one message (the
         measured duplicate); adopting it would point every PUT, and a
         Discard's DELETE, at a row the server may be sending right now. So
         this surface takes no row while the park lasts — the same thing
         `openDraft`'s parked door does, from the same predicate — and the
         send stays named by the session, which refuses the press. `false`
         for `unknown` too, so the engine's notifications ask again: the
         record can resolve while this compose is still on screen. */
      const hold = holdOf(engine, {
        lane: COMPOSE_SEND_KEY, draftId: held, session: composeSessionId(),
      });
      /* ── A ROW THE SERVER CALLS `sent` IS OVER, AND HOLDING IT IS THE FALSE STATE ──────────
         The one status that settles rather than parks. The send committed and `/sync` brought the
         row back; the tab that owned the answer died before it could release the record, so this
         mount arrives holding a delivered message. Keeping it would leave the surface parked on a
         send that is finished — and would put "we couldn't confirm this" over it. The row is let
         go of and the record is settled on the mirror's own word, which is what the confirmed path
         does with the answer it received. */
      if (hold.kind === "parked" && hold.status === "sent") {
        /* ANOTHER DEVICE'S SEND — no record of this browser's names the message — AND WORDS THIS
           ROW NEVER HELD: a tab closed or offline inside the pause, reopened after the send. The
           buffer is not what the row held at this browser's last write (or that is not known), so
           the words are kept as a new draft and said. This browser's own send settles below. */
        const buffer = readComposeDraft();
        const holds = readComposeRowHolds();
        if (worthSaving(buffer) && !sendRecordNames(COMPOSE_SEND_KEY, held, composeSessionId())
          && !(holds !== null && holds.row === held && holds.sig === holdsSig(buffer))) {
          adopted.current = true;
          epoch.current += 1;
          writeComposeRow(null);
          saved.current = null;
          abandonedAt.current = null;
          // Off screen they go to Drafts from the buffer (the form may not hold them yet).
          if (!activeRef.current) {
            openWrite.current = false;
            owedAway.current = { rowId: held, from: buffer };
          }
          setElsewhereAt({ why: "sent", rowId: held, at: null, earlier: true });
          return true;
        }
        /* INVARIANT T(b). This arm used to release the record and drop the held row and stop
           there — which left the DELIVERED TEXT in the form with the projection reading idle, and
           the next ordinary press minted a second Idempotency-Key for a message the mirror says
           was already sent. It is the live confirmed path's ending now, from the same function. */
        adopted.current = true;
        /* THE ROW THIS MOUNT IS HOLDING IS THE MESSAGE — it was read out of storage a moment ago
           and the refusal above proves it is still written there, so the identity is exact. */
        settleComposeRef.current({
          kind: "sentByMirror", rowId: held,
          /* THE ROW THIS MOUNT IS HOLDING IS THE MESSAGE: it was read out of storage a moment ago
             and the one-adopter refusal above proves it is still written there. */
          aboutThisCompose: true,
        });
        return true;
      }
      if (tombstoned(engine, held)) {
        goneAtStart();
        return true;
      }
      if (hold.kind === "unknown") askServer();
      if (hold.kind !== "free") return false;
      adopted.current = true;
      epoch.current += 1;
      // What the row holds is known here only as the marker's hash, and only for this row.
      const marked = readComposeRowHolds();
      savedHash.current = marked !== null && marked.row === held ? marked.sig : null;
      base.current = marked !== null && marked.row === held ? marked.rev ?? null : null;
      // The stored copy is what the row held at this browser's last write: nothing to write back.
      const buffer = readComposeDraft();
      if (savedHash.current !== null && savedHash.current === holdsSig(buffer)) saved.current = signatureOf(buffer);
      setDraftId(held);
      // `saved` stays `null` on purpose: what the account holds for this row is not known to this
      // mount, so the first change writes an UPDATE to it rather than being deduped away.
      return true;
    };
    /* A ROW DELETED WHILE THIS TAB WAS CLOSED: absent from the mirror once a drain of this page has
       completed, it is asked of the server once. Gone, the stored letter is cleared when it holds
       nothing the row did not, and kept as a new draft otherwise; never written back to the row. */
    let asked = false;
    function askServer(): void {
      if (asked || engine.read().get("draft", held!) != null || typeof engine.draftOnServer !== "function") return;
      if ((engine.drainsCompleted?.() ?? 0) === 0) return;
      asked = true;
      void engine.draftOnServer(held!).then((answer) => {
        if (answer === "gone" && !adopted.current && readComposeRow() === held) goneAtStart();
      });
    }
    function goneAtStart(): void {
      adopted.current = true;
      epoch.current += 1;
      adoptOff.current?.();
      adoptOff.current = null;
      saved.current = null;
      savedHash.current = null;
      const buffer = readComposeDraft();
      const holds = readComposeRowHolds();
      const ours = holds !== null && holds.row === held;
      if (!worthSaving(buffer) || (ours && holds.sig === holdsSig(buffer))) {
        openWrite.current = false;
        clearComposeDraft();
        onEmptiedRef.current?.();
        return;
      }
      writeComposeRow(null);
      if (ours && holds.pending === holdsSig(buffer)) {
        keepUnsure(held!, buffer, holds);
        return;
      }
      abandonedAt.current = null;
      setElsewhereAt({ why: "deleted", rowId: held!, at: null, earlier: true });
    }
    if (settle()) return;
    let off: (() => void) | null = engine.subscribe(() => {
      if (settle()) {
        off?.();
        off = null;
        adoptOff.current = null;
      }
    });
    /* HANDED TO `release` — see {@link adoptOff}. Assigned after the subscription rather than
       inside it so there is never a moment where the wait exists and nothing can end it. */
    adoptOff.current = () => {
      off?.();
      off = null;
    };
    return () => {
      off?.();
      off = null;
      adoptOff.current = null;
    };
  }), [engine]);

  const discard = useCallback(async () => {
    const id = draftId;
    // The message ends here: its creates are taken back, and one already on the wire is dropped when it lands.
    ended.current.add(epoch.current);
    for (const [key, c] of [...claims.current]) if (c.binding === epoch.current) { c.held = false; takeBack(key, false); }
    /**
     * A held row is released, never deleted — invariant S(2). The guard is here, in the primitive,
     * rather than at each door: `cancelCompose` calls this, so does {@link
     * ComposeAutosave.settled}'s phantom-copy branch, and a later door would too. A row whose send
     * may already have gone is the only surviving copy of that message and the account's only
     * record the send happened — deleting it on an abandoned compose is how a delivered message
     * stops being findable (the client half of the server's `send_recorded` 409). `unknown` is
     * refused: a browser that cannot read its own record has no evidence the row is free, and a
     * delete cannot be taken back.
     */
    const hold = holdOf(engine, {
      lane: COMPOSE_SEND_KEY, draftId: id ?? readComposeRow(), session: composeSessionId(),
    });
    if (hold.kind !== "free") {
      // Let go of it without deleting: the form is being abandoned, the row is not.
      release();
      return;
    }
    release();
    if (!id) return;
    await engine.mutate({ kind: "draft_discard", draftId: id });
    // The row's life ends here for every caller — the compose cancel, and `settled`'s
    // phantom-copy branch — so the editor meta keyed to it (the signature block's state,
    // `mail-send.ts`) dies with it rather than accumulating in storage.
    writeReplyMeta(`draft:${id}`, {});
  }, [draftId, engine, release, takeBack]);

  /**
   * ── INVARIANT T's ONE FUNCTION ──────────────────────────────────────────────────────────────
   *
   * See {@link ComposeAutosave.settleCompose}. Both arms end with the compose either ADOPTING the
   * resolving row or CLEARING the way the live path clears — never populated behind an idle
   * projection, which is the state all three reviewed sequences arrived at.
   */
  const settleCompose = useCallback((fate: ComposeFate) => {
    if (fate.kind === "refusedWithRow") {
      /* Only a composer holding no row takes it: one that holds another, or has one written down
         that the mount adoption is still asking about, keeps what it has. Taken by `adopt`, which
         marks the text on screen as the row's (the send wrote it there), so a close right after
         the refusal writes nothing to a row the mirror may not have drained yet. */
      const written = readComposeRow();
      if (!fate.aboutThisCompose || draftId !== null || (written !== null && written !== fate.rowId)) return;
      adoptOff.current?.();
      adoptOff.current = null;
      adopted.current = true;
      const carried = epoch.current;
      adopt(fate.rowId, fieldsRef.current, engine.read().get<EngineDraft>("draft", fate.rowId)?.contentRevision ?? null);
      // Still this message: its creates are judged beside the row it holds now.
      for (const c of claims.current.values()) if (c.binding === carried) c.binding = epoch.current;
      storeClaims();
      return;
    }
    if (fate.kind === "changedElsewhere") {
      if (!fate.aboutThisCompose || (draftId ?? readComposeRow()) !== fate.rowId) return;
      letGo("changed", fate.rowId);
      // The send ended refused, so its in-flight state is no reason to hold the words back.
      void forkNowRef.current().then((next) => { onForkedRef.current?.(next.kind === "saved"); });
      return;
    }
    /**
     * WHICH MESSAGE THIS SETTLEMENT IS ABOUT, BEFORE ANYTHING IS DONE ABOUT IT. Everything below
     * acts on the composer — it judges the row, drops it, clears the buffer, empties the form —
     * and all of it is destruction for any message but the one that was sent, the phantom-copy
     * judgement worst of all, which DELETES the row it decides against. A send confirming while
     * somebody was writing the next message threw that message away.
     *
     * A settlement about a message this surface no longer holds is left alone. The record stands,
     * so that message is still recognised if it comes back.
     */
    if (!fate.aboutThisCompose) {
      console.warn(
        "ohmail: send_settled_unbound — a send settled for a compose this surface no longer "
        + "holds; the message on screen is a different one and was left alone",
      );
      return;
    }
    /* ── sentByMirror: THE LIVE CONFIRMED PATH, and `onSendSettled` calls this same code ──────
       Order matters and is the live one: the row is judged first (released if the send used it,
       discarded if the send made its own and this hook adopted a phantom), then the durable record
       for the row AND the session goes, then the held row, then the scratch buffer — which is what
       `clearLaneScratch` does on the live path and what NOTHING did on the reload path, leaving
       the delivered text in the form. Idempotent where the live path already did it. */
    settledRef.current(fate.rowId);
    if (fate.rowId !== null) {
      releaseSendLockForRow(COMPOSE_SEND_KEY, fate.rowId, composeSessionId(), sendLockOwed(engine));
    }
    writeComposeRow(null);
    clearComposeDraft();
    onClearedRef.current?.(fate.toList ?? "ohbox");
  }, [draftId, adopt, engine, letGo, storeClaims]);

  const settled = useCallback(
    (sentDraftId: string | null) => {
      // The send used this row (or there is no row): the ordinary release. A row the send did
      // NOT use is a phantom copy of the delivered message and is deleted — see the interface.
      ended.current.add(epoch.current);
      sentRow.current = sentDraftId;
      // Confirmed: a create the press held is decided by the ended message, and dropped.
      for (const c of claims.current.values()) if (c.binding === epoch.current) c.held = false;
      if (draftId === null || draftId === sentDraftId) release();
      else void discard();
      resolveRef.current();
    },
    [draftId, release, discard],
  );

  /* The current render's inputs, for the save that runs from outside a render — the close's
     flush. `fieldsRef` above holds the form; these hold the rest. */
  const mailboxRef = useRef(mailboxId);
  mailboxRef.current = mailboxId;
  const keepRowMailbox = opts.keepRowMailbox ?? false;
  const keepRowMailboxRef = useRef(keepRowMailbox);
  keepRowMailboxRef.current = keepRowMailbox;
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;
  const sendInFlightRef = useRef(sendInFlight);
  sendInFlightRef.current = sendInFlight;
  /** Whether the lane's send carries this composer's message: a create always, a row it names, or a press under this binding. */
  const carried = (row: string | null): boolean => row === null || pressedAt.current === epoch.current
    || sendNamesRow(engine, COMPOSE_SEND_KEY, row);
  /** The save on the wire, so a flush arriving mid-round-trip waits it out instead of deduping. */
  const inFlightP = useRef<Promise<void> | null>(null);

  /**
   * THE WRITE, AND ITS ONE IMPLEMENTATION — the pause's and the close's. Every refusal is asked
   * HERE rather than at the two call sites, the rule this hook already keeps for the parked-row
   * checks: a door that forgets one cannot reach the wire. The three that answer `nothing` while
   * the form holds text — the ceiling, no mailbox to send from, a parked message — are each
   * stated on screen for as long as they stand, so a close over one of them loses nothing
   * silently.
   */
  const writeNow = useCallback(async (asNew = false, fork = false, from?: ComposeFields): Promise<ComposeFlush> => {
    const f = from ?? fieldsRef.current;
    const row = asNew ? null : draftIdRef.current;
    // A substitute sender is written on a create only — see `keepRowMailbox`.
    const mailbox = row !== null && keepRowMailboxRef.current ? null : mailboxRef.current;
    if (!worthSaving(f)) return { kind: "nothing" };
    const signature = signatureOf(f);
    // THE MESSAGE THIS SURFACE LET GO OF, UNCHANGED SINCE — see `abandonedAt`.
    if (signature === abandonedAt.current) return { kind: "nothing" };
    // A moved sending mailbox is a change on its own — see `savedMailbox`. Only for a row that
    // exists (a create carries the mailbox anyway) and only against a KNOWN base.
    const mailboxMoved = row !== null && mailbox !== null
      && savedMailbox.current !== null && mailbox !== savedMailbox.current;
    if (signature === saved.current && !mailboxMoved) return { kind: "nothing" };
    /* ── THE CEILING IS STATED BEFORE THE PUT, NOT DISCOVERED AS A 413 ────────────────────────
       The server refuses EITHER half past `DRAFT_BODY_MAX_BYTES`, so both halves go through one
       predicate over the effective body: a ceiling a surface states for one half of a message and
       not the other is a rule a person cannot learn. Nothing is taken away from the author — the
       text stays in the form and in the scratch buffer, `saved` is not advanced, and the first
       edit back under the ceiling saves it all. `draftNoteKey` renders this one. */
    if (draftOverCeiling(f.body, f.html)) return { kind: "tooLong" };
    // A create with no mailbox would be a 400 the user cannot act on, and the From line is
    // already saying there is nowhere to send from. Nothing is written until there is.
    if (row === null && !mailbox) return { kind: "nothing" };
    // A RECIPIENT IS NOT A MESSAGE — see {@link worthCreating}. Only the create arm; an existing
    // row keeps saving whatever the form holds, empty subject and body included.
    if (row === null && !worthCreating(f)) return { kind: "nothing" };
    if (inFlight.current) return { kind: "nothing" };
    /* `parked`, NOT "anything but free" — the difference is a compose that can still save. A row
       the MIRROR cannot name (deleted on another device, or a mirror still loading) answers
       `unknown`, and refusing the write on it would stall the surface for good: nothing would ever
       be written to the account again while that id sat in storage. The measured duplicate is the
       RECORD arm (a send this browser is waiting on, named by its session), which `parked` covers.
       Asked at WRITE time and not only when the timer was armed: two seconds pass in between, and
       a compose with an armed save was measured being replaced by the reopen of a row the server
       holds as unconfirmed. */
    const hold = holdOf(engine, {
      lane: COMPOSE_SEND_KEY, draftId: readComposeRow(), session: composeSessionId(),
    });
    if (hold.kind === "parked") return { kind: "nothing" };
    /**
     * AND A CREATE BESIDE A ROW THE MIRROR CANNOT YET NAME: the one place `unknown` refuses a WRITE, and it is
     * scoped as narrowly as the case is. A reload with a row written down and a send that is unconfirmed but not
     * `unverified` — a transport-queued send, or a record a sweep has taken — comes back to an EMPTY mirror. The
     * adoption WAITS (correctly), so this hook holds no row; without this line the write then mints a SECOND row
     * for the message that row belongs to, which is invariant S(1) broken on the very path the adoption exists for.
     * `readComposeRow() !== null` is the whole scope: with nothing written down there is no message this could be a
     * second row FOR, and a first compose in a browser that refuses storage must still reach the account. The PUT
     * arm is untouched — a row that exists is still this message's row, whatever the mirror can say about it.
     */
    if (row === null && readComposeRow() !== null && hold.kind === "unknown") return { kind: "nothing" };
    /* ── AND NOTHING IS WRITTEN WHILE THIS MESSAGE'S SEND IS ON ITS WAY ───────────────────────
       The send carries the words pressed. A create here would be a SECOND row for the message (the
       press beat the first save, so the adapter makes one), and a save of the row lands after the
       send's answer: the hand-off's close and a send longer than the pause both wrote it, and the
       sent row stayed in Drafts. The send's own row reaches this hook through its `entityId`.
       Another draft opened while an earlier letter's send waits is not that message: its row saves. */
    if (sendInFlightRef.current && !fork && carried(row)) return { kind: "nothing" };
    inFlight.current = true;
    const era = epoch.current;
    const sendsAt = sendsPressed.current;
    const seq = ++writeSeq.current;
    // A create's key is minted here and claimed before the await: a door asks for it while it waits.
    const key = row === null ? crypto.randomUUID() : undefined;
    if (key !== undefined) {
      claims.current.set(key, { sig: signature, hash: holdsSig(f), mailbox, binding: era, sends: sendsAt, held: false, seq });
      inAirKey.current = key;
      storeClaims();
      watchCreates();
    }
    /* A 404 to a PUT is the server's word only when the mirror held the row: an absent row is
       refused locally with the same 404 (a resync between pages), and absence is not a delete. */
    const mirrored = row !== null && engine.read().get("draft", row) != null;
    let gone = false;
    let changed = false;
    let sentAlready = false;
    let outcome: ComposeFlush = { kind: "failed", reason: null };
    const run = (async () => {
      try {
        /* Parsed HERE and not by `composePlan`, because the two answer different questions. The
           plan refuses to SEND anything when one address is unparseable — a half-typed address
           must not go on the wire. A draft is a thing somebody is still writing, so the
           recipients that DO parse are stored and the rest stay in the form, where the text
           they were typed as is the only faithful record of them. */
        const to = parseRecipients(f.to).addresses;
        const cc = parseRecipients(f.cc ?? "").addresses;
        const bcc = parseRecipients(f.bcc ?? "").addresses;
        const stated = row !== null ? base.current : null;
        const result = await engine.mutate({
          kind: "draft_save",
          draftId: row,
          // The version these words were written on: a row moved off it refuses them.
          ...(stated ? { ifContentRevision: stated } : {}),
          // The mailbox rides CREATE and UPDATE alike: on an update it re-homes the row to
          // the current From resolution, which is what makes a pick taken after the first
          // keystroke real on the account rather than cosmetic in this tab.
          ...(mailbox ? { mailboxId: mailbox } : {}),
          // The message a forward carries, so the row reopened anywhere still forwards it.
          ...(f.forwardOf ? { forwardOfMessageId: f.forwardOf } : {}),
          // The kept files, only when there is a list: no screen clears another device's choice.
          ...(f.forwardOf && f.forwardParts ? { forwardParts: [...f.forwardParts] } : {}),
          subject: f.subject,
          body: f.body,
          html: f.html ? f.html : null,
          to, cc, bcc,
        }, key !== undefined ? { key } : {});
        if (key !== undefined) inAirKey.current = null;
        // Answered here: only a create the outbox holds stays claimed.
        if (key !== undefined && result.status !== "queued") unclaim(key);
        /* A ROLLED-BACK WRITE IS THE ONE THE CLOSE MAY NOT LEAVE ON: the account does not hold
           this message and nothing here will try again. `queued` is not that — the verb is
           durable in the outbox before it reaches the wire, so it is on its way and the composer
           may go. */
        if (result.status === "rolled_back") {
          gone = mirrored && era === epoch.current
            && (result.error?.status === 404 || result.error?.code === "not_found");
          changed = row !== null && era === epoch.current && result.error?.code === "draft_changed";
          // The row was already sent: the send carried the message, so there is nothing to refuse.
          sentAlready = row !== null && era === epoch.current && result.error?.code === "draft_sent";
          if (sentAlready) { outcome = { kind: "nothing" }; return; }
          if (!gone && era === epoch.current) setSaveRefused(true);
          // A waiting update of these words is no longer what the row will hold.
          if (era === epoch.current && pendingLand.current?.row === row) {
            pendingLand.current = null;
            const prev = readComposeRowHolds();
            markComposeRowHolds({
              row, sig: savedHash.current ?? (prev?.row === row ? prev.sig : ""), ...(base.current ? { rev: base.current } : {}),
            });
          }
          outcome = { kind: "failed", reason: result.error?.message ?? null };
          return;
        }
        if (era === epoch.current) setSaveRefused(false);
        // A create after the row moved elsewhere: the words on screen are kept, and may be said so.
        if (row === null && era === epoch.current) {
          setElsewhereAt((e) => (e !== null && e.why === "changed" && e.kept !== true ? { ...e, kept: true } : e));
        }
        if (result.status !== "confirmed") {
          /* A CREATE THE OUTBOX HOLDS (offline): no row until it lands, and this message's send
             takes it back (`sending`) — at once when the send went while this was answered. */
          if (key !== undefined && result.status === "queued" && sendsPressed.current !== sendsAt
            && claims.current.get(key)?.held !== true) {
            takeBack(key, true);
          }
          // An update the outbox holds: if the row moves meanwhile, the engine keeps it as a new draft.
          if (row !== null && result.status === "queued" && era === epoch.current) {
            const hash = holdsSig(f);
            waitingUpdates.current.set(result.key, { sig: signature, hash, mailbox });
            pendingLand.current = {
              row, signature, hash,
              shape: rowShapeOf({ subject: f.subject, body: f.body, html: f.html, to, cc, bcc }, f.forwardOf && f.forwardParts ? f.forwardParts : undefined),
              parts: Boolean(f.forwardOf && f.forwardParts),
            };
            const prev = readComposeRowHolds();
            markComposeRowHolds({
              row, sig: savedHash.current ?? (prev?.row === row ? prev.sig : ""), pending: hash,
              ...(base.current ? { rev: base.current } : {}),
            });
          }
          openWrite.current = false;
          outcome = { kind: "saved" };
          return;
        }
        /* THE FORM WAS ABANDONED WHILE THIS WAS IN FLIGHT — see `epoch`. A CREATE is undone,
           because the row it just made belongs to a message that has been discarded, sent or
           replaced and nothing on screen will ever refer to it again. An UPDATE is left alone:
           `discard` already deleted that row (the delete is what the user asked for), and
           `release` deliberately keeps it (a send turned it into a sent message). */
        if (era !== epoch.current) {
          if (row === null && result.entityId) {
            await engine.mutate({ kind: "draft_discard", draftId: result.entityId });
          }
          outcome = { kind: "nothing" };
          return;
        }
        // ADOPTED, not assumed. `entityId` is the server's id and is present only on a
        // confirmed create; without it the next pass would create a second row, which is the
        // whole failure this hook exists to avoid.
        if (row === null && result.entityId) {
          setDraftId(result.entityId);
          // Beside the state, for the reload — see the adoption effect above.
          writeComposeRow(result.entityId);
          /* NOTHING IS WRITTEN ONTO A RECORD HERE, and the reason is worth stating because an
             earlier version of this did exactly that. A save cannot reach this line while an
             unresolved record names the message — the refusal above answers it at write time —
             so a row created here belongs to a message nothing is waiting on. The row a record
             needs to know about is the one this surface was ALREADY holding when the record was
             written, and that is bound where the record is written (`mail-send.ts`). */
        }
        saved.current = signature;
        savedHash.current = holdsSig(f);
        reached.current = seq;
        pendingLand.current = null;
        if (result.revision) base.current = result.revision;
        const savedRow = row ?? result.entityId;
        if (savedRow) {
          markComposeRowHolds({ row: savedRow, sig: savedHash.current, ...(base.current ? { rev: base.current } : {}) });
        }
        if (mailbox) savedMailbox.current = mailbox;
        openWrite.current = false;
        outcome = { kind: "saved" };
      } catch (err) {
        /* The text is still in the form and still in the local buffer, and `saved` is not
           advanced, so the next change tries again. The PAUSE says nothing about it — a draft
           that could not be written is not worth a sentence while somebody is typing — but the
           CLOSE does: it is the last moment at which saying nothing would be a loss. */
        outcome = { kind: "failed", reason: err instanceof Error ? err.message : null };
      } finally {
        inFlight.current = false;
        if (key !== undefined && inAirKey.current === key) inAirKey.current = null;
      }
    })();
    inFlightP.current = run;
    await run;
    if (inFlightP.current === run) inFlightP.current = null;
    // THE SERVER SAYS THE ROW IS GONE: let go of it, and what this save carried becomes the new row.
    if (gone && row !== null && draftIdRef.current === row) {
      letGo("deleted", row);
      return writeNow(true);
    }
    // SENT ELSEWHERE: let go of the row, as its `sent` arriving by `/sync` does; never a new row here.
    if (sentAlready && row !== null && draftIdRef.current === row
      && !sendRecordNames(COMPOSE_SEND_KEY, row, composeSessionId())) {
      letGo("sent", row);
      return { kind: "nothing" };
    }
    /* THE ROW MOVED ELSEWHERE SINCE THESE WORDS' VERSION: never overwritten, never merged. The
       other version stays the row's; what was typed here becomes a new draft. */
    if (changed && row !== null && draftIdRef.current === row) {
      letGo("changed", row);
      const next = await writeNow(true, true);
      onForkedRef.current?.(next.kind === "saved");
      return next.kind === "saved" ? { kind: "forked" } : next;
    }
    resolveRef.current();
    return outcome;
  }, [engine, letGo, watchCreates, storeClaims, unclaim, takeBack]);
  /** The new draft of a fork: after any save on the wire, past the send-in-flight guard. */
  const forkNow = useCallback(async (): Promise<ComposeFlush> => {
    const pending = inFlightP.current;
    if (pending) await pending;
    return writeNow(true, true);
  }, [writeNow]);
  const forkNowRef = useRef(forkNow);
  forkNowRef.current = forkNow;

  /** The write's late-bound handle, for {@link putAwayRef}. */
  const writeNowRef = useRef(writeNow);
  writeNowRef.current = writeNow;
  /** The words a save holds for this message: its row's (bound before the render shows it), or a create on its way. */
  const keptNow = (sig: string): boolean => (saved.current === sig && readComposeRow() !== null)
    || [...claims.current.values()].some((c) => c.binding === epoch.current && c.sig === sig);
  /**
   * A LETTER SENT ELSEWHERE, OFF SCREEN: the composer ends holding nothing, so Compose opens a blank
   * letter. Nothing typed since (`at`, what the row held) is simply let go; words typed since, or not
   * known to be the row's, are saved once as a new draft and said. A save refused leaves them here.
   */
  putAwayRef.current = async (rowId, at, from) => {
    const f = from ?? fieldsRef.current;
    const sig = signatureOf(f);
    const emptied = (): void => {
      clearComposeDraft();
      setElsewhereAt(null);
      onEmptiedRef.current?.();
    };
    if (sig === at || !worthSaving(f)) { emptied(); return; }
    const era = epoch.current;
    // A save already on the wire decides first: it may have kept the words, or its answer may be late.
    const pending = inFlightP.current;
    if (pending) await pending;
    // A door gave the composer another message meanwhile: that one is not this rule's.
    if (epoch.current !== era) return;
    const wrote = keptNow(sig) ? "saved" : (await writeNowRef.current(true, false, f)).kind;
    if (epoch.current !== era) return;
    // Left here only when no save holds the words: a refusal or a failure, never a dedupe.
    if (wrote !== "saved" && !keptNow(sig)) {
      if (from !== null) openWrite.current = true;
      setElsewhereAt({ why: "sent", rowId, at, earlier: at === null });
      return;
    }
    release();
    emptied();
    onKeptSentRef.current?.();
  };

  useEffect(() => {
    if (!active && !openWrite.current) return;
    // The send carries the words pressed: nothing is armed while it is on its way.
    if (sendInFlight && carried(draftId)) return;
    if (!worthSaving(fields)) return;
    const signature = signatureOf(fields);
    const mailboxMoved =
      draftId !== null && mailboxId !== null && !keepRowMailbox &&
      savedMailbox.current !== null && mailboxId !== savedMailbox.current;
    if (signature === saved.current && !mailboxMoved) return;
    /* Whether to ARM, asked over the same refusals {@link writeNow} asks again when it fires:
       there is nothing to wait two seconds for when the write would be refused either way, and
       asking again at fire time is what closes the two-second window (see there). */
    if (draftOverCeiling(fields.body, fields.html)) return;
    if (draftId === null && !mailboxId) return;
    if (draftId === null && !worthCreating(fields)) return;
    if (holdOf(engine, {
      lane: COMPOSE_SEND_KEY, draftId: readComposeRow(), session: composeSessionId(),
    }).kind === "parked") return;
    const timer = window.setTimeout(() => { void writeNow(); }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
    // `elsewhereAt`: a row let go of at mount changes no other input, and its words wait on this.
  }, [engine, fields, mailboxId, keepRowMailbox, active, draftId, sendInFlight, writeNow, elsewhereAt]);

  /**
   * THE BELT ON EVERY CLOSE PATH NO DOOR CAN INTERCEPT — the rail, a `g` jump, the browser's
   * Back, the shell unmounting. Routing is hash-driven, so none of them passes through a function
   * the composer owns; `active` falling IS "the composer is going away", and the pending save
   * runs here rather than being dropped with its timer. The doors (Escape, the close control)
   * await {@link ComposeAutosave.flush} themselves, so they can refuse to leave on a failure —
   * this cannot, and it is the same write either way.
   */
  useEffect(() => {
    if (!active) return;
    return () => { void writeNow(); };
  }, [active, writeNow]);
  useEffect(() => {
    const o = owedAway.current;
    // Opened on screen first: the note shows, and the close below puts the letter away.
    if (o === null || active) { owedAway.current = null; return; }
    if (mailboxId === null) return;
    owedAway.current = null;
    void putAwayRef.current(o.rowId, null, o.from);
  }, [active, mailboxId, elsewhereAt]);
  /* A COMPOSER THAT SHOWED A LETTER SENT ELSEWHERE, CLOSED BY ANY EXIT: after the close's save it
     ends holding nothing, as off screen it would have from the start. */
  const elsewhereRef = useRef(elsewhereAt);
  elsewhereRef.current = elsewhereAt;
  useEffect(() => {
    const e = elsewhereRef.current;
    if (active || e === null || e.why !== "sent") return;
    // Closed by its own Send (a new letter, handed off): the send's settle ends the composer.
    if (pressedAt.current === epoch.current) return;
    void (async () => {
      const pending = inFlightP.current;
      if (pending) await pending;
      if (activeRef.current || elsewhereRef.current !== e) return;
      await putAwayRef.current(e.rowId, e.at, null);
    })();
  }, [active]);

  /**
   * ANOTHER DEVICE ENDING THE ROW ENDS THIS EDITOR'S HOLD ON IT. A `sent` read by status (no record
   * of this browser's) while no send of this surface is in flight is another device's send. A
   * delete is the mirror's TOMBSTONE for the row — a delta the server sent — never mere absence: a
   * resync empties the mirror before refilling it, and a pruned row is absent too. This page's own
   * delete ({@link ownDraftDiscard}) and a park by record are not "elsewhere".
   */
  useEffect(() => {
    if (draftId === null) return;
    /* THE RE-BOOTSTRAP ARM: a 410's snapshot lacks a row deleted meanwhile, with no tombstone. A
       row this page saw live and the mirror no longer holds once a drain has completed since is
       asked of the server, once; its 404 is the delete. A pruned or refilling row answers held. */
    let seenLive = false;
    let absentAsOf: string | null | undefined;
    let asked = false;
    // Let go of once: a notification before the release renders would release the next message.
    let ended = false;
    const check = (): void => {
      if (ended) return;
      const land = pendingLand.current;
      if (land !== null && land.row === draftId) {
        const r = engine.store?.get?.<EngineDraft>("draft", draftId);
        if (r != null && rowShapeOf(r, land.parts === true ? r.forwardParts ?? null : undefined) === land.shape) {
          pendingLand.current = null;
          saved.current = land.signature;
          savedHash.current = land.hash;
          markComposeRowHolds({ row: draftId, sig: land.hash, ...(base.current ? { rev: base.current } : {}) });
        }
      }
      if (draftIdRef.current !== draftId || sendInFlightRef.current) return;
      const hold = holdOf(engine, {
        lane: COMPOSE_SEND_KEY, draftId, session: composeSessionId(),
      });
      if (hold.kind === "parked" && hold.by === "status" && hold.status === "sent") {
        ended = true;
        letGo("sent", draftId);
        return;
      }
      if (hold.kind === "parked" || ownDiscards.has(draftId)) return;
      if (tombstoned(engine, draftId)) {
        ended = true;
        letGo("deleted", draftId);
        return;
      }
      if (engine.read().get("draft", draftId) != null) { seenLive = true; absentAsOf = undefined; return; }
      if (!seenLive || asked || typeof engine.draftOnServer !== "function") return;
      const asOf = engine.freshness?.().asOf ?? null;
      if (absentAsOf === undefined) { absentAsOf = asOf; return; }
      if (asOf === null || asOf === absentAsOf) return;
      asked = true;
      void engine.draftOnServer(draftId).then((answer) => {
        if (answer === "gone" && draftIdRef.current === draftId && !ownDiscards.has(draftId)) {
          letGo("deleted", draftId);
        }
      });
    };
    check();
    return engine.subscribe(check);
  }, [engine, draftId, letGo]);

  /**
   * AN EDIT THAT WAITED ON THE OUTBOX, KEPT AS A NEW DRAFT BY THE ENGINE because the row moved
   * elsewhere meanwhile. This composer's own edit: it takes the new draft, so later words go there
   * and not to a third. Each is said once — by the composer's alert on screen, otherwise a toast.
   */
  const keptAsNew = useCallback((entries: readonly KeptAsNewDraft[]): void => {
    const say = (key: string, onScreen: boolean): void => {
      if (keptSaid.has(key)) return;
      keptSaid.add(key);
      if (!onScreen) onKeptAsNewRef.current?.();
    };
    for (const k of entries) {
      const waited = waitingUpdates.current.get(k.key);
      const mine = waited !== undefined && draftIdRef.current === k.from;
      const pending = keptPending.current?.key === k.key && draftIdRef.current === null ? keptPending.current : null;
      if (!mine && pending === null) { say(k.key, false); continue; }
      if (k.row === null) {
        if (!mine) continue;
        letGo("changed", k.from, { at: waited!.sig });
        keptPending.current = { key: k.key, ...waited! };
        say(k.key, activeRef.current);
        continue;
      }
      const w = mine ? waited! : pending!;
      adoptOff.current?.();
      adoptOff.current = null;
      adopted.current = true;
      epoch.current += 1;
      reached.current = null;
      storeClaims();
      waitingUpdates.current.clear();
      keptPending.current = null;
      openWrite.current = false;
      draftIdRef.current = k.row;
      setDraftId(k.row);
      writeComposeRow(k.row);
      saved.current = w.sig;
      savedHash.current = w.hash;
      savedMailbox.current = w.mailbox;
      base.current = k.revision ?? engine.read().get<EngineDraft>("draft", k.row)?.contentRevision ?? null;
      markComposeRowHolds({ row: k.row, sig: w.hash, ...(base.current ? { rev: base.current } : {}) });
      abandonedAt.current = null;
      setElsewhereAt({ why: "changed", rowId: k.from, at: null, earlier: true, kept: true });
      say(k.key, activeRef.current);
    }
  }, [engine, letGo, storeClaims]);

  const elsewhere = elsewhereAt === null ? null : {
    why: elsewhereAt.why,
    typedSince: elsewhereAt.at === null || signatureOf(fields) !== elsewhereAt.at,
    earlier: elsewhereAt.earlier,
    kept: elsewhereAt.kept === true,
  };

  const flush = useCallback(async (): Promise<ComposeFlush> => {
    /* A save already on the wire carries OLDER text: waited out rather than deduped against, or
       the keystrokes typed during its round trip would be the ones that never landed. */
    const pending = inFlightP.current;
    if (pending) await pending;
    return writeNow(false);
  }, [writeNow]);

  const notSent = useCallback(() => {
    // Refused or withdrawn: a create the press held is this message's again, as if no Send went.
    if (pressedAt.current === epoch.current) pressedAt.current = null;
    for (const c of claims.current.values()) {
      if (c.binding !== epoch.current || !c.held) continue;
      c.held = false;
      c.sends = sendsPressed.current;
    }
    resolveRef.current();
  }, []);

  const holdsCreate = useCallback((key: string): boolean => claims.current.get(key)?.binding === epoch.current, []);
  const awaitCreate = useCallback((key: string, f: ComposeFields) => {
    release();
    abandonedAt.current = null;
    claims.current.set(key, {
      sig: signatureOf(f), hash: holdsSig(f), mailbox: f.fromMailboxId, binding: epoch.current,
      sends: sendsPressed.current, held: false, seq: writeSeq.current,
    });
    saved.current = signatureOf(f);
    savedHash.current = holdsSig(f);
    storeClaims();
    watchCreates();
    resolveRef.current();
  }, [release, storeClaims, watchCreates]);
  /** Claims a reload found stored for the message in the buffer, once this engine shows them. */
  restoreClaimsRef.current = () => {
    for (const key of readComposeCreates()) if (!claims.current.has(key)) storedKeys.current.add(key);
    watchCreates();
    resolveRef.current();
  };

  /**
   * A CLAIMED CREATE HAS LANDED — on the reconnect flush, a boot's replay or its own save — and is
   * decided by {@link landingOf}. A create the engine no longer carries, and that made no row, ends.
   */
  resolveRef.current = () => {
    for (const key of [...storedKeys.current]) {
      if (createLive(engine, key)) {
        storedKeys.current.delete(key);
        claims.current.set(key, {
          sig: "", hash: "", mailbox: null, binding: epoch.current, sends: sendsPressed.current, held: false, seq: -1,
        });
      } else if ((engine.drainsCompleted?.() ?? 0) > 0) storedKeys.current.delete(key);
    }
    for (const [key, c] of [...claims.current]) {
      if (key === inAirKey.current) continue;
      const made = landedOf(engine, key);
      if (made === null) {
        if (!createLive(engine, key)) unclaim(key);
        continue;
      }
      const row = draftIdRef.current ?? readComposeRow();
      const at = landingOf(c, { binding: epoch.current, ended: ended.current, sends: sendsPressed.current, row });
      if (at === "wait") continue;
      unclaim(key);
      if (at === "keep") continue;
      if (at === "drop") { dropCopy(engine, COMPOSE_SEND_KEY, made.id, sentRow.current); continue; }
      if (at === "take") {
        setDraftId(made.id);
        draftIdRef.current = made.id;
        writeComposeRow(made.id);
        saved.current = c.sig === "" ? null : c.sig;
        savedHash.current = c.hash === "" ? null : c.hash;
        base.current = made.revision;
        if (c.hash !== "") markComposeRowHolds({ row: made.id, sig: c.hash, ...(made.revision ? { rev: made.revision } : {}) });
        if (c.mailbox) savedMailbox.current = c.mailbox;
        openWrite.current = false;
        reached.current = c.seq;
        void writeNow();
        continue;
      }
      void carry(c, made.id);
    }
    watchCreates();
  };
  /** The row the composer holds takes the newest words; the copy goes once a later write reached it. */
  const carry = async (c: CreateClaim, copy: string): Promise<void> => {
    const pending = inFlightP.current;
    if (pending) await pending;
    if (draftIdRef.current === null) return;
    await writeNow();
    if (copyGoes(c, reached.current, saved.current)) dropCopy(engine, COMPOSE_SEND_KEY, copy, sentRow.current);
  };
  /* Subscribed only while a create waits: a composer with none is woken by nothing. */
  useEffect(() => () => { createsOff.current?.(); createsOff.current = null; }, [engine]);

  /* `settled` is defined below `settleCompose` and is called from inside it — through a ref, so
     the two are not forced into one declaration order by a dependency cycle. */
  settledRef.current = settled;
  settleComposeRef.current = settleCompose;
  const epochNow = useCallback((): number => epoch.current, []);
  const baseNow = useCallback((): string | null => base.current, []);
  const holdsOnScreen = (): boolean => {
    const f = fieldsRef.current;
    if (!worthSaving(f)) return true;
    const sig = signatureOf(f);
    // The row's or a create's, an update on the outbox, or the message let go of unchanged.
    if (keptNow(sig) || pendingLand.current?.signature === sig || abandonedAt.current === sig) return true;
    // The row marker: what the bound row held at this browser's last write (a launch, before adoption).
    const marked = readComposeRowHolds();
    if (marked !== null && marked.row === readComposeRow() && marked.sig === holdsSig(f)
      && marked.pending === undefined && marked.gone !== true) return true;
    const hold = holdOf(engine, { lane: COMPOSE_SEND_KEY, draftId: readComposeRow(), session: composeSessionId() });
    if (hold.kind !== "parked") return false;
    /* The words a send answered unverified carried, as its press recorded them (`SendLock.bfp`): its own
       save wrote them, a signature folded in, before the send went. Files are on no row. */
    const pressed = (f.attachments?.length ?? 0) === 0 && holdsSig(readComposeDraft()) === holdsSig(f)
      ? composeBufferFingerprint() : null;
    if (pressed !== null && sendRecordsNaming(COMPOSE_SEND_KEY, readComposeRow(), composeSessionId())
      .some((r) => r.unverified && r.bfp === pressed)) return true;
    // A park's row holds what it held; words typed since are on no row, as its saves are refused.
    const row = hold.draftId ?? readComposeRow();
    const d = row !== null ? engine.read().get<EngineDraft>("draft", row) : undefined;
    const line = (xs: readonly EmailAddress[] | null | undefined): string => (xs ?? []).map((a) => a.address).join(", ");
    return typeof d?.body === "string" && !reopenWouldOverwrite(f, {
      ...f, attachments: [], to: line(d.to), cc: line(d.cc), bcc: line(d.bcc), subject: d.subject ?? "", body: d.body,
    });
  };
  const adoptionAnswered = (): boolean => adopted.current;
  const rowHoldsOnScreen = (): boolean => {
    const row = draftIdRef.current;
    return row !== null && row === readComposeRow() && saved.current === signatureOf(fieldsRef.current);
  };
  const endWaiting = useCallback(() => {
    ended.current.add(epoch.current);
    for (const c of claims.current.values()) if (c.binding === epoch.current) c.held = false;
    resolveRef.current();
  }, []);

  return {
    draftId, adopt, release, discard, flush, sending, notSent, holdsCreate, awaitCreate, restored, settled, settleCompose, elsewhere, saveRefused, epochNow,
    baseNow, keptAsNew, holdsOnScreen, adoptionAnswered, rowHoldsOnScreen, endWaiting,
  };
}
