import type { RuleDTO, SnapshotResponse, SyncChange, SyncResponse } from "@ohmail/wire";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { changeLog, rules } from "@trafficflow/db/mail";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld } from "../src/identity.js";
import { createCloudMirror as makeCloudMirror, RULES_REFRESH_MIN_GAP_MS } from "../src/cloud-mirror.js";
import type { CloudAuth } from "../src/cloud-auth.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
import { idleSession } from "./fixtures/cloud-auth-double.js";
import { tearDown, tracked } from "./_teardown.js";

const mirrors: ReturnType<typeof makeCloudMirror>[] = [];
const createCloudMirror = tracked(makeCloudMirror, mirrors);

/**
 * THE RULES AGAIN, MID-BOOTSTRAP. A queue answer read while this mirror still replays the account
 * owes one rules pass at the pull's next page boundary, from where the last rules pass ended, so a
 * sender decided on another device is filed here within one round trip instead of at the end of
 * the replay. Bounded: during a bootstrap only, at most once per {@link RULES_REFRESH_MIN_GAP_MS}.
 */

const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

const iso = (): string => new Date().toISOString();
const page = (changes: SyncChange[], cursor: string, hasMore: boolean): SyncResponse => ({
  changes: { creates: changes.filter((c) => c.op === "create"), updates: [], moves: [], deletes: [] },
  cursor, hasMore, serverTime: iso(),
});
const json = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
const EMPTY_SNAPSHOT: SnapshotResponse = { asOfSeq: 1, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } };
const DENY: RuleDTO = {
  id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", kind: "sender", match: "offers@spam.test", destination: "ohmail/Screened",
  priority: 0, provenance: "promoted", enabled: true, subjectContains: null, bodyContains: null,
  stats: { hits: 0, lastHitAt: null, demotions: 0 }, retro: { requestedAt: null, doneAt: null }, byOhmail: false,
  createdAt: iso(), updatedAt: iso(),
};

/** A gate a replay page waits behind, so a test can act while the bootstrap is mid-replay. */
function gate() {
  let open!: () => void;
  let reached!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const atGate = new Promise<void>((r) => { reached = r; });
  return { open, opened, reached, atGate };
}

/**
 * The account: a replay of four pages with two gates in it, and a rules stream whose first pass is
 * empty and whose later passes carry the rule another device wrote mid-bootstrap.
 */
function account() {
  const asked: string[] = [];
  const g2 = gate();
  const g3 = gate();
  let replay = 0;
  const auth: CloudAuth = {
    authedFetch: async (path: string) => {
      asked.push(path);
      const q = new URLSearchParams(path.split("?")[1] ?? "");
      if (path.startsWith("/mailboxes")) return json(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")]));
      if (path.startsWith("/sync/snapshot")) return json(EMPTY_SNAPSHOT);
      if (path.startsWith("/sync") && q.get("types") === "rule") {
        const since = q.get("since");
        if (since === "0") return json(page([], "r1", false));
        return json(page([{ type: "rule", op: "create", id: DENY.id, seq: 50, updatedAt: iso(), entity: DENY }], "r2", false));
      }
      if (path.startsWith("/sync")) {
        replay += 1;
        if (replay === 2) { g2.reached(); await g2.opened; }
        if (replay === 3) { g3.reached(); await g3.opened; }
        return json(page([], Buffer.from(String(replay)).toString("base64url"), replay < 4));
      }
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
  const rulesAsks = () => asked.filter((p) => p.startsWith("/sync?") && new URLSearchParams(p.split("?")[1]).get("types") === "rule")
    .map((p) => new URLSearchParams(p.split("?")[1]).get("since"));
  /** Where in the call log each kind of ask landed, so order can be asserted. */
  const order = () => asked.filter((p) => p.startsWith("/sync?")).map((p) =>
    new URLSearchParams(p.split("?")[1]).get("types") === "rule" ? `rules:${new URLSearchParams(p.split("?")[1]).get("since")}` : "replay");
  return { auth, g2, g3, rulesAsks, order };
}

async function standUp(auth: CloudAuth, clock: { t: number }) {
  const dataDir = await freshDataDir("ohmail-rules-refresh-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  const mirror = createCloudMirror({
    db: opened.db, world, auth, cursorPath: join(dataDir, "cloud-cursor.json"), now: () => new Date(clock.t),
  });
  return { db: opened.db, world, mirror };
}

describe("a queue answer during a bootstrap owes one rules pass", () => {
  it("runs at the next page boundary, from the last rules cursor, and lands the rule for the window", { timeout: 40_000 }, async () => {
    const a = account();
    const clock = { t: Date.parse("2026-10-01T12:00:00.000Z") };
    const { db, world, mirror } = await standUp(a.auth, clock);
    const pull = mirror.pullOnce();
    await a.g2.atGate;
    expect(mirror.bootstrapping(), "the mirror is mid-replay").toBe(true);
    expect(mirror.askRulesRefresh(), "the first answer owed no pass").toBe(true);
    expect(mirror.askRulesRefresh(), "a second answer inside the gap owed another").toBe(false);
    a.g2.open();
    await a.g3.atGate;
    expect(a.rulesAsks(), "the owed pass did not run before the next page").toEqual(["0", "r1"]);
    const [row] = await db.select().from(rules).where(eq(rules.id, DENY.id));
    expect(row?.destination, "the rule decided elsewhere is not in the copy").toBe("ohmail/Screened");
    const logged = await db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, world.accountId), eq(changeLog.entityId, DENY.id)));
    expect(logged.length, "the window's feed did not carry the rule").toBeGreaterThan(0);
    clock.t += RULES_REFRESH_MIN_GAP_MS;
    expect(mirror.askRulesRefresh(), "an answer after the gap owed no pass").toBe(true);
    a.g3.open();
    await pull;
    expect(a.rulesAsks()).toEqual(["0", "r1", "r2"]);
    expect(a.order().indexOf("rules:r2"), "the second pass waited for the replay to end").toBeLessThan(a.order().lastIndexOf("replay"));
  });

  it("owes nothing once the copy has taken in the account", { timeout: 40_000 }, async () => {
    const a = account();
    const clock = { t: Date.parse("2026-10-01T12:00:00.000Z") };
    const { mirror } = await standUp(a.auth, clock);
    a.g2.open();
    a.g3.open();
    await mirror.pullOnce();
    expect(mirror.bootstrapping()).toBe(false);
    clock.t += RULES_REFRESH_MIN_GAP_MS;
    expect(mirror.askRulesRefresh(), "a settled copy owed a rules pass").toBe(false);
  });
});

describe("an answer owed while the opening window pages", () => {
  it("runs before the window's next page, not after the window", { timeout: 40_000 }, async () => {
    const asked: string[] = [];
    const g = gate();
    let snaps = 0;
    const auth: CloudAuth = {
      authedFetch: async (path: string) => {
        asked.push(path);
        const q = new URLSearchParams(path.split("?")[1] ?? "");
        if (path.startsWith("/mailboxes")) return json(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")]));
        if (path.startsWith("/sync/snapshot")) {
          snaps += 1;
          if (snaps === 2) { g.reached(); await g.opened; }
          return json({ ...EMPTY_SNAPSHOT, nextCursor: snaps < 3 ? `w${snaps + 1}` : null });
        }
        if (path.startsWith("/sync") && q.get("types") === "rule") return json(page([], q.get("since") === "0" ? "r1" : "r2", false));
        if (path.startsWith("/sync")) return json(page([], "e", false));
        if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
        return new Response("not found", { status: 404 });
      },
      currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
      sealState: () => ({ sealed: true, reason: null }),
      ...idleSession,
    };
    const clock = { t: Date.parse("2026-10-01T12:00:00.000Z") };
    const { mirror } = await standUp(auth, clock);
    const pull = mirror.pullOnce();
    await g.atGate;
    expect(mirror.askRulesRefresh()).toBe(true);
    g.open();
    await pull;
    const seq = asked.filter((p) => p.startsWith("/sync")).map((p) =>
      p.startsWith("/sync/snapshot") ? "window" : new URLSearchParams(p.split("?")[1]).get("types") === "rule" ? `rules:${new URLSearchParams(p.split("?")[1]).get("since")}` : "replay");
    expect(seq.slice(0, 5), "the owed pass waited for the window to end").toEqual(["rules:0", "window", "window", "rules:r1", "window"]);
  });
});
