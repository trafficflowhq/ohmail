import fs, { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { messages } from "@trafficflow/db/mail";
import type { MessageDTO } from "@trafficflow/services/mail";
import { createCloudSidecar, MIRROR_OWNER_FILE, type CloudSidecar } from "../src/cloud-engine.js";
import { LocalStoreOpenError, PGDATA_SUBDIR, openLocalDb } from "../src/db.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { Disk, imageOfFolder, tellFolderFlushes } from "./_cut-disk.js";
import { freshDataDir } from "./_datadir.js";
import { NEW_HEAD, OLD_HEAD, OLD_STORE, folderAtOldHead, readAsOneOh } from "./_old-head-store.js";

/**
 * A PAIRED DESKTOP'S 1.0 MIRROR IS SET ASIDE, NOT MOVED. Its account's server is the master, so
 * 2.0 fills a new mirror from it. The old one is moved aside whole, its place in the feed first
 * and its store last, into a private folder: a kill at any point leaves no new store beside an
 * old place in the feed. The session, the record of whose mirror this is and the window's queued
 * changes stay where they are. The folder is kept until the new mirror's first window has landed,
 * and goes at the start after that.
 */

const REFILL = /^set-aside-refill-\d{8}T\d{6}Z(-\d+)?$/;
const CURSOR = "cloud-cursor.json";
const MARKS = "cloud-bootstrap-gen.marks";
const OLD_KIND = "set-aside-20250101T000000Z";
const KEKS = { 1: Buffer.alloc(32, 9) };
const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MSG_ONE = "11111111-1111-4111-8111-111111111111";
const iso = (): string => new Date().toISOString();
const send = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
let realRename: typeof fs.renameSync | null = null;
afterEach(async () => {
  if (realRename !== null) { fs.renameSync = realRename; realRename = null; }
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const refills = (dir: string): string[] => readdirSync(dir).filter((n) => REFILL.test(n)).sort();
/** Is `path` a folder a mirror is set aside into, directly in `dir`? */
const refillIn = (dir: string, path: fs.PathLike): boolean => dirname(String(path)) === dir && REFILL.test(basename(String(path)));
const entriesOf = (dir: string): string[] => readdirSync(dir).filter((n) => !n.startsWith("sidecar.")).sort();

/** A store read the way 1.0 reads it, from a copy of its files. */
async function readCopyOf(pgdata: string): Promise<Awaited<ReturnType<typeof readAsOneOh>>> {
  const aside = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-refill-read-"));
  dirs.push(aside);
  cpSync(pgdata, join(aside, PGDATA_SUBDIR), { recursive: true });
  return readAsOneOh(join(aside, PGDATA_SUBDIR));
}

/** A 1.0 mirror's data folder: its store at 1.0.11's head, its place in the feed, the marks of a fill. */
async function oldMirror(): Promise<string> {
  const dir = await folderAtOldHead("ohmail-refill-");
  dirs.push(dir);
  writeFileSync(join(dir, CURSOR), JSON.stringify({ sync: "the old mirror's place" }));
  writeFileSync(join(dir, MARKS), "the old fill's marks\n");
  writeFileSync(join(dir, "store-generation.json"), JSON.stringify({ generation: 7, open: false }));
  return dir;
}

async function headOf(dir: string, way?: "set-aside"): Promise<number> {
  const opened = await openLocalDb(dir, way ? { transition: { way } } : {});
  try {
    const r = await opened.db.execute(sql`select max(created_at)::text as head from "drizzle_mail"."__drizzle_migrations"`);
    return Number((r as unknown as { rows: Array<{ head: string }> }).rows[0]!.head);
  } finally {
    await opened.close();
  }
}

describe("a store on the 1.0 line, opened with set-aside named as the way", () => {
  it("is moved aside whole into a private folder, its place in the feed with it, and a new store is made", async () => {
    const dir = await oldMirror();
    writeFileSync(join(dir, "cloud-tokens.seal"), "a sealed session");
    writeFileSync(join(dir, MIRROR_OWNER_FILE), "the record");
    const lines: string[] = [];
    const opened = await openLocalDb(dir, { transition: { way: "set-aside" }, log: (event, detail) => lines.push(JSON.stringify({ event, ...detail })) });
    // A new run of a new store: no cursor issued for the old mirror is admitted by this one.
    expect(opened.storeGeneration).toBe(8);
    await opened.close();
    const [folder, ...more] = refills(dir);
    expect(more).toEqual([]);
    expect(readdirSync(join(dir, folder!)).sort()).toEqual([MARKS, CURSOR, PGDATA_SUBDIR].sort());
    expect(readFileSync(join(dir, folder!, CURSOR), "utf8")).toBe(JSON.stringify({ sync: "the old mirror's place" }));
    expect(readFileSync(join(dir, folder!, MARKS), "utf8")).toBe("the old fill's marks\n");
    if (process.platform !== "win32") expect(statSync(join(dir, folder!)).mode & 0o777).toBe(0o700);
    // What 1.0 left is what the folder holds; what stays beside the new store is untouched.
    expect(await readCopyOf(join(dir, folder!, PGDATA_SUBDIR))).toMatchObject({ head: OLD_HEAD, words: OLD_STORE.words });
    expect(readFileSync(join(dir, "cloud-tokens.seal"), "utf8")).toBe("a sealed session");
    expect(readFileSync(join(dir, MIRROR_OWNER_FILE), "utf8")).toBe("the record");
    expect(existsSync(join(dir, CURSOR)), "a new store stands beside the old mirror's place in the feed").toBe(false);
    expect(existsSync(join(dir, MARKS))).toBe(false);
    expect(lines.join("\n")).toContain('"kind":"old-line"');
    expect(lines.join("\n")).not.toContain(dir);
    // The new store is this tree's, holds none of the old mail, and the next open sets nothing aside.
    expect(await headOf(dir, "set-aside")).toBe(NEW_HEAD);
    expect(refills(dir)).toEqual([folder]);
  }, 240_000);

  it("after a kill at any step, the next start leaves no new store beside an old place in the feed", async () => {
    // The open itself, with the disk's image taken as it passes each step; the next start is the same call.
    const dir = await oldMirror();
    const disk = new Disk(dir);
    const images: Array<[string, string]> = [];
    const cut = (said: string): void => {
      const image = imageOfFolder(disk, dir);
      dirs.push(image);
      images.push([said, image]);
    };
    disk.install();
    /* The hooks stand on the emulator's own functions, so each image holds what the emulator has seen. */
    const mkdir = fs.mkdirSync;
    const chmod = fs.chmodSync;
    const rename = fs.renameSync;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((path: fs.PathLike, options?: unknown) => {
      if (refillIn(dir, path)) cut("the generation advanced");
      return (mkdir as (...a: unknown[]) => unknown)(path, options);
    }) as never);
    vi.spyOn(fs, "chmodSync").mockImplementation((path, mode) => {
      chmod(path, mode);
      if (refillIn(dir, path)) cut("the folder made");
    });
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (refillIn(dir, dirname(String(to)))) cut(`${basename(String(to))} moved in`);
    });
    try {
      const opened = await openLocalDb(dir, { transition: { way: "set-aside" } });
      await opened.close();
    } finally {
      vi.restoreAllMocks();
      disk.restore();
    }
    for (const [said, image] of images) {
      expect(await headOf(image, "set-aside"), said).toBe(NEW_HEAD);
      // Every piece of the old mirror is in a folder set aside, exactly once, and none stands live.
      const held = refills(image).flatMap((f) => readdirSync(join(image, f)));
      expect(held.sort(), said).toEqual([MARKS, CURSOR, PGDATA_SUBDIR].sort());
      expect(entriesOf(image).filter((n) => n === CURSOR || n === MARKS), said).toEqual([]);
      const withStore = refills(image).find((f) => existsSync(join(image, f, PGDATA_SUBDIR)))!;
      expect((await readCopyOf(join(image, withStore, PGDATA_SUBDIR))).head, said).toBe(OLD_HEAD);
    }
    // The steps the open took, in the order it took them: the store is the last to move.
    expect(images.map(([said]) => said)).toEqual([
      "the generation advanced", "the folder made", `${CURSOR} moved in`, `${MARKS} moved in`, `${PGDATA_SUBDIR} moved in`,
    ]);
  }, 600_000);

  // Windows cannot open a folder to flush it; there each rename stands alone.
  it.skipIf(process.platform === "win32")("has the place in the feed and the marks flushed into their folder before the store follows", async () => {
    const dir = await oldMirror();
    const said: string[] = [];
    const undo = tellFolderFlushes(
      (path) => (path === dir ? "the data folder" : refillIn(dir, path) ? "the folder" : null),
      (what) => said.push(what),
    );
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      rename(from, to);
      if (refillIn(dir, dirname(String(to)))) said.push(`${basename(String(to))} moved in`);
    });
    try {
      const opened = await openLocalDb(dir, { transition: { way: "set-aside" } });
      await opened.close();
    } finally {
      vi.restoreAllMocks();
      undo();
    }
    // A disk that keeps no order between two renames must not keep the store's move and lose the place's.
    const flushed = ["the folder flushed", "the data folder flushed"];
    expect(said.slice(said.indexOf(`${CURSOR} moved in`), said.indexOf(`${PGDATA_SUBDIR} moved in`) + 3)).toEqual([
      `${CURSOR} moved in`, `${MARKS} moved in`, ...flushed, `${PGDATA_SUBDIR} moved in`, ...flushed,
    ]);
  }, 240_000);

  it("a move that fails fails the start, with the old mirror back as it stood", async () => {
    const dir = await oldMirror();
    const real = fs.renameSync;
    realRename = real;
    fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from).endsWith(PGDATA_SUBDIR)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      return real(from, to);
    }) as typeof fs.renameSync;
    const failed: unknown = await openLocalDb(dir, { transition: { way: "set-aside" } }).then(() => "OPENED", (err: unknown) => err);
    fs.renameSync = real;
    realRename = null;
    expect(failed).toBeInstanceOf(LocalStoreOpenError);
    expect(refills(dir)).toEqual([]);
    expect(readFileSync(join(dir, CURSOR), "utf8")).toBe(JSON.stringify({ sync: "the old mirror's place" }));
    expect(readFileSync(join(dir, MARKS), "utf8")).toBe("the old fill's marks\n");
    expect((await readAsOneOh(join(dir, PGDATA_SUBDIR))).head).toBe(OLD_HEAD);
    // The start after it does the whole of it.
    expect(await headOf(dir, "set-aside")).toBe(NEW_HEAD);
    expect(refills(dir)).toHaveLength(1);
  }, 240_000);
});

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

/** The account's server: one mailbox, one letter in its opening window, and every path it was asked. */
function hostedApi() {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")]));
    if (url.pathname === "/sync/snapshot") {
      return send({
        asOfSeq: 1, nextCursor: null, window: { days: 90, minRows: 5000 },
        changes: [{ type: "message", op: "create", id: MSG_ONE, seq: 1, updatedAt: iso(), entity: messageDTO(MSG_ONE) }],
      });
    }
    if (url.pathname === "/sync") {
      return send({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c1", hasMore: false, serverTime: iso() });
    }
    if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
    if (url.pathname === "/auth/refresh") return send({ tokens: { accessToken: "a2", refreshToken: "r2", expiresIn: 900 } });
    if (url.pathname === "/consent") return send({ settings: {} });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, asked };
}

async function until(what: string, test: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("a paired desktop on 1.0, started on 2.0", () => {
  const boot = async (dataDir: string, api: ReturnType<typeof hostedApi>, tokens: boolean): Promise<CloudSidecar> => {
    const sidecar = await createCloudSidecar({
      dataDir, cloudUrl: "https://cloud.test", address: "me@ohmail.test",
      ...(tokens ? { tokens: { accessToken: "a", refreshToken: "r" } } : {}),
      keks: KEKS, fetchImpl: api.fetchImpl, pollIntervalMs: 40,
    });
    sidecars.push(sidecar);
    return sidecar;
  };
  const stop = async (s: CloudSidecar): Promise<void> => {
    await s.stop();
    sidecars.splice(sidecars.indexOf(s), 1);
  };
  const letters = async (s: CloudSidecar): Promise<number> =>
    Number((await s.db.select({ n: sql<number>`count(*)::int` }).from(messages))[0]!.n);

  it("keeps its session, fills a new mirror from zero, and the old one goes at the start after the first window", async () => {
    // A paired desktop that signed in once: its seal, its record and its marker are the engine's own.
    const dataDir = await freshDataDir("ohmail-refill-door-");
    dirs.push(dataDir);
    const api = hostedApi();
    await stop(await boot(dataDir, api, true));
    // …whose store is 1.0's, with the place in the feed 1.0 left, a queued change of the window, and a folder of an older kind.
    rmSync(join(dataDir, PGDATA_SUBDIR), { recursive: true, force: true });
    const old = await folderAtOldHead("ohmail-refill-door-old-");
    dirs.push(old);
    cpSync(join(old, PGDATA_SUBDIR), join(dataDir, PGDATA_SUBDIR), { recursive: true });
    writeFileSync(join(dataDir, CURSOR), JSON.stringify({ sync: "the old mirror's place" }));
    writeFileSync(join(dataDir, MARKS), "the old fill's marks\n");
    mkdirSync(join(dataDir, OLD_KIND, PGDATA_SUBDIR), { recursive: true });
    const stays = entriesOf(dataDir).filter((n) => ![PGDATA_SUBDIR, CURSOR, MARKS, "store-generation.json"].includes(n));
    expect(stays).toEqual(expect.arrayContaining(["cloud-tokens.seal", MIRROR_OWNER_FILE, OLD_KIND]));
    const before = Object.fromEntries(stays.filter((n) => statSync(join(dataDir, n)).isFile()).map((n) => [n, readFileSync(join(dataDir, n), "latin1")]));
    const generationBefore = (JSON.parse(readFileSync(join(dataDir, "store-generation.json"), "utf8")) as { generation: number }).generation;
    api.asked.length = 0;

    // The first start of 2.0: no token handed, so the session is the sealed one.
    const first = await boot(dataDir, api, false);
    const [folder, ...more] = refills(dataDir);
    expect(more).toEqual([]);
    expect(readdirSync(join(dataDir, folder!)).sort()).toEqual([MARKS, CURSOR, PGDATA_SUBDIR].sort());
    expect(readFileSync(join(dataDir, folder!, CURSOR), "utf8")).toBe(JSON.stringify({ sync: "the old mirror's place" }));
    expect(Object.fromEntries(Object.keys(before).map((n) => [n, readFileSync(join(dataDir, n), "latin1")])), "a file that stays was rewritten").toEqual(before);
    expect((JSON.parse(readFileSync(join(dataDir, "store-generation.json"), "utf8")) as { generation: number }).generation).toBe(generationBefore + 1);
    expect(await letters(first)).toBe(0);
    await first.start();
    const health = await (await first.handle(new Request("http://sidecar/health"))).json() as { signedIn: boolean };
    expect(health.signedIn, "the session did not resume from its seal").toBe(true);
    // The new mirror asks for the account from the start, and the old one is marked once its first window landed.
    await until("the first window landed", async () => (await letters(first)) === 1);
    expect(api.asked.some((p) => p.startsWith("/sync/snapshot"))).toBe(true);
    await until("the old mirror is marked as done with", () => existsSync(join(dataDir, folder!, "proven")));
    expect(existsSync(join(dataDir, folder!, PGDATA_SUBDIR)), "removed under a running engine").toBe(true);
    await stop(first);

    // The start after it: the old mirror is gone, the folder of an older kind stays, the mail is there.
    const second = await boot(dataDir, api, false);
    expect(refills(dataDir)).toEqual([]);
    expect(existsSync(join(dataDir, OLD_KIND))).toBe(true);
    expect(await letters(second)).toBe(1);
  }, 240_000);
});
