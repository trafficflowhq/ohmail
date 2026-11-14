import { describe, expect, it } from "vitest";
import { HttpAdapter } from "../src/index.js";

describe("discard against an older server", () => {
  it("keeps a newer draft when the server does not support conditional discard", async () => {
    let body: string | null = "Newer words";
    const adapter = new HttpAdapter({
      baseUrl: "http://localhost",
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (init?.method === "DELETE" && path === "/drafts/one") {
          body = null; // An older server ignores query parameters on its delete route.
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    });
    await expect(adapter.mutate({ kind: "draft_discard", draftId: "one", ifContentRevision: "a".repeat(64) }, {
      idempotencyKey: "discard",
    })).rejects.toMatchObject({ code: "discard_unsupported" });
    expect(body).toBe("Newer words");
  });
});
