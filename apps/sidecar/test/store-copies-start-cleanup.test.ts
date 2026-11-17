import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountOfMailbox, mailboxCredentials } from "@trafficflow/db";
import { openLocalDb, type LocalDb } from "../src/db.js";
import { settleFirstDoorAttempt } from "../src/first-door.js";
import { ensureLocalWorld } from "../src/identity.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * A START THAT REMOVES A PASSWORD REMOVES THE COPIES THAT STILL HOLD IT. A first mailbox set up
 * and never saved is undone by the next start: its password, or the mailbox it added, goes. A
 * copy of the store kept from before an update may hold that same password, sealed, with the key
 * beside it, so every copy goes too. A start that undoes nothing touches no copy.
 */

const COPY = "store-before-2.0";
const SET_ASIDE = "set-aside-20260926T101323Z";
const AT = new Date("2026-11-17T10:00:00.000Z");
const X = "mila@trafficflow.test";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0)) await close(); });

async function store(): Promise<{ dir: string; db: LocalDb }> {
  const dir = await freshDataDir("ohmail-copies-start-");
  const opened = await openLocalDb(dir);
  closers.push(async () => {
    await opened.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  for (const name of [COPY, SET_ASIDE]) {
    mkdirSync(join(dir, name, "pgdata"), { recursive: true });
    writeFileSync(join(dir, name, "pgdata", "held"), "a store's bytes");
  }
  return { dir, db: opened.db };
}

/** One engine start's first step, as the engine orders it: the attempt settled, then the world found. */
async function start(s: { dir: string; db: LocalDb }, how: "pending" | "save" | "other"): Promise<string> {
  await settleFirstDoorAttempt(s.db, {
    dataDir: s.dir, address: X, pending: how === "pending", save: how === "save", now: AT, log: () => undefined,
  });
  return (await ensureLocalWorld(s.db, { address: X, now: AT })).mailboxId;
}

async function seal(db: LocalDb, mailboxId: string): Promise<void> {
  await db.insert(mailboxCredentials).values({
    mailboxId, accountId: accountOfMailbox(mailboxId), transport: "imap", secretEnc: "not-a-secret", keyVersion: 1,
    meta: { host: "imap.trafficflow.test", port: 993, secure: true, user: X }, updatedAt: AT,
  });
}

const standing = (dir: string): string[] => [COPY, SET_ASIDE].filter((n) => existsSync(join(dir, n)));

describe("an unsaved first mailbox, undone by the next start", () => {
  it("takes every copy of the store with the password it removes", async () => {
    const s = await store();
    await seal(s.db, await start(s, "pending"));
    expect(standing(s.dir), "the attempt itself removed a copy").toEqual([COPY, SET_ASIDE]);
    await start(s, "other");
    expect(standing(s.dir)).toEqual([]);
    expect(existsSync(join(s.dir, "store-copies.owed"))).toBe(false);
  });

  it("leaves every copy when the door was saved, and when there was nothing to undo", async () => {
    const saved = await store();
    await seal(saved.db, await start(saved, "pending"));
    await start(saved, "save");
    expect(standing(saved.dir)).toEqual([COPY, SET_ASIDE]);

    const plain = await store();
    await start(plain, "other");
    await start(plain, "other");
    expect(standing(plain.dir)).toEqual([COPY, SET_ASIDE]);
  });
});
