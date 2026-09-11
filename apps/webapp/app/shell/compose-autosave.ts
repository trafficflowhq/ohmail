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
  return JSON.stringify([f.to, f.cc ?? "", f.bcc ?? "", f.subject, f.body, f.html ?? ""]);
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
   * Take over an existing draft — opening one from the Drafts list. The
   * caller sets the form fields; this adopts the id and marks the current
   * text as already-saved, so opening and closing a draft writes nothing.
   * The row must be in the mirror: `mutationEffects` answers no effects for
   * an unknown id and the engine reports `not_found` without touching the
   * wire — the right refusal (a draft another device deleted must not be
   * resurrected by a PUT), and safe only because the one caller is the
   * Drafts list, built from that same mirror. Deliberately no other caller.
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
   * Which form the in-flight save belongs to — bumped by `adopt`, `release` and `discard`. The
   * debounce is two seconds and a create takes a round trip, so a form can be abandoned WHILE its
   * first save is on the wire: press Discard or Send at 2.01 s, `release()` clears `draftId`, the
   * create then confirms, and the old code adopted its `entityId` — pointing the next compose at a
   * row nobody asked for, or leaving that row on the account with no surface that knows it (the
   * Drafts list grows a copy of a message you discarded). Cancel makes the window easy to hit,
   * which is why it is closed in the same slice.
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
  useEffect(() => {
    if (adopted.current) return;
    const held = readComposeRow();
    if (held === null) {
      adopted.current = true;
      return;
    }
    /** `true` = the question is answered, whichever way; `false` = the mirror cannot say yet. */
    const settle = (): boolean => {
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
