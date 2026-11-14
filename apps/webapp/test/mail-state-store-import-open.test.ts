import { describe, expect, it } from "vitest";
import {
  deriveMailState,
  growthStep,
  seedGrowth,
  type MailStateInputs,
  type MailboxFacts,
} from "@ohmail/app-logic/mail-state/mail-state";

/**
 * `storeImportOpen` IS THE ACCOUNT'S OWN IMPORT FLOOR AND NOTHING ELSE. The Screener's queue is the
 * store's answer, so this mirror growing, or this window's first drain, says nothing about it; the
 * account's own first import still open does. Unknown mailbox facts read as `owed`.
 */

const NOW = Date.parse("2026-10-01T09:00:00.000Z");
const mailbox = (over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb1", address: "box@example.test", status: "connected", errorCode: null, disabledReason: null,
  syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: new Date(NOW - 30_000).toISOString(),
  initialImportCompletedAt: new Date(NOW - 30_000).toISOString(), createdAt: new Date(NOW - 60_000).toISOString(),
  ...over,
});
const inputs = (over: Partial<MailStateInputs> = {}): MailStateInputs => ({
  sync: { bootstrapping: false, failures: 0, terminal: false, refused: false, ownerLost: false },
  failureStreak: 3, mailboxes: [mailbox()], mirrored: 40, pulled: 40, growth: seedGrowth(40),
  freshness: { state: "current", asOf: new Date(NOW - 30_000).toISOString() },
  engineFreshness: { state: "current", asOf: new Date(NOW - 30_000).toISOString() },
  now: NOW, demo: false, ...over,
});

/** A mirror rising now — the growth episode `owed` reads. */
function rising(): ReturnType<typeof seedGrowth> {
  let g = seedGrowth(0);
  g = growthStep(g, 400, NOW - 8_000);
  return growthStep(g, 900, NOW);
}

describe("storeImportOpen", () => {
  it("this device importing and its first drain open leave a stamped account's floor closed", () => {
    const s = deriveMailState(inputs({
      sync: { bootstrapping: true, failures: 0, terminal: false, refused: false, ownerLost: false },
      growth: rising(), mirrored: 900, pulled: 900,
    }));
    expect(s.owed, "the fixture does not owe").toBe(true);
    expect(s.storeImportOpen).toBe(false);
  });

  it("an account whose first import is open reads open", () => {
    const s = deriveMailState(inputs({ mailboxes: [mailbox({ initialImportCompletedAt: null })] }));
    expect(s.storeImportOpen).toBe(true);
  });

  it("the floor speaks for itself when the strip says something else (a filing backlog)", () => {
    const s = deriveMailState(inputs({ mailboxes: [mailbox({ initialImportCompletedAt: null, pendingMoves: 3 })] }));
    expect([s.key, s.owed], "the fixture is not the filing arm").toEqual(["filing", false]);
    expect(s.storeImportOpen).toBe(true);
  });

  it("only a connected mailbox's floor counts", () => {
    const s = deriveMailState(inputs({ mailboxes: [mailbox({ initialImportCompletedAt: null, status: "disabled" })] }));
    expect(s.storeImportOpen).toBe(false);
  });

  it("unknown mailbox facts read as owed, the reading the list had", () => {
    const owing = deriveMailState(inputs({
      mailboxes: null,
      sync: { bootstrapping: true, failures: 0, terminal: false, refused: false, ownerLost: false },
    }));
    expect([owing.owed, owing.storeImportOpen]).toEqual([true, true]);
    const resting = deriveMailState(inputs({ mailboxes: null }));
    expect([resting.owed, resting.storeImportOpen]).toEqual([false, false]);
  });

  it("a fixture world has no account import", () => {
    expect(deriveMailState(inputs({ demo: true, mailboxes: [mailbox({ initialImportCompletedAt: null })] })).storeImportOpen).toBe(false);
  });
});
