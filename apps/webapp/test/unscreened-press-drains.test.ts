import type { EngineMessage } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { createEngine } from "../app/shell/engine-config.js";

/**
 * "SCREEN N" MOVES MAIL, AND THE SCREEN SHOWS IT WITHOUT WAITING FOR THE NEXT POLL.
 *
 * The press writes each message's move into the change log in its own transaction, so the pull
 * that follows it carries the move. The engine used to re-read the offer and drain nothing, so
 * the moved mail showed at the window's next poll. Driven through the engine the shell builds.
 */

const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;
const NOW = "2026-09-28T08:00:00.000Z";

function message(folder: string): EngineMessage {
  return {
    id: "m1", accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: "Hello", from: { name: null, address: "stranger@example.test" }, to: [], cc: [],
    date: NOW, folder, snippet: "hi", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW,
  } as EngineMessage;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let calls: string[] = [];
let pressed = false;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  calls = [];
  pressed = false;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.startsWith("/api/sync/snapshot")) {
      return Promise.resolve(json(200, {
        asOfSeq: 1, nextCursor: null, window: { days: 0, minRows: 0 },
        changes: [{ type: "message", op: "create", id: "m1", seq: 1, updatedAt: NOW, entity: message("INBOX") }],
      }));
    }
    if (url.startsWith("/api/sync?")) {
      // The log carries the press's move once the press has written it, and nothing before.
      const moves = pressed
        ? [{ type: "message", op: "move", id: "m1", seq: 2, updatedAt: NOW, entity: message("ohmail/Screener"),
            move: { from: "INBOX", to: "ohmail/Screener" } }]
        : [];
      return Promise.resolve(json(200, {
        changes: { creates: [], updates: [], moves, deletes: [] },
        cursor: pressed ? "2" : "1", hasMore: false, serverTime: NOW,
      }));
    }
    if (url === "/api/screener/unscreened") {
      if (method === "POST") {
        pressed = true;
        return Promise.resolve(json(200, {
          screened: [{ address: "stranger@example.test", count: 1, newestAt: NOW }], total: 1,
        }));
      }
      return Promise.resolve(json(200, {
        groups: pressed ? [] : [{ address: "stranger@example.test", count: 1, newestAt: NOW }],
        total: pressed ? 0 : 1, max: 200,
      }));
    }
    return Promise.resolve(json(404, { error: { code: "not_found", message: "no stub for this route" } }));
  }) as unknown as typeof fetch;
});

afterEach(() => { globalThis.fetch = originalFetch; });

async function settle(engine: OhmailEngine, done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 0));
  void engine;
}

describe("the undecided-sender press drains once after its answer", () => {
  it("the moved message is in the Screener without waiting for the next poll", async () => {
    const engine = createEngine(false, ARMED);
    await engine.start();
    expect(engine.read().get<EngineMessage>("message", "m1")?.folder).toBe("INBOX");
    const before = calls.length;

    await engine.screenUnscreenedSenders();
    const sinceThePress = () => calls.slice(before);
    await settle(engine, () => engine.read().get<EngineMessage>("message", "m1")?.folder === "ohmail/Screener");

    const post = sinceThePress().indexOf("POST /api/screener/unscreened");
    const pulls = sinceThePress().filter((c, i) => i > post && c.startsWith("GET /api/sync?"));
    expect(post, "the press never reached the door").toBeGreaterThanOrEqual(0);
    expect(pulls, `no pull followed the press: ${sinceThePress().join(", ")}`).toHaveLength(1);
    expect(engine.read().get<EngineMessage>("message", "m1")?.folder).toBe("ohmail/Screener");
  });
});
