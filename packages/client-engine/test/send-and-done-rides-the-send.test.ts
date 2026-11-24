/**
 * SEND + DONE'S RELEASE RIDES THE SEND. The release a press earned was held in the pressing
 * surface's memory, keyed by lane, so a send that went queued and was confirmed by a later boot
 * found no arm: the message went and the source stayed. The plan is persisted with the send's own
 * outbox row and handed back on its confirmed result, the replayed one included.
 * Mutation: `andDone` left off the persisted row → case 1 red; off the confirmed result → 1 and 2.
 * Cases 3 and 4 are the third road, Try again on the strip: the abandoned record keeps the plan and
 * the retry's rebuilt entry carries it (either spread removed → red).
 */
import type { EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore, MutationRejectedError, OhmailEngine,
  OUTBOX_BACKOFF_CAP_MS, OUTBOX_MAX_SERVER_FAILURES,
  type MutationResult, type SendAndDonePlan,
} from "@ohmail/client-engine";

const NOW = new Date("2026-09-27T09:00:00.000Z");
const tick = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 5); });

const PLAN: SendAndDonePlan = { section: "new", source: "m1", messageIds: ["m1"] };

const send = (body: string): EngineMutation => ({
  kind: "mail_send", inReplyTo: null, mailboxId: "mb", subject: "Invoice 12", body,
  to: [{ name: null, address: "ada@fake.test" }], cc: [], bcc: [],
} as unknown as EngineMutation);

/** A send route that is unreachable while `offline`, and delivers once reachable. */
function engineOver(store: IndexedDbMirrorStore, net: { offline: boolean; refuse?: boolean }): OhmailEngine {
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: NOW.toISOString(),
      }),
      fetchBody: async () => null,
      mutate: async (m: EngineMutation) => {
        if (m.kind !== "mail_send") return { changes: [], seq: null };
        if (net.offline) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
        if (net.refuse) throw new MutationRejectedError("rejected", { status: 409, code: "send_failed", retryable: false });
        return { changes: [], seq: null, entityId: "d1", providerMessageId: "<d1@x>" };
      },
    } as never,
  });
}

/** The send route answering by `mode`: unreachable, a counted 500, a refusal that keeps Retry, or delivered. */
type Mode = "offline" | "fail500" | "unverified" | "ok";
function engineOn(store: IndexedDbMirrorStore, net: { mode: Mode }, clock: { t: number }): OhmailEngine {
  return new OhmailEngine({
    store,
    now: () => new Date(clock.t),
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: new Date(clock.t).toISOString(),
      }),
      fetchBody: async () => null,
      mutate: async (m: EngineMutation) => {
        if (m.kind !== "mail_send") return { changes: [], seq: null };
        if (net.mode === "offline") throw new MutationRejectedError("network failure", { code: "network", retryable: true });
        if (net.mode === "fail500") {
          throw new MutationRejectedError("internal error", { status: 500, code: "internal", retryable: true });
        }
        if (net.mode === "unverified") {
          throw new MutationRejectedError("unconfirmed", { status: 200, code: "send_unverified", retryable: false });
        }
        return { changes: [], seq: null, entityId: "d1", providerMessageId: "<d1@x>" };
      },
    } as never,
  });
}

async function openStore(factory: IDBFactory): Promise<IndexedDbMirrorStore> {
  const store = new IndexedDbMirrorStore({ owner: "acct-sad", factory });
  await store.load();
  return store;
}

describe("the Send + Done release is kept with the send", () => {
  it("1 — a send queued before a reload comes back confirmed carrying its release", async () => {
    const factory = new IDBFactory();
    const s1 = await openStore(factory);
    const first = engineOver(s1, { offline: true });
    await first.start();
    const queued = await first.mutate(send("thanks, done"), { andDone: PLAN });
    expect(queued.status, "the offline press did not queue").toBe("queued");
    s1.close();

    const s2 = await openStore(factory);
    const second = engineOver(s2, { offline: false });
    await second.start();
    for (let i = 0; i < 20 && !second.hasLateResults(); i++) await tick();
    const late: MutationResult[] = await second.flushPending();
    const mine = late.find((r) => r.key === queued.key);
    expect(mine?.status, "the boot replay did not confirm the restored send").toBe("confirmed");
    expect(mine?.andDone, "the send was confirmed after the reload and its release was lost").toEqual(PLAN);
    s2.close();
  });

  it("2 — a live send pressed with a release returns it on its confirmation", async () => {
    const s = await openStore(new IDBFactory());
    const engine = engineOver(s, { offline: false });
    await engine.start();
    const res = await engine.mutate(send("thanks, done"), { andDone: PLAN });
    expect(res.status).toBe("confirmed");
    expect(res.andDone, "the confirmation lost the release it was pressed with").toEqual(PLAN);
    s.close();
  });

  it("3 — a Send + Done given up on at the ceiling, tried again after a reload, carries its release", async () => {
    const factory = new IDBFactory();
    const clock = { t: NOW.getTime() };
    const net: { mode: Mode } = { mode: "fail500" };
    const s1 = await openStore(factory);
    const first = engineOn(s1, net, clock);
    await first.start();
    await first.mutate(send("thanks, done"), { andDone: PLAN });
    for (let i = 0; i < OUTBOX_MAX_SERVER_FAILURES * 2 && first.abandoned().length === 0; i++) {
      clock.t += OUTBOX_BACKOFF_CAP_MS + 1;
      await first.flushPending();
    }
    const [row] = first.abandoned();
    expect(row?.mutation.kind, "the send was not given up on at the ceiling").toBe("mail_send");
    s1.close();

    net.mode = "ok";
    const s2 = await openStore(factory);
    const second = engineOn(s2, net, clock);
    await second.start();
    const res = await second.retryAbandoned(row!.id);
    expect(res.status, "Try again did not confirm the send").toBe("confirmed");
    expect(res.andDone, "a Send + Done tried again from the strip lost its release").toEqual(PLAN);
    s2.close();
  });

  it("4 — a restored Send + Done refused as unconfirmed, tried again, carries its release", async () => {
    const factory = new IDBFactory();
    const clock = { t: NOW.getTime() };
    const net: { mode: Mode } = { mode: "offline" };
    const s1 = await openStore(factory);
    const first = engineOn(s1, net, clock);
    await first.start();
    expect((await first.mutate(send("thanks, done"), { andDone: PLAN })).status).toBe("queued");
    s1.close();

    net.mode = "unverified";
    const s2 = await openStore(factory);
    const second = engineOn(s2, net, clock);
    await second.start();
    for (let i = 0; i < 20 && second.abandoned().length === 0; i++) await tick();
    const [row] = second.abandoned();
    expect(row?.error.code, "the restored replay was not kept as unconfirmed").toBe("send_unverified");
    expect(row?.retryable, "an unconfirmed send lost its Try again").toBe(true);

    net.mode = "ok";
    const res = await second.retryAbandoned(row!.id);
    expect(res.status).toBe("confirmed");
    expect(res.andDone, "the unconfirmed restored send lost its release").toEqual(PLAN);
    s2.close();
  });

  it("CONTROL: a refused send and a plain send carry no release", async () => {
    const s = await openStore(new IDBFactory());
    const net = { offline: false, refuse: true };
    const engine = engineOver(s, net);
    await engine.start();
    const refused = await engine.mutate(send("thanks, done"), { andDone: PLAN });
    expect(refused.status).toBe("rolled_back");
    expect(refused.andDone, "a refused send handed back a release to dispatch").toBeUndefined();
    net.refuse = false;
    const plain = await engine.mutate(send("just sent"));
    expect(plain.status).toBe("confirmed");
    expect(plain.andDone).toBeUndefined();
    s.close();
  });

  it("CONTROL: a plain Send pressed again under the key disarms the release", async () => {
    const factory = new IDBFactory();
    const s1 = await openStore(factory);
    const net = { offline: true };
    const engine = engineOver(s1, net);
    await engine.start();
    const queued = await engine.mutate(send("thanks, done"), { andDone: PLAN });
    net.offline = false;
    const again = await engine.mutate(send("thanks, done"), { key: queued.key });
    expect(again.status).toBe("confirmed");
    expect(again.andDone, "a plain Send inherited the release of the press it replaced").toBeUndefined();
    s1.close();
  });
});
