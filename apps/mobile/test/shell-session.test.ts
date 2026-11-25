/**
 * THE SHELL'S WAYS IN BOOT NO ENGINE. Paired through the same ceremony and refusals as the screens',
 * the shell's session opens the transport and nothing else: no database is opened on this side, so
 * the old mirror stays shut and the page's engine is the only client of the account's queue. The
 * account the bearer answers for is asked natively, and a mismatch keeps the drain routes shut.
 * Every request the page's engine sends leaves named as the phone and its release, by this session's
 * transport; a name the page sets never leaves.
 */
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, OUTBOX_TYPE, SqlMirrorStore, mirrorDbName } from "@ohmail/client-engine";
import { mirrorExists, mirrorOwnerKey, type MobileEngineDeps } from "../src/engine/boot";
import { OldCopyRefused, PAGE_ROWS, launchVerdict, settleLaunchVerdict, type OldCopyDoor } from "../src/shell/old-copy";
import type { BearerManagerRN } from "../src/net/bearer";
import { clearUnscopedCalendarCredentials, connectShellById, drainPendingWipes, forgetProfile, pairForShell, probePairing, shellSessionOf, type PairingEnv } from "../src/net/pairing";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import type { BackupExclusionNative } from "../src/engine/backup-exclusion";
import type { NotificationPermissionHost } from "../src/engine/notification-permission";
import { askNoticePermission, measureShellBackup, noticePermission, onShellWake, wakeShell } from "../src/shell/doors";
import { OLDEST_WEBVIEW_MAJOR, webViewVerdict } from "../src/shell/webview-check";
import { BridgeHost } from "../src/shell/bridge-host";
import type { ShellConfig } from "../src/shell/bridge-kinds";
import { HttpDoor } from "../src/shell/http-door";
import { createBridge } from "../web/src/bridge";
import { bridgeFetch } from "../web/src/bridge-fetch";
import { createPhoneEngine } from "../web/src/engine";
import type { PagePort } from "../web/src/port";
import { listen, pairServer, sqlWorld } from "./helpers/pair-server";

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v), remove: async (k) => void map.delete(k) };
}

function shellEnv(clientRelease?: string) {
  const world = sqlWorld();
  let opened = 0;
  const deps: MobileEngineDeps = {
    openExecutor: (name) => { opened += 1; return world.open(name); },
    deleteDatabase: world.drop,
    uuid: () => "00000000-0000-4000-8000-000000000000",
  };
  const kv = memoryKV();
  const env: PairingEnv = {
    profiles: new ServerProfileStore(kv), engineDeps: deps, ...(clientRelease ? { clientRelease } : {}),
  };
  return { env, kv, opened: () => opened };
}

/** The page's bridge joined to the native end over `door`, the platform's message channel the one double. */
function pageOver(door: HttpDoor, epoch: string) {
  const toPage = new Set<(text: string) => void>();
  const host = new BridgeHost({
    post: (_epoch, text) => queueMicrotask(() => toPage.forEach((take) => take(text))),
    config: () => null,
    http: door,
    act: async () => ({}),
    openHeld: async () => false,
    ready: () => {},
    place: () => {},
    note: () => {},
    oldCopy: { page: async () => ({ refused: "notReady" as const }), done: async () => ({ refused: "notReady" as const }) },
  });
  host.begin(epoch);
  const port: PagePort = {
    post: (text) => host.receive({ epoch, origin: "https://appassets.androidplatform.net", mainFrame: true, data: text }),
    listen: (take) => (toPage.add(take), () => void toPage.delete(take)),
  };
  return createBridge(port, epoch);
}

async function pairedForShell(env: PairingEnv, opts: Parameters<typeof pairServer>[0]) {
  const fake = pairServer(opts);
  const origin = await listen(fake.server);
  // A door with no session read names its account by the rows it serves.
  fake.addMessage("m-1", "a letter");
  fake.mintPairToken("tok-1");
  const probed = await probePairing(env, { origin, pin: null });
  if (probed.kind === "refused") throw new Error("probe refused");
  return { fake, origin, outcome: await pairForShell(env, { admission: probed.admission, token: "tok-1" }) };
}

describe("the shell's session", () => {
  it("pairs and reconnects without opening a database on this side", async () => {
    const { env, opened } = shellEnv();
    const { fake, origin, outcome } = await pairedForShell(env, { flavor: "desktop-host", accountId: "acct-1" });
    try {
      expect(outcome.kind === "shell" ? "shell" : JSON.stringify(outcome)).toBe("shell");
      if (outcome.kind !== "shell") return;
      expect(outcome.session.standalone).toBe(false);
      expect(outcome.session.profile.origin).toBe(origin);
      const id = (await env.profiles.list())[0]!.id;
      const again = await connectShellById(env, id);
      expect(again.kind).toBe("shell");
      expect(opened(), "an engine was booted under the shell").toBe(0);
      expect((await outcome.session.verifyIdentity()).kind).toBe("verified");
      expect(outcome.session.boundAccount()).toBe("acct-1");

      const before = fake.seen.length;
      const res = await outcome.session.send("/sync?since=0&limit=1&types=message", { method: "GET" });
      expect(res.status).toBe(200);
      expect(fake.seen.slice(before)[0]?.url).toBe("/sync?since=0&limit=1&types=message");
      expect(fake.seen.slice(before)[0]?.auth, "the session's transport stamps the pairing's bearer").toMatch(/^Bearer /);
    } finally {
      fake.server.close();
    }
  });

  it("recognizes a stored computer without a calendar when it answers with a web page", async () => {
    const { env } = shellEnv();
    const origin = new URL("https:" + "//computer.example.invalid").origin;
    const profile = await env.profiles.add({
      origin, flavor: "desktop-host", accountId: "account", refreshToken: "fixture-refresh", pin: null,
    });
    const paths: string[] = [];
    const result = await connectShellById({
      ...env, calendarOnly: true,
      fetchImpl: async (url, init) => {
        paths.push(new URL(url).pathname);
        expect((init as RequestInit | undefined)?.credentials).toBe("omit");
        return new Response("<html></html>", { headers: { "content-type": "text/html" } });
      },
    }, profile.id);
    expect(result).toMatchObject({ kind: "refused", reason: { say: "calendarServerUnavailable" } });
    expect(paths).toEqual(["/calendar/sync", "/api/calendar/sync"]);
  });

  it("clears unscoped credentials and leaves the old pairing available to re-pair", async () => {
    const { env } = shellEnv();
    const origin = "https://calendar.example.invalid";
    const old = await env.profiles.add({ origin, flavor: "managed", accountId: "old", refreshToken: "fixture-refresh" });
    const current = await env.profiles.add({ origin, flavor: "managed", accountId: "new", refreshToken: "cal.fixture-refresh" });
    const calendar = { ...env, calendarOnly: true, fetchImpl: async () => { throw new Error("unexpected network request"); } };
    await clearUnscopedCalendarCredentials(calendar);
    expect(await env.profiles.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: old.id, refreshToken: null }),
      expect.objectContaining({ id: current.id, refreshToken: current.refreshToken }),
    ]));
    expect(await connectShellById(calendar, old.id)).toMatchObject({ kind: "refused", needsRepair: true });
  });

  it("keeps an offline profile and reopens a legacy forget when the keeper still has edits", async () => {
    const { env } = shellEnv();
    const origin = "https://calendar.example.invalid";
    const profile = await env.profiles.add({ origin, flavor: "managed", accountId: "account", refreshToken: "cal.fixture-refresh" });
    const owner = mirrorOwnerKey(origin, profile.accountId);
    const touches: string[] = [];
    const calendar: PairingEnv = {
      ...env, calendarOnly: true,
      fetchImpl: async () => { touches.push("network"); throw new Error("offline"); },
      shell: {
        calendarCopiesPrepared: () => true,
        scopeOf: async (key) => key,
        keeperScopes: async () => [owner],
        fenceCalendarWipe: async () => "pending",
        releaseCalendarWipe: async () => { touches.push("release"); },
        forgetKeeper: async () => { touches.push("forget"); return true; },
        clearViewCopies: async () => { touches.push("clear"); return { listed: false, usage: 0 }; },
      },
    };
    expect(await forgetProfile(calendar, profile.id, { beforeForget: async () => { touches.push("leave"); } }))
      .toMatchObject({ kind: "partial", reason: { say: "calendarQueuePending" } });
    expect(await env.profiles.pendingWipes()).toEqual([]);
    await env.profiles.markPendingWipe(profile.id, owner);
    expect(await drainPendingWipes(calendar)).toEqual([]);
    expect(await env.profiles.pendingWipes()).toEqual([]);
    expect(await env.profiles.list()).toContainEqual(profile);
    expect(touches).toEqual([]);
  });

  it.each(["live", "restart"] as const)("erases only the confirmed keeper after %s even when another queue cannot transfer", async (when) => {
    const { env } = shellEnv();
    const profile = await env.profiles.add({
      origin: "https://calendar.example.invalid", flavor: "managed", accountId: "erased", refreshToken: "cal.fixture-refresh",
    });
    const owner = mirrorOwnerKey(profile.origin, profile.accountId);
    const keepers = new Map([[owner, "pending edit"], ["other", "independent edit"]]);
    const fences = new Set<string>();
    const calls: string[] = [];
    let prepared = false;
    const shell = {
      scopeOf: async (key: string) => key,
      keeperScopes: async () => [...keepers.keys()],
      eraseKeeper: async (scope: string) => { fences.add(scope); keepers.delete(scope); return true; },
      releaseCalendarErasure: async (scope: string) => { fences.delete(scope); },
      forgetKeeper: async () => false,
      waitForCalendarCopies: async () => { calls.push("prepare"); return prepared; },
      clearViewCopies: async () => { calls.push("clear"); return { listed: false, usage: 0 }; },
    };
    const calendar = { ...env, shell, calendarOnly: true };
    await env.profiles.markPendingWipe(profile.id, owner, true);
    if (when === "live") {
      expect(await forgetProfile(calendar, profile.id, { erased: true })).toMatchObject({ kind: "partial" });
    } else {
      expect(await drainPendingWipes(calendar)).toEqual([owner]);
    }
    expect(calls).toEqual(["prepare"]);
    expect(await env.profiles.pendingWipes()).toEqual([{ id: profile.id, owner, erased: true }]);
    expect(keepers).toEqual(new Map([["other", "independent edit"]]));
    expect(fences).toEqual(new Set([owner]));

    prepared = true;
    expect(await drainPendingWipes(calendar)).toEqual([]);
    expect(calls).toEqual(["prepare", "prepare", "clear"]);
    expect(fences.size).toBe(0);
    expect(await env.profiles.pendingWipes()).toEqual([]);
  });

  it.each(["live", "restart"] as const)("erases only the confirmed account's pending calendar after %s", async (when) => {
    const { env, kv } = shellEnv();
    const keepers = new Map([["other", ["independent edit"]]]);
    const clears: string[] = [];
    let viewAvailable = when === "live";
    const shell = {
      calendarCopiesPrepared: () => true,
      scopeOf: async (key: string) => key,
      keeperScopes: async () => [...keepers.keys()],
      fenceCalendarWipe: async () => "pending" as const,
      releaseCalendarErasure: async () => {},
      forgetKeeper: async () => false,
      eraseKeeper: async (scope: string) => { keepers.delete(scope); return true; },
      clearViewCopies: async () => {
        clears.push("web");
        return { listed: !viewAvailable, usage: viewAvailable ? 0 : 1 };
      },
    };
    const calendar = { ...env, shell, calendarOnly: true };
    const { fake, outcome } = await pairedForShell(calendar, { calendarSync: true, accountId: "account" });
    try {
      if (outcome.kind !== "shell") throw new Error("calendar pairing refused");
      const { session } = outcome;
      const { profile, ownerKey } = session;
      keepers.set(ownerKey, ["pending edit"]);
      expect((await session.verifyIdentity()).kind).toBe("verified");
      fake.erase();
      await session.send("/calendar/sync", { method: "GET" });
      expect(await session.bearer?.deathSettled()).toBe("erased");
      expect(await calendar.profiles.list()).toContainEqual(expect.objectContaining({ id: profile.id, refreshToken: null }));
      await calendar.profiles.markPendingWipe(profile.id, ownerKey);
      expect(await calendar.profiles.pendingWipes()).toEqual([{ id: profile.id, owner: ownerKey, erased: true }]);
      session.leave();

      if (when === "live") {
        expect(await forgetProfile(calendar, profile.id, { erased: true, revoke: async () => true }))
          .toEqual({ kind: "forgotten" });
      } else {
        const restarted = { ...calendar, profiles: new ServerProfileStore(kv) };
        expect(await drainPendingWipes(restarted)).toEqual([ownerKey]);
        expect(await restarted.profiles.pendingWipes()).toEqual([{ id: profile.id, owner: ownerKey, erased: true }]);
        expect(keepers.has(ownerKey)).toBe(false);
        viewAvailable = true;
        expect(await drainPendingWipes(restarted)).toEqual([]);
      }
      expect(keepers.has(ownerKey)).toBe(false);
      expect(keepers.get("other")).toEqual(["independent edit"]);
      expect(clears).toContain("web");
      expect(await calendar.profiles.list()).toEqual([]);
      expect(await calendar.profiles.pendingWipes()).toEqual([]);
    } finally { fake.server.close(); }
  });

  it("settles a confirmed calendar erasure before adopting a new pairing for the same account", async () => {
    const { env } = shellEnv();
    const erased: string[] = [];
    let clears = 0;
    const calendar = { ...env, calendarOnly: true, shell: {
      calendarCopiesPrepared: () => true,
      scopeOf: async (key: string) => key,
      keeperScopes: async () => [],
      forgetKeeper: async () => false,
      eraseKeeper: async (scope: string) => { erased.push(scope); return true; },
      releaseCalendarErasure: async () => {},
      clearViewCopies: async () => { clears++; return { listed: false, usage: 0 }; },
    } };
    const { fake, origin, outcome } = await pairedForShell(calendar, { calendarSync: true, accountId: "account" });
    try {
      if (outcome.kind !== "shell") throw new Error("calendar pairing refused");
      const { profile, ownerKey } = outcome.session;
      outcome.session.leave();
      await env.profiles.markPendingWipe(profile.id, ownerKey, true);
      fake.mintPairToken("replacement-code");
      const probed = await probePairing(calendar, { origin, pin: null });
      if (probed.kind === "refused") throw new Error("calendar probe refused");
      const again = await pairForShell(calendar, { admission: probed.admission, token: "replacement-code" });
      expect(again.kind).toBe("shell");
      expect(erased).toEqual([ownerKey]);
      expect(clears).toBe(1);
      expect(await env.profiles.pendingWipes()).toEqual([]);
      if (again.kind === "shell") again.session.leave();
    } finally { fake.server.close(); }
  });

  it("refuses what the screens' way in refuses: a profile this phone does not hold", async () => {
    const { env, opened } = shellEnv();
    expect(await connectShellById(env, "nobody")).toMatchObject({ kind: "refused" });
    expect(opened()).toBe(0);
  });

  it("asks the server whose bearer it is, and keeps the drain shut on a mismatch", async () => {
    const { env } = shellEnv();
    const { fake, outcome } = await pairedForShell(env, { flavor: "managed", sessionRoute: true, accountId: "acct-1" });
    try {
      if (outcome.kind !== "shell") throw new Error("not a shell session");
      expect(outcome.session.boundAccount()).toBeNull();
      expect((await outcome.session.verifyIdentity()).kind).toBe("verified");
      expect(outcome.session.boundAccount()).toBe("acct-1");
      const bearer = outcome.session.bearer!;
      const profile = { ...outcome.session.profile, accountId: "acct-2" };
      const mismatched = shellSessionOf({ kind: "paired", profile, bearer, fetch: bearer.fetch, apiBase: null });
      expect((await mismatched.verifyIdentity()).kind).toBe("mismatch");
      expect(mismatched.boundAccount()).toBeNull();
    } finally {
      fake.server.close();
    }
  });

  it("names the phone and its release on every request the page's engine sends, never a name the page set", async () => {
    const { env } = shellEnv("1.2.3");
    const { fake, outcome } = await pairedForShell(env, { flavor: "desktop-host", accountId: "acct-1" });
    try {
      if (outcome.kind !== "shell") throw new Error("not a shell session");
      const session = outcome.session;
      await session.verifyIdentity();
      const scope = "p0123456789abcdef0123456789abcdef";
      const bridge = pageOver(new HttpDoor({ live: () => ({ session, scope }), ready: () => true }), "e1");
      const config = { scope, accountId: "acct-1", setting: "desktopHost" } as ShellConfig;
      const { engine } = createPhoneEngine(config, bridge, new MemoryMirrorStore());
      const before = fake.seen.length;
      try {
        await engine.syncOnce();
        await bridgeFetch(bridge, scope)("/mailboxes", { headers: { "x-ohmail-client": "web/9.9.9" } });
      } finally {
        engine.dispose();
      }
      const asked = fake.seen.slice(before);
      const paths = asked.map((r) => r.url.split("?")[0]);
      expect(paths.some((p) => p === "/sync" || p === "/sync/snapshot"), paths.join(" ")).toBe(true);
      expect(paths).toContain("/mailboxes");
      for (const r of asked) expect(r.named, r.url).toBe("phone/1.2.3");
    } finally {
      fake.server.close();
    }
  });
});

describe("the native doors on the shell's session", () => {
  it("makes no view on a web view that cannot be sealed off the network, or is missing, mute or too old", () => {
    const able = { installed: true, major: 133, listener: true, sealed: true };
    expect(webViewVerdict(able)).toBe("usable");
    expect(webViewVerdict({ ...able, sealed: false })).toBe("unusable");
    expect(webViewVerdict({ ...able, listener: false })).toBe("unusable");
    expect(webViewVerdict({ ...able, installed: false })).toBe("unusable");
    expect(webViewVerdict({ ...able, major: OLDEST_WEBVIEW_MAJOR - 1 })).toBe("unusable");
    expect(webViewVerdict({ ...able, major: null })).toBe("usable");
  });

  it("hands a wake to every page that listens, and to none that stopped", () => {
    const heard: string[] = [];
    const stop = onShellWake((why) => heard.push(`a ${why}`));
    const other = onShellWake((why) => heard.push(`b ${why}`));
    wakeShell("push");
    stop();
    wakeShell("foreground");
    other();
    wakeShell("push");
    expect(heard).toEqual(["a push", "b push", "b foreground"]);
  });

  /** The phone's notice reader, as a double: what it reads, and what the prompt answers. */
  function reader(over: Partial<NotificationPermissionHost> = {}): NotificationPermissionHost & { asked: number } {
    const host: NotificationPermissionHost & { asked: number } = {
      platform: "android", apiLevel: 34, asked: 0,
      permissionGranted: async () => false,
      switchOn: async () => null,
      request: async () => "denied" as const,
      readAsked: async (): Promise<boolean> => host.asked > 0,
      writeAsked: async () => { host.asked += 1; },
      ...over,
    };
    return host;
  }

  it("reads the notice permission from the phone's own reader, and asks through it once pressed", async () => {
    expect(await noticePermission(reader())).toBe("default");
    expect(await noticePermission(reader({ permissionGranted: async () => true }))).toBe("granted");
    const denied = reader();
    expect(await askNoticePermission(denied)).toBe("denied");
    expect(denied.asked).toBe(1);
    expect(await noticePermission(denied)).toBe("denied");
    expect(await askNoticePermission(reader({ request: async () => "granted" }))).toBe("granted");
    expect(await askNoticePermission(reader({ request: async () => "blocked" }))).toBe("denied");
    // iOS posts no notice of the phone's own, so there is nothing to ask for.
    expect(await noticePermission(reader({ platform: "ios" }))).toBe("unsupported");
    expect(await askNoticePermission(reader({ platform: "ios" }))).toBe("unsupported");
  });

  it("says the mail is out of the backups only when every place the shell keeps it is, measured", async () => {
    const native = (included: string[], unreadable: string[] = []): BackupExclusionNative & { marked: string[] } => {
      const marked: string[] = [];
      return {
        marked,
        excludeFromBackup: async (path) => (marked.push(path), true),
        isExcluded: async (path) => {
          if (unreadable.includes(path)) throw new Error("unreadable");
          return !included.includes(path);
        },
      };
    };
    const places = ["/data/files/SQLite/ohmail-keeper-p1.db", "/data/app_webview", "/data/files/SQLite/ohmail-engine.db"];
    const all = native([]);
    expect(await measureShellBackup(all, places)).toBe("excluded");
    expect(all.marked).toEqual(places);
    expect(await measureShellBackup(native(["/data/app_webview"]), places)).toBe("included");
    expect(await measureShellBackup(native([], ["/data/files/SQLite/ohmail-engine.db"]), places)).toBe("unknown");
    expect(await measureShellBackup(native(["/data/app_webview"], [places[0]!]), places)).toBe("included");
    expect(await measureShellBackup(null, places)).toBe("unknown");
    expect(await measureShellBackup(all, [])).toBe("unknown");
  });
});

describe("the screens' old copy, handed across once", () => {
  const ORIGIN = "https://mail.example";
  const ownerKey = mirrorOwnerKey(ORIGIN, "acct-1");

  /** A phone that ran the screens: their mirror of this mailbox, with mail, a queued send, a held press and its cursor. */
  async function phoneWithOldCopy(messages = PAGE_ROWS + 50) {
    const world = sqlWorld();
    const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "u" };
    const store = new SqlMirrorStore({ owner: ownerKey, open: world.open });
    await store.load();
    await store.commitLocal([
      ...Array.from({ length: messages }, (_, i) => ({ type: "message", id: `m${String(i).padStart(4, "0")}`, entity: { subject: `s${i}` } })),
      { type: OUTBOX_TYPE, id: "o1", entity: { kind: "send" } },
      { type: "routing_journal", id: "ohmail.delete.intents.local", entity: { value: "[]" } },
    ], []);
    await store.setMeta("lastDrainAt", "2026-11-14T10:00:00.000Z");
    store.close();
    await world.open(mirrorDbName(ownerKey)).batch([
      { sql: "INSERT INTO meta (key, value) VALUES ('cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params: [JSON.stringify("c-42")] },
    ]);
    const profile = { id: "a", origin: ORIGIN, accountId: "acct-1", flavor: "managed", apiBase: null } as never;
    const bearer = { headers: () => ({}) } as unknown as BearerManagerRN;
    const session = shellSessionOf({ kind: "paired", profile, bearer, fetch: async () => new Response(null), apiBase: null }, deps);
    return { world, deps, door: session.oldCopy as OldCopyDoor };
  }

  async function allPages(door: OldCopyDoor) {
    const keys: string[] = [];
    let meta: (readonly [string, string])[] = [];
    let after: string | null = null;
    let pages = 0;
    do {
      const page = await door.page(after);
      if (after === null) meta = [...page.meta];
      keys.push(...page.entities.map((e) => `${e.type}:${e.id}`));
      after = page.next;
      pages += 1;
    } while (after !== null);
    return { keys, meta, pages };
  }

  it("reads the live scope's copy in pages, verbatim, without its stamps", async () => {
    const { door } = await phoneWithOldCopy();
    expect(await door.present()).toBe(true);
    const { keys, meta, pages } = await allPages(door);
    expect(pages).toBeGreaterThan(1);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(PAGE_ROWS + 50 + 2);
    expect(keys).toContain(`${OUTBOX_TYPE}:o1`);
    expect(keys).toContain("routing_journal:ohmail.delete.intents.local");
    expect(Object.fromEntries(meta)).toMatchObject({ cursor: JSON.stringify("c-42"), lastDrainAt: JSON.stringify("2026-11-14T10:00:00.000Z") });
    expect(meta.map(([k]) => k)).not.toContain("__owner");
  });

  it("never hands across a copy stamped for another owner", async () => {
    const { world, door } = await phoneWithOldCopy(3);
    await world.open(mirrorDbName(ownerKey)).batch([
      { sql: "UPDATE meta SET value = ? WHERE key = '__owner'", params: [JSON.stringify("https://other.example::acct-1")] },
    ]);
    expect(await door.present()).toBe(false);
    await expect(door.page(null)).rejects.toBeInstanceOf(OldCopyRefused);
    await expect(door.done("same-install")).rejects.toBeInstanceOf(OldCopyRefused);
  });

  it("is marked handed and removed, read back; a start that finds a handed copy finishes the removal", async () => {
    const { deps, door } = await phoneWithOldCopy(3);
    await door.done("same-install");
    expect(await mirrorExists(deps, ownerKey)).toBe(false);
    expect(await door.present()).toBe(false);

    const second = await phoneWithOldCopy(3);
    await second.world.open(mirrorDbName(ownerKey)).batch([
      { sql: "INSERT INTO meta (key, value) VALUES ('__handed', 'true')" },
    ]);
    expect(await second.door.present()).toBe(false);
    expect(await mirrorExists(second.deps, ownerKey)).toBe(false);
  });

  it("removes nothing before the launch has settled the install that wrote the copy", () => {
    settleLaunchVerdict("unknown");
    expect(launchVerdict()).toBeNull();
    settleLaunchVerdict("fresh-install");
    expect(launchVerdict()).toBeNull();
    settleLaunchVerdict("upgrade");
    expect(launchVerdict()).toBe("upgrade");
    settleLaunchVerdict("same-install");
    expect(launchVerdict()).toBe("same-install");
  });
});
