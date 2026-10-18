import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { learningSignals, messageBodies, rules, unsubscribeRecords } from "@trafficflow/db";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { makeNodeOneClickPost, type OneClickPost } from "@trafficflow/services";
import { makeDeps, seedSession, seedMessage, seedBody, req, FIXED_NOW } from "./helpers.js";

/**
 * A ONE-CLICK UNSUBSCRIBE IS DONE ONLY WHEN THE LIST SAYS SO. Driven through the
 * real routes and the production port, against a fixture list server on 127.0.0.1 answering success,
 * a refusal, an error or never: only a 2xx settles as sent; a refusal is kept and never asked twice; a failure
 * is said as one and a person may ask again. The wrapper only re-aims the pinned socket at loopback.
 */

type Wire = {
  posted?: boolean; status?: number | null; refusal?: string | null;
  error?: { code: string; retryable?: boolean; details?: Record<string, unknown> };
};

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const hits = new Map<string, number>();
const held: ServerResponse[] = [];
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((rq, rs) => {
    const path = new URL(rq.url ?? "/", "http://fixture").pathname;
    hits.set(path, (hits.get(path) ?? 0) + 1);
    rq.resume();
    if (path === "/hangs") { held.push(rs); return; }
    rs.writeHead(path === "/accepts" ? 200 : path === "/refuses" ? 405 : 500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const r of held) r.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fixturePort(): OneClickPost {
  const real = makeNodeOneClickPost({ timeoutMs: 400 });
  return {
    post(url, _pin, timeoutMs) {
      const u = new URL(url);
      if (u.hostname !== "list.example") throw new Error(`the fixture port only serves list.example, got ${u.hostname}`);
      return real.post(`http://127.0.0.1:${port}${u.pathname}${u.search}`, ["127.0.0.1"], timeoutMs);
    },
  };
}

const headersFor = (path: string) => ({
  "list-unsubscribe": [`<https://list.example${path}?t=${path.slice(1)}>`],
  "list-unsubscribe-post": ["List-Unsubscribe=One-Click"],
  "list-id": [`<${path.slice(1)}.list.example>`],
  // The mailbox's provider (Gmail's position, `GMAIL` below) confirming the sender: the drain's licence.
  "authentication-results": ["mx.google.com; dmarc=pass"],
});
const GMAIL: ReadonlySet<string> = new Set(["mx.google.com"]);

async function world(path: string) {
  const { db, deps } = await makeDeps(FIXED_NOW, {}, { oneClickPost: fixturePort() });
  const s = await seedSession(db, { now: FIXED_NOW });
  const { id } = await seedMessage(db, { accountId: s.accountId, folder: "ohmail/Screened", fromAddress: `news@${path.slice(1)}.example` });
  await seedBody(db, { messageId: id, headers: headersFor(path) });
  const press = async () => {
    const res = await H(req("POST", `/messages/${id}/unsubscribe`, { bearer: s.token }), deps);
    return { status: res.status, body: (await res.json()) as Wire };
  };
  const record = async () => (await db.select().from(unsubscribeRecords).where(eq(unsubscribeRecords.messageId, id)))[0];
  return { db, deps, s, id, press, record };
}

describe("POST /messages/:id/unsubscribe — what the list answered decides what is said", () => {
  it("200: sent, and a second press says it is already done", async () => {
    hits.clear();
    const w = await world("/accepts");
    const first = await w.press();
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ posted: true, status: 200, refusal: null });
    expect(await w.record()).toMatchObject({ state: "sent", httpStatus: 200 });
    const again = await w.press();
    expect(again.body).toMatchObject({ posted: false, refusal: "already_recorded" });
    expect(hits.get("/accepts")).toBe(1);
  });

  it("405: the list did not accept it — said by name with the sender's link, and never asked again", async () => {
    hits.clear();
    const w = await world("/refuses");
    const first = await w.press();
    expect(first.status, JSON.stringify(first.body)).toBe(409);
    expect(first.body.error!.code).toBe("unsubscribe_list_refused");
    expect(first.body.error!.retryable).not.toBe(true);
    expect(first.body.error!.details).toMatchObject({ status: 405, siteUrl: "https://list.example/refuses?t=refuses" });
    expect(await w.record()).toMatchObject({ state: "refused", refusal: "list_refused", httpStatus: 405 });

    const again = await w.press();
    expect(again.body.error?.code, "a refused list may not read as done").toBe("unsubscribe_list_refused");
    expect(again.body.refusal).toBeUndefined();
    expect(hits.get("/refuses"), "one request per list, for a refusal too").toBe(1);
  });

  it("500: the list failed — said as a failure, retryable, and a person's press asks again", async () => {
    hits.clear();
    const w = await world("/breaks");
    const first = await w.press();
    expect(first.status, JSON.stringify(first.body)).toBe(409);
    expect(first.body.error!.code).toBe("unsubscribe_list_failed");
    expect(first.body.error!.retryable).toBe(true);
    expect(first.body.error!.details).toMatchObject({ status: 500 });
    expect(await w.record()).toMatchObject({ state: "failed", httpStatus: 500 });

    const again = await w.press();
    expect(again.body.error!.code).toBe("unsubscribe_list_failed");
    expect(hits.get("/breaks")).toBe(2);
  });

  it("no answer: a timeout is a failure the person may retry, never a 500 of ours", async () => {
    hits.clear();
    const w = await world("/hangs");
    const first = await w.press();
    expect(first.status, JSON.stringify(first.body)).toBe(409);
    expect(first.body.error!.code).toBe("unsubscribe_list_failed");
    expect(first.body.error!.retryable).toBe(true);
    expect(first.body.error!.details).toMatchObject({ status: null });
    expect(await w.record()).toMatchObject({ state: "failed", httpStatus: null });
    expect(hits.get("/hangs")).toBe(1);
  });
});

describe("GET /internal/unsubscribe/drain — the worker's pass counts a refusal as not delivered", () => {
  const SECRET = "s".repeat(32);
  const drain = (deps: ApiDeps) => H(new Request("http://api.test/internal/unsubscribe/drain", {
    method: "GET", headers: { authorization: `Bearer ${SECRET}` },
  }), { ...deps, alerts: { secret: SECRET, cronSecret: SECRET, sinks: [] } } as ApiDeps);

  it.each([
    ["/refuses", { delivered: 0, failed: 1 }, { state: "refused", refusal: "list_refused", httpStatus: 405 }],
    ["/accepts", { delivered: 1, failed: 0 }, { state: "sent", httpStatus: 200 }],
  ])("%s", async (path, counts, row) => {
    hits.clear();
    const { db, deps } = await makeDeps(undefined, {}, { oneClickPost: fixturePort(), trustedAuthservIds: GMAIL });
    const s = await seedSession(db, { now: deps.now() });
    const from = `news@${path.slice(1)}.example`;
    const { id } = await seedMessage(db, { accountId: s.accountId, fromAddress: from, folder: "ohmail/Screened" });
    await db.insert(messageBodies).values({ messageId: id, text: "", headers: headersFor(path) });
    await db.insert(rules).values({ accountId: s.accountId, kind: "sender", match: from,
      destination: "ohmail/Screened", provenance: "promoted", personDecidedAt: deps.now() });
    await db.insert(learningSignals).values({ accountId: s.accountId, triggeringActionId: `screener:${crypto.randomUUID()}`,
      kind: "screener", senderAddress: from, destination: "ohmail/Screened", label: "positive" });

    const res = await drain(deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ claimed: 1, ...counts });
    const [rec] = await db.select().from(unsubscribeRecords).where(eq(unsubscribeRecords.messageId, id));
    expect(rec).toMatchObject(row);

    const pressed = await H(req("POST", `/messages/${id}/unsubscribe`, { bearer: s.token }), deps);
    const body = (await pressed.json()) as Wire;
    if (path === "/refuses") expect(body.error?.code, "the preview's press after the pass").toBe("unsubscribe_list_refused");
    else expect(body.refusal).toBe("already_recorded");
    expect(hits.get(path)).toBe(1);
  });
});
