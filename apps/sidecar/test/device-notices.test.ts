/**
 * A PERSON IS TOLD WHEN A DEVICE IS PAIRED TO THEIR ACCOUNT, end to end on the desktop's own store.
 *
 * A signed-in client learns of a new device from the settings record: a ring puts the record on the
 * feed, the client's copy takes it, and the gate compares two readings of it. The record once said
 * only how many devices are signed in now, and that count hides a pairing: a phone signs itself out
 * (nothing rings, and one fewer is signed in), then another device is paired (it rings, and as many
 * are signed in as at the client's last reading). Every client read no change, and nobody was told
 * that a device had joined the account.
 *
 * Everything here is the real thing a desktop that hosts phones runs: the store `openLocalDb` opens
 * and its journal, the session machinery of the service bag, the pairing's mint and redeem, the
 * feed (`SyncService`), the client engine's own store, its closed reader of the three numbers and
 * the gate. A client pulls the feed as a wake makes it, and tells what the gate answers.
 */
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_CHANNELS, MemoryMirrorStore, NOTICE_KINDS, decideNotices, devicesOf, flattenResponse, noticeChoicesOf, noticeSampleOf,
  type Notice, type NoticeSample,
} from "@ohmail/client-engine";
import { bindDb, changeLog, devices, sessions } from "@trafficflow/db";
import {
  hashToken, makeAuthConfig, makeSessionLifecycle, mintPairingToken, redeemDevicePair, resolveSession,
  type ServiceContext, type SessionLifecycle,
} from "@trafficflow/services/auth";
import { SyncService, dbFor, type SyncChange, type SyncResponse } from "@trafficflow/services/mail";
import { freshDataDir } from "./_datadir.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedDevices, hostedDevicesOf } from "../src/cloud-mirror-devices.js";
import { openLocalDb, type LocalDb, type OpenLocalDb } from "../src/db.js";
import { ensureLocalWorld, type LocalWorld } from "../src/identity.js";

const AT = new Date("2026-11-17T09:00:00.000Z");
const PAIRED: Notice = { kind: "pairing", change: "paired", device: null };
const REVOKED: Notice = { kind: "pairing", change: "revoked", device: null };

const opened: OpenLocalDb[] = [];
const dirs: string[] = [];
const sidecars: CloudSidecar[] = [];
afterEach(async () => {
  for (const c of sidecars.splice(0)) await c.stop().catch(() => undefined);
  for (const o of opened.splice(0)) await o.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Phone { readonly accessToken: string; readonly refreshToken: string; readonly sessionId: string; readonly deviceId: string }

async function host() {
  const dir = await freshDataDir("ohmail-device-notices-");
  dirs.push(dir);
  const o = await openLocalDb(dir);
  opened.push(o);
  const db: LocalDb = o.db;
  const world: LocalWorld = await ensureLocalWorld(db, { address: "owner@example.com", now: AT });
  const lifecycle: SessionLifecycle = makeSessionLifecycle({ config: makeAuthConfig({ rpID: "localhost", origin: "http://localhost" }) });
  const sync = new SyncService();
  let clock = AT.getTime();
  // A call with a session: the device's own account; a door before sign-in (the redeem, the refresh): nothing.
  const ctx = (over: Partial<ServiceContext> = {}): ServiceContext => ({
    db: over.accountId === "" ? bindDb(db, { account: null }) : dbFor(db, over.accountId ?? world.accountId),
    accountId: world.accountId, userId: world.userId,
    now: () => new Date(clock), requestId: "device-notices", ...over,
  });

  /** Pair a phone with this desktop: the mint and the redeem the pairing's routes call. */
  async function pair(over: Partial<ServiceContext> = {}): Promise<Phone> {
    clock += 1_000;
    const minted = await mintPairingToken(ctx(), { grant: "device-pair", label: "Pixel in the kitchen" });
    const { tokens } = await redeemDevicePair(ctx({ accountId: "", userId: null, ...over }), lifecycle, { token: minted.token, kind: "mobile-android" });
    const resolved = await resolveSession(bindDb(db, { account: null }), tokens.accessToken, new Date(clock));
    const [session] = await db.select({ deviceId: sessions.deviceId }).from(sessions).where(eq(sessions.id, resolved!.sessionId));
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, sessionId: resolved!.sessionId, deviceId: session!.deviceId! };
  }

  /**
   * One signed-in client of the account: its copy, filled by the feed, and what it last read. It
   * opens as a client does, with the snapshot (whose first page carries the settings record) and
   * the feed's cursor; a pull takes what the feed has since, and settles once.
   */
  async function client() {
    const copy = new MemoryMirrorStore();
    await copy.load();
    await copy.applyChanges((await sync.getSnapshot(ctx(), {})).changes);
    let cursor = (await sync.getChanges(ctx(), { since: "0" })).cursor;
    let before: NoticeSample | null = null;
    const settle = (): Notice[] => {
      const after = noticeSampleOf(copy, devicesOf(copy));
      const told = decideNotices(before, after, noticeChoicesOf(DEFAULT_CHANNELS, null, { ohcalPhone: false }), "granted", NOTICE_KINDS);
      before = after;
      return told;
    };
    expect(settle(), "a client's first reading tells nothing").toEqual([]);
    return {
      /** What reached the copy since the last pull, and what the client then tells. */
      async pull(): Promise<{ arrived: number; told: Notice[] }> {
        const page = await sync.getChanges(ctx(), { since: cursor });
        const changes = flattenResponse(page);
        await copy.applyChanges(changes);
        cursor = page.cursor;
        return { arrived: changes.filter((c) => c.type === "settings").length, told: settle() };
      },
      devices: () => devicesOf(copy),
    };
  }

  const rings = async (): Promise<number> => (await db.select({ seq: changeLog.seq }).from(changeLog)
    .where(and(eq(changeLog.accountId, world.accountId), eq(changeLog.entityType, "settings")))).length;
  /** A phone signs itself out: the door a signed-in device's own sign-out goes through. */
  const signOut = (phone: Phone): Promise<unknown> => {
    clock += 1_000;
    return lifecycle.logout(ctx({ sessionId: phone.sessionId }));
  };
  /** The Devices list's take-back, as the desktop's own door calls it. */
  const takeBack = (phone: Phone): Promise<void> => {
    clock += 1_000;
    return lifecycle.revokeDevice(ctx(), phone.deviceId, { requireStepUp: false });
  };
  return { db, world, lifecycle, ctx, pair, client, rings, signOut, takeBack, now: () => new Date(clock) };
}

describe("a device paired to the account is told to the account's other clients", () => {
  it("a phone signs itself out, then another device is paired: the pairing is told", async () => {
    const h = await host();
    const first = await h.pair();
    await h.pair();
    const watcher = await h.client();
    expect(watcher.devices()).toEqual({ made: 2, revoked: 0, live: 2 });

    // The first phone signs itself out. Nothing rings: the watcher is not woken and reads nothing new.
    const before = await h.rings();
    await h.signOut(first);
    expect(await h.rings(), "a sign-out writes no settings change").toBe(before);
    expect(await watcher.pull()).toEqual({ arrived: 0, told: [] });

    // Somebody pairs a third device. As many are signed in now as at the watcher's last reading.
    await h.pair();
    const pulled = await watcher.pull();
    expect(pulled.arrived, "the pairing rang once").toBe(1);
    expect(watcher.devices()).toEqual({ made: 3, revoked: 0, live: 2 });
    expect(pulled.told).toEqual([PAIRED]);
  });

  it("a sign-out alone tells nothing, whenever the client next reads", async () => {
    const h = await host();
    const phone = await h.pair();
    const other = await h.pair();
    const watcher = await h.client();
    await h.signOut(phone);
    expect((await watcher.pull()).told).toEqual([]);
    // A client that opens afterwards reads one fewer signed in, and compares it with nothing.
    const later = await h.client();
    expect(later.devices()).toEqual({ made: 2, revoked: 0, live: 1 });
    expect((await later.pull()).told).toEqual([]);
    // The next take-back is told as a take-back, and the sign-out before it is still told to nobody.
    await h.takeBack(other);
    expect((await watcher.pull()).told).toEqual([REVOKED]);
    expect((await later.pull()).told).toEqual([REVOKED]);
  });

  it("a pairing that replaces the phone's previous sign-in tells the new device and no take-back", async () => {
    const h = await host();
    const old = await h.pair();
    const watcher = await h.client();
    await h.pair({ supersedesInstall: hashToken(old.refreshToken) });
    const [ended] = await h.db.select({ at: sessions.revokedAt }).from(sessions).where(eq(sessions.id, old.sessionId));
    expect(ended!.at, "the previous sign-in was ended by the new one").not.toBeNull();
    const pulled = await watcher.pull();
    expect(watcher.devices()).toEqual({ made: 2, revoked: 0, live: 1 });
    expect(pulled.told).toEqual([PAIRED]);
  });

  it("a refresh token presented twice ends its device's sign-in and tells nothing", async () => {
    const h = await host();
    const phone = await h.pair();
    await h.pair();
    const watcher = await h.client();
    await h.lifecycle.refresh(h.ctx({ userId: null, accountId: "" }), { refreshToken: phone.refreshToken });
    await expect(h.lifecycle.refresh(h.ctx({ userId: null, accountId: "" }), { refreshToken: phone.refreshToken })).rejects.toBeTruthy();
    const [swept] = await h.db.select({ at: sessions.revokedAt }).from(sessions).where(eq(sessions.id, phone.sessionId));
    expect(swept!.at, "the sweep ended the family").not.toBeNull();
    expect(await watcher.pull()).toEqual({ arrived: 0, told: [] });
  });

  it("two pairings between two readings are one notice", async () => {
    const h = await host();
    await h.pair();
    const watcher = await h.client();
    await h.pair();
    await h.pair();
    const pulled = await watcher.pull();
    expect(pulled.arrived).toBe(2);
    expect(pulled.told).toEqual([PAIRED]);
  });

  it("a take-back in Devices is told once, and with a pairing beside it the pairing is told last", async () => {
    const h = await host();
    const phone = await h.pair();
    const second = await h.pair();
    const watcher = await h.client();
    await h.takeBack(phone);
    expect((await watcher.pull()).told).toEqual([REVOKED]);
    const [device] = await h.db.select({ at: devices.revokedAt }).from(devices).where(eq(devices.id, phone.deviceId));
    expect(device!.at).toEqual(h.now());
    // A second press on the device already taken back tells nothing more.
    await h.takeBack(phone);
    expect(await watcher.pull()).toEqual({ arrived: 0, told: [] });

    await h.takeBack(second);
    await h.pair();
    expect((await watcher.pull()).told).toEqual([REVOKED, PAIRED]);
    expect(watcher.devices()).toEqual({ made: 3, revoked: 2, live: 1 });
  });

  it("the device that was just paired tells nothing of its own pairing", async () => {
    const h = await host();
    await h.pair();
    const itself = await h.client();
    expect(itself.devices()).toEqual({ made: 1, revoked: 0, live: 1 });
    expect((await itself.pull()).told).toEqual([]);
  });
});

/**
 * A DESKTOP APP SIGNED IN TO A SERVER. Its window reads this computer's copy of the account, and the
 * copy's own device rows are not the account's: the server makes and takes back its devices. The
 * mirror reads the hosted settings record's three numbers, and the window's record answers those.
 */
describe("a device paired to a hosted account is told in a desktop window signed in to it", () => {
  const CLOUD_ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const CLOUD_MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const STAMP = (n: number): string => new Date(Date.UTC(2026, 10, 17, 9, 0, n)).toISOString();
  const cursorOf = (seq: number): string => Buffer.from(String(seq), "utf8").toString("base64url");

  /** The hosted record as the server's feed sends it: the account's numbers beside its settings. */
  const hostedSettings = (seq: number, numbers: Record<string, unknown>): SyncChange => ({
    type: "settings", op: "update", id: CLOUD_ACCOUNT, seq, updatedAt: STAMP(seq),
    entity: {
      accountId: CLOUD_ACCOUNT, dormancyDays: null, autoSuggestAt: null, blockRemoteImagesAt: null,
      loadTrackingPixelsAt: null, blockAutoUnsubscribeAt: null, foldersEnabledAt: null, folderMailboxesOff: {},
      locale: null, ...numbers, updatedAt: STAMP(seq),
    },
  });

  /**
   * The hosted server: its feed holds the changes `log` holds, one settings change per ring. `hosted`,
   * where given, is the account's settings record as the server reads it now, which its snapshot's
   * first page carries; `dir` is a desktop's data folder that an earlier launch left.
   */
  async function signedIn(log: SyncChange[], over: { hosted?: () => SyncChange; dir?: string } = {}) {
    const page = (changes: SyncChange[], cursor: string): SyncResponse => ({
      changes: { creates: [], updates: changes, moves: [], deletes: [] }, cursor, hasMore: false, serverTime: STAMP(0),
    });
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const send = (v: unknown): Response => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname === "/mailboxes") return send(mailboxList([hostedMailbox(CLOUD_MAILBOX, "me@ohmail.test")]));
      if (url.pathname === "/sync") {
        const since = Number(Buffer.from(url.searchParams.get("since") ?? "", "base64url").toString("utf8") || "0");
        const fresh = log.filter((c) => c.seq > since);
        return send(page(fresh, cursorOf(Math.max(since, ...log.map((c) => c.seq)))));
      }
      if (url.pathname === "/messages/bodies") return send({ items: [], nextCursor: null });
      if (url.pathname === "/sync/snapshot" && over.hosted !== undefined && !url.searchParams.has("cursor")) {
        const asOfSeq = Math.max(0, ...log.map((c) => c.seq));
        return send({ asOfSeq, changes: [{ ...over.hosted(), op: "create", seq: asOfSeq }], nextCursor: null, window: { days: 30, minRows: 0 } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const dir = over.dir ?? (await freshDataDir("ohmail-device-notices-cloud-"));
    if (over.dir === undefined) dirs.push(dir);
    const sidecar = await createCloudSidecar({
      dataDir: dir, cloudUrl: "https://cloud.test", address: "me@ohmail.test",
      tokens: { accessToken: "a", refreshToken: "r" }, fetchImpl, pollIntervalMs: 40,
    });
    sidecars.push(sidecar);
    await sidecar.start();
    const ask = async (path: string): Promise<unknown> => {
      const res = await sidecar.handle(new Request(`http://sidecar${path}`, { headers: { authorization: `Bearer ${sidecar.sessionToken}` } }));
      expect(res.status, path).toBe(200);
      return res.json();
    };
    return { sidecar, ask, dir };
  }

  async function until(what: string, test: () => Promise<boolean>, ms = 20_000): Promise<void> {
    const end = Date.now() + ms;
    while (!(await test())) {
      if (Date.now() > end) throw new Error(`never: ${what}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * The window's copy: its snapshot, then its feed from the start, and the gate at each settle. `told`
   * is what this window has told of the account's devices at an earlier launch (`told-devices.ts`): the
   * first settle compares the record with it, as the window's own caller does.
   */
  async function windowOf(door: Awaited<ReturnType<typeof signedIn>>, told?: { made: number; revoked: number }) {
    const copy = new MemoryMirrorStore();
    await copy.load();
    await copy.applyChanges(((await door.ask("/sync/snapshot")) as { changes: SyncChange[] }).changes);
    let cursor = "0";
    let before: NoticeSample | null = told === undefined ? null : noticeSampleOf(copy, { ...told, live: 0 });
    const pull = async (): Promise<void> => {
      const page = (await door.ask(`/sync?since=${cursor}`)) as SyncResponse;
      await copy.applyChanges(flattenResponse(page));
      cursor = page.cursor;
    };
    const settle = (): Notice[] => {
      const after = noticeSampleOf(copy, devicesOf(copy));
      const told = decideNotices(before, after, noticeChoicesOf(DEFAULT_CHANNELS, null, { ohcalPhone: false }), "granted", NOTICE_KINDS);
      before = after;
      return told;
    };
    return { pull, settle, devices: () => devicesOf(copy) };
  }

  it("a pairing at the server reaches the window, and the gate tells it", { timeout: 60_000 }, async () => {
    const log = [hostedSettings(1, { devices: 2, devicesMade: 2, devicesRevoked: 0 })];
    const door = await signedIn(log);
    await until("the hosted numbers in the window's snapshot", async () => {
      const snap = (await door.ask("/sync/snapshot")) as { changes: SyncChange[] };
      return snap.changes.some((c) => c.type === "settings" && (c.entity as { devicesMade?: number }).devicesMade === 2);
    });
    const window = await windowOf(door);
    expect(window.devices(), "the hosted account's numbers, not this copy's own rows").toEqual({ made: 2, revoked: 0, live: 2 });
    await window.pull();
    expect(window.settle(), "a first reading tells nothing").toEqual([]);

    // A phone is paired to the account at the server: the pairing rings the hosted record.
    log.push(hostedSettings(2, { devices: 3, devicesMade: 3, devicesRevoked: 0 }));
    await until("the ring in the window", async () => {
      await window.pull();
      return window.devices()?.made === 3;
    });
    expect(window.settle()).toEqual([PAIRED]);

    // Signed out: the mirror stops, and nothing it read of this account is answered for the next one.
    await door.sidecar.stop();
    expect(hostedDevices.numbers(door.sidecar.world.accountId)).toBeNull();
  });

  it("a pairing made while no desktop runs is told at the desktop's next start", { timeout: 60_000 }, async () => {
    let hosted = hostedSettings(1, { devices: 2, devicesMade: 2, devicesRevoked: 0 });
    const log = [hosted];
    const first = await signedIn(log, { hosted: () => hosted });
    const window = await windowOf(first);
    await until("the hosted numbers", async () => {
      await window.pull();
      return window.devices()?.made === 2;
    });
    expect(window.settle()).toEqual([]);
    const told = { made: 2, revoked: 0 };
    await first.sidecar.stop();

    // With no desktop running a phone is paired to the account. The server's record says so; no ring of
    // it waits in the feed past the desktop's cursor (a ring is lost, or was pulled and never shown).
    hosted = hostedSettings(2, { devices: 3, devicesMade: 3, devicesRevoked: 0 });
    const next = await signedIn(log, { hosted: () => hosted, dir: first.dir });
    const again = await windowOf(next, told);
    expect(again.devices(), "the mirror read the hosted record at its start").toEqual({ made: 3, revoked: 0, live: 3 });
    expect(again.settle()).toEqual([PAIRED]);
  });

  it("a hosted record read at the start that cannot be read keeps none", { timeout: 60_000 }, async () => {
    const log = [hostedSettings(1, { devices: 2, devicesMade: 2, devicesRevoked: 0 })];
    const first = await signedIn(log, { hosted: () => log[0]! });
    await first.sidecar.stop();
    // The record names a word where a number belongs: the next start knows no numbers, and its window tells nothing.
    const next = await signedIn(log, { hosted: () => hostedSettings(2, { devices: 3, devicesMade: "3", devicesRevoked: 0 }), dir: first.dir });
    const again = await windowOf(next, { made: 2, revoked: 0 });
    expect(again.devices()).toBeNull();
    expect(again.settle()).toEqual([]);
  });

  it("a hosted record that says no numbers answers none, so the window tells nothing", { timeout: 60_000 }, async () => {
    const log = [hostedSettings(1, { devices: 1, devicesMade: 1, devicesRevoked: 0 })];
    const door = await signedIn(log);
    const window = await windowOf(door);
    await until("the hosted numbers", async () => {
      await window.pull();
      return window.devices()?.made === 1;
    });
    window.settle();
    // A server of an earlier build sends the record without them, and a word where a number belongs is none.
    log.push(hostedSettings(2, { devices: 2, devicesMade: "2", devicesRevoked: 0 }));
    await until("the record in the window", async () => {
      await window.pull();
      return window.devices() === null;
    });
    expect(window.settle()).toEqual([]);
  });

  it("reads the hosted record's three numbers closed", () => {
    expect(hostedDevicesOf({ devices: 2, devicesMade: 3, devicesRevoked: 1, locale: null })).toEqual({ made: 3, revoked: 1, live: 2 });
    for (const bad of [
      null, [], "3", {},
      { devices: 2, devicesMade: 3 },
      { devices: 2, devicesMade: "3", devicesRevoked: 1 },
      { devices: 2, devicesMade: 3.5, devicesRevoked: 1 },
      { devices: 2, devicesMade: -1, devicesRevoked: 1 },
      { devices: 2, devicesMade: Number.MAX_SAFE_INTEGER + 1, devicesRevoked: 1 },
      { devices: 2, devicesMade: 3, devicesRevoked: null },
      Object.create({ devices: 2, devicesMade: 3, devicesRevoked: 1 }),
    ]) expect(hostedDevicesOf(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe("a desktop that mirrors no account counts its own devices", () => {
  it("the record says the store's own numbers, with nothing handed for another store", async () => {
    const h = await host();
    await h.pair();
    await h.pair();
    const own = await h.client();
    expect(own.devices(), "the twin of the mirrored window: the store's own rows").toEqual({ made: 2, revoked: 0, live: 2 });
    await h.pair();
    expect((await own.pull()).told).toEqual([PAIRED]);
    expect(own.devices()).toEqual({ made: 3, revoked: 0, live: 3 });
  });
});
