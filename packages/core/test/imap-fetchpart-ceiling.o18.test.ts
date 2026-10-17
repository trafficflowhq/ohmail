import { describe, it, expect } from "vitest";
import { ImapAdapter, AttachmentTooLargeError } from "../src/adapters/imap.js";
import type { NativeLocator } from "../src/types.js";

/**
 * Gap `ImapAdapter.fetchPart`'s byte ceiling.
 *
 * The guard that matters is that the ceiling fires DURING the stream. A check after
 * `Buffer.concat` would enforce the same number while doing none of the work: the memory is
 * already spent, and `getMailboxLock` is held for the whole transfer — so one 90 MB part would
 * pin that mailbox's lock and queue every later fetch behind it. The tests below therefore assert
 * on how much of the stream was CONSUMED, not merely on the error.
 */

const locator: NativeLocator = { folder: "INBOX", ref: "1:42" };

/** A part delivered as `chunks`, counting how many were actually pulled. */
function fakeAdapter(chunks: Buffer[]) {
  const state = { pulled: 0, released: 0 };
  const content = (async function* () {
    for (const c of chunks) { state.pulled += 1; yield c; }
  })();
  const adapter = new ImapAdapter({
    host: "example.invalid", port: 993, secure: true, auth: { user: "u", pass: "p" },
  });
  // Stand in for the connected imapflow client: what `fetchPart` uses.
  (adapter as unknown as { delimiter: string }).delimiter = "/"; // what connect() learns on a flat server
  (adapter as unknown as { client: unknown }).client = {
    getMailboxLock: async () => ({ release: () => { state.released += 1; } }),
    // The SELECTED mailbox, as every real server reports it: `[UIDVALIDITY n]` is required on a
    // successful SELECT, and the epoch guard refuses a locator-addressed command when it is
    // absent. A stand-in without it models a server that does not exist.
    mailbox: { path: "INBOX", uidValidity: 1n },
    download: async () => ({ content, meta: { contentType: "application/pdf", filename: "x.pdf" } }),
    // The post-read witness (`streamPart`): the UID is still there, so the read was not cut.
    fetchOne: async () => ({ uid: 42 }),
  };
  return { adapter, state };
}

describe("fetchPart byte ceiling", () => {
  it("aborts MID-STREAM rather than buffering the whole oversized part", async () => {
    // Equal chunks against a ceiling between two and three of them ⇒ the third chunk crosses it.
    const chunks = Array.from({ length: 10 }, () => Buffer.alloc(100, 7));
    const { adapter, state } = fakeAdapter(chunks);

    const err = await adapter.fetchPart(locator, "2", { maxBytes: 250 }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AttachmentTooLargeError);
    expect((err as AttachmentTooLargeError).limitBytes).toBe(250);
    expect((err as AttachmentTooLargeError).bytesSoFar).toBe(300);
    // THE POINT: it stopped at the crossing chunk and never pulled the other seven.
    expect(state.pulled).toBe(3);
    // The mailbox lock is released even on the abort path, or the mailbox stays wedged — which is
    // the exact failure this ceiling exists to prevent, reintroduced by the fix for it.
    expect(state.released).toBe(1);
  });

  it("lets a part exactly AT the ceiling through", async () => {
    const chunks = [Buffer.alloc(100, 1), Buffer.alloc(100, 2)];
    const { adapter, state } = fakeAdapter(chunks);

    const out = await adapter.fetchPart(locator, "2", { maxBytes: 200 });

    expect(out.body.byteLength).toBe(200);
    expect(out.contentType).toBe("application/pdf");
    expect(state.released).toBe(1);
  });

  it("is UNBOUNDED when no ceiling is given — download-all must keep its connection usable", async () => {
    const chunks = Array.from({ length: 50 }, () => Buffer.alloc(1000, 3));
    const { adapter, state } = fakeAdapter(chunks);

    const out = await adapter.fetchPart(locator, "2");

    expect(out.body.byteLength).toBe(50_000);
    expect(state.pulled).toBe(50);
  });
});
