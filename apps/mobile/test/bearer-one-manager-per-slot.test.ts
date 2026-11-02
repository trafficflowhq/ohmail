/**
 * ONE MANAGER PER PAIRING SLOT FOR THE WHOLE JS PROCESS, driven through the real seam: the profile
 * store over a memory keystore, `connectProfileById`, the engine boot, and a door that rotates
 * single-use and sweeps a family on a spent token. An Android activity recreate rebuilds the React
 * tree inside the same runtime, so the connection layer connects the same profile again while the
 * previous tree's rotation is still on the wire; two managers there present one token twice.
 * Each case imports the seam afresh (`vi.resetModules`), so the process registry starts empty.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileEngineDeps } from "../src/engine/boot";
import type { ConnectedSession, ConnectOutcome, PairAdmission, PairingEnv } from "../src/net/pairing";
import type { SecureKV, ServerProfileStore } from "../src/state/servers";
import type { SessionDeath } from "../src/net/bearer";
import { sqlWorld } from "./helpers/pair-server";

const ORIGIN = "https://a.example";
const ROUTE = `${ORIGIN}/sync/changes`;
const REUSE_BODY = JSON.stringify({ error: { code: "unauthorized", message: "refresh token reuse detected" } });

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}

/**
 * The door: one rotation per token; a spent token re-presented under the attempt that spent it is
 * answered off the live line; any other presentation of a spent token sweeps the family. `hold()`
 * keeps every refresh ANSWER on the wire after the server has committed the rotation, which is the
 * window a recreate lands in. A swept family refuses its access tokens too. The refresh sign-out
 * door ends the family any of its tokens names, spent or not, and sweeps nothing; an older server
 * (`refreshDoor: false`) has none.
 */
function doorModel(opts: { refreshDoor?: boolean } = {}) {
  const wire: Array<{ token?: string; attemptId?: string }> = [];
  let head = "ref-1";
  let minted = 0;
  let revoked = false;
  let ended = false;
  const spentBy = new Map<string, string | undefined>();
  let held: { promise: Promise<void>; release: () => void } | null = null;
  const json = (status: number, body: string): Response =>
    new Response(body, { status, headers: { "content-type": "application/json" } });
  const mint = (): Response => {
    minted += 1;
    head = `ref-${minted + 1}`;
    return json(200, JSON.stringify({ tokens: { accessToken: `acc-${minted}`, refreshToken: head } }));
  };
  const refresh = (body: { refreshToken?: string; attemptId?: string }): Response => {
    wire.push({ token: body.refreshToken, attemptId: body.attemptId });
    if (revoked) return json(401, REUSE_BODY);
    const presented = body.refreshToken ?? "";
    if (spentBy.has(presented)) {
      const by = spentBy.get(presented);
      if (by !== undefined && by === body.attemptId && !spentBy.has(head)) {
        spentBy.set(head, body.attemptId);
        return mint();
      }
      revoked = true;
      return json(401, REUSE_BODY);
    }
    if (presented !== head) return json(401, REUSE_BODY);
    spentBy.set(presented, body.attemptId);
    return mint();
  };
  const fetchImpl = async (url: string, init?: unknown): Promise<Response> => {
    const sent = (init ?? {}) as { body?: string; headers?: Record<string, string> };
    if (url.endsWith("/auth/refresh")) {
      const answer = refresh(JSON.parse(sent.body ?? "{}") as { refreshToken?: string; attemptId?: string });
      if (held !== null) await held.promise;
      return answer;
    }
    if (url.endsWith("/auth/refresh/logout")) {
      if (opts.refreshDoor === false) return new Response(null, { status: 404 });
      const presented = (JSON.parse(sent.body ?? "{}") as { refreshToken?: string }).refreshToken ?? "";
      if (presented !== head && !spentBy.has(presented)) {
        return json(401, JSON.stringify({ error: { code: "unauthorized", message: "nothing to sign out" } }));
      }
      ended = true;
      return new Response(null, { status: 204 });
    }
    const auth = sent.headers?.authorization ?? "";
    if (revoked || ended || !auth.startsWith("Bearer acc-")) return new Response(null, { status: 401 });
    return new Response(null, { status: 204 });
  };
  return {
    fetchImpl,
    wire,
    isRevoked: () => revoked,
    isEnded: () => ended,
    presentationsOf: (token: string) => wire.filter((w) => w.token === token).length,
    hold: () => {
      let release = (): void => undefined;
      const promise = new Promise<void>((r) => { release = r; });
      held = { promise, release };
    },
    release: () => { const h = held; held = null; h?.release(); },
  };
}

/**
 * The same door with PAIRING in it: every redeem mints a new family (`f<n>-ref-1`), each family
 * rotates single-use on its own, and `release(how)` can deliver a held rotation's answer as the
 * reuse refusal although the door committed it — the answer an old family's manager gets when it
 * has lost its slot. `expireAccess()` makes every held manager's next request 401.
 */
function familyDoor() {
  const wire: Array<{ token?: string; attemptId?: string }> = [];
  const head = new Map<string, string>();
  const rotations = new Map<string, number>();
  const familyOf = new Map<string, string>();
  const spentBy = new Map<string, string | undefined>();
  const swept = new Set<string>();
  const honoured = new Set<string>();
  let families = 0;
  let held: { promise: Promise<void>; release: () => void; refuse: boolean } | null = null;
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const reuse = (): Response => json(401, JSON.parse(REUSE_BODY) as unknown);
  const pair = (family: string, n: number) => {
    const tokens = { accessToken: `${family}-acc-${n}`, refreshToken: `${family}-ref-${n}` };
    head.set(family, tokens.refreshToken);
    familyOf.set(tokens.refreshToken, family);
    honoured.add(tokens.accessToken);
    return tokens;
  };
  const rotate = (family: string): Response => {
    const n = (rotations.get(family) ?? 0) + 1;
    rotations.set(family, n);
    return json(200, { tokens: pair(family, n + 1) });
  };
  const refresh = (body: { refreshToken?: string; attemptId?: string }): Response => {
    wire.push({ token: body.refreshToken, attemptId: body.attemptId });
    const presented = body.refreshToken ?? "";
    const family = familyOf.get(presented);
    if (family === undefined || swept.has(family)) return reuse();
    if (spentBy.has(presented)) {
      const current = head.get(family)!;
      if (spentBy.get(presented) === body.attemptId && !spentBy.has(current)) {
        spentBy.set(current, body.attemptId);
        return rotate(family);
      }
      swept.add(family);
      return reuse();
    }
    if (presented !== head.get(family)) return reuse();
    spentBy.set(presented, body.attemptId);
    return rotate(family);
  };
  const fetchImpl = async (url: string, init?: unknown): Promise<Response> => {
    const opts = (init ?? {}) as { body?: string; headers?: Record<string, string> };
    const bearer = (opts.headers?.authorization ?? "").replace(/^Bearer /, "");
    if (url.endsWith("/pair/redeem")) {
      families += 1;
      return json(200, { grant: "device-pair", tokens: pair(`f${families}`, 1) });
    }
    if (url.endsWith("/auth/refresh")) {
      const answer = refresh(JSON.parse(opts.body ?? "{}") as { refreshToken?: string; attemptId?: string });
      if (held === null) return answer;
      const hold = held;
      await hold.promise;
      return hold.refuse ? reuse() : answer;
    }
    if (!honoured.has(bearer)) return new Response(null, { status: 401 });
    if (url.endsWith("/auth/session")) return json(200, { user: { accountId: "acct-1" } });
    return new Response(null, { status: 204 });
  };
  return {
    fetchImpl,
    wire,
    expireAccess: () => honoured.clear(),
    hold: () => {
      let release = (): void => undefined;
      const promise = new Promise<void>((r) => { release = r; });
      held = { promise, release, refuse: false };
    },
    release: (how: "minted" | "refused") => {
      const h = held;
      held = null;
      if (h === null) return;
      h.refuse = how === "refused";
      h.release();
    },
  };
}

const ADMISSION: PairAdmission = {
  origin: ORIGIN, pin: null, flavor: "selfhost", apiBase: ORIGIN, provisionalPin: false, probed: true,
};

type Seam = typeof import("../src/net/pairing");

async function freshProcess(): Promise<{ seam: Seam; Store: typeof ServerProfileStore }> {
  const seam = await import("../src/net/pairing");
  const { ServerProfileStore: Store } = await import("../src/state/servers");
  return { seam, Store };
}

function envOver(profiles: ServerProfileStore, fetchImpl: PairingEnv["fetchImpl"]): PairingEnv {
  const world = sqlWorld();
  const engineDeps: MobileEngineDeps = {
    openExecutor: world.open,
    deleteDatabase: world.drop,
    uuid: () => "00000000-0000-4000-8000-000000000000",
  };
  return { profiles, engineDeps, fetchImpl };
}

function live(outcome: ConnectOutcome): ConnectedSession {
  if (outcome.kind !== "connected") throw new Error(`not connected: ${JSON.stringify(outcome)}`);
  return outcome.session;
}

/** Macrotask turns until `done()` or the bound: the keystore writes settle in microtasks. */
async function turns(done: () => boolean, max = 50): Promise<void> {
  for (let i = 0; i < max && !done(); i++) await new Promise((r) => setTimeout(r, 0));
}

/** The recreate, twice, while the first session's rotation is held on the wire. */
async function recreateTwiceMidRotation(
  env: PairingEnv, seam: Seam, id: string, door: ReturnType<typeof doorModel>,
) {
  const deaths: SessionDeath[] = [];
  const s1 = live(await seam.connectProfileById(env, id));
  s1.bearer!.onSessionDead((why) => deaths.push(why));
  door.hold();
  const r1 = s1.fetch(ROUTE);
  await turns(() => door.wire.length >= 1);
  expect(door.wire.length, "the first rotation is on the wire and held").toBe(1);
  const s2 = live(await seam.connectProfileById(env, id));
  s2.bearer!.onSessionDead((why) => deaths.push(why));
  const r2 = s2.fetch(ROUTE);
  const s3 = live(await seam.connectProfileById(env, id));
  s3.bearer!.onSessionDead((why) => deaths.push(why));
  const r3 = s3.fetch(ROUTE);
  await turns(() => door.wire.length >= 3);
  door.release();
  const statuses = (await Promise.all([r1, r2, r3])).map((r) => r.status);
  for (const s of [s1, s2, s3]) s.store.close();
  return { s1, s2, s3, deaths, statuses, door };
}

async function pairedRow(profiles: ServerProfileStore): Promise<string> {
  const row = await profiles.add({
    origin: ORIGIN, flavor: "selfhost", accountId: "acct-1", refreshToken: "ref-1", apiBase: ORIGIN,
  });
  return row.id;
}

beforeEach(() => {
  vi.resetModules();
});

describe("one bearer manager per pairing slot, for the process", () => {
  it("a recreate twice mid-rotation presents the token ONCE — the process registry", async () => {
    // MUTATION WATCHED: the registry's held-or-construct decision made "always construct" — the
    // recreated sessions get their own managers, `ref-1` is presented three times, and the
    // managers are not the same instance.
    const { seam, Store } = await freshProcess();
    const door = doorModel();
    const profiles = new Store(memoryKV());
    const env = envOver(profiles, door.fetchImpl);
    const id = await pairedRow(profiles);

    const { s1, s2, s3, deaths, statuses } = await recreateTwiceMidRotation(env, seam, id, door);

    expect(door.presentationsOf("ref-1"), "one presentation of the head").toBe(1);
    expect(door.isRevoked(), "the family is not swept").toBe(false);
    expect(deaths, "no session dies").toEqual([]);
    expect(s2.bearer).toBe(s1.bearer);
    expect(s3.bearer).toBe(s1.bearer);
    expect(statuses, "every request is answered on the fresh pair").toEqual([204, 204, 204]);
    expect((await profiles.list())[0]!.refreshToken, "the keystore holds the successor").toBe("ref-2");
  });

  it("an explicit registry is the one used, and the process registry stays empty", async () => {
    const { seam, Store } = await freshProcess();
    const { BearerRegistry, bearers } = await import("../src/net/bearer-registry");
    const door = doorModel();
    const profiles = new Store(memoryKV());
    const own = new BearerRegistry();
    const env: PairingEnv = { ...envOver(profiles, door.fetchImpl), bearers: own };
    const id = await pairedRow(profiles);

    const { s1, s2, deaths } = await recreateTwiceMidRotation(env, seam, id, door);

    expect(door.presentationsOf("ref-1")).toBe(1);
    expect(deaths).toEqual([]);
    expect(s2.bearer).toBe(s1.bearer);
    const load = (): never => { throw new Error("the process slot is empty"); };
    expect(() => bearers.managerFor(id, load), "nothing was built in the process registry").toThrow("empty");
    expect(own.managerFor(id, load)).toBe(s1.bearer);
  });

  it("a cold launch resumes the attempt a killed rotation left unanswered — no sweep", async () => {
    // MUTATION WATCHED: the slot's load passing `refreshAttempt: null` — the launch presents the
    // spent head under a fresh name, the door reads a stranger, and the family is swept.
    const { seam, Store } = await freshProcess();
    const door = doorModel();
    const profiles = new Store(memoryKV());
    const env = envOver(profiles, door.fetchImpl);
    const id = await pairedRow(profiles);
    // The killed process: its attempt was armed, the door committed it, the answer never arrived.
    await profiles.armRefreshAttempt(id, "r-killed-attempt", "ref-1", new Set(["ref-1"]));
    await door.fetchImpl(`${ORIGIN}/auth/refresh`, {
      method: "POST", body: JSON.stringify({ refreshToken: "ref-1", attemptId: "r-killed-attempt" }),
    });
    const deaths: SessionDeath[] = [];
    const s = live(await seam.connectProfileById(env, id));
    s.bearer!.onSessionDead((why) => deaths.push(why));

    expect((await s.fetch(ROUTE)).status).toBe(204);
    s.store.close();

    expect(door.wire[1], "the launch repeats the attempt it owed").toEqual({ token: "ref-1", attemptId: "r-killed-attempt" });
    expect(door.isRevoked()).toBe(false);
    expect(deaths).toEqual([]);
    const row = (await profiles.list())[0]!;
    expect(row.refreshToken).toBe("ref-3");
    expect(row.refreshAttempt, "answered, and cleared").toBeNull();
  });

  it("a forget of a slot nobody holds ends the family its spent token names: nothing renewed, nothing swept", async () => {
    // The sign-out renews nothing: the refresh door ends the family whichever of its tokens it is
    // shown, so the token a killed rotation spent is presented there and nowhere else.
    const { seam, Store } = await freshProcess();
    const door = doorModel();
    const profiles = new Store(memoryKV());
    const env = envOver(profiles, door.fetchImpl);
    const id = await pairedRow(profiles);
    await profiles.armRefreshAttempt(id, "r-killed-attempt", "ref-1", new Set(["ref-1"]));
    await door.fetchImpl(`${ORIGIN}/auth/refresh`, {
      method: "POST", body: JSON.stringify({ refreshToken: "ref-1", attemptId: "r-killed-attempt" }),
    });
    const row = (await profiles.list())[0]!;

    expect(await seam.revokeProfile(env, row), "the server was told").toBe(true);
    expect(door.wire, "the sign-out renewed the session it was ending").toHaveLength(1);
    expect(door.isEnded(), "the family the spent token names is over").toBe(true);
    expect(door.isRevoked(), "a sign-out is not a reuse").toBe(false);
  });

  it("an older server with no refresh door: the routed sign-out's recovery retries the owed attempt", async () => {
    // MUTATION WATCHED: `revokeProfile`'s load passing `refreshAttempt: null` — the logout's
    // recovery presents the spent head under a fresh name and the door sweeps the family.
    const { seam, Store } = await freshProcess();
    const door = doorModel({ refreshDoor: false });
    const profiles = new Store(memoryKV());
    const env = envOver(profiles, door.fetchImpl);
    const id = await pairedRow(profiles);
    await profiles.armRefreshAttempt(id, "r-killed-attempt", "ref-1", new Set(["ref-1"]));
    await door.fetchImpl(`${ORIGIN}/auth/refresh`, {
      method: "POST", body: JSON.stringify({ refreshToken: "ref-1", attemptId: "r-killed-attempt" }),
    });
    const row = (await profiles.list())[0]!;

    expect(await seam.revokeProfile(env, row), "the server was told").toBe(true);
    expect(door.wire[1], "the logout's recovery repeats the owed attempt").toEqual({ token: "ref-1", attemptId: "r-killed-attempt" });
    expect(door.isRevoked(), "a retry of an owed attempt is not a reuse").toBe(false);
  });

  it("a launch's wake drain, the first to build the slot's manager, retries the owed attempt", async () => {
    // MUTATION WATCHED: the drain's load passing `refreshAttempt: null` — the manager that holds the
    // slot for the whole process presents the spent head under a fresh name and the door sweeps.
    const { seam, Store } = await freshProcess();
    const door = doorModel();
    const profiles = new Store(memoryKV());
    const env = envOver(profiles, door.fetchImpl);
    const id = await pairedRow(profiles);
    await profiles.armRefreshAttempt(id, "r-killed-attempt", "ref-1", new Set(["ref-1"]));
    await door.fetchImpl(`${ORIGIN}/auth/refresh`, {
      method: "POST", body: JSON.stringify({ refreshToken: "ref-1", attemptId: "r-killed-attempt" }),
    });
    await profiles.markPendingWakeDrop(id, "sub-1");

    expect(await seam.drainPendingWakeDrops(env), "the wake row was taken down").toEqual([]);
    expect(door.wire[1], "the drain repeats the owed attempt").toEqual({ token: "ref-1", attemptId: "r-killed-attempt" });
    expect(door.isRevoked()).toBe(false);
    const s = live(await seam.connectProfileById(env, id));
    expect((await s.fetch(ROUTE)).status, "the launch's session rides the drain's manager").toBe(204);
    s.store.close();
  });

  it("THIEF: a second holder outside the registry presenting a spent token still ends the family", async () => {
    // The server is untouched: a spent token under another name is the sweep, and each holder
    // reads the door's reuse sentence as `revoked`, never as an ordinary end.
    const { seam, Store } = await freshProcess();
    const { BearerManagerRN } = await import("../src/net/bearer");
    const door = doorModel();
    const profiles = new Store(memoryKV());
    const env = envOver(profiles, door.fetchImpl);
    const id = await pairedRow(profiles);
    const honest = live(await seam.connectProfileById(env, id));
    const honestDeaths: SessionDeath[] = [];
    honest.bearer!.onSessionDead((why) => honestDeaths.push(why));
    expect((await honest.fetch(ROUTE)).status, "the honest holder rotates ref-1").toBe(204);

    const thiefDeaths: SessionDeath[] = [];
    const thief = new BearerManagerRN({
      origin: ORIGIN, refreshToken: "ref-1",
      vault: { save: async () => "no_row", clear: async () => "no_row", armAttempt: async () => "no_row" },
      fetchImpl: door.fetchImpl,
    });
    thief.onSessionDead((why) => thiefDeaths.push(why));
    expect((await thief.fetch(ROUTE)).status).toBe(401);
    expect(door.isRevoked(), "a spent token under another name sweeps").toBe(true);
    expect(thiefDeaths).toEqual(["revoked"]);

    expect((await honest.fetch(ROUTE)).status).toBe(401);
    honest.store.close();
    expect(honestDeaths, "the honest holder is told the family was swept").toEqual(["revoked"]);
    expect(door.presentationsOf("ref-1"), "the honest presentation and the thief's").toBe(2);
  });
});

/** The answer the store gave the first write whose arguments `pick` chose. */
async function wordFor(
  spy: { mock: { calls: unknown[][]; results: Array<{ value: unknown }> } }, pick: (args: unknown[]) => boolean, what: string,
) {
  const i = spy.mock.calls.findIndex(pick);
  if (i < 0) throw new Error(`no write ${what}`);
  return spy.mock.results[i]!.value as Promise<string>;
}
/** A write's `held` chain includes `token`. */
const heldHas = (args: unknown[], at: number, token: string): boolean =>
  args[at] instanceof Set && (args[at] as Set<string>).has(token);

/**
 * ONE SETUP: pair (the old family's manager), 401 it so its rotation is on the wire and held,
 * then pair the same account again (tok-2) the way the connection layer does — the live session
 * torn down first — so the slot now holds the new family's manager,.
 */
async function repairWhileRotating() {
  const { seam, Store } = await freshProcess();
  const door = familyDoor();
  const profiles = new Store(memoryKV());
  const env = envOver(profiles, door.fetchImpl);
  const spies = {
    save: vi.spyOn(profiles, "saveRefreshToken"),
    clear: vi.spyOn(profiles, "clearRefreshToken"),
    arm: vi.spyOn(profiles, "armRefreshAttempt"),
  };
  const first = await seam.pairWithServer(env, { admission: ADMISSION, token: "tok-1" });
  if (first.kind !== "paired") throw new Error(`first pairing refused: ${JSON.stringify(first)}`);
  const s1 = first.session;
  const m1 = s1.bearer!;
  const m1Deaths: SessionDeath[] = [];
  m1.onSessionDead((why) => m1Deaths.push(why));
  door.expireAccess();
  door.hold();
  const r1 = s1.fetch(ROUTE);
  await turns(() => door.wire.length >= 1);
  expect(door.wire[0]?.token, "the old family's rotation is on the wire").toBe("f1-ref-1");
  s1.store.close();
  const second = await seam.pairWithServer(env, { admission: ADMISSION, token: "tok-2" });
  if (second.kind !== "paired") throw new Error(`re-pair refused: ${JSON.stringify(second)}`);
  const s2 = second.session;
  const m2 = s2.bearer!;
  const m2Deaths: SessionDeath[] = [];
  m2.onSessionDead((why) => m2Deaths.push(why));
  expect(s2.profile.id, "a re-pair keeps the row").toBe(s1.profile.id);
  expect(m2, "the slot holds the new family's manager").not.toBe(m1);
  return { seam, door, profiles, env, spies, s1, m1, m1Deaths, r1, s2, m2, m2Deaths };
}

describe("a re-pair replaces the slot's family, and the old family's manager writes nothing", () => {
  it("(a) the old rotation lands MINTED: its save is superseded, the row keeps the redeem's token", async () => {
    // MUTATION WATCHED: the comparison removed from `saveRefreshToken` — the old family's
    // successor overwrites the new pairing's token and the word reads `landed`.
    const t = await repairWhileRotating();
    t.door.release("minted");
    expect((await t.r1).status).toBe(204);
    expect(await wordFor(t.spies.save, (a) => a[1] === "f1-ref-2", "saving f1-ref-2")).toBe("superseded");
    const row = (await t.profiles.list())[0]!;
    expect(row.refreshToken).toBe("f2-ref-1");
    expect(row.refreshAttempt).toBeNull();
    // The admit control, same setup: the slot's current holder still writes.
    t.door.expireAccess();
    expect((await t.s2.fetch(ROUTE)).status).toBe(204);
    expect(await wordFor(t.spies.save, (a) => a[1] === "f2-ref-2", "saving f2-ref-2")).toBe("landed");
    expect((await t.profiles.list())[0]!.refreshToken).toBe("f2-ref-2");
    t.s2.store.close();
  });

  it("(b) the old rotation is REFUSED: its death clears nothing, and the new session lives", async () => {
    // MUTATION WATCHED: the comparison removed from `clearRefreshToken` — the old family's
    // death signs the new pairing out.
    const t = await repairWhileRotating();
    t.door.release("refused");
    expect((await t.r1).status).toBe(401);
    expect(t.m1Deaths).toEqual(["revoked"]);
    expect(await wordFor(t.spies.clear, (a) => heldHas(a, 1, "f1-ref-1"), "clearing the old chain")).toBe("superseded");
    expect((await t.profiles.list())[0]!.refreshToken, "the row keeps the new family").toBe("f2-ref-1");
    expect(t.m2Deaths, "the new session's listener never fires").toEqual([]);
    const again = live(await t.seam.connectProfileById(t.env, t.s2.profile.id));
    expect(again.bearer, "a replaced manager's death is not the slot's").toBe(t.m2);
    again.store.close();
    t.s2.store.close();
  });

  it("(c) the old family rotates again: its armed attempt is superseded, the row owes none", async () => {
    // MUTATION WATCHED: the comparison removed from `armRefreshAttempt` — the old family's
    // attempt id lands beside the new family's token.
    const t = await repairWhileRotating();
    t.door.release("minted");
    await t.r1;
    t.door.expireAccess();
    expect((await t.m1.fetch(ROUTE)).status).toBe(204);
    expect(await wordFor(t.spies.arm, (a) => a[2] === "f1-ref-2", "arming over f1-ref-2")).toBe("superseded");
    const row = (await t.profiles.list())[0]!;
    expect(row.refreshAttempt, "no attempt stands beside the new family's token").toBeNull();
    expect(row.refreshToken).toBe("f2-ref-1");
    t.s2.store.close();
  });
});
