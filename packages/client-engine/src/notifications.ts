/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE NOTIFICATION GATE — one decision, shared by every surface that can draw a notice
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Desktop, browser and phone all answer the same three questions before anything is drawn: is
 * this allowed, what happened, and what may the notice say. Answering them in three places would
 * mean three chances to forget the master switch — and "fully off" has to mean NO code path
 * fires, which is a property of the whole tree rather than of any one emitter.
 *
 * So this module owns the decision and owns no platform. It opens no window, imports nothing
 * from a runtime, and composes no localized string: it returns a SPEC describing what happened,
 * and each surface renders that spec in its own catalogue and its own notification API. That
 * split is what lets `notifications-gate-census` insist there is exactly one emitter per surface
 * and that each one passes through here.
 *
 * ── WHY THE TEXT IS COMPOSED ON THE DEVICE, AND CANNOT BE ANYTHING ELSE ───────────────────
 *
 * On the hosted door a notification begins as a push wake, and that wake is a closed fifteen-byte
 * constant — no subject, no sender, no count, and no account-derived value anywhere on the wire.
 * It is held that way by a census over the sender's own source, which is watched red by threading
 * a subject through it, and that census does not move. So the EVENT TYPE cannot travel either:
 * "a Screener arrival" is metadata about somebody's mail.
 *
 * The wake therefore says only "something changed". The device syncs, compares what it now holds
 * against what it held before, and decides here. Which is why this function takes two snapshots
 * and not an event: there is no event to receive.
 *
 * The happy consequence is that the shipping privacy sentence — "Notifications carry no mail
 * content — your device fetches privately" — is literally true of this code rather than a
 * promise about it. Nothing in a notice ever came off the wire as a notice.
 *
 * ── WHAT A NOTICE MAY SAY ─────────────────────────────────────────────────────────────────
 *
 * The project's stated invariants say nothing about notifications specifically, so the rule below
 * is derived from the two that bear on it — mail on a standalone install never reaches our
 * servers, and an account's mail is reachable by that account's own people and by nobody else —
 * and pinned here:
 *
 *  · never a body or a snippet, on any door, under any setting;
 *  · sender and subject only on a device that ALREADY HOLDS the message — which, after the sync
 *    above, is the only device composing anything;
 *  · and not by default. {@link NotificationChannels.showSenderAndSubject} is off out of the box,
 *    because a notification is read by whoever is looking at the screen and that is not always
 *    the mailbox's owner. {@link decideNotices} strips both fields when it is off, so a surface
 *    CANNOT render what it was not given.
 *
 * That last point is the reason stripping happens here and not in the emitters: a rule enforced
 * at the point of use is a rule three files have to remember.
 */

/** The four things worth interrupting somebody for. */
export type NoticeEvent = "ohbox" | "screener" | "scheduled" | "pairing";

/** Every event id, in the order the Settings pane lists them. */
export const NOTICE_EVENTS: readonly NoticeEvent[] = [
  "ohbox",
  "screener",
  "scheduled",
  "pairing",
] as const;

/**
 * What the operating system says about drawing notices at all.
 *
 * `unsupported` is not a failure: a platform with no notification centre is a supported place to
 * run, and the pane hides the controls rather than showing switches that cannot work.
 */
export type NoticePermission = "granted" | "denied" | "default" | "unsupported";

/**
 * The user's choices. Travels in the mailbox's organizer profile, so the same answers apply
 * behind every door — the mailbox is the master, here as everywhere else.
 *
 * The OS permission is deliberately NOT in here: that is a fact about one device, and copying it
 * into a document that syncs would let one machine's refusal silence another.
 */
export interface NotificationChannels {
  /** The master. Off ⇒ nothing is drawn, whatever the four below say. */
  master: boolean;
  ohbox: boolean;
  screener: boolean;
  scheduled: boolean;
  pairing: boolean;
  /** Opt-in, and off by default — see the content rule above. */
  showSenderAndSubject: boolean;
}

/**
 * WHAT A FRESH INSTALL BELIEVES.
 *
 * The master is ON and the two events a person is waiting for are ON, because an app that has to
 * be configured before it can tell you mail arrived is not doing the job. `scheduled` is on too:
 * a send that did NOT happen is the one outcome silence reports wrongly.
 *
 * `pairing` defaults ON because it is a security event — a new device reaching your mailbox is
 * something you want to hear about even when you did it yourself. `showSenderAndSubject` defaults
 * OFF: a notification is read by whoever is looking at the screen, and that is not always the
 * person the mail was addressed to.
 */
export const DEFAULT_CHANNELS: NotificationChannels = {
  master: true,
  ohbox: true,
  screener: true,
  scheduled: true,
  pairing: true,
  showSenderAndSubject: false,
};

/** How a scheduled send ended. `failed` carries the reason the pane already shows. */
export interface ScheduledOutcome {
  id: string;
  outcome: "sent" | "failed";
  reason?: string;
  subject?: string;
}

/** A device joining or leaving. */
export interface PairingEvent {
  id: string;
  kind: "paired" | "revoked";
  device?: string;
}

/**
 * What a surface knows at one instant. Two of these, compared, are an event.
 *
 * The counts are counts and not lists on purpose: a notice says how many things arrived, and
 * handing this function the messages themselves would put mail text in the one place that has no
 * business holding any.
 */
export interface NoticeSnapshot {
  ohboxUnread: number;
  screenerWaiting: number;
  /** Outcomes observed in this sample. Identified so a redraw cannot repeat one. */
  scheduledOutcomes?: readonly ScheduledOutcome[];
  pairingEvents?: readonly PairingEvent[];
  /** Only read when `showSenderAndSubject` is on, and only for a single new arrival. */
  latestSender?: string;
  latestSubject?: string;
}

/** What to draw. The surface localizes it; this module never composes a sentence. */
export type NoticeSpec =
  | { event: "ohbox"; count: number; sender?: string; subject?: string }
  | { event: "screener"; count: number }
  | { event: "scheduled"; outcome: "sent" | "failed"; reason?: string; subject?: string }
  | { event: "pairing"; kind: "paired" | "revoked"; device?: string };

/**
 * THE GATE. Everything that draws a notice comes through here.
 *
 * `before === null` means this surface has not sampled yet, and the answer is always nothing: an
 * app opened with eleven unread messages has not just received eleven. Seeding rather than
 * notifying on the first sample is the difference between a mail client and an alarm.
 *
 * Returns `[]` — never throws, never partially applies a rule — when notifications are off,
 * unpermitted, or nothing happened. A caller that ignores the empty array draws nothing, which
 * is the correct failure direction for a feature whose defect mode is interrupting people.
 */
export function decideNotices(
  before: NoticeSnapshot | null,
  after: NoticeSnapshot,
  channels: NotificationChannels,
  permission: NoticePermission,
): NoticeSpec[] {
  // THE TWO REFUSALS THAT COME FIRST, in this order, because both are absolute. A denied OS is
  // not something a switch can override, and the master is not something an event can.
  if (permission !== "granted") return [];
  if (!channels.master) return [];
  // The seeding sample. Nothing is an event until there is something to compare against.
  if (before === null) return [];

  const out: NoticeSpec[] = [];

  // NEW MAIL IN THE OHBOX — a RISE only. A falling count is somebody reading their own mail, and
  // notifying about mail you are looking at is the behaviour every mail client is disliked for.
  if (channels.ohbox && after.ohboxUnread > before.ohboxUnread) {
    const count = after.ohboxUnread - before.ohboxUnread;
    const spec: NoticeSpec = { event: "ohbox", count };
    // The identifying fields exist only when the user asked for them, and only for a SINGLE
    // arrival: naming one sender out of six would be picking one of them arbitrarily.
    if (channels.showSenderAndSubject && count === 1) {
      if (after.latestSender !== undefined) spec.sender = after.latestSender;
      if (after.latestSubject !== undefined) spec.subject = after.latestSubject;
    }
    out.push(spec);
  }

  // A NEW SENDER IS WAITING. Never carries a sender name even with the switch on: the Screener's
  // whole subject is mail from people you have not admitted yet, and putting an unadmitted
  // stranger's chosen display name on the lock screen is a channel they did not earn.
  if (channels.screener && after.screenerWaiting > before.screenerWaiting) {
    out.push({ event: "screener", count: after.screenerWaiting - before.screenerWaiting });
  }

  // A SCHEDULED SEND FINISHED. Both outcomes are reported — "sent" is the confirmation somebody
  // scheduled it to get, and "failed" is the one silence would report as success.
  if (channels.scheduled) {
    for (const o of after.scheduledOutcomes ?? []) {
      const spec: NoticeSpec = { event: "scheduled", outcome: o.outcome };
      if (o.reason !== undefined) spec.reason = o.reason;
      // The subject of a message the USER WROTE is theirs, but it is still mail text on a lock
      // screen, so it rides the same switch as everything else.
      if (channels.showSenderAndSubject && o.subject !== undefined) spec.subject = o.subject;
      out.push(spec);
    }
  }

  // A DEVICE PAIRED OR WAS REVOKED. A security event: the device LABEL is not mail content and
  // is not gated on the content switch — knowing which device is the point of the notice.
  if (channels.pairing) {
    for (const p of after.pairingEvents ?? []) {
      const spec: NoticeSpec = { event: "pairing", kind: p.kind };
      if (p.device !== undefined) spec.device = p.device;
      out.push(spec);
    }
  }

  return out;
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
