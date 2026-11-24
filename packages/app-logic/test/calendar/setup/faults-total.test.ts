/**
 * EVERY WAY A CONNECTION CAN FAIL HAS ITS SENTENCE: the wire's closed list against the setup's record, both ways, and
 * a word this build does not know is said as `unknown`, never as itself. (Each key in both catalogues: the app's
 * `calsetup/fault-sentences.test.ts`.)
 */
import { describe, expect, it } from "vitest";
import type { CalendarSyncFault } from "@ohmail/wire";
import { CONNECT_FAULT_KEYS, connectFaultKeyOf } from "../../../src/calendar/setup/index.js";

/** The wire's words, total by its type: a word added there does not compile here until it is named. */
const WIRE_WORDS: Record<CalendarSyncFault, true> = {
  sign_in_refused: true,
  sign_in_incomplete: true,
  consent_needed: true,
  forbidden: true,
  not_found: true,
  no_service: true,
  not_a_calendar: true,
  ended: true,
  token_gone: true,
  throttled: true,
  unavailable: true,
  address_invalid: true,
  address_not_allowed: true,
  port_not_allowed: true,
  host_unresolved: true,
  host_changed: true,
  too_many_redirects: true,
  redirect_invalid: true,
  page_link_refused: true,
  timeout: true,
  connection_failed: true,
  too_large: true,
  unreadable: true,
  unsupported: true,
  provider_off: true,
  unknown: true,
};

describe("the setup's fault sentences", () => {
  it("names a key for every word of the wire's list, and for no other word", () => {
    expect(Object.keys(CONNECT_FAULT_KEYS).sort()).toEqual(Object.keys(WIRE_WORDS).sort());
  });

  it("says a host the server no longer names as a move, never as a server that could not be found", () => {
    expect(connectFaultKeyOf("host_changed")).toBe("fault.hostMoved");
    expect(connectFaultKeyOf("host_unresolved")).toBe("fault.hostUnknown");
  });

  it("says a word it does not know, and a word of the object's own, as unknown", () => {
    expect(connectFaultKeyOf("sign_in_refused")).toBe("fault.signInRefused");
    expect(connectFaultKeyOf("the provider said: wrong password for mila")).toBe("fault.unknown");
    expect(connectFaultKeyOf("constructor")).toBe("fault.unknown");
    expect(connectFaultKeyOf("__proto__")).toBe("fault.unknown");
  });
});
