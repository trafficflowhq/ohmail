"use client";

/**
 * Signatures — the Settings pane's per-mailbox signature editors. One editor per connected mailbox,
 * each THE COMPOSE EDITOR ITSELF with a live preview beneath: the preview renders the draft exactly
 * as the signature block will show it and the send will serialize it, so what is approved here is
 * what ships; per mailbox because two addresses are two sign-offs. The editor is the compose editor
 * (0.16): a sign-off offers the same set as writing mail and NOT ONE THING MORE, by mounting the
 * same component — the grammar cannot drift (one grammar), the server reduces what arrives through
 * the SAME allow-list the body passes, and the preview and the block are this same component in
 * read-only mode, so pane, block and message cannot render three ways.
 */

/**
 * Two save shapes, the editor decides: it reports `{text, html}` and answers `html: ""` for a document nobody
 * formatted (the `rich-text.ts` round-trip rule). No markup ⇒ the plain half is written and the markup cleared — byte
 * for byte the pre-formatting request; markup ⇒ the markup is written and THE SERVER DERIVES the plain half with the
 * converter that renders every composed message's text part. Never both (`setMailboxSignature` refuses, so does the
 * route).
 */

/**
 * Server- confirmed values only: editors seed from `useConsentState()`'s live maps and a save resolves to the
 * server's echo — the stored markup is the SANITIZED markup, so a control the server strips is visibly gone rather
 * than quietly dropped at send. A draft exists only while an editor differs; a refused write keeps it on screen under
 * the failure sentence. The pane renders only once the maps are KNOWN (`signaturesKnown`) — an empty editor over
 * stored text lies in both directions.
 */

/**
 * It writes through `useConsentState().setMailboxSignature`, never the API client: the compose
 * surfaces read the SAME hook's maps, so a saved signature reaches an open composer on the render
 * the server confirms, and a write from another surface reaches this pane through the settings
 * doorbell. Clearing is saving an empty editor: the server stores blank as NULL, both halves, the
 * keys leave both maps, and the compose block stops rendering for that sender — no separate
 * "delete" control, an empty editor IS "no signature", stated once.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import { RichEditor } from "./RichEditorLazy";
import { isRichEmpty, type RichValue } from "./rich-text";
import { standingNote, TravelledChangeNote, type TravelledChangeWire } from "./travelled-change";
import { holdLeave } from "./routing";
import { isRemovedMailbox } from "./mail-state";
import { organizerRefusalOf, organizerRefusalSentence } from "./organizer-refusal";

export function SignaturesRow({
  mailboxes,
  signatures,
  signaturesHtml,
  signatureSources,
  changes = {},
  setMailboxSignature,
}: {
  /**
   * The account's mailboxes — id + address, `GET /mailboxes`' order, plus the one fact that
   * decides whether an editor here is a control or a report: `organizerRole`. On a mailbox
   * somebody else organizes, the signature in force is THEIRS and the local row is a dead copy,
   * so the editor shows their text and does not offer to change it. Optional, and an absent role
   * reads as "this install organizes it" — the column's own default and the only safe direction:
   * a roster too old to carry the field would otherwise lock every editor on the account.
   */
  mailboxes: ReadonlyArray<{
    id: string; address: string; organizerRole?: string | null;
    status?: string; legacyStandDown?: boolean; takeoverAuthorizedAt?: string | null;
  }>;
  /**
   * The stored text map, server-confirmed — `{ mailboxId: text }`, absent key = none. On a mailbox
   * this install only reads, the value is the ORGANIZER'S published one rather than the local row
   * (`effectiveMailboxSignatures`), which is what makes the read-only editor below show the
   * sign-off outgoing mail will actually carry instead of a copy nothing applies.
   */
  signatures: Readonly<Record<string, string>>;
  /**
   * The stored MARKUP map, server-confirmed — `{ mailboxId: html }`, absent key = this
   * signature has no formatting in it (which is not the same as having no signature: the text
   * map above answers that, and the two are read together).
   */
  signaturesHtml: Readonly<Record<string, string>>;
  /**
   * WHOSE signature each mailbox is showing — `"organizer"` only where the organizing install has
   * PUBLISHED one. A mailbox missing from this map reads LOCAL, so the read-only report below
   * renders on a positive fact and never on an absence: a server too old to answer it, or an
   * organizer that has not published yet, leaves the editor a control over the row this install
   * actually sends with.
   */
  signatureSources: Readonly<Record<string, "organizer" | "local">>;
  /**
   * On a mailbox another install organizes, where its last signature change went
   * (`useConsentState().signatureChanges`): on its way, or refused with the holder's name.
   */
  changes?: Readonly<Record<string, TravelledChangeWire>>;
  /** `useConsentState().setMailboxSignature` — one writer, the value every composer reads. */
  setMailboxSignature: (
    mailboxId: string, signature: string | null, signatureHtml?: string | null,
  ) => Promise<unknown>;
}) {
  const t = useTranslations("settings");
  const tWhy = useTranslations("ohbox");
  /* A removed mailbox's tombstone keeps its signature inert: no editor, and the server refuses its writes. */
  const live = mailboxes.filter((m) => !isRemovedMailbox(m));
  /** Editors that DIFFER from the stored value, keyed by mailbox. Absent = showing the store. */
  const [drafts, setDrafts] = useState<Record<string, RichValue>>({});
  /** The mailbox whose save is in flight, or null — one write at a time, the pane's rule. */
  const [pending, setPending] = useState<string | null>(null);
  /** The sentence under the pane after a refused save, or null. */
  const [failed, setFailed] = useState<string | null>(null);

  /** Unmounted-after-await guard — the pane is swapped by a nav press, so this really happens. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  /**
   * AN EDITED SIGNATURE HOLDS THE ROUTE, as the away pane's change does: leaving the pane unmounts
   * these editors, so a draft not saved was dropped in silence. While any editor differs from the
   * store (and no save is in flight) a leave asks first, and closing the tab asks the browser's
   * question. Discard drops every draft and leaves; Keep editing stays.
   */
  const [leaving, setLeaving] = useState<(() => void) | null>(null);
  const askRef = useRef<HTMLDivElement | null>(null);
  const dirtyOf = (id: string): boolean => {
    const d = drafts[id];
    return d !== undefined
      && (d.text !== (signatures[id] ?? "") || d.html !== (signaturesHtml[id] ?? ""));
  };
  const firstDirty = live.find((mb) => dirtyOf(mb.id))?.id ?? null;
  const holding = firstDirty !== null && pending === null;
  useEffect(() => {
    if (!holding) { setLeaving(null); return; }
    const release = holdLeave((leave) => setLeaving(() => leave), "#/settings/signatures");
    const onUnload = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", onUnload);
    return () => { release(); window.removeEventListener("beforeunload", onUnload); };
  }, [holding]);
  useEffect(() => {
    if (leaving === null) return;
    askRef.current?.scrollIntoView?.({ block: "nearest" });
    askRef.current?.focus();
  }, [leaving]);

  const save = (mailboxId: string, value: RichValue, takeoverAsked: boolean) => {
    if (pending !== null) return;
    setPending(mailboxId);
    setFailed(null);
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
      } catch (err) {
        // The draft STAYS — the words are the user's and the write did not land; the sentence
        // below says so (and why, when nothing organizes the mailbox) and Save remains offered.
        const why = organizerRefusalSentence(
          organizerRefusalOf(err as Parameters<typeof organizerRefusalOf>[0], { starting: takeoverAsked }), tWhy,
        );
        if (alive.current) setFailed(why ?? t("signatures.failed"));
      } finally {
        if (alive.current) setPending(null);
      }
    })();
  };

  return (
    <>
      <p className="set-note-inline">{t("signatures.note")}</p>
      {live.map((mb) => {
        /** What the database holds for this mailbox, in both shapes. */
        const stored: RichValue = {
          text: signatures[mb.id] ?? "",
          html: signaturesHtml[mb.id] ?? "",
        };
        const draft = drafts[mb.id];
        const shown = draft ?? stored;
        const dirty = draft !== undefined
          && (draft.text !== stored.text || draft.html !== stored.html);
        /**
         * A MAILBOX THIS INSTALL ONLY READS — the editor is a report, not a control.
         *
         * The signature in force is published by whoever organizes the mailbox and this install's
         * own row is inert, so the editor renders the organizer's text read-only under a sentence
         * saying where it was set, and Save and Discard are not offered at all — a disabled button
         * invites a press and then explains itself. ABSENT reads as "organizer", the column's
         * default: a roster too old to carry the field must not lock the editors on an install
         * that owns its mailbox.
         */
        /* BOTH FACTS, because either alone is false somewhere: a reader whose organizer has
           published nothing still sends its OWN row, so locking that editor would report a
           signature nobody set and remove the only control over the one that goes out. */
        const reading = mb.organizerRole === "reader"
          && signatureSources[mb.id] === "organizer";
        return (
          <div className="sig-settings" key={mb.id}>
            <div className="lab">
              <b>{mb.address}</b>
              <span>
                {reading
                  ? t("signatures.mailboxRead")
                  : stored.text.trim().length > 0
                    ? t("signatures.mailboxOn")
                    : t("signatures.mailboxOff")}
              </span>
            </div>
            <RichEditor
              className="sig-settings-editor"
              ariaLabel={`${t("signatures.title")}: ${mb.address}`}
              value={shown}
              placeholder={t("signatures.placeholder")}
              editable={!reading && pending === null}
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
            <TravelledChangeNote note={standingNote(changes[mb.id])} />
            {leaving !== null && mb.id === firstDirty ? (
              <div
                ref={askRef}
                className="sig-settings-actions"
                role="alertdialog"
                aria-label={t("signatures.leaveAsk")}
                tabIndex={-1}
              >
                <span className="set-note-inline">{t("signatures.leaveAsk")}</span>
                <Button variant="primary" onClick={() => { const leave = leaving; setDrafts({}); setLeaving(null); leave(); }}>
                  {t("signatures.revert")}
                </Button>
                <Button variant="ghost" onClick={() => setLeaving(null)}>{t("signatures.leaveKeep")}</Button>
              </div>
            ) : reading ? null : (
            <div className="sig-settings-actions">
              <Button
                variant="primary"
                disabled={!dirty || pending !== null}
                aria-busy={pending === mb.id || undefined}
                onClick={() => save(mb.id, shown, Boolean(mb.takeoverAuthorizedAt))}
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
            )}
          </div>
        );
      })}
      {failed !== null ? <span className="scn-sg-note">{failed}</span> : null}
    </>
  );
}
