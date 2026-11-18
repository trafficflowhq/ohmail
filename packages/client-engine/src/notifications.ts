/**
 * THE NOTIFICATION GATE: one decision, shared by every surface that draws a notice. It owns no
 * platform and writes no sentence: it answers closed words and whole numbers, and each surface
 * draws them in its own words. There is no event to read: a push wake is a closed constant, so the
 * device syncs and two samples are compared. A sample holds counts and ids, so nothing of a letter
 * can reach a notice from here: no sender, no subject, no body, under any stored choice.
 */

import type { NoticeChoices } from "./notices/choices.js";
import { noticeCount, type Clock, type Notice, type NoticeKind } from "./notices/kinds.js";
import type { CalendarLook, CalendarSample, NoticeGate, NoticePermission } from "./notices/gate.js";
import { answeredNotice, cancelledNotice, foundNotice, invitationNotice, movedNotice } from "./notices/make.js";

export type { NoticePermission };

/**
 * Mail's stored record, as this device has always kept it. The operating system's permission is
 * not in it: that is a fact about one device. A member an older install stored beside these (the
 * switch that once showed a sender and a subject) stays in the stored record and is read by
 * nothing: no notice has a place for either.
 */
export interface NotificationChannels {
  /** The master. Off ⇒ nothing is drawn, whatever the four below say. */
  master: boolean;
  ohbox: boolean;
  screener: boolean;
  scheduled: boolean;
  pairing: boolean;
}

/**
 * What a fresh install believes: the master and the two events a person is
 * waiting for are on — an app that needs configuring before it can say mail
 * arrived is not doing the job. `scheduled` is on: a send that did not
 * happen is the one outcome silence reports wrongly. `pairing` is on because
 * a new device reaching your mailbox is a security event.
 */
export const DEFAULT_CHANNELS: NotificationChannels = {
  master: true,
  ohbox: true,
  screener: true,
  scheduled: true,
  pairing: true,
};

/**
 * The four refusals every notice passes, whatever made it: the platform has granted, the master is
 * on, the kind's own switch is on, and this surface carries the kind. The first two are absolute: a
 * switch cannot override a platform that has not granted, and a kind cannot override the master.
 * One function for the gate and for {@link mayPost}, so a refusal added here holds for both, and
 * for whoever asks before a notice exists: whether this device sets the calendar's alerts at all.
 */
export function mayDrawKind(
  kind: NoticeKind, choices: NoticeChoices, permission: NoticePermission, carries: readonly NoticeKind[],
): boolean {
  return permission === "granted" && choices.master === true && choices[kind] === true && carries.includes(kind);
}

/** Did a number that only rises rise? Both whole numbers, the later one greater; anything else is no event. */
function rose(was: number, now: number): boolean {
  return Number.isSafeInteger(was) && Number.isSafeInteger(now) && was >= 0 && now > was;
}

/**
 * The gate. Everything that draws a notice comes through here, each kind past {@link mayDraw}. The
 * seeding sample answers nothing: nothing is an event until there is something to compare against.
 * Ignoring an empty answer draws nothing, which is the right way to fail for a feature whose fault
 * is interrupting people.
 */
export const decideNotices: NoticeGate = (before, after, choices, permission, carries, look = null) => {
  if (before === null) return [];
  const may = (kind: NoticeKind): boolean => mayDrawKind(kind, choices, permission, carries);
  const out: Notice[] = [];

  // New mail in the Ohbox: a RISE only. A falling count is somebody reading their own mail.
  if (may("ohbox")) {
    const count = noticeCount(after.ohboxUnread - before.ohboxUnread);
    if (count !== null) out.push({ kind: "ohbox", count });
  }

  // A new sender is waiting: how many, never who. They are not let in yet.
  if (may("screener")) {
    const count = noticeCount(after.screenerWaiting - before.screenerWaiting);
    if (count !== null) out.push({ kind: "screener", count });
  }

  // A send that waited for its time. Gone from the unsent drafts: it went. Handed back with its
  // failure: it did not, and silence would report that as sent. A plain draft again: the person's
  // own change of mind, which is no event.
  if (may("scheduled")) {
    let sent = 0;
    let failed = 0;
    for (const [id, was] of before.sends) {
      if (was !== "waiting") continue;
      const now = after.sends.get(id);
      if (now === undefined) sent += 1;
      else if (now === "failed") failed += 1;
    }
    const went = noticeCount(sent);
    const stayed = noticeCount(failed);
    if (went !== null) out.push({ kind: "scheduled", outcome: "sent", count: went });
    if (stayed !== null) out.push({ kind: "scheduled", outcome: "failed", count: stayed });
  }

  // A named device was made, or one was taken back in Devices. Decided from the two numbers that
  // ONLY RISE, where both samples know them, and never from how many devices are signed in now:
  // that count also falls when a device signs itself out, so a sign-out followed by a pairing left
  // it where it stood and the pairing was told to nobody. Several of one kind between two samples
  // are one notice: the record has a word for what happened and no place for how often.
  // The take-back first and the new device last. A surface with one place for the kind keeps the
  // last notice it was handed, and the new device is the one a person must not miss.
  const had = before.devices;
  const has = after.devices;
  if (may("pairing") && had != null && has != null) {
    if (rose(had.revoked, has.revoked)) out.push({ kind: "pairing", change: "revoked", device: null });
    if (rose(had.made, has.made)) out.push({ kind: "pairing", change: "paired", device: null });
  }

  // What a sync turn brought the calendar, compared id by id and made only by the makers. Nothing where
  // either sample holds no calendar (a first sample of one, a surface without one) or nothing names the
  // events; a look that fails makes no calendar notice and takes nothing else down.
  const was = before.calendar ?? null;
  const now = after.calendar ?? null;
  if (was !== null && now !== null && look !== null && look !== undefined) {
    try {
      out.push(...calendarNotices(was, now, choices.showTitles, may, look));
    } catch {
      /* No calendar notice rather than a wrong one. */
    }
  }

  return out;
};

/** The answers an invitee gives that a notice names, in the order a sample counts them. */
const ANSWERS = ["yes", "maybe", "no"] as const;

/** The calendar's notices between two samples, each kind past its refusals. */
function calendarNotices(
  was: CalendarSample, now: CalendarSample, showTitles: boolean, may: (kind: NoticeKind) => boolean, look: CalendarLook,
): Notice[] {
  const out: Notice[] = [];
  const clock = (startMs: number): Clock | null => look.clock(startMs);
  const keep = (notice: Notice | null): void => {
    if (notice !== null) out.push(notice);
  };

  // An invitation waiting for the person's answer that was not waiting before: once.
  if (may("cal_invitation")) {
    for (const id of now.invitations) {
      if (was.invitations.has(id)) continue;
      const seen = look.event(id);
      const stands = now.standing.get(id);
      const at = stands === undefined ? null : clock(stands.startMs);
      if (seen !== null && at !== null) keep(invitationNotice(seen.noticed, showTitles, { at, allDay: seen.allDay }));
    }
  }

  // An event somebody else wrote that the person is in, called off or moved. One that only vanished
  // leaves nothing to name it by, and says nothing.
  if (may("cal_change")) {
    for (const [id, stands] of now.standing) {
      const stood = was.standing.get(id);
      if (stood === undefined) continue;
      const cancelled = stood.status !== "cancelled" && stands.status === "cancelled";
      const sameStart = stands.readerTime === undefined && stood.readerTime === undefined
        ? stood.startMs === stands.startMs
        : stood.readerTime?.kind === stands.readerTime?.kind && stood.readerTime?.value === stands.readerTime?.value;
      const moved = stood.status !== "cancelled" && stands.status !== "cancelled" && !sameStart;
      if (!cancelled && !moved) continue;
      const seen = look.event(id);
      const at = clock(stands.startMs);
      if (seen === null || at === null) continue;
      keep(cancelled
        ? cancelledNotice(seen.noticed, showTitles, { at, allDay: seen.allDay })
        : movedNotice(seen.noticed, showTitles, { at, was: look.clock(stood.startMs, stood.readerTime), allDay: seen.allDay }));
    }
  }

  // Invitees of the person's own event answered: each answer whose count rose, by how much. Never who.
  if (may("cal_answer")) {
    for (const [id, counts] of now.answers) {
      const had = was.answers.get(id);
      if (had === undefined) continue;
      const rises = ANSWERS.map((answer, i) => [answer, counts[i]! - had[i]!] as const).filter(([, rise]) => rise > 0);
      if (rises.length === 0) continue;
      const seen = look.event(id);
      if (seen === null) continue;
      for (const [answer, rise] of rises) keep(answeredNotice(seen.noticed, showTitles, answer, rise));
    }
  }

  // Events letters seem to propose, new since the last turn: one notice for all of them, at the first one's start.
  if (may("cal_found")) {
    const fresh = [...now.found].filter((id) => !was.found.has(id));
    if (fresh.length > 0) {
      const starts = fresh.map((id) => look.found(id)).filter((ms): ms is number => typeof ms === "number" && Number.isFinite(ms));
      keep(foundNotice(fresh, starts.length === 0 ? null : clock(Math.min(...starts))));
    }
  }

  return out;
}

/**
 * May this surface draw `notice` at all? The same refusals as the gate's, for a notice that no
 * comparison of two samples makes: an alert whose minute has come, the day's summary.
 */
export function mayPost(
  notice: Notice, choices: NoticeChoices, permission: NoticePermission, carries: readonly NoticeKind[],
): boolean {
  return mayDrawKind(notice.kind, choices, permission, carries);
}

/**
 * Are any controls worth showing, and is the master press going to trigger the OS ask?
 *
 * Exported so the Settings pane renders the OS's real answer instead of guessing from whether a
 * notice ever appeared — no switch may claim ON while the platform refuses.
 */
export function channelsAreLive(
  channels: NotificationChannels,
  permission: NoticePermission,
): boolean {
  return permission === "granted" && channels.master;
}
