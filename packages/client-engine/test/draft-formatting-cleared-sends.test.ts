import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drafts } from "@trafficflow/db";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import {
  HttpAdapter, MemoryMirrorStore, OhmailEngine, withSignature, type EngineDraft, type FetchLike,
} from "@ohmail/client-engine";
import { draftEditOf } from "../../../apps/mobile/src/state/live.js";
import { FIXED_NOW, makeDeps, seedMailbox, seedSession } from "../../api/test/helpers.js";

/**
 * A DRAFT WHOSE FORMATTING WAS REMOVED SAVES AND SENDS AS PLAIN TEXT.
 *
 * The editor reports no formatting as `html: ""`, and every builder dropped the key, so the save
 * went out as `body` alone. The server refuses a body-only edit of a formatted row (400
 * `validation_failed`, rightly), so the save before Send failed and nothing was ever sent. The
 * editor now says `html: null`; the engine keeps it only for a row its mirror holds as formatted,
 * so every plain request stays what it was. The real engine and HttpAdapter over the real API, on
 * both stores (`vitest.sqlite.config.ts` lists this file: the desktop's and the phone's store).
 */
const app = createApp(apiRoutes);
const TO = [{ name: null, address: "lena@atelier.example" }];
const BOLD = "<p><strong>bold</strong></p>";

async function world() {
  const delivered: OutboundMessage[] = [];
  const wire: Array<{ method: string; path: string; body: Record<string, unknown> | null }> = [];
  /** `offline` throws as a dropped connection does; `fail503` answers PUTs 503; `loseAnswer` drops one PUT's answer. */
  const net = { offline: false, fail503: 0, loseAnswer: false };
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) { delivered.push(msg); return { providerMessageId: msg.messageId ?? "<none>" }; },
    async messageInSent() { return false; },
    async close() { /* nothing */ },
  });
  const { db, deps } = await makeDeps(FIXED_NOW, {}, { sendAdapter: factory });
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId });
  const fetchImpl: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    headers.set("authorization", `Bearer ${s.token}`);
    const raw = typeof init?.body === "string" ? init.body : null;
    const method = (init?.method ?? "GET").toUpperCase();
    wire.push({ method, path: new URL(String(url)).pathname, body: raw ? JSON.parse(raw) as Record<string, unknown> : null });
    if (net.offline) throw new TypeError("fetch failed");
    if (method === "PUT" && net.fail503 > 0) {
      net.fail503 -= 1;
      return new Response(JSON.stringify({ error: { code: "unavailable", message: "busy" } }), {
        status: 503, headers: { "content-type": "application/json", "retry-after": "60" },
      });
    }
    const res = await app.handle(new Request(url, { ...init, headers }), { ...(deps as ApiDeps), session: null, idempotency: null });
    if (method === "PUT" && net.loseAnswer) { net.loseAnswer = false; throw new TypeError("fetch failed"); }
    return res;
  };
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }), store, now: () => FIXED_NOW,
  });
  await engine.start();
  const row = async (id: string) => (await db.select().from(drafts).where(eq(drafts.id, id)))[0]!;
  const base = { mailboxId, subject: "Hi", to: TO, cc: [], bcc: [] };
  /** A draft whose body is bold, saved through the engine as the editor saves it. */
  const boldDraft = async (): Promise<string> => {
    const c = await engine.mutate({ kind: "draft_save", draftId: null, ...base, body: "x" });
    const id = c.entityId!;
    const b = await engine.mutate({ kind: "draft_save", draftId: id, ...base, body: "bold", html: BOLD });
    expect(b.status, "control: the bold save is taken").toBe("confirmed");
    return id;
  };
  const send = (draftId: string, body: string, html: string | null | undefined) => ({
    kind: "mail_send" as const, inReplyTo: null, draftId, mailboxId, threadId: null,
    subject: "Hi", body, ...(html !== undefined ? { html } : {}), to: TO, cc: [], bcc: [],
  });
  /** A second device on the same account: its own engine and mirror over the same API. */
  const another = async (): Promise<OhmailEngine> => {
    const other = new MemoryMirrorStore();
    await other.load();
    const e = new OhmailEngine({
      adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }), store: other, now: () => FIXED_NOW,
    });
    await e.start();
    return e;
  };
  /** Every draft row of the account. */
  const all = async () => db.select().from(drafts).where(eq(drafts.accountId, s.accountId));
  return { engine, mailboxId, delivered, fetchImpl, row, all, base, wire, boldDraft, send, net, another };
}

describe("a draft whose formatting was removed", () => {
  it("the save says html: null, and the formatted row becomes plain", async () => {
    const w = await world();
    const id = await w.boldDraft();
    const cleared = await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "plain now", html: null });
    expect(cleared.status, cleared.error?.message).toBe("confirmed");
    const after = await w.row(id);
    expect([after.body, after.html]).toEqual(["plain now", null]);
    expect(w.wire.filter((x) => x.method === "PUT").at(-1)!.body).toMatchObject({ body: "plain now", html: null });
  });

  it("Send delivers the plain text with the signature, no html part, and the row is sent", async () => {
    const w = await world();
    const id = await w.boldDraft();
    const r = await w.engine.mutate(withSignature(w.send(id, "plain now", null), "Anna", "<p><em>Anna</em></p>"));
    expect(r.status, r.error?.message).toBe("confirmed");
    expect(w.delivered.map((m) => [m.text, m.html ?? null])).toEqual([["plain now\n\nAnna", null]]);
    expect((await w.row(id)).status).toBe("sent");
    // The save before Send carries the change to plain under the send's own request.
    expect(w.wire.filter((x) => x.method === "PUT").at(-1)!.body).toMatchObject({ body: "plain now\n\nAnna", html: null });
  });

  it("a plain row: html: null puts no html key on any draft request", async () => {
    const w = await world();
    const c = await w.engine.mutate({ kind: "draft_save", draftId: null, ...w.base, body: "x", html: null });
    const id = c.entityId!;
    expect((await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "y", html: null })).status).toBe("confirmed");
    expect((await w.engine.mutate(w.send(id, "y", null))).status).toBe("confirmed");
    const writes = w.wire.filter((x) => x.path.startsWith("/drafts") && x.body !== null);
    expect(writes.length).toBeGreaterThanOrEqual(3);
    for (const x of writes) expect("html" in x.body!, `${x.method} ${x.path}`).toBe(false);
    expect(w.delivered.map((m) => [m.text, m.html ?? null])).toEqual([["y", null]]);
  });

  it("formatting from another device this mirror has not seen is never flattened: the save is refused", async () => {
    const w = await world();
    const c = await w.engine.mutate({ kind: "draft_save", draftId: null, ...w.base, body: "x" });
    const id = c.entityId!;
    const other = await w.fetchImpl(`http://localhost/drafts/${id}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "Hi", html: "<p><strong>theirs</strong></p>", to: TO, cc: [], bcc: [] }),
    });
    expect(other.status).toBe(200);
    const mine = await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "mine", html: null });
    expect([mine.status, mine.error?.status, mine.error?.code]).toEqual(["rolled_back", 400, "validation_failed"]);
    expect((await w.row(id)).html).toBe("<p><strong>theirs</strong></p>");
  });

  it("offline, two cleared saves queue: back online the row holds the last words, plain", async () => {
    // The second save must not read the first one's overlay as "already plain" and drop html: null,
    // then retire the only save that carried it: the replay was a body-only PUT, refused 400.
    const w = await world();
    const id = await w.boldDraft();
    w.net.offline = true;
    expect((await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "plain one", html: null })).status).toBe("queued");
    expect((await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "plain two", html: null })).status).toBe("queued");
    w.net.offline = false;
    const flushed = await w.engine.flushPending();
    expect(flushed.map((r) => [r.status, r.error?.code ?? null])).not.toContainEqual(["rolled_back", "validation_failed"]);
    const after = await w.row(id);
    expect([after.body, after.html]).toEqual(["plain two", null]);
  });

  it("the cleared save meets a 503, then Send: the plain text is delivered", async () => {
    const w = await world();
    const id = await w.boldDraft();
    w.net.fail503 = 1;
    expect((await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "plain now", html: null })).status).toBe("queued");
    const r = await w.engine.mutate(w.send(id, "plain now", null), { key: "send-after-503" });
    expect(r.status, r.error?.message).toBe("confirmed");
    expect(w.delivered.map((m) => [m.text, m.html ?? null])).toEqual([["plain now", null]]);
  });

  it("a formatted save whose answer was lost: the cleared saves queued after it still make the row plain", async () => {
    // The server took the bold save but the answer never came back, so the mirror still holds the
    // row as plain. The queued cleared save is what says it is formatted, and the save that retires
    // it must carry html: null on.
    const w = await world();
    const c = await w.engine.mutate({ kind: "draft_save", draftId: null, ...w.base, body: "x" });
    const id = c.entityId!;
    w.net.loseAnswer = true;
    expect((await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "bold", html: BOLD })).status).toBe("queued");
    expect((await w.row(id)).html).toBe(BOLD);
    w.net.offline = true;
    expect((await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "plain one", html: null })).status).toBe("queued");
    expect((await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "plain two", html: null })).status).toBe("queued");
    w.net.offline = false;
    await w.engine.flushPending();
    const after = await w.row(id);
    expect([after.body, after.html]).toEqual(["plain two", null]);
  });

  it("controls: bold kept sends formatted; never formatted sends plain", async () => {
    const w = await world();
    const id = await w.boldDraft();
    expect((await w.engine.mutate(w.send(id, "bold", BOLD))).status).toBe("confirmed");
    expect(w.delivered[0]!.html ?? "").toContain("<strong>bold</strong>");
    const p = await w.engine.mutate({ kind: "draft_save", draftId: null, ...w.base, body: "plain" });
    expect((await w.engine.mutate(w.send(p.entityId!, "plain", null))).status).toBe("confirmed");
    expect([w.delivered[1]!.text, w.delivered[1]!.html ?? null]).toEqual(["plain", null]);
  });

  it("control, the phone: a row made plain is one it edits, and its keep and send deliver plain text", async () => {
    const w = await world();
    const id = await w.boldDraft();
    await w.engine.syncOnce();
    expect(draftEditOf(w.engine.read().get<EngineDraft>("draft", id)!), "a formatted row is not the phone's to edit").toBeNull();
    expect((await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "plain now", html: null })).status).toBe("confirmed");
    await w.engine.syncOnce();
    expect(draftEditOf(w.engine.read().get<EngineDraft>("draft", id)!)).not.toBeNull();
    // The phone's keep and send arms carry no html key (apps/mobile/src/state/live.ts).
    expect((await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "from the phone" })).status).toBe("confirmed");
    const r = await w.engine.mutate(withSignature(w.send(id, "from the phone", undefined), "Anna"));
    expect(r.status, r.error?.message).toBe("confirmed");
    expect(w.delivered.map((m) => [m.text, m.html ?? null])).toEqual([["from the phone\n\nAnna", null]]);
  });
});

describe("one draft on two devices: a save on an outdated version is refused, never written over", () => {
  it("the stale save is refused draft_changed and the row keeps the other device's words", async () => {
    const w = await world();
    const c = await w.engine.mutate({ kind: "draft_save", draftId: null, ...w.base, body: "first" });
    const id = c.entityId!;
    const seen = c.revision!;
    const b = await w.another();
    await b.syncOnce();
    const theirs = await b.mutate({
      kind: "draft_save", draftId: id, ...w.base, body: "from the other device",
      ifContentRevision: b.read().get<EngineDraft>("draft", id)!.contentRevision,
    });
    expect(theirs.status, theirs.error?.message).toBe("confirmed");
    const mine = await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "typed here", ifContentRevision: seen });
    expect([mine.status, mine.error?.code]).toEqual(["rolled_back", "draft_changed"]);
    expect((await w.row(id)).body).toBe("from the other device");
  });

  it("saves queued offline on one version, then reconnect: none is refused, the row holds the last", async () => {
    const w = await world();
    const c = await w.engine.mutate({ kind: "draft_save", draftId: null, ...w.base, body: "first" });
    const id = c.entityId!;
    w.net.offline = true;
    for (const body of ["one", "two"]) {
      expect((await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body, ifContentRevision: c.revision! })).status).toBe("queued");
    }
    w.net.offline = false;
    const flushed = await w.engine.flushPending();
    expect(flushed.map((r) => r.error?.code ?? null)).not.toContain("draft_changed");
    expect((await w.row(id)).body).toBe("two");
  });

  it("a save whose answer was lost is replayed without a refusal", async () => {
    const w = await world();
    const c = await w.engine.mutate({ kind: "draft_save", draftId: null, ...w.base, body: "first" });
    const id = c.entityId!;
    w.net.loseAnswer = true;
    expect((await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "one", ifContentRevision: c.revision! })).status).toBe("queued");
    const flushed = await w.engine.flushPending();
    expect(flushed.map((r) => [r.status, r.error?.code ?? null])).toEqual([["confirmed", null]]);
    expect((await w.row(id)).body).toBe("one");
  });

  it("words that return to an earlier version: this client's next save and its send are taken", async () => {
    const w = await world();
    const c = await w.engine.mutate({ kind: "draft_save", draftId: null, ...w.base, body: "Hello" });
    const id = c.entityId!;
    let base = c.revision!;
    const codes: Array<string | null> = [];
    for (const body of ["Hello wo", "Hello world", "Hello", "Hello there"]) {
      const r = await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body, ifContentRevision: base });
      codes.push(r.error?.code ?? null);
      if (r.revision) base = r.revision;
    }
    const sent = await w.engine.mutate({ ...w.send(id, "Hello there", undefined), ifContentRevision: base });
    expect({ codes, sent: [sent.status, sent.error?.code ?? null], delivered: w.delivered.map((m) => m.text) })
      .toEqual({ codes: [null, null, null, null], sent: ["confirmed", null], delivered: ["Hello there"] });
  });

  it("a save queued offline, refused at reconnect because another device changed the row: its words become a new draft", async () => {
    const w = await world();
    const c = await w.engine.mutate({ kind: "draft_save", draftId: null, ...w.base, body: "first" });
    const id = c.entityId!;
    w.net.offline = true;
    const queued = await w.engine.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "typed offline", ifContentRevision: c.revision! });
    expect(queued.status).toBe("queued");
    w.net.offline = false;
    const b = await w.another();
    await b.syncOnce();
    expect((await b.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "from the other device" })).status).toBe("confirmed");
    await w.engine.flushPending();
    const bodies = (await w.all()).map((r) => (r.id === id ? `theirs: ${r.body}` : `new: ${r.body}`)).sort();
    const kept = w.engine.keptAsNewDrafts();
    expect({ bodies, kept: kept.map((k) => [k.from, k.key, k.row !== null && k.row !== id]) }).toEqual({
      bodies: ["new: typed offline", "theirs: from the other device"], kept: [[id, queued.key, true]],
    });
  });

  it("a kept edit that left the sender to its row keeps the row's sender", async () => {
    const w = await world();
    const c = await w.engine.mutate({ kind: "draft_save", draftId: null, ...w.base, body: "first" });
    const id = c.entityId!;
    w.net.offline = true;
    await w.engine.mutate({ kind: "draft_save", draftId: id, subject: "Hi", to: TO, cc: [], bcc: [], body: "typed offline", ifContentRevision: c.revision! });
    w.net.offline = false;
    const b = await w.another();
    await b.syncOnce();
    await b.mutate({ kind: "draft_save", draftId: id, ...w.base, body: "from the other device" });
    await w.engine.flushPending();
    expect((await w.all()).filter((r) => r.id !== id).map((r) => [r.body, r.mailboxId === w.mailboxId]))
      .toEqual([["typed offline", true]]);
  });
});
