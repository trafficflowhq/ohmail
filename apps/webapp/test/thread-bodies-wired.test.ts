import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeSeqCursor, FixturesAdapter, OhmailEngine, type EngineMessage } from "@ohmail/client-engine";
import { createEngine } from "../app/shell/engine-config.js";
import { createSyncGate } from "@ohmail/app-logic/session/sync-scheduler";

/**
 * ═══ OPENING A THREAD IS ONE REQUEST, ON THE PATH THE PRODUCT BUILDS ══════════════════════
 *
 * The batch body route, the adapter method and the engine's `hydrateThread` all landed with
 * their own suites green, and none of those suites can see the one thing that decides whether a
 * live account ever takes the route: `engine-config.ts` wraps the live transport in
 * `createSyncGate(null).guard(…)`, and that wrapper is an EXPLICIT OBJECT LITERAL rather than a Proxy.
 *
 * `fetchBodies` is STRUCTURAL — the engine reaches for `adapter.fetchBodies` and treats its
 * absence as "this client has no batch route", falling back to one request per message. That
 * fallback is correct, and it is exactly what makes the omission invisible: a wrapper that forgets
 * the line produces an engine that works, converges and renders every body correctly, while every
 * thread on a live account quietly costs N requests instead of one. `fetchBody`, `searchServer`,
 * `snapshot`, `listMessages` and the three attachment methods have each shipped that way. This is
 * the sixth capability to carry the risk and the fourth file written to hold one down.
 *
 * So the assertions here go through {@link createEngine} — the real construction the shell
 * performs — and COUNT THE REQUESTS on the wire. A test that only checked the bodies arrived
 * would pass with the line deleted.
 *
 * ── MUTATION-WATCHED ─────────────────────────────────────────────────────────────────────
 *
 * Deleting `...(adapter.fetchBodies ? … : {})` from `sync-scheduler.ts` turns "one request" red
 * at exactly five `GET /api/messages/:id/body` calls, and "the bodies actually LAND" red with an
 * empty text. Making the spread UNCONDITIONAL turns "the gate does not MANUFACTURE the
 * capability" red. All three were watched, then the implementation was restored.
 */

process.env.NEXT_PUBLIC_API_BASE = "/api";
const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;
const DATE = "2026-08-08T09:00:00.000Z";
const THREAD = ["m1", "m2", "m3", "m4", "m5"];

let calls: string[];
let answer: (url: string, init?: RequestInit) => Response;
const originalFetch = globalThis.fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A message row as `/sync` sends it — a `create` change carrying a `MessageDTO`. */
function messageChange(id: string, seq: number): unknown {
  return {
    type: "message", op: "create", id, seq, updatedAt: DATE,
    entity: {
      id, accountId: "acct", mailboxId: "mb", threadId: "t1", messageIdHeader: null,
      subject: `Re: the north elevation (${id})`,
      from: { name: null, address: "sender@example.invalid" },
      to: [], cc: [], date: DATE, folder: "INBOX", snippet: `snippet of ${id}`,
      unread: false, hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: DATE,
    },
  };
}

beforeEach(() => {
  calls = [];
  answer = () => json(404, { error: { code: "not_found", message: "no stub for this route" } });
  // Stubbed BEFORE `createEngine`: `HttpAdapter` binds the global at construction time, so a
  // later stub would never be seen.
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return Promise.resolve(answer(url, init));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** A live engine with the thread already in its mirror, built the way the shell builds one. */
async function liveEngineWithThread() {
  const seq = 42;
  answer = (url) => {
    if (url.includes("/api/sync/snapshot")) {
      return json(200, {
        asOfSeq: seq,
        changes: THREAD.map((id) => messageChange(id, seq)),
        nextCursor: null,
        window: { days: 90, minRows: 5000 },
      });
    }
    return json(200, {
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: encodeSeqCursor(seq), hasMore: false, serverTime: DATE,
    });
  };
  const engine = createEngine(false, ARMED);
  await engine.syncOnce();
  expect(engine.read().get<EngineMessage>("message", "m5")).toBeTruthy();
  calls = [];
  return engine;
}

const bodiesCalls = (): string[] => calls.filter((c) => c.includes("/messages"));

describe("a live thread open costs ONE request", () => {
  it("THE REGRESSION: five siblings, one `GET /api/messages/bodies?ids=…`", async () => {
    const engine = await liveEngineWithThread();
    answer = (url) =>
      url.includes("/messages/bodies")
        ? json(200, {
            items: THREAD.map((id) => ({
              messageId: id, text: `FULL ${id}`, html: `<p>FULL ${id}</p>`,
              loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
            })),
            nextCursor: null,
          })
        : json(404, { error: { code: "not_found", message: "no single-body stub" } });

    await engine.hydrateThread(THREAD);

    // ONE. Not "at least one" and not "the bodies arrived" — the count IS the fix, and it is the
    // only thing a dropped forward changes.
    expect(bodiesCalls()).toHaveLength(1);
    expect(bodiesCalls()[0]).toContain("/api/messages/bodies?ids=");
    for (const id of THREAD) expect(bodiesCalls()[0]).toContain(id);
    // …and the single-message route is NOT touched: the fallback would be silent otherwise.
    expect(calls.join("\n")).not.toContain("/body");
  });

  it("…and the bodies actually LAND — an unbound forward would count the same and store nothing", async () => {
    // The `.bind(adapter)` half. Forwarding the method unbound puts the gate wrapper in `this`,
    // `this.request` is undefined, and the TypeError becomes a `failed` record on every sibling —
    // which looks exactly like a server that has not deployed the route, and passes any assertion
    // that only counts requests.
    const engine = await liveEngineWithThread();
    answer = () =>
      json(200, {
        items: THREAD.map((id) => ({
          messageId: id, text: `FULL ${id}`, html: `<p>FULL ${id}</p>`,
          loadedRemoteContent: false, unsubscribe: "one_click", unsubscribeUrl: null,
        })),
        nextCursor: null,
      });

    await engine.hydrateThread(THREAD);

    const reader = engine.read();
    for (const id of THREAD) {
      const rec = reader.get<{ state: string; text: string; html: string | null; unsubscribe?: string }>("message_body", id)!;
      expect(rec.state).toBe("ready");
      expect(rec.text).toBe(`FULL ${id}`);
      expect(rec.html).toBe(`<p>FULL ${id}</p>`);
      // The posture rides the batch row, which is why the ids mode joins the headers: without it
      // a thread's siblings would silently offer no way out where the opened message does.
      expect(rec.unsubscribe).toBe("one_click");
    }
  });

  it("the gate does not MANUFACTURE the capability on an adapter with no server", () => {
    // `in`, not `typeof`: an always-defined forward of an absent method reads `undefined` under
    // `typeof` too, but is present as a key — and the engine's `?.bind()` would then bind
    // `undefined` and take the batch branch with nothing behind it. This is the assertion that
    // goes red if the spread is made unconditional.
    const guarded = createSyncGate(null).guard(new FixturesAdapter()) as unknown as Record<string, unknown>;
    expect("fetchBodies" in guarded, "the gate invented a batch route on an adapter with no server").toBe(false);
  });

  it("a gated fixtures engine still opens a thread — the fallback is a real path", async () => {
    // The per-message arm is what the desktop tier and any not-yet-deployed Cloud take, and it
    // has to keep working. Zero requests, because the demo's rows carry their own bodies.
    const engine = new OhmailEngine({ adapter: createSyncGate(null).guard(new FixturesAdapter()) });
    await engine.start();
    const ids = engine.read().list<EngineMessage>("message").slice(0, 5).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    calls = [];

    await engine.hydrateThread(ids);
    expect(calls, "the demo is self-contained — zero requests, on every path").toEqual([]);
  });
});
