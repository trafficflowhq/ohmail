import { describe, expect, it } from "vitest";
import { otherOrganizerOf, type MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";

/**
 * WHO ORGANIZES THE MAILBOX A SHEET IS ABOUT, from the one derivation (`otherOrganizerOf`, self-host 0.25.22): after a
 * hand-back, a holder that stopped, or a mailbox nobody agreed to organize, NOTHING organizes it, and the sheets say
 * so in place of a filing promise; a live holder is named; this install, an unread lease and a pause claim nothing.
 *
 * MOVED WORD FOR WORD (share ohbox-1, the switch's older tests) from `nothing-organizes-head-and-sheets.test.tsx`,
 * whose other cases draw today's sender and subject-rule sheets (they leave with today's shell): these three read the
 * derivation alone, which the new parts read too.
 */

const NOW = new Date("2026-10-12T01:00:00.000Z");
const T = "2026-10-12T00:25:01.000Z";

function row(over: Partial<MailboxFacts>): MailboxFacts {
  return {
    id: "mb", address: "me@family.example", status: "connected", errorCode: null, disabledReason: null,
    syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: null, createdAt: T,
    organizerRole: "reader", organizedBy: null, organizerState: null, organizeConsentedAt: T,
    ...over,
  } as MailboxFacts;
}
const HANDED_BACK = row({ organizerReleasedAt: T });
const STOPPED = row({ organizedBy: { kind: "mobile", name: "Pixel", since: T }, organizerState: "stopped" });
const NEVER = row({ organizeConsentedAt: null });
const LIVE = row({ organizedBy: { kind: "local", name: "Studio laptop", since: T }, organizerState: "held" });
const HERE = row({ organizerRole: "organizer" });
const UNREAD = row({ organizerChecked: false });
const PARKED = row({ organizerReleasedAt: T, organizerParkedAt: T });
const ONE = new Set(["mb"]);

describe("otherOrganizerOf — the sheet's organizer, from the one derivation", () => {
  it("a hand-back, a holder that stopped and a mailbox nobody agreed to: nothing organizes it", () => {
    for (const r of [HANDED_BACK, STOPPED, NEVER]) expect(otherOrganizerOf([r], ONE)).toEqual({ name: null, nobody: true });
  });

  it("CONTROL: a live holder is named; this install, an unread lease and a pause claim nothing", () => {
    expect(otherOrganizerOf([LIVE], ONE)).toEqual({ name: "Studio laptop", nobody: false });
    for (const r of [HERE, UNREAD, PARKED]) expect(otherOrganizerOf([r], ONE)).toBeUndefined();
    expect(otherOrganizerOf([HANDED_BACK], new Set(["another"])), "a mailbox the subject is not in").toBeUndefined();
  });

  it("a live holder on one of the subject's mailboxes outranks one nothing organizes", () => {
    expect(otherOrganizerOf([HANDED_BACK, { ...LIVE, id: "mb2" }], new Set(["mb", "mb2"])))
      .toEqual({ name: "Studio laptop", nobody: false });
  });
});
