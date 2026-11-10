import { describe, expect, it } from "vitest";
import {
  MAILBOX_DISABLED_REASONS, isMailboxDisabledReason,
  MAILBOX_SYNC_BLOCK_REASONS, isMailboxSyncBlockReason,
} from "@trafficflow/db";
import {
  decideLease, parseClaim, LeaseUnavailableError, LeaseClockSkewError,
  type ClaimRecord, type LeaseSelf, type StandDownReason,
} from "@trafficflow/core/adapters/organizer-lease";
import { leaseBlockReason, leaseRefusalIsNamed } from "../src/lease.js";

/**
 * THE TWO SPELLINGS OF ONE CLOSED SET, RECONCILED — and why there are two at all.
 *
 * `StandDownReason` lives in `packages/core` because the ENGINE produces it. `MailboxDisabledReason`
 * lives in `@trafficflow/db` because it is the domain of the column `mailboxes.disabled_reason`,
 * where a ruling put such taxonomies. They cannot be one definition: the engine tier may not
 * import the private half, and a `packages/core` import in `packages/db` would invert the
 * dependency the whole desktop split rests on.
 *
 * `apps/worker/src/lease.ts` is where they meet, and the typed assignment there is the primary
 * proof — a member on either side that the other lacks fails `tsc`. This file is the half `tsc`
 * cannot give: the DB side is a runtime array, so a value ADDED to it that no verdict can produce
 * is invisible to the compiler and would arrive in production as a reason the UI has no copy for.
 * Set equality in both directions, so neither list can grow alone.
 *
 * That ruling argued a single definition is strictly better than a guard asserting two match, and it is.
 * This is the case where a single definition is not available, and the guard is named rather than
 * implied.
 */

const SELF: LeaseSelf = { installId: "us", kind: "local", displayName: "us", lastNonce: null };
const NOW = new Date("2026-08-03T10:00:00.000Z");

/**
 * A foreign claim of the given kind, fresh as of {@link NOW} — built through `parseClaim` from
 * real header text rather than constructed as an object.
 *
 * That is not ceremony. A hand-built `OrganizerClaim` can hold a `kind` no message could ever
 * produce (`parseClaim` maps everything it does not recognise to the literal `"unknown"`), and a
 * fixture that can reach states the format cannot would test arms production never enters — the
 * first draft of this file did exactly that and asserted a verdict the real pipeline cannot
 * reach.
 */
function foreign(kind: string, protocol = 1): ClaimRecord {
  const raw = [
    "X-Ohmail-Lease: 1",
    `X-Ohmail-Organizer-Kind: ${kind}`,
    `X-Ohmail-Install-Id: them-${kind}-${protocol}`,
    `X-Ohmail-Protocol: ${protocol}`,
    `X-Ohmail-Heartbeat: ${NOW.toISOString()}`,
    `X-Ohmail-Claimed-At: ${new Date(NOW.getTime() - 60_000).toISOString()}`,
    `X-Ohmail-Display-Name: ${kind} machine`,
    "X-Ohmail-Nonce: n",
    "",
    "",
  ].join("\r\n");
  const parsed = parseClaim(raw);
  if (!parsed) throw new Error(`fixture is not a claim: ${kind}`);
  return parsed;
}

describe("the organizer stand-down reasons are ONE closed set with two spellings", () => {
  it("every reason the engine can produce is storable in the column", () => {
    // Not a hand-written list of three strings: the reasons are PRODUCED, by driving the decision
    // table into each of its refusing arms. A list would agree with itself even if `decideLease`
    // started emitting a fourth.
    const produced = new Set<StandDownReason>();
    const cases: Array<{ label: string; self: LeaseSelf; claims: ClaimRecord[] }> = [
      // A live Cloud outranks a local install for continuing coverage.
      { label: "fresh foreign cloud", self: SELF, claims: [foreign("cloud")] },
      // Local vs local: the incumbent wins and we are not it.
      { label: "fresh foreign local", self: SELF, claims: [foreign("local")] },
      // A phone. Ranked since mail 0103, so it loses the election like any other incumbent and
      // its reason names a phone — the member that arrived a release after the phone wrote it.
      { label: "fresh foreign mobile", self: SELF, claims: [foreign("mobile")] },
      // A kind we cannot rank, and a protocol from the future. Both refuse as `:unknown`.
      { label: "unrecognised kind", self: SELF, claims: [foreign("desktop-v2")] },
      { label: "protocol from the future", self: SELF, claims: [foreign("cloud", 99)] },
    ];
    for (const c of cases) {
      const verdict = decideLease({ self: c.self, claims: c.claims, now: NOW });
      expect(verdict.verdict, c.label).toBe("stand_down");
      if (verdict.verdict === "stand_down") produced.add(verdict.reason);
    }

    expect([...produced].sort()).toEqual([...MAILBOX_DISABLED_REASONS].sort());
    for (const reason of produced) expect(isMailboxDisabledReason(reason)).toBe(true);
  });

  it("the column's set gains nothing the engine cannot produce", () => {
    // The direction `tsc` cannot see. `MAILBOX_DISABLED_REASONS` is a runtime array, so a member
    // added to it compiles perfectly and reaches the database as a reason no verdict produces and
    // no UI has a sentence for. Four since mail 0103 added `mobile`.
    expect(MAILBOX_DISABLED_REASONS).toHaveLength(4);
    for (const reason of MAILBOX_DISABLED_REASONS) {
      expect(reason.startsWith("organized_elsewhere:"),
        `${reason} is not an organized_elsewhere reason — mail 0027's CHECK will refuse it`).toBe(true);
    }
  });

  it("refuses a value the column must never hold", () => {
    // The membership test is what the write site applies. A shape test would admit these, and
    // that is precisely the finding that closed `error_detail`.
    for (const bad of [
      "organized_elsewhere:desktop",              // a kind that does not exist
      "organized_elsewhere:phone",                // the word a person would guess; `mobile` is the kind
      "organized_elsewhere",                      // the prefix alone
      "ORGANIZED_ELSEWHERE:CLOUD",                // case
      "organized_elsewhere:cloud ",               // trailing space
      "SECRETPASSWORD123", "", null, undefined, 1,
    ]) {
      expect(isMailboxDisabledReason(bad), `${String(bad)} must not be storable`).toBe(false);
    }
  });
});

/**
 * ═══ A WRONG CLOCK IS NOT A FOLDER THAT COULD NOT BE READ ═════════════════════════════════
 *
 * Both refusals are `LeaseUnavailableError`, which is what keeps a wrong clock exempt from every
 * failure counter — the mailbox is not quarantined and no press is voided. What they are CALLED on
 * the row has to differ: `lease_unreadable` renders as "ohmail cannot read its own folder on that
 * server", which is false for a clock refusal and names nothing anybody can act on, while the one
 * thing a person can do about a wrong clock is set it.
 */
describe("what an unreadable lease is called on the mailbox row", () => {
  const skew = (): LeaseClockSkewError =>
    new LeaseClockSkewError("this computer's clock is 900s ahead of the mail server's", {
      skewMs: 900_000, bound: "ahead", boundMs: 150_000,
    });

  it("a clock refusal says the clock", () => {
    expect(leaseBlockReason(skew())).toBe("clock_off");
  });

  it("every OTHER lease fault keeps the answer it had — the positive control", () => {
    /* Without this the rule could be "everything is a clock problem" and the case above would
       still pass. `op` is the whole population of lease faults that are not this one. */
    for (const op of ["list_claims", "ensure_meta", "renew_claim", "no_lease_io"] as const) {
      expect(leaseBlockReason(new LeaseUnavailableError("could not look", { op })))
        .toBe("lease_unreadable");
    }
  });

  it("a folder too full to read says so — its cure is in the person's mailbox", () => {
    expect(leaseBlockReason(new LeaseUnavailableError("too full", { op: "meta_folder_full" })))
      .toBe("meta_folder_full");
    expect(MAILBOX_SYNC_BLOCK_REASONS).toContain("meta_folder_full");
    expect(isMailboxSyncBlockReason("meta_folder_full")).toBe(true);
  });

  it("a folder that takes no delete says so — the cure is a permission on it", () => {
    expect(leaseBlockReason(new LeaseUnavailableError("no delete", { op: "meta_undeletable" })))
      .toBe("meta_undeletable");
    expect(isMailboxSyncBlockReason("meta_undeletable")).toBe(true);
  });

  it("a claim refused for room says the mailbox is full; a plain refused renew still reads unreadable", () => {
    expect(leaseBlockReason(new LeaseUnavailableError("no room", { op: "mailbox_full" }))).toBe("mailbox_full");
    expect(isMailboxSyncBlockReason("mailbox_full")).toBe(true);
    expect(leaseBlockReason(new LeaseUnavailableError("refused", { op: "renew_claim" }))).toBe("lease_unreadable");
  });

  it("a named block is the server answering; only an unreadable lease may be the connection", () => {
    for (const op of ["meta_folder_full", "meta_undeletable", "clock_skew", "mailbox_full"] as const) {
      expect(leaseRefusalIsNamed(new LeaseUnavailableError(op, { op })), op).toBe(true);
    }
    expect(leaseRefusalIsNamed(new LeaseUnavailableError("socket", { op: "list_claims" }))).toBe(false);
  });

  it("and the class is still the one both hosts exempt", () => {
    /* The exemption is BY CLASS at every call site. A refusal that stopped being a
       `LeaseUnavailableError` would start quarantining mailboxes for a wrong clock. */
    expect(skew()).toBeInstanceOf(LeaseUnavailableError);
    expect(skew().op).toBe("clock_skew");
  });

  it("the member exists in the column's closed set, or the sentence is dead by construction", () => {
    /* mail 0102's rule, one member on: the copy renders only behind `isMailboxSyncBlockReason`,
       which reads this set, so a catalogue string without the member is never shown. */
    expect(MAILBOX_SYNC_BLOCK_REASONS).toContain("clock_off");
    expect(isMailboxSyncBlockReason("clock_off")).toBe(true);
  });

  it("a skew under a minute still reports a whole minute, because zero minutes says nothing", () => {
    const small = new LeaseClockSkewError("m", { skewMs: -40_000, bound: "behind", boundMs: 15_000 });
    expect(small.offByMinutes).toBe(1);
    expect(skew().offByMinutes).toBe(15);
  });
});
