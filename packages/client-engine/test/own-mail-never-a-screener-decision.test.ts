import type { EngineMessage, Folder } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  consentPartition,
  ohboxView,
  presentationReader,
  screenerSegments,
  senderKey,
  type ConsentOptions,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * OWN MAIL IS NEVER A SCREENER DECISION (ruling 2026-09-25, row OWN-ADDRESS-GATE-ROW-IS-STILL-A-QUEUE-ROW).
 *
 * A message from one of the account's own addresses sitting in `ohmail/Screener` presents in the
 * INBOX: the partition's own guard places it there, so no queue groups it, no count reads it and
 * the Ohbox shows it. Nothing moves on the server — `physicalFolder` still names the gate.
 * Watch it fail: place the own row at `m.folder` again in `consentPartition`'s own guard, and the
 * first block goes RED (the Ohbox loses the message). The grouping guard in `screenerSegments`
 * stays the answer for a RAW reader (no partition yet), measured apart in the last block.
 */

const NOW = new Date("2026-08-04T12:00:00.000Z");
const RECENT = "2026-07-20T09:00:00.000Z";
const OLD = "2024-03-02T09:00:00.000Z";
const GATE: Folder = "ohmail/Screener";
const OWN = "me@example.com";
const STRANGER = "them@example.com";

let seq = 0;

function msg(o: { id: string; from: string; folder: string; date?: string; unread?: boolean }): EngineMessage {
  return {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: null, address: o.from },
    to: [],
    cc: [],
    date: o.date ?? RECENT,
    folder: o.folder as Folder,
    snippet: `snippet ${o.id}`,
    unread: o.unread ?? true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: o.date ?? RECENT,
  };
}

async function mirrorOf(messages: EngineMessage[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(messages.map((m) => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })) as SyncChange[]);
  return store;
}

/** The three reads every surface makes of one partition: the queue, the Ohbox, the counts. */
function surfaces(store: MemoryMirrorStore, opts: ConsentOptions) {
  const part = consentPartition(store, opts);
  const projected = presentationReader(store, part);
  const segments = screenerSegments(projected, opts.now ?? NOW, "en", "UTC", opts.ownAddresses);
  const ohbox = ohboxView(projected);
  return {
    part,
    projected,
    waiting: segments.waiting.map((r) => senderKey(r.from.address)).sort(),
    ohboxIds: [...ohbox.resurfaced, ...ohbox.newForYou, ...ohbox.previouslySeen].map((m) => m.id).sort(),
  };
}

const opts: ConsentOptions = { now: NOW, ownAddresses: [OWN] };

describe("own mail sitting in the Screener folder presents in the INBOX", () => {
  it("unread and recent: in the Ohbox, in no queue row, counted by nobody", async () => {
    const store = await mirrorOf([
      msg({ id: "own", from: OWN, folder: GATE }),
      msg({ id: "them", from: STRANGER, folder: GATE }),
    ]);
    const s = surfaces(store, opts);

    expect(s.part.placeOf.get("own")).toBe("INBOX");
    const row = s.projected.get<EngineMessage>("message", "own");
    expect(row?.folder).toBe("INBOX");
    expect(row?.physicalFolder).toBe(GATE);
    expect(s.ohboxIds).toEqual(["own"]);

    // The stranger beside it is still the one decision this gate holds, and the numbers agree.
    expect(s.waiting).toEqual([STRANGER]);
    expect(s.part.counts.activeUndecidedSenders).toBe(1);
    expect(s.part.activity.has(OWN)).toBe(false);

    // A presentation, never a move: the mirror still has the message at the gate.
    expect(store.get<EngineMessage>("message", "own")?.folder).toBe(GATE);
  });

  it("old and read: still the INBOX, never History — the account is not an unscreened sender", async () => {
    const store = await mirrorOf([msg({ id: "own", from: OWN, folder: GATE, date: OLD, unread: false })]);
    const s = surfaces(store, opts);

    expect(s.part.placeOf.get("own")).toBe("INBOX");
    expect(s.part.history).toEqual([]);
    expect(s.ohboxIds).toEqual(["own"]);
    expect(s.waiting).toEqual([]);
  });

  it("under every screening setting, and through the address fold", async () => {
    const store = await mirrorOf([msg({ id: "own", from: OWN, folder: GATE, date: OLD, unread: true })]);
    for (const [label, o] of [
      ["all_time", { ...opts, screeningScope: "all_time" }],
      ["baselined", { ...opts, baselineAt: "2026-06-01T00:00:00.000Z" }],
      ["a wide dial", { ...opts, dormancyDays: 365 }],
      ["a messy spelling", { now: NOW, ownAddresses: ["  Me@Example.COM  "] }],
    ] as const) {
      const s = surfaces(store, o);
      expect(s.part.placeOf.get("own"), label).toBe("INBOX");
      expect(s.ohboxIds, label).toEqual(["own"]);
      expect(s.waiting, label).toEqual([]);
      expect(s.part.counts.activeUndecidedSenders, label).toBe(0);
    }
  });
});

describe("what the rule does not touch", () => {
  it("own mail in the INBOX keeps the INBOX; own mail somebody screened out keeps its shelf", async () => {
    const store = await mirrorOf([
      msg({ id: "inbox", from: OWN, folder: "INBOX" }),
      msg({ id: "screened", from: OWN, folder: "ohmail/Screened" }),
      msg({ id: "spam", from: OWN, folder: "ohmail/Quarantine" }),
    ]);
    const s = surfaces(store, opts);

    expect(s.part.placeOf.get("inbox")).toBe("INBOX");
    // An explicit placement is an answer somebody gave, and that shelf is its only surface.
    expect(s.part.placeOf.get("screened")).toBe("ohmail/Screened");
    expect(s.part.placeOf.get("spam")).toBe("ohmail/Quarantine");
    expect(s.ohboxIds).toEqual(["inbox"]);
  });

  it("the same message from an address that is not the account's is a queue row at the gate", async () => {
    const store = await mirrorOf([msg({ id: "own", from: OWN, folder: GATE })]);
    const s = surfaces(store, { now: NOW, ownAddresses: ["someone@example.com"] });

    expect(s.part.placeOf.get("own")).toBe(GATE);
    expect(s.waiting).toEqual([OWN]);
    expect(s.ohboxIds).toEqual([]);
  });
});

describe("a raw reader — no partition yet — is held out by the queue's grouping", () => {
  it("the grouping guard decides here, and minting resumes when nobody is own", async () => {
    const store = await mirrorOf([
      msg({ id: "own", from: OWN, folder: GATE }),
      msg({ id: "them", from: STRANGER, folder: GATE }),
    ]);
    const rows = (own: readonly string[]) =>
      screenerSegments(store, NOW, "en", "UTC", own).waiting.map((r) => senderKey(r.from.address)).sort();

    expect(rows([OWN])).toEqual([STRANGER]);
    expect(rows([])).toEqual([OWN, STRANGER].sort());
  });
});
