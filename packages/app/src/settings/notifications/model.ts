/**
 * Notifications' model. The shell builds it from this device's stored choices, the platform's answer and the
 * last reconcile of the wake registration (`notification-settings.ts`); the pane reaches none of them.
 */
import type {
  MailNoticeKind,
  NoticeKind,
  NoticePermission,
  NotificationChannels,
} from "@ohmail/client-engine";

export type { NoticeKind, NoticePermission, NotificationChannels };

/** Results worth showing in the pane. A successful reconcile clears a prior note. */
export type DeliveryNote = "no_server_key" | "row_remains" | "not_registered" | "unsupported";

export interface NotificationsModel {
  /** This device's stored choices. */
  readonly channels: NotificationChannels;
  /** The platform's own answer. */
  readonly permission: NoticePermission;
  /** The master is on and the platform draws: only then do the events' switches mean anything. */
  readonly live: boolean;
  /** The kinds this surface's emitter draws (its `carries`); every other kind has no switch. None where it draws none. */
  readonly carries: readonly NoticeKind[];
  /** The platform, not this window, holds the permission (the desktop): the switch only decides whether ohmail asks. */
  readonly osHolds: boolean;
  /** What the last reconcile said, when it said something a person can act on. */
  readonly delivery: DeliveryNote | null;
  /** The master's press: the only one that may ask the platform, from the person's own gesture. */
  pressMaster(want: boolean): void;
  set(next: NotificationChannels): void;
}

/** Mail's four kinds in the order the pane lists them, with their words in `settings`. */
export const NOTIFY_ROWS: readonly {
  readonly key: MailNoticeKind;
  readonly label: string;
  readonly why: string;
}[] = [
  { key: "ohbox", label: "notifyOhbox", why: "notifyOhboxWhy" },
  { key: "screener", label: "notifyScreener", why: "notifyScreenerWhy" },
  { key: "scheduled", label: "notifyScheduled", why: "notifyScheduledWhy" },
  { key: "pairing", label: "notifyPairing", why: "notifyPairingWhy" },
];

/** The sentence for a reconcile's answer, a key in `settings`. */
export const DELIVERY_SENTENCE: Readonly<Record<DeliveryNote, string>> = {
  no_server_key: "notifyNoServerKey",
  row_remains: "notifyRowRemains",
  not_registered: "notifyNotRegistered",
  unsupported: "notifyWakeUnsupported",
};
