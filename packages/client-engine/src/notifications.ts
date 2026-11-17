/**
 * THE NOTIFICATION GATE: one decision, shared by every surface that draws a notice. It owns no
 * platform and writes no sentence: it answers closed words and whole numbers, and each surface
 * draws them in its own words. There is no event to read: a push wake is a closed constant, so the
 * device syncs and two samples are compared. A sample holds counts and ids, so nothing of a letter
 * can reach a notice from here: no sender, no subject, no body, under any stored choice.
 */

import type { NoticeChoices } from "./notices/choices.js";
import { MAIL_NOTICE_KINDS, noticeCount, type MailNoticeKind, type Notice, type NoticeKind } from "./notices/kinds.js";
import type { NoticeGate, NoticePermission } from "./notices/gate.js";

export type { NoticePermission };

/** Mail's four kinds, under the names this door has always handed them out by: one list, kept in `notices/kinds.ts`. */
export type NoticeEvent = MailNoticeKind;

/** Every mail kind, in the order the Settings pane lists them. */
export const NOTICE_EVENTS: readonly NoticeEvent[] = MAIL_NOTICE_KINDS;

/**
 * The events some surface can actually deliver today — a statement about
 * which emitters exist, not a preference or a roadmap. The Settings pane
 * offers a switch only for an event whose position changes something. Only
 * `ohbox` qualifies at present (the desktop's unread sink, the browser
 * service worker's closed-window case); screener, scheduled and pairing are
 * modelled by {@link decideNotices} but reach no emitter, so their switches
 * are withheld. A census over the emitters' own source keeps this list
 * honest in both directions.
 */
export const DELIVERABLE_EVENTS: readonly NoticeEvent[] = ["ohbox"] as const;

/**
 * Mail's stored record, as this device has always kept it. The operating system's permission is
 * not in it: that is a fact about one device.
 *
 * `showSenderAndSubject` is a member older installs stored. Nothing reads it: no notice has a
 * place for a sender or a subject. It stays in this type only until the pane's row that still
 * writes it is gone.
 */
export interface NotificationChannels {
  /** The master. Off ⇒ nothing is drawn, whatever the four below say. */
  master: boolean;
  ohbox: boolean;
  screener: boolean;
  scheduled: boolean;
  pairing: boolean;
  /** Stored by older installs; read by nothing. */
  showSenderAndSubject: boolean;
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
  showSenderAndSubject: false,
};

/**
 * The gate. Everything that draws a notice comes through here. The two refusals come first
 * because both are absolute: a platform that has not granted is not something a switch can
 * override, and the master is not something a kind can. Then the seeding sample: nothing is an
 * event until there is something to compare against. Ignoring an empty answer draws nothing,
 * which is the right way to fail for a feature whose fault is interrupting people.
 */
export const decideNotices: NoticeGate = (before, after, choices, permission, carries) => {
  if (permission !== "granted") return [];
  if (choices.master !== true) return [];
  if (before === null) return [];
  const may = (kind: NoticeKind): boolean => choices[kind] === true && carries.includes(kind);
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

  // A device joined or left the account. Drawn only where both samples know the number.
  const had = before.devices;
  const has = after.devices;
  if (may("pairing") && Number.isInteger(had) && Number.isInteger(has) && has !== had) {
    out.push({ kind: "pairing", change: has! > had! ? "paired" : "revoked", device: null });
  }

  return out;
};

/**
 * May this surface draw `notice` at all? The same refusals as the gate's, for a notice that no
 * comparison of two samples makes: an alert whose minute has come, the day's summary.
 */
export function mayPost(
  notice: Notice, choices: NoticeChoices, permission: NoticePermission, carries: readonly NoticeKind[],
): boolean {
  return permission === "granted" && choices.master === true && choices[notice.kind] === true && carries.includes(notice.kind);
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
