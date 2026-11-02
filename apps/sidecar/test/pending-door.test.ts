import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mailboxCredentials, mailboxFolders, mailboxes, outboundSends, outboundSentCopies } from "@trafficflow/db";
import { createAdoptedDoor, DoorFileError } from "../src/adopted-door.js";
import { enforceMirrorOwner, MIRROR_OWNER_FILE, readMirrorOwner } from "../src/cloud-engine.js";
import { openLocalDb, type LocalDb } from "../src/db.js";
import { FIRST_DOOR_ATTEMPT_FILE, settleFirstDoorAttempt } from "../src/first-door.js";
import { ensureLocalWorld } from "../src/identity.js";
import { cloudConfigFromEnv, configFromEnv } from "../src/main.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS });

/**
 * THE PENDING DOOR'S THREE PIECES THAT NEED NO ENGINE: the environment that says "identity
 * pending" rather than an empty address, the door file its first claim CREATES once, and the
 * mirror-owner record a pending launch must not wipe. The engine-level walk is
 * `slow/cloud-approval-adopt.test.ts`. And the first LOCAL door's record, over a real local store
 * with fake encrypted values; its engine walk is `first-connect-seal.imap.test.ts`.
 */

const HOSTED = "https://api.ohmail.app";
const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-pending-door-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { chmodSync(d, 0o700); } catch { /* already writable */ }
    rmSync(d, { recursive: true, force: true });
  }
});

describe("the door file a pending claim creates", () => {
  it("is created once, private, in the shape the shell reads, with no staging file left", () => {
    const dir = tempDir();
    const door = join(dir, "config.json");
    expect(createAdoptedDoor(door, HOSTED, "mila@ohmail.test")).toBe("created");
    expect(JSON.parse(readFileSync(door, "utf8"))).toEqual({ mode: "cloud", cloudUrl: HOSTED, address: "mila@ohmail.test" });
    if (process.platform !== "win32") expect(statSync(door).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["config.json"]);
    // A retried claim for the same account finds its own door and is not refused.
    expect(createAdoptedDoor(door, HOSTED, "  Mila@ohmail.test ")).toBe("same");
  });

  it("never replaces a door somebody chose during the wait, readable or not", () => {
    for (const other of [
      JSON.stringify({ mode: "local", imap: { host: "imap.example.test", user: "someone" } }),
      JSON.stringify({ mode: "cloud", cloudUrl: HOSTED, address: "other@ohmail.test" }),
      "{ torn",
    ]) {
      const dir = tempDir();
      const door = join(dir, "config.json");
      writeFileSync(door, other);
      let caught: unknown = null;
      try { createAdoptedDoor(door, HOSTED, "mila@ohmail.test"); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(DoorFileError);
      expect((caught as DoorFileError).code).toBe("door_changed");
      expect(readFileSync(door, "utf8")).toBe(other);
      expect(readdirSync(dir)).toEqual(["config.json"]);
    }
  });

  it("says it could not save, by code, when the folder refuses the write", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const dir = tempDir();
    chmodSync(dir, 0o500);
    let caught: unknown = null;
    try { createAdoptedDoor(join(dir, "config.json"), HOSTED, "mila@ohmail.test"); } catch (err) { caught = err; }
    expect((caught as DoorFileError).code).toBe("door_not_saved");
    expect((caught as DoorFileError).message).not.toContain(dir);
  });
});

describe("a pending launch keeps the mirror owner it finds", () => {
  function owned(dir: string, owner: string, base = HOSTED): void {
    mkdirSync(join(dir, "pgdata"), { recursive: true });
    writeFileSync(join(dir, "pgdata", "PG_VERSION"), "17\n");
    writeFileSync(join(dir, MIRROR_OWNER_FILE), JSON.stringify({ address: owner, base, account: null }));
  }

  it("a directory another account owns still names that account after a pending launch", () => {
    const dir = tempDir();
    owned(dir, "first@ohmail.test");
    expect(enforceMirrorOwner(dir, null, HOSTED, undefined, { identityPending: true })).toBe(false);
    expect(existsSync(join(dir, "pgdata"))).toBe(true);
    // The claim compares against this: a record rewritten as nobody's would be ADOPTED by B.
    expect(readMirrorOwner(dir)).toBe("first@ohmail.test");
  });

  it("the control: an address-less launch that is NOT pending (the paired door) names nobody", () => {
    const dir = tempDir();
    owned(dir, "first@ohmail.test");
    enforceMirrorOwner(dir, null, HOSTED);
    expect(readMirrorOwner(dir)).toBeNull();
  });

  it("a mirror from another server is discarded and the pending record names nobody", () => {
    const dir = tempDir();
    owned(dir, "first@example.com", "https://ohmail.example.com/api");
    expect(enforceMirrorOwner(dir, null, HOSTED, undefined, { identityPending: true })).toBe(true);
    expect(existsSync(join(dir, "pgdata"))).toBe(false);
    expect(readMirrorOwner(dir)).toBeNull();
  });
});

describe("the environment says identity pending, never an empty address", () => {
  const base = {
    OHMAIL_MODE: "cloud", OHMAIL_DATA_DIR: "/tmp/does-not-need-to-exist", OHMAIL_CLOUD_URL: HOSTED,
  };

  it("the pending door carries no address and its door file", () => {
    const cfg = cloudConfigFromEnv({ ...base, OHMAIL_IDENTITY_PENDING: "1", OHMAIL_DOOR_FILE: "/tmp/x/config.json" });
    expect(cfg.address).toBeNull();
    expect(cfg.identityPending).toEqual({ doorFile: "/tmp/x/config.json" });
  });

  it("a flag beside an address or a pin, or without its door file, refuses to launch", () => {
    const pending = { ...base, OHMAIL_IDENTITY_PENDING: "1", OHMAIL_DOOR_FILE: "/tmp/x/config.json" };
    expect(() => cloudConfigFromEnv({ ...pending, OHMAIL_MAILBOX_ADDRESS: "mila@ohmail.test" })).toThrow(/stale/);
    expect(() => cloudConfigFromEnv({ ...pending, OHMAIL_HOST_PIN: "A".repeat(43) })).toThrow(/stale/);
    expect(() => cloudConfigFromEnv({ ...base, OHMAIL_IDENTITY_PENDING: "1" })).toThrow(/OHMAIL_DOOR_FILE/);
  });

  it("only the exact flag is the pending door: a near miss is an ordinary door and wants its address", () => {
    const saved = process.env.OHMAIL_MAILBOX_ADDRESS;
    delete process.env.OHMAIL_MAILBOX_ADDRESS;
    try {
      for (const nearMiss of ["true", "yes", "0", " 1"]) {
        expect(() => cloudConfigFromEnv({ ...base, OHMAIL_IDENTITY_PENDING: nearMiss, OHMAIL_DOOR_FILE: "/tmp/x" }))
          .toThrow(/OHMAIL_MAILBOX_ADDRESS/);
      }
      const hosted = cloudConfigFromEnv({ ...base, OHMAIL_MAILBOX_ADDRESS: "mila@ohmail.test" });
      expect(hosted.identityPending).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env.OHMAIL_MAILBOX_ADDRESS = saved;
    }
  });
});

describe("the shell's unsaved first local door reaches the engine as one exact flag", () => {
  const local = {
    OHMAIL_DATA_DIR: "/tmp/does-not-need-to-exist", OHMAIL_IMAP_HOST: "imap.trafficflow.test",
    OHMAIL_IMAP_USER: "mila@trafficflow.test",
  };

  it("only `1` marks the start as a first door nobody saved, or as the shell's save of it", () => {
    expect(configFromEnv({ ...local, OHMAIL_DOOR_PENDING: "1" }).doorPending).toBe(true);
    expect(configFromEnv({ ...local, OHMAIL_DOOR_SAVE: "1" }).doorSave).toBe(true);
    for (const nearMiss of ["true", "yes", "0", " 1", "1 ", ""]) {
      expect(configFromEnv({ ...local, OHMAIL_DOOR_PENDING: nearMiss }).doorPending, nearMiss).toBeUndefined();
      expect(configFromEnv({ ...local, OHMAIL_DOOR_SAVE: nearMiss }).doorSave, nearMiss).toBeUndefined();
    }
    expect(configFromEnv(local).doorPending).toBeUndefined();
    expect(configFromEnv(local).doorSave).toBeUndefined();
  });
});

describe("a first local door nobody saved is kept or undone by the next start", () => {
  const X = "Mila@TrafficFlow.test";
  const x = "mila@trafficflow.test";
  const Y = "otto@trafficflow.test";
  const HAD_AT = new Date("2026-10-30T08:00:00.000Z");
  const SEALED_AT = new Date("2026-11-01T09:00:00.000Z");
  const NEXT_AT = new Date("2026-11-01T10:00:00.000Z");
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of closers.splice(0)) await close();
  });
  const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];

  async function store(): Promise<{ dir: string; db: LocalDb; close: () => Promise<void> }> {
    const dir = await freshDataDir("ohmail-first-door-attempt-");
    const opened = await openLocalDb(dir);
    const close = (): Promise<void> => opened.close().catch(() => undefined);
    closers.push(async () => {
      await close();
      try { chmodSync(dir, 0o700); } catch { /* already writable */ }
      rmSync(dir, { recursive: true, force: true });
    });
    return { dir, db: opened.db, close };
  }
  /**
   * One engine start: the attempt settled, then the world found, as `createSidecar` orders them.
   * `save` is the shell's save of its own pending door; `other` is any other start (a relaunch, a
   * door switched from Settings).
   */
  async function start(s: { dir: string; db: LocalDb }, address: string, how: "pending" | "save" | "other") {
    await settleFirstDoorAttempt(s.db, {
      dataDir: s.dir, address, pending: how === "pending", save: how === "save", now: NEXT_AT,
      log: (event, detail) => { lines.push({ event, detail }); },
    });
    return ensureLocalWorld(s.db, { address, now: NEXT_AT });
  }
  /** The window's seal: both transports, a fake encrypted value, never a password. */
  async function seal(db: LocalDb, mailboxId: string, at: Date): Promise<void> {
    for (const transport of ["imap", "smtp"]) {
      const meta = { host: `${transport}.trafficflow.test`, port: transport === "imap" ? 993 : 465, secure: true, user: x };
      await db.insert(mailboxCredentials)
        .values({ mailboxId, transport, secretEnc: "not-a-secret", keyVersion: 1, meta, updatedAt: at })
        .onConflictDoUpdate({
          target: [mailboxCredentials.mailboxId, mailboxCredentials.transport],
          set: { secretEnc: "not-a-secret", updatedAt: at },
        });
    }
  }
  const addresses = async (db: LocalDb): Promise<string[]> =>
    (await db.select({ address: mailboxes.address }).from(mailboxes)).map((r) => r.address).sort();
  const held = async (db: LocalDb, mailboxId: string): Promise<string[]> =>
    (await db.select({ t: mailboxCredentials.transport }).from(mailboxCredentials)
      .where(eq(mailboxCredentials.mailboxId, mailboxId))).map((r) => r.t).sort();
  const record = (dir: string): unknown => {
    const file = join(dir, FIRST_DOOR_ATTEMPT_FILE);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
  };

  it("the shell's save of the same address keeps the row and its password and drops the record", async () => {
    const s = await store();
    const attempt = await start(s, X, "pending");
    await seal(s.db, attempt.mailboxId, SEALED_AT);
    expect(record(s.dir)).toEqual({ v: 1, address: x, created: true, kept: null });
    if (process.platform !== "win32") expect(statSync(join(s.dir, FIRST_DOOR_ATTEMPT_FILE)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(s.dir, FIRST_DOOR_ATTEMPT_FILE), "utf8")).not.toContain("not-a-secret");
    const saved = await start(s, ` ${x.toUpperCase()} `, "save");
    expect(saved.mailboxId).toBe(attempt.mailboxId);
    expect(await held(s.db, attempt.mailboxId)).toEqual(["imap", "smtp"]);
    expect(record(s.dir)).toBeNull();
  });

  it("any other start for the same address, a relaunch or a door switched from Settings, drops the password", async () => {
    const s = await store();
    const attempt = await start(s, X, "pending");
    await seal(s.db, attempt.mailboxId, SEALED_AT);
    const other = await start(s, X, "other");
    expect(other.mailboxId).toBe(attempt.mailboxId);
    expect(await held(s.db, attempt.mailboxId), "kept by a start that was not the door's save").toEqual([]);
    expect(record(s.dir)).toBeNull();
  });

  it("a start for another address, its save, any other start or another first door, removes the row the attempt made", async () => {
    for (const how of ["other", "save", "pending"] as const) {
      const s = await store();
      const attempt = await start(s, X, "pending");
      await seal(s.db, attempt.mailboxId, SEALED_AT);
      await start(s, Y, how);
      expect(await addresses(s.db), how).toEqual([Y]);
      expect(await held(s.db, attempt.mailboxId), how).toEqual([]);
      expect(record(s.dir), how).toEqual(how === "pending" ? { v: 1, address: Y, created: true, kept: null } : null);
    }
  });

  it("a refused attempt leaves no bare row behind the next address", async () => {
    const s = await store();
    await start(s, X, "pending");
    await start(s, Y, "pending");
    expect(await addresses(s.db)).toEqual([Y]);
  });

  it("the same address started again drops its password and reuses the bare row, still the attempt's", async () => {
    const s = await store();
    const attempt = await start(s, X, "pending");
    await seal(s.db, attempt.mailboxId, SEALED_AT);
    const again = await start(s, X, "pending");
    expect(again.mailboxId).toBe(attempt.mailboxId);
    expect(await held(s.db, attempt.mailboxId)).toEqual([]);
    expect(record(s.dir)).toEqual({ v: 1, address: x, created: true, kept: null });
    await start(s, Y, "pending");
    expect(await addresses(s.db)).toEqual([Y]);
  });

  it("a row the attempt made that holds mail, a folder or an unsent copy keeps it: only the passwords go", async () => {
    for (const holds of ["folder", "copy"] as const) {
      const s = await store();
      const attempt = await start(s, X, "pending");
      await seal(s.db, attempt.mailboxId, SEALED_AT);
      if (holds === "folder") {
        await s.db.insert(mailboxFolders).values({ mailboxId: attempt.mailboxId, folder: "INBOX" });
      } else {
        const [send] = await s.db.insert(outboundSends).values({
          accountId: attempt.accountId, idempotencyKey: "first-door", mintedMessageId: "<first-door@trafficflow.test>",
        }).returning({ id: outboundSends.id });
        await s.db.insert(outboundSentCopies).values({
          sendId: send!.id, accountId: attempt.accountId, mailboxId: attempt.mailboxId, rawB64: "AA==",
        });
      }
      await start(s, Y, "pending");
      expect(await addresses(s.db), holds).toEqual([X, Y].sort());
      expect(await held(s.db, attempt.mailboxId), holds).toEqual([]);
    }
  });

  it("a row the install already had loses a password the attempt saved or replaced, and keeps its server", async () => {
    for (const before of ["none", "replaced", "untouched"] as const) {
      const s = await store();
      const had = await start(s, X, "other");
      if (before !== "none") await seal(s.db, had.mailboxId, HAD_AT);
      await start(s, X, "pending");
      expect(record(s.dir)).toEqual({ v: 1, address: x, created: false, kept: before === "none" ? null : HAD_AT.toISOString() });
      if (before !== "untouched") await seal(s.db, had.mailboxId, SEALED_AT);
      await start(s, Y, "pending");
      expect(await addresses(s.db), before).toEqual([X, Y].sort());
      const [row] = await s.db.select({ at: mailboxes.signedOutAt, kept: mailboxes.signedOutMeta })
        .from(mailboxes).where(eq(mailboxes.id, had.mailboxId));
      if (before === "untouched") {
        expect(await held(s.db, had.mailboxId)).toEqual(["imap", "smtp"]);
        expect(row!.at).toBeNull();
        continue;
      }
      expect(await held(s.db, had.mailboxId), before).toEqual([]);
      expect(row!.at?.toISOString(), before).toBe(NEXT_AT.toISOString());
      expect(row!.kept, before).toEqual({
        imap: { host: "imap.trafficflow.test", port: 993, secure: true, user: x },
        smtp: { host: "smtp.trafficflow.test", port: 465, secure: true, user: x },
      });
    }
  });

  it("says what it undid by mailbox and verdict, never by address or path", async () => {
    lines.length = 0;
    const s = await store();
    const attempt = await start(s, X, "pending");
    await start(s, X, "pending");
    expect(lines, "a retry over a refused attempt undid nothing and said it did").toEqual([]);
    await seal(s.db, attempt.mailboxId, SEALED_AT);
    await start(s, Y, "pending");
    expect(lines.map((l) => [l.event, l.detail.verdict])).toEqual([["first_door_attempt_undone", "removed"]]);
    for (const l of lines) {
      expect(Object.keys(l.detail).sort()).toEqual(["mailboxId", "reason", "verdict"]);
      expect(JSON.stringify(l)).not.toMatch(/trafficflow\.test|ohmail-first-door-attempt-/);
    }
  });

  it("an unreadable record is removed and the start goes on", async () => {
    const s = await store();
    writeFileSync(join(s.dir, FIRST_DOOR_ATTEMPT_FILE), "{ torn");
    await start(s, X, "other");
    expect(record(s.dir)).toBeNull();
    writeFileSync(join(s.dir, FIRST_DOOR_ATTEMPT_FILE), JSON.stringify({ v: 2 }));
    await start(s, X, "pending");
    expect(record(s.dir)).toEqual({ v: 1, address: x, created: false, kept: null });
  });

  it("a record that cannot be written, or an undo the store refuses, fails the start and keeps the record", async () => {
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const ro = await store();
      chmodSync(ro.dir, 0o500);
      await expect(start(ro, X, "pending")).rejects.toThrow();
      chmodSync(ro.dir, 0o700);
    }
    const s = await store();
    const attempt = await start(s, X, "pending");
    await seal(s.db, attempt.mailboxId, SEALED_AT);
    await s.close();
    await expect(settleFirstDoorAttempt(s.db, {
      dataDir: s.dir, address: Y, pending: true, save: false, now: NEXT_AT, log: () => undefined,
    })).rejects.toThrow();
    expect(record(s.dir)).toEqual({ v: 1, address: x, created: true, kept: null });
  });
});
