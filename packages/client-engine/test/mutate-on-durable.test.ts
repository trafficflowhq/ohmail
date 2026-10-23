import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { faultyFactory } from "./helpers/faulty-idb.js";
import {
  FixturesAdapter, IndexedDbMirrorStore, OhmailEngine, OUTBOX_TYPE, type EngineMutation,
} from "@ohmail/client-engine";

/**
 * `mutate(m, { onDurable })` — the moment a send may leave its editor. Called once, after the
 * outbox write committed and before the adapter is asked; never when the write was refused, where
 * the send still rolls back (`storage_refused`). The web shell closes a healthy compose there.
 */

const SEND = {
  kind: "mail_send", inReplyTo: null, mailboxId: "mbx-1", subject: "hello", body: "words",
  to: [{ name: "Mila", address: "mila@example.test" }], cc: [], bcc: [],
} as unknown as EngineMutation;
const T = Date.parse("2026-10-23T12:00:00.000Z");

function world(owner: string) {
  const faulty = faultyFactory(new IDBFactory());
  const store = new IndexedDbMirrorStore({ owner, factory: faulty.factory });
  const inner = new FixturesAdapter();
  const order: string[] = [];
  let release!: () => void;
  const answered = new Promise<void>((r) => { release = r; });
  const engine = new OhmailEngine({
    adapter: {
      fetchBody: (...a: Parameters<FixturesAdapter["fetchBody"]>) => inner.fetchBody(...a),
      sync: (...a: Parameters<FixturesAdapter["sync"]>) => inner.sync(...a),
      mutate: async (m: EngineMutation, ...rest: unknown[]) => {
        order.push(`wire:${m.kind}`);
        await answered;
        return (inner.mutate as never as (...x: unknown[]) => Promise<unknown>)(m, ...rest);
      },
    } as never,
    store,
    now: () => new Date(T),
  });
  return { engine, store, faulty, order, release };
}

describe("mutate's onDurable", () => {
  it("fires once, after the outbox row is on disk and before the adapter is asked", async () => {
    const w = world("acct-on-durable");
    await w.engine.start();
    let onDisk: number | null = null;
    const pressed = w.engine.mutate(SEND, {
      key: "k-1",
      onDurable: () => {
        w.order.push("durable");
        onDisk = w.engine.read().list(OUTBOX_TYPE).length;
      },
    });
    for (let i = 0; i < 50 && !w.order.includes("wire:mail_send"); i++) await new Promise((r) => setTimeout(r, 5));
    expect(w.order).toEqual(["durable", "wire:mail_send"]);
    expect(onDisk, "the row was not on disk when the caller let go").toBe(1);
    w.release();
    const res = await pressed;
    expect(res.status).toBe("confirmed");
    expect(w.order.filter((x) => x === "durable")).toHaveLength(1);
  });

  it("never fires on a refused durable write, and the send still rolls back", async () => {
    const w = world("acct-on-durable-refused");
    await w.engine.start();
    w.faulty.arm({ mode: "none", onWrite: (_op, key) => (key.startsWith("outbox_entry:") ? "quota" : "pass") });
    let fired = 0;
    const res = await w.engine.mutate(SEND, { key: "k-2", onDurable: () => { fired += 1; } });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("storage_refused");
    expect(fired).toBe(0);
    expect(w.order, "a send with no durable record reached the wire").toEqual([]);
  });

  it("a caller's own fault in onDurable does not stop the send", async () => {
    const w = world("acct-on-durable-throws");
    await w.engine.start();
    w.release();
    const res = await w.engine.mutate(SEND, { key: "k-3", onDurable: () => { throw new Error("the caller's"); } });
    expect(res.status).toBe("confirmed");
    expect(w.order).toEqual(["wire:mail_send"]);
  });

  it("outboxHeld() is false with no timed-out dispatch standing", async () => {
    const w = world("acct-outbox-held");
    await w.engine.start();
    expect(w.engine.outboxHeld()).toBe(false);
  });
});
