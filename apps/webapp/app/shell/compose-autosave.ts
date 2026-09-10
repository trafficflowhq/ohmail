"use client";

/**
 * ═══ THE COMPOSE FORM BECOMES A ROW ON THE ACCOUNT ════════════════════════════════════════
 *
 * A message somebody is writing used to live in exactly one place: `localStorage`, under one
 * key, in this browser. That is enough to survive navigating away and a reload — which is what
 * it was built for — and it is not enough for anything else. Close the tab on a phone and the
 * draft is on the laptop's disk. Clear site data and it is gone. Open the account anywhere else
 * and there is nothing there. `compose.ts`'s own header says so in as many words and calls
 * server drafts "a later phase"; this is that phase.
 *
 * The scratch buffer STAYS, and is not a duplicate of this. It is written on every keystroke and
 * costs nothing; this writes to the account on a two-second pause. Between the two, a crashed
 * tab loses at most the local buffer's last keystroke and the account's last two seconds, and
 * the local one is what restores instantly on reload with no round trip.
 *
 * ── ONE ROW, FIRST KEYSTROKE TO DELIVERY ────────────────────────────────────────────────
 *
 * The first meaningful edit creates a `drafts` row and this hook ADOPTS its server id
 * (`MutationResult.entityId`). Every later save PUTs that row. Send takes the same id — the
 * mutation carries `draftId`, the adapter skips its own create and sends what is already there.
 * Discard deletes it. There is no point at which a compose corresponds to two rows, and no path
 * that leaves an abandoned one behind.
 *
 * ── WHAT COUNTS AS A MEANINGFUL EDIT ────────────────────────────────────────────────────
 *
 * The same rule `writeComposeDraft` applies, and deliberately the same one: some text in a
 * recipient field, the subject or the body. A sender pick on an untouched form is not a draft —
 * saving it would put a row on the account for every visit to Compose, which is the write storm
 * `compose.ts` was right to refuse. `html` does not count either: an empty ProseMirror document
 * serialises to `<p></p>`, so testing it would make merely OPENING Compose write a draft.
 *
 * ── WHY IT IS DEBOUNCED, AND WHY IT ALSO DEDUPES ────────────────────────────────────────
 *
 * The debounce (2 s after the last change) is the obvious half. The dedupe is the half that
 * matters: React re-renders for reasons that have nothing to do with typing — a sync drain, a
 * theme change, another pane — and a save keyed on "the effect ran" would PUT the same text
 * repeatedly for as long as the form was open. So the last saved value is remembered and an
 * identical form writes nothing at all.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { OhmailEngine } from "@ohmail/client-engine";
import type { ComposeFields } from "./compose";
import { COMPOSE_SEND_KEY, writeReplyMeta } from "./mail-send";
import { holdOf, releaseSendLockForRow } from "./send-lock";
import {
  clearComposeDraft, composeSessionId, parseRecipients, readComposeRow, writeComposeRow,
} from "./compose";

/** How long the form must be still before it is written to the account. */
export const AUTOSAVE_DELAY_MS = 2_000;

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
 * ── WOULD REOPENING A ROW WRITE OVER WHAT IS ON SCREEN? ─────────────────────────────────────
 *
 * The reopen puts the row's stored fields into the form and into the scratch buffer, and for a
 * PARKED message that buffer is the only copy of anything typed since: a parked message's saves
 * are refused, so autosave has stored none of it.
 *
 * The question used to be "is a DIFFERENT row on screen", which the held message's OWN row
 * answers no to — that binding is exactly what an unconfirmed send leaves in place — so its text
 * was replaced by the row's pre-send text with nothing asking. So it asks about the buffer's
 * DRIFT from the row: something worth keeping, and a value the reopen would change.
 *
 * Recipients are compared as ADDRESSES and not as chip text. The row stores parsed addresses and
 * the buffer holds what somebody typed, so a formatting round-trip would otherwise read as an
 * edit and refuse a reopen nobody had changed anything before.
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
 * ── WHAT IS WORTH *CREATING* A ROW FOR, WHICH IS NOT THE SAME QUESTION ──────────────────────
 *
 * A RECIPIENT IS NOT A MESSAGE. Every door that opens a compose with somebody already in the To
 * line — a contact's Write, a `mailto:` link from outside the app — seeds a form that
 * {@link worthSaving} calls worth saving, so the first two-second pause after the door POSTed a
 * row with no subject and no body. Measured on the release candidate: the Drafts list filled with
 * "(no subject)" rows, one per use of the door, none of which anybody had written anything into.
 *
 * So a CREATE additionally requires something the person typed: a subject or a body. The UPDATE
 * arm keeps {@link worthSaving} unchanged — once a row exists, clearing the subject and the body
 * out of it is an edit that must be stored, not a reason to stop saving — and that asymmetry is
 * the whole rule. Invariant S(1) is the reason it matters: a row minted by a door is a second row
 * for a message that has not started, and the send then has two.
 *
 * `html` is deliberately not counted: an empty rich editor serialises to `<p></p>`, so testing it
 * would put the write storm straight back.
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
  return JSON.stringify([f.to, f.cc ?? "", f.bcc ?? "", f.subject, f.body, f.html ?? ""]);
}

/**
 * HOW A BOUND COMPOSE'S MESSAGE ENDED — the input to {@link ComposeAutosave.settleCompose}.
 *
 * Two arms are built. The THIRD that invariant T names — the durable outbox settling a `mail_send`
 * for this lane whose owner died — is NOT here, and its absence is deliberate and recorded: the
 * engine keeps no settled-mutation stream a later mount can read. `replayOutboxInner` dispatches a
 * restored entry and DISCARDS the result; `lateResults` is written only on the timeout path, for
 * the surface that is still waiting; and `flushPending()` is a destructive pull already read by
 * `useMailSend.flush`, so a second consumer would swallow settlements meant for the first.
 * `mail-send.ts`'s own header states the same fact from the other side. Polling cannot recover a
 * result that was never retained, so the seam is reported rather than worked around.
 */
export type ComposeFate =
  /**
   * The mirror shows the bound row `sent`. The server's terminal word, arriving on a mount that
   * did not issue the send — the tab that owned the answer died before it could clear anything.
   */
  | { kind: "sentByMirror"; rowId: string | null; toList?: "ohbox" | "drafts" }
  /**
   * A discard of the bound row was refused: the server answered 409 `send_recorded` and KEPT it.
   * The binding was never really gone, so it is restored rather than re-made.
   */
  | { kind: "restoredBy409"; rowId: string };

export interface ComposeAutosave {
  /**
   * The row this compose IS, or `null` before the first save. Handed to `composePlan` so the
   * send reuses it, and to Discard so there is something to delete.
   */
  draftId: string | null;
  /**
   * Take over an existing draft — opening one from the Drafts list. The caller sets the form
   * fields; this adopts the id and marks the current text as already-saved, so opening a draft
   * and closing it again writes nothing.
   *
   * THE ROW MUST BE IN THE MIRROR. `mutationEffects` resolves an update against it and answers
   * no effects for an id it does not know, which the engine reports as `not_found` WITHOUT going
   * near the wire. That is the right refusal — a draft another device deleted while this tab was
   * typing must not be resurrected by a PUT — and it is only safe because the one caller is the
   * Drafts list, which is built from that same mirror. An id from anywhere else would fail
   * silently, so there is deliberately no other caller.
   */
  adopt: (draftId: string, fields: ComposeFields) => void;
  /**
   * Forget the row without deleting it — after a send, when the row has become a sent message.
   * The next compose starts a new one.
   */
  release: () => void;
  /** Delete the row, if there is one. Returns once the mutation has been dispatched. */
  discard: () => Promise<void>;
  /**
   * ── M'S FATE BECAME KNOWN — invariant T's one function ───────────────────────────────────────
   *
   * Every ending of a bound compose comes through here, and it exists because three of them did
   * not. Each arrived at the same wrong state by a different road: the fate resolved, the durable
   * record was tidied away, and the compose stayed POPULATED with the message's text behind a
   * projection reading `idle` — after which an ordinary press minted a fresh Idempotency-Key for
   * a message that had already gone (the mirror-`sent` reload) or an ordinary pause wrote a second
   * row for it (the 409 that restored the row after the binding was dropped).
   *
   * `sentByMirror` IS THE LIVE CONFIRMED PATH, not a second implementation of it: `onSendSettled`
   * calls this same function, so the reload arm cannot drift from the live one again — which is
   * exactly how the two came to disagree. It deliberately does NOT show a "sent" beat; the live
   * path does not, and a visible one is new design rather than a fix.
   */
  settleCompose: (fate: ComposeFate) => void;
  /**
   * A COMPOSE SEND CONFIRMED — release the row if the send used it, DELETE it if the send made
   * its own.
   *
   * `sentDraftId` is the `draftId` the settled mutation carried. When it names this hook's row,
   * the row has become the sent message and is released exactly as before. When the send carried
   * NO id while this hook holds one, the press beat the first save's round trip: the mutation
   * was built before the create confirmed, the adapter made a second row and sent THAT, and the
   * row adopted here belongs to a message that has been delivered. Releasing it — which is what
   * this path did — leaves the sent message in Drafts as a phantom, reopenable with Send live:
   * a double-send invite that survives reload and re-auth, because the server legitimately
   * holds the row as a draft and no sync can know it was superseded. The window is real, not
   * theoretical — press Send inside the create's round trip (the timer fires two seconds after
   * the last change) and the mutation is built before the row id exists. The create that
   * confirms only AFTER the settle is the epoch guard's case and is undone there; this handles
   * the one that confirmed BEFORE.
   */
  settled: (sentDraftId: string | null) => void;
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
}): ComposeAutosave {
  const { engine, fields, mailboxId, active } = opts;
  const sendInFlight = opts.sendInFlight ?? false;
  /* Through a ref: `settleCompose` is handed to callbacks that outlive the render they were made
     in, and naming the prop directly would pin that render's whole scope. */
  const onClearedRef = useRef(opts.onCleared);
  onClearedRef.current = opts.onCleared;
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
  /** One save at a time: a second create while the first is in flight is a second row. */
  const inFlight = useRef(false);
  /**
   * WHICH FORM THE IN-FLIGHT SAVE BELONGS TO — bumped by `adopt`, `release` and `discard`.
   *
   * The debounce is two seconds and a create takes a round trip, so there is a real window in
   * which the form is abandoned WHILE ITS FIRST SAVE IS ON THE WIRE: press Discard, or Send, at
   * 2.01s. `release()` clears `draftId`, the create then confirms, and the old code adopted its
   * `entityId` — pointing the next compose at a row nobody asked for, or, once the view had
   * unmounted, leaving that row on the account with no surface that knows about it. It is
   * invisible: the Drafts list simply grows a copy of a message you discarded or sent.
   *
   * Cancel is what makes the window easy to hit, which is why it is closed in the same slice.
   */
  const epoch = useRef(0);

  const adopt = useCallback((id: string, f: ComposeFields) => {
    epoch.current += 1;
    setDraftId(id);
    // DURABLY, because this hook's state does not survive a reload and the scratch buffer holding
    // the same message's text does — see `composeRowKey`.
    writeComposeRow(id);
    saved.current = signatureOf(f);
    savedMailbox.current = f.fromMailboxId;
  }, []);

  const release = useCallback(() => {
    epoch.current += 1;
    setDraftId(null);
    writeComposeRow(null);
    saved.current = null;
    savedMailbox.current = null;
  }, []);

  /**
   * ── THE ROW THIS SURFACE WAS HOLDING WHEN THE TAB DIED, ADOPTED ON MOUNT ───────────────────
   *
   * A reload restores the message's TEXT from the scratch buffer and used to restore nothing
   * about its row, so the first pause afterwards CREATED one. The durable send record still named
   * the row the press had carried, and one message under two rows is what unlocked Send for a
   * send whose outcome nobody could confirm — the reviewed sequence: send from saved draft `d1`,
   * unverified, reload, autosave mints `d2`, press, second delivery.
   *
   * ── IT ADOPTS ONLY WHAT THE MIRROR CALLS A DRAFT ───────────────────────────────────────────
   *
   * The same rule {@link ComposeAutosave.adopt} states, applied to an id nobody re-checked. The
   * mirror is the authority for two different refusals and both matter here: an id it does not
   * know at all resolves an update to no effects and the engine answers `not_found` without going
   * near the wire (a row another device deleted must not be resurrected by a PUT), and a row past
   * `draft` — `unverified`, or a stranded `sending` — is one the server refuses to send under any
   * key, so adopting it would point every autosave PUT and the Send press at that refusal.
   *
   * Not adopting is safe rather than merely tolerable: the compose SESSION is what parks an
   * unresolved send (`mail-send.ts`), and it survives the reload whether or not a row does.
   *
   * ── EXCEPT FOR A MESSAGE WE ARE STILL WAITING ON, WHERE DROPPING WAS THE DEFECT ────────────
   *
   * That last sentence was true and incomplete, and the gap between the two was a second copy in
   * a recipient's mailbox. The session does keep such a message parked — but dropping its row
   * let the next pause CREATE one, so the drafts list held two rows for one message before
   * anybody reopened anything, and the surface presented the fresh row as the message. Measured
   * on the release candidate: park a send from saved draft `d1`, reload, one press, total 2.
   *
   * So {@link holdOf} is asked first, and while it answers anything but `free` this surface takes
   * no row at all: the stored id is kept, nothing is adopted, and the save effect creates nothing.
   * It is the same predicate `openDraft`'s parked door reads, which is the point — the two were
   * measured disagreeing, twice, and each disagreement was a second copy in a mailbox.
   *
   * ── AND "THE MIRROR HAS NOT LOADED YET" IS NOT "THERE IS NO SUCH ROW" ─────────────────────
   *
   * The two look identical through `get`, which answers nothing for both — and on the path this
   * exists for, a reload, the mirror is EMPTY at mount: the shell starts the engine in an effect
   * and the rows arrive from storage afterwards. A first version of this asked once and threw the
   * stored id away on a miss, which is the fix defeating itself on precisely the cold start it
   * was written for. `holdOf` answers `unknown` for it, and `unknown` WAITS — the engine's own
   * notifications drive the retry. Waiting for ever is the safe direction: the stored id is
   * cleared by every door that replaces the form and by a confirmed send, so nothing accumulates.
   *
   * A ROW PAST `draft` IS NO LONGER DROPPED, and that is the change invariant S(2) makes here.
   * Dropping it let the next pause mint a fresh row for a message the server is still deciding
   * about — one message, two rows, and the fresh one presented as the message. `holdOf` calls
   * every non-`draft` status `parked`, so the row is kept written down and the question stays
   * open: a late confirmation or a sweep resolves it and the row is adopted then.
   *
   * Once. The stored id is the state the reload came back to; anything after that is this hook's
   * own doing and is already in `draftId`.
   */
  const settledRef = useRef<(sentDraftId: string | null) => void>(() => {});
  /* LATE-BOUND, and not decoration: the adoption effect below is declared ABOVE `settleCompose`
     and its dependency array is `[engine]`, so naming the callback directly would capture the
     FIRST render's copy for the life of the mount — the temporal-dead-zone shape `AppShell` warns
     about one file over. The ref is assigned on every render, so the effect calls the current one. */
  const settleComposeRef = useRef<(fate: ComposeFate) => void>(() => {});
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current) return;
    const held = readComposeRow();
    if (held === null) {
      adopted.current = true;
      return;
    }
    /** `true` = the question is answered, whichever way; `false` = the mirror cannot say yet. */
    const settle = (): boolean => {
      /* ── A MESSAGE WE ARE STILL WAITING ON IS NEITHER ADOPTED NOR DROPPED ──────────────────
         The row is kept written down and the question is left open. Dropping it is what let the
         next pause mint a second row for this one message, which is the measured duplicate; and
         adopting it would point every PUT, and a Discard's DELETE, at a row the server may be
         sending right now. So this surface takes no row at all while the park lasts — the same
         thing `openDraft`'s parked door does, from the same predicate — and the send stays named
         by the session, which is what refuses the press.

         `false` for `unknown` too, so the engine's own notifications ask again: the mirror is
         empty at mount on a reload, and the record can be resolved (a late confirmation, a sweep)
         while this compose is still on screen. */
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
        /* INVARIANT T(b). This arm used to release the record and drop the held row and stop
           there — which left the DELIVERED TEXT in the form with the projection reading idle, and
           the next ordinary press minted a second Idempotency-Key for a message the mirror says
           was already sent. It is the live confirmed path's ending now, from the same function. */
        adopted.current = true;
        settleComposeRef.current({ kind: "sentByMirror", rowId: held });
        return true;
      }
      if (hold.kind !== "free") return false;
      adopted.current = true;
      epoch.current += 1;
      setDraftId(held);
      // `saved` stays `null` on purpose: what the account holds for this row is not known to this
      // mount, so the first change writes an UPDATE to it rather than being deduped away.
      return true;
    };
    if (settle()) return;
    let off: (() => void) | null = engine.subscribe(() => {
      if (settle()) {
        off?.();
        off = null;
      }
    });
    return () => {
      off?.();
      off = null;
    };
  }, [engine]);

  const discard = useCallback(async () => {
    const id = draftId;
    /**
     * ── A HELD ROW IS RELEASED, NEVER DELETED — invariant S(2) ────────────────────────────────
     *
     * The guard is HERE, in the primitive, rather than at each door that calls it: `cancelCompose`
     * calls this, and so does {@link ComposeAutosave.settled}'s phantom-copy branch, and a door
     * added later would call it too. A row whose send may already have gone is the only surviving
     * copy of that message and the account's only record that the send happened — deleting it on
     * an abandoned compose is how a message that WAS delivered stops being findable, and it is the
     * client half of the `send_recorded` 409 the server now answers.
     *
     * `unknown` is refused for the same reason it is everywhere else: a browser that cannot read
     * its own record has no evidence this row is free, and a delete cannot be taken back.
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
  }, [draftId, engine, release]);

  /**
   * ── INVARIANT T's ONE FUNCTION ──────────────────────────────────────────────────────────────
   *
   * See {@link ComposeAutosave.settleCompose}. Both arms end with the compose either ADOPTING the
   * resolving row or CLEARING the way the live path clears — never populated behind an idle
   * projection, which is the state all three reviewed sequences arrived at.
   */
  const settleCompose = useCallback((fate: ComposeFate) => {
    if (fate.kind === "restoredBy409") {
      /* THE SERVER KEPT THE ROW, so the binding was never really gone. Re-adopted rather than
         re-made: `adopt` restores the id AND marks the text on screen as already-saved, so the
         pause that follows writes nothing for content the row already holds — without that the
         "restore" would be a PUT, and on a row with a send on record a PUT is refused.
         Only for the compose that was bound to it: a Delete pressed on some other row in the list
         has nothing here to restore. */
      if (draftId !== null && draftId !== fate.rowId) return;
      adopt(fate.rowId, fieldsRef.current);
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
      releaseSendLockForRow(COMPOSE_SEND_KEY, fate.rowId, composeSessionId());
    }
    writeComposeRow(null);
    clearComposeDraft();
    onClearedRef.current?.(fate.toList ?? "ohbox");
  }, [draftId, adopt]);

  const settled = useCallback(
    (sentDraftId: string | null) => {
      // The send used this row (or there is no row): the ordinary release. A row the send did
      // NOT use is a phantom copy of the delivered message and is deleted — see the interface.
      if (draftId === null || draftId === sentDraftId) release();
      else void discard();
    },
    [draftId, release, discard],
  );

  useEffect(() => {
    if (!active) return;
    if (!worthSaving(fields)) return;
    const signature = signatureOf(fields);
    // A moved sending mailbox is a change on its own — see `savedMailbox`. Only for a row that
    // exists (a create carries the mailbox anyway) and only against a KNOWN base.
    const mailboxMoved =
      draftId !== null && mailboxId !== null &&
      savedMailbox.current !== null && mailboxId !== savedMailbox.current;
    if (signature === saved.current && !mailboxMoved) return;
    // A create with no mailbox would be a 400 the user cannot act on, and the From line is
    // already saying there is nowhere to send from. Nothing is written until there is.
    if (draftId === null && !mailboxId) return;
    // A RECIPIENT IS NOT A MESSAGE — see {@link worthCreating}. Only the create arm; an existing
    // row keeps saving whatever the form holds, empty subject and body included.
    if (draftId === null && !worthCreating(fields)) return;
    /* NOTHING IS WRITTEN AT ALL FOR A MESSAGE THIS BROWSER IS ALREADY WAITING ON — see
       `holdOf`. A create is a SECOND row for a message the durable record already names, and
       that is the reload half of the duplicate: park a send from a saved draft, reload, and the
       pause that followed minted `d2` while the record still named `d1`.

       AND NOT ONLY THE CREATE, which is what this said and where it was wrong. Measured live on
       the release candidate: the door that opens a new compose (a contact's Write) MINTS AN EMPTY
       ROW at once, so the hook is holding THAT row when the parked message is reopened; the pause
       that followed wrote the parked message's subject and body into the DOOR'S row with a PUT.
       The parked row itself was never touched — a guard that only watched writes to it saw
       nothing — while the composer was working on a row the record does not name, so Send lit up
       and one press delivered a second copy. The reopen releases that row (`AppShell`), and this
       is the same refusal at the layer the write actually happens in, so a door that forgets to
       release cannot reach the wire.

       It reads the PERSISTED row, not this hook's state: the persisted row is the message the
       surface is holding, which is exactly what the door writes and what the reopen restores.

       `parked`, NOT "anything but free", and the difference is a compose that can still save. A
       row the MIRROR cannot name — deleted on another device, or a mirror that has not finished
       loading — answers `unknown`, and refusing the write on it would stall the surface for good:
       nothing would ever be written to the account again while that id sat in storage. The
       measured duplicate is not that case, it is the RECORD arm (a send this browser is waiting
       on, named by its session), which `parked` covers. Invariant S(4)'s fail-closed arms are the
       RECOVERIES — adopt, discard, re-mint — and each of them refuses `unknown` on its own line. */
    if (holdOf(engine, {
      lane: COMPOSE_SEND_KEY, draftId: readComposeRow(), session: composeSessionId(),
    }).kind === "parked") return;

    const timer = window.setTimeout(() => {
      if (inFlight.current) return;
      /* ── ASKED AGAIN AT FIRE TIME, AND THIS IS THE HALF THAT WAS MISSING ───────────────────
         The test above runs when the save is SCHEDULED. Two seconds pass before it fires, and in
         that window the surface can become a different message: measured live, a compose with an
         armed save was replaced by the reopen of a row the server holds as unconfirmed, and the
         already-scheduled save then fired against it — a create, in the reopen window itself,
         which replaced the hold and turned Send back on. Re-arranging who cancels what is a race
         with a two-second window; asking again here is not. `parked` for the reason the check at
         schedule time states. */
      const hold = holdOf(engine, {
        lane: COMPOSE_SEND_KEY, draftId: readComposeRow(), session: composeSessionId(),
      });
      if (hold.kind === "parked") return;
      /* ── AND A CREATE BESIDE A ROW THE MIRROR CANNOT YET NAME ──────────────────────────────
         The one place `unknown` refuses a WRITE, and it is scoped as narrowly as the case is.
         A reload with a row written down and a send that is unconfirmed but not `unverified` — a
         transport-queued send, or a record a sweep has taken — comes back to an EMPTY mirror. The
         adoption WAITS (correctly), so this hook holds no row; without this line the timer then
         mints a SECOND row for the message that row belongs to, which is invariant S(1) broken on
         the very path the adoption exists for.
         `readComposeRow() !== null` is the whole scope: with nothing written down there is no
         message this could be a second row FOR, and a first compose in a browser that refuses
         storage must still reach the account. The PUT arm is untouched — a row that exists is
         still this message's row, whatever the mirror can say about it. */
      if (draftId === null && readComposeRow() !== null && hold.kind === "unknown") return;
      /* ── AND A PRESS THAT BEAT THE FIRST SAVE IS NOT A REASON TO MAKE A ROW ────────────────
         The press-before-first-autosave race, from the write side. The composer's timer is armed,
         Send is pressed inside the two seconds, and the mutation goes out carrying NO row — so the
         ADAPTER creates one and sends that. The armed save then fires and creates a SECOND row for
         the same message, which lands in Drafts looking like an ordinary draft: measured on the
         release candidate as one message leaving two rows behind.
         The send's own row reaches this hook through the settled mutation's `entityId`; nothing
         needs to be created for it here. Only a CREATE is refused — a row that already exists is
         still the message's row and its edits are still worth storing. */
      if (draftId === null && sendInFlight) return;
      inFlight.current = true;
      const era = epoch.current;
      void (async () => {
        try {
          /* Parsed HERE and not by `composePlan`, because the two answer different questions. The
             plan refuses to SEND anything when one address is unparseable — a half-typed address
             must not go on the wire. A draft is a thing somebody is still writing, so the
             recipients that DO parse are stored and the rest stay in the form, where the text
             they were typed as is the only faithful record of them. */
          const to = parseRecipients(fields.to).addresses;
          const cc = parseRecipients(fields.cc ?? "").addresses;
          const bcc = parseRecipients(fields.bcc ?? "").addresses;
          const result = await engine.mutate({
            kind: "draft_save",
            draftId,
            // The mailbox rides CREATE and UPDATE alike: on an update it re-homes the row to
            // the current From resolution, which is what makes a pick taken after the first
            // keystroke real on the account rather than cosmetic in this tab.
            ...(mailboxId ? { mailboxId } : {}),
            subject: fields.subject,
            body: fields.body,
            ...(fields.html ? { html: fields.html } : {}),
            to, cc, bcc,
          });
          if (result.status !== "confirmed") return;
          /* THE FORM WAS ABANDONED WHILE THIS WAS IN FLIGHT — see `epoch`. A CREATE is undone,
             because the row it just made belongs to a message that has been discarded, sent or
             replaced and nothing on screen will ever refer to it again. An UPDATE is left alone:
             `discard` already deleted that row (the delete is what the user asked for), and
             `release` deliberately keeps it (a send turned it into a sent message). */
          if (era !== epoch.current) {
            if (draftId === null && result.entityId) {
              await engine.mutate({ kind: "draft_discard", draftId: result.entityId });
            }
            return;
          }
          // ADOPTED, not assumed. `entityId` is the server's id and is present only on a
          // confirmed create; without it the next pass would create a second row, which is the
          // whole failure this hook exists to avoid.
          if (draftId === null && result.entityId) {
            setDraftId(result.entityId);
            // Beside the state, for the reload — see the adoption effect above.
            writeComposeRow(result.entityId);
            /* NOTHING IS WRITTEN ONTO A RECORD HERE, and the reason is worth stating because an
               earlier version of this did exactly that. A save cannot reach this line while an
               unresolved record names the message — the check at the top of the callback refuses
               it at fire time — so a row created here belongs to a message nothing is waiting on.
               The row a record needs to know about is the one this surface was ALREADY holding
               when the record was written, and that is bound where the record is written
               (`mail-send.ts`). Attaching here would be a branch no test could enter. */
          }
          saved.current = signature;
          if (mailboxId) savedMailbox.current = mailboxId;
        } catch {
          /* Left unsaved on purpose: `saved` is not advanced, so the next change tries again.
             A draft that could not be written is not worth a sentence on screen — the text is
             still in the form and still in the local buffer, and the account catches up on the
             next pause. */
        } finally {
          inFlight.current = false;
        }
      })();
    }, AUTOSAVE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [engine, fields, mailboxId, active, draftId, sendInFlight]);

  /* `settled` is defined below `settleCompose` and is called from inside it — through a ref, so
     the two are not forced into one declaration order by a dependency cycle. */
  settledRef.current = settled;
  settleComposeRef.current = settleCompose;

  return { draftId, adopt, release, discard, settled, settleCompose };
}
