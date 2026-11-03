import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type ScreenerWaitingWire,
  type SyncChange,
  type SyncResponse,
} from "@ohmail/client-engine";
import {
  liveOhbox, liveScreener, presentedWorld, SCREENING_UNSUPPLIED, type WorldView,
} from "../src/state/live";
import {
  NOW as WORLD_NOW, SENDERS, removedMailboxWorld,
} from "../../../packages/services/test/helpers/removed-mailbox-world.js";

/**
 * THE PHONE PRESENTS WHAT THE STORE LISTS. A correspondent's letter the organizer admitted sits in
 * the INBOX and `GET /screener` lists only the real stranger; the phone's partition, with no rule
 * for either, used to present both at the gate and count the correspondent as held. The same
 * store answer now reaches the phone's own screens: Ohbox for one, Screener for the other.
 */

const NOW = new Date("2026-09-26T09:00:00.000Z");
const OWN = "me@home.test";
const PAL = "pal@friends.test";
const STRANGER = "new@stranger.test";
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const view: WorldView = { now: NOW, zone: "UTC", ownAddresses: [OWN] };

function msg(id: string, over: Partial<EngineMessage>): EngineMessage {
  const date = over.date ?? ago(2);
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "x@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: "s", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date, ...over,
  };
}

const MAIL: EngineMessage[] = [
  msg("sent", { folder: "Sent" as EngineMessage["folder"], from: { name: null, address: OWN }, to: [{ name: null, address: PAL }], date: ago(72), unread: false }),
  msg("pal-letter", { folder: "INBOX", from: { name: "Pal", address: PAL } }),
  msg("stranger-letter", { folder: "ohmail/Screener", from: { name: null, address: STRANGER } }),
];
const STRANGER_ONLY: ScreenerWaitingWire = {
  items: [{ messageId: "stranger-letter", address: STRANGER, name: null, receivedAt: ago(2), subject: "Subject stranger-letter", snippet: "s", mailboxId: "mb" }],
  nextCursor: null, total: 1, inFlight: [],
};

async function phoneMirror() {
  let sent = false;
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const creates: SyncChange[] = sent ? [] : MAIL.map((m, i): SyncChange => (
        { type: "message", op: "create", id: m.id, seq: i + 1, updatedAt: m.updatedAt, entity: m }));
      sent = true;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async () => null,
    screenerWaiting: async () => STRANGER_ONLY,
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
  await engine.start();
  await engine.syncOnce();
  const refresh = (engine as unknown as { refreshScreenerWaiting?: () => Promise<void> }).refreshScreenerWaiting;
  await refresh?.call(engine);
  return engine;
}

describe("the phone's screens present what the store lists", () => {
  it("Ohbox for the correspondent, Screener for the stranger, before and after the route's own read", async () => {
    const engine = await phoneMirror();
    const pres = presentedWorld(engine.read(), NOW, false, SCREENING_UNSUPPLIED, [OWN]).reader;

    const box = liveOhbox(pres, view);
    const inBox = [...box.resurfaced, ...box.fresh, ...box.seen].map((m) => m.id);
    expect(inBox, "the correspondent's letter was presented at the gate").toContain("pal-letter");

    const beforeRead = liveScreener(pres, view);
    expect(beforeRead.waiting.map((r) => r.address)).toEqual([STRANGER]);
    const afterRead = liveScreener(pres, view, {}, [{
      messageId: "stranger-letter", address: STRANGER, name: null, receivedAt: ago(2), subject: "Subject stranger-letter", snippet: "s",
    }]);
    expect(afterRead.waiting.map((r) => r.address)).toEqual([STRANGER]);
    expect(afterRead.source).toBe("server");
  });
});

describe("a mailbox removed with its copy kept asks nothing (helpers/removed-mailbox-world.ts)", () => {
  it("the phone's Screener lists the live strangers, its walk names none past them, its Ohbox none of the strangers", async () => {
    const w = await removedMailboxWorld("removed");
    const engine = await w.engine();
    const at: WorldView = { now: WORLD_NOW, zone: "UTC", ownAddresses: [w.own] };
    const pres = presentedWorld(engine.read(), WORLD_NOW, false, SCREENING_UNSUPPLIED, [w.own]).reader;
    const walked = (await engine.screenerWaitingPage(null))!.senders;
    expect(walked.map((s) => w.nameOf(s.messageId))).toEqual(["I.held", "B.live"]);
    for (const server of [null, walked]) {
      expect(liveScreener(pres, at, {}, server).waiting.map((r) => r.address).sort()).toEqual([SENDERS.B, SENDERS.I].sort());
    }
    const box = liveOhbox(pres, at);
    const inBox = [...box.resurfaced, ...box.fresh, ...box.seen].map((m) => m.id);
    expect(inBox, "an admitted sender's letter in the removed mailbox").toContain(w.idOf("F.inbox"));
    for (const name of ["A.held", "C.inbox", "D.second", "H.second"]) expect(inBox, name).not.toContain(w.idOf(name));
  });

  it("a removal between the stored page and the phone's walk past it: its Ohbox shows none of the removed mailbox's strangers", async () => {
    const w = await removedMailboxWorld("stood-down");
    const engine = await w.engine({ pageLimit: 2 });
    await w.walkPastARemoval(engine);
    const at: WorldView = { now: WORLD_NOW, zone: "UTC", ownAddresses: [w.own] };
    const box = liveOhbox(presentedWorld(engine.read(), WORLD_NOW, false, SCREENING_UNSUPPLIED, [w.own]).reader, at);
    const inBox = [...box.resurfaced, ...box.fresh, ...box.seen].map((m) => m.id);
    for (const name of ["A.held", "C.held", "C.inbox"]) expect(inBox, name).not.toContain(w.idOf(name));
  });
});
