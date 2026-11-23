/**
 * THE SETUP'S PORT: what the calendar's setup and its settings reach of our server, and nothing else. Types only. A
 * member that is `"none"` is a door this host does not have, and nothing is drawn for it.
 *
 * What a person types for a connection reaches the port once, in `connect` or `signInAgain`, and nowhere else.
 */
import type { CalendarOAuthResult } from "./steps.js";
import type { CalendarSettingsBody, CalendarSettingsWire, CalendarSyncFault } from "@ohmail/wire";

/** Every way a calendar can be connected, as our server names it. */
export const CALENDAR_WAYS = ["icloud", "caldav", "ics", "google", "microsoft"] as const;
export type CalendarWay = (typeof CALENDAR_WAYS)[number];
export type CalendarOAuthProvider = Extract<CalendarWay, "google" | "microsoft">;

export function isCalendarOAuthProvider(way: unknown): way is CalendarOAuthProvider {
  return way === "google" || way === "microsoft";
}

/** One connection asked for: iCloud's Apple Account and app password, another CalDAV server, or a subscription. */
export type ConnectAsk =
  | {
      readonly way: "icloud";
      readonly connectionId: string;
      readonly user: string;
      readonly password: string;
    }
  | {
      readonly way: "caldav";
      readonly connectionId: string;
      readonly server: string;
      readonly user: string;
      readonly password: string;
    }
  | { readonly way: "ics"; readonly connectionId: string; readonly address: string };

/** What our server made of an ask: taken (the reading follows by the feed), or refused by its shape at once. */
export type ConnectAnswer =
  { readonly kind: "taken" } | { readonly kind: "refused"; readonly fault: CalendarSyncFault };

/** A change to one calendar: shown or hidden, or its name here. */
export interface CalendarChange {
  readonly shown?: boolean;
  readonly name?: string;
}

export interface CalendarSetupPort {
  /** The ways this account may connect, as our server lists them; `[]` on any failure. */
  ways(): Promise<readonly CalendarWay[]>;
  /** True or false only after the server confirms what the account has connected. */
  hasConnections?(): Promise<boolean>;
  /**
   * One ask, once. A rejection means the ask was not sent and nothing was connected: the step says so, and a new press
   * is a new ask with a new connection id.
   */
  readonly connect: ((ask: ConnectAsk) => Promise<ConnectAnswer>) | "none";
  /** Opens the provider's sign-in, or the browser setup if the host delegates it there. */
  readonly startOAuth?: (provider: CalendarOAuthProvider) => Promise<CalendarOAuthResult | void>;
  readonly oauthInBrowser?: boolean;
  /**
   * A new sign-in for the connection the ask names. A rejection means the ask was not sent and the connection is as
   * it was.
   */
  readonly signInAgain: ((ask: ConnectAsk) => Promise<ConnectAnswer>) | "none";
  readonly remove: ((connectionId: string) => Promise<void>) | "none";
  /** Reads the connection now. */
  readonly check: ((connectionId: string) => Promise<void>) | "none";
  readonly setCalendar: ((calendarId: string, change: CalendarChange) => Promise<void>) | "none";
  readonly saveSettings: ((body: CalendarSettingsBody) => Promise<CalendarSettingsWire>) | "none";
}
