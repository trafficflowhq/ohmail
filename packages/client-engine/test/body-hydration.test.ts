import { describe, expect, it, vi } from "vitest";
import {
  HttpAdapter,
  MemoryMirrorStore,
  OhmailEngine,
  bodyOf,
  type EngineAdapter,
  type EngineMessage,
  type MessageBodyRecord,
  type MutationOutcome,
  type SyncChange,
  type SyncResponse,
} from "../src/index.js";
import { FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * SLICE THE HYDRATION SEAM.
 *
 * The defect this slice closes was not a missing affordance. Every pile already had the
 * open/collapse interaction — `StreamCard`'s height clamp and its Expand pill, the Screener's
 * full-body preview — and the reason none of it appeared on a live account is that the wire
 * `MessageDTO` carries `snippet` and never `body`. So `m.body ?? m.snippet` had one branch,
 * every card measured "short", `.scast.short .sc-x{display:none}` hid the pill, and there was
 * no pill because there was nothing to expand. Meanwhile `GET /messages/:id/body` had existed
 * the whole time, spend-gated and contract-tested, with zero client callers.
 *
 * The three guards that matter are the ruling's own, in its order of risk:
 *
 *  1. **A delta apply must not wipe a hydrated body.** `applyToRecords` replaces the entity on
 *     `create|update`, and opening a message emits `mark_seen`, whose echo IS an update. The
 *     body therefore lives in a client-local `message_body` record that `/sync` has no
 *     vocabulary for. Invisible in fixtures — the demo's rows carry `body` already — so it is
 *     the client-side twin of this repo's PGlite blindness, and it is asserted here.
 *  2. **The absent branch must not stay the shipped branch.** A failure has to be visible and
 *     distinct from "this is the whole message", so a 500 produces a `failed` record rather
 *     than an empty body or a silent snippet.
 *  3. **Invariant #1.** The endpoint's text is already redacted and is stored verbatim; this
 *     client never re-derives a secret.
 */

const NOW = new Date("2026-08-03T12:00:00.000Z");

let seq = 0;

function msg(over: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject: `Subject ${over.id}`,
    from: { name: null, address: "sender@example.test" },
    to: [],
    cc: [],
    date: "2026-08-03T09:00:00.000Z",
    folder: "ohmail/News",
    snippet: `snippet of ${over.id}`,
    unread: true,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: NOW.toISOString(),
    ...over,
  };
}

/** A quiet `/sync` plus a scriptable body endpoint — the only two calls this slice makes. */
function adapterOf(body: (id: string) => Promise<{ text: string } | null>): EngineAdapter & { bodyCalls: string[] } {
  const bodyCalls: string[] = [];
  return {
    bodyCalls,
    sync: async (): Promise<SyncResponse> => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "0",
      hasMore: false,
      serverTime: NOW.toISOString(),
    }),
    mutate: async (): Promise<MutationOutcome> => ({ changes: [], seq: null }),
    fetchBody: async (id) => {
      bodyCalls.push(id);
      return body(id);
    },
  };
}

async function engineWith(
  messages: EngineMessage[],
  body: (id: string) => Promise<{ text: string } | null> = async (id) => ({ text: `FULL ${id}` }),
): Promise<{ engine: OhmailEngine; store: MemoryMirrorStore; adapter: { bodyCalls: string[] } }> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(
    messages.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
  );
  const adapter = adapterOf(body);
  return { engine: new OhmailEngine({ adapter, store, now: () => NOW }), store, adapter };
}

describe("bodyOf — the read-time merge every surface uses", () => {
  it("a message with no record is a SNIPPET, and never claims to be the message", async () => {
    // THE GUARD ON THE SHIPPED EXPRESSION. `m.body ?? m.snippet` produced this text and called
    // it the body. Red by returning a bare string: the caller loses the only way to tell a
    // truncation from a short email, which is exactly how the first body fetch shipped.
    const { store } = await engineWith([msg({ id: "m1" })]);
    const m = store.get<EngineMessage>("message", "m1")!;
    expect(bodyOf(store, m)).toEqual({ text: "snippet of m1", state: "snippet", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
  });

  it("a fixture row's own body wins, with no record and no request", async () => {
    // The demo world, and the reason `demo-zero-network.test.ts` still holds: `hydrateBody`
    // short-circuits on the same field this reads, so the two cannot disagree.
    const { engine, store, adapter } = await engineWith([msg({ id: "m1", body: "the whole letter" })]);
    await engine.hydrateBody("m1");
    const m = store.get<EngineMessage>("message", "m1")!;
    expect(bodyOf(store, m)).toEqual({ text: "the whole letter", state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
    expect(adapter.bodyCalls).toEqual([]);
    expect(store.get("message_body", "m1")).toBeUndefined();
  });

  it("hydrating turns it FULL, and the text is the endpoint's verbatim", async () => {
    const { engine, store, adapter } = await engineWith([msg({ id: "m1" })]);
    await engine.hydrateBody("m1");
    expect(adapter.bodyCalls).toEqual(["m1"]);
    const m = store.get<EngineMessage>("message", "m1")!;
    expect(bodyOf(store, m)).toEqual({ text: "FULL m1", state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
  });

  it("an empty body row reads as FULL rather than silently reverting to the snippet", async () => {
    /**
     * `getBody` answers `text: ""` for a message whose body row was never ingested. Reporting
     * that as `full` is deliberate: the snippet is DERIVED from the body at ingest, so a
     * populated snippet beside an empty body is not a state the pipeline produces — and
     * inventing a fallback for it would mean rendering a preview while calling it the whole
     * message, which is the exact claim this slice removes.
     */
    const { engine, store } = await engineWith([msg({ id: "m1" })], async () => ({ text: "" }));
    await engine.hydrateBody("m1");
    const m = store.get<EngineMessage>("message", "m1")!;
    expect(bodyOf(store, m)).toEqual({ text: "", state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
  });
});

describe("RISK 1 — a delta apply must not wipe a hydrated body", () => {
  it("an update carrying a server-shaped DTO leaves the body standing", async () => {
    /**
     * THE RULING'S FIRST RISK, and the one no fixture test could ever have seen.
     *
     * `applyToRecords` replaces the entity on `create|update` (`apply.ts:56-58`). Opening a
     * message emits `mark_seen`; its echo is an update carrying the server's DTO, which has
     * `snippet` and no `body`. With the fetched text written onto the message row, the act of
     * reading a message would erase the message being read — live only, timing-dependent, and
     * invisible in the demo because fixture rows carry `body` regardless.
     *
     * WATCHED RED: setting `entity: { ...before, body: "FULL m1" }` below (the message-record
     * variant) and dropping the `message_body` write makes `bodyOf` answer `snippet of m1`.
     */
    const { engine, store } = await engineWith([msg({ id: "m1" })]);
    await engine.hydrateBody("m1");
    expect(bodyOf(store, store.get<EngineMessage>("message", "m1")!).state).toBe("full");

    const before = store.get<EngineMessage>("message", "m1")!;
    await store.applyChanges([{
      type: "message",
      op: "update",
      id: "m1",
      seq: ++seq,
      updatedAt: NOW.toISOString(),
      entity: { ...before, unread: false },   // the wire's shape: snippet, no body
    }]);

    const after = store.get<EngineMessage>("message", "m1")!;
    // The delta landed — this test must not pass by the update having been dropped.
    expect(after.unread).toBe(false);
    expect(bodyOf(store, after)).toEqual({ text: "FULL m1", state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
  });

  it("a MOVE — the other echo a decision produces — leaves it standing too", async () => {
    // `screener_decide` and every filing key produce moves, not updates, and `applyToRecords`
    // takes a different branch for them (`apply.ts:50-53`). Both branches are asserted because
    // both are reachable from the act of reading and filing one message.
    const { engine, store } = await engineWith([msg({ id: "m1", folder: "ohmail/Screener" })]);
    await engine.hydrateBody("m1");
    await store.applyChanges([{
      type: "message",
      op: "move",
      id: "m1",
      seq: ++seq,
      updatedAt: NOW.toISOString(),
      move: { from: "ohmail/Screener", to: "INBOX" },
    }]);
    const after = store.get<EngineMessage>("message", "m1")!;
    expect(after.folder).toBe("INBOX");
    expect(bodyOf(store, after)).toEqual({ text: "FULL m1", state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
  });

  it("but a DELETED message takes its body with it — no orphaned text in the mirror", async () => {
    /**
     * The other side of "no delta may touch this record". The immunity that protects a body
     * mid-read would also leave the FULL TEXT of a deleted message in IndexedDB forever,
     * unreferenced and unreachable through any path the product offers — residue, against
     * The "Privacy of tiers" invariant's deletable-Cloud-data promise. So the cascade is structural, in the same
     * `persist` flush as the page that deleted the message.
     *
     * Red by removing the `cascadeLocalDeletes` call from `applyChanges`.
     */
    const { engine, store } = await engineWith([msg({ id: "m1" })]);
    await engine.hydrateBody("m1");
    expect(store.get<MessageBodyRecord>("message_body", "m1")?.text).toBe("FULL m1");

    await store.applyChanges([{
      type: "message", op: "delete", id: "m1", seq: ++seq, updatedAt: NOW.toISOString(),
    }]);
    expect(store.get("message", "m1")).toBeUndefined();
    expect(store.get("message_body", "m1")).toBeUndefined();
  });
});

describe("RISK 2 — the failure must be visible, and distinct from the whole message", () => {
  it("a 500-ing adapter produces FAILED, not an empty body and not a silent snippet", async () => {
    /**
     * The shipped branch, refused. `body ?? snippet` renders a truncation as the whole mail
     * with no signal — which is both how the first body fetch shipped and how a hydration failure would ship
     * again if a rejection resolved quietly.
     *
     * `state` carries the difference. The text stays the snippet, because it is the only text
     * there is; what changes is that the surface can now say so. Red by having
     * `fetchBodyInto`'s catch write a `ready` record, or `{text: ""}`: the assertion below
     * collapses to `full`.
     */
    const { engine, store } = await engineWith([msg({ id: "m1" })], async () => {
      throw new Error("HTTP 500");
    });
    await engine.hydrateBody("m1");

    const rec = store.get<MessageBodyRecord>("message_body", "m1")!;
    expect(rec.state).toBe("failed");
    expect(rec.error).toContain("500");
    const m = store.get<EngineMessage>("message", "m1")!;
    expect(bodyOf(store, m)).toEqual({ text: "snippet of m1", state: "failed", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
  });

  it("hydrateBody never rejects — a failed fetch is a record, not a throw at a React effect", async () => {
    // Every caller is an effect or a click handler. A rejection there is an unhandled promise
    // over somebody's mailbox; the outcome has to be something the UI can render instead.
    const { engine } = await engineWith([msg({ id: "m1" })], async () => {
      throw new Error("network down");
    });
    await expect(engine.hydrateBody("m1")).resolves.toBeUndefined();
  });

  it("a FAILED body is NOT re-asked automatically — an effect must not become a request loop", async () => {
    /**
     * FOUND BY A TEST, not by reasoning: `apps/webapp/test/body-open.test.ts` mounted a
     * 500-ing adapter under `ReadsView`, whose hydrate effect depends on the callback it is
     * given. A failed fetch writes a record → the mirror version moves → the view re-renders →
     * the effect re-runs → it asks again. Two of those tests ran until vitest killed them at
     * five seconds.
     *
     * On a live account that is a poll against a server already refusing, billed per attempt,
     * for as long as somebody leaves the view open — the "No API cost without revenue behind it" invariant, from the inside. The rule
     * is therefore about WHO asks: an automatic trigger asks once.
     *
     * Red by dropping the `!opts.retry` term from the `failed` short-circuit in `hydrateBody`:
     * `bodyCalls` becomes four.
     */
    const { engine, adapter } = await engineWith([msg({ id: "m1" })], async () => {
      throw new Error("HTTP 500");
    });
    await engine.hydrateBody("m1");
    await engine.hydrateBody("m1");
    await engine.hydrateBody("m1");
    await engine.hydrateBody("m1");
    expect(adapter.bodyCalls).toEqual(["m1"]);
  });

  it("…but a HUMAN asking again does ask again", async () => {
    // What makes the failed state an exit rather than a dead end: re-expanding a card, and the
    // Retry control in the reading pane and the Screener preview. All three pass `retry`.
    let attempt = 0;
    const { engine, store, adapter } = await engineWith([msg({ id: "m1" })], async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("HTTP 503");
      return { text: "FULL m1, second time" };
    });
    await engine.hydrateBody("m1");
    expect(bodyOf(store, store.get<EngineMessage>("message", "m1")!).state).toBe("failed");

    await engine.hydrateBody("m1", { retry: true });
    expect(adapter.bodyCalls).toEqual(["m1", "m1"]);
    expect(bodyOf(store, store.get<EngineMessage>("message", "m1")!))
      .toEqual({ text: "FULL m1, second time", state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
  });

  it("a READY body is not re-fetched even when a human asks", async () => {
    // `retry` widens the `failed` gate only. Re-expanding a card whose body is already on
    // screen must not spend a read to fetch text the mirror is holding.
    const { engine, adapter } = await engineWith([msg({ id: "m1" })]);
    await engine.hydrateBody("m1");
    await engine.hydrateBody("m1", { retry: true });
    expect(adapter.bodyCalls).toEqual(["m1"]);
  });

  it("a persisted LOADING record re-fetches — a dead tab must not leave a permanent spinner", async () => {
    /**
     * `message_body` records persist. A tab that dies mid-request leaves `loading` on disk with
     * no promise behind it, and deciding re-fetch from the RECORD's state would make that
     * permanent: a body stuck "loading" forever, with no control and no timeout.
     *
     * Dedup therefore lives in the engine's in-flight map, and the only state that suppresses a
     * fetch is `ready`. Red by changing the short-circuit to `state !== undefined`.
     */
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{
      type: "message", op: "create", id: "m1", seq: ++seq, updatedAt: NOW.toISOString(), entity: msg({ id: "m1" }),
    }]);
    // Exactly what a killed tab leaves behind.
    await store.putLocal("message_body", "m1", { messageId: "m1", state: "loading", text: "" });

    const adapter = adapterOf(async (id) => ({ text: `FULL ${id}` }));
    const engine = new OhmailEngine({ adapter, store, now: () => NOW });
    await engine.hydrateBody("m1");

    expect(adapter.bodyCalls).toEqual(["m1"]);
    expect(bodyOf(store, store.get<EngineMessage>("message", "m1")!).state).toBe("full");
  });
});

describe("hydrateBody — asked once, on intent, and never speculatively", () => {
  it("a READY body is not re-fetched", async () => {
    const { engine, adapter } = await engineWith([msg({ id: "m1" })]);
    await engine.hydrateBody("m1");
    await engine.hydrateBody("m1");
    await engine.hydrateBody("m1");
    expect(adapter.bodyCalls).toEqual(["m1"]);
  });

  it("concurrent callers join ONE request", async () => {
    /**
     * The Ohbox read column and the reader sheet render the same message at the same time
     * (`message-chrome.tsx`), so two surfaces wanting one body is the ordinary case rather
     * than a race. Red by dropping the in-flight map: `bodyCalls` becomes three entries and
     * a paying account is billed three reads for one open.
     */
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { engine, adapter } = await engineWith([msg({ id: "m1" })], async (id) => {
      await gate;
      return { text: `FULL ${id}` };
    });

    const all = Promise.all([engine.hydrateBody("m1"), engine.hydrateBody("m1"), engine.hydrateBody("m1")]);
    release!();
    await all;
    expect(adapter.bodyCalls).toEqual(["m1"]);
  });

  it("a message that is not in the mirror is not asked about", async () => {
    // A fixture `screener_sender`'s held ids are not message ids, and a row can be drained
    // away between a render and the effect that follows it.
    const { engine, adapter } = await engineWith([msg({ id: "m1" })]);
    await engine.hydrateBody("nobody");
    expect(adapter.bodyCalls).toEqual([]);
  });

  it("a SENSITIVE message IS asked about — its body is shown like any other", async () => {
    /**
     * Body withholding is removed (`isProtectedMessage` is a constant false), so a message flagged
     * sensitive is hydrated exactly like an ordinary one — the reader is entitled to their own code.
     * Mutation: restore `isProtectedMessage`'s live branch and `hydrateBody` short-circuits, so
     * `bodyCalls` is empty again — the withholding this slice removed.
     */
    const { engine, adapter } = await engineWith([msg({
      id: "otp",
      sensitivity: { sensitive: true, category: "otp", no_ai: true, no_forward: true, no_kb: true, priority: true },
    })]);
    await engine.hydrateBody("otp");
    expect(adapter.bodyCalls).toEqual(["otp"]);
  });

  it("the ENGINE never fetches a body on its own — no drain-time prefetch", async () => {
    /**
     * The "An unverified account must not be able to generate meaningful cost" invariant's posture, asserted rather than assumed: `read` is a permissive cost class,
     * which makes a pile-wide prefetch cheap to write and wrong to ship. A bootstrap of a real
     * mailbox is a great many messages; fetching their bodies because they arrived would be
     * a billed read each for mail nobody has looked at.
     *
     * Red by calling `hydrateBody` from `drain()` or from `applyResponse`.
     */
    const { engine, adapter } = await engineWith([msg({ id: "m1" }), msg({ id: "m2" }), msg({ id: "m3" })]);
    await engine.start();
    await engine.syncOnce();
    expect(adapter.bodyCalls).toEqual([]);
  });
});

describe("the two adapters", () => {
  it("FixturesAdapter serves no bodies, and the engine writes no record for that", async () => {
    // `null` rather than `{text: ""}`: an empty string is a claim about the mail. The demo's
    // rows carry `body`, so this branch is only reached by a fixture message that has none.
    const fixtures = new FixturesAdapter();
    await expect(fixtures.fetchBody("anything")).resolves.toBeNull();

    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{
      type: "message", op: "create", id: "m1", seq: ++seq, updatedAt: NOW.toISOString(),
      entity: msg({ id: "m1" }),   // deliberately body-less, unlike the real fixture world
    }]);
    const engine = new OhmailEngine({ adapter: fixtures, store, now: () => NOW });
    await engine.hydrateBody("m1");

    expect(store.get("message_body", "m1")).toBeUndefined();
    expect(bodyOf(store, store.get<EngineMessage>("message", "m1")!))
      .toEqual({ text: "snippet of m1", state: "snippet", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
  });

  it("HttpAdapter calls GET /messages/:id/body and returns its text unchanged", async () => {
    const calls: Array<[string, string | undefined]> = [];
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      getCookie: () => null,
      fetch: async (url, init) => {
        calls.push([url, init?.method]);
        return new Response(
          JSON.stringify({ messageId: "m1", text: "Dear Mila,\n\nthe kiln is fixed.", html: "<p>the kiln is fixed.</p>", headers: {}, loadedRemoteContent: false }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    // `html` is CARRIED now. This assertion used to be `{ text }` only, and the
    // fixture's html field was literally named `"<p>ignored</p>"`: the endpoint sent it, the
    // adapter dropped it, and the renderer was left with the text alternative of every
    // message. `headers` stays unread (contract §8).
    await expect(adapter.fetchBody("m1")).resolves.toEqual({
      text: "Dear Mila,\n\nthe kiln is fixed.",
      html: "<p>the kiln is fixed.</p>",
      loadedRemoteContent: false,
      unsubscribe: "no_header",
      unsubscribeUrl: null,
    });
    expect(calls).toEqual([["/api/messages/m1/body", "GET"]]);
  });

  it("HttpAdapter encodes the id, so a message id is never a path injection", async () => {
    const calls: string[] = [];
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      getCookie: () => null,
      fetch: async (url) => {
        calls.push(url);
        return new Response(JSON.stringify({ text: "x" }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await adapter.fetchBody("a/../../auth/session");
    expect(calls[0]).toBe("/api/messages/a%2F..%2F..%2Fauth%2Fsession/body");
  });

  it("HttpAdapter THROWS the server's own sentence on a refusal", async () => {
    // Not `HTTP 402`. The spend gate and the 404 both speak `{error:{code,message}}`, and the
    // engine turns the throw into a `failed` record the surface reports.
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      getCookie: () => null,
      fetch: async () => new Response(
        JSON.stringify({ error: { code: "payment_required", message: "This mailbox is out of credit." } }),
        { status: 402, headers: { "content-type": "application/json" } },
      ),
    });
    await expect(adapter.fetchBody("m1")).rejects.toThrow("This mailbox is out of credit.");
  });

  it("HttpAdapter tolerates a missing `text` rather than rendering `undefined`", async () => {
    // Contract §8, forward-compatible parsing.
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      getCookie: () => null,
      fetch: async () => new Response(JSON.stringify({ messageId: "m1" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
    // All three fields default, and `html` defaults to `null` rather than `""` — "there is
    // no html" and "the html is an empty document" are different facts, and the renderer's
    // fall-back-to-text branch is chosen by the first one.
    await expect(adapter.fetchBody("m1")).resolves.toEqual({
      text: "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
    });
  });

  it("HttpAdapter defaults the unsubscribe posture to `no_header` on an OLDER server (C, §8)", async () => {
    // The GUARD for the additive unsubscribe field. A server built before it existed answers a
    // fully-populated body with NO `unsubscribe`/`unsubscribeUrl`. "The server said nothing" must
    // read as "offers no route" (`no_header`) and "no link" (`null`) — never as a claim that some
    // route exists, which would put a dead Unsubscribe control in front of the reader. Change the
    // adapter's default away from `"no_header"` and this goes red.
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      getCookie: () => null,
      fetch: async () => new Response(
        JSON.stringify({ messageId: "m1", text: "hello", html: "<p>hi</p>", loadedRemoteContent: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });
    await expect(adapter.fetchBody("m1")).resolves.toEqual({
      text: "hello",
      html: "<p>hi</p>",
      loadedRemoteContent: true,
      unsubscribe: "no_header",
      unsubscribeUrl: null,
    });
  });

  it("HttpAdapter carries a KNOWN unsubscribe state and link through unchanged (C)", async () => {
    // The other side of the same narrowing: a value the build knows is trusted verbatim, so the
    // default above is a fallback and not a floor. `not_one_click` carries the sender's own https
    // page for the reader to open.
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      getCookie: () => null,
      fetch: async () => new Response(
        JSON.stringify({
          messageId: "m1", text: "x", html: null, loadedRemoteContent: false,
          unsubscribe: "not_one_click", unsubscribeUrl: "https://sender.example/leave?t=abc",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    });
    await expect(adapter.fetchBody("m1")).resolves.toEqual({
      text: "x", html: null, loadedRemoteContent: false,
      unsubscribe: "not_one_click", unsubscribeUrl: "https://sender.example/leave?t=abc",
    });
  });
});

describe("INVARIANT #1 — the redacted text is stored verbatim, never re-derived", () => {
  it("what the endpoint sent is what the record holds, character for character", async () => {
    /**
     * `message-service.ts` `getBody` returns the stored `text` as-is, and the pipeline stored
     * it redacted. This client's whole job is to not touch that: it must not attempt a
     * redaction of its own (a second implementation of the "Sensitive mail" invariant is a second place for it
     * to be wrong), and it must not fall back to the snippet, which for a sensitive message
     * is redacted by a DIFFERENT code path at ingest.
     *
     * The surface guard — a protected message rendering `ProtectedBlock` and no text — is
     * asserted at the surface, in `apps/webapp/test/body-open.test.ts`.
     */
    const REDACTED = "Your verification code is ······ (redacted by ohmail)";
    const { engine, store } = await engineWith([msg({ id: "otp", snippet: "" })], async () => ({ text: REDACTED }));
    await engine.hydrateBody("otp");

    const rec = store.get<MessageBodyRecord>("message_body", "otp")!;
    expect(rec.text).toBe(REDACTED);
    expect(bodyOf(store, store.get<EngineMessage>("message", "otp")!))
      .toEqual({ text: REDACTED, state: "full", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null });
  });
});

describe("the mirror bookkeeping a client-local record needs", () => {
  it("putLocal does not move maxSeq, so a body cannot advance the cursor's high-water mark", async () => {
    /**
     * A client-local record has no seq: it did not come from the log. Pushing one through
     * `applyToRecords` with a synthetic seq would either be refused by the replay guard on the
     * second write or move `maxSeq()` past deltas the mirror never applied — and `maxSeq` is
     * what the sync machinery reasons about convergence with.
     */
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{
      type: "message", op: "create", id: "m1", seq: 7, updatedAt: NOW.toISOString(), entity: msg({ id: "m1" }),
    }]);
    expect(store.maxSeq()).toBe(7);

    await store.putLocal("message_body", "m1", { messageId: "m1", state: "ready", text: "x" });
    expect(store.maxSeq()).toBe(7);
    // And it is overwritable, repeatedly — "local, latest wins" rather than seq-ordered.
    await store.putLocal("message_body", "m1", { messageId: "m1", state: "ready", text: "y" });
    expect(store.get<MessageBodyRecord>("message_body", "m1")!.text).toBe("y");
  });

  it("a body write bumps the mirror version, so the UI recomputes", async () => {
    // `useEngineVersion` subscribes to this. A write that did not move it would leave the
    // fetched body invisible until something else happened to re-render the shell.
    const { engine, store } = await engineWith([msg({ id: "m1" })]);
    const before = engine.read().version();
    await engine.hydrateBody("m1");
    expect(engine.read().version()).not.toBe(before);
    expect(store.version()).toBeGreaterThan(0);
  });

  it("subscribers are notified — the surface hears about it", async () => {
    const { engine } = await engineWith([msg({ id: "m1" })]);
    const seen = vi.fn();
    engine.subscribe(seen);
    await engine.hydrateBody("m1");
    // Twice: `loading`, then `ready`. Both are states a surface renders differently.
    expect(seen.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("a 410 re-bootstrap discards bodies with everything else", async () => {
    // `resetForBootstrap` means "this mirror is not trustworthy". A body kept across it would
    // be text attributed to a message id the server may have reused.
    const { engine, store } = await engineWith([msg({ id: "m1" })]);
    await engine.hydrateBody("m1");
    expect(store.get("message_body", "m1")).toBeDefined();
    await store.resetForBootstrap();
    expect(store.get("message_body", "m1")).toBeUndefined();
  });
});

/**
 * ── THE RENDERER SHIPPED AND THE OWNER STILL SAW A TEXT DUMP ────────────────
 *
 * One change put the html part on the wire and a sanitizing renderer behind it, and a user
 * reported the SAME message still rendering as `<brand> [<image host>/images/…]` … ending in
 * `[url8792.mail.wolkenmail.example/wf/open?upn=…]` — a tracking pixel printed as prose — on the
 * live site, on the build that contains the fix.
 *
 * Three things were measured before a line was changed, and two of them killed the obvious
 * explanations:
 *
 *   THE DEPLOY IS NOT STALE.  The live `/_next/static/chunks/app/(product)/mailbox/page-*.js`
 *                             contains `allow-popups-to-escape-sandbox`, `data-ohmail-blocked`
 *                             and `default-src 'none'`. The renderer is in the browser.
 *   THE SERVER HAS THE HTML.  That exact message holds a long `html` in
 *                             `message_bodies`, with the beacon deep inside it. Its text
 *                             part carries the same beacon early on — which is the
 *                             line the user pasted.
 *   SO IT IS THE MIRROR.      `message_body` records are PERSISTED. A record written by any
 *                             build before that change is `{messageId, state, text}` with **no `html`
 *                             key at all**, `hydrateBody` returned early on `state === "ready"`,
 *                             and `bodyOf` reads `rec.html ?? null`. So every message the
 *                             reader had ALREADY OPENED was frozen in the pre-fix shape for
 *                             ever, while newly-arrived mail rendered correctly — which is
 *                             exactly "it looks unfixed to anyone who was already using it".
 *
 * The fix is in `hydrateBody` and it is one term: `ready` suppresses a fetch only when the
 * record is from a build that KNEW ABOUT `html`. It is not a migration — inventing `html:
 * null` for those rows would be indistinguishable from a message that genuinely has none
 * ({@link MessageBodyRecord}) — and it is not a sweep: `hydrateBody` is called per message on
 * explicit intent, so the cost is one extra `GET /messages/:id/body` per message the reader
 * opens again, once, and nothing at all for mail they do not open.
 *
 * The second test below is the half that keeps that true. A text-only message legitimately
 * stores `html: null`, and a fix that re-fetched on FALSINESS rather than on ABSENCE would
 * re-ask for it on every render of every plain-text mail — a permanent billed poll (the API-cost
 * invariant forbids it) against a server that will keep answering `null`.
 */
describe("a body cached before the html renderer is re-fetched, exactly once", () => {
  /** Precisely what a pre-O11b build left in IndexedDB: no `html`, no `loadedRemoteContent`. */
  const PRE_O11B: MessageBodyRecord = {
    messageId: "m1",
    state: "ready",
    text: "Wolkenmail [https://cdn.wolkenmail.example/images/email/wolkenmail_logo_chip.png]\n\n…\n\n[https://url8792.mail.wolkenmail.example/wf/open?upn=u001.Hx4mQs9dWbPz5e]",
  };

  async function seeded(record: MessageBodyRecord) {
    const store = new MemoryMirrorStore();
    await store.load();
    await store.applyChanges([{
      type: "message", op: "create", id: "m1", seq: ++seq, updatedAt: NOW.toISOString(), entity: msg({ id: "m1" }),
    }]);
    await store.putLocal("message_body", "m1", record);
    const adapter = adapterOf(async (id) => ({
      text: `FULL ${id}`,
      html: "<p>the mail, as mail</p>",
      loadedRemoteContent: false,
    }));
    return { store, adapter, engine: new OhmailEngine({ adapter, store, now: () => NOW }) };
  }

  it("a READY record with NO `html` key is re-asked, and the message becomes mail", async () => {
    const { engine, store, adapter } = await seeded(PRE_O11B);

    // The reported state: full text, no document, so `MessageBody` falls to `BodyText`
    // and the beacon's url is on screen as a line of prose.
    const before = bodyOf(store, store.get<EngineMessage>("message", "m1")!);
    expect(before.state).toBe("full");
    expect(before.html).toBeNull();
    expect(before.text).toContain("/wf/open");

    await engine.hydrateBody("m1");

    expect(adapter.bodyCalls).toEqual(["m1"]);
    expect(bodyOf(store, store.get<EngineMessage>("message", "m1")!)).toEqual({
      text: "FULL m1",
      state: "full",
      html: "<p>the mail, as mail</p>",
      loadedRemoteContent: false,
      unsubscribe: "no_header",
      unsubscribeUrl: null,
    });
  });

  it("…and ONCE. The repaired record suppresses the next ask, so this is not a poll", async () => {
    // The record `fetchBodyInto` writes always sets `html` explicitly — `HttpAdapter.fetchBody`
    // normalises a missing field to `null`, so no transport can leave it `undefined`. That is
    // what makes the re-fetch terminate; without it, every render of the reading pane would
    // ask again. Four calls, one request.
    const { engine, adapter } = await seeded(PRE_O11B);
    await engine.hydrateBody("m1");
    await engine.hydrateBody("m1");
    await engine.hydrateBody("m1");
    await engine.hydrateBody("m1");
    expect(adapter.bodyCalls).toEqual(["m1"]);
  });

  it("a text-only message — `html: null`, STATED — is never re-asked", async () => {
    /**
     * THE OTHER HALF, and the one that decides whether this fix is a repair or a leak.
     *
     * Many of a live mailbox's non-sensitive messages store `html IS NULL` because they are
     * genuinely plain text, and every sensitivity-redacted message stores none by design
     * (`pipeline.ts` — `html: p.sensitivity.sensitive ? null : …`). Re-fetching on
     * `!rec.html` instead of on `rec.html === undefined` would re-ask for all of them, on every
     * open, for ever — a request loop against a server that keeps answering the same `null`.
     */
    const { engine, adapter } = await seeded({
      messageId: "m1", state: "ready", text: "plain text only", html: null, loadedRemoteContent: false,
    });
    await engine.hydrateBody("m1");
    await engine.hydrateBody("m1", { retry: true });
    expect(adapter.bodyCalls).toEqual([]);
  });
});
