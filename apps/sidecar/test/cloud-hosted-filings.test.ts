import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MailboxDTO, SyncChange, SyncResponse } from "@trafficflow/services/mail";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { deriveMailState, seedGrowth, type MailStateInputs, type MailboxFacts } from "../../webapp/app/shell/mail-state.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

/**
 * THE ACCOUNT'S WAITING FILINGS REACH A CLOUD-PAIRED WINDOW (the desktop's Cloud door). That door
 * serves `GET /mailboxes` from the mirror, which writes every filing it copies as settled, so the
 * strip and the Settings block never showed there however many filings Cloud held stuck. The mirror
 * keeps each refresh's filing figures (`hostedFilings`, rebuilt whole) and the door puts Cloud's on
 * the list; Try again and Leave are relayed to Cloud's own routes.
 */

const A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWN = "me@ohmail.test";
const STUCK: MailboxDTO["filing"] = {
  due: 0, deferred: 6, oldestPendingAt: "2026-10-24T09:00:00.000Z", nextAttemptAt: "2026-10-24T15:00:00.000Z",
  attempts: 4, lastRefusalClass: "no_such_folder", stuck: 6, stuckSince: "2026-10-24T09:00:00.000Z",
  stuckRefusalClass: "no_such_folder", asOf: "2026-10-24T14:45:00.000Z", lastCycleAt: "2026-10-24T14:44:00.000Z",
};
type Filing = MailboxDTO["filing"] | "absent" | "junk";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);
const sidecars: CloudSidecar[] = [];
const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [sidecars, mirrors], close: opens, remove: dirs }));

const emptyPage = (): SyncResponse => ({
  changes: { creates: [] as SyncChange[], updates: [], moves: [], deletes: [] },
  cursor: "end", hasMore: false, serverTime: new Date().toISOString(),
});
const send = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

function box(filing: Filing): MailboxDTO {
  const row = hostedMailbox(A, OWN, { organizerRole: "organizer" });
  if (filing === "absent") { const { filing: _gone, ...rest } = row; return rest as MailboxDTO; }
  if (filing === "junk") return { ...row, filing: { ...row.filing, stuck: "6" as unknown as number } };
  return { ...row, filing, pendingMoves: filing.due + filing.deferred };
}

function answer(path: string, filing: () => Filing): Response {
  if (path.startsWith("/mailboxes")) return send(mailboxList([box(filing())]));
  if (path.startsWith("/sync/snapshot")) return send({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
  if (path.startsWith("/sync")) return send(emptyPage());
  if (path.startsWith("/messages/bodies")) return send({ items: [], nextCursor: null });
  return new Response("not found", { status: 404 });
}

describe("the mirror keeps the account's filing figures per refresh", () => {
  it("follows the hosted answer and keeps only a well-formed one", async () => {
    const dataDir = await freshDataDir("ohmail-cloud-filings-");
    dirs.push(dataDir);
    const opened = await openLocalDb(dataDir);
    opens.push(opened);
    const world = await ensureLocalWorld(opened.db, { address: OWN, now: new Date() });
    let filing: Filing = STUCK;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => answer(path, () => filing),
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json"), now: () => new Date(), auth });
    await mirror.pullOnce();
    expect(mirror.hostedFilings().get(A), "Cloud's stuck filings never reached the mirror").toEqual({ pendingMoves: 6, filing: STUCK });
    filing = "absent";
    await mirror.pullOnce();
    expect(mirror.hostedFilings().has(A), "an older server's silence was read as an answer").toBe(false);
    filing = "junk";
    await mirror.pullOnce();
    expect(mirror.hostedFilings().has(A), "a malformed figure was kept").toBe(false);
  });
});

describe("the Cloud door's mailbox list carries Cloud's filings, and the presses reach Cloud", () => {
  it("6 stuck at Cloud light the strip and the block; Try again and Leave reach Cloud's routes", { timeout: 30_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-cloud-filings-door-");
    dirs.push(dataDir);
    let filing: Filing = STUCK;
    const posted: Array<{ path: string; body: unknown }> = [];
    const sidecar = await createCloudSidecar({
      dataDir, cloudUrl: "https://cloud.test", address: OWN, tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        if (method === "POST" && url.pathname.startsWith(`/mailboxes/${A}/filings/`)) {
          const raw = init?.body ?? (input instanceof Request ? await input.text() : null);
          posted.push({ path: url.pathname, body: JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw as Uint8Array)) });
          if (url.pathname.endsWith("/leave")) return send({ settled: 6, remaining: 0 });
          filing = { ...STUCK, due: 6, deferred: 0, stuck: 0, stuckSince: null, stuckRefusalClass: null };
          return send({ reset: 6, skipped: 0 }, 202);
        }
        return answer(`${url.pathname}${url.search}`, () => filing);
      }) as unknown as typeof fetch,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start();
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
    const list = async (): Promise<Record<string, unknown>> => {
      const res = await sidecar.handle(new Request("http://sidecar/mailboxes", { headers: auth }));
      expect(res.status).toBe(200);
      return ((await res.json()).items as Array<Record<string, unknown>>)[0]!;
    };

    const row = await list();
    expect(row.filing, "the window read the mirror's settled copy, not Cloud's figures").toEqual(STUCK);
    expect(row.pendingMoves).toBe(6);
    const now = Date.parse("2026-10-24T14:46:00.000Z");
    const state = deriveMailState({
      sync: { bootstrapping: false, failures: 0, terminal: false, refused: false }, failureStreak: 3,
      mailboxes: [row as unknown as MailboxFacts], mirrored: 10, growth: seedGrowth(10),
      freshness: { state: "current", asOf: new Date(now).toISOString() },
      engineFreshness: { state: "current", asOf: new Date(now).toISOString() }, now, demo: false,
    } as MailStateInputs);
    expect(state.key, "no strip on the Cloud door").toBe("filing");
    expect(state.filing).toMatchObject({ arm: "stuck", count: 6 });
    /* The block's own rule (`MailboxFilings`' `waits`): an organizer row with stuck or deferred filings. */
    expect(row.organizerRole).toBe("organizer");

    const res = await sidecar.handle(new Request(`http://sidecar/mailboxes/${A}/filings/retry`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ folder: "ohmail/Screened" }),
    }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ reset: 6, skipped: 0 });
    expect(posted, "Try again never reached Cloud").toEqual([{ path: `/mailboxes/${A}/filings/retry`, body: { folder: "ohmail/Screened" } }]);
    let after = await list();
    /* The relay refreshes the mailbox list after it answers, not before: wait for that refresh. */
    for (let i = 0; i < 250 && (after.filing as { stuck: number }).stuck !== 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      after = await list();
    }
    expect((after.filing as { stuck: number; due: number }), "the list kept the stuck figure after Cloud cleared it").toMatchObject({ stuck: 0, due: 6 });

    const left = await sidecar.handle(new Request(`http://sidecar/mailboxes/${A}/filings/leave`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ folder: "ohmail/Screened", through: "2026-10-24T09:05:00.000Z" }),
    }));
    expect(left.status).toBe(200);
    expect(posted.at(-1), "Leave never reached Cloud").toEqual({
      path: `/mailboxes/${A}/filings/leave`, body: { folder: "ohmail/Screened", through: "2026-10-24T09:05:00.000Z" },
    });
  });

  it("CONTROL: with nothing from Cloud the row says what the mirror's own read says", { timeout: 30_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-cloud-filings-absent-");
    dirs.push(dataDir);
    const sidecar = await createCloudSidecar({
      dataDir, cloudUrl: "https://cloud.test", address: OWN, tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return answer(`${url.pathname}${url.search}`, () => "absent");
      }) as unknown as typeof fetch,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start();
    const res = await sidecar.handle(new Request("http://sidecar/mailboxes", { headers: { authorization: `Bearer ${sidecar.sessionToken}` } }));
    const [row] = (await res.json()).items as Array<Record<string, unknown>>;
    expect((row!.filing as { stuck: number }).stuck).toBe(0);
  });
});
