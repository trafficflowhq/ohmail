/**
 * FIX-022 — the strip's verdict has one settled source. Measured on the shipped 0.21.0 desktop: many
 * minutes into a session the engine drained every two minutes, and the strip read "Sync failed.
 * Retrying." because the WINDOW's own drain rejected on every attempt (a `RangeError` out of the
 * settle's prune) — a failure that reached no log and named no mailbox. Three pins: the window's
 * streak is reported through the engine and never renders as "Sync failed"; a mailbox the door
 * marks failing outranks the window's own trouble and is named; the sentence clears when the
 * window's drain lands again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MemoryMirrorStore, OhmailEngine,
  type EngineAdapter, type MutationOutcome, type SyncResponse, type WindowSyncFailure,
} from "@ohmail/client-engine";
import { startSyncScheduler, SYNC_FAILURE_STREAK, type SyncStatus } from "@ohmail/app-logic/session/sync-scheduler";
import { deriveMailState, type MailStateInputs, type MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { seedGrowth } from "@ohmail/app-logic/mail-state/mail-state";
import en from "../messages/en.json";
import de from "../messages/de.json";

const NOW = Date.parse("2026-09-21T07:22:58.000Z");
const FREEZE_READ_MS = 33 * 60_000;

function throwingThenHealingAdapter(): EngineAdapter & { heal(): void; calls: number } {
  const self = {
    calls: 0,
    healed: false,
    heal(): void { self.healed = true; },
    sync: async (p: { since: string }): Promise<SyncResponse> => {
      self.calls += 1;
      if (!self.healed) throw new RangeError("Maximum call stack size exceeded");
      return {
        changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: p.since,
        hasMore: false, serverTime: new Date(Date.now()).toISOString(),
      };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    reportSyncFailure: async (r: WindowSyncFailure): Promise<void> => { reports.push(r); },
  };
  return self as unknown as EngineAdapter & { heal(): void; calls: number };
}
const reports: WindowSyncFailure[] = [];

function fakeVisibility() {
  return {
    visibilityState: "visible" as DocumentVisibilityState,
    addEventListener(): void {}, removeEventListener(): void {},
  };
}
function fakeOnline() { return { addEventListener(): void {}, removeEventListener(): void {} }; }

const mailbox = (over: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb1", address: "one@example.test", status: "connected", errorCode: null, disabledReason: null,
  syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: new Date(NOW - 30_000).toISOString(),
  initialImportCompletedAt: new Date(NOW - 60_000).toISOString(), createdAt: new Date(NOW - 120_000).toISOString(),
  ...over,
});
const inputs = (sync: SyncStatus, mailboxes: MailboxFacts[] | null): MailStateInputs => ({
  sync, failureStreak: SYNC_FAILURE_STREAK, mailboxes, mirrored: 10_000, pulled: 10_000,
  growth: seedGrowth(10_000),
  freshness: { state: "current", asOf: new Date(NOW - 30_000).toISOString() },
  engineFreshness: { state: "current", asOf: new Date(NOW - 30_000).toISOString() },
  now: NOW, demo: false,
});

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); reports.length = 0; });
afterEach(() => { vi.useRealTimers(); });

describe("the freeze's 33-minute shape", () => {
  it("a window whose every drain rejects reports each failure through the engine, never says 'Sync failed', and clears when a drain lands", async () => {
    const adapter = throwingThenHealingAdapter();
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore() });
    const published: SyncStatus[] = [];
    const stop = startSyncScheduler(engine, {
      onStatus: (s) => published.push(s), report: () => {},
      random: () => 0.5, visibility: fakeVisibility(), online: fakeOnline(),
    });

    await vi.advanceTimersByTimeAsync(FREEZE_READ_MS);
    const at33 = published[published.length - 1]!;
    expect(adapter.calls, "the loop kept retrying for the whole window").toBeGreaterThan(SYNC_FAILURE_STREAK);
    expect(at33.failures, "the streak stands at the read").toBeGreaterThanOrEqual(SYNC_FAILURE_STREAK);
    // (a) every counted failure reached the door as a content-free record naming the class.
    expect(reports.length).toBe(adapter.calls);
    expect(new Set(reports.map((r) => r.errorClass))).toEqual(new Set(["RangeError"]));
    // The spread past the argument ceiling is named as such, apart from the other window faults.
    expect(new Set(reports.map((r) => r.reason))).toEqual(new Set(["stack_ceiling"]));
    expect(reports.map((r) => r.attempt)).toEqual(reports.map((_r, i) => i + 1));
    // (b) the ladder renders the WINDOW's arm and its sentence is about refreshing, in both languages.
    const state = deriveMailState(inputs(at33, [mailbox()]));
    expect(state.key).toBe("failing");
    for (const cat of [en, de]) {
      const sentence = (cat as { sync: { failing: string } }).sync.failing;
      expect(sentence).not.toMatch(/Sync failed|Synchronisierung fehlgeschlagen/);
      expect(sentence.length).toBeGreaterThan(0);
    }
    // (c) one landed drain clears the count — and with it the arm.
    adapter.heal();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const after = published[published.length - 1]!;
    expect(after.failures).toBe(0);
    expect(deriveMailState(inputs(after, [mailbox()])).key).not.toBe("failing");
    stop();
  });
});

describe("one settled source for 'Sync failed'", () => {
  const streak: SyncStatus = { bootstrapping: false, failures: SYNC_FAILURE_STREAK, terminal: false, refused: false, ownerLost: false };
  it("a mailbox the door marks failing outranks the window's own streak, and is named", () => {
    const failing = mailbox({ id: "mb2", address: "two@example.test", status: "error", errorCode: "connect" });
    const state = deriveMailState(inputs(streak, [mailbox(), failing]));
    expect(state.key).toBe("mailboxError");
    expect(state.address).toBe("two@example.test");
    expect(state.errorCode).toBe("connect");
  });
  it("with every mailbox healthy the window's streak renders its own arm", () => {
    expect(deriveMailState(inputs(streak, [mailbox(), mailbox({ id: "mb2", address: "two@example.test" })])).key).toBe("failing");
  });
  it("the mailbox verdict clears when that mailbox's facts clear, whatever the window's count says", () => {
    const healed = mailbox({ id: "mb2", address: "two@example.test" });
    expect(deriveMailState(inputs(streak, [mailbox(), healed])).key).toBe("failing");
    const settled: SyncStatus = { ...streak, failures: 0 };
    expect(deriveMailState(inputs(settled, [mailbox(), healed])).key).not.toBe("mailboxError");
  });
  it("'Sync failed' lives only under the mailbox verdicts in both catalogues", () => {
    for (const [cat, needle] of [[en, /Sync failed/], [de, /Synchronisierung .*fehlgeschlagen/]] as const) {
      const sync = (cat as { sync: Record<string, string> }).sync;
      for (const [k, v] of Object.entries(sync)) expect(v, `sync.${k}`).not.toMatch(needle);
      const mailboxes = (cat as { mailboxes: Record<string, string> }).mailboxes;
      expect(Object.entries(mailboxes).filter(([k, v]) => k.startsWith("err_") && needle.test(v)).length).toBeGreaterThan(0);
    }
  });
});
