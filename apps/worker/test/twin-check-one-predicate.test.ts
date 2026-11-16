import { describe, expect, it } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  CLAIM_PROTOCOL, DEFAULT_STALE_AFTER_MS, clockSkewBoundMs, decideLease, formatClaim, parseClaim,
  type ClaimRecord, type RawClaimMessage,
} from "@trafficflow/core/adapters/organizer-lease";
import { DEFAULT_PERMIT_TTL_MS, OrganizerStandDownError, assertNoLiveTwin } from "@ohmail/organizer/lease";
import { DEFAULT_POLL_INTERVAL_MS } from "../src/config.js";

/**
 * THE TWIN CHECK ASKS THE ENGINE'S ONE PREDICATE, ON THE SERVER'S CLOCK
 * (LEASE-TWIN-CHECK-OFF-PREDICATE). It kept an absolute test of its own, so a record wearing our id
 * with a 2099 heartbeat refused the operator CLIs for ever while the gate had recovered the
 * mailbox. It now parses INTERNALDATE as the gate does and asks `peekLease`'s per-holder `fresh`.
 * Mutation watched red: the verdict taken as "any holder of our id" instead of `fresh`.
 */

const OUR_ID = "ohmail-cloud:test";
const NOW = new Date("2026-09-29T00:00:00.000Z");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const FAR_FUTURE = new Date("2099-01-01T00:00:00.000Z");
const YEAR = 365 * 24 * 60 * 60 * 1000;

function raw(o: { heartbeat: Date; protocol?: number; installId?: string }): string {
  return formatClaim({
    installId: o.installId ?? OUR_ID, kind: "cloud", displayName: "ohmail Cloud",
    heartbeat: o.heartbeat, claimedAt: ago(YEAR), nonce: `n-${o.heartbeat.getTime()}`,
    authorizedAt: null, capabilities: [], ...(o.protocol !== undefined ? { protocol: o.protocol } : {}),
  });
}

const adapterOver = (messages: RawClaimMessage[]): MailboxAdapter =>
  ({ leasePeekIo: () => ({ listClaims: async () => messages }) }) as unknown as MailboxAdapter;

const verdictOf = async (messages: RawClaimMessage[], now: Date = NOW): Promise<"admits" | "refuses"> => {
  try {
    await assertNoLiveTwin({ adapter: adapterOver(messages), installId: OUR_ID, now });
    return "admits";
  } catch (err) {
    if (err instanceof OrganizerStandDownError) return "refuses";
    throw err;
  }
};

describe("the twin check reads the server's clock and the peek's own verdict", () => {
  it("a 2099 heartbeat the server stamped a year ago: no twin, the sweep may run", async () => {
    expect(await verdictOf([{ ref: 1, raw: raw({ heartbeat: FAR_FUTURE }), internalDate: ago(YEAR) }]))
      .toBe("admits");
  });

  it("a 2099 heartbeat the server stamped a second ago: a live twin, refused", async () => {
    expect(await verdictOf([{ ref: 1, raw: raw({ heartbeat: FAR_FUTURE }), internalDate: ago(1_000) }]))
      .toBe("refuses");
  });

  it("the margin: the reader a skew bound ahead, a twin stamped a TTL plus a poll ago, still refused", async () => {
    const renewed = ago(DEFAULT_PERMIT_TTL_MS + DEFAULT_POLL_INTERVAL_MS);
    const readerAhead = new Date(NOW.getTime() + clockSkewBoundMs(DEFAULT_STALE_AFTER_MS));
    expect(await verdictOf([{ ref: 1, raw: raw({ heartbeat: renewed }), internalDate: renewed }], readerAhead))
      .toBe("refuses");
  });

  it("no INTERNALDATE on the row: the believability cap decides, and 2099 is no evidence", async () => {
    expect(await verdictOf([{ ref: 1, raw: raw({ heartbeat: FAR_FUTURE }) }])).toBe("admits");
  });

  it("a live record wearing our id that this build cannot rank still refuses — the fail-safe arm", async () => {
    const stamped = ago(1_000);
    expect(await verdictOf([
      { ref: 1, raw: raw({ heartbeat: stamped, protocol: CLAIM_PROTOCOL + 1 }), internalDate: stamped },
    ])).toBe("refuses");
  });

  it("one folder, both answers: the gate admits a press over the dead-clock record, and so does the twin check", async () => {
    const messages: RawClaimMessage[] = [{ ref: 1, raw: raw({ heartbeat: FAR_FUTURE }), internalDate: ago(YEAR) }];
    const claims = messages
      .map((m) => parseClaim(m.raw, m.ref, m.internalDate ?? null))
      .filter((c): c is ClaimRecord => c !== null);
    const gate = decideLease({
      self: { installId: "this-mac", kind: "local", displayName: "This Mac", lastNonce: null },
      claims, now: NOW, takeover: { authorizedAt: NOW, intent: "takeover" },
    });
    expect(gate.verdict).toBe("organize");
    expect(await verdictOf(messages)).toBe("admits");
  });
});
