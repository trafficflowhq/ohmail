import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { mailboxes, mailboxProfileMirror } from "@trafficflow/db/mail";
import {
  syncService, type MailboxDTO, type MailboxProfileDTO, type RuleDTO, type ServiceContext,
  type SnapshotResponse, type SyncChange, type SyncResponse,
} from "@trafficflow/services/mail";
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
 * A DESKTOP SIGNED IN TO CLOUD SHOWS THE ORGANIZER'S ARRANGEMENT (HOSTED-DESKTOP-CLOUD-READER-ARRANGEMENT).
 *
 * Where Cloud only reads a mailbox a desktop at home organizes, the web and the phone judge that
 * mailbox by the organizer's rules (`mailbox_profile`). The desktop's Cloud mirror never asked for
 * the type, so its window split the mailbox by the Cloud account's own rules. Read here through
 * the local door the window drains, which is where the arrangement has to arrive.
 */

const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const READ_ONLY: MailboxDTO = hostedMailbox(MAILBOX, "me@ohmail.test", {
  organizerRole: "reader",
  organizedBy: { kind: "local", name: "Studio", since: "2026-09-01T00:00:00.000Z" },
  organizedByThisInstall: false,
});
const AS_OF = "2026-09-27T12:00:00.000Z";

const opens: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(() => tearDown({ stop: [mirrors], close: opens, remove: dirs }));

async function standUp(): Promise<{ db: OpenLocalDb["db"]; world: LocalWorld; cursorPath: string }> {
  const dataDir = await freshDataDir("ohmail-cloud-profile-");
  dirs.push(dataDir);
  const opened = await openLocalDb(dataDir);
  opens.push(opened);
  const world = await ensureLocalWorld(opened.db, { address: "me@ohmail.test", now: new Date() });
  return { db: opened.db, world, cursorPath: join(dataDir, "cloud-cursor.json") };
}

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

function profileRule(at: number, match: string): RuleDTO {
  return {
    id: `profile:${MAILBOX}:${at}`, kind: "sender", match, destination: "ohmail/News", priority: 0,
    provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
    stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: AS_OF, updatedAt: AS_OF,
    retro: { requestedAt: null, doneAt: null }, byOhmail: false,
  };
}

/** The organizer's document with an unreadable entry at index 1, which the projection skipped. */
const PROFILE: MailboxProfileDTO = {
  mailboxId: MAILBOX,
  rules: [profileRule(0, "letters@paper.test"), profileRule(2, "digest@weekly.test")],
  asOf: AS_OF, from: { kind: "local", name: "Studio", since: "2026-09-01T00:00:00.000Z" }, updatedAt: AS_OF,
  applied: ["req-1"],
};

const change = (op: SyncChange["op"], seq: number, entity?: unknown): SyncChange =>
  ({ type: "mailbox_profile", op, id: MAILBOX, seq, updatedAt: AS_OF, ...(entity ? { entity } : {}) });

function syncPage(changes: SyncChange[], cursor: string): SyncResponse {
  return {
    changes: {
      creates: changes.filter((c) => c.op === "create"), updates: changes.filter((c) => c.op === "update"),
      moves: [], deletes: changes.filter((c) => c.op === "delete"),
    },
    cursor, hasMore: false, serverTime: AS_OF,
  };
}

function fakeAuth(sync: SyncResponse[], snapshot: SnapshotResponse, asked: string[] = []): CloudAuth {
  let s = 0;
  return {
    authedFetch: async (path: string) => {
      asked.push(path);
      if (path.startsWith("/mailboxes")) return json(mailboxList([READ_ONLY]));
      if (path.startsWith("/sync/snapshot")) return json(snapshot);
      if (path.startsWith("/sync") && new URLSearchParams(path.split("?")[1] ?? "").get("types") === "rule") {
        return json(syncPage([], "rules-end"));
      }
      if (path.startsWith("/sync")) return json(sync[s++] ?? syncPage([], "end"));
      if (path.startsWith("/messages/bodies")) return json({ items: [], nextCursor: null });
      return new Response("not found", { status: 404 });
    },
    currentTokens: () => ({ accessToken: "a", refreshToken: "r" }),
    sealState: () => ({ sealed: true, reason: null }),
    ...idleSession,
  };
}

const EMPTY_SNAPSHOT: SnapshotResponse = { asOfSeq: 99, changes: [], nextCursor: null, window: { days: 90, minRows: 500 } };

/** What the window reads: page 1 of this install's own snapshot. */
async function localProfile(db: OpenLocalDb["db"], world: LocalWorld): Promise<MailboxProfileDTO | undefined> {
  const ctx: ServiceContext = { db, accountId: world.accountId, userId: null, now: () => new Date(AS_OF), requestId: "profile" };
  const page = await syncService.getSnapshot(ctx, {});
  return page.changes.find((c) => c.type === "mailbox_profile")?.entity as MailboxProfileDTO | undefined;
}

describe("the Cloud mirror carries the organizer's arrangement", () => {
  it("asks for it, stores it, and the local door serves it with the account's rule ids", async () => {
    const { db, world, cursorPath } = await standUp();
    const asked: string[] = [];
    await createCloudMirror({
      db, world, cursorPath, now: () => new Date(AS_OF),
      auth: fakeAuth([syncPage([change("create", 1, PROFILE)], "c1")], EMPTY_SNAPSHOT, asked),
    }).pullOnce();
    const typesAsked = asked.filter((p) => p.startsWith("/sync?")).map((p) => new URLSearchParams(p.split("?")[1]).get("types") ?? "");
    expect(typesAsked.some((t) => t.split(",").includes("mailbox_profile"))).toBe(true);
    const served = await localProfile(db, world);
    expect(served?.rules.map((r) => [r.id, r.match])).toEqual([
      [`profile:${MAILBOX}:0`, "letters@paper.test"],
      [`profile:${MAILBOX}:2`, "digest@weekly.test"],
    ]);
    expect(served?.asOf).toBe(AS_OF);
    expect(served?.applied).toEqual(["req-1"]);
  });

  it("a delete takes it away again", async () => {
    const { db, world, cursorPath } = await standUp();
    const pull = (page: SyncResponse) => createCloudMirror({
      db, world, cursorPath, now: () => new Date(AS_OF), auth: fakeAuth([page], EMPTY_SNAPSHOT),
    }).pullOnce();
    await pull(syncPage([change("create", 1, PROFILE)], "c1"));
    expect(await localProfile(db, world)).toBeDefined();
    await pull(syncPage([change("delete", 2)], "c2"));
    expect(await localProfile(db, world)).toBeUndefined();
  });

  it("a mirror that bootstrapped before it asked is repaired once from snapshot page 1", async () => {
    const { db, world, cursorPath } = await standUp();
    const snapshot: SnapshotResponse = { ...EMPTY_SNAPSHOT, changes: [{ ...change("create", 99, PROFILE) }] };
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(AS_OF), auth: fakeAuth([], EMPTY_SNAPSHOT) }).pullOnce();
    // What an upgraded install carries: a cursor file written before the repair existed.
    const cur = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
    delete cur.profileRepair;
    writeFileSync(cursorPath, JSON.stringify(cur));
    expect(await localProfile(db, world)).toBeUndefined();

    const asked: string[] = [];
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(AS_OF), auth: fakeAuth([], snapshot, asked) }).pullOnce();
    expect((await localProfile(db, world))?.rules.map((r) => r.id)).toEqual([`profile:${MAILBOX}:0`, `profile:${MAILBOX}:2`]);
    const again: string[] = [];
    await createCloudMirror({ db, world, cursorPath, now: () => new Date(AS_OF), auth: fakeAuth([], snapshot, again) }).pullOnce();
    expect(again.some((p) => p.startsWith("/sync/snapshot")), "the repair ran twice").toBe(false);
  });

  it("a bootstrap sweeps an arrangement the account no longer names, and keeps one it does", async () => {
    const stale = async (named: boolean): Promise<unknown[]> => {
      const { db, world, cursorPath } = await standUp();
      // What an earlier bootstrap left: the mailbox row the refresh keeps, and its old document.
      await db.insert(mailboxes).values({ id: MAILBOX, accountId: world.accountId, provider: "imap", address: "old@ohmail.test" });
      await db.insert(mailboxProfileMirror).values({
        mailboxId: MAILBOX, accountId: world.accountId, doc: { rules: [] }, readAt: new Date(AS_OF),
      });
      const snapshot: SnapshotResponse = { ...EMPTY_SNAPSHOT, changes: named ? [change("create", 99, PROFILE)] : [] };
      await createCloudMirror({ db, world, cursorPath, now: () => new Date(AS_OF), auth: fakeAuth([], snapshot) }).pullOnce();
      return db.select().from(mailboxProfileMirror).where(eq(mailboxProfileMirror.mailboxId, MAILBOX));
    };
    expect(await stale(false), "a document the account no longer names outlived the bootstrap").toEqual([]);
    expect(await stale(true)).toHaveLength(1);
  });

  it("an arrangement for a mailbox this mirror does not hold is not stored", async () => {
    const { db, world, cursorPath } = await standUp();
    const stranger = { ...PROFILE, mailboxId: randomUUID() };
    const mirror = createCloudMirror({
      db, world, cursorPath, now: () => new Date(AS_OF),
      auth: fakeAuth([syncPage([{ ...change("create", 1, stranger), id: stranger.mailboxId }], "c1")], EMPTY_SNAPSHOT),
    });
    await mirror.pullOnce();
    expect(await db.select().from(mailboxProfileMirror).where(eq(mailboxProfileMirror.mailboxId, stranger.mailboxId)))
      .toEqual([]);
    // Skipped, not refused: a row the store refuses is held aside and the mailbox shows an error.
    expect(mirror.quarantined().count).toBe(0);
  });
});
