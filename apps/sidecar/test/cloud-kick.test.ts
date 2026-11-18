import type { SyncResponse } from "@ohmail/wire";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * `CloudMirror.kick()` — the wake channel's entry into the mirror, BOUNDED.
 *
 * The property that matters is burst behaviour: the hosted account can commit twenty times in
 * the seconds an in-flight pull takes (a rule retro-pass, a busy correspondent), which is
 * twenty `sync` frames and twenty kicks. The in-flight pull may have read `/sync` BEFORE those
 * commits, so finishing it is not enough — but one follow-up reads everything, so exactly one
 * is what a burst may buy. N follow-ups would be N-1 wasted pulls; zero would leave the last
 * commits waiting out the poll, which is the latency the wake channel exists to remove.
 *
 * Real PGlite under the mirror (the sidecar's production truth); the wire is a fake
 * `authedFetch` whose `/sync` the test holds open to make "in flight" a state it controls.
 */

const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ opened: OpenLocalDb; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-cloud-kick-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  return { opened, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

const EMPTY_SYNC: SyncResponse = {
  changes: { creates: [], updates: [], moves: [], deletes: [] },
  cursor: "end",
  hasMore: false,
  serverTime: new Date().toISOString(),
};

/** A fake Cloud whose `/sync` answers only when the test releases it, counting pulls. */
function gatedCloud() {
  const waiters: Array<() => void> = [];
  let pulls = 0;
  const json = (v: unknown): Response =>
    new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const auth: CloudAuth = {
    authedFetch: async (path: string) => {
      if (path.startsWith("/mailboxes")) {
        pulls += 1;                          // every runPull begins here, exactly once
        return json(mailboxList([hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")]));
      }
      if (path.startsWith("/sync/snapshot")) return new Response("no snapshot", { status: 404 });
      if (path.startsWith("/sync")) {
        // The bootstrap's rules-first pass answers immediately: it is not one of the gated
        // pulls this fake meters — gating it would deadlock the very first pull, whose gate
        // the test releases exactly once per expected /sync.
        if (new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
          return json(EMPTY_SYNC);
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
        return json(EMPTY_SYNC);
      }
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
  return {
    auth,
    pulls: () => pulls,
    release: (): void => {
      for (const w of waiters.splice(0)) w();
    },
    inFlight: () => waiters.length > 0,
  };
}

const until = async (predicate: () => boolean, ms = 5_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!predicate() && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("CloudMirror.kick", () => {
  it("a BURST of kicks during an in-flight pull buys exactly ONE follow-up pull", async () => {
    const { opened, world, cursorPath } = await standUp();
    const cloud = gatedCloud();
    const mirror = createCloudMirror({ db: opened.db, world, auth: cloud.auth, cursorPath });

    mirror.kick();
    await until(() => cloud.inFlight());
    expect(cloud.pulls(), "the first kick must start a pull").toBe(1);

    // Twenty frames land while the pull is on the wire — a rule retro-pass on the account.
    for (let i = 0; i < 20; i++) mirror.kick();
    cloud.release();
    await until(() => cloud.inFlight());           // the single follow-up reaches /sync
    cloud.release();
    await until(() => !mirror.draining());

    expect(cloud.pulls(), "twenty mid-pull kicks must coalesce into one follow-up").toBe(2);

    // …and the follow-up was the LAST one: the queue is a bit, not a counter.
    await new Promise((r) => setTimeout(r, 100));
    expect(cloud.pulls()).toBe(2);

    await mirror.stop();
  }, 20_000);

  it("a kick on a STOPPED mirror pulls nothing", async () => {
    const { opened, world, cursorPath } = await standUp();
    const cloud = gatedCloud();
    const mirror = createCloudMirror({ db: opened.db, world, auth: cloud.auth, cursorPath });
    await mirror.stop();

    mirror.kick();
    await new Promise((r) => setTimeout(r, 100));
    expect(cloud.pulls(), "a stopped mirror answered a wake").toBe(0);
  }, 20_000);

  it("a kick whose pull FAILS does not retry — the poll owns retries", async () => {
    const { opened, world, cursorPath } = await standUp();
    let pulls = 0;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        if (path.startsWith("/mailboxes")) {
          pulls += 1;
          return new Response("upstream down", { status: 503 });
        }
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const mirror = createCloudMirror({ db: opened.db, world, auth, cursorPath });

    mirror.kick();
    await until(() => pulls > 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(pulls, "a failed kick retried by itself — that ladder belongs to the poll").toBe(1);
    // The failure still flipped the reachability flag, exactly as a failed poll does: the
    // wake path reuses `runPull` whole, so the door's offline honesty is unchanged.
    expect(mirror.online()).toBe(false);

    await mirror.stop();
  }, 20_000);
});
