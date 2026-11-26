/**
 * THE CALENDAR'S PORT: what the calendar's views reach of one engine, and nothing else. Types only; a shell builds
 * the port beside its engine (`calendarPortOf`) and hands it in as the host's `wires.calendar`.
 *
 * A press is durable on this device when `press` resolves; what our server made of it is `verdict(key)` after
 * `flush`, and only then may a sentence be said. A view reads `events()` on every `version()` and keeps no copy.
 */
import type { CalendarSetupPort } from "./setup/port.js";
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import type {
  CalendarAct,
  CalendarProposalAct,
  CalendarSettingsWire,
  CalendarWindow,
  CalendarWriteFault,
  CalendarWriteReceipt,
} from "@ohmail/wire";

import type { CalendarRefusalWord } from "@ohmail/client-engine/calendar-writes";
export type { CalendarRefusalWord };

/** What our server made of one press. */
export type CalendarVerdict =
  | { readonly kind: "taken"; readonly write: CalendarWriteReceipt | null }
  | {
      readonly kind: "refused";
      readonly word: CalendarRefusalWord | CalendarWriteFault;
      readonly details: unknown;
    };

/** A span of the device's mirror that was read, in milliseconds since the epoch. */
export interface HeldSpan {
  readonly fromMs: number;
  readonly toMs: number;
}

interface HeldCalendarAct {
  readonly key: string;
  readonly deadline: number;
  readonly remainingMs: () => number;
  readonly undo: () => Promise<boolean>;
}

export interface CalendarPort {
  /** A new event's id, minted on the device. */
  newId(): string;
  /** Makes the act durable on this device under a new key. It says nothing of our server's answer. */
  press(act: CalendarAct): Promise<{ readonly key: string }>;
  /** A guest-free delete stays on this device until its Undo window expires. */
  holdDelete?(
    act: Extract<CalendarAct, { kind: "calendar_event_delete" }>,
    delay: number,
  ): Promise<HeldCalendarAct>;
  holdProposal?(act: CalendarProposalAct, delay: number): Promise<HeldCalendarAct>;
  recoveredProposals?(): readonly {
    key: string;
    act: Extract<CalendarProposalAct, { kind: "calendar_event_propose" }>;
    needsReview: boolean;
    reviewRefused?: true;
  }[];
  reviewProposal?(key: string, send: boolean): Promise<boolean>;
  pendingProposals?(): readonly { key: string; act: CalendarProposalAct }[];
  /** Resume this account's pending queue while its host is present. */
  activate?(): () => void;
  /** Sends what this device still owes; resolves when the queue has gone through once. */
  flush(): Promise<void>;
  hasOwedWrites?(): boolean;
  /** Our server's answer to the press under `key`; `null` while this device still owes it. */
  verdict(key: string): CalendarVerdict | null;
  /** Report a refusal still owed when the initial press returned. */
  watchLateRefusal?(key: string): void;
  /** Follow a locally saved draft until its provider confirms or refuses it. */
  watchCreate?(
    eventId: string,
    key: string,
    refuse: (verdict: CalendarVerdict, writeId?: string) => void,
    recorded?: () => void,
  ): void;
  /** Release the local copy of a create that was refused before reaching the provider queue. */
  forgetUnsentCreate?(eventId: string): void;
  /** Follow an edit's write on the record that holds its receipt, including a generated occurrence. */
  watchEdit?(
    eventId: string,
    key: string,
    refuse: (verdict: CalendarVerdict, writeId?: string) => void,
  ): void;
  subscribeLateRefusals?(
    report: (word: CalendarRefusalWord | CalendarWriteFault) => void,
    retire?: () => void,
  ): () => void;
  /** Each event with its waiting writes laid over, as the engine's one selector makes them. */
  events(): readonly EventWithWrites[];
  settings(): Promise<CalendarSettingsWire>;
  /** Whether the initial calendar and event data is ready for the account's switch. */
  ready?(enabledAt: string | null | undefined): boolean;
  /** Changes when the account's settings record arrives through sync. */
  settingsVersion?(): number;
  /** Change whether the account sees this suggestion, then reconcile through the mirror. */
  setSuggestionDismissed?(id: string, dismissed: boolean): Promise<void>;
  readonly setup?: CalendarSetupPort;
  /** The window our server serves, and the spans this device has read. */
  held(): { readonly window: CalendarWindow; readonly loaded: readonly HeldSpan[] };
  /** Reads a span before the served window; `none` where this shell has no way to ask for one. */
  readonly load: ((span: { readonly from: string; readonly to: string }) => Promise<boolean>) | "none";
  /** Moves whenever anything `events`, `held` or a verdict reads has moved. */
  version(): number;
  subscribe(changed: () => void): () => void;
}
