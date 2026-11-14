import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STALE_RESUME_MS } from "@trafficflow/core/drain-policy";
import type { MailboxDTO, SyncChange, SyncResponse } from "@trafficflow/services/mail";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

/**
 * CLOUD'S OWN SCAN REACHES A CLOUD-PAIRED WINDOW (row OHBOX-QUIET-READS-AS-STALLED). On the Cloud
 * door a mailbox row's `lastSyncAt` is this mirror's pull, not Cloud's check of the mailbox, and the
 * Ohbox's "Checked" line must not say the one for the other. The mirror keeps each refresh's hosted
 * stamps (`hostedSyncs`, rebuilt whole) and the door puts `hostedLastSyncAt` on EVERY row — `null`
 * before the first hosted refresh — so the window never falls back to the pull time.
 */

const A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWN = "me@ohmail.test";
const SCANNED = "2026-10-19T09:58:00.000Z";
type Stamp = string | null | "absent" | "junk";

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
const send = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

function box(stamp: Stamp): MailboxDTO {
  const row = hostedMailbox(A, OWN, { organizerRole: "organizer" });
  if (stamp === "absent") {
    const { lastSyncAt: _drop, ...rest } = row;
    return rest as MailboxDTO;
  }
  return { ...row, lastSyncAt: (stamp === "junk" ? 7 : stamp) as string | null };
}

/** What the server says about fetching on the row: its word, `null`, no key at all, or nonsense. */
type Word = { behind: boolean; since: string | null } | null | "absent" | "junk";
const LAST_CYCLE_AT = "2026-11-12T17:40:00.000Z";
const BEHIND = { behind: true, since: LAST_CYCLE_AT };

function boxSaying(word: Word, over: Partial<MailboxDTO> = {}): MailboxDTO {
  const row = hostedMailbox(A, OWN, { organizerRole: "organizer", ...over });
  if (word === "absent") {
    const { fetching: _drop, ...rest } = row;
    return rest as MailboxDTO;
  }
  return { ...row, fetching: (word === "junk" ? { behind: "yes", since: 7 } : word) as MailboxDTO["fetching"] };
}

function answer(path: string, stamp: () => Stamp, boxesDown = false, listed: () => MailboxDTO = () => box(stamp())): Response {
  if (path.startsWith("/mailboxes")) {
    return boxesDown ? new Response("down", { status: 503 }) : send(mailboxList([listed()]));
  }
  if (path.startsWith("/sync/snapshot")) return send({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
  if (path.startsWith("/sync")) return send(emptyPage());
  if (path.startsWith("/messages/bodies")) return send({ items: [], nextCursor: null });
  return new Response("not found", { status: 404 });
}

describe("the mirror keeps the hosted scan stamps per refresh", () => {
  it("follows the hosted answer and keeps only a string or null", async () => {
    const dataDir = await freshDataDir("ohmail-cloud-scan-");
    dirs.push(dataDir);
    const opened = await openLocalDb(dataDir);
    opens.push(opened);
    const world = await ensureLocalWorld(opened.db, { address: OWN, now: new Date() });
    let stamp: Stamp = SCANNED;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => answer(path, () => stamp),
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json"), now: () => new Date(), auth });
    expect(mirror.hostedSyncs().size, "a stamp before any refresh").toBe(0);
    await mirror.pullOnce();
    expect(mirror.hostedSyncs().get(A)).toBe(SCANNED);
    stamp = null;
    await mirror.pullOnce();
    expect(mirror.hostedSyncs().has(A)).toBe(true);
    expect(mirror.hostedSyncs().get(A)).toBeNull();
    stamp = "absent";
    await mirror.pullOnce();
    expect(mirror.hostedSyncs().has(A)).toBe(false);
    stamp = "junk";
    await mirror.pullOnce();
    expect(mirror.hostedSyncs().has(A)).toBe(false);
  });
});

describe("the Cloud door's mailbox rows always carry it", () => {
  async function start(dataDir: string, boxesDown: boolean): Promise<CloudSidecar> {
    const sidecar = await createCloudSidecar({
      dataDir, cloudUrl: "https://cloud.test", address: OWN, tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl: (async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        return answer(`${url.pathname}${url.search}`, () => SCANNED, boxesDown);
      }) as unknown as typeof fetch,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start().catch(() => undefined);
    return sidecar;
  }
  async function rows(sidecar: CloudSidecar): Promise<Array<Record<string, unknown>>> {
    const res = await sidecar.handle(new Request("http://sidecar/mailboxes", {
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    expect(res.status).toBe(200);
    return (await res.json()).items as Array<Record<string, unknown>>;
  }

  it("the hosted value after a refresh, never the mirror's own pull", { timeout: 30_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-cloud-scan-door-");
    dirs.push(dataDir);
    const [row] = await rows(await start(dataDir, false));
    expect(row!.hostedLastSyncAt).toBe(SCANNED);
    expect(row!.lastSyncAt, "the mirror copied the hosted stamp onto its own row").not.toBe(SCANNED);
  });

  it("null, present, before the first hosted refresh", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-cloud-scan-cold-");
    dirs.push(dataDir);
    // A first run mirrors the mailbox row, then a restart whose hosted list is down.
    const first = await start(dataDir, false);
    await first.stop();
    sidecars.splice(sidecars.indexOf(first), 1);
    const listed = await rows(await start(dataDir, true));
    expect(listed.length, "the restart lists no mirrored mailbox").toBe(1);
    expect(Object.hasOwn(listed[0]!, "hostedLastSyncAt")).toBe(true);
    expect(listed[0]!.hostedLastSyncAt).toBeNull();
  });

  it("the local door never puts it on a row", () => {
    const local = readFileSync(resolve(process.cwd(), "apps/sidecar/src/engine.ts"), "utf8");
    expect(local).not.toContain("hostedLastSyncAt");
    const cloud = readFileSync(resolve(process.cwd(), "apps/sidecar/src/cloud-engine.ts"), "utf8");
    expect(cloud.match(/hostedLastSyncAt:/g)).toHaveLength(1);
  });
});

/**
 * THE SERVER'S WORD ON FETCHING REACHES THE WINDOW. The server says on each mailbox row whether
 * new mail is being fetched (`fetching`), and the window reads its rows from this mirror, whose own
 * read has no such word. The mirror keeps the server's per refresh and the hosted door puts it on
 * the rows; a word nobody can renew (a refresh that failed, a mirror that has not asked for longer
 * than its own staleness bound) lapses to silence, never to "fetching runs".
 *
 * Mutations watched red: the decorator left out of the door (every row says `null`); the map kept
 * across a failed refresh; the age bound dropped; a malformed word kept as given.
 */
describe("the mirror keeps the server's word on fetching per refresh", () => {
  async function mirrorOver(listed: () => MailboxDTO, down: () => boolean, clock: () => Date) {
    const dataDir = await freshDataDir("ohmail-cloud-fetching-");
    dirs.push(dataDir);
    const opened = await openLocalDb(dataDir);
    opens.push(opened);
    const world = await ensureLocalWorld(opened.db, { address: OWN, now: new Date() });
    const auth: CloudAuth = {
      authedFetch: async (path: string) => answer(path, () => SCANNED, down(), listed),
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    return createCloudMirror({ db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json"), now: clock, auth });
  }

  it("follows the hosted answer and keeps only a well-formed word or null", async () => {
    let word: Word = BEHIND;
    const mirror = await mirrorOver(() => boxSaying(word), () => false, () => new Date());
    expect(mirror.hostedFetching().size, "a word before any refresh").toBe(0);
    await mirror.pullOnce();
    expect(mirror.hostedFetching().get(A)).toEqual(BEHIND);
    word = { behind: false, since: SCANNED };
    await mirror.pullOnce();
    expect(mirror.hostedFetching().get(A)).toEqual({ behind: false, since: SCANNED });
    word = { behind: true, since: null };
    await mirror.pullOnce();
    expect(mirror.hostedFetching().get(A)).toEqual({ behind: true, since: null });
    word = null;
    await mirror.pullOnce();
    expect(mirror.hostedFetching().has(A)).toBe(true);
    expect(mirror.hostedFetching().get(A)).toBeNull();
    for (const none of ["absent", "junk"] as const) {
      word = BEHIND;
      await mirror.pullOnce();
      word = none;
      await mirror.pullOnce();
      expect(mirror.hostedFetching().has(A), `${none}: the earlier word stayed`).toBe(false);
    }
  });

  it("has no role test of its own: a mailbox the server reads for another organizer is kept as given", async () => {
    // The server says it of every mailbox it is on duty to fetch, a reader's too, and takes its
    // word off a row it has left out (here: past its capacity).
    const reader = { organizerRole: "reader" as const, organizedByThisInstall: false };
    let listed = boxSaying(BEHIND, reader);
    const mirror = await mirrorOver(() => listed, () => false, () => new Date());
    await mirror.pullOnce();
    expect(mirror.hostedFetching().get(A)).toEqual(BEHIND);
    listed = boxSaying(null, { ...reader, syncBlockedReason: "at_capacity" });
    await mirror.pullOnce();
    expect(mirror.hostedFetching().get(A)).toBeNull();
  });

  it("lapses when a refresh fails, and when nothing has renewed it for the staleness bound", async () => {
    let down = false;
    let at = Date.parse("2026-11-13T19:40:00.000Z");
    const mirror = await mirrorOver(() => boxSaying(BEHIND), () => down, () => new Date(at));
    await mirror.pullOnce();
    expect(mirror.hostedFetching().get(A)).toEqual(BEHIND);

    down = true;
    await mirror.pullOnce().catch(() => undefined);
    expect(mirror.hostedFetching().size, "the word outlived a refresh that failed").toBe(0);
    down = false;
    await mirror.pullOnce();
    expect(mirror.hostedFetching().get(A)).toEqual(BEHIND);

    at += STALE_RESUME_MS - 1_000;
    expect(mirror.hostedFetching().get(A), "inside the bound").toEqual(BEHIND);
    at += 2_000;
    expect(mirror.hostedFetching().size, "the word outlived the bound with nobody renewing it").toBe(0);
    await mirror.pullOnce();
    expect(mirror.hostedFetching().get(A)).toEqual(BEHIND);
  });
});

describe("the hosted door's mailbox rows carry the server's word on fetching", () => {
  async function door(listed: () => MailboxDTO, boxesDown = false, dataDir?: string): Promise<{ sidecar: CloudSidecar; dataDir: string }> {
    const dir = dataDir ?? await freshDataDir("ohmail-cloud-fetching-door-");
    if (dataDir === undefined) dirs.push(dir);
    const sidecar = await createCloudSidecar({
      dataDir: dir, cloudUrl: "https://cloud.test", address: OWN, tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
        if (method === "POST" && url.pathname === "/sync/pull") {
          // The pull's own answer carries the same word once, for the account.
          const said = listed().fetching;
          return new Response(JSON.stringify({
            requested: 1, requestedAt: "2026-11-13T19:40:00.000Z",
            mailboxes: [{ id: A, requestedAt: "2026-11-13T19:40:00.000Z" }], fetching: said ?? null,
          }), { status: 202, headers: { "content-type": "application/json" } });
        }
        return answer(`${url.pathname}${url.search}`, () => SCANNED, boxesDown, listed);
      }) as unknown as typeof fetch,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start().catch(() => undefined);
    return { sidecar, dataDir: dir };
  }
  const head = (sidecar: CloudSidecar) => ({ authorization: `Bearer ${sidecar.sessionToken}` });
  async function listedAt(sidecar: CloudSidecar, query = ""): Promise<Array<Record<string, unknown>>> {
    const res = await sidecar.handle(new Request(`http://sidecar/mailboxes${query}`, { headers: head(sidecar) }));
    expect(res.status).toBe(200);
    return (await res.json()).items as Array<Record<string, unknown>>;
  }

  it("behind: the rows say it, counted or not, and the pull's answer at the same door says the same", { timeout: 30_000 }, async () => {
    const { sidecar } = await door(() => boxSaying(BEHIND));
    for (const query of ["", "?counts=1"]) {
      expect((await listedAt(sidecar, query))[0]!.fetching, `GET /mailboxes${query}`).toEqual(BEHIND);
    }
    const pull = await sidecar.handle(new Request("http://sidecar/sync/pull", {
      method: "POST", headers: { ...head(sidecar), "content-type": "application/json" }, body: "{}",
    }));
    expect(pull.status).toBe(202);
    const rang = (await pull.json()) as { fetching?: unknown };
    expect(rang.fetching).toEqual(BEHIND);
    expect((await listedAt(sidecar))[0]!.fetching, "the press said it and the row did not").toEqual(rang.fetching);
  });

  it("a server that does not say: the rows say nothing, never that fetching runs", { timeout: 30_000 }, async () => {
    const { sidecar } = await door(() => boxSaying(null));
    const [row] = await listedAt(sidecar);
    expect(Object.hasOwn(row!, "fetching")).toBe(true);
    expect(row!.fetching).toBeNull();
  });

  it("says nothing after a restart whose server cannot be reached", { timeout: 60_000 }, async () => {
    const first = await door(() => boxSaying(BEHIND));
    expect((await listedAt(first.sidecar))[0]!.fetching).toEqual(BEHIND);
    await first.sidecar.stop();
    sidecars.splice(sidecars.indexOf(first.sidecar), 1);
    const again = await door(() => boxSaying(BEHIND), true, first.dataDir);
    const listed = await listedAt(again.sidecar);
    expect(listed.length, "the restart lists no mirrored mailbox").toBe(1);
    expect(listed[0]!.fetching, "yesterday's word was shown by a mirror that cannot ask").toBeNull();
  });
});
