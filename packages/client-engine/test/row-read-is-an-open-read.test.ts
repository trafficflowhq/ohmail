import { describe, expect, it } from "vitest";
import { getFixtures, type MessageFixture } from "@ohmail/fixtures";
import {
  DEMO_NOW,
  FixturesAdapter,
  MutationRejectedError,
  OhmailEngine,
  ohboxView,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type SyncChange,
} from "@ohmail/client-engine";

/**
 * A ROW READ BY ITS OWN VERB IS A READ IN OHMAIL (owner 2026-10-21: "should be at the top when it was
 * my last action"). A surface with no reader on the row (a phone row's swipe, the web reader over the
 * Tag, sender or History view) names it as `readRow`; `Engine.enrich` judges it like the held row:
 * a row in New, every id in its conversation, a read. The flag is the engine's, `readRow` never
 * reaches the wire or the outbox, and no hold is taken.
 */

interface Row { label: string; thread: string; arrived: string; unread: boolean; folder?: string }

const ROWS: Row[] = [
  { label: "tue", thread: "TUE", arrived: "2026-07-28T09:00:00.000Z", unread: false },
  { label: "mon", thread: "MON", arrived: "2026-07-27T09:00:00.000Z", unread: false },
  { label: "b", thread: "B", arrived: "2026-07-26T09:00:00.000Z", unread: true },
  { label: "fri", thread: "FRI", arrived: "2026-07-24T00:15:00.000Z", unread: true },
  { label: "c1", thread: "C", arrived: "2026-07-23T10:00:00.000Z", unread: true },
  { label: "c2", thread: "C", arrived: "2026-07-23T11:00:00.000Z", unread: true },
  { label: "news", thread: "NEWS", arrived: "2026-07-22T09:00:00.000Z", unread: true, folder: "ohmail/News" },
  { label: "rcpt", thread: "RCPT", arrived: "2026-07-21T09:00:00.000Z", unread: true, folder: "ohmail/Receipts" },
];
const ARRIVAL = ["tue", "mon"];

function fixtureOf(r: Row): MessageFixture {
  return {
    id: r.label, folder: "ohbox", from: { name: r.label, address: `${r.label}@example.com` },
    subject: `Subject ${r.label}`, snippet: `snippet ${r.label}`, time: "Mon", unread: r.unread,
  };
}

interface World { engine: OhmailEngine; sent: EngineMutation[]; drop: { next: boolean } }

async function world(): Promise<World> {
  const base = getFixtures();
  const inner = new FixturesAdapter({
    fixtures: { ...base, ohbox: ROWS.map(fixtureOf), reads: [], receipts: [], triage: { replyLater: [], setAside: [], resurface: [] } },
  });
  const byId = new Map(ROWS.map((r) => [r.label, r]));
  const stamp = (c: SyncChange): SyncChange => {
    const r = c.type === "message" ? byId.get(c.id) : undefined;
    if (!r || !c.entity) return c;
    return { ...c, entity: { ...(c.entity as object), threadId: r.thread, date: r.arrived, sortAt: r.arrived, folder: r.folder ?? "INBOX" } };
  };
  const sent: EngineMutation[] = [];
  const drop = { next: false };
  const adapter: EngineAdapter = {
    fetchBody: () => inner.fetchBody(),
    withdrawSend: (key, draftId) => inner.withdrawSend(key, draftId),
    async sync(params) {
      const r = await inner.sync(params);
      return { ...r, changes: { ...r.changes, creates: r.changes.creates.map(stamp), updates: r.changes.updates.map(stamp), moves: r.changes.moves.map(stamp) } };
    },
    async mutate(m, o) {
      sent.push(m);
      if (drop.next) {
        drop.next = false;
        throw new MutationRejectedError("socket closed", { code: "network", retryable: true });
      }
      const out = await inner.mutate(m, o);
      return { ...out, changes: out.changes.map(stamp) };
    },
  };
  const engine = new OhmailEngine({ adapter, now: () => DEMO_NOW });
  await engine.start();
  return { engine, sent, drop };
}

const ids = (list: readonly EngineMessage[]) => list.map((m) => m.id);
const box = (engine: OhmailEngine) => ohboxView(engine.read(), engine.openRowHeld());
const reads = (sent: readonly EngineMutation[]) => sent.filter((m) => m.kind === "mark_seen");
const flagged = (m: EngineMutation): boolean => (m as { openRead?: unknown }).openRead === true;
const read = (messageIds: string[], readRow?: string, extra: object = {}): EngineMutation =>
  ({ kind: "mark_seen", messageIds, unread: false, ...(readRow !== undefined ? { readRow } : {}), ...extra }) as EngineMutation;

describe("a row read by its own verb is an open read", () => {
  it("nothing held: sent with openRead and no readRow, the row first in Earlier, no hold", async () => {
    const { engine, sent } = await world();
    expect(ids(box(engine).previouslySeen), "the premise").toEqual(ARRIVAL);
    expect((await engine.mutate(read(["fri"], "fri"))).status).toBe("confirmed");
    const [m] = reads(sent);
    expect(m).toEqual({ kind: "mark_seen", messageIds: ["fri"], unread: false, openRead: true });
    expect(Object.keys(m!)).not.toContain("readRow");
    expect(engine.openRowHeld(), "no hold is taken").toBeNull();
    expect(ids(box(engine).previouslySeen)).toEqual(["fri", ...ARRIVAL]);
  });

  it("a conversation's every member read by its row is one open read", async () => {
    const { engine, sent } = await world();
    await engine.mutate(read(["c2", "c1"], "c2"));
    expect(reads(sent).map(flagged)).toEqual([true]);
    expect(new Set(ids(box(engine).previouslySeen).slice(0, 2))).toEqual(new Set(["c1", "c2"]));
  });

  it("while B is held: the row's read is an open read and B stays held in New", async () => {
    const { engine, sent } = await world();
    expect(engine.holdOpenRow("b")).toBe(true);
    await engine.mutate(read(["fri"], "fri"));
    expect(reads(sent).map(flagged)).toEqual([true]);
    expect(engine.openRowHeld()).toBe("b");
    expect(ids(box(engine).newForYou)).toContain("b");
    expect(ids(box(engine).previouslySeen)[0]).toBe("fri");
  });

  it("the outbox keeps the enriched mutation: queued, then replayed the same, never with readRow", async () => {
    const { engine, sent, drop } = await world();
    drop.next = true;
    expect((await engine.mutate(read(["fri"], "fri"))).status).toBe("queued");
    const [entry] = engine.pendingMutations();
    expect(entry?.mutation).toEqual({ kind: "mark_seen", messageIds: ["fri"], unread: false, openRead: true });
    await engine.flushPending();
    expect(reads(sent)).toEqual([entry!.mutation, entry!.mutation]);
  });
});

describe("CONTROLS: these keep arrival", () => {
  it("a News row and a Receipts row", async () => {
    const { engine, sent } = await world();
    await engine.mutate(read(["news"], "news"));
    await engine.mutate(read(["rcpt"], "rcpt"));
    expect(reads(sent).map(flagged)).toEqual([false, false]);
  });

  it("a resurfaced row and a parked row", async () => {
    const { engine, sent } = await world();
    await engine.mutate({ kind: "triage_set", messageId: "fri", state: "resurfaced" as never });
    await engine.mutate({ kind: "triage_set", messageId: "b", state: "reply_later" });
    await engine.mutate(read(["fri"], "fri"));
    await engine.mutate(read(["b"], "b"));
    expect(reads(sent).map(flagged)).toEqual([false, false]);
  });

  it("two conversations under one row", async () => {
    const { engine, sent } = await world();
    await engine.mutate(read(["fri", "c1"], "fri"));
    expect(reads(sent).map(flagged)).toEqual([false]);
    expect(ids(box(engine).previouslySeen)).toEqual([...ARRIVAL, "fri"]);
  });

  it("an unread with a row named, and a flag a surface passed with none", async () => {
    const { engine, sent } = await world();
    await engine.mutate(read(["tue"], "tue", { unread: true }));
    await engine.mutate(read(["fri"], undefined, { openRead: true }));
    expect(reads(sent).map(flagged)).toEqual([false, false]);
    expect(reads(sent).map((m) => Object.keys(m).includes("readRow"))).toEqual([false, false]);
  });
});
