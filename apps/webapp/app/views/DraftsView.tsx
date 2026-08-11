"use client";

/**
 * DRAFTS — the messages you started and have not sent.
 *
 * ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────────────────
 *
 * The `drafts` table, its four routes and the `draft` sync entity have existed since the send
 * path was built. The compose form never used any of it: a half-written message lived in
 * `localStorage`, under one key, in one browser. That is enough to survive navigating away and a
 * reload — which is what it was for — and it means a draft is not on the account. Close the tab
 * on a phone and it is on the laptop's disk. Clear site data and it is gone. Open the mail
 * anywhere else and there is nothing to open.
 *
 * The compose form now autosaves to a real row (`compose-autosave.ts`), which is what gives this
 * list something to list. Every row here came off `/sync`, so it is the same list on every device
 * the account is open on.
 *
 * ── WHAT A ROW OFFERS, AND THE ONE IT DOES NOT ──────────────────────────────────────────
 *
 * Open, and Discard. There is deliberately no Send from here: sending is a decision taken while
 * looking at the message, with the recipients, the subject and the From line in front of you, and
 * a Send button in a list is a button whose blast radius is a row of preview text. Open, read it,
 * send it from the place that shows it to you.
 *
 * DISCARD IS TWO PRESSES and the second one is under a sentence, on `RulesView`'s reasoning: a
 * draft is unrecoverable — `DELETE /drafts/:id` is a real delete, not a soft one — and the only
 * copy of an unsent message is not something a mis-click may take.
 *
 * ── A REPLY OPENS AS A REPLY ────────────────────────────────────────────────────────────
 *
 * A draft with an `inReplyToMessageId` this device can resolve is a half-written answer to a
 * message the reader can see, and opening it in a standalone compose form would strip it of the
 * conversation it belongs to. The shell routes those back to the message's own inline editor;
 * everything else — a compose, or a reply whose parent this device has not synced — opens in
 * Compose. The decision is the shell's because only the shell can look in the mirror; this view
 * reports the press and says which kind of thing each row is.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { EngineDraft } from "@ohmail/client-engine";
import { Button, InfoNote, ListPane, ListRows } from "@ohmail/ui";

/** "you, and two others" — the recipients, as a line, or the empty-string for none. */
function recipientLine(d: EngineDraft): string {
  const all = [...d.to, ...d.cc, ...d.bcc];
  return all.map((a) => a.name || a.address).join(", ");
}

export function DraftsView({
  drafts,
  now,
  onOpen,
  onDiscard,
  /**
   * Can this device open the message this draft answers? Asked of the SHELL because only it can
   * read the mirror — and the answer changes what the row says, not just what the press does: a
   * reply whose parent has not synced to this device opens as a plain compose, and telling
   * somebody it will open "in the conversation" and then not doing so is worse than saying
   * nothing.
   */
  repliesHere,
}: {
  drafts: readonly EngineDraft[];
  now: Date;
  onOpen: (draft: EngineDraft) => void;
  onDiscard: (draftId: string) => void;
  repliesHere: (draft: EngineDraft) => boolean;
}) {
  const t = useTranslations("drafts");
  /** The row whose Discard has been pressed once. One at a time — a list of open confirms is noise. */
  const [confirming, setConfirming] = useState<string | null>(null);

  return (
    <section className="view col view-drafts">
      <ListPane
        title={t("title")}
        meta={drafts.length ? t("metaCount", { count: drafts.length }) : undefined}
      >
        {/* Same idiom as History: the sentence that says what the list IS stays on screen,
            the one that says where the drafts live is behind the (i). */}
        <InfoNote
          className="view-note"
          lead={t("explainer")}
          moreLabel={t("explainerMoreLabel")}
        >
          {t("explainerMore")}
        </InfoNote>
        <ListRows>
          {drafts.length ? (
            drafts.map((d) => {
              const to = recipientLine(d);
              return (
                <div key={d.id} className="draft-row" data-id={d.id}>
                  {/* THE TWO CONTROLS THAT ARE ACTUALLY SIDE BY SIDE, and only those. The
                      confirm below is a SIBLING of this line, not a third item in it — see
                      `.draft-row` in `app.css` for what it cost to have it inside. */}
                  <div className="draft-row-main">
                    <button
                      type="button"
                      className="draft-open"
                      onClick={() => onOpen(d)}
                      title={t("openTitle")}
                    >
                      <span className="draft-line">
                        <b className="draft-subject">{d.subject.trim() || t("noSubject")}</b>
                        <span className="draft-when">{stamp(d.updatedAt, now)}</span>
                      </span>
                      <span className="draft-line">
                        {/* WHO IT IS FOR, or the honest absence. A draft with no recipient is the
                            commonest kind of unfinished message and the list must not pretend
                            otherwise by leaving the line blank. */}
                        <span className="draft-to">{to || t("noRecipient")}</span>
                        {repliesHere(d) ? <span className="draft-badge">{t("isReply")}</span> : null}
                      </span>
                      <span className="draft-preview">{preview(d.body)}</span>
                    </button>
                    {/* THE TRIGGER STAYS ON SCREEN WHILE THE QUESTION IS OPEN — `RulesView`'s
                        idiom, and the reason is the same: it was SWAPPED for the confirm, so
                        the row lost its only trailing control and the panel took its place in
                        the flex line. A disclosure that keeps its trigger can also be closed
                        from the same place it was opened. */}
                    <button
                      type="button"
                      className="draft-discard"
                      aria-expanded={confirming === d.id}
                      onClick={() => setConfirming(confirming === d.id ? null : d.id)}
                    >
                      {t("discard")}
                    </button>
                  </div>
                  {confirming === d.id ? (
                    <div className="draft-confirm" role="group" aria-label={t("discardConfirm")}>
                      {/* SAID BEFORE THE ACT, not after. A draft is the only copy of an unsent
                          message and the delete is real. */}
                      <p className="set-note-inline">{t("discardWhat")}</p>
                      <div className="gate-actions">
                        <Button
                          variant="primary"
                          onClick={() => { setConfirming(null); onDiscard(d.id); }}
                        >
                          {t("discardConfirm")}
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirming(null)}>
                          {t("discardCancel")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="empty">
              <span className="glyph">✎</span>
              <b>{t("emptyTitle")}</b>
              {t("emptyHint")}
            </div>
          )}
        </ListRows>
      </ListPane>
    </section>
  );
}

/** The first line of the body, cut — never the html, which this surface never renders. */
function preview(body: string): string {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
}

/**
 * When it was last touched. Deliberately coarse: a draft list is answering "what was I writing",
 * and a minute-accurate stamp on something nobody sent invites the reader to treat it as a record.
 */
function stamp(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const day = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
  const ago = Math.round((day(now) - day(d)) / 86_400_000);
  if (ago === 0) {
    return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const s = `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? s : `${s} ${d.getUTCFullYear()}`;
}
