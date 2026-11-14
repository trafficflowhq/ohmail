/**
 * THE NOTIFICATION GATE: one decision, shared by every surface that draws a notice. It owns no
 * platform and writes no sentence: it answers closed words and whole numbers, and each surface
 * draws them in its own words. There is no event to read: a push wake is a closed constant, so the
 * device syncs and two samples are compared. A sample holds counts and ids, so nothing of a letter
 * can reach a notice from here: no sender, no subject, no body, under any stored choice.
 */

import type { NoticeChoices } from "./notices/choices.js";
import { noticeCount, type Notice, type NoticeKind } from "./notices/kinds.js";
import type { NoticeGate, NoticePermission } from "./notices/gate.js";

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
 * One function for the gate and for {@link mayPost}, so a refusal added here holds for both.
 */
function mayDraw(
  kind: NoticeKind, choices: NoticeChoices, permission: NoticePermission, carries: readonly NoticeKind[],
): boolean {
  return permission === "granted" && choices.master === true && choices[kind] === true && carries.includes(kind);
}

/**
 * The gate. Everything that draws a notice comes through here, each kind past {@link mayDraw}. The
 * seeding sample answers nothing: nothing is an event until there is something to compare against.
 * Ignoring an empty answer draws nothing, which is the right way to fail for a feature whose fault
 * is interrupting people.
 */
export const decideNotices: NoticeGate = (before, after, choices, permission, carries) => {
  if (before === null) return [];
  const may = (kind: NoticeKind): boolean => mayDraw(kind, choices, permission, carries);
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
  return mayDraw(notice.kind, choices, permission, carries);
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
