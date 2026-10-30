/**
 * A WRITE THAT NEVER ANSWERS HOLDS THE OUTBOX FOR ITS CEILING, NOT UNTIL A RELOAD.
 *
 * Measured on Cloud web, 2026-10-23: a two-minute silent cut. The first press's request never
 * answered, so after the replay deadline it became the order barrier; every later press said it
 * was filed and sent nothing, Try again sent nothing, and everything went out 1.3 s after the hung
 * request finally reset. The barrier is right (a newer write must not land before an older one
 * that may still commit); what was wrong is that it stood for as long as the socket did.
 *
 * Driven on the shipped numbers, on a fake clock: past `OUTBOX_HOLD_CEILING_MS` the hung attempt
 * is a retryable `timeout`, goes back on the queue under its own key and replays first. A send is
 * the exception: only its barrier goes (`send-outlives-the-hold-ceiling.test.ts`). Try again ends
 * the wait only past `OUTBOX_TRY_AGAIN_ENDS_HOLD_MS` (`try-again-keeps-the-order.test.ts`).
 * Mutations: the ceiling's race removed → cases 1, 3, 4 and 5 red; `retryQueued` not ending the
 * hold → case 3 red; ending it at any age → cases 3 and 3b red; the ended change not sent ahead of
 * the press → case 3c red; a `queued` late answer recorded for a decide → case 1b red; dropped for
 * a draft's first save too → case 5 red; a send ended at its ceiling, or its barrier kept → case 6 red;
 * an ended write's request not stopped, or stopped after it is queued again → cases 3 and 7 red;
 * a create behind the hold left out of the take-back, or its row left unmarked → case 8 red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine, OUTBOX_HOLD_CEILING_MS, OUTBOX_REPLAY_DEADLINE_MS,
  OUTBOX_TRY_AGAIN_ENDS_HOLD_MS, OUTBOX_TYPE, type EngineDraft, type EngineMutation,
} from "@ohmail/client-engine";

const NOW = "2026-10-23T09:00:00.000Z";
const SCREENER = "ohmail/Screener";

const held = (id: string, address: string) => ({
  id, accountId: "acct_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: `subject of ${id}`, from: { name: `Sender ${id}`, address },
  to: [], cc: [], date: NOW, folder: SCREENER, snippet: `snippet of ${id}`, unread: true,
  hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: NOW,
});
const draft = (id: string) => ({
  id, mailboxId: "mb_1", threadId: null, inReplyToMessageId: null, subject: `Draft ${id}`, body: "words",
  to: [], cc: [], bcc: [], rationale: null, status: "draft", createdAt: NOW, updatedAt: NOW,
});

/** How the server meets the n-th request: answered, never answered, answered after a while, refused. */
type Answer = "ok" | "hang" | { afterMs: number } | MutationRejectedError;

async function scene(plan: (m: EngineMutation, n: number) => Answer, opts: { autoReplay?: boolean } = {}) {
  const store = new MemoryMirrorStore();
  await store.load();
  const sent: Array<{ kind: string; key: string; signal?: AbortSignal }> = [];
  let seq = 0;
  const engine = new OhmailEngine({
    store,
    ...(opts.autoReplay === false ? { outboxAutoReplay: false } : {}),
    adapter: {
      sync: async () => ({
        changes: {
          creates: seq > 0 ? [] : [
            { type: "message", id: "s1", entity: held("s1", "ada@example.invalid") },
            { type: "message", id: "s2", entity: held("s2", "bo@example.invalid") },
            { type: "message", id: "m1", entity: { ...held("m1", "cy@example.invalid"), folder: "INBOX" } },
            { type: "draft", id: "d1", entity: draft("d1") },
          ].map((c) => ({ ...c, op: "create", seq: ++seq, updatedAt: NOW })),
          updates: [], moves: [], deletes: [],
        },
        cursor: String(seq), hasMore: false, serverTime: NOW,
      }),
      fetchBody: async () => null,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      mutate: async (m: EngineMutation, o: { idempotencyKey: string; signal?: AbortSignal }) => {
        const n = sent.push({ kind: m.kind, key: o.idempotencyKey, ...(o.signal ? { signal: o.signal } : {}) });
        const how = plan(m, n);
        if (how === "hang") return new Promise(() => { /* the dead socket */ });
        if (how instanceof MutationRejectedError) throw how;
        if (typeof how === "object") {
          return new Promise((resolve) => setTimeout(() => resolve({ changes: [], seq: null }), how.afterMs));
        }
        return { changes: [], seq: null };
      },
    } as never,
  });
  await engine.start();
  return { engine, store, sent };
}

const decide = (senderId: string): EngineMutation =>
  ({ kind: "screener_decide", senderId, decision: "yes", dest: "ohbox", scope: "sender" }) as EngineMutation;
const discard = (draftId: string): EngineMutation => ({ kind: "draft_discard", draftId }) as EngineMutation;
const keys = (sent: Array<{ key: string }>): string[] => sent.map((s) => s.key);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.useRealTimers(); });

describe("the hold behind a hung write ends at its ceiling", () => {
  it("the ceiling is past the server's own limit, so a request still being worked on answers first", () => {
    const route = readFileSync(
      fileURLToPath(new URL("../../../apps/api-vercel/app/[[...path]]/route.ts", import.meta.url)), "utf8",
    );
    const maxDuration = Number(/export const maxDuration = (\d+)/.exec(route)?.[1]);
    expect(maxDuration, "the API's maxDuration could not be read").toBeGreaterThan(0);
    expect(OUTBOX_HOLD_CEILING_MS, "the ceiling ends a request the server may still be working on")
      .toBeGreaterThan(maxDuration * 1000);
    expect(OUTBOX_HOLD_CEILING_MS).toBeGreaterThan(OUTBOX_REPLAY_DEADLINE_MS);
  });

  it("1 — a hung decide, then a decide and a discard: past the ceiling all three leave in order, the first under its own key", async () => {
    const { engine, sent } = await scene((_m, n) => (n === 1 ? "hang" : "ok"));
    const first = engine.mutate(decide("s1"));
    await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1);
    const a = await first;
    expect(a.status, "the hung decide did not answer at its deadline").toBe("queued");
    const b = await engine.mutate(decide("s2"));
    const c = await engine.mutate(discard("d1"));
    expect([b.status, c.status]).toEqual(["queued", "queued"]);
    expect(keys(sent), "a press went out behind the hung one").toEqual([a.key]);

    // A drive inside the ceiling still replays nothing: the barrier stands.
    await engine.syncOnce();
    await vi.advanceTimersByTimeAsync(OUTBOX_HOLD_CEILING_MS - OUTBOX_REPLAY_DEADLINE_MS - 1_000);
    expect(keys(sent), "the barrier gave way before its ceiling").toEqual([a.key]);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(keys(sent), "past the ceiling the queue still waited on the hung request")
      .toEqual([a.key, a.key, b.key, c.key]);
    expect(engine.pendingMutations(), "a change is still waiting after the replay").toEqual([]);
    // The ceiling's own `queued` is no answer: the replay's confirmation is the only one handed over.
    const handed = await engine.flushPending();
    expect(handed.filter((r) => r.id === a.id).map((r) => r.status), "a queued non-answer was kept beside the real one")
      .not.toContain("queued");
  });

  it("1b — on a host that owns the replay, the flush after the ceiling hands over the answer and no non-answer beside it", async () => {
    const { engine, sent } = await scene((_m, n) => (n === 1 ? "hang" : "ok"), { autoReplay: false });
    const first = engine.mutate(decide("s1"));
    await vi.advanceTimersByTimeAsync(OUTBOX_HOLD_CEILING_MS + 1);
    const a = await first;
    expect(engine.pendingMutations().map((p) => p.key), "the hung decide did not go back under its key").toEqual([a.key]);
    const handed = await engine.flushPending();
    expect(handed.filter((r) => r.id === a.id).map((r) => r.status), "the ceiling's `queued` was handed over as an answer")
      .toEqual(["confirmed"]);
    expect(keys(sent)).toEqual([a.key, a.key]);
  });

  it("2 — CONTROL: an answer at 30 s, inside the ceiling, is sent once and never replayed", async () => {
    const { engine, sent } = await scene((_m, n) => (n === 1 ? { afterMs: 30_000 } : "ok"));
    const first = engine.mutate(decide("s1"));
    await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1);
    const a = await first;
    expect(a.status).toBe("queued");
    const b = await engine.mutate(discard("d1"));
    await vi.advanceTimersByTimeAsync(OUTBOX_HOLD_CEILING_MS * 2);
    expect(keys(sent), "a request that answered was sent again").toEqual([a.key, b.key]);
    expect(engine.pendingMutations()).toEqual([]);
  });

  it("3 — Try again inside the API's limit waits its turn; past it, it ends the wait at once, the hung change first", async () => {
    const { engine, sent } = await scene((_m, n) => (n === 1 ? "hang" : "ok"));
    const first = engine.mutate(decide("s1"));
    await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1);
    const a = await first;
    const b = await engine.mutate(discard("d1"));
    expect(b.status).toBe("queued");
    expect(keys(sent)).toEqual([a.key]);

    // The server may still be working on the hung decide: the press goes after it, not beside it.
    const early = engine.retryQueued(b.id);
    await vi.advanceTimersByTimeAsync(10);
    expect((await early)?.status, "Try again sent a press beside a request the server may still apply").toBe("queued");
    expect(keys(sent)).toEqual([a.key]);

    await vi.advanceTimersByTimeAsync(OUTBOX_TRY_AGAIN_ENDS_HOLD_MS - OUTBOX_REPLAY_DEADLINE_MS);
    expect(keys(sent), "the barrier gave way before its ceiling").toEqual([a.key]);
    const pressed = engine.retryQueued(b.id);
    await vi.advanceTimersByTimeAsync(10);
    const r = await pressed;
    expect(r === null || r.status === "confirmed", `Try again answered ${r?.status}`).toBe(true);
    expect(keys(sent), "Try again waited for the ceiling, or skipped the hung change").toEqual([a.key, a.key, b.key]);
    expect(sent[0]!.signal?.aborted, "the attempt Try again ended was left free to be sent again").toBe(true);
    expect(engine.pendingMutations()).toEqual([]);
  });

  it("3b — Try again ends the hung read, and a newer unread on its only letter leaves nothing to send again", async () => {
    // The host owns the replay here (the phone's shape), so the press alone decides the order.
    const { engine, sent } = await scene((_m, n) => (n === 1 ? "hang" : "ok"), { autoReplay: false });
    const first = engine.mutate({ kind: "mark_seen", messageIds: ["m1"], unread: false } as EngineMutation);
    await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1);
    const read = await first;
    const unread = await engine.mutate({ kind: "mark_seen", messageIds: ["m1"], unread: true } as EngineMutation);
    expect([read.status, unread.status]).toEqual(["queued", "queued"]);

    const early = engine.retryQueued(unread.id);
    await vi.advanceTimersByTimeAsync(10);
    expect((await early)?.status, "the unread went out while the read may still land after it").toBe("queued");
    expect(keys(sent)).toEqual([read.key]);

    await vi.advanceTimersByTimeAsync(OUTBOX_TRY_AGAIN_ENDS_HOLD_MS - OUTBOX_REPLAY_DEADLINE_MS);
    const pressed = engine.retryQueued(unread.id);
    await vi.advanceTimersByTimeAsync(10);
    expect((await pressed)?.status).toBe("confirmed");
    expect(keys(sent), "the older read went again over the newer unread").toEqual([read.key, unread.key]);
    expect(sent[0]!.signal?.aborted, "the attempt Try again ended was left free to be sent again").toBe(true);
    expect(engine.pendingMutations()).toEqual([]);
    expect((await engine.flushPending()).filter((r) => r.key === read.key)).toEqual([]);
  });

  it("3c — Try again sends what the newer unread leaves of the hung read ahead of the press", async () => {
    const bodies: string[] = [];
    const { engine, sent } = await scene((m, n) => {
      const r = m as { messageIds?: string[]; unread?: boolean };
      bodies.push(`${(r.messageIds ?? []).join(",")} ${r.unread ? "unread" : "read"}`);
      return n === 1 ? "hang" : "ok";
    }, { autoReplay: false });
    const first = engine.mutate({ kind: "mark_seen", messageIds: ["m1", "s1"], unread: false } as EngineMutation);
    await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1);
    const read = await first;
    const unread = await engine.mutate({ kind: "mark_seen", messageIds: ["m1"], unread: true } as EngineMutation);
    await vi.advanceTimersByTimeAsync(OUTBOX_TRY_AGAIN_ENDS_HOLD_MS - OUTBOX_REPLAY_DEADLINE_MS + 10);
    const pressed = engine.retryQueued(unread.id);
    await vi.advanceTimersByTimeAsync(10);
    expect((await pressed)?.status).toBe("confirmed");
    expect(bodies, "the newer unread went out before what is left of the older read").toEqual(["m1,s1 read", "s1 read", "m1 unread"]);
    expect(keys(sent)).toEqual([read.key, read.key, unread.key]);
    expect(engine.pendingMutations()).toEqual([]);
    // The read's confirmation waits for the host's flush, as a late answer does.
    expect((await engine.flushPending()).filter((r) => r.key === read.key).map((r) => r.status)).toEqual(["confirmed"]);
  });

  it("4 — a timeout spends none of the give-up ceiling, and the change keeps its key", async () => {
    const offline = new MutationRejectedError("network failure", { code: "network", retryable: true });
    const { engine, store, sent } = await scene((_m, n) => (n === 1 ? "hang" : offline));
    const first = engine.mutate(discard("d1"));
    await vi.advanceTimersByTimeAsync(OUTBOX_HOLD_CEILING_MS + 1);
    const a = await first;
    // Still unreachable after the ceiling: the change waits, under the key it was made with.
    expect(engine.pendingMutations().map((p) => p.key)).toEqual([a.key]);
    expect(new Set(keys(sent)), "the replay minted a new key").toEqual(new Set([a.key]));
    const row = store.entries<{ attempts?: number; lastError?: { code: string | null } }>(OUTBOX_TYPE)
      .find((e) => e.id === a.id)?.entity;
    expect(row?.attempts ?? 0, "the timeout was counted as the server failing").toBe(0);
    expect(engine.abandoned()).toEqual([]);
  });

  it("5 — CONTROL: a draft's first save that hung is handed over exactly once by flushPending", async () => {
    const { engine, sent } = await scene((m, n) => (n === 1 && m.kind === "draft_save" ? "hang" : "ok"));
    const create = engine.mutate({
      kind: "draft_save", draftId: null, mailboxId: "mb_1", subject: "Hello", body: "words", to: [], cc: [], bcc: [],
    } as unknown as EngineMutation);
    await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1);
    const made = await create;
    expect(made.status, "the hung create did not answer at its deadline").toBe("queued");
    await vi.advanceTimersByTimeAsync(OUTBOX_HOLD_CEILING_MS);
    expect(engine.pendingMutations().map((p) => p.key), "the create did not go back under its key").toEqual([made.key]);
    // Its surface's collector wakes on a waiting answer; the `queued` is what re-arms its retry.
    expect(engine.hasLateResults(), "the composer waiting on its create was never told to flush again").toBe(true);
    const out = await engine.flushPending();
    const mine = out.filter((r) => r.key === made.key && r.status === "confirmed");
    expect(mine.length, "the create's confirmation was not handed over exactly once").toBe(1);
    expect(keys(sent)).toEqual([made.key, made.key]);
    expect((await engine.flushPending()).filter((r) => r.key === made.key)).toEqual([]);
  });

  it("6 — a send that never answers: past the ceiling only its barrier goes, and it is never sent again beside its open request", async () => {
    const { engine, sent } = await scene((m) => (m.kind === "mail_send" ? "hang" : "ok"));
    const press = engine.mutate({
      kind: "mail_send", inReplyTo: null, mailboxId: "mb_1", subject: "plans", body: "attached",
      to: [{ name: null, address: "to@example.invalid" }], cc: [], bcc: [],
    } as unknown as EngineMutation);
    await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1);
    const s = await press;
    expect(s.status).toBe("queued");
    const b = await engine.mutate(discard("d1"));
    expect(b.status).toBe("queued");

    // Its surface keeps flushing on a `queued` answer, as `useMailSend` does; the clock runs meanwhile.
    for (let i = 0; i < 6; i++) {
      const flushed = engine.flushPending();
      await vi.advanceTimersByTimeAsync(OUTBOX_HOLD_CEILING_MS / 3);
      await flushed;
    }
    expect(keys(sent).filter((k) => k === s.key), "the send went out again beside its open request").toHaveLength(1);
    expect(keys(sent), "the change behind the send still waited past the ceiling").toContain(b.key);
    expect(engine.pendingMutations().map((p) => p.key), "the send was put back on the queue").not.toContain(s.key);
    expect(engine.inFlightMutations().map((p) => p.key), "the send's request stopped owning its entry").toEqual([s.key]);
    expect(sent.find((x) => x.kind === "mail_send")?.signal, "a send was handed a signal to stop it").toBeUndefined();
  });

  it("7 — the write the ceiling ends has its request stopped before the queue owns it again", async () => {
    const { engine, sent } = await scene((_m, n) => (n === 1 ? "hang" : "ok"), { autoReplay: false });
    const first = engine.mutate(decide("s1"));
    await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1);
    const a = await first;
    const signal = sent[0]!.signal;
    expect(signal, "the write went out with nothing to stop its request").toBeInstanceOf(AbortSignal);
    let queuedAtStop: boolean | null = null;
    signal!.addEventListener("abort", () => { queuedAtStop = engine.pendingMutations().some((p) => p.key === a.key); });
    await vi.advanceTimersByTimeAsync(OUTBOX_HOLD_CEILING_MS - OUTBOX_REPLAY_DEADLINE_MS - 2);
    expect(signal!.aborted, "the request was stopped while the engine still waited on it").toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(queuedAtStop, "the write went back on the queue with its request still free to be sent").toBe(false);
    expect(engine.pendingMutations().map((p) => p.key)).toEqual([a.key]);
  });
  it("8 — a create waiting out the hold is named by its row, and a take-back stops it for this session and the next", async () => {
    const { engine, store, sent } = await scene((m) => (m.kind === "draft_save" && m.draftId === "d1" ? "hang" : "ok"), { autoReplay: false });
    const edit = engine.mutate({ kind: "draft_save", draftId: "d1", mailboxId: "mb_1", subject: "Hi", body: "slow", to: [], cc: [], bcc: [] } as unknown as EngineMutation);
    await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1);
    expect((await edit).status, "the hung edit did not answer at its deadline").toBe("queued");
    const key = "create-key-1";
    const create = engine.mutate({ kind: "draft_save", draftId: null, mailboxId: "mb_1", subject: "Hi", body: "held", to: [], cc: [], bcc: [] } as unknown as EngineMutation, { key });
    await vi.advanceTimersByTimeAsync(1);
    const local = engine.read().list<EngineDraft>("draft").find((d) => d.body === "held")?.id ?? "no paint";
    expect(engine.pendingCreateOf(local), "the painted row of a create behind the hold named no create").toBe(key);
    expect(await engine.withdrawQueued(key), "the take-back of a create behind the hold did not say withdrawn").toBe("withdrawn");
    const onDisk = store.list<{ key: string; withdrawn?: boolean }>(OUTBOX_TYPE).filter((e) => e.key === key);
    expect(onDisk.every((e) => e.withdrawn === true), "the take-back left a row a reload replays").toBe(true);
    await vi.advanceTimersByTimeAsync(OUTBOX_HOLD_CEILING_MS + 1);
    expect((await create).status).toBe("rolled_back");
    expect(keys(sent), "the create went out after its take-back").not.toContain(key);
  });
});
