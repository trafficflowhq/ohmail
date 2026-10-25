import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpAdapter, OhmailEngine } from "../src/index.js";
import { ORGANIZER_REQUESTS_REREAD_MS } from "../src/engine.js";

/**
 * WHAT WAITS ON THE ORGANIZER, ONE LIST: the server's (`GET /organizer-requests`) merged with the
 * requests this session sent. A queued rule edit settles on the rule's own change OR on the server
 * listing it as over — the record of a reader-only account, where no change may come (gap row
 * NO-STANDING-LIST-OF-WHAT-WAITS-ON-THE-ORGANIZER).
 */
const NOW = new Date("2026-10-02T09:00:00.000Z");
const RULE = {
  id: "r1", kind: "sender", match: "ann@shop.example", destination: "ohmail/News", priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
};
const KEY = { kind: "sender", match: "ann@shop.example", subjectContains: null, bodyContains: null };
const row = (state: string) => ({
  id: "req-1", kind: "rule.delete", state, mailboxId: "mb1", holder: { name: "Laptop" },
  decidedAt: NOW.toISOString(), resolvedAt: state === "sent" ? null : NOW.toISOString(),
  refusedReason: state === "refused" ? "no_such_rule" : null, target: { rule: KEY },
});

function world() {
  let seq = 10;
  const pages: unknown[][] = [];
  let server: unknown[] = [];
  let asks = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    const method = init?.method ?? "GET";
    let status = 200;
    let body: unknown = {};
    if (href.includes("/sync?")) {
      const first = href.includes("since=0");
      const page = pages.shift() ?? (first ? [{ type: "rule", op: "create", id: RULE.id, seq, updatedAt: RULE.updatedAt, entity: RULE }] : []);
      const ch = page as Array<{ op: string }>;
      body = {
        changes: {
          creates: ch.filter((c) => c.op === "create"), updates: ch.filter((c) => c.op === "update"),
          moves: [], deletes: ch.filter((c) => c.op === "delete"),
        },
        cursor: String(seq), hasMore: false, serverTime: NOW.toISOString(),
      };
    } else if (href.endsWith("/organizer-requests")) {
      asks++;
      body = { items: server };
    } else if ((/\/rules\/r1$/.test(href) && (method === "DELETE" || method === "PATCH")) || (href.endsWith("/rules") && method === "POST")) {
      status = 202;
      // The rules route's REAL 202: `{ pending, travel }`, no top-level id (REVIEW-026 H2) —
      // each held mailbox's request id rides its leg.
      body = { pending: true, travel: { appliedLocally: [], pending: [{ mailboxId: "mb1", requestId: "req-1", holder: { kind: "local", name: "Laptop", since: NOW.toISOString() } }], refused: [] } };
    }
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "https://api.test", fetch: fetchImpl }), now: () => NOW });
  return {
    engine,
    organizerDeletes: () => { seq += 1; pages.push([{ type: "rule", op: "delete", id: RULE.id, seq, updatedAt: NOW.toISOString() }]); },
    organizerUpdates: (destination: string) => { seq += 1; pages.push([{ type: "rule", op: "update", id: RULE.id, seq, updatedAt: NOW.toISOString(), entity: { ...RULE, destination } }]); },
    organizerCreates: (match: string) => { seq += 1; pages.push([{ type: "rule", op: "create", id: "r2", seq, updatedAt: NOW.toISOString(), entity: { ...RULE, id: "r2", match } }]); },
    unrelatedPage: () => { seq += 1; pages.push([{ type: "rule", op: "update", id: "r9", seq, updatedAt: NOW.toISOString(), entity: { ...RULE, id: "r9", match: "z@z.example" } }]); },
    serverSays: (rows: unknown[]) => { server = rows; },
    asks: () => asks,
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));
afterEach(() => { vi.useRealTimers(); });

describe("a rule request waiting on the organizer", () => {
  it("is held, listed against its rule, and the organizer's delete settles it", async () => {
    const w = world();
    await w.engine.start();
    const res = await w.engine.mutate({ kind: "rule_delete", ruleId: "r1" });
    expect(res.status).toBe("awaiting_organizer");
    expect(w.engine.organizerRequests().map((r) => r.kind)).toEqual(["rule_delete"]);
    expect(w.engine.waitingOnOrganizer()).toEqual([expect.objectContaining({ kind: "rule.delete", ruleId: "r1", state: "pending" })]);
    w.organizerDeletes();
    await w.engine.syncOnce();
    expect(w.engine.organizerRequests(), "the organizer removed the rule and the request still waits").toHaveLength(0);
  });

  it("settles from the server's list with NO change delivered — a reader-only account's ending", async () => {
    const w = world();
    await w.engine.start();
    await w.engine.mutate({ kind: "rule_delete", ruleId: "r1" });
    w.serverSays([row("applied")]);
    w.engine.refreshWaitingOnOrganizer();
    await settle();
    expect(w.engine.organizerRequests()).toHaveLength(0);
    expect(w.engine.waitingOnOrganizer(), "an applied request is still listed as waiting").toEqual([]);
  });

  it("a refusal stays listed with its reason after the queue lets it go", async () => {
    const w = world();
    await w.engine.start();
    await w.engine.mutate({ kind: "rule_delete", ruleId: "r1" });
    w.serverSays([row("refused")]);
    w.engine.refreshWaitingOnOrganizer();
    await settle();
    expect(w.engine.organizerRequests()).toHaveLength(0);
    expect(w.engine.waitingOnOrganizer()).toEqual([expect.objectContaining({ state: "refused", refusedReason: "no_such_rule", ruleId: "r1", holder: { name: "Laptop" } })]);
  });

  it("the server's row and the session's request under one id are one row, and twice delivered settles once", async () => {
    const w = world();
    await w.engine.start();
    w.serverSays([row("sent")]);
    await w.engine.mutate({ kind: "rule_delete", ruleId: "r1" });
    await settle();
    expect(w.engine.waitingOnOrganizer()).toHaveLength(1);
    w.organizerDeletes();
    w.organizerDeletes();
    await w.engine.syncOnce();
    expect(w.engine.organizerRequests()).toHaveLength(0);
  });

  it("one press reads as one entry, under the leg's id the real 202 names", async () => {
    const w = world();
    await w.engine.start();
    w.serverSays([row("pending")]);
    const res = await w.engine.mutate({ kind: "rule_delete", ruleId: "r1" });
    expect(res.requestId).toBe("req-1");
    await settle();
    // The server lists it now, so its row speaks and the session's entry has left.
    expect(w.engine.organizerRequests()).toEqual([]);
    expect(w.engine.waitingOnOrganizer(), "the press and its server row read as two").toHaveLength(1);
  });

  it("a poll reads while something waits, once per floor, and not after a refused read until a page clears it", async () => {
    let clock = NOW.getTime();
    let refusing = false;
    let asks = 0;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith("/organizer-requests")) {
        asks++;
        if (refusing) throw new Error("the gate refused");
        return new Response(JSON.stringify({ items: [row("sent")] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (/\/rules\/r1$/.test(href) && (init?.method ?? "GET") === "DELETE") {
        return new Response(JSON.stringify({ pending: true, travel: { appliedLocally: [], pending: [{ mailboxId: "mb1", requestId: "req-1", holder: { kind: "local", name: "Laptop", since: NOW.toISOString() } }], refused: [] } }), { status: 202, headers: { "content-type": "application/json" } });
      }
      const first = href.includes("since=0");
      return new Response(JSON.stringify({
        changes: { creates: first ? [{ type: "rule", op: "create", id: RULE.id, seq: 1, updatedAt: RULE.updatedAt, entity: RULE }] : [], updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: NOW.toISOString(),
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "https://api.test", fetch: fetchImpl }), now: () => new Date(clock) });
    await engine.start();
    await engine.mutate({ kind: "rule_delete", ruleId: "r1" });
    await settle();
    const afterPress = asks;
    engine.pollWaitingOnOrganizer();
    await settle();
    expect(asks, "a poll under the floor read").toBe(afterPress);
    clock += ORGANIZER_REQUESTS_REREAD_MS;
    engine.pollWaitingOnOrganizer();
    await settle();
    expect(asks, "a due poll did not read").toBe(afterPress + 1);
    refusing = true;
    clock += ORGANIZER_REQUESTS_REREAD_MS;
    engine.pollWaitingOnOrganizer();
    await settle();
    expect(asks).toBe(afterPress + 2);
    for (let i = 0; i < 5; i++) { clock += ORGANIZER_REQUESTS_REREAD_MS; engine.pollWaitingOnOrganizer(); await settle(); }
    expect(asks, "a refused read was retried on the clock").toBe(afterPress + 2);
  });

  it("a poll with nothing waiting, or with no list to read, reads nothing and throws nothing", async () => {
    const w = world();
    await w.engine.start();
    const before = w.asks();
    w.engine.pollWaitingOnOrganizer();
    await settle();
    expect(w.asks()).toBe(before);
    const bare = new OhmailEngine({ adapter: { sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "0", hasMore: false, serverTime: NOW.toISOString() }) } as never, now: () => NOW });
    expect(() => bare.pollWaitingOnOrganizer()).not.toThrow();
  });

  it("CONTROL: with nothing waiting, a page asks the server nothing", async () => {
    const w = world();
    await w.engine.start();
    w.engine.waitingOnOrganizer();
    await settle();
    const before = w.asks();
    w.unrelatedPage();
    await w.engine.syncOnce();
    await settle();
    expect(w.asks(), "an empty list re-asked on every page").toBe(before);
  });

  it("an edit settles on the rule filing where it asked, and not on somebody else's edit", async () => {
    const w = world();
    await w.engine.start();
    await w.engine.mutate({ kind: "rule_update", ruleId: "r1", destination: "ohmail/Receipts" as never });
    w.organizerUpdates("INBOX");
    await w.engine.syncOnce();
    expect(w.engine.organizerRequests(), "another edit settled this request").toHaveLength(1);
    w.organizerUpdates("ohmail/Receipts");
    await w.engine.syncOnce();
    expect(w.engine.organizerRequests()).toHaveLength(0);
  });

  it("a create settles on a row under its key, whatever its spelling", async () => {
    const w = world();
    await w.engine.start();
    await w.engine.mutate({ kind: "rule_create", ruleKind: "sender", match: "bob@shop.example", destination: "ohmail/News" as never });
    w.organizerCreates("someone@else.example");
    await w.engine.syncOnce();
    expect(w.engine.organizerRequests()).toHaveLength(1);
    w.organizerCreates(" Bob@Shop.example");
    await w.engine.syncOnce();
    expect(w.engine.organizerRequests()).toHaveLength(0);
  });
});

/**
 * A REFUSAL STAYS LISTED, EXCEPT THE ONE A NEWER DECISION OWNS (mail 0145). `stale` is the organizer's
 * 24 h window and says "did not carry this out" for a day, as it always did; `superseded` is an aged
 * move refused behind a newer placement, and that placement owns the sentence.
 */
describe("which refusals the waiting list says", () => {
  it("a rule request refused stale is listed with its refusal", async () => {
    const w = world();
    await w.engine.start();
    await w.engine.mutate({ kind: "rule_delete", ruleId: "r1" });
    w.serverSays([{ ...row("refused"), refusedReason: "stale" }]);
    w.engine.refreshWaitingOnOrganizer();
    await settle();
    expect(w.engine.waitingOnOrganizer().map((x) => [x.state, x.refusedReason])).toEqual([["refused", "stale"]]);
  });

  it("a move refused stale is listed; one refused superseded is not", async () => {
    const w = world();
    await w.engine.start();
    const move = (id: string, reason: string) => ({
      id, kind: "message.move", state: "refused", mailboxId: "mb1", holder: { name: "Laptop" },
      decidedAt: NOW.toISOString(), resolvedAt: NOW.toISOString(), refusedReason: reason,
      target: { messageId: "m1", folder: "ohmail/Receipts" },
    });
    w.serverSays([move("req-2", "stale"), move("req-3", "superseded")]);
    w.engine.refreshWaitingOnOrganizer();
    await settle();
    expect(w.engine.waitingOnOrganizer().map((x) => [x.requestId, x.refusedReason])).toEqual([["req-2", "stale"]]);
  });
});

describe("the rule requests the organizer applied", () => {
  it("lists the applied rule rows of the last read, and nothing in flight or of another kind", async () => {
    const w = world();
    await w.engine.start();
    w.serverSays([
      row("applied"), { ...row("sent"), id: "req-2" }, { ...row("refused"), id: "req-3" },
      { ...row("applied"), id: "req-4", kind: "message.move", target: { messageId: "m1", folder: "INBOX" } },
    ]);
    w.engine.refreshWaitingOnOrganizer();
    await settle();
    expect(w.engine.appliedRuleRequests()).toEqual([{
      requestId: "req-1", kind: "rule.delete", mailboxId: "mb1", decidedAt: NOW.toISOString(), resolvedAt: NOW.toISOString(),
      target: { rule: KEY },
    }]);
  });
});
