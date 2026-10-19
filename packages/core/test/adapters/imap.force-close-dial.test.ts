import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { ImapAdapter } from "../../src/adapters/imap.js";

/**
 * A CLOSE ENDS A DIAL IN EVERY PHASE. imapflow's `close()` during the TCP connect or the TLS
 * handshake clears its own connect timer and destroys the socket without settling the pending
 * `connect()`, which then never settles: the worker's attach deadline and its stop both waited on
 * it for ever (review of #110). The adapter now rejects its own dial when it is closed.
 *
 * The listener accepts TCP and never answers, so a TLS dial sits in its handshake. The connect
 * timeout is far above the test's own, so a rejection can only come from the close.
 */

const AUTH = { user: "someone", pass: "fixture-not-a-secret-password-password" };
const SLOW = { connectionMs: 120_000, greetingMs: 120_000, socketMs: 120_000 };
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (closers.length > 0) await closers.pop()!(); });

async function silentListener(): Promise<{ port: number; connections: () => number; next: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  let count = 0;
  let waiters: Array<() => void> = [];
  const server = net.createServer((sock) => {
    count++;
    sockets.add(sock);
    sock.on("error", () => { /* the client goes away */ });
    sock.on("close", () => sockets.delete(sock));
    for (const w of waiters) w();
    waiters = [];
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }));
  return {
    port: (server.address() as net.AddressInfo).port,
    connections: () => count,
    next: () => new Promise<void>((r) => { if (count > 0) r(); else waiters.push(r); }),
  };
}

const settleOf = (p: Promise<unknown>): Promise<{ code: unknown }> =>
  p.then(() => ({ code: "resolved" }), (err: unknown) => ({ code: (err as { code?: unknown })?.code }));

describe("ImapAdapter: a close ends a dial still in its handshake", () => {
  it("forceClose() in the TLS handshake rejects connect() as NoConnection", async () => {
    const l = await silentListener();
    const a = new ImapAdapter({ host: "127.0.0.1", port: l.port, secure: true, auth: AUTH, timeouts: SLOW });
    const dial = settleOf(a.connect());
    await l.next();
    a.forceClose();
    expect(await dial).toEqual({ code: "NoConnection" });
    // The teardown a caller runs next does not hang on the dead dial either.
    await a.close();
  }, 10_000);

  it("close() in the TLS handshake rejects connect() and returns", async () => {
    const l = await silentListener();
    const a = new ImapAdapter({ host: "127.0.0.1", port: l.port, secure: true, auth: AUTH, timeouts: SLOW });
    const dial = settleOf(a.connect());
    await l.next();
    await a.close();
    expect(await dial).toEqual({ code: "NoConnection" });
  }, 10_000);

  it("forceClose() while the OAuth token is fetched rejects connect() and never dials", async () => {
    const l = await silentListener();
    let token!: (t: string) => void;
    const fetched = new Promise<string>((r) => { token = r; });
    const a = new ImapAdapter({
      host: "127.0.0.1", port: l.port, secure: true, timeouts: SLOW,
      auth: { user: "someone", fetchAccessToken: () => fetched },
    });
    const dial = settleOf(a.connect());
    a.forceClose();
    expect(await dial).toEqual({ code: "NoConnection" });
    token("fixture-token");
    await new Promise((r) => setTimeout(r, 200));
    expect(l.connections(), "the dial went out after the close").toBe(0);
  }, 10_000);

  it("forceClose() with the greeting pending still rejects at once (control)", async () => {
    const l = await silentListener();
    const a = new ImapAdapter({ host: "127.0.0.1", port: l.port, secure: false, auth: AUTH, timeouts: SLOW });
    const dial = settleOf(a.connect());
    await l.next();
    // Past the client's own `connect` event, so imapflow is waiting on the greeting.
    await new Promise((r) => setTimeout(r, 300));
    a.forceClose();
    expect((await dial).code).not.toBe("resolved");
  }, 10_000);
});
