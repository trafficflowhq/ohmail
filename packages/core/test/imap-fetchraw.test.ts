import { describe, it, expect } from "vitest";
import {
  ImapAdapter, RawMessageTooLargeError, MessageGoneError, ReadNotAnsweredError, DEFAULT_FETCH_RAW_MAX_BYTES,
} from "../src/adapters/imap.js";
import type { NativeLocator } from "../src/types.js";

/**
 * `ImapAdapter.fetchRaw` — re-reading ONE whole message without changing anything about it.
 *
 * Three properties are worth a guard, and they are the three a caller cannot check for itself:
 *
 *  · it asks for the SOURCE, which is the only thing that makes the wire form `BODY.PEEK[]` and
 *    therefore the only thing that stops a re-read from marking somebody's mail as read;
 *  · the ceiling reaches the DRIVER rather than being enforced by abandoning the stream, because
 *    the caller runs on a connection it must hand back intact;
 *  · a short read is REFUSED. This is the one that matters most: the caller re-parses these bytes
 *    and decides whether the message is sensitive, and a message missing its tail is a message
 *    with less to find. Returning it quietly biases that decision toward "clean".
 */

const locator: NativeLocator = { folder: "INBOX", ref: "1:42" };

/** A message delivered as `chunks`, recording what the adapter asked the driver for. `uidSearch`
    is the server's answer to `UID SEARCH UID n`: an array, or `false` for a refused one. */
function fakeAdapter(chunks: Buffer[], expectedSize?: number, uidSearch: number[] | false = []) {
  const state = {
    pulled: 0,
    released: 0,
    searched: 0,
    part: "unset" as unknown,
    options: null as Record<string, unknown> | null,
  };
  const content = (async function* () {
    for (const c of chunks) { state.pulled += 1; yield c; }
  })();
  const adapter = new ImapAdapter({
    host: "example.invalid", port: 993, secure: true, auth: { user: "u", pass: "p" },
  });
  const total = chunks.reduce((n, c) => n + c.length, 0);
  (adapter as unknown as { delimiter: string }).delimiter = "/"; // what connect() learns on a flat server
  (adapter as unknown as { established: boolean }).established = true;
  (adapter as unknown as { client: unknown }).client = {
    search: async () => { state.searched += 1; return uidSearch; },
    getMailboxLock: async () => ({ release: () => { state.released += 1; } }),
    // The SELECTED mailbox, as every real server reports it: `[UIDVALIDITY n]` is required on a
    // successful SELECT, and the epoch guard refuses a locator-addressed command when it is
    // absent. A stand-in without it models a server that does not exist.
    mailbox: { path: "INBOX", uidValidity: 1n },
    download: async (_range: string, part: unknown, options: Record<string, unknown>) => {
      state.part = part;
      state.options = options;
      return { content, meta: { expectedSize: expectedSize ?? total, contentType: "message/rfc822" } };
    },
  };
  return { adapter, state };
}

describe("fetchRaw — a read-only re-read of one whole message", () => {
  it("asks for the SOURCE, which is what makes the wire form BODY.PEEK[]", async () => {
    const { adapter, state } = fakeAdapter([Buffer.from("From: a@b\r\n\r\nhi")]);

    await adapter.fetchRaw(locator);

    // `undefined`, not `""`. Both reach imapflow's source branch — one because it is the absence
    // of a part, the other because an empty string happens to be falsy. Only the first says so.
    expect(state.part).toBeUndefined();
    expect(state.options).toMatchObject({ uid: true });
  });

  it("returns the bytes UNCHANGED — a re-parse has to see what the server holds", async () => {
    const raw = "From: a@b\r\nSubject: x\r\n\r\nline one\r\nline two\r\n";
    const { adapter } = fakeAdapter([Buffer.from(raw, "utf8")]);

    const out = await adapter.fetchRaw(locator);

    expect(Buffer.from(out).toString("utf8")).toBe(raw);
  });

  it("hands the ceiling to the DRIVER instead of abandoning the stream", async () => {
    // The contrast with `fetchPart` is the whole design: that one throws out of its own
    // `for await`, which kills the connection. This one must leave the socket usable, so the
    // limit has to be the driver's — every chunk it stops before is a request never issued.
    const { adapter, state } = fakeAdapter([Buffer.alloc(10)]);

    await adapter.fetchRaw(locator, { maxBytes: 4096 });

    expect(state.options).toMatchObject({ uid: true, maxBytes: 4096 });
  });

  it("defaults the ceiling rather than reading unbounded", async () => {
    const { adapter, state } = fakeAdapter([Buffer.alloc(10)]);

    await adapter.fetchRaw(locator);

    expect(state.options?.maxBytes).toBe(DEFAULT_FETCH_RAW_MAX_BYTES);
  });

  it("REFUSES a message over the ceiling, naming the server's own size", async () => {
    // The driver truncates silently at its limit, so "what came back" cannot detect this. The
    // server's RFC822.SIZE can, and it is a real number rather than a guess precisely because
    // nothing was abandoned.
    const { adapter, state } = fakeAdapter([Buffer.alloc(200)], 9_000_000);

    const err = await adapter.fetchRaw(locator, { maxBytes: 200 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RawMessageTooLargeError);
    expect((err as RawMessageTooLargeError).sizeBytes).toBe(9_000_000);
    expect((err as RawMessageTooLargeError).limitBytes).toBe(200);
    expect(state.released).toBe(1);
  });

  it("REFUSES a short read even when no ceiling explains it", async () => {
    // A transfer that ended early for any other reason. Returning these bytes would hand the
    // caller a message whose tail is missing, with nothing to notice it by.
    const { adapter } = fakeAdapter([Buffer.alloc(100)], 500);

    const err = await adapter.fetchRaw(locator, { maxBytes: 4096 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RawMessageTooLargeError);
  });

  it("accepts a read that MATCHES the declared size", async () => {
    const { adapter, state } = fakeAdapter([Buffer.alloc(100), Buffer.alloc(400)], 500);

    const out = await adapter.fetchRaw(locator, { maxBytes: 4096 });

    expect(out.byteLength).toBe(500);
    expect(state.pulled).toBe(2);
    expect(state.released).toBe(1);
  });

  it("tolerates a server that declares no size — there is nothing to compare against", async () => {
    const { adapter, state } = fakeAdapter([Buffer.alloc(64)]);
    (adapter as unknown as { client: { download: unknown } }).client.download = async () => ({
      content: (async function* () { yield Buffer.alloc(64); })(),
      meta: { contentType: "message/rfc822" },
    });

    const out = await adapter.fetchRaw(locator, { maxBytes: 4096 });

    expect(out.byteLength).toBe(64);
    void state;
  });

  it("raises MessageGoneError when the locator no longer resolves", async () => {
    const { adapter, state } = fakeAdapter([]);
    (adapter as unknown as { client: { download: unknown } }).client.download = async () => ({});

    const err = await adapter.fetchRaw(locator).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MessageGoneError);
    // The lock is released on the failure path too, or one vanished message wedges the mailbox.
    expect(state.released).toBe(1);
  });
});

/**
 * AN EMPTY ANSWER IS NOT A GONE MESSAGE. imapflow answers a FETCH throttled past its retries (and
 * one sent with no mailbox selected) with nothing and no error, exactly as it answers an absent
 * UID. Only the server's UID SEARCH tells them apart, and an unanswered one is "not now".
 */
describe("an empty read is asked again by UID before it is called gone", () => {
  const empty = (adapter: ImapAdapter): void => {
    const client = (adapter as unknown as { client: Record<string, unknown> }).client;
    client.download = async () => ({});
    client.fetchOne = async () => false;
  };
  const read = {
    fetchRaw: (a: ImapAdapter) => a.fetchRaw(locator),
    fetchPart: (a: ImapAdapter) => a.fetchPart(locator, "2"),
    fetchStructure: (a: ImapAdapter) => a.fetchStructure(locator),
  };
  const outcomes: Record<keyof typeof read, Record<"absent" | "present" | "unanswered", string>> = {
    fetchRaw: { absent: "gone", present: "not now", unanswered: "not now" },
    // Present with no structure answered either: the throttle covers the tree too.
    fetchPart: { absent: "gone", present: "not now", unanswered: "not now" },
    fetchStructure: { absent: "null", present: "not now", unanswered: "not now" },
  };
  const said = (v: unknown): string => v instanceof ReadNotAnsweredError && v.code === "ETHROTTLE" ? "not now"
    : v instanceof MessageGoneError ? "gone" : v === null ? "null" : String(v);
  for (const [name, call] of Object.entries(read) as Array<[keyof typeof read, (a: ImapAdapter) => Promise<unknown>]>) {
    for (const [answer, search] of [["absent", []], ["present", [42]], ["unanswered", false]] as const) {
      it(`${name}, the UID search ${answer}: ${outcomes[name][answer]}`, async () => {
        const { adapter, state } = fakeAdapter([], undefined, search as number[] | false);
        empty(adapter);
        const got = await call(adapter).then((v) => v, (e: unknown) => e);
        expect({ said: said(got), searched: state.searched, released: state.released })
          .toEqual({ said: outcomes[name][answer], searched: 1, released: 1 });
      });
    }
  }

  it("a whole part whose witness fetch comes back empty: the search decides, never the empty answer", async () => {
    for (const [search, want] of [[false, "not now"], [[], "gone"], [[42], "whole"]] as const) {
      const { adapter } = fakeAdapter([], undefined, search as number[] | false);
      const client = (adapter as unknown as { client: Record<string, unknown> }).client;
      client.download = async () => ({ content: (async function* () { yield Buffer.alloc(8 * 1024); })(), meta: {} });
      client.fetchOne = async () => false;
      const got = await adapter.fetchPart(locator, "2").then(() => "whole", (e: unknown) => said(e));
      expect(got, `search ${JSON.stringify(search)}`).toBe(want);
    }
  });

  it("an empty part of a message still there: the server's tree decides between not now and a missing section", async () => {
    const tree = (pdfSize: number | null, parts = 2) => ({
      type: "multipart/mixed",
      childNodes: [{ type: "text/plain", size: 10 }, { type: "application/pdf", size: pdfSize }].slice(0, parts),
    });
    for (const [what, structure, want] of [
      ["the section is declared with bytes", tree(4), "not now"],
      ["the section is not in the tree", tree(4, 1), "gone"],
      ["the section is declared empty", tree(0), "gone"],
    ] as const) {
      const { adapter, state } = fakeAdapter([], undefined, [42]);
      const client = (adapter as unknown as { client: Record<string, unknown> }).client;
      client.download = async () => ({});
      client.fetchOne = async (_r: string, query: Record<string, unknown>) => (query.bodyStructure ? { uid: 42, bodyStructure: structure } : false);
      const got = await adapter.fetchPart(locator, "2").then(() => "whole", (e: unknown) => said(e));
      expect({ got, released: state.released }, what).toEqual({ got: want, released: 1 });
    }
  });

  it("no mailbox selected is a lost connection, not an answer", async () => {
    const { adapter, state } = fakeAdapter([], undefined, []);
    empty(adapter);
    const client = (adapter as unknown as { client: Record<string, unknown> }).client;
    // The lock was granted, then the selection went: the epoch guard reads `mailbox` first.
    let reads = 0;
    Object.defineProperty(client, "mailbox", { get: () => (reads++ === 0 ? { path: "INBOX", uidValidity: 1n } : false) });
    const got = await adapter.fetchRaw(locator).then((v) => v, (e: unknown) => e);
    expect({ code: (got as { code?: string }).code, searched: state.searched }).toEqual({ code: "NoConnection", searched: 0 });
  });
});
