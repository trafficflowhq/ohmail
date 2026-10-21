import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore,
  MemoryMirrorStore,
  OhmailEngine,
  SqlMirrorStore,
  type BaseMirrorStore,
  type EngineAdapter,
  type EngineMessage,
  type MessageBodyRecord,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";
import { sqlWorld } from "./helpers/node-sql-executor.js";

/**
 * AN OPEN THAT JOINS A BODY READ ALREADY OUT AS A BACKGROUND ONE SENDS ITS OWN, at once and marked
 * for the person (`{ urgent: true }`: `priority: "high"` on the web's wire). The web's resume lane
 * holds background reads behind its cap after a return, where the engine cannot see them, so
 * joining one made the open wait for a background slot or the lane's three-second bound; on the
 * wire the person's read may land first too. Whichever answer lands first writes the record and
 * the other is dropped: no second write, no flicker. On every mirror store.
 *
 * Mutations watched: the race removed from `hydrateBody`'s join (the open sends nothing of its own);
 * the landing claim removed (the second answer writes again); the deferred failure written at once
 * (a failed open read over a background read still out reads "couldn't load"); the batch's per-id
 * tail asked for a raced id (a third read).
 */

const NOW = new Date("2026-10-21T12:00:00.000Z");
let seq = 0;

function msg(id: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date: "2026-10-21T09:00:00.000Z", folder: "INBOX",
    snippet: `snippet of ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
  };
}

type Kind = "memory" | "sql" | "idb";

function storeOf(kind: Kind): BaseMirrorStore {
  if (kind === "memory") return new MemoryMirrorStore();
  if (kind === "sql") return new SqlMirrorStore({ dbName: "open-beside", open: sqlWorld().open });
  return new IndexedDbMirrorStore({ dbName: "open-beside", factory: new IDBFactory() });
}

/** One body request on the wire, held until the test answers it. */
interface Call {
  kind: "batch" | "single";
  ids: string[];
  urgent: boolean;
  /** Answer every id (or all but `omit`) with `<who> <id>`. */
  answer(who: string, omit?: string[]): void;
  fail(): void;
}

/**
 * The world: `ids` arrive in one `/sync` page, every body read is held and recorded, and every
 * `message_body` write the engine makes is counted per id and state.
 */
async function world(kind: Kind, ids: string[], opts: { batch?: boolean } = {}) {
  const store = storeOf(kind);
  const calls: Call[] = [];
  let served = false;
  const held = <T>(call: Omit<Call, "answer" | "fail">, shape: (who: string, omit: string[]) => T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      calls.push({
        ...call,
        answer: (who, omit = []) => resolve(shape(who, omit)),
        fail: () => reject(new Error("HTTP 503")),
      });
    });
  const adapter = {
    sync: async (): Promise<SyncResponse> => {
      const creates: SyncChange[] = served ? [] : ids.map((id) => ({
        type: "message", op: "create", id, seq: ++seq, updatedAt: NOW.toISOString(), entity: msg(id),
      }));
      served = true;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: `c${seq}`, hasMore: false, serverTime: NOW.toISOString() };
    },
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: (id: string, intent?: { urgent?: boolean }) =>
      held({ kind: "single", ids: [id], urgent: intent?.urgent === true }, (who) => ({
        text: `${who} ${id}`, html: null, loadedRemoteContent: false,
      })),
    ...(opts.batch === false ? {} : {
      fetchBodies: (asked: string[], intent?: { urgent?: boolean }) =>
        held({ kind: "batch", ids: [...asked], urgent: intent?.urgent === true }, (who, omit) =>
          asked.filter((id) => !omit.includes(id)).map((messageId) => ({
            messageId, text: `${who} ${messageId}`, html: null, loadedRemoteContent: false,
          }))),
    }),
  } as unknown as EngineAdapter;

  /** Every `message_body` record written, in order, as `<id>:<state>`. */
  const writes: string[] = [];
  const note = (type: string, id: string, entity: unknown): void => {
    if (type === "message_body") writes.push(`${id}:${(entity as MessageBodyRecord | null)?.state ?? "none"}`);
  };
  const putLocal = store.putLocal.bind(store);
  store.putLocal = async (type, id, entity) => { note(type, id, entity); return putLocal(type, id, entity); };
  const commitLocal = store.commitLocal.bind(store);
  store.commitLocal = async (puts, deletes) => {
    for (const p of puts) note(p.type, p.id, p.entity);
    return commitLocal(puts, deletes);
  };

  const engine = new OhmailEngine({ adapter, store, now: () => NOW, eagerBodies: true });
  await engine.start();
  const record = (id: string): MessageBodyRecord | undefined => store.get<MessageBodyRecord>("message_body", id);
  /** The `ready` writes of `id`: two would be the second answer written over the first. */
  const readyWrites = (id: string): number => writes.filter((w) => w === `${id}:ready`).length;
  return { engine, store, calls, writes, record, readyWrites };
}

/** Yield until `cond` holds: the mirror's writes ahead of a read are asynchronous on every store. */
async function until(cond: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 0));
  if (!cond()) throw new Error(`timed out waiting for: ${label}`);
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The eager pass, the background reader: its batch for `ids` is out and unanswered. */
async function backgroundBatchOut(w: Awaited<ReturnType<typeof world>>, ids: string[]): Promise<Call> {
  void w.engine.prefetchRecentBodies();
  await until(() => w.calls.some((c) => c.kind === "batch" && !c.urgent), "the background batch to leave");
  const bg = w.calls.find((c) => c.kind === "batch" && !c.urgent)!;
  expect(bg.ids.sort(), "the premise: the background batch carries the bodies").toEqual([...ids].sort());
  for (const id of ids) expect(w.record(id)?.state, "the premise: marked loading").toBe("loading");
  return bg;
}

for (const kind of ["memory", "sql", "idb"] as const) {
  describe(`an open beside a background read already out (${kind} store)`, () => {
    it("the open sends its own read at once, marked; its answer writes the record, the background's is dropped", async () => {
      const w = await world(kind, ["m1", "m2"]);
      const bg = await backgroundBatchOut(w, ["m1", "m2"]);
      void w.engine.hydrateBody("m1", { urgent: true });
      const own = w.calls.find((c) => c.urgent && c.ids.includes("m1"));
      expect(own, "the open joined the background read and sent nothing of its own").toBeDefined();
      expect(own!.kind).toBe("single");
      own!.answer("OPEN");
      await until(() => w.record("m1")?.state === "ready", "the open's answer to land");
      expect(w.record("m1")!.text).toBe("OPEN m1");
      bg.answer("BACKGROUND");
      await until(() => w.record("m2")?.state === "ready", "the background batch to land");
      await settle();
      expect(w.record("m1")!.text, "the background answer wrote over the open's").toBe("OPEN m1");
      expect(w.readyWrites("m1"), "the record was written twice").toBe(1);
      expect(w.record("m2")!.text, "the batch's other bodies are written as ever").toBe("BACKGROUND m2");
    });

    it("the background answer lands first: it writes, and the open's later answer is dropped", async () => {
      const w = await world(kind, ["m1", "m2"]);
      const bg = await backgroundBatchOut(w, ["m1", "m2"]);
      void w.engine.hydrateBody("m1", { urgent: true });
      const own = w.calls.find((c) => c.urgent && c.ids.includes("m1"))!;
      expect(own).toBeDefined();
      bg.answer("BACKGROUND");
      await until(() => w.record("m1")?.state === "ready", "the background batch to land");
      own.answer("OPEN");
      await settle();
      expect(w.record("m1")!.text).toBe("BACKGROUND m1");
      expect(w.readyWrites("m1"), "the open's late answer was written too").toBe(1);
    });

    it("the open's read fails while the background read is out: nothing is written until that one answers", async () => {
      const w = await world(kind, ["m1"]);
      const bg = await backgroundBatchOut(w, ["m1"]);
      void w.engine.hydrateBody("m1", { urgent: true });
      w.calls.find((c) => c.urgent && c.ids.includes("m1"))!.fail();
      await settle();
      expect(w.record("m1")?.state, "a failure was written while another read could still answer").toBe("loading");
      bg.answer("BACKGROUND");
      await until(() => w.record("m1")?.state === "ready", "the background batch to land");
      expect(w.writes.filter((x) => x === "m1:failed")).toEqual([]);
    });

    it("both reads fail: one failed record", async () => {
      const w = await world(kind, ["m1"]);
      const bg = await backgroundBatchOut(w, ["m1"]);
      void w.engine.hydrateBody("m1", { urgent: true });
      w.calls.find((c) => c.urgent && c.ids.includes("m1"))!.fail();
      await settle();
      bg.fail();
      await until(() => w.record("m1")?.state === "failed", "the failure to be written");
      await settle();
      expect(w.writes.filter((x) => x === "m1:failed")).toHaveLength(1);
    });

    it("its promise settles when its own answer lands, though the background read is still out", async () => {
      const w = await world(kind, ["m1"]);
      await backgroundBatchOut(w, ["m1"]);
      let done = false;
      void w.engine.hydrateBody("m1", { urgent: true }).then(() => { done = true; });
      w.calls.find((c) => c.urgent && c.ids.includes("m1"))!.answer("OPEN");
      await until(() => done, "the open's promise to settle");
      expect(w.record("m1")!.text).toBe("OPEN m1");
    });

    it("a second open joins the first's read: nothing more is sent", async () => {
      const w = await world(kind, ["m1"]);
      await backgroundBatchOut(w, ["m1"]);
      void w.engine.hydrateBody("m1", { urgent: true });
      void w.engine.hydrateBody("m1", { urgent: true });
      void w.engine.hydrateBody("m1", { retry: true });
      expect(w.calls.filter((c) => c.urgent), "each open sent a read of its own").toHaveLength(1);
    });

    it("an open while the background answer is being written sends nothing, and the record is written once", async () => {
      const w = await world(kind, ["m1"]);
      const bg = await backgroundBatchOut(w, ["m1"]);
      // Hold the background's write: its answer has landed, its record is not in the mirror yet.
      let release: () => void = () => {};
      let writing = false;
      const gate = new Promise<void>((r) => { release = r; });
      const commitLocal = w.store.commitLocal.bind(w.store);
      w.store.commitLocal = async (puts, deletes) => {
        if (puts.some((p) => p.type === "message_body" && (p.entity as MessageBodyRecord | null)?.state === "ready")) {
          writing = true;
          await gate;
        }
        return commitLocal(puts, deletes);
      };
      bg.answer("BACKGROUND");
      await until(() => writing, "the background's write to start");
      expect(w.record("m1")?.state, "the premise: the write has not reached the mirror").toBe("loading");
      void w.engine.hydrateBody("m1", { urgent: true });
      expect(w.calls.filter((c) => c.urgent), "an answer already landed, and the open asked again").toEqual([]);
      release();
      await until(() => w.record("m1")?.state === "ready", "the background's write to land");
      expect(w.readyWrites("m1")).toBe(1);
    });

    it("an open before the background read has left (its marker is being written): that read leaves as the person's", async () => {
      const w = await world(kind, ["m1"]);
      let release: () => void = () => {};
      let marking = false;
      const gate = new Promise<void>((r) => { release = r; });
      const commitLocal = w.store.commitLocal.bind(w.store);
      w.store.commitLocal = async (puts, deletes) => {
        if (puts.some((p) => p.type === "message_body" && (p.entity as MessageBodyRecord | null)?.state === "loading")) {
          marking = true;
          await gate;
        }
        return commitLocal(puts, deletes);
      };
      void w.engine.prefetchRecentBodies();
      await until(() => marking, "the background read's marker to be written");
      void w.engine.hydrateBody("m1", { urgent: true });
      expect(w.calls, "nothing leaves before its marker").toEqual([]);
      release();
      await until(() => w.calls.length > 0, "the read to leave");
      await settle();
      expect(w.calls.map((c) => `${c.kind}:${c.ids.join(",")}:${c.urgent ? "marked" : "background"}`)).toEqual(["batch:m1:marked"]);
    });

    it("a thread open whose siblings ride a background batch: one marked batch of its own for them", async () => {
      const w = await world(kind, ["m1", "m2", "m3"]);
      const bg = await backgroundBatchOut(w, ["m1", "m2", "m3"]);
      void w.engine.hydrateThread(["m1", "m2"]);
      const own = w.calls.filter((c) => c.urgent);
      expect(own.map((c) => `${c.kind}:${c.ids.join(",")}`), "the thread joined the background batch and sent nothing of its own")
        .toEqual(["batch:m1,m2"]);
      own[0]!.answer("THREAD");
      await until(() => w.record("m2")?.state === "ready", "the thread's answer to land");
      bg.answer("BACKGROUND");
      await until(() => w.record("m3")?.state === "ready", "the background batch to land");
      await settle();
      expect([w.record("m1")!.text, w.record("m2")!.text, w.record("m3")!.text]).toEqual(["THREAD m1", "THREAD m2", "BACKGROUND m3"]);
      expect(w.readyWrites("m1") + w.readyWrites("m2")).toBe(2);
    });

    it("both batches leave a body out: one read asks it alone, never two", async () => {
      const w = await world(kind, ["m1", "m2"]);
      const bg = await backgroundBatchOut(w, ["m1", "m2"]);
      void w.engine.hydrateThread(["m1", "m2"]);
      const own = w.calls.find((c) => c.urgent && c.kind === "batch")!;
      expect(own).toBeDefined();
      own.answer("THREAD", ["m1"]);
      await settle();
      expect(w.calls.filter((c) => c.kind === "single"), "the thread asked alone while the background could still answer").toEqual([]);
      bg.answer("BACKGROUND", ["m1"]);
      await until(() => w.calls.some((c) => c.kind === "single"), "the per-message read");
      const singles = w.calls.filter((c) => c.kind === "single");
      expect(singles.map((c) => c.ids[0])).toEqual(["m1"]);
      singles[0]!.answer("ALONE");
      await until(() => w.record("m1")?.state === "ready", "the per-message answer");
      await settle();
      expect(w.calls.filter((c) => c.kind === "single")).toHaveLength(1);
      expect(w.record("m1")!.text).toBe("ALONE m1");
    });

    it("without a batch route a thread sibling's background read is raced alone", async () => {
      const w = await world(kind, ["m1"], { batch: false });
      void w.engine.prefetchRecentBodies();
      await until(() => w.calls.some((c) => c.kind === "single" && !c.urgent), "the background read to leave");
      void w.engine.hydrateThread(["m1"]);
      const own = w.calls.find((c) => c.urgent && c.ids.includes("m1"));
      expect(own, "the thread joined the background read and sent nothing of its own").toBeDefined();
      own!.answer("THREAD");
      await until(() => w.record("m1")?.state === "ready", "the thread's answer");
      w.calls.find((c) => !c.urgent)!.answer("BACKGROUND");
      await settle();
      expect(w.record("m1")!.text).toBe("THREAD m1");
      expect(w.readyWrites("m1")).toBe(1);
    });
  });
}
