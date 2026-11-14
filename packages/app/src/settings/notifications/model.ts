/**
 * Notifications' model. The shell builds it from this device's stored choices, the platform's answer and the
 * last reconcile of the wake registration (`notification-settings.ts`); the pane reaches none of them.
 */
import type { NoticePermission, NotificationChannels } from "@ohmail/client-engine";

export type { NoticePermission, NotificationChannels };

/** The three answers of a reconcile a person can act on; the ordinary ones are no state. */
export type DeliveryNote = "no_server_key" | "row_remains" | "not_registered";

export interface NotificationsModel {
  /** This device's stored choices. */
  readonly channels: NotificationChannels;
  /** The platform's own answer. */
  readonly permission: NoticePermission;
  /** The master is on and the platform draws: only then do the events' switches mean anything. */
  readonly live: boolean;
  /** The events something can deliver now; the others have no switch. */
  readonly deliverable: readonly string[];
  /** The platform, not this window, holds the permission (the desktop): the switch only decides whether ohmail asks. */
  readonly osHolds: boolean;
  /** What the last reconcile said, when it said something a person can act on. */
  readonly delivery: DeliveryNote | null;
  /** The master's press: the only one that may ask the platform, from the person's own gesture. */
  pressMaster(want: boolean): void;
  set(next: NotificationChannels): void;
}

/** The four real events in the order the pane lists them, with their words in `settings`. */
export const NOTIFY_ROWS = [
  { key: "ohbox", label: "notifyOhbox", why: "notifyOhboxWhy" },
  { key: "screener", label: "notifyScreener", why: "notifyScreenerWhy" },
  { key: "scheduled", label: "notifyScheduled", why: "notifyScheduledWhy" },
  { key: "pairing", label: "notifyPairing", why: "notifyPairingWhy" },
] as const;

/** The sentence for a reconcile's answer, a key in `settings`. */
export const DELIVERY_SENTENCE: Readonly<Record<DeliveryNote, string>> = {
  no_server_key: "notifyNoServerKey",
  row_remains: "notifyRowRemains",
  not_registered: "notifyNotRegistered",
};
