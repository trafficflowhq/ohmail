"use client";

/**
 * SIGNATURES — the Settings pane's per-mailbox signature editors (mail 0075).
 *
 * One editor per connected mailbox, each a PLAIN MULTI-LINE text area with a live preview
 * beneath it: the preview renders the draft exactly as the compose surfaces' signature block
 * will show it (and exactly as the send will serialize it), so what is approved here is what
 * ships. The stored value is per mailbox because the signature is: two addresses are two
 * sign-offs, and the compose block follows the From selector between them.
 *
 * ── SERVER-CONFIRMED VALUES ONLY ──────────────────────────────────────────────────────────
 *
 * The editors seed from `useConsentState().signatures` — the live wire's map — and a save
 * resolves to the server's echo, which is what the hook stores and this pane re-renders from.
 * A DRAFT exists only while an editor differs from the stored text; Save writes it, and a
 * refused write keeps the draft on screen under the failure sentence rather than pretending it
 * landed. The pane renders at all only once the map is KNOWN (`signaturesKnown`), because an
 * empty editor over stored text is a lie in both directions.
 *
 * ── IT WRITES THROUGH THE HOOK ────────────────────────────────────────────────────────────
 *
 * `setMailboxSignature` is `useConsentState().setMailboxSignature`, never the API client
 * directly: the compose surfaces read the SAME hook's map, so a saved signature reaches an
 * open composer on the same render the server confirms — and a write from another surface
 * reaches this pane through the settings doorbell (the `settings` change row → stamp → re-ask).
 *
 * Clearing is saving an empty editor: the server stores blank as NULL (`setMailboxSignature`),
 * the key leaves the map, and the compose block stops rendering for that sender. No separate
 * "delete" control — an empty editor IS "no signature", stated once.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";

export function SignaturesRow({
  mailboxes,
  signatures,
  setMailboxSignature,
}: {
  /** The account's mailboxes — id + address, `GET /mailboxes`' order. */
  mailboxes: ReadonlyArray<{ id: string; address: string }>;
  /** The stored map, server-confirmed — `{ mailboxId: text }`, absent key = none. */
  signatures: Readonly<Record<string, string>>;
  /** `useConsentState().setMailboxSignature` — one writer, the value every composer reads. */
  setMailboxSignature: (mailboxId: string, signature: string | null) => Promise<Record<string, string>>;
}) {
  const t = useTranslations("settings");
  /** Editors that DIFFER from the stored text, keyed by mailbox. Absent = showing the store. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  /** The mailbox whose save is in flight, or null — one write at a time, the pane's rule. */
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  /** Unmounted-after-await guard — the pane is swapped by a nav press, so this really happens. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const save = (mailboxId: string, draft: string) => {
    if (pending !== null) return;
    setPending(mailboxId);
    setFailed(false);
    void (async () => {
      try {
        await setMailboxSignature(mailboxId, draft.trim().length > 0 ? draft : null);
        // The hook has stored the echo; dropping the draft makes the editor render it —
        // server-confirmed, which on success is the text that was just saved (or nothing).
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
        const stored = signatures[mb.id] ?? "";
        const draft = drafts[mb.id];
        const shown = draft ?? stored;
        const dirty = draft !== undefined && draft !== stored;
        return (
          <div className="sig-settings" key={mb.id}>
            <div className="lab">
              <b>{mb.address}</b>
              <span>
                {stored.trim().length > 0 ? t("signatures.mailboxOn") : t("signatures.mailboxOff")}
              </span>
            </div>
            <textarea
              className="c-input sig-settings-editor"
              aria-label={`${t("signatures.title")}: ${mb.address}`}
              value={shown}
              rows={Math.min(Math.max(shown.split("\n").length, 2) + 1, 10)}
              placeholder={t("signatures.placeholder")}
              disabled={pending !== null}
              onChange={(e) => setDrafts((cur) => ({ ...cur, [mb.id]: e.target.value }))}
            />
            {/* THE LIVE PREVIEW — the block as a message will carry it, drawn from the SAME
                text the editor holds. Absent while there is nothing to preview: a frame around
                emptiness would be a claim about a signature that does not exist. */}
            {shown.trim().length > 0 ? (
              <div className="sig-settings-preview" aria-label={t("signatures.preview")}>
                <span className="sig-tag" aria-hidden="true">{t("signatures.preview")}</span>
                <div className="sig-preview-text">{shown}</div>
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
