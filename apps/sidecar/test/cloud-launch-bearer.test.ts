import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSession } from "@trafficflow/services/mail";
import { openLocalDb, type LocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { mintLaunchBearer } from "../src/launch-bearer.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { pgliteOf } from "./_store-client.js";

/**
 * THE CLOUD DOOR'S LAUNCH BEARER IS DECIDED IN MEMORY, AND THE MEMORY NEVER ADMITS WHAT THE STORE
 * REFUSES. A relayed search asked the store for this bearer on every request, and during a first
 * fill that read waited behind each mirror page's transaction. The held decision agrees with
 * `resolveSession` at every instant the row can change in this process — the mint, the next
 * launch's mint, the row's renewal (`launch-bearer-renewal.test.ts`) and the store's close — and
 * before the half-life it answers with no store read.
 */

const LAUNCH = new Date("2026-09-24T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const opens: OpenLocalDb[] = [];
const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const o of opens.splice(0)) await o.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Client = Record<"query" | "exec" | "transaction", (...a: unknown[]) => Promise<unknown>>;

/** Every statement this store handle runs, counted — the store-read spy. */
function spyOnStore(db: LocalDb): { reads: () => number; stop: () => void } {
  const client = pgliteOf(db) as unknown as Client;
  let n = 0;
  const originals = { query: client.query, exec: client.exec, transaction: client.transaction };
  for (const name of ["query", "exec", "transaction"] as const) {
    const original = originals[name];
    client[name] = (...args: unknown[]) => { n++; return original.apply(client, args); };
  }
  return { reads: () => n, stop: () => Object.assign(client, originals) };
}

async function store(): Promise<{ db: LocalDb; world: Awaited<ReturnType<typeof ensureLocalWorld>> }> {
  const dataDir = await freshDataDir("ohmail-launch-bearer-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: LAUNCH });
  return { db: opened.db, world };
}

describe("the held launch-bearer decision", () => {
  /* The expiry arm this case used to carry moved: a live process's own bearer is RENEWED from its
     half-life, and the store agrees after it — `launch-bearer-renewal.test.ts` holds that. */
  it("is the store's answer, given with no store read, up to the row's half-life", async () => {
    const { db, world } = await store();
    const bearer = await mintLaunchBearer(db, world, LAUNCH);
    const justBefore = new Date(LAUNCH.getTime() + DAY_MS / 2 - 1);

    const spy = spyOnStore(db);
    const held = await bearer.decide(bearer.token, LAUNCH);
    const late = await bearer.decide(bearer.token, justBefore);
    expect(spy.reads(), "no decision read the store").toBe(0);
    spy.stop();

    const fromStore = await resolveSession(db, bearer.token, LAUNCH);
    expect(fromStore).not.toBeNull();
    expect(held).toEqual({ held: fromStore });
    expect(late).toEqual({ held: await resolveSession(db, bearer.token, justBefore) });
  });

  it("is refused from the store's close on, with no store read", async () => {
    const { db, world } = await store();
    const bearer = await mintLaunchBearer(db, world, LAUNCH);
    bearer.end();
    const spy = spyOnStore(db);
    expect(await bearer.decide(bearer.token, LAUNCH)).toBe("refused");
    expect(spy.reads()).toBe(0);
    spy.stop();
  });

  it("answers for its own bearer only: the next launch's mint leaves the old one to the store, which refuses it", async () => {
    const { db, world } = await store();
    const first = await mintLaunchBearer(db, world, LAUNCH);
    const next = await mintLaunchBearer(db, world, new Date(LAUNCH.getTime() + 60_000));
    expect(await next.decide(first.token, LAUNCH), "not this launch's bearer").toBe("unknown");
    expect(await next.decide("not-a-bearer", LAUNCH)).toBe("unknown");
    expect(await resolveSession(db, first.token, LAUNCH), "the next mint revoked the old row").toBeNull();
    expect(await next.decide(next.token, LAUNCH)).toEqual({ held: await resolveSession(db, next.token, LAUNCH) });
  });
});

describe("the Cloud door asks no store for its own launch bearer", () => {
  const json = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "me@ohmail.test")]));
    if (url.pathname === "/sync") return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: new Date().toISOString() });
    if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  async function door(signedIn: boolean): Promise<CloudSidecar> {
    const dataDir = await freshDataDir("ohmail-launch-bearer-door-");
    dirs.push(dataDir);
    const sidecar = await createCloudSidecar({
      dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test", fetchImpl, pollIntervalMs: 3_600_000,
      ...(signedIn ? { tokens: { accessToken: "a", refreshToken: "r" } } : {}),
    });
    sidecars.push(sidecar);
    return sidecar;
  }
  const ask = (sidecar: CloudSidecar, token: string, path = "/messages/x"): Promise<Response> =>
    sidecar.handle(new Request(`http://sidecar${path}`, { headers: { authorization: `Bearer ${token}` } }));

  it("admits its launch bearer with no store read, and a foreign token is still asked of the store", { timeout: 30_000 }, async () => {
    const sidecar = await door(false);
    const spy = spyOnStore(sidecar.db);
    const res = await ask(sidecar, sidecar.sessionToken);
    const readsForOwn = spy.reads();
    const foreign = await ask(sidecar, "not-the-launch-bearer");
    const readsForForeign = spy.reads() - readsForOwn;
    spy.stop();
    expect(res.status, "past the bearer: this pre-auth engine's own refusal").toBe(409);
    expect(readsForOwn, "the launch bearer was decided without the store").toBe(0);
    expect(foreign.status).toBe(401);
    expect(readsForForeign, "a token this process did not mint is the store's to decide").toBeGreaterThanOrEqual(1);
  });

  it("revoke then request: after the stop the bearer answers 401 with the store untouched", { timeout: 30_000 }, async () => {
    const sidecar = await door(false);
    const spy = spyOnStore(sidecar.db);
    await sidecar.stop();
    const before = spy.reads();
    const res = await ask(sidecar, sidecar.sessionToken);
    expect(res.status).toBe(401);
    expect(spy.reads() - before, "no store read between the end and the refusal").toBe(0);
    spy.stop();
  });

  it("a hosted sign-out leaves the launch bearer live, as the store says: the window signs in again over it", { timeout: 30_000 }, async () => {
    const sidecar = await door(true);
    const out = await sidecar.handle(new Request("http://sidecar/cloud/session", {
      method: "DELETE", headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    expect(out.status).toBe(200);
    const res = await ask(sidecar, sidecar.sessionToken);
    expect(res.status, "admitted, then refused as signed out").toBe(409);
    expect(await resolveSession(sidecar.db, sidecar.sessionToken, new Date())).not.toBeNull();
  });
});
