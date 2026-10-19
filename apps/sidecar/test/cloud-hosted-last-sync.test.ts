import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

function answer(path: string, stamp: () => Stamp, boxesDown = false): Response {
  if (path.startsWith("/mailboxes")) {
    return boxesDown ? new Response("down", { status: 503 }) : send(mailboxList([box(stamp())]));
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
