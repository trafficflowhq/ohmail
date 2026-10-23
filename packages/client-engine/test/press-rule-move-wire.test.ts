import { describe, expect, it } from "vitest";
import { HttpAdapter, type EngineMutation } from "@ohmail/client-engine";

/**
 * A RULE PRESS'S MOVE SAYS SO ON THE WIRE (`pressRule`), so the server does not count it against
 * the route the same press rewrites; every other move's body is as it was.
 */
async function bodyOf(m: EngineMutation): Promise<unknown> {
  let sent: unknown = null;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body ?? "null"));
    return new Response(JSON.stringify({ id: "m1", folder: "ohmail/Receipts" }), {
      status: 200, headers: { "content-type": "application/json", "x-sync-seq": "7" },
    });
  }) as unknown as typeof globalThis.fetch;
  await new HttpAdapter({ baseUrl: "https://api.test", fetch: fetchImpl }).mutate(m, { idempotencyKey: "k1" });
  return sent;
}

describe("the move's wire body", () => {
  it("carries pressRule for a rule press's move, and nothing new otherwise", async () => {
    expect(await bodyOf({ kind: "move", messageId: "m1", folder: "ohmail/Receipts", pressRule: true }))
      .toEqual({ folder: "ohmail/Receipts", pressRule: true });
    expect(await bodyOf({ kind: "move", messageId: "m1", folder: "ohmail/Receipts" })).toEqual({ folder: "ohmail/Receipts" });
  });
});
