import { describe, expect, it } from "vitest";
import { HttpAdapter, MutationRejectedError } from "@ohmail/client-engine";
import { routePath } from "../src/adapters/route-path.js";

/**
 * EVERY REQUEST THE ENGINE'S CLIENT MAKES GOES OUT BY ITS ROUTE'S NAME. The name is the wire's,
 * `"METHOD /pattern"`; the client fills the pattern and sends exactly the request it sent when
 * each call site wrote its own path. Held here: what a name becomes, that a missing parameter is
 * refused before anything is sent, and that the calls a person's day is made of still ask for the
 * same method and the same address.
 */

describe("a route's name, as a request", () => {
  it("splits the method off at the first space and fills each parameter, percent-encoded", () => {
    expect(routePath("GET /hello", {})).toEqual({ method: "GET", path: "/hello" });
    expect(routePath("GET /messages/:id/body", { id: "m-1" })).toEqual({ method: "GET", path: "/messages/m-1/body" });
    expect(routePath("DELETE /folders/:id/op", { id: "a b/c?d" }))
      .toEqual({ method: "DELETE", path: "/folders/a%20b%2Fc%3Fd/op" });
  });

  it("REFUSES a parameter the pattern names and the caller did not give, and says which", () => {
    const asked = () => routePath("GET /messages/:id/body", {});
    expect(asked).toThrow(MutationRejectedError);
    expect(asked).toThrow("GET /messages/:id/body was asked without its id");
    try { asked(); } catch (err) {
      expect((err as MutationRejectedError).retryable).toBe(false);
      expect((err as MutationRejectedError).code).toBe("protocol");
    }
    // Not a string is not given: `:id` is never sent as the letters "undefined" or "null".
    expect(() => routePath("GET /drafts/:id", { id: undefined })).toThrow("without its id");
    expect(() => routePath("GET /drafts/:id", { id: null })).toThrow("without its id");
  });
});

/** An adapter whose transport records what it was asked and answers `body` at `status`. */
function recording(body: unknown, status = 200) {
  const asked: Array<{ method: string; url: string; body: unknown }> = [];
  const adapter = new HttpAdapter({
    baseUrl: "http://wire.test",
    getCookie: () => null,
    fetch: async (url, init) => {
      asked.push({
        method: init?.method ?? "GET", url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "x-sync-seq": "7" } });
    },
  });
  return { adapter, asked };
}

describe("the calls, as they leave", () => {
  it("asks for a letter's body at its own address, the id percent-encoded", async () => {
    const { adapter, asked } = recording({ text: "hello", html: null, loadedRemoteContent: false });
    const body = await adapter.fetchBody("m 1");
    expect(asked).toEqual([{ method: "GET", url: "http://wire.test/messages/m%201/body", body: undefined }]);
    expect(body.text).toBe("hello");
  });

  it("carries a query exactly as the call wrote it", async () => {
    const { adapter, asked } = recording({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "MA", hasMore: false, serverTime: "2026-01-01T00:00:00.000Z" });
    await adapter.sync({ since: "0", limit: 50, types: ["message", "tag"] });
    expect(asked.map((a) => `${a.method} ${a.url}`)).toEqual(["GET http://wire.test/sync?since=0&limit=50&types=message%2Ctag"]);
  });

  it("asks for a snapshot's first page with no query mark, and a later one with its cursor", async () => {
    const page = { asOfSeq: 3, changes: [], nextCursor: null, window: { days: 90, minRows: 200 } };
    const { adapter, asked } = recording(page);
    await adapter.snapshot();
    await adapter.snapshot({ cursor: "c1" });
    expect(asked.map((a) => a.url)).toEqual(["http://wire.test/sync/snapshot", "http://wire.test/sync/snapshot?cursor=c1"]);
  });

  it("sends a move as a POST to the letter, with the folder and nothing it was not given", async () => {
    const letter = { id: "m1", folder: "ohmail/News", updatedAt: "2026-01-01T00:00:00.000Z" };
    const { adapter, asked } = recording(letter);
    await adapter.mutate({ kind: "move", messageId: "m1", folder: "ohmail/News" }, { idempotencyKey: "k1" });
    expect(asked).toEqual([{ method: "POST", url: "http://wire.test/messages/m1/move", body: { folder: "ohmail/News" } }]);
  });

  it("sends a tag's deletion as a DELETE with no body, and reads a 204 as done", async () => {
    const { adapter, asked } = recording(null, 204);
    const out = await adapter.mutate({ kind: "tag_delete", tagId: "t1" }, { idempotencyKey: "k2" });
    expect(asked).toEqual([{ method: "DELETE", url: "http://wire.test/tags/t1", body: undefined }]);
    expect(out).toEqual({ changes: [], seq: 7 });
  });
});
