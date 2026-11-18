import type { SyncChange, SyncResponse } from "@ohmail/wire";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { freshDataDir } from "./_datadir.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * THE MIRROR COUNTS WHAT IT COULD NOT STORE (CLOUD-QUARANTINE-STRIP-COUNT-AND-CAP-STATE). The held
 * quarantine keeps a bounded number of refused rows with their payload; past it every refusal keeps its KEY, so the
 * count the window is served is the true one — before and after a relaunch — and a floor, said as
 * one, only past the overflow ceiling. A key leaves when its entity's newer state lands, and a
 * completed since=0 bootstrap drops every key it did not refuse again. Refusals are planted as the
 * store-stuck file plants them: a local CHECK the apply was never taught.
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHECK = "ALTER TABLE tags ADD CONSTRAINT tags_refusal_probe CHECK (name NOT LIKE 'refuse-%')";

const sidecars: CloudSidecar[] = [];
const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [sidecars, mirrors], close: opens, remove: dirs }));

const iso = (): string => new Date().toISOString();
/** Tag ids that sort like their number, so "which ones overflowed" is the seq order. */
const tagId = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const tag = (n: number, seq: number, name = `refuse-${n}`): SyncChange => ({
  type: "tag", op: seq === n ? "create" : "update", id: tagId(n), seq, updatedAt: iso(),
  entity: { id: tagId(n), accountId: "unused", name, hue: "moss", createdAt: iso(), updatedAt: iso() },
}) as SyncChange;
const page = (changes: SyncChange[], cursor: string): SyncResponse => ({
  changes: {
    creates: changes.filter((c) => c.op === "create"), updates: changes.filter((c) => c.op === "update"),
    moves: [], deletes: [],
  },
  cursor, hasMore: false, serverTime: iso(),
});
const tags = (from: number, to: number): SyncChange[] =>
  Array.from({ length: to - from + 1 }, (_, i) => tag(from + i, from + i));

/** A hosted API whose next `/sync` answer is whatever `feed` holds when it is asked. */
function hosted(feed: { next: SyncResponse[] }): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    const send = (v: unknown): Response =>
      new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")]));
    if (url.pathname === "/sync") {
      return send(url.searchParams.get("types") === "rule" ? page([], "r") : feed.next.shift() ?? page([], "end"));
    }
    if (url.pathname === "/sync/snapshot") return send({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function sidecarOver(dataDir: string, feed: { next: SyncResponse[] }): Promise<CloudSidecar> {
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test",
    tokens: { accessToken: "a", refreshToken: "r" }, fetchImpl: hosted(feed), pollIntervalMs: 3_600_000,
  });
  sidecars.push(sidecar);
  return sidecar;
}

async function servedRefusals(sidecar: CloudSidecar): Promise<unknown> {
  const res = await sidecar.handle(new Request("http://sidecar/mailboxes", {
    headers: { authorization: `Bearer ${sidecar.sessionToken}` },
  }));
  const [row] = (await res.json() as { items: Array<Record<string, unknown>> }).items;
  expect(row!.errorCode).toBe("storage");
  return row!.storeRefusals;
}

describe("the window is served the true count of what this copy could not store", () => {
  it("612 refused: 612 stated, 500 retried, exact — and the same after a relaunch", { timeout: 120_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-refusals-");
    dirs.push(dataDir);
    const first = await sidecarOver(dataDir, { next: [page(tags(1, 612), "c1")] });
    await first.db.execute(sql.raw(CHECK));
    await first.start();
    expect(await servedRefusals(first)).toEqual({ count: 612, retrying: 500, exact: true });
    await first.stop();
    sidecars.splice(sidecars.indexOf(first), 1);

    // THE RELAUNCH — the row's whole point: the 112 past the held cap used to leave no trace.
    const second = await sidecarOver(dataDir, { next: [] });
    await second.start();
    expect(await servedRefusals(second), "the relaunch forgot the refusals past the cap")
      .toEqual({ count: 612, retrying: 500, exact: true });

    // A NEWER state of an overflowed entity lands (a name the store admits): its key leaves.
    await second.stop();
    sidecars.splice(sidecars.indexOf(second), 1);
    const late = await sidecarOver(dataDir, { next: [page([tag(612, 700, "stored-612")], "c2")] });
    await late.start();
    expect(await servedRefusals(late), "a landed entity was still counted as refused")
      .toEqual({ count: 611, retrying: 500, exact: true });
  });
});

function auth(feed: { next: SyncResponse[] }): CloudAuth {
  const f = hosted(feed);
  return {
    authedFetch: async (path: string) => f(`https://cloud.test${path}`),
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  } as CloudAuth;
}

async function mirrorWorld(): Promise<{ opened: OpenLocalDb; cursorPath: string; world: Awaited<ReturnType<typeof ensureLocalWorld>> }> {
  const dataDir = await freshDataDir("ohmail-refusals-mirror-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  await opened.db.execute(sql.raw(CHECK));
  return { opened, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

/** Hand the mirror a since=0 bootstrap on its next launch, keeping everything else in the file. */
function owesBootstrap(cursorPath: string): void {
  const j = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
  writeFileSync(cursorPath, JSON.stringify({ ...j, sync: "0", bootstrapping: false }));
}

describe("the overflow ledger's floor and its end", () => {
  it("past the ceiling the count is a floor, and a completed bootstrap re-measures it", { timeout: 120_000 }, async () => {
    const { opened, world, cursorPath } = await mirrorWorld();
    const db = opened.db;
    const feed = { next: [page(tags(1, 505), "c1")] };
    const m1 = createCloudMirror({ db, world, cursorPath, auth: auth(feed), now: () => new Date(), overflowMax: 2 });
    await m1.pullOnce();
    expect(m1.quarantined(), "503 counted of 505 refused, and said as a floor")
      .toMatchObject({ count: 502, retrying: 500, exact: false });

    // The store is fixed and the account bootstraps again: everything lands, nothing refuses.
    await db.execute(sql.raw("ALTER TABLE tags DROP CONSTRAINT tags_refusal_probe"));
    owesBootstrap(cursorPath);
    const m2 = createCloudMirror({
      db, world, cursorPath, auth: auth({ next: [page(tags(1, 505), "c2")] }), now: () => new Date(), overflowMax: 2,
    });
    await m2.pullOnce();
    expect(m2.quarantined(), "a completed bootstrap that refused nothing left a count")
      .toMatchObject({ count: 0, retrying: 0, exact: true });
  });

  it("a completed bootstrap drops the keys it did not refuse again and keeps the ones it did", { timeout: 120_000 }, async () => {
    const { opened, world, cursorPath } = await mirrorWorld();
    const db = opened.db;
    const m1 = createCloudMirror({ db, world, cursorPath, auth: auth({ next: [page(tags(1, 505), "c1")] }), now: () => new Date() });
    await m1.pullOnce();
    expect(m1.quarantined()).toMatchObject({ count: 505, retrying: 500, exact: true });

    // Tags 503-505 are gone upstream: the replay does not carry them, and 1-502 still refuse.
    owesBootstrap(cursorPath);
    const m2 = createCloudMirror({ db, world, cursorPath, auth: auth({ next: [page(tags(1, 502), "c2")] }), now: () => new Date() });
    await m2.pullOnce();
    expect(m2.quarantined(), "a key the bootstrap never re-delivered is still counted")
      .toMatchObject({ count: 502, retrying: 500, exact: true });
    const file = JSON.parse(readFileSync(cursorPath, "utf8")) as { quarantineOverflow?: unknown[] };
    expect(file.quarantineOverflow).toHaveLength(2);
  });

  it("CONTROL: a healthy install writes neither overflow key into its cursor file", { timeout: 60_000 }, async () => {
    const { opened, world, cursorPath } = await mirrorWorld();
    const m = createCloudMirror({
      db: opened.db, world, cursorPath, auth: auth({ next: [page([tag(1, 1, "fine")], "c1")] }), now: () => new Date(),
    });
    await m.pullOnce();
    expect(m.quarantined()).toMatchObject({ count: 0, retrying: 0, exact: true });
    const file = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
    expect("quarantineOverflow" in file || "quarantineFloor" in file).toBe(false);
  });
});
