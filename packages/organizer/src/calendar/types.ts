/**
 * THE CALENDAR'S PASSES, AS THE TASKS AFTER THIS ONE MEET THEM: what a pass is handed, what it
 * answers, and the two hooks other work fills in (the writes owed to a provider, the provider's
 * notices). Types only; nothing here reads an environment, a clock or a timer, so the module moves
 * with the organizer and a desktop's engine can hand it its own providers.
 */
import type { CalEvent, ZoneSource } from "@ohmail/cal-core";
import type { CalendarProvider, CalendarProviders, Clock, Connection } from "@ohmail/cal-providers";
import type { KeyProvider, Logger, MicrosoftClientCredentials, MicrosoftClientKind } from "@trafficflow/core";
import type { CalendarPool, ConnectionDb, ConnectionKey } from "./connection.js";
import type { CalendarSyncFault } from "./words.js";

/** The names the two passes carry in the registry and in their log lines. */
export const CALENDAR_PASSES = { sync: "calendar_sync", notices: "calendar_notices" } as const;

/** One connection the roster found due: both ids from one row, and what it was when read. */
export interface DueConnection extends ConnectionKey {
  /** The stored provider word; a word this build does not serve is `provider_off`, never a dial. */
  readonly provider: string;
  readonly status: "active" | "failing";
}

/**
 * What one turn of one connection came to. Closed words and numbers only, so the whole outcome
 * may be logged: no address, id of a provider, token or title rides in it.
 *
 * - `off`: nothing was dialled and nothing decrypted (the account's calendar is off, the provider
 *   is not served here, the account is parked).
 * - `synced`: the turn ended well. `more` says a reading is still open and the connection queues again.
 * - `stopped`: a word that waits for the person (a refused sign-in, an ended subscription).
 * - `backed_off`: a word that waits for time, until `untilMs`.
 * - `halted`: the worker is stopping, or the turn's budget ran out mid-reading; nothing is lost.
 * - `superseded`: the stored sign-in changed under the turn (a reconnect, another worker's seal).
 * - `gone`: the connection is no longer there for this account (removed, erased, another status).
 */
export type CalendarSyncOutcome =
  | { readonly kind: "off"; readonly why: "calendar_off" | "provider_off" | "parked" }
  | {
    readonly kind: "synced"; readonly calendars: number; readonly pages: number;
    readonly changed: number; readonly dropped: number; readonly more: boolean;
  }
  | { readonly kind: "stopped"; readonly word: CalendarSyncFault }
  | { readonly kind: "backed_off"; readonly word: CalendarSyncFault; readonly untilMs: number }
  | { readonly kind: "halted" }
  | { readonly kind: "superseded" }
  | { readonly kind: "gone" };

/** Where a pass gets the registrations it trades a lasting sign-in with. Asked at trade time, never kept. */
export interface CalendarOAuth {
  /** Google's registration, or `null` where this deployment serves no Google calendar. */
  readonly google: { readonly clientId: string; readonly clientSecret: string } | null;
  /** The mail registration's resolver (the worker's one reader of it), asked for the door the credential was issued through. */
  readonly microsoft: ((want: MicrosoftClientKind) => Promise<MicrosoftClientCredentials>) | null;
}

/**
 * THE DRAIN OF THE WRITES OWED TO A PROVIDER, `cal-write`'s to fill. Called once a turn, after the
 * sign-in and before the calendars are read, on the turn's own bound handle and sign-in, so that a
 * write a person made reaches the provider before the reading that would otherwise undo it.
 * `nextAttemptAt` is the earliest owed write it left for later; the connection is due again by then.
 * `wait`, where the provider answered a write with a wait of its own: the turn ends there, and the
 * connection waits it out under that word, its readings too.
 */
export interface CalendarWriteDrainInput {
  readonly db: ConnectionDb;
  readonly key: ConnectionKey;
  readonly provider: CalendarProvider;
  /** The port's connection for this turn: its sign-in is the turn's, and is gone when the turn is. */
  readonly connection: Connection;
  readonly signal: AbortSignal;
}
/** A provider's own wish to be left alone, as it answered a write: its word, and how long. */
export interface CalendarWriteWait {
  readonly word: CalendarSyncFault;
  readonly retryAfterMs: number;
}
export type CalendarWriteDrain = (input: CalendarWriteDrainInput) => Promise<{ readonly nextAttemptAt: Date | null; readonly wait?: CalendarWriteWait }>;

/**
 * THE PROVIDER'S NOTICES, `notices`' to fill: after a turn that ended well, open or renew the
 * provider's channel for each calendar that has none alive. `live` says a channel stands for every
 * one of them, which stretches the polling floor. With no public address for notices it is not composed.
 */
export interface CalendarNoticeInput {
  readonly db: ConnectionDb;
  readonly key: ConnectionKey;
  readonly provider: CalendarProvider;
  readonly connection: Connection;
  readonly calendars: readonly { readonly id: string; readonly providerId: string }[];
  readonly signal: AbortSignal;
}
export type CalendarNoticeHook = (input: CalendarNoticeInput) => Promise<{ readonly live: boolean }>;

/**
 * A reading still open, in this process only: where its next page starts and what its pages named.
 * Nothing of it is durable. A crash, a restart or a connection that has to wait discards it whole,
 * and the next turn reads again from the token the calendar row keeps, which moves only when a
 * reading ends.
 */
export interface OpenReading {
  /** The connection it is read for: one that waits, or that the roster no longer hands over, gives up the places its readings hold. */
  readonly connectionId: string;
  /** The stored token this reading started from, or `null`; a reading is only resumed from the same one. */
  readonly since: string | null;
  /** The `more` cursor of the next page, or `null` before the first. */
  cursor: string | null;
  mode: "delta" | "whole" | null;
  /** The database's own `now()` when the reading began: a row written after it is never dropped. */
  readonly startedAt: Date;
  /** Digests of every id a page of this reading named, as an upsert, a `gone` or a `left`. */
  readonly named: Set<bigint>;
  /** Changed days cancelled by a page before their series was stored, applied at the reading's end. */
  readonly heldCancellations: { readonly uid: string; readonly key: string; readonly time: import("@ohmail/cal-core").EventTime }[];
  /** Microsoft: the window asked for, the days its pages showed, and the series they carried. */
  readonly window: { readonly start: number; readonly end: number } | null;
  readonly seen: Map<string, Set<string>>;
  readonly masters: Map<string, CalEvent>;
  pages: number;
  changed: number;
  /** A `gone` named a day of a series (Microsoft: an id nobody stores, or a changed day's own): the window is read whole again. */
  unknownGone: boolean;
  /** Something in this reading could not be compared or kept, so nothing is dropped at its end. */
  noDrop: boolean;
  /** A page left a record out: what this reading did not show may be there all the same, so no day is called cancelled for its silence. */
  leftOut: boolean;
}

/** Everything a pass is handed. One object per worker; `memory` is the only thing it keeps. */
export interface CalendarSyncDeps {
  /** The pool, opaque: a pass reaches it through `passDb` alone (the binder's line), the roster through its one read. */
  readonly db: CalendarPool;
  readonly providers: CalendarProviders;
  readonly keys: KeyProvider;
  readonly clock: Clock;
  /** The program's ONE zone source, the same the providers were made with. */
  readonly zones: ZoneSource;
  /** A number in [0, 1), for the spread of a subscription's asks. */
  readonly random: () => number;
  readonly oauth: CalendarOAuth;
  readonly memory: CalendarSyncMemory;
  /** The worker is stopping: asked before every page and every transaction. */
  readonly halted: () => boolean;
  readonly log: Logger;
  readonly drainWrites?: CalendarWriteDrain;
  readonly notices?: CalendarNoticeHook;
  /** Pages and wall time one turn may take before the connection queues again behind the others. */
  readonly turn?: { readonly pages: number; readonly ms: number };
}

/** The process's memory of the calendar's passes. Bounded; a lost entry costs a reading, never a row. */
export interface CalendarSyncMemory {
  /** Readings kept from one turn to the next, by calendar row id; at most `MAX_OPEN_READINGS`, and none given up for another. */
  readonly readings: Map<string, OpenReading>;
  /** Calendars whose last reading needed a place and found none: they begin again only when one is free. */
  readonly crowded: Map<string, true>;
  /** Failures in a row by connection id (the connection's backoff), and by calendar id. */
  readonly failures: Map<string, number>;
  /** When a connection's calendars were last listed, epoch ms. */
  readonly listedAt: Map<string, number>;
  /** Calendar row ids one listing did not name; removed when the next one does not either. */
  readonly unlisted: Map<string, ReadonlySet<string>>;
  /** When a calendar was last forced to read its window whole again (Microsoft's unknown `gone`), epoch ms. */
  readonly forcedAt: Map<string, number>;
  /** Calendars whose last whole reading would have dropped most of what is stored; the second one drops. */
  readonly massDrop: Map<string, true>;
}
