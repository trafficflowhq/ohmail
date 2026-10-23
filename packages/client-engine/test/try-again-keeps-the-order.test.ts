/**
 * TRY AGAIN DOES NOT SEND A NEWER CHANGE BESIDE AN OLDER ONE THE SERVER MAY STILL BE APPLYING.
 *
 * Review of PR #201: a person's Try again ended a hung write's wait at any moment past the replay
 * deadline, without stopping its request. Inside the API's own limit (`maxDuration`, 60 s) the
 * server may still be working on that request, so the newer change pressed behind it went out
 * first and the older one landed after it: a message moved to News and back ended in News, a read
 * then unread ended read, a draft ended at its older words. On main Try again sent nothing until
 * the request settled, and every case ended as the person left it.
 *
 * The server below applies each request when it answers; the first write answers at 30 s. Try
 * again is pressed at 15 s. Both shapes: the web's (the engine replays) and the phone's (the host
 * flushes), and both roads: a queued change's Try again and a given-up one's. Mutations: `endHold`
 * without its age check → every pressed case red; the waiting press keeping its own backoff → the
 * backoff case red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine, OUTBOX_HOLD_CEILING_MS, OUTBOX_MAX_SERVER_FAILURES,
  OUTBOX_REPLAY_DEADLINE_MS, OUTBOX_TRY_AGAIN_ENDS_HOLD_MS, type EngineMutation,
} from "@ohmail/client-engine";

const NOW = "2026-10-23T09:00:00.000Z";
const FIRST_LANDS_MS = 30_000;

const message = (id: string) => ({
  id, accountId: "acct_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: `subject of ${id}`, from: { name: "Cy", address: "cy@example.invalid" },
  to: [], cc: [], date: NOW, folder: "INBOX", snippet: "…", unread: true,
  hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: NOW,
});
const draft = (id: string) => ({
  id, mailboxId: "mb_1", threadId: null, inReplyToMessageId: null, subject: "Plans", body: "v0",
  to: [], cc: [], bcc: [], rationale: null, status: "draft", createdAt: NOW, updatedAt: NOW,
});

/** The server's own state, changed when a request is applied, which is when it answers. */
interface ServerState { folder: string; unread: boolean; body: string }

/** How the server meets the n-th request: applied at 30 s, never answered, refused with a 500, or applied at once. */
type Plan = (m: EngineMutation, n: number) => "slow" | "dead" | "fail" | "ok";
const FIRST_SLOW: Plan = (_m, n) => (n === 1 ? "slow" : "ok");

async function world(opts: { autoReplay: boolean; plan?: Plan }) {
  const store = new MemoryMirrorStore();
  await store.load();
  const server: ServerState = { folder: "INBOX", unread: true, body: "v0" };
  const sent: Array<{ kind: string; key: string; at: number }> = [];
  const t0 = Date.now();
  const apply = (m: EngineMutation): void => {
    if (m.kind === "move") server.folder = m.folder;
    if (m.kind === "mark_seen") server.unread = m.unread;
    if (m.kind === "draft_save") server.body = m.body;
  };
  let seq = 0;
  const engine = new OhmailEngine({
    store,
    ...(opts.autoReplay ? {} : { outboxAutoReplay: false }),
    adapter: {
      sync: async () => ({
        changes: {
          creates: seq > 0 ? [] : [
            { type: "message", id: "m1", entity: message("m1") },
            { type: "draft", id: "d1", entity: draft("d1") },
          ].map((c) => ({ ...c, op: "create", seq: ++seq, updatedAt: NOW })),
          updates: [], moves: [], deletes: [],
        },
        cursor: String(seq), hasMore: false, serverTime: NOW,
      }),
      fetchBody: async () => null,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      mutate: async (m: EngineMutation, o: { idempotencyKey: string }) => {
        const n = sent.push({ kind: m.kind, key: o.idempotencyKey, at: Date.now() - t0 });
        const how = (opts.plan ?? FIRST_SLOW)(m, n);
        if (how === "dead") return new Promise(() => { /* the dead socket */ });
        if (how === "fail") throw new MutationRejectedError("the server failed", { status: 500, code: "internal", retryable: true });
        if (how === "slow") {
          // Slow, not dead: the server applies it at 30 s, inside its own limit.
          return new Promise((resolve) => setTimeout(() => { apply(m); resolve({ changes: [], seq: null }); }, FIRST_LANDS_MS));
        }
        apply(m);
        return { changes: [], seq: null };
      },
    } as never,
  });
  await engine.start();
  return { engine, server, sent };
}

const saveDraft = (body: string): EngineMutation =>
  ({ kind: "draft_save", draftId: "d1", mailboxId: "mb_1", subject: "Plans", body, to: [], cc: [], bcc: [] }) as EngineMutation;

/** Each pair: the first change (slow), the newer one on the same field, and what the server must end at. */
const PAIRS: Array<{ name: string; first: EngineMutation; newer: EngineMutation; ends: (s: ServerState) => unknown; want: unknown }> = [
  {
    name: "a move to News, then back to the Inbox",
    first: { kind: "move", messageId: "m1", folder: "ohmail/News" } as EngineMutation,
    newer: { kind: "move", messageId: "m1", folder: "INBOX" } as EngineMutation,
    ends: (s) => s.folder, want: "INBOX",
  },
  {
    name: "read, then unread",
    first: { kind: "mark_seen", messageIds: ["m1"], unread: false } as EngineMutation,
    newer: { kind: "mark_seen", messageIds: ["m1"], unread: true } as EngineMutation,
    ends: (s) => s.unread, want: true,
  },
  {
    name: "a draft's words, then newer words",
    first: saveDraft("v1"), newer: saveDraft("v2"),
    ends: (s) => s.body, want: "v2",
  },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.useRealTimers(); });

describe("the press waits while the server may still be working on the hung write", () => {
  it("the age a press needs is the API's own limit, and the ceiling is past it", () => {
    const route = readFileSync(
      fileURLToPath(new URL("../../../apps/api-vercel/app/[[...path]]/route.ts", import.meta.url)), "utf8",
    );
    const maxDuration = Number(/export const maxDuration = (\d+)/.exec(route)?.[1]);
    expect(maxDuration, "the API's maxDuration could not be read").toBeGreaterThan(0);
    expect(OUTBOX_TRY_AGAIN_ENDS_HOLD_MS, "a press may end a request the server is still working on")
      .toBeGreaterThanOrEqual(maxDuration * 1000);
    expect(OUTBOX_TRY_AGAIN_ENDS_HOLD_MS).toBeLessThan(OUTBOX_HOLD_CEILING_MS);
  });

  it("web: a press that waited its turn leaves when the barrier goes, its own backoff yielding to it", async () => {
    let failing = true;
    const { engine, sent } = await world({
      autoReplay: true,
      plan: (m) => (m.kind === "triage_set" ? (failing ? "fail" : "ok") : m.kind === "draft_save" ? "slow" : "ok"),
    });
    const change = await engine.mutate({ kind: "triage_set", messageId: "m1", state: "set_aside" } as EngineMutation);
    await engine.flushPending();
    await engine.flushPending(); // three counted failures: its own backoff runs for minutes
    failing = false;
    void engine.mutate(saveDraft("v1"));
    await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 5_000);

    const pressed = engine.retryQueued(change.id);
    await vi.advanceTimersByTimeAsync(10);
    expect((await pressed)?.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(FIRST_LANDS_MS);
    const after = sent.filter((s) => s.kind === "triage_set" && s.at >= FIRST_LANDS_MS);
    expect(after.map((s) => s.at < FIRST_LANDS_MS + 1_000), "the press sat out the change's own backoff after the barrier went")
      .toEqual([true]);
  });

  for (const shape of [{ autoReplay: true, label: "web" }, { autoReplay: false, label: "phone" }]) {
    describe(`${shape.label}: the first answers at 30 s, Try again at 15 s`, () => {
      for (const pair of PAIRS) {
        it(`${pair.name}: the server ends at the newer value`, async () => {
          const { engine, server, sent } = await world({ autoReplay: shape.autoReplay });
          const first = engine.mutate(pair.first);
          await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1);
          expect((await first).status, "the slow write did not become the hold").toBe("queued");
          await vi.advanceTimersByTimeAsync(1_000);
          const newer = await engine.mutate(pair.newer);
          expect(newer.status).toBe("queued");
          await vi.advanceTimersByTimeAsync(4_000);

          const pressed = engine.retryQueued(newer.id);
          await vi.advanceTimersByTimeAsync(10);
          expect((await pressed)?.status, "Try again did not wait its turn").toBe("queued");
          expect(sent.map((s) => s.kind), "the press went out beside a request the server may still apply")
            .toEqual([pair.first.kind]);

          await vi.advanceTimersByTimeAsync(FIRST_LANDS_MS);
          if (!shape.autoReplay) await engine.flushPending(); // the phone's host flushes after its drain
          await vi.advanceTimersByTimeAsync(10);
          expect(pair.ends(server), "the older change landed after the newer one").toEqual(pair.want);
          expect(sent.at(-1)!.at, "the newer change left before the older one was answered")
            .toBeGreaterThanOrEqual(FIRST_LANDS_MS);
          expect(engine.pendingMutations()).toEqual([]);
        });
      }

      it("CONTROL: nobody presses, and the move ends where the person left it", async () => {
        const { engine, server } = await world({ autoReplay: shape.autoReplay });
        void engine.mutate(PAIRS[0]!.first);
        await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1_000);
        await engine.mutate(PAIRS[0]!.newer);
        await vi.advanceTimersByTimeAsync(FIRST_LANDS_MS);
        if (!shape.autoReplay) await engine.flushPending();
        await vi.advanceTimersByTimeAsync(10);
        expect(server.folder).toBe("INBOX");
        expect(engine.pendingMutations()).toEqual([]);
      });

      it("Try again on a change ohmail gave up on waits its turn behind the hung write too", async () => {
        let failing = true;
        const { engine, sent } = await world({
          autoReplay: shape.autoReplay,
          plan: (m) => (m.kind === "triage_set" ? (failing ? "fail" : "ok") : m.kind === "draft_save" ? "slow" : "ok"),
        });
        const given = await engine.mutate({ kind: "triage_set", messageId: "m1", state: "set_aside" } as EngineMutation);
        for (let i = 1; i < OUTBOX_MAX_SERVER_FAILURES; i++) await engine.flushPending();
        expect(engine.abandoned().map((a) => a.id), "the change was not given up on").toEqual([given.id]);
        failing = false;

        void engine.mutate(saveDraft("v1"));
        await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 5_000);
        const before = sent.length;
        const pressed = engine.retryAbandoned(given.id);
        await vi.advanceTimersByTimeAsync(10);
        expect((await pressed).status, "Try again sent a given-up change beside the hung write").toBe("queued");
        expect(sent.length).toBe(before);

        await vi.advanceTimersByTimeAsync(FIRST_LANDS_MS);
        if (!shape.autoReplay) await engine.flushPending();
        await vi.advanceTimersByTimeAsync(10);
        expect(sent.filter((s) => s.kind === "triage_set").at(-1)!.at, "it left before the hung write was answered")
          .toBeGreaterThanOrEqual(FIRST_LANDS_MS);
        expect(engine.abandoned()).toEqual([]);
        expect(engine.pendingMutations()).toEqual([]);
      });

      it("CONTROL: past the API's limit, a press on a write that never answers sends the newer change at once", async () => {
        const { engine, server, sent } = await world({ autoReplay: shape.autoReplay, plan: (_m, n) => (n === 1 ? "dead" : "ok") });
        void engine.mutate(PAIRS[0]!.first);
        await vi.advanceTimersByTimeAsync(OUTBOX_REPLAY_DEADLINE_MS + 1_000);
        const newer = await engine.mutate(PAIRS[0]!.newer);
        await vi.advanceTimersByTimeAsync(OUTBOX_TRY_AGAIN_ENDS_HOLD_MS - OUTBOX_REPLAY_DEADLINE_MS);
        expect(sent).toHaveLength(1);
        const pressed = engine.retryQueued(newer.id);
        await vi.advanceTimersByTimeAsync(10);
        // `null`: the drive the barrier's end starts took the press first (the web's shape).
        const r = await pressed;
        expect(r === null || r.status === "confirmed", `a press past the API's limit answered ${r?.status}`).toBe(true);
        expect(sent.map((s) => s.kind), "the newer change did not leave at the press").toEqual(["move", "move"]);
        expect(sent.at(-1)!.at).toBeLessThan(OUTBOX_HOLD_CEILING_MS);
        expect(server.folder).toBe("INBOX");
      });
    });
  }
});
