import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineMessage } from "@ohmail/client-engine";
import { createEngine } from "../app/shell/engine-config.js";
import { dispatchScreeningChange, movesAtLanding, planScreeningChange, senderScreening } from "@ohmail/app-logic/press/sender-screening";
import { screeningShown } from "@ohmail/app-logic/press/press-verdict";

/**
 * A SCREENING PRESS SAYS WHAT THE LIST SHOWS AFTER ITS MOVES SETTLED.
 *
 * A press that writes no rule is a set of moves, and its sentence counts the mail the list shows
 * at the place. The press used to answer before the moves did, so a move the server refused was
 * still painted at the place and counted. Driven through the engine the shell builds.
 */

const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;
const NOW = "2026-09-28T08:00:00.000Z";

function message(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: NOW, folder: "INBOX", snippet: "hi", unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: NOW,
  } as EngineMessage;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const later = (ms: number, r: Response): Promise<Response> => new Promise((ok) => setTimeout(() => ok(r), ms));

const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/sync/snapshot")) {
      return Promise.resolve(json(200, {
        asOfSeq: 1, nextCursor: null, window: { days: 0, minRows: 0 },
        changes: ["m1", "m2"].map((id, i) => ({
          type: "message", op: "create", id, seq: 1, updatedAt: NOW,
          entity: message(id, i === 0 ? "a@x.test" : "b@x.test"),
        })),
      }));
    }
    if (url.startsWith("/api/sync?")) {
      return Promise.resolve(json(200, {
        changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: NOW,
      }));
    }
    // The server takes m1's move and refuses m2's, a moment later.
    if (method === "POST" && url === "/api/messages/m1/move") return later(20, json(200, { messageId: "m1", folder: "ohmail/News" }));
    if (method === "POST" && url === "/api/messages/m2/move") {
      return later(40, json(409, { error: { code: "conflict", message: "the mail server would not move it" } }));
    }
    return Promise.resolve(json(404, { error: { code: "not_found", message: "no stub for this route" } }));
  }) as unknown as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe("a domain press that writes no rule", () => {
  it("answers after its moves settled, so a refused one is not counted at the place", async () => {
    const engine = createEngine(false, ARMED);
    await engine.start();
    const sender = senderScreening(engine.verbRead(), "m1");
    expect(sender, "the sender sheet cannot read the seed").not.toBeNull();
    const plan = planScreeningChange(sender!, "reads", "domain", false, false);
    // The lists here are unpartitioned (`consent: null`), so every candidate lands at the place.
    const moves = movesAtLanding(plan, null);
    expect(moves.map((m) => m.kind)).toEqual(["move", "move"]);

    await dispatchScreeningChange(plan, moves, (m) => engine.mutate(m));
    const shown = screeningShown(engine.verbRead(), sender!.scopes.domain.messages, "reads", {
      consent: null, now: new Date(NOW), ownAddresses: [],
    });
    expect(shown, "the refused move was read back at the place").toEqual(["m1"]);
  });
});
