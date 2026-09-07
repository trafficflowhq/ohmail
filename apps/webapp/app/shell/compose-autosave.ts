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
import { attachSendLockDraft, parkedComposeRecord } from "./send-lock";
import { composeSessionId, parseRecipients, readComposeRow, writeComposeRow } from "./compose";

/** How long the form must be still before it is written to the account. */
export const AUTOSAVE_DELAY_MS = 2_000;

/**
 * ── IS THE MESSAGE THIS SURFACE IS HOLDING ONE WE ARE STILL WAITING ON? ─────────────────────
 *
 * The same question `openDraft` asks, from the same function, because the two were measured
 * disagreeing: the reopen learned to keep a parked message parked while THIS side went on
 * treating it as new, which is a duplicate delivery reached without reopening anything.
 *
 * Asked with BOTH names the message can carry — the row this surface came back to, and the
 * compose session, which survives a reload whether or not a row does and is the only name a send
 * pressed before the first save ever had.
 *
 * Reading the session mints one if the jar holds none. That is the same lazy mint every other
 * reader does (`sessionOf` in `mail-send.ts`), and it is reached only where a message-in-progress
 * already exists: a stored row to decide about, or a form with text in it on the compose route.
 */
function parkedHere(held: string | null): boolean {
  return parkedComposeRecord(COMPOSE_SEND_KEY, held, composeSessionId()) !== null;
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
}): ComposeAutosave {
  const { engine, fields, mailboxId, active } = opts;
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
   * So {@link parkedHere} is asked first, and while it answers `true` this surface takes no row
   * at all: the stored id is kept, nothing is adopted, and the save effect creates nothing. It is
   * the same behaviour `openDraft`'s parked door has, deliberately with no second arm for the
   * row's status — a row still at `draft` would be safe to write to and a row past it would not,
   * and neither status says anything about whether this browser is waiting.
   *
   * ── AND "THE MIRROR HAS NOT LOADED YET" IS NOT "THERE IS NO SUCH ROW" ─────────────────────
   *
   * The two look identical through `get`, which answers nothing for both — and on the path this
   * exists for, a reload, the mirror is EMPTY at mount: the shell starts the engine in an effect
   * and the rows arrive from storage afterwards. A first version of this asked once and threw the
   * stored id away on a miss, which is the fix defeating itself on precisely the cold start it
   * was written for. So an absent answer WAITS — the engine's own notifications drive the
   * retry — and only a row the mirror can positively name, in a status this surface may not write
   * to, is dropped. Waiting for ever is the safe direction: the stored id is cleared by every
   * door that replaces the form and by a confirmed send, so nothing accumulates.
   *
   * Once. The stored id is the state the reload came back to; anything after that is this hook's
   * own doing and is already in `draftId`.
   */
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
      const row = engine.read().get<{ status?: string }>("draft", held);
      if (row === null || row === undefined) return false;
      /* ── A MESSAGE WE ARE STILL WAITING ON IS NEITHER ADOPTED NOR DROPPED ──────────────────
         The row is kept written down and the question is left open. Dropping it is what let the
         next pause mint a second row for this one message, which is the measured duplicate; and
         adopting it would point every PUT, and a Discard's DELETE, at a row the server may be
         sending right now. So this surface takes no row at all while the park lasts — the same
         thing `openDraft`'s parked door does, for the same reason — and the send stays named by
         the session, which is what refuses the press.

         `false`, so the engine's own notifications ask again: the record can be resolved (a late
         confirmation, a sweep) while this compose is still on screen, and the row is then adopted
         or dropped exactly as it would have been. */
      if (parkedHere(held)) return false;
      adopted.current = true;
      if (row.status !== "draft") {
        // Named, and not this hook's row to write to. Dropped, so no later mount asks again, and
        // the surface behaves as it did before this adoption existed: the next pause makes a row.
        writeComposeRow(null);
        return true;
      }
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
    release();
    if (!id) return;
    await engine.mutate({ kind: "draft_discard", draftId: id });
    // The row's life ends here for every caller — the compose cancel, and `settled`'s
    // phantom-copy branch — so the editor meta keyed to it (the signature block's state,
    // `mail-send.ts`) dies with it rather than accumulating in storage.
    writeReplyMeta(`draft:${id}`, {});
  }, [draftId, engine, release]);

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
    /* NOTHING IS WRITTEN AT ALL FOR A MESSAGE THIS BROWSER IS ALREADY WAITING ON — see
       `parkedHere`. A create is a SECOND row for a message the durable record already names, and
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
       surface is holding, which is exactly what the door writes and what the reopen restores. */
    if (parkedHere(readComposeRow())) return;

    const timer = window.setTimeout(() => {
      if (inFlight.current) return;
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
            /* AND ONTO THE RECORD, IF THIS MESSAGE HAS ONE WAITING — the row it has just
               ACQUIRED. A send pressed before the first save is named only by
               `compose:<session>`, and the save it beat can still land: the timer was armed
               before the press, so the row appears seconds AFTER the record. Attaching only on a
               refused press (which is where `attachSendLockDraft`'s other caller sits) left that
               row unattached until somebody pressed Send again — so the row sitting in Drafts was
               a parked message that the row alone could not identify, and opening it from another
               session took the recovery door and sent a second copy.

               Only a record this session names is touched, and `draftId` is diagnostic: the
               record's identity does not move onto the row, which is the whole point of keeping
               both names. */
            const session = composeSessionId();
            if (session !== null) {
              attachSendLockDraft(COMPOSE_SEND_KEY, [`compose:${session}`], result.entityId);
            }
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
  }, [engine, fields, mailboxId, active, draftId]);

  return { draftId, adopt, release, discard, settled };
}
