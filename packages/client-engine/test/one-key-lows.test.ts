/**
 * The one-key fix, step 1: the LOW rows beside the re-press that sent twice, read at the
 * engine through a server double that answers as production does (one stored response per key
 * for its retention window, one reservation per send key for ever, a tag name UNIQUE per account).
 */
import type { EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import {
  IndexedDbMirrorStore, MutationRejectedError, OhmailEngine, OUTBOX_TYPE,
  type SendAndDonePlan,
} from "@ohmail/client-engine";

const t0 = Date.parse("2026-10-04T08:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const tick = (): Promise<void> => new Promise<void>((r) => { setTimeout(r, 5); });
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400 && !cond(); i++) await tick();
  if (!cond()) throw new Error(`never reached: ${what}`);
}
const msg = (id: string, folder = "INBOX") => ({
  id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: `<${id}@x>`, subject: id,
  from: { name: "Ada", address: "ada@fake.test" }, to: [], cc: [], date: new Date(t0).toISOString(), folder,
  snippet: "", unread: true, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: new Date(t0).toISOString(),
});

/** What a second arrival of each request does on the real server, `POST /tags` keyed. */
function server(clock: { t: number }) {
  const stored = new Map<string, number>(); // key → when the response was stored
  const effects: Array<{ kind: string; key: string }> = [];
  const tagNames = new Set<string>();
  const draftRows: string[] = [];
  const reserved = new Set<string>();
  let hold: Promise<void> | null = null;
  let failHeld: MutationRejectedError | null = null;
  const net = { syncFails: false, loseNextResponse: false };
  const adapter = {
    sync: async () => {
      if (net.syncFails) throw new MutationRejectedError("network failure", { code: "network", retryable: true });
      return { changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date(clock.t).toISOString() };
    },
    fetchBody: async () => null,
    mutate: async (m: EngineMutation, opts: {
      idempotencyKey: string; createdRow?: { id: string };
      onDraftRow?: (r: { id: string; revision: string | null }) => Promise<void>;
    }) => {
      const key = opts.idempotencyKey;
      // A send with no row of its own makes one before it sends, as the adapter does.
      if (m.kind === "mail_send" && opts.createdRow === undefined) {
        draftRows.push(key);
        await opts.onDraftRow?.({ id: `row-${draftRows.length}`, revision: null });
      }
      if (hold) { const h = hold; hold = null; await h; const f = failHeld; failHeld = null; if (f) throw f; }
      if (m.kind === "mail_send") {
        if (reserved.has(key)) return { changes: [], seq: null, firstSend: { status: "sent", at: new Date(clock.t).toISOString() } };
        reserved.add(key);
        effects.push({ kind: m.kind, key });
        if (net.loseNextResponse) { net.loseNextResponse = false; throw new MutationRejectedError("network failure", { code: "network", retryable: true }); }
        return { changes: [{ type: "draft", op: "update", id: `row-${key}`, seq: 2, updatedAt: new Date(clock.t).toISOString(), entity: { id: `row-${key}`, status: "sent" } }], seq: 2, providerMessageId: `<${key}@x>` };
      }
      const at = stored.get(key);
      if (at !== undefined && clock.t - at < 24 * HOUR) return { changes: [], seq: null };
      if (m.kind === "tag_create") {
        if (tagNames.has(m.name)) throw new MutationRejectedError("a tag with that name already exists", { status: 409, code: "conflict", retryable: false });
        tagNames.add(m.name);
      }
      effects.push({ kind: m.kind, key });
      stored.set(key, clock.t); // POST /tags claims its key too (the tag create's own route test)
      if (net.loseNextResponse) { net.loseNextResponse = false; throw new MutationRejectedError("network failure", { code: "network", retryable: true }); }
      return { changes: [], seq: null };
    },
  };
  return {
    adapter, effects, net, draftRows,
    holdNext(fail: MutationRejectedError | null = null): () => void {
      let open!: () => void;
      hold = new Promise<void>((r) => { open = r; });
      failHeld = fail;
      return () => open();
    },
  };
}

async function openStore(factory: IDBFactory, owner: string): Promise<IndexedDbMirrorStore> {
  const store = new IndexedDbMirrorStore({ owner, factory });
  await store.load();
  return store;
}
async function engineOn(store: IndexedDbMirrorStore, srv: ReturnType<typeof server>, clock: { t: number }, seed = true) {
  if (seed) {
    await store.applyChanges(["m-1", "m-2"].map((id) => ({ type: "message", op: "create", id, seq: 1, updatedAt: new Date(t0).toISOString(), entity: msg(id) })) as never);
  }
  const e = new OhmailEngine({ store, adapter: srv.adapter as never, now: () => new Date(clock.t), outboxAutoReplay: false } as never);
  await e.start();
  return e;
}

describe("the LOW rows, read at the engine", () => {
  it("OUTBOX-REPLAY-ON-A-NON-IDEMPOTENT-ROUTE: a tag create whose answer was lost is not refused on its retry", async () => {
    const clock = { t: t0 };
    const srv = server(clock);
    const e = await engineOn(await openStore(new IDBFactory(), "acct-tag"), srv, clock);
    srv.net.loseNextResponse = true;
    const first = await e.mutate({ kind: "tag_create", tagId: "t-1", name: "Invoices" } as EngineMutation);
    expect(first.status, "premise: the lost answer queued the create").toBe("queued");
    const [retry] = await e.flushPending();
    expect({ status: retry?.status, code: retry?.error?.code ?? null, created: srv.effects.filter((x) => x.kind === "tag_create").length },
      "the retry of a create that landed was refused as a duplicate").toEqual({ status: "confirmed", code: null, created: 1 });
  });

  it("CONTROL: the same kept move replayed an hour later is answered from the stored response", async () => {
    const clock = { t: t0 };
    const srv = server(clock);
    const factory = new IDBFactory();
    const s1 = await openStore(factory, "acct-1h");
    const e1 = await engineOn(s1, srv, clock);
    srv.net.syncFails = true;
    expect((await e1.mutate({ kind: "move", messageId: "m-1", folder: "ohmail/News" } as EngineMutation)).status).toBe("confirmed");
    s1.close();
    clock.t = t0 + HOUR;
    srv.net.syncFails = false;
    const e2 = await engineOn(await openStore(factory, "acct-1h"), srv, clock, false);
    await e2.flushPending();
    expect(srv.effects.filter((x) => x.kind === "move")).toHaveLength(1);
  });

  it("CONFIRMED-SEND-REPLAYED-AFTER-A-KILL-RELEASES-AGAIN: a send kept for its echo replays without its Done", async () => {
    const clock = { t: t0 };
    const srv = server(clock);
    const factory = new IDBFactory();
    const s1 = await openStore(factory, "acct-done");
    const e1 = await engineOn(s1, srv, clock);
    const apply = s1.applyChanges.bind(s1);
    let refuse = true;
    s1.applyChanges = (async (...a: Parameters<typeof apply>) => {
      if (refuse && (a[0] as Array<{ type: string }>).some((c) => c.type === "draft")) { refuse = false; throw new Error("QuotaExceededError"); }
      return apply(...a);
    }) as typeof s1.applyChanges;
    const plan: SendAndDonePlan = { section: "new", source: "m-1", messageIds: ["m-1"] };
    const first = await e1.mutate({
      kind: "mail_send", inReplyTo: "m-1", mailboxId: "mb", subject: "Re: m-1", body: "Done.",
      to: [{ name: null, address: "ada@fake.test" }], cc: [], bcc: [],
    } as unknown as EngineMutation, { andDone: plan });
    expect(first.andDone, "premise: the press's own confirmation carries the Done").toBeDefined();
    const kept = s1.entries(OUTBOX_TYPE).length;
    s1.close();
    const e2 = await engineOn(await openStore(factory, "acct-done"), srv, clock, false);
    const replayed = await e2.flushPending();
    const again = replayed.filter((r) => r.status === "confirmed" && r.andDone !== undefined).length;
    expect({ kept, deliveries: srv.effects.filter((x) => x.kind === "mail_send").length, releasedAgain: again },
      "the replayed confirmation carried the Done a second time").toEqual({ kept: 1, deliveries: 1, releasedAgain: 0 });
  });

  it("CONTROL: a Send + Done queued before a kill still carries its Done on the replay", async () => {
    const clock = { t: t0 };
    const srv = server(clock);
    const factory = new IDBFactory();
    const s1 = await openStore(factory, "acct-done-ctl");
    const e1 = await engineOn(s1, srv, clock);
    const open = srv.holdNext(new MutationRejectedError("network failure", { code: "network", retryable: true }));
    open();
    const plan: SendAndDonePlan = { section: "new", source: "m-1", messageIds: ["m-1"] };
    const first = await e1.mutate({
      kind: "mail_send", inReplyTo: "m-1", mailboxId: "mb", subject: "Re: m-1", body: "Done.",
      to: [{ name: null, address: "ada@fake.test" }], cc: [], bcc: [],
    } as unknown as EngineMutation, { andDone: plan });
    expect(first.status, "premise: the send was queued").toBe("queued");
    s1.close();
    const e2 = await engineOn(await openStore(factory, "acct-done-ctl"), srv, clock, false);
    const replayed = await e2.flushPending();
    expect(replayed.map((r) => [r.status, r.andDone?.source ?? null])).toEqual([["confirmed", "m-1"]]);
  });

  /** A reply queued by a lost connection, the app closed, and opened again `later` ms on. */
  async function sendQueuedThenReopened(owner: string, later: number) {
    const clock = { t: t0 };
    const srv = server(clock);
    const factory = new IDBFactory();
    const s1 = await openStore(factory, owner);
    const e1 = await engineOn(s1, srv, clock);
    srv.holdNext(new MutationRejectedError("network failure", { code: "network", retryable: true }))();
    const reply = {
      kind: "mail_send", inReplyTo: "m-1", mailboxId: "mb", subject: "Re: m-1", body: "Thursday works.",
      to: [{ name: null, address: "ada@fake.test" }], cc: [], bcc: [],
    } as unknown as EngineMutation;
    const first = await e1.mutate(reply);
    expect(first.status, "premise: the reply was queued").toBe("queued");
    s1.close();
    clock.t = t0 + later;
    const e2 = await engineOn(await openStore(factory, owner), srv, clock, false);
    return { srv, e2, reply, first, sent: () => srv.effects.filter((x) => x.kind === "mail_send").length };
  }

  for (const [label, later] of [["a day", 25 * HOUR], ["eight days", 8 * 24 * HOUR], ["CONTROL: within the day", 23 * HOUR]] as const) {
    it(`a reply replayed ${label} later goes, once, and nothing is kept back`, async () => {
      const w = await sendQueuedThenReopened(`acct-send-${later}`, later);
      const [replay] = await w.e2.flushPending();
      expect({ sent: w.sent(), status: replay?.status, kept: w.e2.abandoned().length },
        "a reply that waited was held back, or went twice").toEqual({ sent: 1, status: "confirmed", kept: 0 });
      const again = await w.e2.mutate(w.reply, { key: w.first.key });
      expect({ status: again.status, sent: w.sent(), rows: w.srv.draftRows.length },
        "the press under the same key sent it again, or made a second draft row").toEqual({ status: "confirmed", sent: 1, rows: 1 });
    });
  }

  it("a reply replayed a day later whose first attempt was delivered is answered from that delivery", async () => {
    const clock = { t: t0 };
    const srv = server(clock);
    const factory = new IDBFactory();
    const s1 = await openStore(factory, "acct-went");
    const e1 = await engineOn(s1, srv, clock);
    srv.net.loseNextResponse = true;
    const first = await e1.mutate({
      kind: "mail_send", inReplyTo: "m-1", mailboxId: "mb", subject: "Re: m-1", body: "Thursday works.",
      to: [{ name: null, address: "ada@fake.test" }], cc: [], bcc: [],
    } as unknown as EngineMutation);
    expect(first.status, "premise: delivered, answer lost, queued").toBe("queued");
    s1.close();
    clock.t = t0 + 25 * HOUR;
    const e2 = await engineOn(await openStore(factory, "acct-went"), srv, clock, false);
    const [r] = await e2.flushPending();
    expect({ status: r?.status, went: r?.firstSend !== undefined, sent: srv.effects.filter((x) => x.kind === "mail_send").length })
      .toEqual({ status: "confirmed", went: true, sent: 1 });
  });

  it("a press under a key whose send confirmed before the press dispatched sends that send's row, never a second create", async () => {
    const clock = { t: t0 };
    const srv = server(clock);
    const seen: Array<string | null> = [];
    const mutate = srv.adapter.mutate;
    srv.adapter.mutate = (async (m: EngineMutation, o: Parameters<typeof mutate>[1]) => {
      if (m.kind === "mail_send") seen.push(o.createdRow?.id ?? null);
      return mutate(m, o);
    }) as typeof mutate;
    const e = await engineOn(await openStore(new IDBFactory(), "acct-row"), srv, clock);
    const reply = (body: string) => ({
      kind: "mail_send", inReplyTo: "m-1", mailboxId: "mb", subject: "Re: m-1", body,
      to: [{ name: null, address: "ada@fake.test" }], cc: [], bcc: [],
    }) as unknown as EngineMutation;
    const a = await e.mutate(reply("Words A."));
    expect(a.status).toBe("confirmed");
    await e.mutate(reply("Words B, the edit."), { key: a.key });
    expect(seen, "the later press made a second create under the key").toEqual([null, "row-1"]);
  });
});

