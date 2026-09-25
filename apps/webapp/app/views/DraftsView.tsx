"use client";

/**
 * Drafts — the messages you started and have not sent. A half-written message used to live in `localStorage`, one
 * key, one browser — enough to survive a reload, and invisible on every other device. The compose form now autosaves
 * to a real row (`compose-autosave.ts`), every row here came off `/sync`, so it is the same list on every device. A
 * row offers Open and Discard — deliberately no Send from a list: sending is a decision taken while looking at the
 * message.
 */

/**
 * Discard is two presses, and both happen where the hand is: the confirm replaces the row's
 * trailing controls with one sentence and two buttons (Escape keeps). A reply opens as a reply: a
 * draft with a resolvable `inReplyToMessageId` routes back to the message's own inline editor (the
 * shell decides — only it can look in the mirror). A send that did not confirm is a row here and
 * says plainly what is known: `draftsList` surfaces `unverified` rows and stale `sending` rows — both
 * hold the only copy of a message that may never have been delivered. Discard works on them too.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { HELD_SEND_RECHECK_MS, type EngineDraft } from "@ohmail/client-engine";
import { Button, InfoNote, ListPane, ListRows } from "@ohmail/ui";
import { displayTime, scheduleLabel } from "../shell/format";
import { useZoneNav } from "../shell/zone-nav";
import { useListWindow } from "../shell/list-window";
import { HeldSendResolve } from "../components/HeldSendResolve";

/**
 * Is the engine still looking for this held send? `updatedAt` is the moment the row was left
 * `unverified` — nothing touches it while it waits — and the reconciler checks the Sent folder for
 * `HELD_SEND_RECHECK_MS` from then. Inside the window the row says so; past it, that the message is
 * not in Sent. An unparseable stamp reads as past the window: the sentence that claims less.
 */
function heldStillChecking(d: EngineDraft, now: Date): boolean {
  const at = Date.parse(d.updatedAt);
  return Number.isFinite(at) && now.getTime() - at < HELD_SEND_RECHECK_MS;
}

/** The refusal a Discard came back with, rendered in its row — never a toast alone. */
export interface DiscardRefusal {
  draftId: string;
  why: "still-sending" | "unknown-jar";
  at: number;
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
  onSendAgain,
  refusal,
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
  /** Send the words again: the shell answers `not_arrived` and opens the message with Send live. */
  onSendAgain: (draft: EngineDraft) => void;
  /**
   * The row a Discard was just refused for, with why — rendered IN THAT ROW as a sentence and
   * focused, so a refusal is never silent and never a toast pointing at nothing. Stamped by the
   * press: a second refusal on the same row is heard again.
   */
  refusal?: DiscardRefusal | null;
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
  /**
   * FOCUS FOLLOWS THE QUESTION BOTH WAYS. Opening puts it on the confirm. Keeping (the button or
   * Escape) puts it back on the Discard control that opened it — which is UNMOUNTED while the
   * question stands, since the confirm replaces the action area — so the restore runs after the
   * re-render, off the row remembered at the close, never off a node that is not there yet.
   */
  const focusBack = useRef<string | null>(null);
  useEffect(() => {
    if (confirming !== null) { confirmRef.current?.focus(); return; }
    const back = focusBack.current;
    if (back === null) return;
    focusBack.current = null;
    // `CSS.escape` is fenced because jsdom builds lack it; a draft id is a server UUID, so the
    // raw fallback never actually differs.
    const esc = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape
      ?? ((s: string) => s);
    listRef.current
      ?.querySelector<HTMLButtonElement>(`.draft-row[data-id="${esc(back)}"] .draft-discard`)
      ?.focus();
  }, [confirming]);
  /**
   * A REFUSED DISCARD IS READ FROM ITS ROW. Keyed on the press's own stamp, so a second refusal on
   * the same row is heard again. `.draft-refusal` is a live region with `tabIndex={-1}`: focusing
   * it is what a screen reader hears, and a sighted reader sees it where the press was.
   */
  const refusedAt = refusal?.at ?? null;
  const refusedFor = refusal?.draftId ?? null;
  useEffect(() => {
    if (refusedAt === null || refusedFor === null) return;
    const esc = (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS?.escape
      ?? ((s: string) => s);
    const line = listRef.current
      ?.querySelector<HTMLElement>(`.draft-row[data-id="${esc(refusedFor)}"] .draft-refusal`);
    if (!line) return;
    line.scrollIntoView({ block: "nearest" });
    line.focus();
  }, [refusedAt, refusedFor]);
  const closeConfirm = useCallback((draftId: string) => {
    focusBack.current = draftId;
    setConfirming(null);
  }, []);

  /**
   * THE LIST IS A WINDOW, like every list: nothing bounds what an account has written and not
   * sent. One index space for both groups and the heading between them, the Ohbox's shape —
   * Scheduled, its rows, Drafts, its rows — the two headings only while a send is scheduled.
   */
  const scrollerRef = useRef<HTMLDivElement>(null);
  const schedCount = scheduled.length;
  const draftCount = drafts.length;
  const schedBase = schedCount > 0 ? 1 : 0;
  const draftsHeadAt = schedBase + schedCount;
  const draftsBase = draftsHeadAt + (schedCount > 0 ? 1 : 0);
  const win = useListWindow({ scrollerRef, count: draftsBase + draftCount });
  const clamp = (i: number, hi: number): number => Math.min(Math.max(i, 0), hi);
  const schedFrom = clamp(win.start - schedBase, schedCount);
  const schedTo = clamp(win.end - schedBase, schedCount);
  const draftsFrom = clamp(win.start - draftsBase, draftCount);
  const draftsTo = clamp(win.end - draftsBase, draftCount);
  const showSchedHead = schedCount > 0 && win.start === 0;
  const showDraftsHead = schedCount > 0 && win.start <= draftsHeadAt && win.end > draftsHeadAt;

  return (
    <section className="view col view-drafts" ref={listRef}>
      <ListPane
        title={t("title")}
        meta={drafts.length ? t("metaCount", { count: drafts.length }) : undefined}
        scrollerRef={scrollerRef}
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
        <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
        {showSchedHead ? (
          <div className="drafts-group-head" role="heading" aria-level={2} data-index={0}>
            {t("scheduledTitle")}
          </div>
        ) : null}
        {schedTo > schedFrom ? (
          <ListRows ariaLabel={t("scheduledTitle")}>
            {scheduled.slice(schedFrom, schedTo).map((d, k) => {
              const to = recipientLine(d);
              const at = schedFrom + k;
              return (
                <div
                  key={d.id}
                  className={["draft-row draft-row-scheduled", at === schedCount - 1 ? "draft-row-last" : ""].filter(Boolean).join(" ")}
                  data-id={d.id}
                  data-index={schedBase + at}
                >
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
        ) : null}
        {showDraftsHead ? (
          <div className="drafts-group-head" role="heading" aria-level={2} data-index={draftsHeadAt}>
            {t("title")}
          </div>
        ) : null}
        {draftsTo > draftsFrom ? (
          <ListRows ariaLabel={t("title")}>
            {drafts.slice(draftsFrom, draftsTo).map((d, k) => {
              const to = recipientLine(d);
              const at = draftsFrom + k;
              return (
                <div
                  key={d.id}
                  /* `draft-row-confirming` and `draft-row-held` let the main line wrap: the question,
                     or a held row's two acts, drop under the draft on a narrow pane instead of
                     squeezing it. An ordinary row — one control — never wraps. */
                  className={[
                    "draft-row",
                    confirming === d.id ? "draft-row-confirming" : "",
                    d.status !== "draft" || heldHere?.has(d.id) === true ? "draft-row-held" : "",
                    at === draftCount - 1 ? "draft-row-last" : "",
                  ].filter(Boolean).join(" ")}
                  data-id={d.id}
                  data-index={draftsBase + at}
                >
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
                          {t(heldSentence(d, now))}
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
                    {/* THE ROW'S CONTROLS, AT THE TRAILING EDGE. A held row (the server says
                        `unverified` or interrupted, or this browser holds a record for it) carries
                        the two acts a person can take beside Discard; while the discard question
                        is open the whole area IS the question — one sentence, Keep, Discard —
                        so the confirm lands under the finger that pressed. Escape keeps. */}
                    {confirming === d.id ? (
                      <div
                        ref={confirmRef}
                        className="draft-confirm"
                        role="alertdialog"
                        aria-label={t("discardConfirm")}
                        aria-describedby={`draft-discard-what-${d.id}`}
                        tabIndex={-1}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") { e.stopPropagation(); closeConfirm(d.id); }
                        }}
                      >
                        <p className="set-note-inline" id={`draft-discard-what-${d.id}`}>
                          {t("discardWhat")}
                        </p>
                        <div className="gate-actions">
                          <Button variant="ghost" onClick={() => closeConfirm(d.id)}>
                            {t("discardCancel")}
                          </Button>
                          <Button
                            variant="primary"
                            onClick={() => { setConfirming(null); onDiscard(d.id); }}
                          >
                            {t("discardConfirm")}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="draft-actions">
                        {d.status !== "draft" || heldHere?.has(d.id) === true ? (
                          <HeldSendResolve
                            draftId={d.id}
                            label={t(heldSentence(d, now))}
                            onResolve={onResolve}
                            onSendAgain={() => onSendAgain(d)}
                          />
                        ) : null}
                        <button
                          type="button"
                          className="draft-discard"
                          aria-expanded={false}
                          onClick={() => setConfirming(d.id)}
                        >
                          {t("discard")}
                        </button>
                      </div>
                    )}
                  </div>
                  {refusedFor === d.id ? (
                    <p className="draft-refusal" role="alert" tabIndex={-1}>
                      {t(refusal!.why === "still-sending" ? "discardStillSending" : "discardUnknownJar")}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </ListRows>
        ) : null}
        {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
        {draftCount === 0 ? (
          <ListRows ariaLabel={t("title")}>
            <div className="empty">
              <span className="glyph">✎</span>
              <b>{t("emptyTitle")}</b>
              {t("emptyHint")}
            </div>
          </ListRows>
        ) : null}
      </ListPane>
    </section>
  );
}

/**
 * WHAT A HELD ROW SAYS — the one reading, for the row's state line and the verbs' label alike. An
 * `unverified` row: the engine is still looking, or the message is not in Sent. A stale `sending`
 * row: the send was interrupted and nobody knows.
 */
function heldSentence(d: EngineDraft, now: Date): "heldChecking" | "heldNotInSent" | "heldInterrupted" {
  if (d.status === "unverified") return heldStillChecking(d, now) ? "heldChecking" : "heldNotInSent";
  if (d.status === "sending") return "heldInterrupted";
  // A plain `draft` row this browser holds by its own record: the server wrote no word, so the
  // honest sentence is the one about the window — the record is at most as old as the row.
  return heldStillChecking(d, now) ? "heldChecking" : "heldNotInSent";
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
