/**
 * A DEATH IS ONE FACT THE MANAGER OWNS, AND A LATE LISTENER STILL HEARS IT. The slot's manager is
 * shared, so a torn-down tree's last request can end it while a reconnect of the same slot is
 * between reading the death and subscribing. The manager settles its death after its listener
 * loop, tells a subscriber that arrives afterwards once on a microtask, and `buildSession` awaits a
 * death still settling. The door answers a held read with `410 account_erased` or a swept family.
 */
/* @reads: apps/mobile/src/net/connection.tsx */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import type { MobileEngineDeps } from "../src/engine/boot";
import type { ConnectOutcome, PairingEnv } from "../src/net/pairing";
import type { RefreshVault, SessionDeath } from "../src/net/bearer";
import type { SecureKV } from "../src/state/servers";
import { sqlWorld } from "./helpers/pair-server";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://a.example";
const ROUTE = `${ORIGIN}/sync/changes`;
const REUSE = { error: { code: "unauthorized", message: "refresh token reuse detected" } };

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return { get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v), remove: async (k) => void map.delete(k) };
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** The door: rotates single-use; `holdNextRead()` keeps one read on the wire; `end(how)` answers it. */
function door() {
  let minted = 0;
  let head = "ref-1";
  let ended: "none" | "erased" | "revoked" = "none";
  const honoured = new Set<string>();
  let held: ((r: Response) => void) | null = null;
  let holdNext = false;
  let baseHeld: (() => void) | null = null;
  let holdBase = false;
  const erasedAnswer = () => json(410, { error: { code: "account_erased", message: "gone" } }, { "X-Ohmail-Account": "acct-1" });
  const fetchImpl = async (url: string, init?: unknown): Promise<Response> => {
    const opts = (init ?? {}) as { body?: string; headers?: Record<string, string> };
    if (url.endsWith("/auth/refresh")) {
      const body = JSON.parse(opts.body ?? "{}") as { refreshToken?: string };
      if (ended === "erased") return erasedAnswer();
      if (ended === "revoked" || body.refreshToken !== head) return json(401, REUSE);
      minted += 1; head = `ref-${minted + 1}`;
      const acc = `acc-${minted}`; honoured.add(acc);
      return json(200, { tokens: { accessToken: acc, refreshToken: head } });
    }
    if (holdBase && !url.endsWith("/sync/changes") && !url.includes("/auth/")) {
      holdBase = false;
      await new Promise<void>((r) => { baseHeld = r; });
    }
    const auth = (opts.headers?.authorization ?? "").replace(/^Bearer /, "");
    if (holdNext && url === ROUTE) {
      holdNext = false;
      return new Promise<Response>((r) => { held = r; });
    }
    if (ended === "erased" && honoured.has(auth)) return erasedAnswer();
    if (ended !== "none" || !honoured.has(auth)) return new Response(null, { status: 401 });
    return new Response(null, { status: 204 });
  };
  return {
    fetchImpl,
    holdNextRead: () => { holdNext = true; },
    readHeld: () => held !== null,
    holdBaseProbe: () => { holdBase = true; },
    baseHeld: () => baseHeld !== null,
    releaseBase: () => { const b = baseHeld; baseHeld = null; b?.(); },
    end: (how: "erased" | "revoked") => {
      ended = how;
      const h = held; held = null;
      h?.(how === "erased" ? erasedAnswer() : new Response(null, { status: 401 }));
    },
  };
}

async function turns(done: () => boolean, max = 200): Promise<void> {
  for (let i = 0; i < max && !done(); i++) await new Promise((r) => setTimeout(r, 0));
}

async function setup(apiBase: string | null) {
  vi.resetModules();
  const seam = await import("../src/net/pairing");
  const { ServerProfileStore } = await import("../src/state/servers");
  const client = await import("@ohmail/client-engine");
  const boot = await import("../src/engine/boot");
  const d = door();
  const world = sqlWorld();
  let gate: { promise: Promise<void>; release: () => void } | null = null;
  let reached = false;
  const engineDeps: MobileEngineDeps = {
    openExecutor: async (name: string) => {
      if (gate !== null) { reached = true; const g = gate; gate = null; await g.promise; }
      return world.open(name);
    },
    deleteDatabase: world.drop,
    uuid: () => "00000000-0000-4000-8000-000000000000",
  };
  const profiles = new ServerProfileStore(memoryKV());
  const env: PairingEnv = { profiles, engineDeps, fetchImpl: d.fetchImpl };
  const row = await profiles.add({ origin: ORIGIN, flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1", ...(apiBase ? { apiBase } : {}) });
  const mirror = client.mirrorDbName(boot.mirrorOwnerKey(ORIGIN, "acct-1"));
  const armBootGate = () => {
    let release = (): void => undefined;
    const promise = new Promise<void>((r) => { release = r; });
    gate = { promise, release };
    return { reached: () => reached, release };
  };
  return { seam, d, world, env, profiles, id: row.id, mirror, armBootGate };
}

function live(o: ConnectOutcome) {
  if (o.kind !== "connected") throw new Error(`not connected: ${JSON.stringify(o)}`);
  return o.session;
}

beforeEach(() => { vi.resetModules(); });

describe("a death between the reconnect's read of it and its listener's subscription", () => {
  for (const how of ["erased", "revoked"] as const) {
    it(`(ii ${how}) lands on the reconnect's listener once, on a microtask, never synchronously`, async () => {
      // MUTATIONS WATCHED: sticky delivery removed — the listener never hears it; delivery made
      // synchronous — `ended` would be painted over by `live`, and `deaths` is filled at once.
      const t = await setup(ORIGIN);
      const s1 = live(await t.seam.connectProfileById(t.env, t.id));
      expect((await s1.fetch(ROUTE)).status, "s1 warm: rotated once").toBe(204);
      t.d.holdNextRead();
      const r1 = s1.fetch(ROUTE);
      await turns(() => t.d.readHeld());
      expect(t.d.readHeld(), "the torn-down tree's last read is on the wire").toBe(true);
      const g = t.armBootGate();
      const p2 = t.seam.connectProfileById(t.env, t.id);
      await turns(() => g.reached());
      expect(g.reached(), "the reconnect is inside the boot, past its reads of the manager").toBe(true);
      t.d.end(how);
      await r1;
      expect(s1.bearer!.paired(), "the shared manager died").toBe(false);
      g.release();
      const s2 = live(await p2);
      expect(s2.bearer).toBe(s1.bearer);

      // What `adopt` does: subscribe, then paint `live`. The death must arrive after the paint.
      const deaths: SessionDeath[] = [];
      let forgot: Promise<unknown> | null = null;
      s2.bearer!.onSessionDead((why) => {
        deaths.push(why);
        // The listener's own ceremony for an erased account: the Forget, once the handles close.
        if (why === "erased") {
          const closed = Promise.resolve().then(() => { s2.store.close(); s1.store.close(); });
          forgot = t.seam.forgetProfile(t.env, t.id, { closed, revoke: async () => true });
        }
      });
      expect(deaths, "never synchronously").toEqual([]);
      await Promise.resolve();
      expect(deaths, "once, on a microtask").toEqual([how]);
      await turns(() => false, 5);
      expect(deaths, "and only once").toEqual([how]);
      expect(s2.bearer!.death, "the manager's own fact").toBe(how);
      if (how === "erased") {
        expect(forgot).not.toBeNull();
        expect(await forgot).toMatchObject({ kind: "forgotten" });
        expect(await t.profiles.list(), "the erased account's pairing is gone").toEqual([]);
        expect(t.world.names(), "and its mail").not.toContain(t.mirror);
      } else {
        s2.store.close(); s1.store.close();
      }
    });
  }

  it("(i erased) a death still settling when the reconnect meets the dead manager answers as that death", async () => {
    // MUTATION WATCHED: the `!paired()` arm's await removed — "pair again" for an erased account,
    // and no `died`, so the connection layer never runs the Forget.
    const t = await setup(null); // a self-host row with no measured base re-probes inside buildSession
    const s1 = live(await t.seam.connectProfileById(t.env, t.id));
    expect((await s1.fetch(ROUTE)).status).toBe(204);
    t.d.holdNextRead();
    const r1 = s1.fetch(ROUTE);
    await turns(() => t.d.readHeld());
    t.d.holdBaseProbe();
    const p2 = t.seam.connectProfileById(t.env, t.id);
    await turns(() => t.d.baseHeld());
    expect(t.d.baseHeld(), "the reconnect is measuring the base, past its first read of the death").toBe(true);
    t.d.end("erased");
    await r1;
    t.d.releaseBase();
    const o2 = await p2;
    expect(o2.kind).toBe("refused");
    if (o2.kind !== "refused") return;
    expect(o2.died).toBe("erased");
    expect(o2.reason.say).toBe("accountErased");
    expect(o2.needsRepair).toBe(false);
    s1.store.close();
  });

  it("adopt's listener answers a late death as it answers any: teardown, `ended`, the Forget when erased", () => {
    const text = withoutComments(readFileSync(join(APP, "src/net/connection.tsx"), "utf8"));
    const at = text.indexOf("offDead.current = session.bearer?.onSessionDead((why) => {");
    expect(at, "adopt subscribes the dead signal").toBeGreaterThan(-1);
    const body = text.slice(at, text.indexOf("}) ?? null;", at));
    expect(body).toContain("teardown(session)");
    expect(body).toContain('enter({ k: "ended", reason: deathRefusal(why) })');
    expect(body).toContain("forgetProfile(env, session.profile.id, { closed, revoke: async () => true })");
    expect(text.indexOf('enter({ k: "live", session })', at), "and paints `live` after subscribing").toBeGreaterThan(at);
  });
});

describe("the manager tells each listener of its death exactly once", () => {
  it("a subscriber during the held clear hears it from the loop, a later one on a microtask, and a second death is no death", async () => {
    // MUTATION WATCHED: the death settled before the clear's await — the subscriber during the
    // clear is told twice, once by the loop and once as a late subscriber.
    const { BearerManagerRN } = await import("../src/net/bearer");
    let releaseClear = (): void => undefined;
    const clearHeld = new Promise<void>((r) => { releaseClear = r; });
    const vault: RefreshVault = {
      save: async () => "landed",
      armAttempt: async () => "landed",
      clear: async () => { await clearHeld; return "landed"; },
      oweSignOut: async () => false,
    };
    const fetchImpl = async (url: string): Promise<Response> =>
      url.endsWith("/auth/refresh") ? json(401, REUSE) : new Response(null, { status: 401 });
    const m = new BearerManagerRN({ origin: ORIGIN, refreshToken: "ref-1", accountId: "acct-1", vault, fetchImpl });
    const first = m.fetch(ROUTE);
    await turns(() => m.deathSettled() !== null);
    expect(m.paired(), "the manager is dying").toBe(false);
    expect(m.death, "not settled while the clear is held").toBeNull();
    const a: SessionDeath[] = [];
    m.onSessionDead((why) => a.push(why));
    releaseClear();
    await first;
    expect(m.death).toBe("revoked");
    await turns(() => false, 5);
    expect(a, "the subscriber during the clear: once, from the loop").toEqual(["revoked"]);

    const b: SessionDeath[] = [];
    m.onSessionDead((why) => b.push(why));
    expect(b).toEqual([]);
    await Promise.resolve();
    expect(b, "a subscriber after the death: once, on a microtask").toEqual(["revoked"]);

    expect(await m.logout(), "a second death: the server has nothing left to be told").toBe(true);
    await turns(() => false, 5);
    expect(a).toEqual(["revoked"]);
    expect(b).toEqual(["revoked"]);
    expect(await m.deathSettled(), "the one death").toBe("revoked");
  });
});
