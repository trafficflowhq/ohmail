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
import { parseRecipients } from "./compose";

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
 * The saved shape, as one string, so "has anything changed" is one comparison rather than five
 * that can be forgotten one at a time. It covers exactly the fields the mutation carries — a
 * change to `fromMailboxId` alone is not a change to the DRAFT, because the mailbox is settled at
 * create and immutable afterwards.
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
  /** One save at a time: a second create while the first is in flight is a second row. */
  const inFlight = useRef(false);

  const adopt = useCallback((id: string, f: ComposeFields) => {
    setDraftId(id);
    saved.current = signatureOf(f);
  }, []);

  const release = useCallback(() => {
    setDraftId(null);
    saved.current = null;
  }, []);

  const discard = useCallback(async () => {
    const id = draftId;
    release();
    if (!id) return;
    await engine.mutate({ kind: "draft_discard", draftId: id });
  }, [draftId, engine, release]);

  useEffect(() => {
    if (!active) return;
    if (!worthSaving(fields)) return;
    const signature = signatureOf(fields);
    if (signature === saved.current) return;
    // A create with no mailbox would be a 400 the user cannot act on, and the From line is
    // already saying there is nowhere to send from. Nothing is written until there is.
    if (draftId === null && !mailboxId) return;

    const timer = window.setTimeout(() => {
      if (inFlight.current) return;
      inFlight.current = true;
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
            ...(draftId === null && mailboxId ? { mailboxId } : {}),
            subject: fields.subject,
            body: fields.body,
            ...(fields.html ? { html: fields.html } : {}),
            to, cc, bcc,
          });
          if (result.status !== "confirmed") return;
          // ADOPTED, not assumed. `entityId` is the server's id and is present only on a
          // confirmed create; without it the next pass would create a second row, which is the
          // whole failure this hook exists to avoid.
          if (draftId === null && result.entityId) setDraftId(result.entityId);
          saved.current = signature;
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

  return { draftId, adopt, release, discard };
}
