/**
 * The notification gate — one decision, shared by every surface that can
 * draw a notice. It owns no platform: it returns a spec, each surface
 * renders it in its own catalogue and API, and the notifications-gate
 * census insists on one emitter per surface, all through here. Text is
 * composed on the device: a push wake is a closed fifteen-byte constant, so
 * the device syncs and compares two snapshots — there is no event. Never a
 * body or snippet; sender and subject only on a device already holding the
 * message and only when `showSenderAndSubject` is on (off by default).
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
 * What a fresh install believes: the master and the two events a person is
 * waiting for are on — an app that needs configuring before it can say mail
 * arrived is not doing the job. `scheduled` is on: a send that did not
 * happen is the one outcome silence reports wrongly. `pairing` is on because
 * a new device reaching your mailbox is a security event.
 * `showSenderAndSubject` is off: a notification is read by whoever is
 * looking at the screen, not always the person the mail was addressed to.
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
 * The gate. Everything that draws a notice comes through here. `before ===
 * null` means this surface has not sampled yet and the answer is always
 * nothing: an app opened with eleven unread messages has not just received
 * eleven — seeding, not notifying, on the first sample. Returns `[]` (never
 * throws, never partially applies a rule) when notifications are off,
 * unpermitted, or nothing happened; ignoring an empty array draws nothing,
 * the correct failure direction for a feature whose defect mode is
 * interrupting people.
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
