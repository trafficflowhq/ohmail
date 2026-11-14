import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore,
  OUTBOX_ABANDONED_TYPE,
  OUTBOX_TYPE,
  OhmailEngine,
  type EngineAdapter,
  type EngineMutation,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * OUTBOX-DAY-OLD-UNKEYED-CREATE-DROPPED-AT-RESTORE. A new-draft or rule create restored more
 * than a day after it was made cannot be replayed (the server has forgotten its key, so a replay
 * mints a second row), and the boot used to delete it without a word. It is kept now, in the
 * list of changes that did not land, saying why Try again is refused.
 */
const DAY_AND_MORE = DEMO_NOW.getTime() - (24 * 60 * 60 * 1000 + 60_000);

function recording(inner: FixturesAdapter): { adapter: EngineAdapter; kinds: string[] } {
  const kinds: string[] = [];
  const adapter = new Proxy(inner, {
    get(target, prop, recv) {
      if (prop === "mutate") {
        return async (m: EngineMutation, ...rest: unknown[]) => {
          kinds.push(m.kind);
          return (target.mutate as (...a: unknown[]) => unknown)(m, ...rest);
        };
      }
      const v = Reflect.get(target, prop, recv) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as unknown as EngineAdapter;
  return { adapter, kinds };
}

async function bootWith(rows: Array<Record<string, unknown>>) {
  const factory = new IDBFactory();
  const s1 = new IndexedDbMirrorStore({ owner: "acct-expired", factory });
  await s1.load();
  for (const r of rows) await s1.putLocal(OUTBOX_TYPE, r.id as string, r);
  s1.close();
  const w = recording(new FixturesAdapter());
  const store = new IndexedDbMirrorStore({ owner: "acct-expired", factory });
  const engine = new OhmailEngine({ adapter: w.adapter, store, now: () => DEMO_NOW });
  await engine.hydrate();
  await engine.syncOnce();
  return { engine, store, kinds: w.kinds };
}

const draftCreate = (id: string, at: number) => ({
  v: 3, id, key: `k-${id}`, n: 0, at, attempts: 0,
  mutation: {
    kind: "draft_save", draftId: null, mailboxId: "mb1", subject: "Friday",
    body: "the words nobody else holds", to: [], cc: [], bcc: [],
  },
});

describe("a day-old unkeyed create is kept where the person can see it", () => {
  it("is listed as a change that did not land, with Try again refused and nothing on the wire", async () => {
    const { engine, store, kinds } = await bootWith([draftCreate("old-draft", DAY_AND_MORE)]);

    expect(kinds, "a create past the dedupe horizon was replayed").not.toContain("draft_save");
    const listed = engine.abandoned();
    expect(listed.map((a) => a.id), "the day-old create vanished without a word").toEqual(["old-draft"]);
    expect(listed[0]!.retryable, "Try again would mint a second row").toBe(false);
    expect(listed[0]!.refusedCode).toBe("outbox_expired");
    expect(listed[0]!.error.message).toContain("too old");
    // The words are still on this device, in the record the list reads.
    const kept = store.entries<{ mutation: { body?: string } }>(OUTBOX_ABANDONED_TYPE);
    expect(kept.map((e) => e.entity.mutation.body)).toEqual(["the words nobody else holds"]);
    expect(store.entries(OUTBOX_TYPE), "the live queue still holds it").toHaveLength(0);
    store.close();
  });

  it("Discard removes it, like any other change that did not land", async () => {
    const { engine, store } = await bootWith([draftCreate("old-draft", DAY_AND_MORE)]);
    await engine.discardAbandoned("old-draft");
    expect(engine.abandoned()).toEqual([]);
    expect(store.entries(OUTBOX_ABANDONED_TYPE)).toHaveLength(0);
    store.close();
  });

  it("CONTROL: a create inside the day replays, and a day-old state verb still replays", async () => {
    const { engine, store, kinds } = await bootWith([
      draftCreate("fresh-draft", DEMO_NOW.getTime() - 60_000),
      {
        v: 1, id: "old-state", key: "k-old-state", n: 1, at: DAY_AND_MORE,
        mutation: { kind: "mark_seen", messageIds: ["giulia"], unread: false },
      },
    ]);
    expect(kinds.sort()).toEqual(["draft_save", "mark_seen"]);
    expect(engine.abandoned()).toEqual([]);
    store.close();
  });
});
