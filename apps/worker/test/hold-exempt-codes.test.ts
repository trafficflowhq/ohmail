import { describe, it, expect } from "vitest";
import { ImapBoundExceeded } from "@trafficflow/core/adapters/imap";
import type { ChangePlan } from "@trafficflow/core/mail";
import { breachSetAside, DeadLetterLedger, HOLD_EXEMPT_CODES } from "../src/dead-letter.js";
import { relearnedUnderNewEpoch } from "../src/sync.js";

/**
 * THE HOLD'S RUN AND THE PROGRESS PREDICATE, at the ledger. A
 * `mime_too_large` write-off is a bound applied to the server's bytes: the backstop's run never counts
 * it and a standing hold never refuses it, while the per-cycle cap still does. `breachSetAside` is
 * true for an overrun whose message this ledger wrote off, or for one naming no message whose folder
 * this cycle stored new mail into, re-learned a message under its new epoch in, or wrote a message
 * off from.
 */
const loc = (uid: number) => ({ folder: "INBOX", ref: `100:${uid}` });
const overrun = { code: "mime_too_large" as const, deterministic: true };
const ordinary = { code: "mime_unparseable" as const, deterministic: true };
const breachAt = (uid: number) =>
  new ImapBoundExceeded("body_overrun", 1_000, 2_000_000, "INBOX", { uidValidity: "100", uid });

describe("the hold-exempt codes", () => {
  it("the list is mime_too_large and nothing else", () => {
    expect([...HOLD_EXEMPT_CODES]).toEqual(["mime_too_large"]);
  });

  it("six overruns in one cycle: five taken, the sixth refused by the cap, taken next cycle, no hold", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    const verdicts = [1, 2, 3, 4, 5, 6].map((u) => dl.record(loc(u), overrun));
    dl.beginCycle();
    expect(verdicts).toEqual(["skip", "skip", "skip", "skip", "skip", "retry"]);
    expect(dl.record(loc(6), overrun)).toBe("skip");
    expect(dl.writeOffsHeldSince).toBeNull();
  });

  it("a standing hold refuses an ordinary write-off and admits an overrun", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    dl.hydrateRun({ count: 5, heldSince: new Date() });
    expect(dl.record(loc(7), ordinary)).toBe("retry");
    expect(dl.record(loc(8), overrun)).toBe("skip");
  });

  it("CONTROL: five ordinary write-offs hold, and an overrun after them in that cycle is refused by the cap", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    const ord = [1, 2, 3, 4, 5].map((u) => dl.record(loc(u), ordinary));
    expect(ord).toEqual(["skip", "skip", "skip", "skip", "skip"]);
    expect(dl.writeOffsHeldSince).not.toBeNull();
    expect(dl.record(loc(6), overrun)).toBe("retry");
  });

  it("revoking an overrun leaves the run alone; revoking an ordinary one gives its place back", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    for (const u of [1, 2, 3, 4]) dl.record(loc(u), ordinary);
    dl.record(loc(5), overrun);
    dl.revoke(loc(5));
    expect(dl.writeOffsHeldSince, "an overrun's revoke lowered the run").toBeNull();
    dl.beginCycle();
    dl.record(loc(6), ordinary);
    expect(dl.writeOffsHeldSince, "the fifth ordinary write-off did not hold").not.toBeNull();
  });
});

describe("breachSetAside: progress is a committed set-aside", () => {
  it("true for the breach whose message this ledger wrote off", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    expect(dl.record(loc(3), overrun)).toBe("skip");
    expect(breachSetAside(breachAt(3), dl)).toBe(true);
  });

  it("false for a row an EARLIER cycle wrote: a re-read of an older set-aside is no progress", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    expect(dl.record(loc(3), overrun)).toBe("skip");
    dl.beginCycle();
    expect(dl.record(loc(3), overrun), "the row was not already written off").toBe("skip");
    expect(dl.has("INBOX", "100", 3)).toBe(true);
    expect(breachSetAside(breachAt(3), dl)).toBe(false);
  });

  it("false when the cap refused the set-aside, so the row was never written", () => {
    const dl = new DeadLetterLedger({ holdAtCap: false });
    dl.beginCycle();
    for (const u of [1, 2, 3, 4, 5]) dl.record(loc(u), ordinary);
    expect(dl.record(loc(6), overrun)).toBe("retry");
    expect(breachSetAside(breachAt(6), dl)).toBe(false);
  });

  it("false when the row write failed and the decision was revoked", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    dl.record(loc(3), overrun);
    dl.revoke(loc(3));
    expect(breachSetAside(breachAt(3), dl)).toBe(false);
  });

  it("false for a batch-total breach that names no message, another bound, or another message", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    dl.record(loc(3), overrun);
    expect(breachSetAside(new ImapBoundExceeded("body_overrun", 1_000, 2_000_000, "INBOX"), dl)).toBe(false);
    expect(breachSetAside(new ImapBoundExceeded("read_deadline", 1_000, 2_000, "INBOX", { uidValidity: "100", uid: 3 }), dl)).toBe(false);
    expect(breachSetAside(breachAt(4), dl)).toBe(false);
    expect(breachSetAside(new Error("socket said something odd"), dl)).toBe(false);
    expect(breachSetAside(breachAt(3), undefined)).toBe(false);
  });
});

describe("breachSetAside: a batch total that names no message is progress when its folder moved", () => {
  const total = (folder?: string) => new ImapBoundExceeded("body_overrun", 1_048_576, 1_200_000, folder);

  it("true when this cycle stored new mail into, or wrote a message off from, the breach's folder", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    dl.noteProgressIn("INBOX");
    expect(breachSetAside(total("INBOX"), dl)).toBe(true);
  });

  it("false for another folder's progress, for a breach naming no folder, and for no progress", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    expect(breachSetAside(total("INBOX"), dl)).toBe(false);
    dl.noteProgressIn("ohmail/News");
    expect(breachSetAside(total("INBOX"), dl)).toBe(false);
    expect(breachSetAside(total(undefined), dl)).toBe(false);
    expect(breachSetAside(new ImapBoundExceeded("read_deadline", 1_000, 2_000, "ohmail/News"), dl)).toBe(false);
  });

  it("false after the next cycle begins: an earlier cycle's progress is not this one's", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    dl.noteProgressIn("INBOX");
    dl.beginCycle();
    expect(breachSetAside(total("INBOX"), dl)).toBe(false);
  });

  it("a breach naming a message keeps its own rule: folder progress does not stand in for its write-off", () => {
    const dl = new DeadLetterLedger({ holdAtCap: true });
    dl.beginCycle();
    dl.noteProgressIn("INBOX");
    expect(breachSetAside(breachAt(4), dl)).toBe(false);
  });
});

/**
 * WHICH ALREADY-HELD MESSAGE IS PROGRESS: one re-learned under the folder's new epoch, which the
 * commit repoints, so it happens once per message. A re-observation, a second copy at the same epoch,
 * a copy elsewhere, or an epoch nobody named is not: each can come back on every pass.
 */
describe("relearnedUnderNewEpoch: a renumbered folder's re-read is progress, a re-observation is not", () => {
  const plan = (outcome: string, stored: string, arrival: string, folders: [string, string] = ["Archive", "Archive"]) => ({
    outcome,
    existing: {
      kind: outcome, messageId: "m", ownAuthored: false,
      storedLocator: { folder: folders[0], ref: stored }, arrivalLocator: { folder: folders[1], ref: arrival },
    },
  }) as unknown as ChangePlan;

  it("true for a message held under the old epoch and met under the new one", () => {
    expect(relearnedUnderNewEpoch(plan("duplicate", "300:4", "301:104"))).toBe(true);
  });

  it("false for the same message again, a second copy at the same epoch, or an epoch nobody named", () => {
    expect(relearnedUnderNewEpoch(plan("duplicate", "301:104", "301:104"))).toBe(false);
    expect(relearnedUnderNewEpoch(plan("duplicate", "301:104", "301:105"))).toBe(false);
    expect(relearnedUnderNewEpoch(plan("duplicate", "0:0", "301:104"))).toBe(false);
    expect(relearnedUnderNewEpoch(plan("duplicate", "300:4", "undefined:104"))).toBe(false);
  });

  it("false for every other outcome, a copy in another folder included", () => {
    for (const outcome of ["own_copy", "external_copy", "received_copy", "own_move", "external_move"]) {
      expect(relearnedUnderNewEpoch(plan(outcome, "300:4", "301:104", ["INBOX", "Archive"])), outcome).toBe(false);
    }
    expect(relearnedUnderNewEpoch({ outcome: "new" } as unknown as ChangePlan)).toBe(false);
  });
});
