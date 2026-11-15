import { afterEach, describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { createServer } from "node:net";
import tls from "node:tls";
import { pinnedHttpRequest, type PinnedResponse } from "../src/net/index.js";
import { answerEach, farSide, localhostIdentity, onOnePort, SWITCH } from "./far-side.js";

/**
 * THE PINNED REQUEST SETTLES, WHATEVER THE FAR SIDE ANSWERS. A letter's sender names the host, so the far side may
 * answer anything; each case is a raw listener of its own on 127.0.0.1 that writes exactly the bytes it names. The
 * deadline is armed as every caller arms it, an abort when it passes, and a case is watched for three of them.
 */

const DEADLINE_MS = 1_000;
const NOTHING_LEFT = { connections: 0, listeners: 0 };

const closers: (() => Promise<void>)[] = [];
const timers: ReturnType<typeof setTimeout>[] = [];
afterEach(async () => {
  for (const timer of timers.splice(0)) clearTimeout(timer);
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** The address of a far side that answers with `act`, closed after the case. */
async function answering(act: Parameters<typeof farSide>[0]): Promise<string> {
  const far = await farSide(act);
  closers.push(far.close);
  return `${far.url}/x`;
}

/** The request as a caller makes it, under the caller's deadline. */
function ask(url: string, method = "GET", deadlineMs = DEADLINE_MS, pin = ["127.0.0.1"]) {
  const caller = new AbortController();
  timers.push(setTimeout(() => caller.abort(), deadlineMs));
  const body = method === "POST" ? "a=1" : undefined;
  return { signal: caller.signal, asked: pinnedHttpRequest(url, { method, pin, signal: caller.signal, body }) };
}

/** An answer's body, read to its end. */
async function text(res: PinnedResponse): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of res.stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** How `p` settles and when, or `never` once three deadlines have passed. */
async function settle(p: Promise<unknown>) {
  const started = Date.now();
  const never = new Promise<{ settled: "never" }>((done) => timers.push(setTimeout(() => done({ settled: "never" }), 3 * DEADLINE_MS)));
  const out = await Promise.race([p.then((value) => ({ settled: "resolved", value }), (error: unknown) => ({ settled: "rejected", error })), never]);
  return { ...out, ms: Date.now() - started };
}

/** What is still open after a deadline's wait: this process's connections, the far side's too (no case closes it), and the caller's abort listeners. */
async function left(signal: AbortSignal): Promise<typeof NOTHING_LEFT> {
  const connections = (): number => process.getActiveResourcesInfo().filter((r) => r === "TCPSocketWrap").length;
  for (const until = Date.now() + DEADLINE_MS; connections() > 0 && Date.now() < until;) await new Promise((r) => setTimeout(r, 10));
  return { connections: connections(), listeners: getEventListeners(signal, "abort").length };
}

describe("pinnedHttpRequest settles inside the caller's deadline and leaves nothing open", () => {
  // No case tells the upgrade listener from the close listener: without the first, Node ends the handed-over
  // connection itself and the second refuses the request with the same code at the same moment; only the message
  // differs, and no caller reads it.
  it.each(["GET", "POST"])("%s: a change of protocol (101), then a close, is refused at once", async (method) => {
    const { asked, signal } = ask(await answering((socket) => socket.end(SWITCH)), method);
    const out = await settle(asked);
    expect(out).toMatchObject({ settled: "rejected", error: { code: "ECONNRESET" } });
    expect(out.ms).toBeLessThan(DEADLINE_MS);
    expect(await left(signal)).toEqual(NOTHING_LEFT);
  });

  it.each(["GET", "POST"])("%s: a change of protocol (101) held open is refused at once, and the connection ended", async (method) => {
    const { asked, signal } = ask(await answering((socket) => socket.write(SWITCH)), method);
    const out = await settle(asked);
    expect(out).toMatchObject({ settled: "rejected", error: { code: "ECONNRESET" } });
    expect(out.ms).toBeLessThan(DEADLINE_MS);
    // The far side holds its end open, so only the request can have ended the connection.
    expect(await left(signal), "the request kept the switched connection open").toEqual(NOTHING_LEFT);
  });

  it("a close with no bytes is refused at once", async () => {
    const { asked, signal } = ask(await answering((socket) => socket.end()), "POST");
    const out = await settle(asked);
    expect(out).toMatchObject({ settled: "rejected", error: { code: "ECONNRESET" } });
    expect(out.ms).toBeLessThan(DEADLINE_MS);
    expect(await left(signal)).toEqual(NOTHING_LEFT);
  });

  it("an answer's head, then silence: the head comes back at once, and the deadline ends the body", async () => {
    const { asked, signal } = ask(await answering((socket) => socket.write("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n")), "GET", 300);
    const res = await asked;
    expect(res.status).toBe(200);
    const body = await settle((async () => { for await (const _ of res.stream) { /* the caller reads */ } })());
    expect(body.settled).toBe("rejected");
    expect(body.ms).toBeLessThan(DEADLINE_MS);
    expect(await left(signal)).toEqual(NOTHING_LEFT);
  });

  it("a connection handed over with no answer at all (an accepted CONNECT) is refused when it closes", async () => {
    const { asked, signal } = ask(await answering((socket) => socket.write("HTTP/1.1 200 Connection established\r\n\r\n")), "CONNECT");
    const out = await settle(asked);
    expect(out).toMatchObject({ settled: "rejected", error: { code: "ECONNRESET" } });
    expect(out.ms).toBeLessThan(DEADLINE_MS);
    expect(await left(signal)).toEqual(NOTHING_LEFT);
  });

  it("a 101 without the Upgrade lines changes no protocol: it comes back at once as the answer it is", async () => {
    const { asked } = ask(await answering((socket) => socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n")));
    const out = await settle(asked);
    expect(out).toMatchObject({ settled: "resolved", value: { status: 101 } });
    expect(out.ms).toBeLessThan(DEADLINE_MS);
  });
});

/**
 * EVERY REQUEST DIALS THE ADDRESS IT WAS PINNED TO. Two far sides answer on one port of this machine, at two of its
 * addresses, each with its own address, and keep every connection open. One name and one port: a connection kept for
 * them would carry a later request to an address that request's own check never saw.
 */
describe("every request dials its own pin, whatever went to the same name and port before it", () => {
  /** Two raw far sides on one port, closed after the case; `null` where this machine has one address only. */
  async function twoAddresses(identity?: { key: string; cert: string }) {
    const far = await onOnePort((address) => identity
      ? tls.createServer(identity, (socket) => answerEach(socket, address))
      : createServer((socket) => answerEach(socket, address)));
    if (far !== null) closers.push(far.close);
    return far;
  }

  /** The first request read to its end, then the second, at once: what the second read, and what was left open. */
  async function inTurn(url: string, [first, second]: readonly [string, string]) {
    const one = await ask(url, "GET", DEADLINE_MS, [first]).asked;
    expect(await text(one)).toBe(first);
    const two = ask(url, "GET", DEADLINE_MS, [second]);
    return { second: await text(await two.asked), left: await left(two.signal) };
  }

  it("a second request inside the kept-alive window, pinned elsewhere, is answered at its own address", async (ctx) => {
    const far = await twoAddresses();
    if (far === null) return ctx.skip();
    const out = await inTurn(`http://localhost:${far.port}/x`, far.addresses);
    // The far sides keep their ends open, so only the requests can have ended the connections.
    expect(out, "the second request rode the first one's connection, or a connection outlived its request")
      .toEqual({ second: far.addresses[1], left: NOTHING_LEFT });
  });

  it("the same through TLS", async (ctx) => {
    const identity = localhostIdentity();
    const far = await twoAddresses(identity);
    if (far === null) return ctx.skip();
    // The certificate is trusted for this case alone, as a public one is; nothing of the check is turned off.
    const trusted = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...trusted, identity.cert]);
    try {
      const out = await inTurn(`https://localhost:${far.port}/x`, far.addresses);
      expect(out, "the second request rode the first one's connection, or a connection outlived its request")
        .toEqual({ second: far.addresses[1], left: NOTHING_LEFT });
    } finally {
      tls.setDefaultCACertificates(trusted);
    }
  });

  it("the same when the first answer was dropped unread, as the unsubscribe and the wake drop theirs", async (ctx) => {
    const far = await twoAddresses();
    if (far === null) return ctx.skip();
    const [first, second] = far.addresses;
    const url = `http://localhost:${far.port}/x`;
    (await ask(url, "GET", DEADLINE_MS, [first]).asked).stream.destroy();
    const two = ask(url, "GET", DEADLINE_MS, [second]);
    expect({ second: await text(await two.asked), left: await left(two.signal) }).toEqual({ second, left: NOTHING_LEFT });
  });
});
