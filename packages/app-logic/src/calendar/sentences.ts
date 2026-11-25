/**
 * WHAT A PERSON IS TOLD, as catalogue keys in the namespace `event`: one total record per closed list, so a new word
 * in the wire is a compile error here before it can reach a screen unsaid. Never a provider's text, never a refusal's
 * `message`.
 */
import type { CalendarAct, CalendarWriteFault } from "@ohmail/wire";
import type { CalendarRefusalWord } from "./port.js";

/** Why a write did not reach the calendar, or was not carried out there: the not-saved line's reason. */
export const FAULT_KEYS = {
  sign_in_refused: "fault.signIn",
  sign_in_incomplete: "fault.signIn",
  consent_needed: "fault.signIn",
  token_gone: "fault.signIn",
  forbidden: "fault.notAllowed",
  read_only: "fault.notAllowed",
  not_found: "fault.gone",
  event_gone: "fault.gone",
  ended: "fault.gone",
  not_a_calendar: "fault.gone",
  no_service: "fault.unreachable",
  throttled: "fault.unreachable",
  unavailable: "fault.unreachable",
  timeout: "fault.unreachable",
  connection_failed: "fault.unreachable",
  provider_off: "fault.unreachable",
  host_unresolved: "fault.unreachable",
  host_changed: "fault.unreachable",
  address_invalid: "fault.unreachable",
  address_not_allowed: "fault.unreachable",
  port_not_allowed: "fault.unreachable",
  too_many_redirects: "fault.unreachable",
  redirect_invalid: "fault.unreachable",
  page_link_refused: "fault.unreachable",
  too_large: "fault.notKept",
  unreadable: "fault.notKept",
  unsupported: "fault.notKept",
  left_out: "fault.notKept",
  field_unwritable: "fault.notKept",
  invitees_unsupported: "fault.inviteesUnsupported",
  repeat_unsupported: "fault.notKept",
  move_copy_left: "fault.moveCopyLeft",
  move_unresolved: "fault.moveUnresolved",
  move_destination_unavailable: "fault.moveDestinationUnavailable",
  version_stale: "fault.stale",
  version_unknown: "fault.versionUnknown",
  earlier_refused: "fault.earlier",
  content_refused: "fault.chained",
  expired: "fault.expired",
  unknown: "fault.unknown",
} as const satisfies Readonly<Record<CalendarWriteFault, `fault.${string}`>>;

/** Our server's refusal of a press, said in the report slot after the verdict. */
export const REFUSAL_KEYS = {
  calendar_off: "refusal.off",
  calendar_read_only: "refusal.readOnly",
  calendar_writes_full: "refusal.full",
  calendar_write_left: "refusal.left",
  calendar_connection_stopped: "refusal.connection",
  validation_failed: "refusal.invalid",
  not_found: "refusal.gone",
  payload_too_large: "refusal.tooLarge",
  idempotency_replay: "refusal.replay",
  unknown: "refusal.unknown",
} as const satisfies Readonly<Record<CalendarRefusalWord, `refusal.${string}`>>;

/** A press our server took, said once in the report slot. */
export const TAKEN_KEYS = {
  calendar_event_create: "taken.create",
  calendar_event_update: "taken.update",
  calendar_event_delete: "taken.delete",
  calendar_event_move: "taken.move",
  calendar_event_answer: "taken.answer",
  calendar_write_retry: "taken.retry",
  calendar_write_dismiss: "taken.dismiss",
} as const satisfies Readonly<Record<CalendarAct["kind"], `taken.${string}`>>;

export type CalendarSentenceKey =
  | (typeof FAULT_KEYS)[keyof typeof FAULT_KEYS]
  | (typeof REFUSAL_KEYS)[keyof typeof REFUSAL_KEYS]
  | (typeof TAKEN_KEYS)[keyof typeof TAKEN_KEYS];
