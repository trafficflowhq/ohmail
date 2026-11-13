/**
 * THE CALENDAR'S PORT: what the calendar's views reach of one engine, and nothing else. Types only; a shell builds
 * the port beside its engine (`calendarPortOf`) and hands it in as the host's `wires.calendar`.
 *
 * A press is durable on this device when `press` resolves; what our server made of it is `verdict(key)` after
 * `flush`, and only then may a sentence be said. A view reads `events()` on every `version()` and keeps no copy.
 */
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type {
  CalendarAct,
  CalendarReason,
  CalendarSettingsWire,
  CalendarWindow,
  CalendarWriteReceipt,
} from "@ohmail/wire";

/** Every word a refusal of our server's can carry to a person: the door's own reasons and the route's refusals. */
export type CalendarRefusalWord =
  CalendarReason | "validation_failed" | "not_found" | "payload_too_large" | "idempotency_replay" | "unknown";

/** What our server made of one press. */
export type CalendarVerdict =
  | { readonly kind: "taken"; readonly write: CalendarWriteReceipt | null }
  | { readonly kind: "refused"; readonly word: CalendarRefusalWord; readonly details: unknown };

/** A span of the device's mirror that was read, in milliseconds since the epoch. */
export interface HeldSpan {
  readonly fromMs: number;
  readonly toMs: number;
}

export interface CalendarPort {
  /** A new event's id, minted on the device. */
  newId(): string;
  /** Makes the act durable on this device under a new key. It says nothing of our server's answer. */
  press(act: CalendarAct): Promise<{ readonly key: string }>;
  /** Sends what this device still owes; resolves when the queue has gone through once. */
  flush(): Promise<void>;
  /** Our server's answer to the press under `key`; `null` while this device still owes it. */
  verdict(key: string): CalendarVerdict | null;
  /** Each event with its waiting writes laid over, as the engine's one selector makes them. */
  events(): readonly EventWithWrites[];
  settings(): Promise<CalendarSettingsWire>;
  /** The window our server serves, and the spans this device has read. */
  held(): { readonly window: CalendarWindow; readonly loaded: readonly HeldSpan[] };
  /** Reads a span before the served window; `none` where this shell has no way to ask for one. */
  readonly load: ((span: { readonly from: string; readonly to: string }) => Promise<boolean>) | "none";
  /** Moves whenever anything `events`, `held` or a verdict reads has moved. */
  version(): number;
  subscribe(changed: () => void): () => void;
}
