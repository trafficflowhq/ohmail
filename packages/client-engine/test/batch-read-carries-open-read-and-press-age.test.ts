import type { EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { HttpAdapter } from "../src/index.js";

// The batch read's PATCH carries both halves the server joins: the open read's flag in the body
// (without it nothing is stamped) and the press age in the header (without it no per-id floor applies).

describe("the batch read's request carries openRead and the press age", () => {
  it("PATCH /messages has openRead: true in its body and x-ohmail-press-age set", async () => {
    const seen: Array<{ method: string; path: string; age: string | null; body: unknown }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      seen.push({
        method: init?.method ?? "GET", path: String(url).replace("http://h", ""), age: headers.get("x-ohmail-press-age"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const adapter = new HttpAdapter({ baseUrl: "http://h", fetch: fetchImpl as typeof fetch });
    const m = { kind: "mark_seen", messageIds: ["11111111-1111-4111-8111-111111111111"], unread: false, openRead: true } as EngineMutation;
    await adapter.mutate(m, { idempotencyKey: "k", pressAgeMs: 90_061_000 });
    expect(seen).toHaveLength(1);
    expect([seen[0]!.method, seen[0]!.path]).toEqual(["PATCH", "/messages"]);
    expect((seen[0]!.body as { openRead?: unknown }).openRead, "the open read's flag").toBe(true);
    expect(seen[0]!.age, "the press age").toBe("90061000");
  });
});
