import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { changeLog, messages } from "@trafficflow/db/mail";
import type { MessageDTO, SyncChange, SyncResponse } from "@trafficflow/services/mail";
import {
  createCloudSidecar, enforceMirrorOwner, readMirrorErased, readMirrorRevoked, MIRROR_OWNER_FILE, type CloudSidecar,
} from "../src/cloud-engine.js";
import { encodeMirrorRecord } from "../src/cloud-origin.js";
import { openLocalDb } from "../src/db.js";
import { windowOutboxFilesOf, windowOutboxOwnerKey } from "../src/window-outbox.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";
/* @reads: apps/desktop/src-tauri/src/engine_tests.rs */

/**
 * A DELETED HOSTED ACCOUNT LEAVES NO COPY ON THE PAIRED DESKTOP. Measured at the base: the hosted
 * `410 account_erased` latched `/health.accountErased`, dropped the seal and left the mirror on
 * disk. Now, after the teardown: each mailbox's mail goes in one transaction with a removal
 * receipt, the cursor and the outbox go, and the database goes whole at the next launch, which
 * still says the account was deleted. A local-mode directory beside it is not touched. Watched
 * red: the discard cut; run BESIDE the teardown (a drain in flight writes after the delete); the
 * erased fact not carried across the relaunch.
 */

/** The record the desktop shell reads to discard a frozen directory, as its suite spells it. */
function shellRecord(name: string): string {
  const src = readFileSync(fileURLToPath(new URL("../../desktop/src-tauri/src/engine_tests.rs", import.meta.url)), "utf8");
  const found = new RegExp(`const ${name}: &str = r#"(.*?)"#;`).exec(src);
  if (!found) throw new Error(`engine_tests.rs declares no ${name}`);
  return found[1]!;
}

const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const iso = (): string => new Date().toISOString();
const send = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const erasedAnswer = (): Response =>
  send({ error: { code: "account_erased", message: "this account has been deleted" } }, 410, { "X-Ohmail-Account": CLOUD_ACCOUNT });

function messageDTO(id: string): MessageDTO {
  return {
    id, accountId: CLOUD_ACCOUNT, mailboxId: CLOUD_MAILBOX, threadId: null,
    messageIdHeader: `<${id}@sender.test>`, subject: "a letter",
    from: { name: null, address: "friend@elsewhere.test" },
    to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: iso(), date: iso(), folder: "INBOX",
    snippet: "hello", unread: true, lastReadAt: null,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}
const created = (id: string, seq: number): SyncChange =>
  ({ type: "message", op: "create", id, seq, updatedAt: iso(), entity: messageDTO(id) });
const page = (changes: SyncChange[], cursor: string): SyncResponse => ({
  changes: { creates: changes, updates: [], moves: [], deletes: [] }, cursor, hasMore: false, serverTime: iso(),
});

const MSG_ONE = "11111111-1111-4111-8111-111111111111";
const MSG_TWO = "22222222-2222-4222-8222-222222222222";

interface Rig {
  sidecar: CloudSidecar;
  root: string;
  dataDir: string;
  /** Hold the next plain `/sync` and answer it with a page carrying the second message once released. */
  holdNextSync: () => { pending: Promise<void>; release: () => void };
  erase: () => void;
  health: () => Promise<Record<string, unknown>>;
  auth: Record<string, string>;
}

const sidecars: CloudSidecar[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function hostedApi() {
  let erased = false;
  /** The session revoked at the server (Devices, sign out everywhere): `refresh_revoked`, with the sweep's cause when one. */
  let revoked: { cause?: "reuse" } | null = null;
  let hold: { arrived: () => void; gate: Promise<void> } | null = null;
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (url.pathname === "/sync" && url.searchParams.get("types") !== "rule" && hold !== null) {
      const h = hold;
      hold = null;
      h.arrived();
      await h.gate;
      return send(page([created(MSG_TWO, 2)], "c2"));
    }
    if (erased) return erasedAnswer();
    // A sign-in on this computer is a new session: the account answers again.
    if (url.pathname === "/auth/login") return send({ status: "twofa_required", loginToken: "lt-1" });
    if (url.pathname === "/auth/2fa/totp/verify") {
      revoked = null;
      return send({ tokens: { accessToken: "a3", refreshToken: "r3" } });
    }
    if (url.pathname === "/auth/session") return send({ user: { email: "me@ohmail.test" }, scope: "full" });
    if (revoked !== null) {
      return url.pathname === "/auth/refresh"
        ? send({ error: { code: "refresh_revoked", message: "invalid refresh token", ...(revoked.cause ? { details: { cause: revoked.cause } } : {}) } }, 401)
        : send({ error: { code: "unauthorized", message: "no session" } }, 401);
    }
    if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")]));
    if (url.pathname === "/sync/snapshot") {
      return send({ asOfSeq: 1, changes: [created(MSG_ONE, 1)], nextCursor: null, window: { days: 90, minRows: 5000 } });
    }
    if (url.pathname === "/sync") return send(page([], "c1"));
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    if (url.pathname === "/auth/refresh") return send({ tokens: { accessToken: "a2", refreshToken: "r2", expiresIn: 900 } });
    if (url.pathname === "/consent") return send({ settings: {} });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    erase: () => { erased = true; },
    revoke: (cause?: "reuse") => { revoked = cause ? { cause } : {}; },
    holdNextSync: () => {
      let arrived!: () => void;
      let release!: () => void;
      const pending = new Promise<void>((r) => { arrived = r; });
      const gate = new Promise<void>((r) => { release = r; });
      hold = { arrived, gate };
      return { pending, release };
    },
  };
}

/** `<root>/engine-cloud` is this door; `<root>/engine` is a local-mode directory beside it. */
async function rig(tokens = true): Promise<Rig & { api: ReturnType<typeof hostedApi> }> {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-erased-discard-"));
  roots.push(root);
  const dataDir = join(root, "engine-cloud");
  renameSync(await freshDataDir("ohmail-erased-discard-cloud-"), dataDir);
  return boot(root, dataDir, hostedApi(), tokens);
}

async function boot(root: string, dataDir: string, api: ReturnType<typeof hostedApi>, tokens: boolean) {
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test",
    ...(tokens ? { tokens: { accessToken: "a", refreshToken: "r" } } : {}),
    keks: { 1: randomBytes(32) }, fetchImpl: api.fetchImpl, pollIntervalMs: 40,
  });
  sidecars.push(sidecar);
  await sidecar.start();
  return {
    sidecar, root, dataDir, api,
    holdNextSync: api.holdNextSync, erase: api.erase,
    health: async (): Promise<Record<string, unknown>> =>
      (await sidecar.handle(new Request("http://sidecar/health"))).json() as Promise<Record<string, unknown>>,
    auth: { authorization: `Bearer ${sidecar.sessionToken}` },
  };
}

async function until(what: string, test: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Every file under `dir`, with the sha256 of its bytes. */
function snapshotTree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p, `${rel}${name}/`);
      else out[`${rel}${name}`] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(dir, "");
  return out;
}

/** What a database holds: message rows, and mailbox-removal receipts. */
async function countsIn(db: CloudSidecar["db"]): Promise<{ messages: number; receipts: number }> {
  const m = await db.select({ n: sql<number>`count(*)::int` }).from(messages);
  const r = await db.select({ n: sql<number>`count(*)::int` }).from(changeLog)
    .where(and(eq(changeLog.entityType, "mailbox"), eq(changeLog.op, "delete")));
  return { messages: Number(m[0]!.n), receipts: Number(r[0]!.n) };
}

/** What the directory's database holds, opened with the engine stopped. */
async function readStore(dataDir: string): Promise<{ messages: number; receipts: number }> {
  const opened = await openLocalDb(dataDir);
  try {
    return await countsIn(opened.db);
  } finally {
    await opened.close();
  }
}

/** The erased account's outbox files, and another account's on the same server, which stay. */
const ERASED_FILES = windowOutboxFilesOf(windowOutboxOwnerKey({ address: "me@ohmail.test", base: "https://cloud.test" }));
const OTHER_FILES = windowOutboxFilesOf(windowOutboxOwnerKey({ address: "other@ohmail.test", base: "https://cloud.test" }));

describe("the paired desktop of an erased account", () => {
  it("removes the mail with a drain in flight, then the cursor, and stages the database's discard", { timeout: 60_000 }, async () => {
    const r = await rig();
    const local = join(r.root, "engine");
    mkdirSync(join(local, "pgdata"), { recursive: true });
    writeFileSync(join(local, "pgdata", "PG_VERSION"), "17\n");
    writeFileSync(join(local, "config.json"), JSON.stringify({ door: "local" }));
    writeFileSync(join(local, "cloud-cursor.json"), "{}");
    const localBefore = snapshotTree(local);

    await until("the first message mirrored", async () => {
      const res = await r.sidecar.handle(new Request("http://sidecar/sync?since=0", { headers: r.auth }));
      return res.ok && (await res.text()).includes(MSG_ONE);
    });
    expect(existsSync(join(r.dataDir, "cloud-cursor.json"))).toBe(true);

    // The window's queued changes, kept on disk: an erased account's go with its mail; another's stay.
    for (const f of [...ERASED_FILES, ...OTHER_FILES]) writeFileSync(join(r.dataDir, f), "{}");
    // A drain in flight, holding a page with the second message — then the erased answer on another request.
    const held = r.holdNextSync();
    await held.pending;
    r.erase();
    await r.sidecar.handle(new Request("http://sidecar/consent", { headers: r.auth }));
    await until("/health.accountErased", async () => (await r.health()).accountErased === true);
    await new Promise((res) => setTimeout(res, 150));
    held.release();

    await until("the cursor gone", () => !existsSync(join(r.dataDir, "cloud-cursor.json")));
    await until("the discard staged", () => readMirrorErased(r.dataDir));
    for (const f of ERASED_FILES) {
      expect(existsSync(join(r.dataDir, f)), `${f}: the window's queued changes outlived the account`).toBe(false);
    }
    for (const f of OTHER_FILES) {
      expect(existsSync(join(r.dataDir, f)), `${f}: another account's queued changes went with this one`).toBe(true);
    }
    const record = JSON.parse(readFileSync(join(r.dataDir, MIRROR_OWNER_FILE), "utf8")) as Record<string, unknown>;
    expect(record).toMatchObject({ discardPending: true, erased: true, account: null });
    expect(readFileSync(join(r.dataDir, MIRROR_OWNER_FILE), "utf8"), "the shell reads another record")
      .toBe(shellRecord("ERASED_MIRROR_RECORD"));
    await r.sidecar.stop();
    sidecars.splice(sidecars.indexOf(r.sidecar), 1);

    const store = await readStore(r.dataDir);
    expect(store.messages, "the deleted account's mail is still on this computer").toBe(0);
    expect(store.receipts, "no removal receipt for the window or a paired phone to drain").toBe(1);
    expect(snapshotTree(local), "the local-mode directory beside it was touched").toEqual(localBefore);
  });

  it("the next launch removes the database and still says the account was deleted, until a session", { timeout: 60_000 }, async () => {
    const r = await rig();
    await until("the first message mirrored", async () => {
      const res = await r.sidecar.handle(new Request("http://sidecar/sync?since=0", { headers: r.auth }));
      return res.ok && (await res.text()).includes(MSG_ONE);
    });
    r.erase();
    await until("the discard staged", () => readMirrorErased(r.dataDir));
    await r.sidecar.stop();
    sidecars.splice(sidecars.indexOf(r.sidecar), 1);
    // A probe inside the old database: an inode number can be reused, a file that was removed cannot.
    writeFileSync(join(r.dataDir, "pgdata", "erased-discard-probe"), "the old database");

    const again = await boot(r.root, r.dataDir, hostedApi(), false);
    const h = await again.health();
    expect(h.accountErased, "the relaunch forgot the account was deleted").toBe(true);
    expect(h.signedIn).toBe(false);
    expect(existsSync(join(r.dataDir, "pgdata", "erased-discard-probe")), "the database was not discarded").toBe(false);
    const record = JSON.parse(readFileSync(join(r.dataDir, MIRROR_OWNER_FILE), "utf8")) as Record<string, unknown>;
    expect(record.discardPending, "a staged discard survived its own launch").toBeUndefined();
    expect(record.erased).toBe(true);
    expect(readFileSync(join(r.dataDir, MIRROR_OWNER_FILE), "utf8"), "the shell reads another record")
      .toBe(shellRecord("ERASED_MIRROR_RECORD_AFTER_ITS_LAUNCH"));
    await again.sidecar.stop();
    sidecars.splice(sidecars.indexOf(again.sidecar), 1);
    expect((await readStore(r.dataDir)).messages).toBe(0);
  });

  it("a session after the card clears it on disk: signed out again, the next launch is a sign-in, not the card", { timeout: 60_000 }, async () => {
    // ERASED-ACCOUNT-CARD-NOT-KEPT-ACROSS-A-RELAUNCH's residual: the flag was cleared in memory
    // alone, so a launch with no session after a new sign-in said the account was deleted again.
    const r = await rig();
    await until("the first message mirrored", async () => {
      const res = await r.sidecar.handle(new Request("http://sidecar/sync?since=0", { headers: r.auth }));
      return res.ok && (await res.text()).includes(MSG_ONE);
    });
    r.erase();
    await until("the discard staged", () => readMirrorErased(r.dataDir));
    await r.sidecar.stop();
    sidecars.splice(sidecars.indexOf(r.sidecar), 1);

    // A new session: the person signed in again after the card.
    const signedIn = await boot(r.root, r.dataDir, hostedApi(), true);
    expect((await signedIn.health()).accountErased).toBe(false);
    expect(readMirrorErased(r.dataDir), "the record still says the account was deleted").toBe(false);
    const out = await signedIn.sidecar.handle(new Request("http://sidecar/cloud/session", { method: "DELETE", headers: signedIn.auth }));
    expect(out.status).toBe(200);
    await signedIn.sidecar.stop();
    sidecars.splice(sidecars.indexOf(signedIn.sidecar), 1);

    const later = await boot(r.root, r.dataDir, hostedApi(), false);
    const h = await later.health();
    expect(h.signedIn).toBe(false);
    expect(h.accountErased, "a launch after a sign-in and a sign-out showed the deleted-account card").toBe(false);
  });

  it("CONTROL — a lapse at the refresh door (refresh_expired) signs out and keeps the copy", { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-erased-discard-"));
    roots.push(root);
    const dataDir = join(root, "engine-cloud");
    renameSync(await freshDataDir("ohmail-erased-discard-cloud-"), dataDir);
    let refused = false;
    const api = hostedApi();
    const inner = api.fetchImpl;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (refused) {
        return new URL(raw).pathname === "/auth/refresh"
          ? send({ error: { code: "refresh_expired", message: "no" } }, 401)
          : send({ error: { code: "unauthorized", message: "no" } }, 401);
      }
      return inner(input, init);
    }) as unknown as typeof fetch;
    const r = await boot(root, dataDir, { ...api, fetchImpl }, true);
    await until("the first message mirrored", async () => {
      const res = await r.sidecar.handle(new Request("http://sidecar/sync?since=0", { headers: r.auth }));
      return res.ok && (await res.text()).includes(MSG_ONE);
    });
    refused = true;
    await until("/health.sessionExpired", async () => (await r.health()).sessionExpired === true);
    expect((await r.health()).accountErased).toBe(false);
    expect(readMirrorErased(dataDir)).toBe(false);
    expect(readFileSync(join(dataDir, MIRROR_OWNER_FILE), "utf8"), "the shell reads another record")
      .toBe(shellRecord("SIGNED_OUT_MIRROR_RECORD"));
    await r.sidecar.stop();
    sidecars.splice(sidecars.indexOf(r.sidecar), 1);
    expect((await readStore(dataDir)).messages, "a sign-out took the mail").toBe(1);
  });
});

/**
 * A SESSION REVOKED AT ITS SERVER LEAVES NO COPY EITHER. Devices → remove, signing out everywhere or a
 * password or two-step change answers the next renewal `refresh_revoked` (a reuse sweep too): the
 * mail goes now, with a removal receipt per mailbox, the cursor with it, and the database's files at
 * the stop — or, after a crash or on a launch after an older build heard it, before the next launch
 * opens anything, once. The window's changes stay for the account's next sign-in, as Sign out keeps
 * them, and a sign-in in the same run keeps the database it fills again. Watched red: the revoke
 * read as a lapse; the files left at the stop; a removal at every launch.
 */
describe("the desktop of a session revoked at its server", () => {
  const recordOf = (dataDir: string): Record<string, unknown> =>
    JSON.parse(readFileSync(join(dataDir, MIRROR_OWNER_FILE), "utf8")) as Record<string, unknown>;
  const mirrored = async (r: Rig): Promise<void> => until("the first message mirrored", async () => {
    const res = await r.sidecar.handle(new Request("http://sidecar/sync?since=0", { headers: r.auth }));
    return res.ok && (await res.text()).includes(MSG_ONE);
  });
  const stopped = async (s: CloudSidecar): Promise<void> => {
    await s.stop();
    sidecars.splice(sidecars.indexOf(s), 1);
  };

  for (const [name, cause] of [["refresh_revoked", undefined], ["a reuse sweep", "reuse"]] as const) {
    it(`${name}: the mail goes with a drain in flight, the window's changes stay, the files go at the stop`, { timeout: 60_000 }, async () => {
      const r = await rig();
      const local = join(r.root, "engine");
      mkdirSync(join(local, "pgdata"), { recursive: true });
      writeFileSync(join(local, "pgdata", "PG_VERSION"), "17\n");
      writeFileSync(join(local, "config.json"), JSON.stringify({ door: "local" }));
      const localBefore = snapshotTree(local);
      await mirrored(r);
      const before = recordOf(r.dataDir);
      // This account's queued change (`ERASED_FILES[0]` is its file) and another account's files: both stay.
      const mine = ERASED_FILES[0]!;
      writeFileSync(join(r.dataDir, mine), JSON.stringify({ v: 1, rows: [{ type: "outbox_entry", id: "k-1", entity: { key: "k-1" } }] }));
      for (const f of OTHER_FILES) writeFileSync(join(r.dataDir, f), "{}");
      const held = r.holdNextSync();
      await held.pending;
      r.api.revoke(cause);
      await r.sidecar.handle(new Request("http://sidecar/consent", { headers: r.auth }));
      await until("/health.sessionExpired", async () => (await r.health()).sessionExpired === true);
      await new Promise((res) => setTimeout(res, 150));
      held.release();

      // The sign-in door waits for the whole teardown, the removal in it: a body it cannot read is answered after.
      const waited = await r.sidecar.handle(new Request("http://sidecar/cloud/signin", { method: "POST", headers: r.auth, body: "{" }));
      expect(waited.status).toBe(400);
      expect(readMirrorRevoked(r.dataDir), "the sign-in door answered before the copy was removed").toBe(true);
      expect(existsSync(join(r.dataDir, "cloud-cursor.json")), "the cursor outlived the mail").toBe(false);
      expect(await countsIn(r.sidecar.db), "the mail stayed, or no receipt for the window or a paired phone")
        .toEqual({ messages: 0, receipts: 1 });
      for (const f of [mine, ...OTHER_FILES]) {
        expect(existsSync(join(r.dataDir, f)), `${f}: the window's queued changes went with the copy`).toBe(true);
      }
      expect(recordOf(r.dataDir), "the address, server and account are kept").toEqual({ ...before, revoked: true });
      expect(await r.health()).toMatchObject({ restartRequired: false, accountErased: false, signedIn: false, queued: { count: 1 } });
      writeFileSync(join(r.dataDir, "pgdata", "revoke-probe"), "the old database");
      await stopped(r.sidecar);
      expect(existsSync(join(r.dataDir, "pgdata", "revoke-probe")), "the database's files outlived the stop").toBe(false);
      expect(existsSync(join(r.dataDir, "cloud-cursor.json"))).toBe(false);
      expect(existsSync(join(r.dataDir, mine)), "the stop took the window's queued change").toBe(true);
      expect(recordOf(r.dataDir), "the flag outlived the files").toEqual(before);
      expect(snapshotTree(local), "the local-mode directory beside it was touched").toEqual(localBefore);
      // The next launch keeps the database it makes: the stop paid what was owed.
      mkdirSync(join(r.dataDir, "pgdata"), { recursive: true });
      writeFileSync(join(r.dataDir, "pgdata", "revoke-probe"), "the next launch's database");
      enforceMirrorOwner(r.dataDir, "me@ohmail.test", "https://cloud.test");
      expect(existsSync(join(r.dataDir, "pgdata", "revoke-probe")), "the next launch removed its own database").toBe(true);
    });
  }

  const refusal = JSON.stringify({ code: "refresh_revoked", since: new Date().toISOString() });
  for (const [name, left] of [
    ["a crash after the mail went", { flag: true }],
    ["an older build that heard the revoke", { flag: false }],
  ] as const) {
    it(`${name}: the next launch removes the copy before it opens it, and only once`, { timeout: 90_000 }, async () => {
      const r = await rig();
      await mirrored(r);
      await stopped(r.sidecar);
      // What that run left: the kept refusal, no seal, the copy on disk, and the flag when the discard ran.
      rmSync(join(r.dataDir, "cloud-tokens.seal"), { force: true });
      writeFileSync(join(r.dataDir, "cloud-session-refused.json"), refusal);
      if (left.flag) {
        writeFileSync(join(r.dataDir, MIRROR_OWNER_FILE), encodeMirrorRecord("me@ohmail.test", "https://cloud.test", null, false, false, true));
      }
      writeFileSync(join(r.dataDir, "pgdata", "revoke-probe"), "the old database");

      const again = await boot(r.root, r.dataDir, hostedApi(), false);
      expect(existsSync(join(r.dataDir, "pgdata", "revoke-probe")), "the launch opened the copy").toBe(false);
      expect((await countsIn(again.sidecar.db)).messages).toBe(0);
      expect(readMirrorRevoked(r.dataDir)).toBe(false);
      expect((await again.health()).session, "the sign-in no longer says why").toMatchObject({ state: "refused_before", code: "refresh_revoked" });
      await stopped(again.sidecar);

      writeFileSync(join(r.dataDir, "pgdata", "revoke-probe"), "the database the last launch made");
      const third = await boot(r.root, r.dataDir, hostedApi(), false);
      expect(existsSync(join(r.dataDir, "pgdata", "revoke-probe")), "every launch removes the database again").toBe(true);
      expect((await third.health()).session).toMatchObject({ state: "refused_before", code: "refresh_revoked" });
    });
  }

  it("a sign-in in the same run keeps the database it fills again", { timeout: 60_000 }, async () => {
    const r = await rig();
    await mirrored(r);
    r.api.revoke();
    await r.sidecar.handle(new Request("http://sidecar/consent", { headers: r.auth }));
    await until("the copy removed", () => readMirrorRevoked(r.dataDir));
    const signIn = await r.sidecar.handle(new Request("http://sidecar/cloud/signin", {
      method: "POST", headers: { ...r.auth, "content-type": "application/json" },
      body: JSON.stringify({ email: "me@ohmail.test", password: "pw", totp: "123456" }),
    }));
    expect(signIn.status, await signIn.clone().text()).toBe(200);
    expect(readMirrorRevoked(r.dataDir), "a new session still owes the removal").toBe(false);
    await until("the mail pulled again", async () => (await countsIn(r.sidecar.db)).messages > 0);
    writeFileSync(join(r.dataDir, "pgdata", "revoke-probe"), "this session's database");
    await stopped(r.sidecar);
    expect(existsSync(join(r.dataDir, "pgdata", "revoke-probe")), "the stop removed a signed-in session's database").toBe(true);
  });
});
