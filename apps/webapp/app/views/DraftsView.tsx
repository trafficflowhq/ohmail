"use client";

/**
 * Drafts — the messages you started and have not sent. A half-written message used to live in `localStorage`, one
 * key, one browser — enough to survive a reload, and invisible on every other device. The compose form now autosaves
 * to a real row (`compose-autosave.ts`), every row here came off `/sync`, so it is the same list on every device. A
 * row offers Open and Discard — deliberately no Send from a list: sending is a decision taken while looking at the
 * message.
 */

/**
 * Discard is two presses (`RulesView`'s reasoning): `DELETE /drafts/:id` is a real delete, and the only copy of an
 * unsent message is not something a mis-click may take. A reply opens as a reply: a draft with a resolvable
 * `inReplyToMessageId` routes back to the message's own inline editor (the shell decides — only it can look in the
 * mirror). A send that did not confirm is a row here and says so: `draftsList` surfaces `unverified` rows and stale
 * `sending` rows — both hold the only copy of a message that may never have been delivered; opening one recovers the
 * text into a fresh message, never a blind re-send.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type { EngineDraft } from "@ohmail/client-engine";
import { Button, InfoNote, ListPane, ListRows } from "@ohmail/ui";
import { displayTime, scheduleLabel } from "../shell/format";
import { useZoneNav } from "../shell/zone-nav";
import { HeldSendResolve } from "../components/HeldSendResolve";

/**
 * WHEN A HELD SEND STOPS BEING "NOT CONFIRMED YET" AND BECOMES "WE NEVER CONFIRMED IT".
 *
 * `unverifiedNote` reads as a thing still settling, and for an hour it is. The account behind the
 * 2026-09-16 incident carried one such row for THIRTY-SIX DAYS with the same sentence and the same
 * two verbs, and nobody ever pressed them: nothing on screen said the question had gone stale.
 * Seven days, ruled — it is a READING, not a state: no clock writes anything, the row is still
 * `unverified` on the server, and the two verbs are still the only way out.
 */
const HELD_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Has this held row's question been standing longer than the bound? `updatedAt` is the row's last
 * write and nothing touches an `unverified` row while it waits, so it is the moment it was left
 * held. An unparseable stamp reads NOT stale — the softer sentence is the one that claims less.
 */
function heldIsStale(d: EngineDraft, now: Date): boolean {
  const at = Date.parse(d.updatedAt);
  return Number.isFinite(at) && now.getTime() - at > HELD_STALE_AFTER_MS;
}

/** "you, and two others" — the recipients, as a line, or the empty-string for none. */
function recipientLine(d: EngineDraft): string {
  const all = [...d.to, ...d.cc, ...d.bcc];
  return all.map((a) => a.name || a.address).join(", ");
}

export function DraftsView({
  drafts,
  scheduled,
  now,
  onOpen,
  onDiscard,
  onResolve,
  askResolveFor,
  heldHere,
  onCancelSchedule,
  onEditScheduled,
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
  /**
   * SEND LATER's appointments (mail 0077), soonest first — rendered as their own group ABOVE
   * the drafts, because a message that WILL act on its own is more urgent to see than one that
   * never will. A scheduled row offers exactly two verbs, and Discard is deliberately not one
   * of them: Edit is cancel-then-open (the server freezes a scheduled row, so editing means
   * taking the appointment off first), and Cancel returns it to the drafts below. Both go
   * through the cancel verb, which is the one race-safe way off the schedule.
   */
  scheduled: readonly EngineDraft[];
  now: Date;
  onOpen: (draft: EngineDraft) => void;
  onDiscard: (draftId: string) => void;
  /**
   * A person's answer for a send this server could not confirm. Dispatched straight to the
   * engine by the shell; this view renders the two verbs and knows nothing about the hold.
   */
  onResolve: (draftId: string, outcome: "arrived" | "not_arrived") => void;
  /**
   * The row a Discard was just refused for, stamped by the press that was refused — the list puts
   * focus on THAT row's pair of verbs. The toast alone named the answer and pointed at nothing: on
   * a list with ten held rows there are ten identical pairs on screen (measured on the rig,
   * 2026-09-16), so "tell us whether it arrived" is an instruction with no address.
   */
  askResolveFor?: { draftId: string; at: number } | null;
  /**
   * The rows THIS browser holds by a durable send record — asked of the shell, like `repliesHere`,
   * because only it can read the jar. A record naming a row the mirror still calls `"draft"` is
   * the lost-answer case, and it refuses Discard just as hard as an `unverified` status does; the
   * verbs below were offered on the status alone, so that row was refused with no exit rendered
   * anywhere. Optional: the three other doors that mount this view's component pass nothing.
   */
  heldHere?: ReadonlySet<string>;
  onCancelSchedule: (draftId: string) => void;
  onEditScheduled: (draft: EngineDraft) => void;
  repliesHere: (draft: EngineDraft) => boolean;
}) {
  const t = useTranslations("drafts");

  /* The zone model's rail leg only (`zone-nav.tsx`): ← steps to the rail, ↑/↓ walk it, →
     returns. No list config — this view has no keyboard cursor yet — and no reader zone. */
  useZoneNav({});
  /** The row whose Discard has been pressed once. One at a time — a list of open confirms is noise. */
  const [confirming, setConfirming] = useState<string | null>(null);
  /**
   * THE QUESTION IS A DIALOG TO THE ACCESSIBILITY TREE, and focus moves with it — the same
   * treatment as the compose cancel confirm, for the same reason: an inline `group` that
   * appears in silence is a destructive question a screen-reader user never hears. Focus lands
   * on the panel when it opens; closing without acting puts it back on the row's own trigger.
   */
  const listRef = useRef<HTMLElement | null>(null);
  const confirmRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (confirming !== null) confirmRef.current?.focus();
  }, [confirming]);
  /**
   * A REFUSED DISCARD PUTS FOCUS ON THE VERBS THAT UNBLOCK THAT ROW. Keyed on the press's own
   * stamp, so a second press on the same row asks again; the ask is never cleared, because a value
   * left standing cannot fire twice. `.draft-resolve` is a `group`, so focusing the group is what
   * a screen reader hears — its label is the question — and the first verb is one Tab away.
   */
  const askedAt = askResolveFor?.at ?? null;
  const askedFor = askResolveFor?.draftId ?? null;
  useEffect(() => {
    if (askedAt === null || askedFor === null) return;
    const esc = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape
      ?? ((s: string) => s);
    const group = listRef.current
      ?.querySelector<HTMLElement>(`.draft-row[data-id="${esc(askedFor)}"] .draft-resolve`);
    if (!group) return;
    group.scrollIntoView({ block: "nearest" });
    group.focus();
  }, [askedAt, askedFor]);
  const closeConfirm = useCallback((draftId: string) => {
    setConfirming(null);
    // `CSS.escape` is fenced because jsdom builds lack it; a draft id is a server UUID, so the
    // raw fallback never actually differs.
    const esc = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape
      ?? ((s: string) => s);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`.draft-row[data-id="${esc(draftId)}"] .draft-discard`)
      ?.focus();
  }, []);

  return (
    <section className="view col view-drafts" ref={listRef}>
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
        {/* ── SCHEDULED — the appointments, above the drafts they will stop being ─────────────
            Each row says WHEN it sends, in the reader's own clock (`scheduleLabel`), because
            the time is the entire content of this group. Open-to-edit and Cancel both route
            through the shell's cancel verb — see the prop's note. */}
        {scheduled.length ? (
          <>
            <div className="drafts-group-head" role="heading" aria-level={2}>
              {t("scheduledTitle")}
            </div>
            <ListRows ariaLabel={t("scheduledTitle")}>
              {scheduled.map((d) => {
                const to = recipientLine(d);
                return (
                  <div key={d.id} className="draft-row draft-row-scheduled" data-id={d.id}>
                    <div className="draft-row-main">
                      <button
                        type="button"
                        className="draft-open"
                        onClick={() => onEditScheduled(d)}
                        title={t("scheduledEditTitle")}
                      >
                        <span className="draft-line">
                          <b className="draft-subject">{d.subject.trim() || t("noSubject")}</b>
                          {/* The appointment, not `updatedAt`: when it SENDS is this row's stamp. */}
                          <span className="draft-when">
                            {d.sendAt ? t("scheduledWhen", { when: scheduleLabel(d.sendAt, now) }) : ""}
                          </span>
                        </span>
                        <span className="draft-line">
                          <span className="draft-to">{to || t("noRecipient")}</span>
                        </span>
                        <span className="draft-preview">{preview(d.body ?? "")}</span>
                      </button>
                      <button
                        type="button"
                        className="draft-discard"
                        onClick={() => onCancelSchedule(d.id)}
                        title={t("scheduledCancelTitle")}
                      >
                        {t("scheduledCancel")}
                      </button>
                    </div>
                  </div>
                );
              })}
            </ListRows>
            <div className="drafts-group-head" role="heading" aria-level={2}>
              {t("title")}
            </div>
          </>
        ) : null}
        <ListRows ariaLabel={t("title")}>
          {drafts.length ? (
            drafts.map((d) => {
              const to = recipientLine(d);
              return (
                <div
                  key={d.id}
                  /* The row a refused Discard was about is MARKED as well as focused: focus alone
                     is invisible to a sighted reader who was watching the toast, not the list. */
                  className={askedFor === d.id ? "draft-row draft-row-asked" : "draft-row"}
                  data-id={d.id}
                >
                  {/* THE TWO CONTROLS THAT ARE ACTUALLY SIDE BY SIDE, and only those. The
                      confirm below is a SIBLING of this line, not a third item in it — see
                      `.draft-row` in `app.css` for what it cost to have it inside. */}
                  <div className="draft-row-main">
                    <button
                      type="button"
                      className="draft-open"
                      onClick={() => onOpen(d)}
                      title={d.status === "draft" ? t("openTitle") : t("openRecoverTitle")}
                    >
                      <span className="draft-line">
                        <b className="draft-subject">{d.subject.trim() || t("noSubject")}</b>
                        <span className="draft-when">{displayTime({ date: d.updatedAt }, now)}</span>
                      </span>
                      <span className="draft-line">
                        {/* WHO IT IS FOR, or the honest absence. A draft with no recipient is the
                            commonest kind of unfinished message and the list must not pretend
                            otherwise by leaving the line blank. */}
                        <span className="draft-to">{to || t("noRecipient")}</span>
                        {repliesHere(d) ? <span className="draft-badge">{t("isReply")}</span> : null}
                      </span>
                      <span className="draft-preview">{preview(d.body ?? "")}</span>
                      {/* WHAT IS AND IS NOT KNOWN, in the row — before any press. `role="status"`
                          for the same reason `SendStatus` carries it: the condition arrived out
                          of band, possibly days ago, and this line is the first anyone hears of
                          it. The wording never claims the mail failed: `unverified` means
                          exactly "we could not tell", and a claim either way would be a guess. */}
                      {d.status !== "draft" ? (
                        <span className="draft-state" role="status">
                          {d.status === "unverified"
                            ? t(heldIsStale(d, now) ? "unverifiedStaleNote" : "unverifiedNote")
                            : t("interruptedNote")}
                        </span>
                      ) : null}
                      {/* A SCHEDULED SEND THAT COULD NOT BE KEPT (mail 0077). The server's own
                          sentence rides in `sendError` and is QUOTED, `SendState.reason`'s
                          treatment of a live refusal — the row is an ordinary draft again, so
                          opening it to fix and resend works as on any draft, and the sentence
                          clears on the next edit or schedule. */}
                      {d.status === "draft" && d.sendError ? (
                        <span className="draft-state" role="status">
                          {t("scheduleFailedNote", { reason: d.sendError })}
                        </span>
                      ) : null}
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
                  {/* The stuck row's way out — BOTH stuck rows, which is the correction. A send
                      whose outcome could not be confirmed was a dead end, and so was one that
                      never answered at all: each note asked a question with nowhere to put the
                      answer, so Discard refused the row for ever. These are that answer — the only
                      two things a reader can know: they looked in Sent, and the message is there
                      or it is not. `!== "draft"` is exactly the rows carrying a note above, and
                      `draftsList` only lists a `sending` row once it is past every invocation's
                      lifetime, so the verbs are never offered for a send still running. Only the
                      mutation dispatches from here; whether the row may then be discarded is the
                      shell's predicate on the next render. */}
                  {d.status !== "draft" || heldHere?.has(d.id) === true ? (
                    <HeldSendResolve draftId={d.id} onResolve={onResolve} />
                  ) : null}
                  {confirming === d.id ? (
                    <div
                      ref={confirmRef}
                      className="draft-confirm"
                      role="alertdialog"
                      aria-label={t("discardConfirm")}
                      aria-describedby={`draft-discard-what-${d.id}`}
                      tabIndex={-1}
                    >
                      {/* SAID BEFORE THE ACT, not after. A draft is the only copy of an unsent
                          message and the delete is real. */}
                      <p className="set-note-inline" id={`draft-discard-what-${d.id}`}>
                        {t("discardWhat")}
                      </p>
                      <div className="gate-actions">
                        <Button
                          variant="primary"
                          onClick={() => { setConfirming(null); onDiscard(d.id); }}
                        >
                          {t("discardConfirm")}
                        </Button>
                        <Button variant="ghost" onClick={() => closeConfirm(d.id)}>
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
 * WHEN IT WAS LAST TOUCHED — through `displayTime`, which is the shell's one stamp. This was a private `stamp()`
 * here: its own day-banding, its own hardcoded English month table, and its own `getUTC*` reads. It therefore carried
 * both defects the shared stamp had already had fixed — a German reader saw "Aug", and every reader saw the server's
 * clock rather than their own — and it would have gone on carrying them, because a formatter that is not the seam is
 * not touched when the seam is. That is the whole argument for there being exactly one. What changed on screen: a
 * draft touched within the last six days now names its weekday ("Sat") where it used to give a date ("8 Aug"). That
 * is the same rule every other list in the product follows, and it is coarser rather than finer, which is what the
 * old comment here was protecting.
 */
