/**
 * A PICTURE ON A PAIRED PHONE COMES THROUGH THE SERVER, AND THE SENDER NEVER SEES THE PHONE.
 *
 * Two local fixture servers, both recorded: the SENDER's image host and the PAIRED server. The
 * route is the one the frame takes (`imageRouteOf(session)` → `fetchRemoteImages`). On a paired
 * door the sender's host must see nothing; on the standalone door this phone dials it, and the
 * notice says so. No real sender is ever dialled.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchRemoteImages, imageRouteOf, imagesSeenBy } from "../src/mail/remote-images";

/** A 1×2 PNG — two pixels, so it is a picture and not a beacon by size. */
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000020806000000990d0a3b0000001049444154789c63f8cfc0f01f0005fe02fea7d6a5c50000000049454e44ae426082",
  "hex",
);

/** A 1×1 PNG — a beacon by its own bytes, whatever its tag declared. */
const PIXEL = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082",
  "hex",
);
/** Labelled a PNG, with no header any decoder sizes. */
const UNSIZED = Buffer.from("labelled a picture, sized by nothing");

interface Seen { method: string; path: string; bearer: boolean }

function recorder(answer: (req: IncomingMessage) => { status: number; type?: string; body?: Buffer }) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method ?? "", path: req.url ?? "", bearer: Boolean(req.headers.authorization) });
    const a = answer(req);
    res.writeHead(a.status, a.type ? { "content-type": a.type } : {});
    res.end(a.body ?? "");
  });
  return { seen, server };
}

let consentStatus = 200;
const sender = recorder((req) => ({
  status: 200, type: "image/png", body: req.url === "/pixel.png" ? PIXEL : req.url === "/odd.png" ? UNSIZED : PNG,
}));
const paired = recorder((req) => {
  if (req.method === "POST" && /^\/messages\/[^/]+\/load-remote$/.test(req.url ?? "")) {
    return { status: consentStatus, type: "application/json", body: Buffer.from("{}") };
  }
  if (req.method === "GET" && (req.url ?? "").startsWith("/img?")) return { status: 200, type: "image/png", body: PNG };
  return { status: 404 };
});

const origin = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
const listen = (s: Server) => new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));

beforeAll(async () => {
  await listen(sender.server);
  await listen(paired.server);
});
afterAll(async () => {
  await new Promise((r) => sender.server.close(r));
  await new Promise((r) => paired.server.close(r));
});
beforeEach(() => {
  sender.seen.length = 0;
  paired.seen.length = 0;
  consentStatus = 200;
});

/** The session shape the connection layer hands the world, over the paired fixture. */
function session(flavor: string, standalone = false) {
  return {
    standalone,
    profile: { origin: origin(paired.server), apiBase: null, flavor },
    fetch: (url: string, init?: unknown) => {
      const i = (init ?? {}) as RequestInit;
      return fetch(url, { ...i, headers: { ...(i.headers as Record<string, string>), authorization: "Bearer t" } });
    },
  } as unknown as Parameters<typeof imageRouteOf>[0];
}

const urls = () => [`${origin(sender.server)}/a.png`, `${origin(sender.server)}/b.png`];

describe("a paired phone's pictures come through the paired server's /img", () => {
  it("the press is recorded, each picture is asked of the server, and the sender sees nothing", async () => {
    const got = await fetchRemoteImages(imageRouteOf(session("managed")), "m-1", urls(), { consented: false });
    expect(sender.seen, "the phone dialled the sender's image host").toEqual([]);
    expect(paired.seen.map((r) => `${r.method} ${r.path.split("?")[0]}`)).toEqual([
      "POST /messages/m-1/load-remote", "GET /img", "GET /img",
    ]);
    expect(paired.seen.every((r) => r.bearer), "a request to the server went without the session").toBe(true);
    const asked = paired.seen.slice(1).map((r) => new URL(r.path, "http://x").searchParams);
    expect(asked.map((q) => [q.get("mid"), q.get("u")])).toEqual(urls().map((u) => ["m-1", u]));
    expect([...got.minted.keys()]).toEqual(urls());
    expect([...got.minted.values()].every((v) => v.startsWith("data:image/png;base64,"))).toBe(true);
    expect(got.consentRefused).toBe(false);
    expect(got.pixels, "the server's /img sizes a paired door's pictures").toEqual([]);
  });

  it("a body the server already marked loaded is not asked again", async () => {
    await fetchRemoteImages(imageRouteOf(session("selfhost")), "m-2", urls(), { consented: true });
    expect(paired.seen.map((r) => r.method)).toEqual(["GET", "GET"]);
    expect(sender.seen).toEqual([]);
  });

  it("a press the server refuses fetches nothing, from anybody, and says so", async () => {
    consentStatus = 403;
    const got = await fetchRemoteImages(imageRouteOf(session("managed")), "m-3", urls(), { consented: false });
    expect(got.consentRefused).toBe(true);
    expect(got.minted.size).toBe(0);
    expect(paired.seen.map((r) => r.method)).toEqual(["POST"]);
    expect(sender.seen).toEqual([]);
  });

  it("a desktop host is a paired server too — and it is the reader's computer that dials", async () => {
    const route = imageRouteOf(session("desktop-host"));
    await fetchRemoteImages(route, "m-4", urls(), { consented: true });
    expect(sender.seen).toEqual([]);
    expect(imagesSeenBy(route)).toBe("computer");
    expect(imagesSeenBy(imageRouteOf(session("managed")))).toBeNull();
    expect(imagesSeenBy(imageRouteOf(session("selfhost")))).toBeNull();
  });
});

describe("the standalone door has no server, so this phone dials — and the notice names it", () => {
  it("the pictures come from the sender's host, with no session and nothing of ours", async () => {
    const route = imageRouteOf(session("local", true));
    const got = await fetchRemoteImages(route, "m-5", urls(), { consented: false });
    expect(paired.seen, "the standalone door asked a server it does not have").toEqual([]);
    expect(sender.seen.map((r) => r.path)).toEqual(["/a.png", "/b.png"]);
    expect(sender.seen.some((r) => r.bearer), "a credential reached the sender").toBe(false);
    expect(got.minted.size).toBe(2);
    expect(imagesSeenBy(route)).toBe("phone");
  });

  it("a picture whose own bytes are 1×1 is not drawn and is reported; bytes nothing can size are not drawn", async () => {
    const route = imageRouteOf(session("local", true));
    const pixel = `${origin(sender.server)}/pixel.png`;
    const odd = `${origin(sender.server)}/odd.png`;
    const picture = urls()[0]!;
    const got = await fetchRemoteImages(route, "m-7", [pixel, odd, picture], { consented: false });
    expect([...got.minted.keys()], "a disguised pixel or an unsized body was drawn").toEqual([picture]);
    expect(got.pixels).toEqual([pixel]);
  });

  it("with nothing live, nothing is fetched", async () => {
    const got = await fetchRemoteImages({ via: "none" }, "m-6", urls(), { consented: true });
    expect(got.minted.size).toBe(0);
    expect(sender.seen).toEqual([]);
    expect(paired.seen).toEqual([]);
  });
});
