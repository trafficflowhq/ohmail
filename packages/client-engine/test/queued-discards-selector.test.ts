/**
 * THE QUEUED DISCARDS, AS ONE ENGINE SELECTOR. A draft discard that cannot reach the account waits
 * on the queue while its overlay erases the draft, so the strip beside the abandoned rows is the
 * only place the draft is still named. The web strip and the phone both read `queuedDiscards()`;
 * this file pins its membership (the queue's own) and its snapshot identity.
 * Mutations: the kind filter narrowed → all three red (and the web and phone lists); the kept
 * snapshot dropped → case 3 red.
 */
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore, MutationRejectedError, OhmailEngine, type EngineMutation,
} from "@ohmail/client-engine";

const NOW = new Date("2026-09-28T09:00:00.000Z");

const draft = (id: string) => ({
  id, mailboxId: "mb", threadId: null, inReplyToMessageId: null, subject: `Draft ${id}`, body: "words",
  to: [], cc: [], bcc: [], rationale: null, status: "draft",
  createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
});

/** `offline` reaches every draft but those in `through`; `hang` holds the request open. */
interface Net { offline: boolean; through: Set<string>; hang: Promise<void> | null }

async function scene(ids: readonly string[]) {
  const store = new IndexedDbMirrorStore({ owner: "acct-queued-discards", factory: new IDBFactory() });
  await store.load();
  const net: Net = { offline: true, through: new Set(), hang: null };
  const sent: EngineMutation[] = [];
  let seq = 0;
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: {
          creates: seq > 0 ? [] : ids.map((id) => ({
            type: "draft", op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity: draft(id),
          })),
          updates: [], moves: [], deletes: [],
        },
        cursor: String(seq), hasMore: false, serverTime: NOW.toISOString(),
      }),
      fetchBody: async () => null,
      mutate: async (m: EngineMutation) => {
        sent.push(m);
        if (net.hang) await net.hang;
        const target = (m as { draftId?: string }).draftId ?? "";
        if (net.offline && !net.through.has(target)) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
        return { changes: [], seq: null };
      },
    } as never,
  });
  await engine.start();
  return { engine, store, net, sent };
}

const ids = (engine: OhmailEngine) => engine.queuedDiscards().map((q) => q.id);

describe("queuedDiscards — the draft discards waiting on the queue", () => {
  it("1 — lists a queued discard as a frozen pick, and nothing else the queue holds", async () => {
    const { engine, store } = await scene(["d1", "d2"]);
    const res = await engine.mutate({ kind: "draft_discard", draftId: "d1" });
    expect(res.status, "the offline discard did not queue").toBe("queued");
    // A second verb on the queue that is not a discard stays out of the list.
    await engine.mutate({
      kind: "draft_save", draftId: "d2", mailboxId: "mb", subject: "x", body: "y", to: [], cc: [], bcc: [],
    } as unknown as EngineMutation);
    expect(engine.pendingMutations().map((q) => q.mutation.kind).sort(), "the control verb did not queue")
      .toEqual(["draft_discard", "draft_save"]);
    const listed = engine.queuedDiscards();
    expect(listed.map((q) => [q.id, q.key, q.mutation.kind]), "the queued discard is on the queue and not listed")
      .toEqual([[res.id, res.key, "draft_discard"]]);
    expect(Object.isFrozen(listed) && Object.isFrozen(listed[0]), "the engine handed out a live entry").toBe(true);
    expect(engine.read().get("draft", "d1"), "the overlay did not erase the draft").toBeUndefined();
    store.close();
  });

  it("2 — on the wire it is not listed; withdrawn it is not listed; confirmed it is gone", async () => {
    const { engine, store, net } = await scene(["d1", "d2"]);
    const a = await engine.mutate({ kind: "draft_discard", draftId: "d1" });
    const b = await engine.mutate({ kind: "draft_discard", draftId: "d2" });
    expect(ids(engine)).toEqual([a.id, b.id]);

    let release!: () => void;
    net.hang = new Promise<void>((r) => { release = r; });
    net.through.add("d1");
    const flying = engine.retryQueued(a.id);
    for (let i = 0; i < 20 && ids(engine).includes(a.id); i++) await Promise.resolve();
    expect(ids(engine), "a discard on the wire is still listed as waiting").toEqual([b.id]);
    release();
    net.hang = null;
    expect((await flying)?.status).toBe("confirmed");
    expect(ids(engine)).toEqual([b.id]);

    expect(await engine.withdrawQueued(b.key)).toBe("withdrawn");
    expect(ids(engine), "a withdrawn discard is still listed").toEqual([]);
    expect(engine.read().get("draft", "d2"), "the withdrawn discard's draft did not come back").toBeDefined();
    store.close();
  });

  it("3 — one snapshot while nothing changed; a held-back discard is listed again at the END", async () => {
    const { engine, store } = await scene(["d1", "d2"]);
    const a = await engine.mutate({ kind: "draft_discard", draftId: "d1" });
    const b = await engine.mutate({ kind: "draft_discard", draftId: "d2" });
    const first = engine.queuedDiscards();
    expect(engine.queuedDiscards(), "an unchanged queue rebuilt its snapshot").toBe(first);

    // Tried again and still unreachable: the entry goes back on the queue behind the other one.
    expect((await engine.retryQueued(a.id))?.status).toBe("queued");
    const after = engine.queuedDiscards();
    expect(after.map((q) => q.id), "the held-back discard is not listed at the end").toEqual([b.id, a.id]);
    expect(after, "an order change kept the old snapshot").not.toBe(first);
    store.close();
  });
});

describe("waitingSends — the sends waiting to go, as Drafts lists them", () => {
  const send = (over: Record<string, unknown> = {}) => ({
    kind: "mail_send", inReplyTo: null, mailboxId: "mb", subject: "Offline", body: "words",
    to: [{ name: null, address: "bo@fake.test" }], cc: [], bcc: [], ...over,
  }) as unknown as EngineMutation;

  /** The send's create reaches the server and its send step does not, as the phone's held step answers. */
  async function sendScene() {
    const s = await scene(["d1"]);
    let rows = 0;
    let hang: Promise<void> | null = null;
    const adapter = (s.engine as unknown as { adapter: Record<string, unknown> }).adapter;
    adapter.mutate = async (m: EngineMutation, opts: { onDraftRow?: (r: { id: string; revision: null }) => Promise<void>; createdRow?: unknown }) => {
      if (m.kind !== "mail_send") return { changes: [], seq: null };
      if (opts.createdRow === undefined && (m as { draftId?: string }).draftId === undefined) {
        await opts.onDraftRow?.({ id: `row-${++rows}`, revision: null });
      }
      if (hang) await hang;
      if (s.net.offline) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
      return { changes: [], seq: null, providerMessageId: "pm" };
    };
    adapter.withdrawSend = async () => ({ outcome: "withdrawn" });
    return { ...s, hold: (p: Promise<void> | null) => { hang = p; } };
  }

  it("4 — lists a waiting send with the row it made, a bound send by its row, and nothing else", async () => {
    const { engine, store } = await sendScene();
    const fresh = await engine.mutate(send());
    const bound = await engine.mutate(send({ draftId: "d1", subject: "Bound" }));
    await engine.mutate(send({ subject: "Later", sendAt: "2030-01-01T09:00:00.000Z" }));
    await engine.mutate({ kind: "draft_discard", draftId: "d1" });
    expect([fresh.status, bound.status]).toEqual(["queued", "queued"]);
    const listed = engine.waitingSends();
    expect(listed.map((w) => [w.key, w.draftId, w.wire]), "an appointment or a discard is listed as a waiting send")
      .toEqual([[fresh.key, "row-1", false], [bound.key, "d1", false]]);
    expect(listed[0]!.paintId, "the send's own placeholder row is not named").toBeTruthy();
    expect(engine.read().get("draft", listed[0]!.paintId!), "the named placeholder is not the send's paint")
      .toMatchObject({ status: "sending", subject: "Offline" });
    expect(listed[0]!.mutation.subject).toBe("Offline");
    expect(Object.isFrozen(listed) && Object.isFrozen(listed[0]), "the engine handed out a live entry").toBe(true);
    store.close();
  });

  it("5 — on the wire after a wait it says so; withdrawn it is gone; one snapshot while nothing changed", async () => {
    const { engine, store, net, hold } = await sendScene();
    const res = await engine.mutate(send());
    const first = engine.waitingSends();
    expect(engine.waitingSends(), "an unchanged queue rebuilt its snapshot").toBe(first);

    let release!: () => void;
    hold(new Promise<void>((r) => { release = r; }));
    net.offline = false;
    const flying = engine.retryQueued(res.id);
    for (let i = 0; i < 20 && engine.waitingSends()[0]?.wire !== true; i++) await Promise.resolve();
    expect(engine.waitingSends().map((w) => [w.key, w.wire]), "a send that waited is not listed on the wire")
      .toEqual([[res.key, true]]);
    expect(engine.waitingSends(), "the wire did not change the snapshot").not.toBe(first);
    release();
    hold(null);
    expect((await flying)?.status).toBe("confirmed");
    expect(engine.waitingSends(), "a confirmed send is still waiting").toEqual([]);

    net.offline = true;
    const again = await engine.mutate(send({ subject: "Second" }));
    expect(engine.waitingSends().map((w) => w.key)).toEqual([again.key]);
    expect(await engine.withdrawQueued(again.key)).toBe("withdrawn");
    expect(engine.waitingSends(), "a withdrawn send is still waiting").toEqual([]);
    store.close();
  });
});
