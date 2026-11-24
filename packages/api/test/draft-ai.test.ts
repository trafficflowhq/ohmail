import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { localRoutes } from "../src/routes/local.js";
import type { DraftInput, DraftPort } from "@trafficflow/core";
import {
  makeDeps, seedSession, seedThread, seedMessage, seedMailbox, req, FIXED_NOW,
} from "./helpers.js";
import { drafts, kbEntries, type AccessVerdict, type EntitlementsPort } from "@trafficflow/db";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/** A capturing mock DraftPort injected via makeDeps `over.drafter` (no network). */
function mockDrafter(): DraftPort & { calls: number; inputs: DraftInput[] } {
  const m = {
    calls: 0,
    inputs: [] as DraftInput[],
    async draft(input: DraftInput) {
      m.calls += 1;
      m.inputs.push(input);
      return { subject: "Re: your message", body: "AI-drafted reply.", rationale: "grounded in KB + thread" };
    },
  };
  return m;
}

describe("POST /messages/:id/draft — AI draft-from-history (Phase 3b)", () => {
  it("streams provisional words, then returns the saved draft and replays its receipt", async () => {
    let finish!: () => void;
    const writing = new Promise<void>((resolve) => { finish = resolve; });
    let calls = 0;
    const drafter: DraftPort = {
      async draft(_input, options) {
        calls++;
        options?.onPreview?.("Hello");
        await writing;
        return { body: "Hello again.", subject: "Re: Hello", rationale: "" };
      },
    };
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
    const session = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: session.accountId });
    const { id } = await seedMessage(db, { accountId: session.accountId, mailboxId });
    const buy = () => H(req("POST", `/messages/${id}/draft`, {
      bearer: session.token, headers: { Accept: "application/x-ndjson", "Idempotency-Key": "one-live-draft" },
    }), deps);

    const pending = buy();
    let first: Response;
    let remaining: Promise<ReadableStreamReadResult<Uint8Array>>;
    try {
      first = await pending;
      expect(first.headers.get("content-type")).toBe("application/x-ndjson");
      expect(first.headers.get("x-ohmail-account")).toBe(session.accountId);
      const reader = first.body!.getReader();
      const preview = await reader.read();
      expect(JSON.parse(new TextDecoder().decode(preview.value))).toEqual({ type: "preview", text: "Hello" });
      expect(await db.select({ id: drafts.id }).from(drafts)).toEqual([]);
      remaining = reader.read();
    } finally {
      finish();
    }
    const result = JSON.parse(new TextDecoder().decode((await remaining!).value));

    const replay = await buy();
    expect(replay.status).toBe(202);
    expect(replay.headers.get("x-sync-seq")).toBeTruthy();
    expect(result).toEqual({
      type: "result", status: 202, body: { draftId: expect.any(String) }, syncSeq: replay.headers.get("x-sync-seq"),
    });
    expect(await replay.json()).toEqual(result.body);
    expect(calls).toBe(1);
  });

  it("202 { draftId }, echoes X-Sync-Seq, stores a 'draft' (never sent), visible in /sync creates", async () => {
    const drafter = mockDrafter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
    const s = await seedSession(db, { now: FIXED_NOW });
    const threadId = await seedThread(db, { accountId: s.accountId, subject: "Refund" });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    // KB entry the retrieval should surface + a prior thread message for context.
    await db.insert(kbEntries).values({
      accountId: s.accountId, title: "Refund policy", content: "We refund purchases within 30 days.",
    });
    // KbService.retrieve is websearch_to_tsquery (AND-semantics): the query
    // (subject+snippet) tokens must all be in the KB doc to match.
    const { id: target } = await seedMessage(db, {
      accountId: s.accountId, mailboxId, threadId, subject: "Refund policy", snippet: "refund within 30 days",
    });
    await seedMessage(db, {
      accountId: s.accountId, mailboxId, threadId, snippet: "PRIOR-THREAD-SNIPPET",
      fromAddress: "me@lichtgrat.example", date: new Date(FIXED_NOW.getTime() - 1000),
    });

    const res = await H(req("POST", `/messages/${target}/draft`, { bearer: s.token }), deps);
    expect(res.status).toBe(202);
    expect(res.headers.get("x-sync-seq")).toBeTruthy();
    const { draftId } = await res.json();
    expect(draftId).toBeTruthy();
    expect(drafter.calls).toBe(1);

    // The drafter received the KB entry + the thread sibling snippet.
    const input = drafter.inputs[0]!;
    expect(input.context.kbEntries.map((e) => e.title)).toContain("Refund policy");
    expect(input.context.threadMessages.map((t) => t.snippet)).toContain("PRIOR-THREAD-SNIPPET");

    // Stored, not sent: GET the draft → status 'draft' with the AI body + linkage.
    const got = await H(req("GET", `/drafts/${draftId}`, { bearer: s.token }), deps);
    expect(got.status).toBe(200);
    const draft = await got.json();
    expect(draft.status).toBe("draft");
    expect(draft.body).toBe("AI-drafted reply.");
    expect(draft.rationale).toBe("grounded in KB + thread");
    expect(draft.inReplyToMessageId).toBe(target);

    // Visible in /sync creates as a `draft` entity (no tombstone).
    const sync = await H(req("GET", "/sync?since=0", { bearer: s.token }), deps);
    const body = await sync.json();
    const create = body.changes.creates.find((c: { id: string }) => c.id === draftId);
    expect(create).toBeDefined();
    expect(create.type).toBe("draft");
    expect(body.changes.deletes.find((d: { id: string }) => d.id === draftId)).toBeUndefined();
  });

  it("replays the same draft receipt and sync sequence without buying another draft", async () => {
    const drafter = mockDrafter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const { id: target } = await seedMessage(db, { accountId: s.accountId, mailboxId });
    const purchase = () => H(req("POST", `/messages/${target}/draft`, {
      bearer: s.token, headers: { "Idempotency-Key": "one-draft-press" },
    }), deps);

    const first = await purchase();
    expect(first.status).toBe(202);
    const receipt = await first.json();
    expect(receipt).toEqual({ draftId: expect.any(String) });
    const seq = first.headers.get("x-sync-seq");
    expect(seq).toBeTruthy();

    const replay = await purchase();
    expect(replay.status).toBe(202);
    expect(replay.headers.get("x-sync-seq")).toBe(seq);
    expect(await replay.json()).toEqual(receipt);
    expect(drafter.calls).toBe(1);
  });

  it("a no_ai target → 422 and the drafter is NEVER called (0 calls)", async () => {
    const drafter = mockDrafter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id: target } = await seedMessage(db, { accountId: s.accountId, noAi: true });

    const res = await H(req("POST", `/messages/${target}/draft`, { bearer: s.token }), deps);
    expect(res.status).toBe(422);
    expect(drafter.calls).toBe(0);
    expect((await res.json()).error.code).toBe("sensitive_no_ai");
  });

  it("a sensitive (sensitivity_category) target → 422, 0 calls", async () => {
    const drafter = mockDrafter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id: target } = await seedMessage(db, { accountId: s.accountId, sensitivityCategory: "otp" });

    const res = await H(req("POST", `/messages/${target}/draft`, { bearer: s.token }), deps);
    expect(res.status).toBe(422);
    expect(drafter.calls).toBe(0);
  });

  it("no drafter wired → 503 drafter_unconfigured (retryable:false), not 500 internal", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id: target } = await seedMessage(db, { accountId: s.accountId });
    // A rules-only deployment: legitimate (a preview, a local run), so the host is NOT broken
    // and must not report itself as such. This used to be `500 internal`, which logged a healthy
    // deployment as failing and gave the client no code to render.
    const noAi: ApiDeps = { ...deps, services: { ...deps.services!, drafter: undefined } };

    const res = await H(req("POST", `/messages/${target}/draft`, { bearer: s.token }), noAi);
    expect(res.status).toBe(503);
    const body = await res.json();
    // The SAME code the workflow enqueue refusal uses — one condition, one code to render.
    expect(body.error.code).toBe("drafter_unconfigured");
    expect(body.error.retryable).toBe(false);
  });

  it("a no_kb thread sibling is structurally excluded from the DraftInput", async () => {
    const drafter = mockDrafter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
    const s = await seedSession(db, { now: FIXED_NOW });
    const threadId = await seedThread(db, { accountId: s.accountId });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const { id: target } = await seedMessage(db, {
      accountId: s.accountId, mailboxId, threadId, subject: "advise", snippet: "target",
      date: new Date(FIXED_NOW.getTime() + 3000),
    });
    await seedMessage(db, {
      accountId: s.accountId, mailboxId, threadId, snippet: "NORMAL-SNIPPET",
      date: new Date(FIXED_NOW.getTime() + 1000),
    });
    await seedMessage(db, {
      accountId: s.accountId, mailboxId, threadId, snippet: "NOKB-SNIPPET", noKb: true,
      date: new Date(FIXED_NOW.getTime() + 2000),
    });

    const res = await H(req("POST", `/messages/${target}/draft`, { bearer: s.token }), deps);
    expect(res.status).toBe(202);
    const snippets = drafter.inputs[0]!.context.threadMessages.map((t) => t.snippet);
    expect(snippets).toContain("NORMAL-SNIPPET");
    expect(snippets).not.toContain("NOKB-SNIPPET");
  });

  it("cross-account target → 404", async () => {
    const drafter = mockDrafter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
    const owner = await seedSession(db, { now: FIXED_NOW, token: "ai-owner" });
    const other = await seedSession(db, { now: FIXED_NOW, token: "ai-other" });
    const { id: target } = await seedMessage(db, { accountId: owner.accountId });

    const res = await H(req("POST", `/messages/${target}/draft`, { bearer: other.token }), deps);
    expect(res.status).toBe(404);
    expect(drafter.calls).toBe(0);
  });
});

/**
 * SEC-5 — THE SCREEN OVER THE JOINED PAYLOAD, driven through the route that runs it.
 *
 * The `no_ai`/sensitive refusal above reads ingest FLAGS; this reads the bytes about to be sent.
 * A credential written across a subject and a snippet satisfies every one of those flags, so
 * before the door the drafter was called and a draft carrying it came back.
 */
describe("POST /messages/:id/draft — a credential split across two fields", () => {
  /** Invented, in the shape providers use. Each half is admitted on its own (asserted below). */
  const SPLIT = { subject: "Your passphrase", snippet: "It is 481920, on the label." };

  it("422 with the reason class, no draft, and the drafter is never called", async () => {
    const drafter = mockDrafter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id: target } = await seedMessage(db, { accountId: s.accountId, ...SPLIT });

    const res = await H(req("POST", `/messages/${target}/draft`, { bearer: s.token }), deps);
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.code).toBe("credential_screened");
    expect(error.details).toEqual({ reason: "credential_shape" });
    // THE PERSON'S HALF: the webapp renders `message` verbatim, so this sentence is the product.
    expect(error.message).toBe(
      "this message contains something that looks like a credential, so no draft was generated");

    expect(drafter.calls, "the model was asked anyway").toBe(0);
    expect(await db.select().from(drafts), "a draft was stored for a refused request").toHaveLength(0);
  });

  it("neither half alone is refused — so the 422 is about the JOIN, not the words", async () => {
    for (const half of [{ subject: SPLIT.subject }, { snippet: SPLIT.snippet }]) {
      const drafter = mockDrafter();
      const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
      const s = await seedSession(db, { now: FIXED_NOW });
      const { id: target } = await seedMessage(db, { accountId: s.accountId, ...half });

      const res = await H(req("POST", `/messages/${target}/draft`, { bearer: s.token }), deps);
      expect(res.status, JSON.stringify(half)).toBe(202);
      expect(drafter.calls).toBe(1);
    }
  });

  it("refuses a split carried by the KB GROUNDING, which the target itself does not hold", async () => {
    const drafter = mockDrafter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const { id: target } = await seedMessage(db, {
      accountId: s.accountId, mailboxId, subject: "Router passphrase", snippet: "label",
    });

    // THE CONTROL FIRST: this target's own join is admitted, so the refusal below is the KB's.
    const before = await H(req("POST", `/messages/${target}/draft`, { bearer: s.token }), deps);
    expect(before.status, "the target alone already refuses — the case proves nothing").toBe(202);

    // The retrieval is websearch_to_tsquery (AND): the query's tokens must all be in the entry.
    await db.insert(kbEntries).values({
      accountId: s.accountId, title: `Router ${SPLIT.subject}`, content: SPLIT.snippet,
    });
    const res = await H(req("POST", `/messages/${target}/draft`, { bearer: s.token }), deps);
    expect(res.status).toBe(422);
    expect((await res.json()).error.code).toBe("credential_screened");
    expect(drafter.calls, "only the admitted first request reached the model").toBe(1);
  });
});

describe("POST /drafts/from-text — a draft from the person's own words", () => {
  const post = (body: unknown, token: string): Request => req("POST", "/drafts/from-text", { bearer: token, body: JSON.stringify(body) });

  it("202 { draftId } with X-Sync-Seq: the words reach the drafter, the draft is stored in the mailbox named, never sent", async () => {
    const drafter = mockDrafter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const res = await H(post({ text: "ask Ines for the signed contract", mailboxId, subject: "Contract" }, s.token), deps);
    expect(res.status).toBe(202);
    expect(res.headers.get("x-sync-seq")).toBeTruthy();
    const { draftId } = await res.json();
    expect(drafter.inputs[0]!.own).toEqual({ text: "ask Ines for the signed contract", replying: false, subject: "Contract" });
    const got = await (await H(req("GET", `/drafts/${draftId}`, { bearer: s.token }), deps)).json();
    expect([got.status, got.mailboxId, got.subject, got.inReplyToMessageId]).toEqual(["draft", mailboxId, "Contract", null]);
  });

  it("metered: no Idempotency-Key is a 400 before anything is read or asked", async () => {
    const drafter = mockDrafter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
    const s = await seedSession(db, { now: FIXED_NOW });
    // A metered composition whose every answer is open: what is refused is the missing key alone.
    const access = async (): Promise<AccessVerdict> => ({ ok: true, limits: { mailboxes: 5, storageBytes: 1_000, canAddMailbox: true, aiEnabled: true } });
    const port: EntitlementsPort = {
      access, accessOrFault: access,
      spend: async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key }),
      release: async () => "settled" as const, manageLink: async () => null, releaseAccount: async () => "none",
    };
    const metered: ApiDeps = { ...deps, services: { ...deps.services!, entitlementsPort: port } };
    const res = await H(post({ text: "hello" }, s.token), metered);
    expect([res.status, (await res.json()).error.code]).toEqual([400, "idempotency_key_required"]);
    expect(drafter.calls).toBe(0);
  });

  it("no drafter wired is a 503 drafter_unconfigured; an unverified account is refused before it", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const noAi: ApiDeps = { ...deps, services: { ...deps.services!, drafter: undefined } };
    const res = await H(post({ text: "hello", mailboxId }, s.token), noAi);
    expect([res.status, (await res.json()).error.code]).toEqual([503, "drafter_unconfigured"]);
    const u = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false });
    const refused = await H(post({ text: "hello", mailboxId }, u.token), deps);
    expect([refused.status, (await refused.json()).error.code]).toEqual([403, "email_unverified"]);
  });

  it("the desktop's own table serves it too, unmetered, on the desktop's own drafter", async () => {
    const drafter = mockDrafter();
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { drafter });
    const s = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: s.accountId });
    const local = createApp(localRoutes);
    const res = await local.handle(post({ text: "hello", mailboxId }, s.token), { ...deps, session: null, idempotency: null });
    expect(res.status).toBe(202);
    expect(drafter.calls).toBe(1);
  });
});
