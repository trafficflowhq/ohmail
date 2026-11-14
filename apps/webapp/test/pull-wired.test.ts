import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineAdapter } from "@ohmail/client-engine";
import { createEngine } from "../app/shell/engine-config.js";
import { createSyncGate } from "@ohmail/app-logic/session/sync-scheduler";

/**
 * ═══ THE PULL DOORBELL RINGS ON THE PATH THE PRODUCT BUILDS ═════════════════════════════════
 *
 * The "Pull new mail" control shipped (2026-08-26) with its route tested, its adapter tested and
 * its rate limit tested — and DEAD on ohmail.app, because the one thing no suite drove was the
 * construction the shell actually performs: `engine-config.ts` wraps the live transport in
 * `createSyncGate(null).guard(…)`, that wrapper is an EXPLICIT OBJECT LITERAL, and the literal did
 * not forward `requestPull`. `OhmailEngine.requestPull` reads an absent capability as "this
 * world has no worker to hurry" and returns null WITHOUT touching the wire — so the click ran
 * to completion in microtasks: no POST, no busy paint, no console error, every suite green.
 * Measured live (owner report 2026-08-29) before the forward existed. `fetchBody`,
 * `searchServer`, `snapshot`, `listMessages` and the three attachment methods each shipped the
 * same way; this is the eighth capability to carry the risk and the fourth file written to hold
 * one down.
 *
 * So every assertion here goes through {@link createEngine} — the real construction — and
 * watches the WIRE, exactly as `snapshot-wired.test.ts` does for the cold start.
 *
 * ── MUTATION-WATCHED (2026-08-29) ───────────────────────────────────────────────────────────
 *
 * · Deleting the `...(adapter.requestPull ? …)` spread from `sync-scheduler.ts` turned the
 *   first two tests red ("the live engine has no doorbell" / "no request was issued").
 * · Rebinding the forward as `{ requestPull: adapter.requestPull }` (UNBOUND — `this` becomes
 *   the gate wrapper, `this.withDeadline` is undefined) turned the ring test red: the TypeError
 *   is swallowed by `OhmailEngine.requestPull`'s own catch and the wire stays silent, which is
 *   exactly the silent shape the bound assertion exists to catch.
 * · Making the spread unconditional turned the gate-direct control red — and ONLY that one:
 *   the demo-engine control stayed green under it, because `createEngine(true)` returns a bare
 *   `FixturesAdapter` before the gate exists. A first draft of this file carried only the demo
 *   control and the mutation survived it, which is why the gate is also driven directly.
 * Each was watched, then the implementation was restored.
 */

const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;

let calls: Array<{ method: string; url: string }>;
let answer: (url: string, init?: RequestInit) => Response;
const originalFetch = globalThis.fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  calls = [];
  answer = () => json(404, { error: { code: "not_found", message: "no stub for this route" } });
  // Stubbed BEFORE `createEngine`: `HttpAdapter` binds the global at construction time, so a
  // later stub would never be seen.
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? "GET", url: String(url) });
    return Promise.resolve(answer(String(url), init));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("the live engine's doorbell survives the sync gate", () => {
  it("THE REGRESSION: the engine built by the shell HAS a doorbell — `pullAvailable()` is true", () => {
    const engine = createEngine(false, ARMED);
    expect(
      engine.pullAvailable(),
      "the gate wrapper dropped `requestPull` — the control renders nothing (or renders and does nothing) on the live path only",
    ).toBe(true);
  });

  it("…and ringing it puts `POST /api/sync/pull` on the wire and hands back the per-mailbox stamps, parsed", async () => {
    answer = (url) =>
      url.includes("/api/sync/pull")
        ? json(202, {
            requested: 2,
            requestedAt: "2026-08-29T12:00:01.000Z",
            mailboxes: [
              { id: "mb-1", requestedAt: "2026-08-29T12:00:01.000Z" },
              { id: "mb-2", requestedAt: "2026-08-29T11:59:58.500Z" },
            ],
          })
        : json(404, { error: { code: "not_found", message: "only the doorbell is stubbed" } });

    const engine = createEngine(false, ARMED);
    const rang = await engine.requestPull();

    // The wire half: an UNBOUND forward throws `this.withDeadline is not a function` before any
    // fetch, `OhmailEngine.requestPull` swallows it into null, and the wire stays silent — so
    // "a POST happened" and "the result is non-null" must BOTH hold.
    expect(
      calls.filter((c) => c.method === "POST" && c.url === "/api/sync/pull"),
      `the ring never reached the wire — requests seen: ${calls.map((c) => `${c.method} ${c.url}`).join(", ") || "none"}`,
    ).toHaveLength(1);
    expect(rang).not.toBeNull();
    // The settle contract's inputs, per mailbox — each row's OWN effective stamp.
    expect(rang!.requested).toBe(2);
    expect(rang!.mailboxes).toEqual([
      { id: "mb-1", requestedAt: "2026-08-29T12:00:01.000Z" },
      { id: "mb-2", requestedAt: "2026-08-29T11:59:58.500Z" },
    ]);
  });

  it("the gate does not MANUFACTURE the capability: a doorbell-less adapter stays doorbell-less through `guard`", () => {
    // The GATE is driven directly here, because the demo path never reaches it (`createEngine`
    // returns a bare FixturesAdapter before `gate.guard`) — a demo-engine control would stay
    // green under an unconditional forward, which is the mutation this test exists to catch.
    const bare = {
      sync: async () => { throw new Error("not under test"); },
      mutate: async () => { throw new Error("not under test"); },
      fetchBody: async () => null,
    } as unknown as EngineAdapter;
    const wrapped = createSyncGate(null).guard(bare);
    expect(
      wrapped.requestPull,
      "the gate invented a doorbell for an adapter that has no worker to hurry",
    ).toBeUndefined();
  });

  it("…and the demo engine has no doorbell and rings nothing", async () => {
    const engine = createEngine(true);
    expect(engine.pullAvailable(), "a FixturesAdapter claimed a doorbell it has no worker for").toBe(false);
    const rang = await engine.requestPull();
    expect(rang).toBeNull();
    expect(calls, "the demo touched the network for a pull").toHaveLength(0);
  });
});
