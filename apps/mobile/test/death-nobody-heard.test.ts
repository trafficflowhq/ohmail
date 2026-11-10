/**
 * A DEATH NOBODY WAS SUBSCRIBED TO IS STILL TOLD, AND AN ERASED ACCOUNT OR A REVOKED SESSION STILL
 * LEAVES NO COPY. The launch pays the wake-row debts before it connects, through the slot's own
 * manager, and that manager can hear `410 account_erased` or `refresh_revoked` with no session
 * listening yet. The registry hears every death of a manager it holds; the next connect answers with
 * it; and such a verdict is written down as an owed Forget BEFORE the credential goes, so a kill
 * between the two is paid by the next launch. A lapse keeps the row and the mirror. Each "process"
 * is a fresh module graph over the same keystore map and the same mirrors.
 */
/* @reads: apps/mobile/src/net/connection.tsx */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { withoutCommentsAndLiterals, withoutComments } from "../../../scripts/lib/source-scan.mjs";
import type { MobileEngineDeps } from "../src/engine/boot";
import type { PairingEnv } from "../src/net/pairing";
import type { SecureKV } from "../src/state/servers";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ERASED_LINE = '{"service":"pairing","event":"session_dead","why":"erased"}';
const REVOKED_LINE = '{"service":"pairing","event":"session_dead","why":"signedOutElsewhere"}';

/** The device keystore: one map that outlives every process, read through a fresh door each time. */
function keystore() {
  const map = new Map<string, string>();
  let dead = false;
  /** Every operation after `killAfter` saw its write land never returns: the process is gone. */
  let killAfter: ((key: string, value: string) => boolean) | null = null;
  /** The next `set` of this key throws, once — a keystore that refused one write. */
  let refuseNextSetOf: string | null = null;
  /** The next `remove` of this key throws, once. */
  let refuseNextRemoveOf: string | null = null;
  const hang = <T>(): Promise<T> => new Promise<T>(() => undefined);
  const door = (): SecureKV => ({
    get: async (k) => (dead ? hang<string | null>() : map.get(k) ?? null),
    set: async (k, v) => {
      if (dead) return hang<void>();
      if (k === refuseNextSetOf) { refuseNextSetOf = null; throw new Error("the keystore refused the write"); }
      map.set(k, v);
      if (killAfter?.(k, v)) dead = true;
    },
    remove: async (k) => {
      if (dead) return hang<void>();
      if (k === refuseNextRemoveOf) { refuseNextRemoveOf = null; throw new Error("the keystore refused the removal"); }
      map.delete(k);
    },
  });
  return {
    map,
    door,
    killWhen: (p: (key: string, value: string) => boolean) => { killAfter = p; },
    killed: () => dead,
    revive: () => { dead = false; killAfter = null; },
    refuseNextSet: (k: string) => { refuseNextSetOf = k; },
    refuseNextRemove: (k: string) => { refuseNextRemoveOf = k; },
  };
}

/** A fresh process: its own module instances, so its own registry, sink and store classes. */
async function launch() {
  vi.resetModules();
  const pairing = await import("../src/net/pairing");
  const helpers = await import("./helpers/pair-server");
  const { ServerProfileStore } = await import("../src/state/servers");
  const log = await import("../src/engine/engine-log");
  const boot = await import("../src/engine/boot");
  const client = await import("@ohmail/client-engine");
  return { pairing, helpers, ServerProfileStore, log, boot, client };
}

type World = ReturnType<Awaited<ReturnType<typeof launch>>["helpers"]["sqlWorld"]>;

function envOf(p: Awaited<ReturnType<typeof launch>>, kv: SecureKV, world: World): PairingEnv {
  const engineDeps: MobileEngineDeps = {
    openExecutor: world.open, deleteDatabase: world.drop, uuid: () => "00000000-0000-4000-8000-000000000000",
  };
  return { profiles: new p.ServerProfileStore(kv), engineDeps };
}

type Fake = ReturnType<Awaited<ReturnType<typeof launch>>["helpers"]["pairServer"]>;

/** Pair an account on its own server in process one, owe one wake-row deletion, then `end` it at the server. */
async function pairedThenEnded(end: (fake: Fake) => void) {
  const first = await launch();
  const store = keystore();
  const world = first.helpers.sqlWorld();
  const fake = first.helpers.pairServer({ flavor: "desktop-host", sessionRoute: false, accountId: "acct-x" });
  const origin = await first.helpers.listen(fake.server);
  fake.addMessage("m-x", "the letter of acct-x");
  fake.mintPairToken("tok-x");
  const env = envOf(first, store.door(), world);
  const paired = await first.helpers.pairThroughConfirm(env, { origin, token: "tok-x" });
  if (paired.kind !== "paired") throw new Error(`pairing refused: ${JSON.stringify(paired)}`);
  paired.session.store.close();
  const id = paired.session.profile.id;
  await env.profiles.markPendingWakeDrop(id, "sub-1");
  end(fake);
  const mirror = first.client.mirrorDbName(first.boot.mirrorOwnerKey(origin, "acct-x"));
  expect(world.names(), "the mirror is on the phone before the session ended").toContain(mirror);
  return { store, world, fake, origin, id, mirror };
}

/**
 * THE TWO DEATHS THAT TAKE THE COPY: the account erased, and the session revoked at its server by
 * code (Devices, sign out everywhere, a credential change — `refresh_revoked`). Both owe the Forget
 * before the credential goes; the erasure says so, a revoke says the pairing ended.
 */
const COPY_GOES = [
  { name: "an erased account", end: (f: Fake) => f.erase(), died: "erased", say: "accountErased", line: ERASED_LINE },
  {
    name: "a session revoked at its server", end: (f: Fake) => f.revoke("refresh_revoked"),
    died: "signedOutElsewhere", say: "pairEnded", line: REVOKED_LINE,
  },
] as const;

describe.each(COPY_GOES)("$name heard only by the launch's wake drain", ({ end, died, say, line }) => {
  it("(a) same process: the connect answers the death, and the Forget takes the copy", async () => {
    // MUTATIONS WATCHED: `died` dropped in `buildSession` — the connect reads the owed Forget as
    // `forgetStillPending`; the registry's listener not subscribed — no line and no `died`.
    const { store, world, fake, id, mirror } = await pairedThenEnded(end);
    try {
      const p = await launch();
      const env = envOf(p, store.door(), world);
      await p.pairing.drainPendingWakeDrops(env);
      const outcome = await p.pairing.connectProfileById(env, id);
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect(outcome.died).toBe(died);
      expect(outcome.reason.say).toBe(say);
      expect(outcome.removesCopy).toBe(true);
      expect(outcome.needsRepair).toBe(false);
      expect(p.log.recentEngineLines().filter((l) => l === line), "one line for the one death").toHaveLength(1);

      // What `runConnect` answers a death that removes the copy with — the listener's own call, no store to close.
      expect((await p.pairing.forgetProfile(env, id, { revoke: async () => true })).kind).toBe("forgotten");
      expect(await env.profiles.list()).toEqual([]);
      expect(world.names()).not.toContain(mirror);
      expect(await env.profiles.pendingWipes()).toEqual([]);
    } finally {
      fake.server.close();
    }
  }, 60_000);

  it("(b) a kill between the death and the connect: the next launch pays the Forget first", async () => {
    // MUTATION WATCHED: the owed-Forget mark removed from `vaultFor`'s clear, or written after
    // the credential clear — the kill lands between, nothing is owed, and the mirror stays.
    const { store, world, fake, id, mirror } = await pairedThenEnded(end);
    try {
      const b = await launch();
      const profileKey = `ohmail.servers.v1.${id}`;
      store.killWhen((k, v) => k === profileKey && v.includes('"refreshToken":null'));
      void b.pairing.drainPendingWakeDrops(envOf(b, store.door(), world));
      for (let i = 0; i < 2000 && !store.killed(); i++) await new Promise((r) => setTimeout(r, 5));
      expect(store.killed(), "the process died right after the credential was cleared").toBe(true);
      store.revive();

      const c = await launch();
      const env = envOf(c, store.door(), world);
      expect(await c.pairing.drainPendingWipes(env)).toEqual([]);
      expect(await env.profiles.list(), "the ended account's pairing is still here").toEqual([]);
      expect(world.names(), "and its mail").not.toContain(mirror);
      const outcome = await c.pairing.connectProfileById(env, id);
      expect(outcome.kind === "refused" ? outcome.reason.say : outcome.kind).toBe("notPairedHere");
    } finally {
      fake.server.close();
    }
  }, 60_000);
});

describe("the connection layer", () => {
  it("runConnect answers `died` the way the dead-signal listener answers a death", () => {
    const code = withoutCommentsAndLiterals(readFileSync(join(APP, "src/net/connection.tsx"), "utf8"));
    const text = withoutComments(readFileSync(join(APP, "src/net/connection.tsx"), "utf8"));
    const at = code.indexOf("outcome.died !== undefined");
    expect(at, "runConnect reads the death").toBeGreaterThan(-1);
    const arm = text.slice(at, text.indexOf("return { ok: false, reason: outcome.reason };", at));
    expect(arm).toContain('enter({ k: "ended", reason: outcome.reason })');
    expect(arm).toContain("if (outcome.removesCopy === true)");
    expect(arm).toContain('forgetProfile(env, id, { revoke: async () => true, erased: outcome.died === "erased" })');
  });
});

describe.each(COPY_GOES)("$name whose owed Forget cannot be written", ({ end }) => {
  it("(d) skips the credential's clear, and the next launch hears the answer again and owes the Forget", async () => {
    // MUTATION WATCHED: the mark's refusal swallowed — the clear runs with no debt written, the
    // next launch has no token to hear the answer with, and the account's copy stays on the phone.
    const { store, world, fake, id, mirror } = await pairedThenEnded(end);
    try {
      const b = await launch();
      store.refuseNextSet("ohmail.servers.v1"); // the index, where the owed Forget is written
      await b.pairing.drainPendingWakeDrops(envOf(b, store.door(), world));
      const envB = envOf(b, store.door(), world);
      expect(await envB.profiles.pendingWipes(), "the mark did not land").toEqual([]);
      expect((await envB.profiles.list())[0]!.refreshToken, "so the credential was not cleared").not.toBeNull();

      // Killed before any Forget. The next launch presents the kept token and hears it again.
      const c = await launch();
      const env = envOf(c, store.door(), world);
      expect(await c.pairing.drainPendingWipes(env), "nothing owed yet at this launch's first step").toEqual([]);
      await c.pairing.drainPendingWakeDrops(env);
      expect((await env.profiles.pendingWipes()).map((w) => w.id), "the Forget is owed now").toEqual([id]);
      expect((await env.profiles.list())[0]!.refreshToken, "and only then is the credential cleared").toBeNull();
      const d = await launch();
      const envD = envOf(d, store.door(), world);
      expect(await d.pairing.drainPendingWipes(envD), "the launch after pays it").toEqual([]);
      expect(await envD.profiles.list()).toEqual([]);
      expect(world.names()).not.toContain(mirror);
    } finally {
      fake.server.close();
    }
  }, 60_000);
});

describe("an owed Forget whose slot manager died of something else", () => {
  it("is still said as the Forget: only an erasure answers ahead of it", async () => {
    // MUTATION WATCHED: every recorded death answering ahead of the owed Forget — a Forget the
    // person pressed is told as "pair again".
    const p = await launch();
    const store = keystore();
    const world = p.helpers.sqlWorld();
    const REUSE = JSON.stringify({ error: { code: "unauthorized", message: "refresh token reuse detected" } });
    let head = "ref-1"; let n = 1; let loggedOut = false;
    const honoured = new Set<string>();
    const fetchImpl = async (url: string, init?: unknown): Promise<Response> => {
      const opts = (init ?? {}) as { body?: string; headers?: Record<string, string> };
      if (url.endsWith("/auth/refresh")) {
        const body = JSON.parse(opts.body ?? "{}") as { refreshToken?: string };
        if (loggedOut || body.refreshToken !== head) return new Response(REUSE, { status: 401, headers: { "content-type": "application/json" } });
        n += 1; head = `ref-${n}`; honoured.add(`acc-${n}`);
        return new Response(JSON.stringify({ tokens: { accessToken: `acc-${n}`, refreshToken: head } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      const auth = (opts.headers?.authorization ?? "").replace(/^Bearer /, "");
      if (loggedOut || !honoured.has(auth)) return new Response(null, { status: 401 });
      if (url.endsWith("/auth/logout")) { loggedOut = true; return new Response(null, { status: 204 }); }
      return new Response(null, { status: 204 });
    };
    const env: PairingEnv = { ...envOf(p, store.door(), world), fetchImpl };
    const row = await env.profiles.add({ origin: "https://a.example", flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1", apiBase: "https://a.example" });
    // The previous process: Forget pressed and killed before the row went; a wake row owed too.
    await env.profiles.markPendingWipe(row.id, p.boot.mirrorOwnerKey("https://a.example", "acct-1"));
    await env.profiles.markPendingWakeDrop(row.id, "sub-1");
    store.refuseNextRemove(`ohmail.servers.v1.${row.id}`);
    expect(await p.pairing.drainPendingWipes(env), "the removal was refused, the Forget stays owed").toHaveLength(1);
    await p.pairing.drainPendingWakeDrops(env);
    const outcome = await p.pairing.connectProfileById(env, row.id);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason.say).toBe("forgetStillPending");
  });
});

describe("a swept family heard only by the launch's wake drain", () => {
  it("(c) a revoked death: pair ended, one scan re-pairs, the row and the mirror are kept", async () => {
    const first = await launch();
    const store = keystore();
    const world = first.helpers.sqlWorld();
    const REUSE = JSON.stringify({ error: { code: "unauthorized", message: "refresh token reuse detected" } });
    let swept = false;
    const door = async (url: string, init?: unknown): Promise<Response> => {
      const headers = ((init ?? {}) as { headers?: Record<string, string> }).headers ?? {};
      if (url.endsWith("/auth/refresh")) {
        if (swept) return new Response(REUSE, { status: 401, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ tokens: { accessToken: "acc-1", refreshToken: "ref-2" } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: !swept && headers.authorization === "Bearer acc-1" ? 204 : 401 });
    };
    const origin = "https://a.example";
    const envA: PairingEnv = { ...envOf(first, store.door(), world), fetchImpl: door };
    const row = await envA.profiles.add({ origin, flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1", apiBase: origin });
    const booted = await first.pairing.connectProfileById(envA, row.id);
    if (booted.kind !== "connected") throw new Error("the first boot refused");
    booted.session.store.close();
    const mirror = first.client.mirrorDbName(first.boot.mirrorOwnerKey(origin, "acct-1"));
    await envA.profiles.markPendingWakeDrop(row.id, "sub-1");
    swept = true;

    const p = await launch();
    const env: PairingEnv = { ...envOf(p, store.door(), world), fetchImpl: door };
    await p.pairing.drainPendingWakeDrops(env);
    const outcome = await p.pairing.connectProfileById(env, row.id);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.died).toBe("revoked");
    expect(outcome.reason.say).toBe("pairEnded");
    expect(outcome.needsRepair).toBe(true);
    const kept = await env.profiles.list();
    expect(kept.map((r) => r.id), "the row stays, so one scan re-pairs into it").toEqual([row.id]);
    expect(kept[0]!.refreshToken).toBeNull();
    expect(world.names(), "the mirror stays").toContain(mirror);
    expect(await env.profiles.pendingWipes(), "nothing owes a Forget").toEqual([]);
  }, 60_000);

  it("CONTROL — a lapse (refresh_expired): pair ended, one scan re-pairs, the row and the mirror are kept", async () => {
    const { store, world, fake, id, mirror } = await pairedThenEnded((f) => f.expire());
    try {
      const p = await launch();
      const env = envOf(p, store.door(), world);
      await p.pairing.drainPendingWakeDrops(env);
      const outcome = await p.pairing.connectProfileById(env, id);
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") return;
      expect([outcome.died, outcome.reason.say, outcome.removesCopy, outcome.needsRepair]).toEqual(["refused", "pairEnded", false, true]);
      const kept = await env.profiles.list();
      expect(kept.map((r) => r.id), "the row stays, so one scan re-pairs into it").toEqual([id]);
      expect(kept[0]!.refreshToken).toBeNull();
      expect(world.names(), "the mirror stays").toContain(mirror);
      expect(await env.profiles.pendingWipes(), "nothing owes a Forget").toEqual([]);
    } finally {
      fake.server.close();
    }
  }, 60_000);
});
