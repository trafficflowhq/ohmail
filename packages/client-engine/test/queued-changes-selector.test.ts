/**
 * EVERY CHANGE WAITING ON THE QUEUE, WITH ITS OWN LAST ERROR.
 *
 * The Unsaved changes panel read `queuedDiscards()`, so while the outbox held a person's Screener
 * decisions they were listed nowhere ("it does not save my Screener decisions"), and every waiting
 * discard said "could not reach your account" whatever had actually gone wrong. `queuedChanges()`
 * lists every queued verb but the two a surface of their own settles (a send, a draft's first save),
 * each with the error its last attempt met, or `null` before any answer. `queuedDiscards()` is
 * unchanged: the phone reads it.
 * Mutations: the kind filter left as discards only → case 1 red; sends not excluded → case 1 red;
 * the error not carried → case 2 red; the kept snapshot dropped → case 3 red.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine, type EngineMutation,
} from "@ohmail/client-engine";

const NOW = "2026-10-23T09:00:00.000Z";
const held = (id: string, address: string) => ({
  id, accountId: "acct_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: `subject of ${id}`, from: { name: `Sender ${id}`, address },
  to: [], cc: [], date: NOW, folder: "ohmail/Screener", snippet: "…", unread: true,
  hasAttachments: false, attachmentCount: 0, sensitivity: {}, triage: null, labels: [],
  remoteContent: "none", updatedAt: NOW,
});
const draft = (id: string) => ({
  id, mailboxId: "mb_1", threadId: null, inReplyToMessageId: null, subject: `Draft ${id}`, body: "words",
  to: [], cc: [], bcc: [], rationale: null, status: "draft", createdAt: NOW, updatedAt: NOW,
});

/** Every request is answered by `answer(kind)`: a thrown refusal, or nothing (accepted). */
async function scene(answer: (m: EngineMutation) => MutationRejectedError | null) {
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  const engine = new OhmailEngine({
    store,
    now: () => new Date(NOW),
    adapter: {
      sync: async () => ({
        changes: {
          creates: seq > 0 ? [] : [
            { type: "message", id: "s1", entity: held("s1", "ada@example.invalid") },
            { type: "draft", id: "d1", entity: draft("d1") },
            { type: "draft", id: "d2", entity: draft("d2") },
          ].map((c) => ({ ...c, op: "create", seq: ++seq, updatedAt: NOW })),
          updates: [], moves: [], deletes: [],
        },
        cursor: String(seq), hasMore: false, serverTime: NOW,
      }),
      fetchBody: async () => null,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      mutate: async (m: EngineMutation) => {
        const refusal = answer(m);
        if (refusal) throw refusal;
        return { changes: [], seq: null };
      },
    } as never,
  });
  await engine.start();
  return { engine, store };
}

const offline = () => new MutationRejectedError("network failure", { code: "network", retryable: true });
const busy = () => new MutationRejectedError("the service is busy", { status: 503, code: "unavailable", retryable: true });

describe("queuedChanges — every change waiting on the queue", () => {
  it("1 — lists a decision, a rule and a discard; a send and a draft's first save stay with their own surface", async () => {
    const { engine } = await scene(() => offline());
    const decision = await engine.mutate({ kind: "screener_decide", senderId: "s1", decision: "yes", dest: "ohbox", scope: "sender" } as EngineMutation);
    const rule = await engine.mutate({ kind: "rule_create", ruleKind: "sender", match: "bo@example.invalid", destination: "INBOX" } as EngineMutation);
    const gone = await engine.mutate({ kind: "draft_discard", draftId: "d1" } as EngineMutation);
    const create = await engine.mutate({
      kind: "draft_save", draftId: null, mailboxId: "mb_1", subject: "Hi", body: "x", to: [], cc: [], bcc: [],
    } as unknown as EngineMutation);
    const send = await engine.mutate({
      kind: "mail_send", inReplyTo: null, draftId: "d2", mailboxId: "mb_1", to: [{ name: null, address: "cy@example.invalid" }], cc: [], bcc: [],
      subject: "Draft d2", body: "words",
    } as unknown as EngineMutation);
    expect([decision, rule, gone, create, send].map((r) => r.status), "a change did not queue").toEqual(
      ["queued", "queued", "queued", "queued", "queued"],
    );
    const listed = engine.queuedChanges();
    expect(listed.map((q) => [q.id, q.mutation.kind]), "the panel would not list what waits").toEqual([
      [decision.id, "screener_decide"], [rule.id, "rule_create"], [gone.id, "draft_discard"],
    ]);
    expect(Object.isFrozen(listed) && listed.every((q) => Object.isFrozen(q)), "a live entry was handed out").toBe(true);
    // The discard-only selector the phone reads is unchanged.
    expect(engine.queuedDiscards().map((q) => q.id)).toEqual([gone.id]);
  });

  it("2 — each carries the error its own last attempt met", async () => {
    const { engine } = await scene((m) => (m.kind === "rule_create" ? busy() : offline()));
    const rule = await engine.mutate({ kind: "rule_create", ruleKind: "sender", match: "bo@example.invalid", destination: "INBOX" } as EngineMutation);
    const gone = await engine.mutate({ kind: "draft_discard", draftId: "d1" } as EngineMutation);
    const byId = new Map(engine.queuedChanges().map((q) => [q.id, q.error]));
    expect(byId.get(rule.id), "the rule's own refusal was lost").toEqual({ code: "unavailable", message: "the service is busy", status: 503 });
    expect(byId.get(gone.id)?.code, "the discard's own failure was lost").toBe("network");
  });

  it("3 — one snapshot while nothing changed; a new error is a new snapshot", async () => {
    let refusal: () => MutationRejectedError = offline;
    const { engine } = await scene(() => refusal());
    const gone = await engine.mutate({ kind: "draft_discard", draftId: "d1" } as EngineMutation);
    const first = engine.queuedChanges();
    expect(engine.queuedChanges(), "an unchanged queue rebuilt its snapshot").toBe(first);
    refusal = busy;
    expect((await engine.retryQueued(gone.id))?.status).toBe("queued");
    const after = engine.queuedChanges();
    expect(after, "a changed error kept the old snapshot").not.toBe(first);
    expect(after[0]?.error?.code).toBe("unavailable");
  });
});
