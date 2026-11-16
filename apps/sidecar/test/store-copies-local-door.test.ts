import fs, { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import type { ChangeBatch, ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { LOCAL_STORE_EXTENSIONS, PGDATA_SUBDIR } from "../src/db.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { createSidecarLogger, diagnosticFor } from "../src/log.js";
import { freshDataDir } from "./_datadir.js";
import { NEW_HEAD, OLD_STORE, folderAtOldHead } from "./_old-head-store.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: 4 * PGLITE_STANDUP_BUDGET_MS });

/**
 * A DESKTOP THAT ORGANIZES ON ITS OWN, AND THE COPIES OF ITS STORE. Its update to 2.0 keeps a copy
 * of the 1.0 store, and earlier starts may have set a store aside: each holds every letter and
 * the mailbox passwords, sealed, with the key beside them. So signing out, removing a mailbox,
 * taking a paired device back and a start that finishes a removal each take every copy; a
 * sign-out or a removal that cannot take one is refused with nothing else changed; what asks for
 * nothing to be gone (a new password, a quit, a relaunch) takes none; and the copy from the
 * update leaves on its own once the updated store has served every mailbox it holds a login for.
 */

const COPY = "store-before-2.0";
const SET_ASIDE = "set-aside-20260926T101323Z";
const COPIES = [SET_ASIDE, COPY];
const HOST = "imap.example.test";
const USER = "owner@example.test";
const PASS = "the-seed-password";
const KEKS = { 1: Buffer.alloc(32, 7) };
const EMPTY_BATCH: ChangeBatch = { creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} } };

/** A mail server as a double: it admits every login, or only the one named, and has no mail. */
function server(only?: string) {
  return (cfg: ImapConfig): MailboxAdapter => ({
    leaseIo: () => ({
      async ensureMetaFolder(): Promise<void> {},
      async listClaims(): Promise<never[]> { return []; },
      async appendClaim(): Promise<void> {},
      async removeClaims(): Promise<void> {},
      async findOwnRecords(): Promise<never[]> { return []; },
      uidValidity(): number | bigint | null { return 4_100; },
    }),
    leasePeekIo: () => ({ async listClaims(): Promise<never[]> { return []; } }),
    async connect(): Promise<void> {
      if (only !== undefined && (cfg.auth as { user?: string }).user !== only) {
        throw Object.assign(new Error("authentication failed"), { authenticationFailed: true });
      }
    },
    async close(): Promise<void> {},
    async listFolders(): Promise<string[]> { return ["INBOX", "Sent", "Drafts", "Trash"]; },
    async capabilities() {
      return { move: true, uidplus: true, condstore: true, qresync: false, idle: true, specialUse: true, sentFolder: null };
    },
    async ensureFolders(): Promise<void> {},
    async changesSince(): Promise<ChangeBatch> { return { ...EMPTY_BATCH }; },
    async move() { return { folder: "INBOX", ref: "1:1" }; },
    async setFlags(): Promise<void> {},
    async scanSentRecipients(): Promise<string[]> { return []; },
    async watch(): Promise<() => Promise<void>> { return async () => {}; },
  } as unknown as MailboxAdapter);
}

interface Booted { s: Sidecar; lines: string[]; events: () => string[] }
const sidecars: Sidecar[] = [];
const dirs: string[] = [];
let realRename: typeof fs.renameSync | null = null;
afterEach(async () => {
  if (realRename !== null) { fs.renameSync = realRename; realRename = null; }
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(dataDir: string, over: Record<string, unknown> = {}): Promise<Booted> {
  const lines: string[] = [];
  const logger = createSidecarLogger({ sink: (line) => { lines.push(line); } });
  const s = await createSidecar({
    dataDir, imap: { host: HOST, port: 993, secure: true, auth: { user: USER, pass: PASS } }, address: USER,
    machineName: "this machine", pollIntervalMs: 60 * 60 * 1000, vitalsIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
    keks: KEKS, adapterFactory: server(), log: diagnosticFor(logger), logger, ...over,
  } as never);
  sidecars.push(s);
  return { s, lines, events: () => lines.map((l) => (JSON.parse(l) as { event: string }).event) };
}
const stop = async (s: Sidecar): Promise<void> => {
  await s.stop();
  sidecars.splice(sidecars.indexOf(s), 1);
};

/** A data folder on 2.0 with the copies an update and an earlier start left beside the store. */
async function folderWithCopies(): Promise<string> {
  const dir = await freshDataDir("ohmail-copies-local-");
  dirs.push(dir);
  for (const name of COPIES) {
    mkdirSync(join(dir, name, "pgdata"), { recursive: true });
    // Never read: bytes no store could be, behind a mode nothing may open.
    writeFileSync(join(dir, name, "pgdata", "PG_VERSION"), randomBytes(64), { mode: 0o000 });
  }
  return dir;
}
const standing = (dir: string): string[] => COPIES.filter((n) => existsSync(join(dir, n)));

/** The rename that commits a copy's removal fails, as a folder held open elsewhere fails it. */
function failRemovals(): () => void {
  const real = fs.renameSync;
  realRename = real;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (COPIES.some((n) => String(from).endsWith(n))) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    return real(from, to);
  }) as typeof fs.renameSync;
  return () => { fs.renameSync = real; realRename = null; };
}

const ask = (s: Sidecar, method: string, path: string, body?: unknown): Promise<Response> =>
  s.handle(new Request(`http://local${path}`, {
    method, headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
const sealed = async (s: Sidecar): Promise<number> =>
  Number(((await s.db.execute(sql`select count(*)::int as n from mailbox_credentials`)).rows[0] as { n: number }).n);
async function until(what: string, test: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("signing out of a desktop that organizes on its own", () => {
  it("removes every copy, and nothing the engine said named one", async () => {
    const dir = await folderWithCopies();
    const { s, lines } = await boot(dir);
    await s.start();
    expect(standing(dir), "an ordinary session removed a copy").toEqual(COPIES);
    const health = JSON.stringify(await (await s.handle(new Request("http://local/health"))).json());
    const res = await ask(s, "DELETE", "/local/stored-login");
    expect(res.status).toBe(200);
    expect(standing(dir)).toEqual([]);
    expect(await sealed(s)).toBe(0);
    for (const word of ["set-aside", "store-before", "proven", "store-copies", dir, "@"]) {
      expect(`${health}\n${lines.join("\n")}`, `the engine named ${word}`).not.toContain(word);
    }
  });

  it("is refused whole while a copy cannot be removed: nothing forgotten, no fence raised", async () => {
    const dir = await folderWithCopies();
    const { s, events } = await boot(dir);
    await s.start();
    const held = await sealed(s);
    expect(held).toBeGreaterThan(0);
    const restore = failRemovals();
    const refused = await ask(s, "DELETE", "/local/stored-login");
    restore();
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("store_copy_not_removed");
    expect(await sealed(s), "a password was forgotten by a sign-out that was refused").toBe(held);
    expect(standing(dir)).toEqual(COPIES);
    expect(events()).not.toContain("stored_login_fence_raised");
    // Pressed again once the copy can go: the ordinary sign-out.
    expect((await ask(s, "DELETE", "/local/stored-login")).status).toBe(200);
    expect(standing(dir)).toEqual([]);
    expect(await sealed(s)).toBe(0);
  });
});

describe("removing a mailbox from a desktop that organizes on its own", () => {
  it("removes every copy before the mailbox; while one cannot go the removal is refused with nothing removed", async () => {
    const dir = await folderWithCopies();
    const { s } = await boot(dir);
    await s.start();
    const held = await sealed(s);
    const restore = failRemovals();
    const refused = await ask(s, "DELETE", `/local/mailboxes/${s.world.mailboxId}`);
    restore();
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("local_mirror_not_cleared");
    expect(await sealed(s), "the removal went on over a copy that still holds the mailbox's password").toBe(held);
    expect(standing(dir)).toEqual(COPIES);

    const removed = await ask(s, "DELETE", `/local/mailboxes/${s.world.mailboxId}`);
    expect(removed.status).toBe(200);
    expect(standing(dir)).toEqual([]);
    expect(await sealed(s)).toBe(0);
  });
});

describe("taking a paired device or a pairing code back at the desktop", () => {
  it("removes every copy with it, and is never refused over one", async () => {
    const dir = await folderWithCopies();
    const { s } = await boot(dir, { hostMode: true });
    // A code taken back before anybody used it.
    const code = await (await ask(s, "POST", "/pair", { grant: "device-pair", label: "phone" })).json() as { id: string };
    expect((await ask(s, "DELETE", `/pair/${code.id}`)).status).toBe(204);
    expect(standing(dir)).toEqual([]);

    // A paired device taken back while a copy cannot be removed: the take-back happens, the removal stays owed.
    for (const name of COPIES) mkdirSync(join(dir, name, "pgdata"), { recursive: true });
    const minted = await (await ask(s, "POST", "/pair", { grant: "device-pair", label: "Pixel in the kitchen" })).json() as { token: string };
    const redeemed = await s.handleHost!(new Request("http://local/pair/redeem", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ grant: "device-pair", token: minted.token }),
    }));
    expect(redeemed.status).toBe(200);
    const devices = await (await ask(s, "GET", "/devices")).json() as { items: Array<{ id: string; label: string }> };
    const device = devices.items.find((i) => i.label === "Pixel in the kitchen")!;
    const restore = failRemovals();
    const taken = await ask(s, "DELETE", `/devices/${device.id}`);
    restore();
    expect(taken.status, "a take-back was refused over a copy").toBe(204);
    expect(standing(dir)).toEqual(COPIES);
    expect(existsSync(join(dir, "store-copies.owed")), "nothing says the removal is still owed").toBe(true);
    // The next start finishes it, before the store opens.
    await stop(s);
    await boot(dir, { hostMode: true });
    expect(standing(dir)).toEqual([]);
    expect(existsSync(join(dir, "store-copies.owed"))).toBe(false);
  });
});

describe("a start that finishes a removal an earlier run left", () => {
  it("takes every copy when it removes the password an earlier version's sign-out left", async () => {
    const dir = await folderWithCopies();
    const first = await boot(dir);
    await first.s.start();
    // What an earlier version's sign-out left: the incoming password gone, the outgoing one still stored.
    await first.s.db.execute(sql`update mailbox_credentials set transport = 'smtp' where mailbox_id = ${first.s.world.mailboxId}`);
    await stop(first.s);
    expect(standing(dir)).toEqual(COPIES);
    const { s, events } = await boot(dir, { imap: { host: HOST, port: 993, secure: true, auth: { user: USER } } });
    expect(events()).toContain("signed_out_residue_removed");
    expect(standing(dir)).toEqual([]);
    expect(await sealed(s)).toBe(0);
  });

  it("takes every copy when it takes a removed mailbox's leftover mail off this computer", async () => {
    const dir = await folderWithCopies();
    const first = await boot(dir);
    await first.s.start();
    const mailboxId = first.s.world.mailboxId;
    // A removal cut short: the mailbox is a tombstone with no password, and a letter of it is still here.
    await first.s.db.execute(sql`delete from mailbox_credentials where mailbox_id = ${mailboxId}`);
    await first.s.db.execute(sql`update mailboxes set status = 'disabled', disabled_reason = null where id = ${mailboxId}`);
    await first.s.db.execute(sql`insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, date)
      values (${first.s.world.accountId}, ${mailboxId}, 'h', 'left:1', 'left behind', now())`);
    await stop(first.s);
    const { events } = await boot(dir, { imap: { host: HOST, port: 993, secure: true, auth: { user: "other@example.test", pass: PASS } }, address: "other@example.test" });
    expect(events()).toContain("local_mirror_wipe_finished");
    expect(standing(dir)).toEqual([]);
  });
});

describe("what asks for nothing to be gone", () => {
  it("a new password, a quit and a relaunch leave every copy", async () => {
    const dir = await folderWithCopies();
    const { s } = await boot(dir);
    await s.start();
    const replaced = await ask(s, "PATCH", `/local/mailboxes/${s.world.mailboxId}`, { imap: { host: HOST, port: 993, secure: true, user: USER, pass: "a-new-password" } });
    expect(replaced.status).toBeLessThan(300);
    expect(standing(dir)).toEqual(COPIES);
    await stop(s);
    expect(standing(dir)).toEqual(COPIES);
    // The relaunch takes nothing a person did not ask gone. (The copy from the update leaves here by
    // its own rule: the run before served its mailbox. The folder set aside has no such rule.)
    const again = await boot(dir);
    await again.s.start();
    expect(standing(dir)).toEqual([SET_ASIDE]);
  });
});

describe("a desktop's 1.0 data folder, started by the 2.0 engine", () => {
  /** The 1.0 folder, with or without the second mailbox's login (which names no server, so it can never be served). */
  async function oldFolder(secondLogin: boolean): Promise<string> {
    const dir = await folderAtOldHead("ohmail-copies-local-old-");
    dirs.push(dir);
    if (!secondLogin) {
      const client = new PGlite(join(dir, PGDATA_SUBDIR), { extensions: LOCAL_STORE_EXTENSIONS });
      await client.query(`delete from mailbox_credentials where mailbox_id = $1`, [OLD_STORE.secondMailboxId]);
      await client.close();
    }
    return dir;
  }
  const old = { imap: { host: HOST, port: 993, secure: true, auth: { user: OLD_STORE.address, pass: OLD_STORE.password } }, address: OLD_STORE.address, keks: OLD_STORE.keks };

  it("is copied and moved by the engine itself, and the copy goes at the start after its mailbox was served", async () => {
    const dir = await oldFolder(false);
    const { s, lines } = await boot(dir, old);
    // The engine names the way: the store is 2.0's, and the whole 1.0 store stands beside it.
    const head = Number(((await s.db.execute(sql`select max(created_at)::text as head from "drizzle_mail"."__drizzle_migrations"`)).rows[0] as { head: string }).head);
    expect(head).toBe(NEW_HEAD);
    expect(readdirSync(join(dir, COPY)).sort()).toEqual(["copy.json", "pgdata", "store-generation.json"]);
    expect(JSON.parse(readFileSync(join(dir, COPY, "copy.json"), "utf8"))).toMatchObject({ v: 1 });
    expect(lines.join("\n")).not.toContain(dir);
    // Not served yet: no mark. A cycle served, as a mailbox that only reads serves one: marked.
    expect(existsSync(join(dir, COPY, "proven"))).toBe(false);
    await s.start();
    await until("the copy is marked once its mailbox was served", () => existsSync(join(dir, COPY, "proven")));
    expect(existsSync(join(dir, COPY, "pgdata")), "removed under a running engine").toBe(true);
    await stop(s);
    await boot(dir, old);
    expect(existsSync(join(dir, COPY))).toBe(false);
  });

  it("keeps the copy while a mailbox with a login here has not been served", async () => {
    const dir = await oldFolder(true);
    // The second mailbox's server refuses its login: it holds one here, and no cycle of it is ever served.
    const { s, events } = await boot(dir, { ...old, adapterFactory: server(OLD_STORE.address) });
    await s.start();
    await until("the first mailbox served a cycle", () => events().includes("sync_drain"));
    await new Promise((r) => setTimeout(r, 300));
    expect(existsSync(join(dir, COPY, "proven")), "marked with a mailbox unserved").toBe(false);
    await stop(s);
    await boot(dir, { ...old, adapterFactory: server(OLD_STORE.address) });
    expect(existsSync(join(dir, COPY, "pgdata"))).toBe(true);
  });
});
