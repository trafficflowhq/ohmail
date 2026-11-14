import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeSeqCursor,
  HttpAdapter,
  OhmailEngine,
  type EngineMessage,
} from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { createEngine } from "../app/shell/engine-config.js";
import { createSyncGate, transportOf } from "@ohmail/app-logic/session/sync-scheduler";

/**
 * ═══ THE COLD START GOES THROUGH `GET /sync/snapshot` ON THE PATH THE PRODUCT BUILDS ═══════
 *
 * The snapshot reader and the engine's use of it both landed with their own suites green, and
 * neither of those suites could see the one thing that decides whether a live account ever
 * takes the route: `engine-config.ts` wraps the live transport in `createSyncGate(null).guard(…)`,
 * and that wrapper is an EXPLICIT OBJECT LITERAL rather than a Proxy.
 *
 * `snapshot` is STRUCTURAL — the engine reaches for `adapter.snapshot` and treats its absence
 * as "this client has no such route", falling back to `since=0`. That fallback is correct and
 * it is also what makes the omission invisible: a wrapper that forgets the line produces an
 * engine that works, converges, and quietly replays the whole change log from seq zero on every
 * cold start, on the LIVE path only — the demo is never wrapped. `fetchBody`, `searchServer`
 * and the three attachment methods each shipped exactly that way; this is the sixth capability
 * to carry the risk and the third file written to hold it down.
 *
 * So every assertion here goes through {@link createEngine} — the real construction the shell
 * performs — and watches the WIRE. Nothing below builds an adapter of its own except the
 * controls, which are labelled as such.
 *
 * ── MUTATION-WATCHED ────────────────────────────────────────────────────────────────────────
 *
 * Deleting the `...(adapter.snapshot ? …)` spread from `sync-scheduler.ts` turns the first three
 * tests red (`GET /api/sync?since=0` is issued instead of the snapshot). Making the spread
 * unconditional turns "the gate does not manufacture the capability" red. Both were watched, then
 * the implementation was restored.
 */

const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;

/** Every request the stubbed fetch saw, in order: `"GET /api/sync/snapshot"`. */
let calls: string[];
let answer: (url: string, init?: RequestInit) => Response;
const originalFetch = globalThis.fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A message row as `/sync/snapshot` sends it — a `create` change carrying a `MessageDTO`. */
function messageChange(id: string, seq: number): unknown {
  const date = "2026-08-01T09:00:00.000Z";
  return {
    type: "message",
    op: "create",
    id,
    seq,
    updatedAt: date,
    entity: {
      id,
      accountId: "acct",
      mailboxId: "mb",
      threadId: null,
      messageIdHeader: null,
      subject: `Subject ${id}`,
      from: { name: null, address: "sender@example.test" },
      to: [],
      cc: [],
      date,
      folder: "INBOX",
      snippet: "snippet",
      unread: false,
      hasAttachments: false,
      attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null,
      labels: [],
      remoteContent: "none",
      updatedAt: date,
    },
  };
}

/** An empty, settled `/sync` page at the given cursor. */
function quietSync(cursor: string): Response {
  return json(200, {
    changes: { creates: [], updates: [], moves: [], deletes: [] },
    cursor,
    hasMore: false,
    serverTime: "2026-08-07T12:00:00.000Z",
  });
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

describe("a cold live mirror asks for the snapshot, not for the log from seq zero", () => {
  it("THE REGRESSION: the FIRST request of a cold drain is `GET /api/sync/snapshot`", async () => {
    const asOf = 900;
    answer = (url) => {
      if (url.includes("/api/sync/snapshot")) {
        return json(200, {
          asOfSeq: asOf,
          changes: [messageChange("m1", asOf)],
          nextCursor: null,
          window: { days: 90, minRows: 5000 },
        });
      }
      return quietSync(encodeSeqCursor(asOf));
    };

    const engine = createEngine(false, ARMED);
    await engine.syncOnce();

    // FIRST, not merely present: the whole value of the route is that the log replay never
    // happens. A snapshot issued after a `since=0` page would be a second bootstrap, not a
    // cheaper one.
    expect(calls[0], `the first request was ${calls[0]} — the gate dropped \`snapshot\``)
      .toBe("GET /api/sync/snapshot");
    expect(calls.join("\n")).not.toContain("since=0");
  });

  it("…and it is BOUND, so the rows actually land and the cursor advances past them", async () => {
    // An UNBOUND forward puts the gate wrapper in `this`, `this.request` is undefined, and the
    // TypeError is swallowed by `runSnapshot`'s page-1 fallback — which looks exactly like a
    // server that has not deployed the route. The mirror would then fill from `since=0` and
    // every assertion about "a request was made" would still pass. This is the one that bites.
    const asOf = 1200;
    answer = (url) =>
      url.includes("/api/sync/snapshot")
        ? json(200, {
            asOfSeq: asOf,
            changes: [messageChange("m1", asOf), messageChange("m2", asOf)],
            nextCursor: null,
            window: { days: 90, minRows: 5000 },
          })
        : quietSync(encodeSeqCursor(asOf));

    const engine = createEngine(false, ARMED);
    await engine.syncOnce();

    const reader = engine.read();
    expect(reader.get<EngineMessage>("message", "m1")?.subject).toBe("Subject m1");
    expect(reader.get<EngineMessage>("message", "m2")?.subject).toBe("Subject m2");
    // The delta drain that follows resumes from the snapshot's point, not from zero.
    expect(calls.some((c) => c.includes(`since=${encodeURIComponent(encodeSeqCursor(asOf))}`))).toBe(true);
  });

  it("a 410 mid-drain RE-SNAPSHOTS — it never falls back to `since=0`", async () => {
    // The 410 branch resets the cursor to "0" and `continue`s to the top of the drain loop,
    // where the snapshot condition is written once. If the gate dropped the capability the same
    // branch would issue `since=0` instead — a full log replay every time a cursor expires,
    // which on a large account is the most expensive request the product can make.
    const first = 900;
    const second = 1500;
    let syncCalls = 0;
    let snapshots = 0;
    answer = (url) => {
      if (url.includes("/api/sync/snapshot")) {
        snapshots++;
        const asOf = snapshots === 1 ? first : second;
        return json(200, {
          asOfSeq: asOf,
          changes: [messageChange(`m${snapshots}`, asOf)],
          nextCursor: null,
          window: { days: 90, minRows: 5000 },
        });
      }
      syncCalls++;
      // Call 1 settles the first drain. Call 2 — the start of the SECOND drain, from a mirror
      // that already holds a cursor — expires it.
      if (syncCalls === 2) return json(410, { error: { code: "cursor_expired", message: "gone" } });
      return quietSync(encodeSeqCursor(snapshots === 1 ? first : second));
    };

    const engine = createEngine(false, ARMED);
    await engine.syncOnce();
    const before = calls.length;
    await engine.syncOnce();

    const afterThe410 = calls.slice(before);
    expect(snapshots, "the 410 did not re-snapshot").toBe(2);
    expect(
      afterThe410.some((c) => c === "GET /api/sync/snapshot"),
      `after the 410 the client issued ${afterThe410.join(", ")}`,
    ).toBe(true);
    // The assertion that fails when the forward is deleted: `since=0` is the fallback path, and
    // with a snapshot route present it must never be reached.
    expect(calls.join("\n"), "the client replayed the log from seq zero").not.toContain("since=0");
  });
});

describe("SPREAD, not always-defined — an adapter with no server keeps not having one", () => {
  it("guarding a `FixturesAdapter` does not MANUFACTURE `snapshot`", () => {
    // `in`, not `typeof`: an always-defined forward of an absent method reads `undefined` under
    // `typeof` too, but is present as a key — and `satisfies` would still compile.
    const guarded = createSyncGate(null).guard(new FixturesAdapter()) as unknown as Record<string, unknown>;
    expect("snapshot" in guarded, "the gate invented a snapshot route on an adapter with no server").toBe(false);
  });

  it("the demo engine issues ZERO requests — no snapshot, no sync, nothing", async () => {
    // Invariants #6/#8. The demo returns from `createEngine` before `guard` is ever called, so
    // this is also the control that keeps the tests above from being about a stub.
    const engine = createEngine(true, ARMED);
    await engine.start();
    expect(calls).toEqual([]);
  });

  it("the transport behind the live gate really is the HTTP adapter", () => {
    const engine = createEngine(false, ARMED);
    expect(transportOf((engine as unknown as { adapter: unknown }).adapter)).toBeInstanceOf(HttpAdapter);
  });

  it("a gated fixtures engine still bootstraps — the fallback is a real path, not dead code", async () => {
    // The `since=0` branch is what every adapter without the route takes, and it has to keep
    // working: it is the desktop tier's path and the path of any Cloud that has not deployed
    // the reader yet.
    const engine = new OhmailEngine({ adapter: createSyncGate(null).guard(new FixturesAdapter()) });
    await engine.start();
    expect(engine.read().list<EngineMessage>("message").length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });
});
