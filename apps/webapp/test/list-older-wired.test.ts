import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OhmailEngine, SERVER_VIEW_OF, type EngineMessage } from "@ohmail/client-engine";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { createEngine } from "../app/shell/engine-config.js";
import { createSyncGate } from "@ohmail/app-logic/session/sync-scheduler";

/**
 * ═══ THE WAY BACK PAST THE WINDOW EXISTS ON THE PATH THE PRODUCT BUILDS ════════════════════
 *
 * `listMessages` is the sixth structural capability the live engine reaches for on its adapter,
 * and the gate in `engine-config.ts` rebuilds that adapter as an EXPLICIT OBJECT LITERAL. A
 * capability the literal does not name does not exist — and only on the live path, because the
 * demo returns before `guard` is ever called.
 *
 * This one's failure mode is the worst of the six. `fetchBody` missing meant one-line previews;
 * `searchServer` missing meant a search that could not reach the archive. This missing means a
 * windowed account scrolls to the bottom of its ninety days and is told, by the product, in its
 * own voice, that this is the end of their mail. It would say it only in production, and every
 * suite in the repo would stay green, because they all build engines from bare adapters.
 *
 * ── AND IT ASKS FOR THE PILE BY A NAME THE SERVER KNOWS ─────────────────────────────────────
 *
 * The wiring being present is only half of it. The client and the server have different words for
 * the same six piles — `ohbox` here is `imbox` there — and they agree on exactly one of them. A
 * client that put its own word on the wire got one working view and five refusals, each carrying
 * a validation message that listed the server's internal names, straight onto the screen.
 *
 * The tests below therefore drive the CLIENT's name and assert the SERVER's name on the wire.
 * A stub keyed on the client's word would bake the defect into the guard, which is how this went
 * out in the first place.
 *
 * ── MUTATION-WATCHED ────────────────────────────────────────────────────────────────────────
 *
 * Deleting the `...(adapter.listMessages ? …)` spread from `sync-scheduler.ts` turns the first
 * three tests red. Making it unconditional turns the demo group red. Both were watched, then the
 * implementation was restored.
 */

const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;

let calls: string[];
let answer: (url: string) => Response;
const originalFetch = globalThis.fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function wireMessage(id: string): unknown {
  const date = "2023-05-05T09:00:00.000Z";
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: "sender@example.test" },
    to: [], cc: [], date, folder: "INBOX", snippet: "snippet", unread: false,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: date,
  };
}

beforeEach(() => {
  calls = [];
  answer = () => json(404, { error: { code: "not_found", message: "no stub for this route" } });
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    return Promise.resolve(answer(url));
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("a live windowed account can reach the mail it did not keep", () => {
  it("THE REGRESSION: `createEngine(false, …)` answers `listOlderAvailable() === true`", () => {
    // The one-line statement of the bug. False here means the pile renders no control at all,
    // and its last row silently becomes a claim about somebody's whole mailbox.
    expect(createEngine(false, ARMED).listOlderAvailable()).toBe(true);
  });

  it("a page reaches `GET /api/messages?view=&cursor=` and comes back READY", async () => {
    // The stub answers the SERVER's name. Keyed on `view=ohbox` it would answer a request the
    // real server refuses, and the suite would prove the product works while production refuses it.
    answer = (url) =>
      url.includes("/api/messages?view=imbox")
        ? json(200, { items: [wireMessage("old-1")], nextCursor: "keyset-2" })
        : json(400, { error: { code: "validation", message: "view must be one of imbox, feed, paper_trail, screened, quarantine, new_for_you, previously_seen" } });

    const engine = createEngine(false, ARMED);
    const outcome = await engine.listOlder("ohbox", { cursor: "keyset-1" });

    // NOT `state !== "unavailable"`: `ready` is the assertion. An UNBOUND forward would put the
    // gate wrapper in `this`, `this.request` would be undefined, and the engine's catch would
    // turn the TypeError into `failed` — which a weaker assertion would sail past.
    expect(outcome).toEqual({
      state: "ready",
      items: [wireMessage("old-1")],
      nextCursor: "keyset-2",
    });
    expect(calls).toContain("GET /api/messages?view=imbox&cursor=keyset-1");
    // The client's own word never reaches the wire.
    expect(calls.some((c) => c.includes("view=ohbox")), "the client's vocabulary went out on the wire").toBe(false);
  });

  it("every pile the server serves is asked for under the SERVER's name", async () => {
    // Driven by the client's vocabulary, asserted against the server's — the shape the broken
    // version of this test could not have had, because it stubbed the client's word.
    answer = () => json(200, { items: [], nextCursor: null });
    const engine = createEngine(false, ARMED);

    for (const [clientView, serverView] of Object.entries(SERVER_VIEW_OF)) {
      if (serverView === null) continue;
      calls = [];
      await engine.listOlder(clientView as Parameters<typeof engine.listOlder>[0]);
      expect(calls, `"${clientView}" did not go out as "${serverView}"`)
        .toEqual([`GET /api/messages?view=${serverView}`]);
    }
  });

  it("THE SCREENER asks for nothing at all, and says so honestly", async () => {
    // A queue of senders waiting at the door, not a pile of mail: the server has no message list
    // behind it. `unavailable` is the same answer a client with no server gives — never a request
    // that would be refused, and never a failure the pile would have to render.
    answer = () => json(500, { error: { code: "server_error", message: "the screener must never reach the wire" } });
    const engine = createEngine(false, ARMED);
    expect(await engine.listOlder("screener")).toEqual({ state: "unavailable" });
    expect(calls).toEqual([]);
  });

  it("the page is NOT written to the mirror, even through the real engine", async () => {
    answer = () => json(200, { items: [wireMessage("old-1")], nextCursor: null });
    const engine = createEngine(false, ARMED);
    await engine.listOlder("ohbox");
    expect(engine.read().get<EngineMessage>("message", "old-1")).toBeUndefined();
  });

  it("a refusal arrives as the server's own sentence, not as a thrown error", async () => {
    answer = () => json(402, { error: { code: "payment_required", message: "You have used this month's included reads." } });
    const engine = createEngine(false, ARMED);
    const outcome = await engine.listOlder("ohbox");
    expect(outcome.state).toBe("failed");
    expect((outcome as { error: string }).error).toContain("included reads");
  });
});

describe("THE DRIFT GUARD: the client's idea of the server's vocabulary is checked against the server", () => {
  /**
   * The server's `MessageView` union, read out of its own source rather than imported.
   *
   * Read, not imported, because `packages/services` is a server package the browser bundle must
   * never pull in — and because the point of this check is to notice a change on the other side
   * of the wire, which an import would simply follow.
   */
  const SOURCE = fileURLToPath(new URL("../../../packages/services/src/message-service.ts", import.meta.url));

  function serverVocabulary(): string[] {
    const text = readFileSync(SOURCE, "utf8");
    const decl = /export type MessageView\s*=([^;]+);/.exec(text);
    expect(decl, "`export type MessageView` is no longer declared where this guard reads it").not.toBeNull();
    return [...decl![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  }

  /**
   * WHAT THE SERVER SAID WHEN THIS GUARD WAS WRITTEN.
   *
   * Spelled out so the check has an opinion. Compared against the union parsed above, a name
   * added, removed or renamed on the server turns THIS red — at the moment the change lands,
   * rather than as a refused request under somebody's pile of mail weeks later.
   */
  const EXPECTED = [
    "imbox", "feed", "paper_trail", "screened", "quarantine", "new_for_you", "previously_seen",
  ];

  it("the server still speaks the seven names the client was built against", () => {
    // MUTATION: drop a name from `EXPECTED`, or from the union in `message-service.ts` → red.
    expect(serverVocabulary()).toEqual(EXPECTED);
  });

  it("and every view the client asks for is one of them", () => {
    // The assertion that would have caught the live defect on its own: `ohbox`, `reads`,
    // `receipts` and `spam` are not names this server has ever known.
    const known = new Set(serverVocabulary());
    for (const [clientView, serverView] of Object.entries(SERVER_VIEW_OF)) {
      if (serverView === null) continue;
      expect(known.has(serverView), `"${clientView}" is sent as "${serverView}", which the server would refuse`).toBe(true);
    }
  });
});

describe("SPREAD, not always-defined — a client that holds everything keeps holding everything", () => {
  it("the DEMO reports nothing behind its list, and issues zero requests", async () => {
    const engine = createEngine(true, ARMED);
    expect(engine.listOlderAvailable()).toBe(false);
    expect(await engine.listOlder("ohbox")).toEqual({ state: "unavailable" });
    expect(calls).toEqual([]);
  });

  it("guarding a `FixturesAdapter` does not MANUFACTURE `listMessages`", () => {
    // `in`, not `typeof`: an always-defined forward of an absent method reads `undefined` under
    // `typeof` too, but is present as a key — and `satisfies` would still compile.
    const guarded = createSyncGate(null).guard(new FixturesAdapter()) as unknown as Record<string, unknown>;
    expect("listMessages" in guarded, "the gate invented a route on an adapter with no server").toBe(false);
  });

  it("…and a gated fixtures engine answers `unavailable`, never an empty page", async () => {
    // The two are different answers and must never be conflated: one is a client with no server,
    // the other is a server that answered and had nothing older.
    const engine = new OhmailEngine({ adapter: createSyncGate(null).guard(new FixturesAdapter()) });
    expect(engine.listOlderAvailable()).toBe(false);
    expect(await engine.listOlder("ohbox")).toEqual({ state: "unavailable" });
    expect(calls).toEqual([]);
  });
});
