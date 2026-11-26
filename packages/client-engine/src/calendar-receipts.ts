import type { Assert, CalendarReason, CalendarWriteFault, Complete } from "@ohmail/wire";

const CALENDAR_REASONS = [
  "calendar_off", "calendar_read_only", "calendar_writes_full", "calendar_write_left",
  "calendar_connection_stopped",
] as const satisfies readonly CalendarReason[];
type _RouteWords = Assert<Complete<CalendarReason, typeof CALENDAR_REASONS>>;

const ROUTE_WORDS = [
  ...CALENDAR_REASONS, "validation_failed", "not_found", "payload_too_large",
  "idempotency_replay", "unknown",
] as const;
export type CalendarRefusalWord = (typeof ROUTE_WORDS)[number];

const WRITE_WORDS = [
  "sign_in_refused", "sign_in_incomplete", "consent_needed", "forbidden", "not_found",
  "no_service", "not_a_calendar", "ended", "token_gone", "throttled", "unavailable",
  "address_invalid", "address_not_allowed", "port_not_allowed", "host_unresolved", "host_changed",
  "too_many_redirects", "redirect_invalid", "page_link_refused", "timeout", "connection_failed",
  "too_large", "unreadable", "unsupported", "provider_off", "unknown", "version_stale",
  "version_unknown", "event_gone", "read_only", "left_out", "invitees_unsupported",
  "repeat_unsupported", "field_unwritable", "earlier_refused", "content_refused", "expired", "answer_unconfirmed", "move_copy_left", "move_unresolved", "move_destination_unavailable",
] as const satisfies readonly CalendarWriteFault[];
type _WriteWords = Assert<Complete<CalendarWriteFault, typeof WRITE_WORDS>>;

function wordOf<T extends string>(words: readonly T[], value: unknown): T | "unknown" {
  return words.find((word) => word === value) ?? "unknown";
}

export const calendarReasonOf = (value: unknown) => wordOf(CALENDAR_REASONS, value);
export const refusalWordOf = (value: unknown) => wordOf(ROUTE_WORDS, value);
export const writeFaultOf = (value: unknown) => wordOf(WRITE_WORDS, value);

export type CalendarResult =
  | { readonly kind: "taken" }
  | { readonly kind: "refused"; readonly word: CalendarRefusalWord | CalendarWriteFault };

/** One terminal result, indexed by the pending write's original key in the account mirror. */
export interface CalendarSettlement {
  readonly expiresAt: number;
  readonly reference: { readonly type: "event" | "write"; readonly id: string };
  readonly result: CalendarResult;
}

export function calendarSettlementExpiry(entity: unknown): number {
  const expiresAt = (entity as Partial<CalendarSettlement> | null)?.expiresAt;
  return typeof expiresAt === "number" && Number.isFinite(expiresAt) ? expiresAt : 0;
}
