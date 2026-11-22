import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTBOX_ABANDONED_TYPE, OUTBOX_TYPE } from "@ohmail/client-engine";
import { CALENDAR_OUTBOX_TYPE } from "@ohmail/client-engine/calendar-writes";
import { enforceMirrorOwner, MIRROR_OWNER_FILE } from "../src/cloud-engine.js";
import {
  createWindowOutbox, LEGACY_WINDOW_OUTBOX_FILE, UNOWNED_WINDOW_OUTBOX_FILE, WINDOW_OUTBOX_ROUTE, WINDOW_OUTBOX_TYPES,
  windowOutboxFilesOf, windowOutboxOwnerKey, type WindowOutboxDeps, type WindowOutboxOwner,
} from "../src/window-outbox.js";

/**
 * `GET|POST /local/window/outbox` — the window's queued changes on this machine
 * (DESKTOP-OUTBOX-IS-NOT-DURABLE). Driven on a real directory: what the next launch reads is what
 * is on disk, so every durability claim here is read back through a FRESH door.
 */

/**
 * The real write's file-system calls, in order, recorded only while a case arms them — every
 * other case runs the calls unwrapped. `dirSyncFault` makes the directory's flush refuse.
 */
const fsCalls: string[] = [];
let recording = false;
let dirSyncFault: string | null = null;
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (!recording) return handle;
      const label = `${String(args[1])} ${String(args[0])}`;
      fsCalls.push(`open ${label}`);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      handle.sync = async () => {
        fsCalls.push(`sync ${label}`);
        if (dirSyncFault !== null && args[1] === "r") {
          throw Object.assign(new Error("the test refused this flush"), { code: dirSyncFault });
        }
        return sync();
      };
      handle.close = async () => { fsCalls.push(`close ${label}`); return close(); };
      return handle;
    },
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (recording) fsCalls.push(`rename ${String(args[0])} ${String(args[1])}`);
      return actual.rename(...args);
    },
  };
});

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-window-outbox-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  recording = false;
  dirSyncFault = null;
  fsCalls.length = 0;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Line = { event: string; fields: Record<string, unknown> };
const SERVED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MANAGED = "https://api.ohmail.app";
/** The account and server a case's door keeps changes for, unless it names another. */
const OWNER_A: WindowOutboxOwner = { address: "first@account.example", base: MANAGED };
const OWNER_B: WindowOutboxOwner = { address: "second@account.example", base: MANAGED };
const filesOf = (owner: WindowOutboxOwner): readonly string[] => windowOutboxFilesOf(windowOutboxOwnerKey(owner));
const FILES_A = filesOf(OWNER_A);
const FILE_A = FILES_A[0]!;
function door(dir: string, over: Partial<WindowOutboxDeps> = {}) {
  const lines: Line[] = [];
  const d = createWindowOutbox({
    dataDir: dir, owner: OWNER_A, authorized: async () => true, scope: () => SERVED,
    log: (event, fields) => { lines.push({ event, fields }); }, ...over,
  });
  const at = `http://sidecar${WINDOW_OUTBOX_ROUTE}?scope=${SERVED}`;
  const post = (body: unknown) => d.handle(new Request(at, {
    method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  const get = async (after?: string) => {
    const res = await d.handle(new Request(`${at}${after ? `&after=${encodeURIComponent(after)}` : ""}`));
    return { status: res.status, body: (await res.json()) as { rows: Array<{ type: string; id: string; entity: unknown }>; next: string | null } };
  };
  const all = async () => {
    const rows: Array<{ type: string; id: string; entity: unknown }> = [];
    let after: string | undefined;
    for (;;) {
      const page = await get(after);
      rows.push(...page.body.rows);
      if (page.body.next === null) return rows;
      after = page.body.next;
    }
  };
  return { lines, post, get, all, count: (applied?: (key: string) => boolean) => d.count(applied), discard: () => d.discard() };
}

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "outbox_entry", id, entity: { v: 3, id, key: `k-${id}`, n: 1, at: 1, mutation: { kind: "mark_seen" }, ...extra },
});

describe("the window's outbox door", () => {
  it("keeps a pending calendar change for its hosted account across a relaunch", async () => {
    const dir = tempDir();
    const row = { type: CALENDAR_OUTBOX_TYPE, id: "calendar-press", entity: { key: "calendar-press" } };
    const hosted = { calendar: true };
    expect((await door(dir).post({ puts: [row] })).status).toBe(400);
    expect((await door(dir, hosted).post({ puts: [row] })).status).toBe(204);
    const reopened = door(dir, hosted);
    expect(await reopened.all()).toEqual([row]);
    expect(await reopened.count()).toBe(1);
    expect(await reopened.count((key) => key === row.id)).toBe(0);
    expect(await door(dir, { ...hosted, owner: OWNER_B }).all()).toEqual([]);
    expect((await reopened.post({ deletes: [row] })).status).toBe(204);
    expect(await door(dir, hosted).all()).toEqual([]);
  });

  it("spells the engine's own two outbox types", () => {
    expect([...WINDOW_OUTBOX_TYPES].sort()).toEqual([OUTBOX_TYPE, OUTBOX_ABANDONED_TYPE].sort());
  });

  it("a recorded change is on disk, private, and read back by the next launch's door", async () => {
    const dir = tempDir();
    expect((await door(dir).post({ puts: [entry("a"), entry("b")] })).status).toBe(204);
    expect(statSync(join(dir, FILE_A)).mode & 0o777).toBe(0o600);
    const next = door(dir);
    expect((await next.all()).map((r) => r.id).sort()).toEqual(["a", "b"]);
  });

  it("one write applies its puts and then its deletes, as the engine's commit does", async () => {
    const dir = tempDir();
    const d = door(dir);
    await d.post({ puts: [entry("a"), entry("b")] });
    // The abandon transition: one row in, the other out, in one write.
    await d.post({
      puts: [{ type: "outbox_abandoned", id: "a", entity: { v: 3, id: "a" } }, entry("c")],
      deletes: [{ type: "outbox_entry", id: "a" }, { type: "outbox_entry", id: "c" }],
    });
    const rows = await door(dir).all();
    expect(rows.map((r) => `${r.type}:${r.id}`).sort()).toEqual(["outbox_abandoned:a", "outbox_entry:b"]);
  });

  it("an accepted write logs how many changes the outbox now holds, and nothing of them", async () => {
    const d = door(tempDir());
    await d.post({ puts: [entry("a"), entry("b")] });
    await d.post({ deletes: [{ type: "outbox_entry", id: "a" }] });
    expect(d.lines.filter((l) => l.event === "window_outbox_recorded").map((l) => l.fields))
      .toEqual([{ count: 2 }, { count: 1 }]);
  });

  it("an emptied outbox leaves no file behind", async () => {
    const dir = tempDir();
    const d = door(dir);
    await d.post({ puts: [entry("a")] });
    await d.post({ deletes: [{ type: "outbox_entry", id: "a" }] });
    expect(existsSync(join(dir, FILE_A))).toBe(false);
    expect((await door(dir).get()).body).toEqual({ rows: [], next: null });
  });

  it("a refused write changes nothing, on disk or in what the door answers", async () => {
    const dir = tempDir();
    const ok = door(dir);
    await ok.post({ puts: [entry("a")] });
    const failing = door(dir, { write: async () => { throw new Error("disk full"); } });
    await failing.get();
    const res = await failing.post({ puts: [entry("b")] });
    expect(res.status).toBe(500);
    expect((await failing.all()).map((r) => r.id)).toEqual(["a"]);
    expect((await door(dir).all()).map((r) => r.id)).toEqual(["a"]);
    expect(failing.lines.map((l) => l.event)).toEqual(["window_outbox_write_failed"]);
  });

  it("takes the two outbox types and nothing else, and refuses by shape", async () => {
    const d = door(tempDir());
    expect((await d.post({ puts: [{ type: "message", id: "m", entity: { id: "m" } }] })).status).toBe(400);
    expect((await d.post({ puts: [{ type: "outbox_entry", id: "has space", entity: {} }] })).status).toBe(400);
    expect((await d.post({ puts: [{ type: "outbox_entry", id: "a", entity: null }] })).status).toBe(400);
    expect((await d.post({ deletes: [{ type: "message_body", id: "a" }] })).status).toBe(400);
    expect((await d.post("{not json")).status).toBe(400);
    expect(d.lines.map((l) => l.fields.reason)).toEqual([
      "a put that is not an outbox row", "a put that is not an outbox row", "a put that is not an outbox row",
      "a delete that is not an outbox key", "not JSON",
    ]);
    expect((await d.all())).toEqual([]);
  });

  it("refuses without the launch bearer", async () => {
    const d = door(tempDir(), { authorized: async () => false });
    expect((await d.post({ puts: [entry("a")] })).status).toBe(401);
  });

  it("admits only the mailbox this engine serves, so a window left from another account writes nothing", async () => {
    const dir = tempDir();
    const other = door(dir, { scope: () => "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
    expect((await other.post({ puts: [entry("a")] })).status).toBe(409);
    expect((await other.get()).status).toBe(409);
    expect(existsSync(join(dir, FILE_A))).toBe(false);
    const unnamed = door(dir, { scope: () => "" });
    expect((await unnamed.post({ puts: [entry("a")] })).status, "an engine serving no mailbox yet").toBe(409);
    expect((await door(dir).post({ puts: [entry("a")] })).status, "control: the served mailbox").toBe(204);
  });

  it("pages a large outbox by key, and a delete between two pages skips no row", async () => {
    const dir = tempDir();
    const big = "x".repeat(400);
    const d = door(dir, { pageBytes: 1_000 });
    await d.post({ puts: ["a", "b", "c", "d", "e", "f"].map((id) => entry(id, { body: big })) });
    const first = await d.get();
    expect(first.body.rows.length).toBeGreaterThan(0);
    expect(first.body.rows.length).toBeLessThan(6);
    expect(first.body.next).not.toBeNull();
    // A row already read goes before the next page is asked for.
    await d.post({ deletes: [{ type: "outbox_entry", id: first.body.rows[0]!.id }] });
    const rest: string[] = [];
    let after = first.body.next;
    while (after !== null) {
      const page = await d.get(after);
      rest.push(...page.body.rows.map((r) => r.id));
      after = page.body.next;
    }
    expect([...first.body.rows.map((r) => r.id), ...rest].sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("an unreadable file is set aside rather than refusing every launch", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, FILE_A), "{torn");
    const d = door(dir);
    expect((await d.get()).body).toEqual({ rows: [], next: null });
    expect(readFileSync(join(dir, `${FILE_A}.unreadable`), "utf8")).toBe("{torn");
    expect(d.lines.map((l) => l.event)).toEqual(["window_outbox_read_failed"]);
  });

  /* INVERTED (it pinned the loss): this pin read the files GONE after another account's launch,
     which was the defect — the account's queued changes went with the mirror. They stay for it now. */
  it("stays for its own account when the install is pointed at another account, which never reads it", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, MIRROR_OWNER_FILE), JSON.stringify({ address: "first@account.example", base: MANAGED }));
    await door(dir).post({ puts: [entry("a")] });
    writeFileSync(join(dir, `${FILE_A}.unreadable`), "{torn");
    enforceMirrorOwner(dir, "first@account.example", MANAGED);
    for (const f of FILES_A) expect(existsSync(join(dir, f)), `the same owner keeps ${f}`).toBe(true);
    expect(enforceMirrorOwner(dir, "second@account.example", MANAGED), "control: the mirror itself was discarded").toBe(true);
    for (const f of FILES_A) expect(existsSync(join(dir, f)), `another account's launch removed ${f}`).toBe(true);
    expect(await door(dir, { owner: OWNER_B }).all(), "another account's door read the first one's change").toEqual([]);
    expect((await door(dir).all()).map((r) => r.id), "the first account's door lost its change").toEqual(["a"]);
  });
});

/**
 * ONE FILE PER OWNER — the account and the server a change was made for, never the mailbox id a
 * re-bootstrap mints anew. A launch reads its own owner's file and no other, and every path that
 * removes one names whose: another account's launch never does, a staged start-over removes the
 * changes of the holder whose record asked for it, and an ownerless file is adopted, never served.
 */
describe("the window's outbox is kept for the account and server it was made for", () => {
  const OWNER_A_ELSEWHERE: WindowOutboxOwner = { address: OWNER_A.address, base: "https://self.example" };
  const record = (dir: string, value: Record<string, unknown> | string): void =>
    writeFileSync(join(dir, MIRROR_OWNER_FILE), typeof value === "string" ? value : JSON.stringify(value));

  it("the mirror's owner is the address and the server, read as the record reads them, and nothing else", () => {
    const key = windowOutboxOwnerKey(OWNER_A);
    expect(windowOutboxOwnerKey({ address: " First@Account.Example ", base: ` ${MANAGED} ` })).toBe(key);
    expect(windowOutboxOwnerKey(OWNER_B)).not.toBe(key);
    expect(windowOutboxOwnerKey(OWNER_A_ELSEWHERE)).not.toBe(key);
    expect(windowOutboxOwnerKey({ address: null, base: MANAGED }), "a paired door names no address").not.toBe(key);
    expect(FILES_A).toEqual([`window-outbox.${key}.json`, `window-outbox.${key}.json.unreadable`]);
  });

  it("each owner's door reads its own changes only, and counts and discards only its own", async () => {
    const dir = tempDir();
    const a = door(dir);
    await a.post({ puts: [entry("a1"), entry("a2"), { type: "outbox_abandoned", id: "a0", entity: { v: 3, id: "a0" } }] });
    const b = door(dir, { owner: OWNER_B });
    const elsewhere = door(dir, { owner: OWNER_A_ELSEWHERE });
    expect(await b.all(), "another account on the same server").toEqual([]);
    expect(await elsewhere.all(), "the same address on another server").toEqual([]);
    await b.post({ puts: [entry("b1")] });
    expect(await a.count(), "the count is of this owner's waiting changes").toBe(2);
    expect(await b.count()).toBe(1);
    await a.discard();
    expect(existsSync(join(dir, FILE_A))).toBe(false);
    expect((await door(dir, { owner: OWNER_B }).all()).map((r) => r.id), "a discard took another owner's").toEqual(["b1"]);
  });

  it("the count leaves out a change its server already applied, by its key, and keeps its row", async () => {
    const dir = tempDir();
    const a = door(dir);
    await a.post({ puts: [entry("a1"), entry("a2")] });
    expect(await a.count((key) => key === "k-a1")).toBe(1);
    expect(await a.count(() => false), "control: nothing applied, both wait").toBe(2);
    expect((await a.all()).map((r) => r.id).sort(), "an applied change's row went").toEqual(["a1", "a2"]);
  });

  it("an ownerless file an earlier build wrote goes to the account its record names, not the launch's", async () => {
    const dir = tempDir();
    record(dir, { address: OWNER_A.address, base: MANAGED });
    writeFileSync(join(dir, LEGACY_WINDOW_OUTBOX_FILE), JSON.stringify({ v: 1, rows: [entry("a")] }));
    writeFileSync(join(dir, `${LEGACY_WINDOW_OUTBOX_FILE}.unreadable`), "{torn");
    enforceMirrorOwner(dir, OWNER_B.address, MANAGED);
    expect(existsSync(join(dir, LEGACY_WINDOW_OUTBOX_FILE)), "the ownerless file is still served as it is").toBe(false);
    expect(readFileSync(join(dir, `${FILE_A}.unreadable`), "utf8"), "the unreadable copy follows it").toBe("{torn");
    expect(await door(dir, { owner: OWNER_B }).all(), "the launching account read the previous one's change").toEqual([]);
    expect((await door(dir).all()).map((r) => r.id), "the account it was made for lost it").toEqual(["a"]);
  });

  it("with no record it is this launch's, and a one-line record's server is the managed one", async () => {
    const fresh = tempDir();
    writeFileSync(join(fresh, LEGACY_WINDOW_OUTBOX_FILE), JSON.stringify({ v: 1, rows: [entry("a")] }));
    enforceMirrorOwner(fresh, OWNER_A.address, MANAGED);
    expect((await door(fresh).all()).map((r) => r.id)).toEqual(["a"]);
    const legacy = tempDir();
    record(legacy, `${OWNER_A.address}\n`);
    writeFileSync(join(legacy, LEGACY_WINDOW_OUTBOX_FILE), JSON.stringify({ v: 1, rows: [entry("a")] }));
    enforceMirrorOwner(legacy, OWNER_A.address, "https://self.example");
    expect(await door(legacy, { owner: OWNER_A_ELSEWHERE }).all(), "the self-hosted launch read a managed change").toEqual([]);
    expect((await door(legacy).all()).map((r) => r.id)).toEqual(["a"]);
  });

  it("a record that names no server sets it aside unread, said once, and never over another one", async () => {
    const dir = tempDir();
    const lines: Line[] = [];
    for (const n of [1, 2]) {
      record(dir, { address: OWNER_A.address, base: null });
      writeFileSync(join(dir, LEGACY_WINDOW_OUTBOX_FILE), JSON.stringify({ v: 1, rows: [entry(`a${n}`)] }));
      enforceMirrorOwner(dir, OWNER_A.address, MANAGED, (event, fields) => { lines.push({ event, fields }); });
    }
    expect(existsSync(join(dir, UNOWNED_WINDOW_OUTBOX_FILE))).toBe(true);
    expect(existsSync(join(dir, "window-outbox.unowned.2.json")), "the second set-aside replaced the first").toBe(true);
    expect(await door(dir).all(), "an unowned change was served").toEqual([]);
    expect(lines.filter((l) => l.event === "window_outbox_unowned")).toHaveLength(2);
  });

  it("an owner's own file is never replaced by an ownerless one", async () => {
    const dir = tempDir();
    record(dir, { address: OWNER_A.address, base: MANAGED });
    await door(dir).post({ puts: [entry("kept")] });
    writeFileSync(join(dir, LEGACY_WINDOW_OUTBOX_FILE), JSON.stringify({ v: 1, rows: [entry("older")] }));
    enforceMirrorOwner(dir, OWNER_A.address, MANAGED);
    expect((await door(dir).all()).map((r) => r.id)).toEqual(["kept"]);
    expect(existsSync(join(dir, LEGACY_WINDOW_OUTBOX_FILE)), "the older file was deleted").toBe(true);
  });

  it("a staged start-over removes its own account's changes, and another account's launch removes none", async () => {
    const dir = tempDir();
    await door(dir).post({ puts: [entry("a")] });
    await door(dir, { owner: OWNER_B }).post({ puts: [entry("b")] });
    record(dir, { address: OWNER_A.address, base: MANAGED, discardPending: true });
    enforceMirrorOwner(dir, OWNER_A.address, MANAGED);
    expect(existsSync(join(dir, FILE_A)), "the person's own start-over kept the changes").toBe(false);
    expect((await door(dir, { owner: OWNER_B }).all()).map((r) => r.id)).toEqual(["b"]);
    await door(dir).post({ puts: [entry("a")] });
    record(dir, { address: OWNER_A.address, base: MANAGED, discardPending: true });
    enforceMirrorOwner(dir, OWNER_B.address, MANAGED);
    expect(existsSync(join(dir, FILE_A)), "another account's launch removed the first one's changes").toBe(true);
    expect((await door(dir, { owner: OWNER_B }).all()).map((r) => r.id), "the launching account's changes went").toEqual(["b"]);
  });
});

/**
 * A change the door answers 204 for survives a power cut: the staged file is flushed, renamed,
 * and then the DIRECTORY is flushed, because the rename is an entry there. Driven through the
 * door's own write, so the one caller of the helper is what is measured.
 */
describe("the window's outbox is on the disk before the door answers", () => {
  const staged = (dir: string): string => `${join(dir, FILE_A)}.${process.pid}.tmp`;

  it.skipIf(process.platform === "win32")("the file, then the rename, then the directory are flushed", async () => {
    const dir = tempDir();
    const d = door(dir);
    recording = true;
    const res = await d.post({ puts: [entry("a")] });
    fsCalls.push(`answered ${res.status}`);
    const tmp = staged(dir);
    expect(fsCalls).toEqual([
      `open w ${tmp}`, `sync w ${tmp}`, `close w ${tmp}`,
      `rename ${tmp} ${join(dir, FILE_A)}`,
      `open r ${dir}`, `sync r ${dir}`, `close r ${dir}`,
      "answered 204",
    ]);
  });

  it("on Windows, which cannot open a directory for a flush, the file's flush stands alone", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    try {
      const dir = tempDir();
      recording = true;
      expect((await door(dir).post({ puts: [entry("a")] })).status).toBe(204);
      const tmp = staged(dir);
      expect(fsCalls).toEqual([`open w ${tmp}`, `sync w ${tmp}`, `close w ${tmp}`, `rename ${tmp} ${join(dir, FILE_A)}`]);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it.skipIf(process.platform === "win32")("a filesystem with no directory flush still keeps the change", async () => {
    const dir = tempDir();
    recording = true;
    dirSyncFault = "EINVAL";
    expect((await door(dir).post({ puts: [entry("a")] })).status).toBe(204);
    expect(fsCalls).toContain(`close r ${dir}`);
    expect((await door(dir).all()).map((r) => r.id)).toEqual(["a"]);
  });

  it.skipIf(process.platform === "win32")("a directory flush that fails is a refused write, never a kept one", async () => {
    const dir = tempDir();
    const d = door(dir);
    await d.post({ puts: [entry("a")] });
    recording = true;
    dirSyncFault = "EIO";
    const res = await d.post({ puts: [entry("b")] });
    expect(res.status).toBe(500);
    expect(fsCalls).toContain(`close r ${dir}`);
    expect((await d.all()).map((r) => r.id)).toEqual(["a"]);
    expect(d.lines.map((l) => l.event)).toEqual(["window_outbox_recorded", "window_outbox_write_failed"]);
    expect(existsSync(staged(dir))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("emptying the outbox flushes the directory, and a failed flush refuses", async () => {
    const dir = tempDir();
    const d = door(dir);
    await d.post({ puts: [entry("a"), entry("b")] });
    recording = true;
    expect((await d.post({ deletes: [{ type: "outbox_entry", id: "a" }, { type: "outbox_entry", id: "b" }] })).status).toBe(204);
    expect(fsCalls).toEqual([`open r ${dir}`, `sync r ${dir}`, `close r ${dir}`]);
    await d.post({ puts: [entry("c")] });
    dirSyncFault = "EIO";
    expect((await d.post({ deletes: [{ type: "outbox_entry", id: "c" }] })).status).toBe(500);
    expect((await d.all()).map((r) => r.id)).toEqual(["c"]);
    expect(d.lines.map((l) => l.event)).toEqual([
      "window_outbox_recorded", "window_outbox_recorded", "window_outbox_recorded", "window_outbox_write_failed",
    ]);
  });
});
