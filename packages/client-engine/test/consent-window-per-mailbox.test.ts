import type { EngineMessage, Folder } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, consentPartition, presentationReader, screenerSegments, screeningDegrade, widestWindowOf,
  type ConsentOptions, type MailboxScreening, type ScreeningSource, type SyncChange,
} from "@ohmail/client-engine";

/**
 * EACH MAILBOX BY ITS ORGANIZER'S WINDOW, ON THE CLIENT (RULING-026). `ConsentOptions.byMailbox`
 * judges a message by its own mailbox's window and reads no account field; a sender is waiting
 * when active in ANY mailbox; a mailbox the map does not name is admitted, as the server's `else`.
 * The rendered Waiting list is the store's queue where the store answered; with the map the
 * partition agrees with it, where the account's own fields on a reader filed a waiting sender's
 * letter in History as well.
 */

const NOW = new Date("2026-10-12T08:00:00.000Z");
const daysAgo = (d: number): string => new Date(NOW.getTime() - d * 86_400_000).toISOString();
const READ = "mb-read";
const OWN = "mb-own";
const FRESH = "fresh@sender.test";
const OLD = "old@sender.test";
let seq = 0;

function msg(id: string, mailboxId: string, from: string, date: string, unread = false, folder: Folder = "ohmail/Screener"): EngineMessage {
  return {
    id, accountId: "acct", mailboxId, threadId: null, messageIdHeader: null, subject: `s ${id}`,
    from: { name: null, address: from }, to: [], cc: [], date, folder, snippet: "",
    unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

/** The store's queue page as the engine keeps it, naming `senders` (newest first). */
function storePage(senders: Array<{ address: string; messageId: string; mailboxId: string; at: string }>): SyncChange[] {
  const total = senders.length;
  return [
    { type: "screener_waiting", op: "create", id: "page", seq: ++seq, updatedAt: NOW.toISOString(),
      entity: { id: "page", kind: "page", total, nextCursor: null, inFlight: [], ask: 1, rows: total } },
    ...senders.map((s, order) => ({
      type: "screener_waiting", op: "create", id: `sender:${s.address}`, seq: ++seq, updatedAt: NOW.toISOString(),
      entity: {
        id: `sender:${s.address}`, kind: "sender", order, messageId: s.messageId, address: s.address, name: null,
        receivedAt: s.at, subject: "s", snippet: "", mailboxId: s.mailboxId, total,
      },
    })),
  ] as SyncChange[];
}

async function mirrorOf(messages: EngineMessage[], extra: SyncChange[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m) => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...extra,
  ] as SyncChange[]);
  return store;
}

/** A `screeningByMailbox` entry as the shells hold it: the window and whose it is. */
type Entry = MailboxScreening & ScreeningSource;
const WINDOW_30: Entry = { baselineAt: daysAgo(1), dormancyDays: 30, scope: "window", source: "organizer", holderName: "Studio Mac" };
const WINDOW_365: Entry = { baselineAt: daysAgo(1), dormancyDays: 365, scope: "window", source: "own" };
const WHOLE = (source: "unread" | "unstated"): Entry =>
  ({ baselineAt: null, dormancyDays: 60, scope: "all_time", source, holderName: "Studio Mac" });

/** The account's own fields — what a reader partitioned with before the map. */
const OWN_FIELDS: ConsentOptions = { now: NOW, baselineAt: daysAgo(1), dormancyDays: 365, screeningScope: "window" };

const waitingOf = (store: MemoryMirrorStore, o: ConsentOptions): string[] => {
  const reader = store;
  const p = consentPartition(reader, o);
  return screenerSegments(presentationReader(reader, p), NOW).waiting.map((w) => w.from.address).sort();
};

describe("the partition judges each mailbox by its organizer's window", () => {
  it("the organizer's 30 days retire an old read sender this install's own 365 days would keep", async () => {
    const store = await mirrorOf([msg("f", READ, FRESH, daysAgo(2), true), msg("o", READ, OLD, daysAgo(150))]);
    const before = consentPartition(store, OWN_FIELDS);
    expect(before.activity.get(OLD)).toBe("active");
    const after = consentPartition(store, { ...OWN_FIELDS, byMailbox: { [READ]: WINDOW_30 } });
    expect(after.activity.get(OLD)).toBe("dormant");
    expect(after.history.map((m) => m.id)).toEqual(["o"]);
    expect(after.counts.activeUndecidedSenders).toBe(1);
  });

  it("mixed role: active in either mailbox is waiting; dormant in every one is History", async () => {
    const store = await mirrorOf([
      msg("a1", OWN, OLD, daysAgo(150)), msg("a2", READ, OLD, daysAgo(200)),
      msg("b1", OWN, FRESH, daysAgo(400)), msg("b2", READ, FRESH, daysAgo(3)),
    ]);
    const p = consentPartition(store, { now: NOW, byMailbox: { [OWN]: WINDOW_365, [READ]: WINDOW_30 } });
    expect(p.activity.get(OLD)).toBe("active"); // 150 days in the 365-day mailbox
    expect(p.activity.get(FRESH)).toBe("active"); // 3 days in the 30-day mailbox
    const q = consentPartition(store, { now: NOW, byMailbox: { [OWN]: WINDOW_30, [READ]: WINDOW_30 } });
    expect(q.activity.get(OLD)).toBe("dormant");
  });

  it("a mailbox the map does not name is admitted, never retired by a window nobody stated", async () => {
    const store = await mirrorOf([msg("o", "mb-new", OLD, daysAgo(900))]);
    expect(consentPartition(store, { now: NOW, byMailbox: { [READ]: WINDOW_30 } }).activity.get(OLD)).toBe("active");
  });

  it("unread and unstated list the folder whole", async () => {
    const store = await mirrorOf([msg("o", READ, OLD, daysAgo(900))]);
    for (const s of ["unread", "unstated"] as const) {
      expect(consentPartition(store, { ...OWN_FIELDS, byMailbox: { [READ]: WHOLE(s) } }).activity.get(OLD)).toBe("active");
    }
  });
});

describe("the rendered Waiting list is the store's queue (fix-025's sentence, measured)", () => {
  const both = [
    { address: FRESH, messageId: "f", mailboxId: READ, at: daysAgo(2) },
    { address: OLD, messageId: "o", mailboxId: READ, at: daysAgo(150) },
  ];
  const mail = () => [msg("f", READ, FRESH, daysAgo(2), true), msg("o", READ, OLD, daysAgo(150))];
  const historyIds = (store: MemoryMirrorStore, o: ConsentOptions): string[] => consentPartition(store, o).history.map((m) => m.id);

  it("BASE SHAPE: the list is the store's, and a reader's own window ALSO files that sender's letter in History", async () => {
    const store = await mirrorOf(mail(), storePage(both));
    const own = { ...OWN_FIELDS, dormancyDays: 30 };
    expect(waitingOf(store, own)).toEqual([FRESH, OLD]);
    expect(historyIds(store, own)).toEqual(["o"]);
  });

  it("with the map, the store's list and the partition agree — unstated, folder whole, nothing in History", async () => {
    const store = await mirrorOf(mail(), storePage(both));
    const o = { ...OWN_FIELDS, dormancyDays: 30, byMailbox: { [READ]: WHOLE("unstated") } };
    expect(waitingOf(store, o)).toEqual([FRESH, OLD]);
    expect(historyIds(store, o)).toEqual([]);
  });

  it("with the map, the store's list and the partition agree — the organizer's window", async () => {
    const store = await mirrorOf(mail(), storePage(both.slice(0, 1)));
    const o = { ...OWN_FIELDS, byMailbox: { [READ]: WINDOW_30 } };
    expect(waitingOf(store, o)).toEqual([FRESH]);
    expect(historyIds(store, o)).toEqual(["o"]);
  });
});

describe("the mirror's prune keeps the widest window in the map", () => {
  it("the widest days; all_time anywhere is all_time; no map is null", () => {
    expect(widestWindowOf({ [READ]: WINDOW_30, [OWN]: WINDOW_365 })).toEqual({ dormancyDays: 365, scope: "window" });
    expect(widestWindowOf({ [READ]: WHOLE("unread"), [OWN]: WINDOW_30 })).toEqual({ dormancyDays: null, scope: "all_time" });
    expect(widestWindowOf(null)).toBeNull();
  });
});

describe("what the reader says about its count", () => {
  it("nothing while every window is stated", () => {
    expect(screeningDegrade({ [READ]: WINDOW_30, [OWN]: WINDOW_365 })).toBeNull();
    expect(screeningDegrade(null)).toBeNull();
  });
  it("unstated before unread, naming the holder", () => {
    expect(screeningDegrade({ a: WHOLE("unread"), b: { ...WHOLE("unstated"), holderName: "Old Mac" } }))
      .toEqual({ state: "unstated", holderName: "Old Mac" });
    expect(screeningDegrade({ a: WHOLE("unread"), b: WINDOW_30 })).toEqual({ state: "unread", holderName: "Studio Mac" });
  });
});
