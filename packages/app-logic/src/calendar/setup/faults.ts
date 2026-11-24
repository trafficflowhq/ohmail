/**
 * WHY A CONNECTION FAILED, AS A PERSON IS TOLD IT: one total record from the readers' closed list to keys of the
 * namespace `calsetup`. A new word in the wire is a compile error here before it can reach a screen unsaid. Never a
 * provider's own text.
 */
import type { CalendarSyncFault } from "@ohmail/wire";

export const CONNECT_FAULT_KEYS = {
  sign_in_refused: "fault.signInRefused",
  sign_in_incomplete: "fault.signInAgain",
  consent_needed: "fault.signInAgain",
  token_gone: "fault.signInAgain",
  forbidden: "fault.forbidden",
  not_found: "fault.notFound",
  not_a_calendar: "fault.notFound",
  ended: "fault.notFound",
  no_service: "fault.noService",
  address_invalid: "fault.addressInvalid",
  address_not_allowed: "fault.addressRefused",
  port_not_allowed: "fault.addressRefused",
  page_link_refused: "fault.addressRefused",
  redirect_invalid: "fault.addressRefused",
  too_many_redirects: "fault.addressRefused",
  host_unresolved: "fault.hostUnknown",
  host_changed: "fault.hostMoved",
  throttled: "fault.unreachable",
  unavailable: "fault.unreachable",
  timeout: "fault.unreachable",
  connection_failed: "fault.unreachable",
  provider_off: "fault.unreachable",
  too_large: "fault.unreadable",
  unreadable: "fault.unreadable",
  unsupported: "fault.unreadable",
  unknown: "fault.unknown",
} as const satisfies Readonly<Record<CalendarSyncFault, `fault.${string}`>>;

export type ConnectFaultKey = (typeof CONNECT_FAULT_KEYS)[CalendarSyncFault];

/** The key for a fault word; a word this build does not know is said as `unknown`, never as itself. */
export function connectFaultKeyOf(fault: string): ConnectFaultKey {
  return Object.hasOwn(CONNECT_FAULT_KEYS, fault)
    ? CONNECT_FAULT_KEYS[fault as CalendarSyncFault]
    : CONNECT_FAULT_KEYS.unknown;
}
