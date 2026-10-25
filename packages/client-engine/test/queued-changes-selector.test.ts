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
 * the error not carried → case 2 red; the kept snapshot dropped → case 3 red; a create's row painted
 * without its key → cases 5 to 7 red; a create waiting at the gate out of the take-back → case 6 red;
 * a write naming a waiting create's row sent or painted → case 7 red.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine, OUTBOX_TYPE, type EngineDraft, type EngineMutation,
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
async function scene(answer: (m: EngineMutation) => MutationRejectedError | null | Promise<MutationRejectedError | null>) {
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
        const refusal = await answer(m);
        if (refusal) throw refusal;
        if (m.kind === "draft_save" && m.draftId === null) {
          const id = `row-${++seq}`;
          const entity = { ...draft(id), contentRevision: `rev-${id}` };
          return { changes: [{ type: "draft", op: "create", id, seq, updatedAt: NOW, entity }], seq, entityId: id };
        }
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

  it("4 — a create confirmed on the reconnect flush names its row by key; an update names none", async () => {
    let off = true;
    const { engine } = await scene(() => (off ? offline() : null));
    const create = await engine.mutate({
      kind: "draft_save", draftId: null, mailboxId: "mb_1", subject: "Hi", body: "x", to: [], cc: [], bcc: [],
    } as unknown as EngineMutation);
    const update = await engine.mutate({
      kind: "draft_save", draftId: "d1", mailboxId: "mb_1", subject: "Hi", body: "y", to: [], cc: [], bcc: [],
    } as unknown as EngineMutation);
    expect(engine.createdDraftOf(create.key), "a queued create named a row").toBeNull();
    let heard = 0;
    engine.subscribe(() => { heard += 1; });
    off = false;
    await engine.flushPending();
    const made = engine.createdDraftOf(create.key);
    expect(made, "the flushed create's row was not kept for its editor").toEqual({ id: expect.stringMatching(/^row-/), revision: `rev-${made?.id}` });
    expect(engine.createdDraftOf(update.key), "an update was recorded as a create").toBeNull();
    expect(heard, "nobody was told the row landed").toBeGreaterThan(0);
  });

  it("5 — a waiting create's local row names its key until it lands; a row the server holds names none", async () => {
    let off = true;
    const { engine } = await scene(() => (off ? offline() : null));
    const create = await engine.mutate({
      kind: "draft_save", draftId: null, mailboxId: "mb_1", subject: "Hi", body: "local", to: [], cc: [], bcc: [],
    } as unknown as EngineMutation);
    const local = engine.read().list<{ id: string; body: string }>("draft").find((d) => d.body === "local")!.id;
    expect(engine.pendingCreateOf(local)).toBe(create.key);
    expect(engine.pendingCreateOf("d1"), "a held row named a create").toBeNull();
    off = false;
    await engine.flushPending();
    expect(engine.pendingCreateOf(local), "a landed create still named its local row").toBeNull();
  });
  it("6 — a create waiting its turn behind a save on the wire carries its key, and is taken back before it leaves", async () => {
    let release: () => void = () => {};
    const hung = new Promise<null>((r) => { release = () => r(null); });
    const wire: EngineMutation[] = [];
    const { engine, store } = await scene((m) => { wire.push(m); return m.kind === "draft_save" && m.draftId === "d1" ? hung : null; });
    const edit = engine.mutate({ kind: "draft_save", draftId: "d1", mailboxId: "mb_1", subject: "Hi", body: "slow", to: [], cc: [], bcc: [] } as unknown as EngineMutation);
    const key = "create-at-the-gate";
    const create = engine.mutate({ kind: "draft_save", draftId: null, mailboxId: "mb_1", subject: "Hi", body: "waits", to: [], cc: [], bcc: [] } as unknown as EngineMutation, { key });
    await new Promise((r) => setTimeout(r, 10));
    const local = engine.read().list<EngineDraft>("draft").find((d) => d.body === "waits")?.id ?? "no paint";
    expect(engine.pendingCreateOf(local), "a create waiting at the gate named no key").toBe(key);
    expect(await engine.withdrawQueued(key), "a create waiting at the gate was not taken back").toBe("withdrawn");
    expect(store.list<{ key: string; withdrawn?: boolean }>(OUTBOX_TYPE).filter((e) => e.key === key).every((e) => e.withdrawn === true)).toBe(true);
    release();
    await edit;
    expect((await create).status).toBe("rolled_back");
    expect(wire.filter((m) => m.kind === "draft_save" && m.draftId === null), "the create went out after its take-back").toHaveLength(0);
  });

  it("7 — an update, a discard and a send naming a waiting create's row are answered not found, and nothing goes", async () => {
    const wire: EngineMutation[] = [];
    let off = true;
    const { engine } = await scene((m) => { wire.push(m); return off ? offline() : null; });
    await engine.mutate({ kind: "draft_save", draftId: null, mailboxId: "mb_1", subject: "Hi", body: "local", to: [], cc: [], bcc: [] } as unknown as EngineMutation);
    const local = engine.read().list<EngineDraft>("draft").find((d) => d.body === "local")!.id;
    wire.length = 0;
    off = false;
    const answers = [
      await engine.mutate({ kind: "draft_save", draftId: local, mailboxId: "mb_1", subject: "Hi", body: "newer", to: [], cc: [], bcc: [] } as unknown as EngineMutation),
      await engine.mutate({ kind: "draft_discard", draftId: local } as EngineMutation),
      await engine.mutate({ kind: "mail_send", inReplyTo: null, draftId: local, mailboxId: "mb_1", subject: "Hi", body: "newer", to: [{ name: null, address: "ann@example.invalid" }] } as unknown as EngineMutation),
    ];
    expect(answers.map((a) => [a.status, a.error?.status, a.error?.code])).toEqual([
      ["rolled_back", 404, "not_found"], ["rolled_back", 404, "not_found"], ["rolled_back", 404, "not_found"],
    ]);
    expect(wire, "a write naming the unconfirmed local id went out").toEqual([]);
    expect(engine.read().get<EngineDraft>("draft", local)?.body, "the refused update was painted").toBe("local");
  });
});
