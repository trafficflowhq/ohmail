import type { MailboxDTO, SyncChange, SyncResponse } from "@ohmail/wire";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";
import {
  createCloudMirror as makeCloudMirror, HOSTED_COUNTS_MIN_GAP_MS, HOSTED_COUNTS_TTL_MS,
} from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * THE HOSTED MESSAGE COUNT — WHAT IT COSTS THE ACCOUNT TO KNOW IT.
 *
 * The window's strip can only say how much of the account this device is holding if this process
 * knows the second number, and the only place it exists is the hosted account. `GET /mailboxes`
 * will answer it — for `?counts=1`, and `packages/api/src/routes/mailboxes.ts` makes that opt-in
 * for one reason it states plainly: the count is a grouped aggregate over the account's whole
 * `messages` table, and the route is POLLED. This mirror polls every 20 s.
 *
 * So the interesting property is not "can it read the number" — it is "how often does it ask".
 * These tests drive the real `refreshMailboxes` through real pulls with a controlled clock and
 * COUNT the counted requests. An implementation that asked on every refresh would pass every
 * functional test in this suite and put 180 full-table aggregates an hour behind one install.
 *
 * Mutation-checked, all three shown red:
 *  · make `countsWanted()` always true            → the floor and budget cases go red;
 *  · drop the `countsAskedAt` stamp               → the counts-less-account case goes red;
 *  · stop clearing `sawBacklog` after a counted ask → the spent-backlog case goes red.
 */

const CLOUD_MAILBOX_A = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLOUD_MAILBOX_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ opened: OpenLocalDb; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-hosted-counts-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  return { opened, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

const emptyPage = (hasMore = false): SyncResponse => ({
  changes: { creates: [] as SyncChange[], updates: [], moves: [], deletes: [] },
  cursor: "end",
  hasMore,
  serverTime: new Date().toISOString(),
});

/** A page carrying ONE tombstone — the shape that makes a held count too high. */
const deletePage = (): SyncResponse => ({
  changes: {
    creates: [],
    updates: [],
    moves: [],
    deletes: [{
      type: "message", op: "delete", id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      seq: 1, updatedAt: new Date().toISOString(),
    }] as SyncChange[],
  },
  cursor: "end",
  hasMore: false,
  serverTime: new Date().toISOString(),
});

/**
 * A fake account that answers counts ONLY when asked for them — the hosted route's actual
 * behaviour, and the whole point: a fake that always included `messageCount` could not tell a
 * client that asks politely from one that asks constantly.
 */
function fakeAuth(opts: {
  asked: string[];
  pages?: SyncResponse[];
  counts?: Record<string, number> | null;
  mailboxIds?: readonly string[];
}): CloudAuth {
  let p = 0;
  const ids = opts.mailboxIds ?? [CLOUD_MAILBOX_A];
  const json = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  return {
    authedFetch: async (path: string) => {
      opts.asked.push(path);
      if (path.startsWith("/mailboxes")) {
        const wants = path.includes("counts=1");
        const rows: MailboxDTO[] = ids.map((id, i) => {
          const box = hostedMailbox(id, i === 0 ? "me@ohmail.test" : `alias${i}@ohmail.test`);
          const n = opts.counts?.[id];
          return wants && typeof n === "number" ? { ...box, messageCount: n } : box;
        });
        return json(mailboxList(rows));
      }
      // An EMPTY SNAPSHOT in the route's real shape: the bootstrap's opening window reads this before
      // the replay and refuses a body that is not a snapshot, so the old placeholder shape would fail
      // every pull here.
      if (path.startsWith("/sync/snapshot")) return json({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
      // The bootstrap's rules-first pass (`types=rule`): these feeds carry no rule changes, so
      // the honest filtered answer is an empty page — it must not consume a counted mixed page.
      if (path.startsWith("/sync")
          && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json(emptyPage());
      }
      if (path.startsWith("/sync")) return json(opts.pages?.[p++] ?? emptyPage());
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

/** The counted asks in a recorded call log — the number this file is about. */
const countedAsks = (asked: string[]): string[] => asked.filter((p) => p.includes("counts=1"));
/** Every mailbox refresh, counted or not. */
const mailboxAsks = (asked: string[]): string[] => asked.filter((p) => p.startsWith("/mailboxes"));

describe("the hosted counts are learned, and paid for once", () => {
  it("the FIRST pull asks for counts and the numbers land", async () => {
    // The launch after an install has been closed for days: the map is empty, which is exactly
    // when a shortfall is most likely and least visible.
    const { opened, world, cursorPath } = await standUp();
    const asked: string[] = [];
    const mirror = createCloudMirror({
      db: opened.db, world, cursorPath, now: () => new Date(),
      auth: fakeAuth({ asked, counts: { [CLOUD_MAILBOX_A]: 1_541 } }),
    });
    await mirror.pullOnce();
    expect(countedAsks(asked)).toHaveLength(1);
    expect(mirror.hostedCounts().get(CLOUD_MAILBOX_A)).toBe(1_541);
  });

  it("a second pull a few seconds later asks WITHOUT counts — the floor holds", async () => {
    const { opened, world, cursorPath } = await standUp();
    const asked: string[] = [];
    let t = Date.parse("2026-08-21T12:00:00.000Z");
    const mirror = createCloudMirror({
      db: opened.db, world, cursorPath, now: () => new Date(t),
      auth: fakeAuth({ asked, counts: { [CLOUD_MAILBOX_A]: 1_541 } }),
    });
    await mirror.pullOnce();
    t += HOSTED_COUNTS_MIN_GAP_MS - 1_000;
    await mirror.pullOnce();
    expect(mailboxAsks(asked)).toHaveLength(2);
    expect(countedAsks(asked), "the aggregate was asked for twice inside a minute").toHaveLength(1);
  });

  it("past the TTL it asks again — a denominator is a measurement, not a constant", async () => {
    const { opened, world, cursorPath } = await standUp();
    const asked: string[] = [];
    let t = Date.parse("2026-08-21T12:00:00.000Z");
    const mirror = createCloudMirror({
      db: opened.db, world, cursorPath, now: () => new Date(t),
      auth: fakeAuth({ asked, counts: { [CLOUD_MAILBOX_A]: 1_541 } }),
    });
    await mirror.pullOnce();
    t += HOSTED_COUNTS_TTL_MS + 1_000;
    await mirror.pullOnce();
    expect(countedAsks(asked)).toHaveLength(2);
  });

  it("A DRAIN THAT SAW `hasMore` buys the next pull a fresh denominator", async () => {
    // The case the sentence exists for: the hosted account said there is more, so the mirror is
    // behind and the number on screen is about to matter.
    const { opened, world, cursorPath } = await standUp();
    const asked: string[] = [];
    let t = Date.parse("2026-08-21T12:00:00.000Z");
    const mirror = createCloudMirror({
      db: opened.db, world, cursorPath, now: () => new Date(t),
      auth: fakeAuth({
        asked,
        // Pull 1 drains two pages, the first reporting more to come.
        pages: [emptyPage(true), emptyPage(false), emptyPage(false)],
        counts: { [CLOUD_MAILBOX_A]: 1_541 },
      }),
    });
    await mirror.pullOnce();
    t += HOSTED_COUNTS_MIN_GAP_MS + 1_000;
    await mirror.pullOnce();
    // Well inside the TTL, so only the backlog can explain the second ask.
    expect(t - Date.parse("2026-08-21T12:00:00.000Z")).toBeLessThan(HOSTED_COUNTS_TTL_MS);
    expect(countedAsks(asked)).toHaveLength(2);
  });

  it("…and the backlog reason is SPENT by the ask it buys — one catch-up, not a new cadence", async () => {
    // Without this, a single `hasMore` would turn the floor into the interval: every pull past a
    // minute would find the flag still set and ask again, for the rest of the session.
    const { opened, world, cursorPath } = await standUp();
    const asked: string[] = [];
    const t0 = Date.parse("2026-08-21T12:00:00.000Z");
    let t = t0;
    const mirror = createCloudMirror({
      db: opened.db, world, cursorPath, now: () => new Date(t),
      auth: fakeAuth({
        asked,
        pages: [emptyPage(true), emptyPage(false)],
        counts: { [CLOUD_MAILBOX_A]: 1_541 },
      }),
    });
    await mirror.pullOnce();                       // launch ask; the drain reports a backlog
    t += HOSTED_COUNTS_MIN_GAP_MS + 1_000;
    await mirror.pullOnce();                       // the backlog's own ask
    t += HOSTED_COUNTS_MIN_GAP_MS + 1_000;
    await mirror.pullOnce();                       // nothing outstanding: must stay quiet
    expect(t - t0).toBeLessThan(HOSTED_COUNTS_TTL_MS);
    expect(countedAsks(asked), "the backlog flag was never cleared, so it re-asked every minute")
      .toHaveLength(2);
  });

  it("A TOMBSTONE DROPS THE HELD COUNTS — a total that is too high is worse than none", async () => {
    /**
     * The reported failure: counts are read (say the account holds N), another device then deletes
     * some messages, and the next ordinary drain applies the tombstones. The local number
     * falls; the held total does not, for as long as the refresh cadence says. The strip would
     * then report a shortfall of messages that no longer exist anywhere.
     *
     * A delete therefore drops the map immediately — the strip says nothing, which is true — and
     * buys the next refresh a fresh count.
     */
    const { opened, world, cursorPath } = await standUp();
    const asked: string[] = [];
    let t = Date.parse("2026-08-21T12:00:00.000Z");
    const mirror = createCloudMirror({
      db: opened.db, world, cursorPath, now: () => new Date(t),
      auth: fakeAuth({ asked, pages: [emptyPage(), deletePage(), emptyPage()], counts: { [CLOUD_MAILBOX_A]: 1_541 } }),
    });
    await mirror.pullOnce();
    expect(mirror.hostedCounts().get(CLOUD_MAILBOX_A), "the launch ask did not land").toBe(1_541);

    t += HOSTED_COUNTS_MIN_GAP_MS + 1_000;
    await mirror.pullOnce();  // this drain applies the tombstone
    expect(mirror.hostedCounts().size, "a held total survived a deletion it cannot be true of").toBe(0);

    t += HOSTED_COUNTS_MIN_GAP_MS + 1_000;
    await mirror.pullOnce();  // …and the count is re-asked, well inside the TTL
    expect(t - Date.parse("2026-08-21T12:00:00.000Z")).toBeLessThan(HOSTED_COUNTS_TTL_MS);
    // Two counted asks: the launch, and the one the deletion bought. The refresh runs at the TOP
    // of a pull, so the tombstone's own pull had already asked (without counts) before it applied
    // — which is exactly why dropping the map on the spot is the load-bearing half and the re-ask
    // is only the recovery.
    expect(countedAsks(asked), "the deletion did not buy a fresh count").toHaveLength(2);
    expect(mirror.hostedCounts().get(CLOUD_MAILBOX_A)).toBe(1_541);
  });

  it("A MALFORMED ANSWER STILL SPENDS THE ASK — a reconnect ladder may not re-ask every second", async () => {
    // `countsAskedAt` used to be written after a successful apply, so a throw anywhere between the
    // request and the apply left it unset and the backoff ladder (1 s, 2 s, 4 s) re-asked for the
    // full-table aggregate on every retry. The floor protects the ACCOUNT's database, so what it
    // has to count is the ask.
    const { opened, world, cursorPath } = await standUp();
    const asked: string[] = [];
    let t = Date.parse("2026-08-21T12:00:00.000Z");
    let broken = true;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        if (path.startsWith("/mailboxes")) {
          asked.push(path);
          if (broken) {
            // A well-formed HTTP answer whose BODY is not a mailbox list: the shape that throws
            // after the request has already been paid for.
            return new Response(JSON.stringify({ items: "not a list" }), {
              status: 200, headers: { "content-type": "application/json" },
            });
          }
          const box = hostedMailbox(CLOUD_MAILBOX_A, "me@ohmail.test");
          return new Response(JSON.stringify(mailboxList([{ ...box, messageCount: 1_541 }])), {
            status: 200, headers: { "content-type": "application/json" },
          });
        }
        const body = path.startsWith("/sync/snapshot")
          ? { asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } }
          : path.startsWith("/messages/bodies")
            ? { items: [], nextCursor: null }
            : emptyPage();
        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db: opened.db, world, cursorPath, now: () => new Date(t), auth });

    await expect(mirror.pullOnce()).rejects.toBeTruthy();
    expect(countedAsks(asked)).toHaveLength(1);
    // The reconnect ladder's first two retries, both inside the floor.
    t += 1_000;
    await expect(mirror.pullOnce()).rejects.toBeTruthy();
    t += 2_000;
    await expect(mirror.pullOnce()).rejects.toBeTruthy();
    expect(countedAsks(asked), "a failing pull re-asked for the aggregate inside the floor").toHaveLength(1);
    // AND THE RECOVERY IS THE ORDINARY CADENCE, not the floor. A spent ask that taught this
    // process nothing leaves the denominator unknown, and the strip then says nothing — for up to
    // one TTL, which is the deliberate price of not letting a hosted build that cannot answer
    // (or one that is failing) turn the floor into the interval. Past the TTL it asks again.
    broken = false;
    t += HOSTED_COUNTS_MIN_GAP_MS;
    await mirror.pullOnce();
    expect(countedAsks(asked), "the floor became the interval after a failure").toHaveLength(1);
    expect(mirror.hostedCounts().size).toBe(0);

    t += HOSTED_COUNTS_TTL_MS;
    await mirror.pullOnce();
    expect(countedAsks(asked)).toHaveLength(2);
    expect(mirror.hostedCounts().get(CLOUD_MAILBOX_A)).toBe(1_541);
  });

  it("THE BUDGET: an hour of steady 20 s polling costs FOUR aggregates, not 180", async () => {
    const { opened, world, cursorPath } = await standUp();
    const asked: string[] = [];
    let t = Date.parse("2026-08-21T12:00:00.000Z");
    const mirror = createCloudMirror({
      db: opened.db, world, cursorPath, now: () => new Date(t),
      auth: fakeAuth({ asked, counts: { [CLOUD_MAILBOX_A]: 1_541 } }),
    });
    for (let i = 0; i < 180; i++) {
      await mirror.pullOnce();
      t += 20_000;
    }
    expect(mailboxAsks(asked), "the ordinary refresh stopped happening").toHaveLength(180);
    // One at launch plus one per TTL window over the run, so five at the very most
    // depending on where the hour's boundary falls.
    expect(countedAsks(asked).length).toBeLessThanOrEqual(5);
    expect(countedAsks(asked).length).toBeGreaterThanOrEqual(4);
  });

  it("AN ACCOUNT THAT ANSWERS NO COUNTS IS ASKED ONCE, NOT FOR EVER", async () => {
    // The failure this pins: gating the next ask on "is the map still empty" alone would turn a
    // hosted build without the field into the exact request storm the cadence exists to prevent —
    // three full-table aggregates a minute, for as long as the app is open.
    const { opened, world, cursorPath } = await standUp();
    const asked: string[] = [];
    let t = Date.parse("2026-08-21T12:00:00.000Z");
    const mirror = createCloudMirror({
      db: opened.db, world, cursorPath, now: () => new Date(t),
      auth: fakeAuth({ asked, counts: null }),
    });
    for (let i = 0; i < 5; i++) {
      await mirror.pullOnce();
      t += 20_000;
    }
    expect(countedAsks(asked)).toHaveLength(1);
    expect(mirror.hostedCounts().size, "a count was invented for an account that reported none").toBe(0);
  });

  it("a mailbox the account stops naming loses its count — the map is rebuilt, never merged", async () => {
    const { opened, world, cursorPath } = await standUp();
    const asked: string[] = [];
    let t = Date.parse("2026-08-21T12:00:00.000Z");
    let ids: readonly string[] = [CLOUD_MAILBOX_A, CLOUD_MAILBOX_B];
    const auth: CloudAuth = {
      authedFetch: async (path: string) =>
        fakeAuth({ asked, counts: { [CLOUD_MAILBOX_A]: 1_000, [CLOUD_MAILBOX_B]: 541 }, mailboxIds: ids })
          .authedFetch(path),
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db: opened.db, world, cursorPath, now: () => new Date(t), auth });
    await mirror.pullOnce();
    expect([...mirror.hostedCounts().values()].reduce((a, b) => a + b, 0)).toBe(1_541);

    ids = [CLOUD_MAILBOX_A];
    t += HOSTED_COUNTS_TTL_MS + 1_000;
    await mirror.pullOnce();
    expect(mirror.hostedCounts().has(CLOUD_MAILBOX_B), "a removed mailbox kept a stale count in the sum").toBe(false);
    expect(mirror.hostedCounts().get(CLOUD_MAILBOX_A)).toBe(1_000);
  });
});


/* ══════════════════════════════════════════════════════════════════════════════════════════
   AND THE NUMBER HAS TO REACH THE WINDOW — through the REAL request handler
   ══════════════════════════════════════════════════════════════════════════════════════════

   `GET /mailboxes` in Cloud mode is served out of the mirror, so every field on those rows is a
   fact about the local copy. The strip's sentence needs one field that is not: the count the
   mirror is draining TOWARD. These drive `createCloudSidecar` end to end — hosted fake, real
   mirror, real handler — because the decoration lives at the mount point and a unit test of the
   map would prove nothing about what the window receives. */

const sidecars: CloudSidecar[] = [];
const sidecarDirs: string[] = [];
afterEach(() => tearDown({ stop: [sidecars, mirrors], remove: sidecarDirs }));

async function freshDir(): Promise<string> {
  const d = await freshDataDir("ohmail-hosted-counts-e2e-");
  sidecarDirs.push(d);
  return d;
}

/** A hosted fake for the sidecar's own `fetchImpl`, answering counts only when asked. */
function hostedFetch(counts: number | null, calls: string[]): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    calls.push(`${url.pathname}${url.search}`);
    const send = (v: unknown): Response =>
      new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname === "/mailboxes") {
      const wants = url.searchParams.get("counts") === "1";
      const box = hostedMailbox(CLOUD_MAILBOX_A, "me@ohmail.test");
      return send(mailboxList([wants && counts !== null ? { ...box, messageCount: counts } : box]));
    }
    if (url.pathname === "/sync") return send(emptyPage());
    if (url.pathname === "/sync/snapshot") return send({ asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("the window's mailbox list carries the account's own count", () => {
  // A Cloud door stands up in 6 to 9 s here; the 5 s default never fired while its pull held the loop.
  it("a counted account reaches `hostedMessageCount`, and `messageCount` stays absent", { timeout: 30_000 }, async () => {
    const calls: string[] = [];
    const sidecar = await createCloudSidecar({
      dataDir: await freshDir(),
      cloudUrl: "https://cloud.test",
      address: "me@ohmail.test",
      tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl: hostedFetch(1_541, calls),
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start();

    const res = await sidecar.handle(new Request("http://sidecar/mailboxes", {
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    expect(res.status).toBe(200);
    const [row] = (await res.json()).items as Array<Record<string, unknown>>;
    expect(row!.hostedMessageCount, "the account's own count never reached the window").toBe(1_541);
    // The LOCAL aggregate is never computed for this route: a mirror's own count under any name
    // beside the hosted one is how the strip's "N of M" turns into two of the mirror's own numbers and says nothing.
    expect("messageCount" in row!, "the mirror computed an aggregate of ITSELF").toBe(false);
  });

  it("an account that reports nothing leaves the field ABSENT — not zero", { timeout: 30_000 }, async () => {
    const calls: string[] = [];
    const sidecar = await createCloudSidecar({
      dataDir: await freshDir(),
      cloudUrl: "https://cloud.test",
      address: "me@ohmail.test",
      tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl: hostedFetch(null, calls),
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start();

    const res = await sidecar.handle(new Request("http://sidecar/mailboxes", {
      headers: { authorization: `Bearer ${sidecar.sessionToken}` },
    }));
    const [row] = (await res.json()).items as Array<Record<string, unknown>>;
    expect("hostedMessageCount" in row!, "an unknown denominator was emitted as a number").toBe(false);
  });
});
