"use client";

/**
 * SIGNATURES — the Settings pane's per-mailbox signature editors.
 *
 * One editor per connected mailbox, each THE COMPOSE EDITOR ITSELF with a live preview beneath
 * it: the preview renders the draft exactly as the compose surfaces' signature block will show
 * it (and exactly as the send will serialize it), so what is approved here is what ships. The
 * stored value is per mailbox because the signature is: two addresses are two sign-offs, and
 * the compose block follows the From selector between them.
 *
 * ── THE EDITOR IS THE COMPOSE EDITOR, WHICH IS THE WHOLE DESIGN (0.16) ────────────────────
 *
 * This pane was a plain textarea. A sign-off is part of the message, and writing mail here
 * already offers bold, italic, strike, links, lists, quotes and code — so the signature offers
 * the same set and NOT ONE THING MORE, by mounting the same component rather than by growing a
 * second formatting surface with its own opinions. Three consequences, all of them the point:
 *
 *   · the grammar cannot drift from the composer's, because there is one grammar;
 *   · the server reduces what arrives through the SAME allow-list the message body passes, so a
 *     control this editor does not offer is refused twice rather than trusted once;
 *   · the preview and the signature block are this same component in read-only mode, so the
 *     pane, the block and the message cannot render three different ways.
 *
 * ── TWO SAVE SHAPES, AND THE EDITOR DECIDES WHICH ─────────────────────────────────────────
 *
 * The editor reports `{text, html}` and answers `html: ""` for a document nobody formatted —
 * the round-trip rule in `rich-text.ts`, and it is load-bearing here exactly as it is on the
 * send path. So:
 *
 *   no markup   the plain half is written and the markup cleared. Byte for byte the request
 *               this pane made before it could format anything, which is what keeps every
 *               existing signature and every plain-text client unaffected.
 *   markup      the markup is written and THE SERVER DERIVES the plain half from it, with the
 *               converter that renders the text part of every composed message.
 *
 * The two are never sent together: one value, one door (`setMailboxSignature` refuses both, and
 * so does the route before anything writes).
 *
 * ── SERVER-CONFIRMED VALUES ONLY ──────────────────────────────────────────────────────────
 *
 * The editors seed from `useConsentState()`'s live maps — text and markup — and a save resolves
 * to the server's echo, which is what the hook stores and this pane re-renders from. That
 * matters more now than it did: the stored markup is the SANITIZED markup, so the pane shows
 * what survived rather than what was typed, and a control the server strips is visibly gone
 * rather than quietly dropped at send time. A DRAFT exists only while an editor differs from
 * the stored value; Save writes it, and a refused write keeps the draft on screen under the
 * failure sentence rather than pretending it landed. The pane renders at all only once the maps
 * are KNOWN (`signaturesKnown`), because an empty editor over stored text is a lie in both
 * directions.
 *
 * ── IT WRITES THROUGH THE HOOK ────────────────────────────────────────────────────────────
 *
 * `setMailboxSignature` is `useConsentState().setMailboxSignature`, never the API client
 * directly: the compose surfaces read the SAME hook's maps, so a saved signature reaches an
 * open composer on the same render the server confirms — and a write from another surface
 * reaches this pane through the settings doorbell (the `settings` change row → stamp → re-ask).
 *
 * Clearing is saving an empty editor: the server stores blank as NULL, both halves, the keys
 * leave both maps, and the compose block stops rendering for that sender. No separate "delete"
 * control — an empty editor IS "no signature", stated once.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import { RichEditor } from "./RichEditor";
import { isRichEmpty, type RichValue } from "./rich-text";

export function SignaturesRow({
  mailboxes,
  signatures,
  signaturesHtml,
  setMailboxSignature,
}: {
  /** The account's mailboxes — id + address, `GET /mailboxes`' order. */
  mailboxes: ReadonlyArray<{ id: string; address: string }>;
  /** The stored text map, server-confirmed — `{ mailboxId: text }`, absent key = none. */
  signatures: Readonly<Record<string, string>>;
  /**
   * The stored MARKUP map, server-confirmed — `{ mailboxId: html }`, absent key = this
   * signature has no formatting in it (which is not the same as having no signature: the text
   * map above answers that, and the two are read together).
   */
  signaturesHtml: Readonly<Record<string, string>>;
  /** `useConsentState().setMailboxSignature` — one writer, the value every composer reads. */
  setMailboxSignature: (
    mailboxId: string, signature: string | null, signatureHtml?: string | null,
  ) => Promise<unknown>;
}) {
  const t = useTranslations("settings");
  /** Editors that DIFFER from the stored value, keyed by mailbox. Absent = showing the store. */
  const [drafts, setDrafts] = useState<Record<string, RichValue>>({});
  /** The mailbox whose save is in flight, or null — one write at a time, the pane's rule. */
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  /** Unmounted-after-await guard — the pane is swapped by a nav press, so this really happens. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const save = (mailboxId: string, value: RichValue) => {
    if (pending !== null) return;
    setPending(mailboxId);
    setFailed(false);
    void (async () => {
      try {
        /**
         * ONE OF THE TWO SHAPES, decided by whether the editor reports markup at all.
         *
         * `html === ""` is the editor's own answer for a document nobody formatted, not a
         * hand-written "does it contain a tag" test — the same predicate the send path uses to
         * decide whether a message goes out as one part or two. Asking the editor is the only
         * check that cannot drift from the editor.
         */
        if (value.html === "") {
          await setMailboxSignature(mailboxId, isRichEmpty(value) ? null : value.text);
        } else {
          // The markup is the value; the server derives the text half. Passing the editor's own
          // `text` alongside would be refused, and rightly: two halves from two sources can
          // disagree, and one of them would be what a plaintext recipient reads.
          await setMailboxSignature(mailboxId, null, value.html);
        }
        // The hook has stored the echo; dropping the draft makes the editor render it —
        // server-confirmed, which on success is the value that was just saved (or nothing).
        if (alive.current) {
          setDrafts((cur) => {
            const { [mailboxId]: _gone, ...rest } = cur;
            return rest;
          });
        }
      } catch {
        // The draft STAYS — the words are the user's and the write did not land; the sentence
        // below says so and Save remains offered.
        if (alive.current) setFailed(true);
      } finally {
        if (alive.current) setPending(null);
      }
    })();
  };

  return (
    <>
      <p className="set-note-inline">{t("signatures.note")}</p>
      {mailboxes.map((mb) => {
        /** What the database holds for this mailbox, in both shapes. */
        const stored: RichValue = {
          text: signatures[mb.id] ?? "",
          html: signaturesHtml[mb.id] ?? "",
        };
        const draft = drafts[mb.id];
        const shown = draft ?? stored;
        const dirty = draft !== undefined
          && (draft.text !== stored.text || draft.html !== stored.html);
        return (
          <div className="sig-settings" key={mb.id}>
            <div className="lab">
              <b>{mb.address}</b>
              <span>
                {stored.text.trim().length > 0
                  ? t("signatures.mailboxOn")
                  : t("signatures.mailboxOff")}
              </span>
            </div>
            <RichEditor
              className="sig-settings-editor"
              ariaLabel={`${t("signatures.title")}: ${mb.address}`}
              value={shown}
              placeholder={t("signatures.placeholder")}
              editable={pending === null}
              onChange={(v) => setDrafts((cur) => ({ ...cur, [mb.id]: v }))}
            />
            {/* THE LIVE PREVIEW — the block as a message will carry it, drawn from the SAME
                value the editor holds by the SAME component the block uses. Absent while there
                is nothing to preview: a frame around emptiness would be a claim about a
                signature that does not exist. */}
            {!isRichEmpty(shown) ? (
              <div className="sig-settings-preview" aria-label={t("signatures.preview")}>
                <span className="sig-tag" aria-hidden="true">{t("signatures.preview")}</span>
                <RichEditor
                  className="sig-preview-text"
                  ariaLabel={t("signatures.preview")}
                  value={shown}
                  onChange={() => {}}
                  editable={false}
                  toolbar={false}
                />
              </div>
            ) : null}
            <div className="sig-settings-actions">
              <Button
                variant="primary"
                disabled={!dirty || pending !== null}
                aria-busy={pending === mb.id || undefined}
                onClick={() => save(mb.id, shown)}
              >
                {pending === mb.id ? t("signatures.saving") : t("signatures.save")}
              </Button>
              {dirty && pending === null ? (
                <Button variant="ghost" onClick={() => setDrafts((cur) => {
                  const { [mb.id]: _gone, ...rest } = cur;
                  return rest;
                })}>
                  {t("signatures.revert")}
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}
      {failed ? <span className="scn-sg-note">{t("signatures.failed")}</span> : null}
    </>
  );
}
