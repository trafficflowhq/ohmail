/**
 * A VERB ON A ROW THE MIRROR DOES NOT HOLD — delete, move and tag
 * on a History or Search row go through the one `mutate` door as on a mirror row: the effects come
 * from the page cache, the row leaves or moves at the press, one outbox entry carries it, and the
 * shadow holds the page's row until the store agrees. A row in neither cache is still sent.
 */
import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  OUTBOX_ENTRY_VERSION,
  OUTBOX_TYPE,
  StoreTimelineWalker,
  type OhmailEngine,
  type StoreKeyset,
} from "../src/index.js";
import { SHADOW_DRAIN_BOUND } from "../src/shadow.js";
import { FAKE_NOW, FakeStore, idOf, settle } from "./helpers/fake-store.js";

const STORE_ROWS = 74_000;
const MIRROR_ROWS = 20;
const keysetOf = (m: EngineMessage): StoreKeyset => ({ date: m.date ?? null, id: m.id });

/** The store's page that starts at row `n` — held in the page cache, never in the mirror. */
async function pageAt(engine: OhmailEngine, fake: FakeStore, n: number): Promise<EngineMessage[]> {
  const before = fake.rows[n - 1]!;
  const out = await engine.pageStore("all", { before: keysetOf(before) });
  if (out.state !== "ready") throw new Error("the page did not answer");
  return out.items;
}

const outbox = (engine: OhmailEngine) => engine.store.entries(OUTBOX_TYPE);

describe("delete, move and tag on a History row the mirror does not hold", () => {
  it("a delete leaves at the press, is one outbox entry, confirms, and the store's next page no longer lists it", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: MIRROR_ROWS });
    const engine = await fake.engine();
    const before = keysetOf(fake.rows[4999]!);
    const [row] = await pageAt(engine, fake, 5000);
    expect(row!.id).toBe(idOf(5000));
    expect(engine.read().get("message", row!.id), "the mirror does not hold it").toBeUndefined();

    const release = fake.holdNext();
    const pending = engine.mutate({ kind: "message_delete", messageId: row!.id });
    expect(engine.storePageRow(row!), "gone within one paint").toBeNull();
    await settle();
    expect(outbox(engine), "one durable entry while it is on the wire").toHaveLength(1);
    release();
    const res = await pending;
    expect(res.status).toBe("confirmed");
    expect(fake.verbs.filter((v) => v.kind === "message_delete")).toEqual([
      expect.objectContaining({ id: row!.id }),
    ]);
    expect(engine.storePageRow(row!)).toBeNull();
    expect(outbox(engine)).toHaveLength(0);
    expect(engine.store.list("message"), "nothing was written into the mirror").toHaveLength(MIRROR_ROWS);

    engine.resetStorePages();
    const next = await engine.pageStore("all", { before });
    expect(next.state === "ready" ? next.items[0]!.id : null).toBe(idOf(5001));
  });

  it("a move shows at the press and stays moved after the window prunes the row the delta brought", async () => {
    const fake = new FakeStore(STORE_ROWS, {
      mirror: MIRROR_ROWS,
      engine: { storePolicy: { mode: "windowed", days: 90, minRows: 5, maxRows: 10 } },
    });
    const engine = await fake.engine();
    const [row] = await pageAt(engine, fake, 5000);
    const pending = engine.mutate({ kind: "move", messageId: row!.id, folder: "ohmail/Receipts" });
    expect(engine.storePageRow(row!)?.folder, "moved within one paint").toBe("ohmail/Receipts");
    expect((await pending).status).toBe("confirmed");
    expect(engine.store.get("message", row!.id), "the window pruned the row the delta brought").toBeUndefined();
    for (let i = 0; i <= SHADOW_DRAIN_BOUND; i++) {
      await engine.syncOnce();
      expect(engine.storePageRow(row!)?.folder, `drain ${i}`).toBe("ohmail/Receipts");
    }
    expect(fake.row(row!.id)?.folder).toBe("ohmail/Receipts");
  });

  it("a tag shows at the press, and its Undo is read from the same rows", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: MIRROR_ROWS });
    const engine = await fake.engine();
    const [row] = await pageAt(engine, fake, 6000);
    expect(engine.verbRead().get<EngineMessage>("message", row!.id)?.id, "the verb reader holds the page row").toBe(row!.id);
    const pending = engine.mutate({ kind: "tag_assign", messageId: row!.id, tagId: "t1", assigned: true });
    expect(engine.storePageRow(row!)?.labels).toEqual(["t1"]);
    expect((await pending).status).toBe("confirmed");
    await engine.syncOnce();
    expect(engine.storePageRow(row!)?.labels).toEqual(["t1"]);
    expect(fake.row(row!.id)?.labels).toEqual(["t1"]);
  });

  it("the same verb on a mirror row is unchanged (control)", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: MIRROR_ROWS });
    const engine = await fake.engine();
    const id = idOf(3);
    const res = await engine.mutate({ kind: "move", messageId: id, folder: "ohmail/Receipts" });
    expect(res.status).toBe("confirmed");
    expect(engine.read().get<EngineMessage>("message", id)?.folder).toBe("ohmail/Receipts");
    expect(fake.verbs).toHaveLength(1);
  });

  it("a row deleted here reads gone to the next verb — the page's older copy never answers for it", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: MIRROR_ROWS, lag: true });
    const engine = await fake.engine();
    const [row] = await pageAt(engine, fake, 5000);
    expect((await engine.mutate({ kind: "message_delete", messageId: row!.id })).status).toBe("confirmed");
    expect(engine.verbRead().get("message", row!.id)).toBeUndefined();
    const again = await engine.mutate({ kind: "tag_assign", messageId: row!.id, tagId: "t1", assigned: true });
    expect(again.status).toBe("rolled_back");
    expect(fake.verbs.map((v) => v.kind)).toEqual(["message_delete"]);
  });

  it("a no-op on a held row is refused here, and nothing reaches the wire", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: MIRROR_ROWS });
    const engine = await fake.engine();
    const [row] = await pageAt(engine, fake, 5000);
    const res = await engine.mutate({ kind: "move", messageId: row!.id, folder: "INBOX" });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("not_found");
    expect(fake.verbs).toHaveLength(0);
  });
});

describe("the History walker renders the verb at the press", () => {
  it("a deep slot's row folds at the press and a moved one shows its new folder, both in the walker's own rows", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: MIRROR_ROWS });
    const engine = await fake.engine();
    const walker = new StoreTimelineWalker(engine);
    walker.start();
    await settle();
    for (let i = 0; i < 20 && walker.rowAt(4_010, []) === null; i++) {
      walker.want(4_000, 4_020);
      await settle();
    }
    const deleted = walker.rowAt(4_010, []) as EngineMessage;
    const moved = walker.rowAt(4_011, []) as EngineMessage;
    expect(deleted.id).toBe(idOf(4_010));
    const gone = engine.mutate({ kind: "message_delete", messageId: deleted.id });
    const filed = engine.mutate({ kind: "move", messageId: moved.id, folder: "ohmail/Receipts" });
    expect(walker.rowAt(4_010, []), "folded within one paint").toBe("gone");
    expect((walker.rowAt(4_011, []) as EngineMessage).folder).toBe("ohmail/Receipts");
    expect((await gone).status).toBe("confirmed");
    expect((await filed).status).toBe("confirmed");
    expect(walker.rowAt(4_010, [])).toBe("gone");
    expect((walker.rowAt(4_011, []) as EngineMessage).folder).toBe("ohmail/Receipts");
    walker.stop();
  });
});

describe("the shadow over a page row", () => {
  it(`a door that lags keeps the deleted row gone through ${SHADOW_DRAIN_BOUND - 1} drains, then the tombstone agrees`, async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: MIRROR_ROWS, lag: true });
    const engine = await fake.engine();
    const [row] = await pageAt(engine, fake, 5000);
    expect((await engine.mutate({ kind: "message_delete", messageId: row!.id })).status).toBe("confirmed");
    expect(engine.storePageRow(row!), "the confirm's own drain read a copy without the write").toBeNull();
    for (let i = 1; i < SHADOW_DRAIN_BOUND; i++) {
      await engine.syncOnce();
      expect(engine.storePageRow(row!), `drain ${i}`).toBeNull();
    }
    fake.catchUp();
    await engine.syncOnce();
    expect(engine.store.isTombstoned("message", row!.id)).toBe(true);
    await engine.syncOnce();
    expect(engine.storePageRow(row!)).toBeNull();
  });
});

describe("a verb with nothing to paint", () => {
  it("a row in neither the mirror nor a page is sent by id, and the store answers", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: MIRROR_ROWS });
    const engine = await fake.engine();
    const id = idOf(70_000);
    expect(engine.verbRead().get("message", id)).toBeUndefined();
    const res = await engine.mutate({ kind: "move", messageId: id, folder: "ohmail/Receipts" });
    expect(res.status).toBe("confirmed");
    expect(fake.row(id)?.folder).toBe("ohmail/Receipts");
    expect(outbox(engine)).toHaveLength(0);
  });

  it("the 404 is the server's own answer, never a local one", async () => {
    const fake = new FakeStore(STORE_ROWS, { mirror: MIRROR_ROWS });
    const engine = await fake.engine();
    const res = await engine.mutate({ kind: "message_delete", messageId: idOf(90_000) });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.status).toBe(404);
    expect(fake.verbs.map((v) => v.id)).toEqual([idOf(90_000)]);
    expect(outbox(engine)).toHaveLength(0);
  });

  it("a verb left on disk for a page row replays after a restart with an empty page cache, and its row goes", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.putLocal(OUTBOX_TYPE, "left-1", {
      v: OUTBOX_ENTRY_VERSION, id: "left-1", key: "k-left-1", n: 0, at: FAKE_NOW.getTime() - 60_000,
      mutation: { kind: "message_delete", messageId: idOf(5000) },
    });
    const fake = new FakeStore(STORE_ROWS, { mirror: MIRROR_ROWS, store });
    const engine = await fake.engine();
    await settle();
    expect(engine.storePageCacheRows(), "nothing cached: a fresh session").toBe(0);
    expect(fake.verbs).toEqual([{ kind: "message_delete", id: idOf(5000), key: "k-left-1" }]);
    expect(fake.row(idOf(5000))).toBeUndefined();
    expect(outbox(engine), "delivered, and its durable row dropped").toHaveLength(0);
  });
});
