import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { StoreTimelineWalker } from "../src/index.js";
import { FAKE_NOW, FakeStore, idOf, settle, storeMessage } from "./helpers/fake-store.js";

/**
 * An open History showed new mail above its first row
 * and kept its own count and rows for everything else until the next visit. A change below the
 * pages it read — an older message arriving, a message taken away elsewhere — now takes the
 * store's months and total, and the rows on screen stay drawn while their pages are asked again.
 */
type Commit = { commit: (c: unknown) => void };

async function openHistory(fake: FakeStore) {
  const engine = await fake.engine();
  const w = new StoreTimelineWalker(engine);
  w.start();
  for (let i = 0; i < 40 && w.state() !== "ready"; i++) await settle();
  return { engine, w };
}
const flush = async () => { for (let i = 0; i < 30; i++) await settle(); };

describe("an open History takes the store's figure for a change below what it read", () => {
  it("an OLDER message arriving moves the total", async () => {
    const fake = new FakeStore(300, { mirror: 20 });
    const { engine, w } = await openHistory(fake);
    expect(w.total()).toBe(300);
    const older: EngineMessage = { ...storeMessage(1000), id: "zz-older" };
    fake.rows.push(older);
    (fake as unknown as Commit).commit({ type: "message", op: "create", id: older.id, entity: older });
    await engine.syncOnce();
    await flush();
    expect(w.total(), "the visit kept its own count").toBe(301);
  });

  it("a message taken away elsewhere, below the pages read, moves the total", async () => {
    const fake = new FakeStore(300, { mirror: 20 });
    const { engine, w } = await openHistory(fake);
    const i = fake.rows.findIndex((m) => m.id === idOf(250));
    fake.rows.splice(i, 1);
    (fake as unknown as Commit).commit({ type: "message", op: "delete", id: idOf(250), entity: null });
    await engine.syncOnce();
    await flush();
    expect(w.total(), "the visit kept its own count").toBe(299);
  });

  it("control: new mail above the first row moves it too (the shipped half)", async () => {
    const fake = new FakeStore(300, { mirror: 20 });
    const { engine, w } = await openHistory(fake);
    const fresh: EngineMessage = { ...storeMessage(0), id: "zz-new", date: new Date(FAKE_NOW.getTime() + 60_000).toISOString() };
    fake.rows.unshift(fresh);
    (fake as unknown as Commit).commit({ type: "message", op: "create", id: fresh.id, entity: fresh });
    await engine.syncOnce();
    await flush();
    expect(w.total()).toBe(301);
  });

  it("a message taken away inside the pages a deep reader holds: the rows close up, read again", async () => {
    const fake = new FakeStore(600, { mirror: 20 });
    const { engine, w } = await openHistory(fake);
    const deep = () => Array.from({ length: 30 }, (_, k) => w.rowAt(240 + k, []));
    const reach = async () => {
      for (let n = 0; n < 20 && deep().some((r) => r === null); n++) { w.want(240, 270); await flush(); }
    };
    await reach();
    expect(deep().every((r) => r !== null && r !== "gone"), "control: the deep rows were read").toBe(true);
    const i = fake.rows.findIndex((m) => m.id === idOf(250));
    fake.rows.splice(i, 1);
    (fake as unknown as Commit).commit({ type: "message", op: "delete", id: idOf(250), entity: null });
    await engine.syncOnce();
    await flush();
    const at = (k: number) => { const r = w.rowAt(k, []); return r !== null && r !== "gone" ? r.id : r; };
    /* The view asks again after every page that lands (its `want` moves with the walk). */
    for (let n = 0; n < 30 && at(250) !== idOf(251); n++) { w.want(240, 270); await settle(); }
    expect(at(250), "the deleted row's slot still folds, the rows below it one slot off").toBe(idOf(251));
    expect(at(249)).toBe(idOf(249));
    expect(w.total()).toBe(599);
  }, 20_000);

  it("a deep reader keeps its rows drawn across an older arrival, and they are the store's after", async () => {
    const fake = new FakeStore(600, { mirror: 20 });
    const { engine, w } = await openHistory(fake);
    const deep = () => Array.from({ length: 30 }, (_, k) => w.rowAt(240 + k, []));
    /* The view asks after every landed page; far slots are reached by steps. */
    const reach = async () => {
      for (let n = 0; n < 20 && deep().some((r) => r === null); n++) { w.want(240, 270); await flush(); }
    };
    await reach();
    const before = deep();
    expect(before.every((r) => r !== null && r !== "gone"), "control: the deep rows were read").toBe(true);
    // Answers held on the wire: the frame is re-read while nothing has landed yet.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const a = fake.adapter as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>;
    const list = a.listMessages!.bind(fake.adapter);
    const older: EngineMessage = { ...storeMessage(5000), id: "zz-older" };
    fake.rows.push(older);
    (fake as unknown as Commit).commit({ type: "message", op: "create", id: older.id, entity: older });
    let first = true;
    a.listMessages = async (...x) => { if (!first) await gate; first = false; return list(...x); };
    await engine.syncOnce();
    await flush();
    const during = deep();
    expect(during.every((r) => r !== null && r !== "gone"), "a mounted slot read empty during the re-read").toBe(true);
    release();
    await reach();
    const after = deep();
    expect(after.map((r) => (r !== null && r !== "gone" ? r.id : r))).toEqual(before.map((r) => (r !== null && r !== "gone" ? r.id : r)));
    expect(w.total()).toBe(601);
  });
});
