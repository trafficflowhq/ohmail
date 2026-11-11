/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  EVERY RENDERED STATE BELONGS TO THE ACCOUNT BEING RENDERED
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Four sequences, one invariant in three halves: a state is read for the account it is shown
 * under, a press reaches the engine or renders why it did not, and one base composes every
 * request. The Stop halves are two of the three Stop defects of this campaign — the third,
 * a resume whose rejection was discarded, belongs to the one-organizer lane.
 *
 * There is no React Native renderer in this workspace, so a decision that a screen makes is
 * driven through the function that makes it and the two lines a component owns are read out of
 * their own source — the idiom `standalone-adopt.test.ts` established for the same reason.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlExecutor, SqlRow, SqlValue } from "@ohmail/client-engine";

import { LOCAL_ENGINE_ORIGIN, type MobileEngineDeps } from "../src/engine/boot";
import {
  endStandaloneHere,
  forgetOrganizerSessionForTests,
  holdStandaloneDoor,
  organizerDoor,
  organizerInstruction,
  organizerSettingsLeftOnlyHere,
  pressOrganizeHere,
  releaseStandaloneLaunch,
  standaloneHere,
  standaloneHereFor,
  takeStandaloneLaunch,
} from "../src/engine/organizer-session";
import { organizesHere, type StandaloneEngine, type StopOrganizingOutcome } from "../src/engine/standalone-door";
import {
  createBackgroundOrganizing,
  STOP_ATTEMPTS,
  STOP_BACKOFF_MS,
  type BackgroundEngine,
  type BackgroundService,
  type ServiceNotice,
} from "../src/engine/background";
import {
  claimChipLabel, claimHere, claimNoteLine, mayStopHere, pressSaidLine, stopAndRemoveAsks,
} from "../src/ui/standalone-form";
import { connectProfile, forgetProfile, listHeldStandalone, type PairingEnv } from "../src/net/pairing";
import { connectionSaid, connectionSay } from "../src/state/live";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import { readFoldersEnabled } from "../src/net/consent";
import { readMailboxes } from "../src/net/mailboxes";
import { readFolderSummary } from "../src/net/folder-ops";
import { EN } from "../src/copy.en";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
const HERE = fileURLToPath(new URL(".", import.meta.url));
const read = (p: string): string => readFileSync(join(HERE, "..", p), "utf8");

const handles: DatabaseSync[] = [];

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}

function nodeSqlExecutor(db: DatabaseSync): SqlExecutor {
  return {
    async all(sql: string, params: ReadonlyArray<SqlValue> = []): Promise<SqlRow[]> {
      return db.prepare(sql).all(...params) as SqlRow[];
    },
    async batch(statements): Promise<void> {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const { sql, params = [] } of statements) db.prepare(sql).run(...params);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
  };
}

function engineDeps(): MobileEngineDeps {
  return {
    openExecutor: () => {
      const db = new sqlite.DatabaseSync(":memory:");
      handles.push(db);
      return nodeSqlExecutor(db);
    },
    deleteDatabase: async () => undefined,
    uuid: () => `33333333-3333-4333-8333-${String(handles.length).padStart(12, "0")}`,
    fetch: async () => {
      throw new Error("the global transport was used on the standalone door");
    },
  };
}

/* ── the door in this process, failing the way the engine fails ──────────────────────────── */

interface DoorLog {
  stopped: number;
  handedBack: number;
  stoppedOrganizing: number;
  /** What `stopOrganizing()` answers — three words; see `StopOrganizingOutcome`. */
  stopOrganizingAnswers: StopOrganizingOutcome;
  organizer: {
    organizing: boolean; heldBy: string | null; reason: string | null;
    releaseRequestedAt: string | null;
  };
  connection: { reachable: boolean; unreachableSince: Date | null; signInRefused: boolean; firstSync: string };
}

const doorLog = (): DoorLog => ({
  stopped: 0,
  handedBack: 0,
  stoppedOrganizing: 0,
  stopOrganizingAnswers: "released",
  organizer: { organizing: true, heldBy: null, reason: null, releaseRequestedAt: null },
  connection: { reachable: true, unreachableSince: null, signInRefused: false, firstSync: "finished" },
});

/**
 * THE DOUBLE FAILS THE WAY PRODUCTION FAILS. On a refused release the engine answers `refused`
 * and reports `organizing: false` with the request still standing on the row — a pass carrying
 * out a release arranges nothing either way. A double answering `organizing: true` there would
 * make the panel's reading look measured while production defeated it.
 */
function fakeDoor(log: DoorLog): StandaloneEngine {
  return {
    accountId: "engine-account",
    address: "held@example.test",
    get sessionToken() { return "engine-launch-token"; },
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.pathname === "/sync/snapshot") {
        return json(200, { asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
      }
      if (url.pathname === "/mailboxes") return json(200, { items: [{ id: "m1", address: "held@example.test" }] });
      return json(404, { error: { code: "not_found", message: url.pathname } });
    },
    async stop() { log.stopped += 1; },
    log() { /* the engine's own logger; nothing here reads it */ },
    async handBack() { log.handedBack += 1; return [{ mailboxId: "m1", released: 1 }]; },
    leave() { /* the latch alone: nothing to release in a double */ },
    async forgetStoredLogin() { return true; },
    async serverSettings() { return null; },
    async resume() { return [{ mailboxId: "m1", served: 1 }]; },
    async claimHere() {
      log.organizer = { organizing: true, heldBy: null, reason: null, releaseRequestedAt: null };
      return "claimed" as const;
    },
    async heldElsewhere() { return null; },
    async stopOrganizing() {
      log.stoppedOrganizing += 1;
      if (log.stopOrganizingAnswers === "not_organizing") return "not_organizing" as const;
      log.organizer = log.stopOrganizingAnswers === "refused"
        ? { organizing: false, heldBy: null, reason: null, releaseRequestedAt: "2026-09-14T09:00:00.000Z" }
        : { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null };
      return log.stopOrganizingAnswers;
    },
    runtimes: () => ({
      organizer: { m1: { ...log.organizer, claimed: log.organizer.reason === null } },
      connection: { m1: log.connection },
    }),
  };
}

/** A standalone port over a door that is already running, counting the switch-away stand-downs. */
function heldPort(door: StandaloneEngine, standDowns: { n: number }) {
  return {
    door: () => door,
    reopen: async () => { throw new Error("reopen was called while a door was already held"); },
    /* THE REAL ADAPTER, not a counting double: `endStandaloneHere` is what the app wires here,
       and a double that only counted would leave the hand-back and the engine's stop unmeasured. */
    standDownAway: async () => { standDowns.n += 1; await endStandaloneHere(); },
    /* NOT DRIVEN HERE, and loud rather than silent: removal goes through `forgetProfile`,
       which no case in this file calls — this file is about SWITCHING. A no-op default would
       let a case remove the engine store and still pass. */
    removeEngine: async () => { throw new Error("a switch case removed the engine store"); },
  };
}

function testEnv(standalone?: PairingEnv["standalone"]): PairingEnv {
  return {
    profiles: new ServerProfileStore(memoryKV()),
    engineDeps: engineDeps(),
    ...(standalone ? { standalone } : {}),
  };
}

afterEach(() => {
  forgetOrganizerSessionForTests();
  for (const h of handles.splice(0)) { try { h.close(); } catch { /* already closed */ } }
});

/* ══ A — the world reads the runtime for ITS account, and a mailbox switched away from stands
      down ══════════════════════════════════════════════════════════════════════════════════ */

describe("A — a mailbox somebody switched away from is not the account on screen", () => {
  it("stands the retained engine down on a switch, so nothing answers for the other mailbox", async () => {
    /**
     * Measured: switch from the mailbox on this phone to a paired account, then let the RETAINED
     * standalone engine lose its IMAP connection. The world read the GLOBAL door and put that
     * other mailbox's "Connection lost" over a healthy account.
     */
    const log = doorLog();
    log.connection = { reachable: false, unreachableSince: null, signInRefused: false, firstSync: "finished" };
    const door = fakeDoor(log);
    const standDowns = { n: 0 };
    const env = testEnv(heldPort(door, standDowns));
    expect(holdStandaloneDoor(door)).toBe(true);
    const paired = await env.profiles.add({
      origin: "https://srv.example", flavor: "selfhost", accountId: "a1", refreshToken: "r1",
    });

    await connectProfile(env, (await env.profiles.list()).find((p) => p.id === paired.id)!);

    expect(standDowns.n, "the switch left the phone's own engine running").toBe(1);
    /* AND THE ENGINE ACTUALLY WENT — read from the door, not from the call count. */
    expect(log.handedBack, "the lease was not handed back").toBeGreaterThanOrEqual(1);
    expect(standaloneHere(), "a door still answers for a mailbox nobody is looking at").toBeNull();
    /* THE RENDERED SENTENCE, which is what a person sees. */
    expect(
      connectionSaid(connectionSay(standaloneHere(), new Date(), "Europe/Zurich")),
      "the healthy account renders the other mailbox's outage",
    ).toBeNull();
  });

  it("the phone's own account still renders its own outage", async () => {
    const log = doorLog();
    log.connection = { reachable: false, unreachableSince: null, signInRefused: false, firstSync: "finished" };
    holdStandaloneDoor(fakeDoor(log));
    expect(connectionSaid(connectionSay(standaloneHere(), new Date(), "Europe/Zurich")))
      .toBe(EN.connectionLost);
  });

  it("the door is read for the session being rendered and for no other", () => {
    /* The scoping's own subject, with no switch in it: it is what decides here, so it is measured
       by asking the same held door under both sessions in one pass. */
    const log = doorLog();
    log.connection = { reachable: false, unreachableSince: null, signInRefused: false, firstSync: "finished" };
    holdStandaloneDoor(fakeDoor(log));
    const said = (standalone: boolean): string | null =>
      connectionSaid(connectionSay(standaloneHereFor({ standalone }), new Date(), "Europe/Zurich"));
    expect(said(false), "a paired session rendered the phone's own engine's outage").toBeNull();
    expect(said(true), "the phone's own session lost its outage").toBe(EN.connectionLost);
  });

  it("switching back is an ordinary resume — the engine is opened again, with no consent press", async () => {
    const log = doorLog();
    const door = fakeDoor(log);
    const standDowns = { n: 0 };
    const env = testEnv(heldPort(door, standDowns));
    holdStandaloneDoor(door);
    const own = await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: door.accountId,
    });
    const paired = await env.profiles.add({
      origin: "https://srv.example", flavor: "selfhost", accountId: "a1", refreshToken: "r1",
    });
    await connectProfile(env, (await env.profiles.list()).find((p) => p.id === paired.id)!);
    expect(standaloneHere()).toBeNull();

    /* AND BACK. Nothing is held now, so the session is built from what the engine sealed for
       itself — the cold-launch arm, which runs the gate and presses no consent. */
    let opens = 0;
    const cold = {
      ...testEnv(),
      profiles: env.profiles,
      standalone: {
        door: () => organizerDoor(),
        reopen: async () => { opens += 1; holdStandaloneDoor(door); return { ok: true as const, door }; },
        standDownAway: async () => { standDowns.n += 1; await endStandaloneHere(); },
        /* NOT DRIVEN HERE, for `heldPort`'s reason: this is the cold-launch arm of a SWITCH. */
        removeEngine: async () => { throw new Error("a switch case removed the engine store"); },
      },
    };
    const back = await connectProfile(cold, (await env.profiles.list()).find((p) => p.id === own.id)!);
    expect(opens, "switching back did not reopen the mailbox on this phone").toBe(1);
    expect(back.kind).toBe("connected");
    expect(standaloneHere(), "the door did not come back").not.toBeNull();
    /* AND NO EXTRA STAND-DOWN: a relaunch of this very door is not a switch away from it. */
    expect(standDowns.n).toBe(1);
  });

  it("a pairing and its forget leave the slot open over the kept store, so the engine's store must refuse", async () => {
    /* The row's sequence up to the press: the slot reads only this process, and opens here. */
    const door = fakeDoor(doorLog());
    const env = testEnv(heldPort(door, { n: 0 }));
    holdStandaloneDoor(door);
    await env.profiles.addStandalone({ origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: door.accountId });
    const paired = await env.profiles.add({
      origin: "https://srv.example", flavor: "managed", accountId: "a1", refreshToken: "r1",
    });
    await connectProfile(env, (await env.profiles.list()).find((p) => p.id === paired.id)!);
    expect(await forgetProfile(env, paired.id, { revoke: async () => true })).toEqual({ kind: "forgotten" });
    expect(organizerDoor()).toBeNull();
    expect(stopAndRemoveAsks(null, await organizerSettingsLeftOnlyHere()), "Stop and remove asks").not.toBeNull();
    expect(takeStandaloneLaunch()).toBe("open");
    releaseStandaloneLaunch();
  });

  it("lists the mailbox a refused Connect found, once and never as the active one", async () => {
    const env = testEnv();
    const paired = await env.profiles.add({
      origin: "https://srv.example", flavor: "managed", accountId: "a1", refreshToken: "r1",
    });
    await listHeldStandalone(env, "");
    expect((await env.profiles.list()).filter(organizesHere), "an empty id listed a row").toEqual([]);
    await listHeldStandalone(env, "engine-account");
    await listHeldStandalone(env, "engine-account");
    expect((await env.profiles.list()).filter(organizesHere).map((p) => p.accountId)).toEqual(["engine-account"]);
    expect((await env.profiles.active())?.id, "the listing took the active row").toBe(paired.id);

    /* A local row already listed is the way out; nothing is added beside it. */
    const own = testEnv();
    const row = await own.profiles.addStandalone({ origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "engine-account" });
    await listHeldStandalone(own, "another-account");
    expect(await own.profiles.list()).toEqual([row]);
  });

  it("the world asks for the door of the session it is rendering, never the module's", () => {
    const src = read("src/state/world.tsx");
    expect(src, "the world reads the global door").not.toMatch(/connectionSay\(standaloneHere\(\)/);
    expect(src).toContain("standaloneHereFor(session)");
  });
});

/* ══ B — a refused Stop is the engine's state, and a second press reaches it ═══════════════ */

describe("B — a Stop the mail server refused", () => {
  it("reaches the engine on the SECOND press and keeps the sentence that explains why", async () => {
    /**
     * Measured by the round's own probe: ONE engine call across BOTH presses. The surface read
     * `organizing: false` as idle, answered "standing" from its own word, and the second press
     * wiped the one sentence explaining the first.
     */
    const log = doorLog();
    log.stopOrganizingAnswers = "refused";
    holdStandaloneDoor(fakeDoor(log));

    expect(await pressOrganizeHere("stop")).toBe("refused");
    expect(log.stoppedOrganizing).toBe(1);

    const second = await pressOrganizeHere("stop");
    expect(log.stoppedOrganizing, "the second press never reached the engine").toBe(2);
    expect(second, "the second press reported the instruction as already in force").not.toBe("standing");
  });

  it("renders the engine's state, which is a release still pending — never a plain Organizing", () => {
    const log = doorLog();
    log.organizer = {
      organizing: false, heldBy: null, reason: null, releaseRequestedAt: "2026-09-14T09:00:00.000Z",
    };
    holdStandaloneDoor(fakeDoor(log));
    const claim = claimHere(standaloneHere()!, organizerInstruction(), false);
    expect(claim).toEqual({ k: "ours", stopping: false, releasePending: true });
  });

  it("the panel does not wipe the answer to the last press when a new one is made", () => {
    const src = read("app/settings.tsx");
    /* THE CONDITION CLEARS A REFUSAL, NEVER A PRESS. `pressSaidLine` already spends the record
       against the claim, which is the state change; a `setSaid(null)` on the way into a press
       destroys the sentence before the press has an answer of its own. */
    expect(src).not.toMatch(/setSaid\(null\);\s*\n\s*void pressOrganizeHere/);
    expect(src).not.toMatch(/setSaid\(null\);\s*\n\s*\/\* THROUGH THE ONE DOOR/);
  });

  it("the chip is the pending stop, and the verb to ask again is still there", () => {
    const log = doorLog();
    log.organizer = {
      organizing: false, heldBy: null, reason: null, releaseRequestedAt: "2026-09-14T09:00:00.000Z",
    };
    holdStandaloneDoor(fakeDoor(log));
    const claim = claimHere(standaloneHere()!, organizerInstruction(), false);
    expect(claimChipLabel(claim), "the panel said Organizing over a stop somebody already made")
      .toBe(EN.phoneStateStopPending);
    expect(claimNoteLine(claim, "android")).toBe(EN.phoneStateStopPendingWhy);
    /* NEVER REMOVED — a person whose stop was refused needs the verb. */
    expect(mayStopHere(claim), "the only way to ask again was hidden").toBe(true);
  });

  it("the refusal sentence survives a second press, because a state clears it and a press does not", async () => {
    /* `pressSaidLine` spends the record against the CLAIM. Over a claim that is still ours the
       sentence stands; the press that produced it is not what takes it away. */
    const log = doorLog();
    log.stopOrganizingAnswers = "refused";
    holdStandaloneDoor(fakeDoor(log));
    await pressOrganizeHere("stop");
    const afterFirst = claimHere(standaloneHere()!, organizerInstruction(), false);
    expect(pressSaidLine("stopRefused", afterFirst)).toBe(EN.settingsStopHereFailed);
    await pressOrganizeHere("stop");
    const afterSecond = claimHere(standaloneHere()!, organizerInstruction(), false);
    expect(pressSaidLine("stopRefused", afterSecond), "the second press wiped the explanation")
      .toBe(EN.settingsStopHereFailed);
  });

  it("an ordinary Stop still stops", async () => {
    const log = doorLog();
    holdStandaloneDoor(fakeDoor(log));
    expect(await pressOrganizeHere("stop")).toBe("stopped");
    expect(log.stoppedOrganizing).toBe(1);
    expect(standaloneHere()!.releaseRequestedAt).toBeNull();
  });
});

/* ══ C — one base composes every request ══════════════════════════════════════════════════ */

describe("C — the base the API is on, for every helper and not only sync", () => {
  it("composes /api for every session-scoped helper under a prefixed base", async () => {
    const urls: string[] = [];
    const session = {
      profile: { origin: "https://srv.example", apiBase: "https://srv.example/api" },
      fetch: async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ items: [], waiting: [], total: 0, unread: 0 }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await readFoldersEnabled(session);
    await readMailboxes(session);
    // The queue read is not among them: it asks through the engine's own adapter, on the base the
    // mirror's drain rides (`screener-store-row-presses.test.ts`), and composes no URL of its own.
    await readFolderSummary(session, "f1");

    expect(urls.length).toBeGreaterThanOrEqual(3);
    const bare = urls.filter((u) => !u.startsWith("https://srv.example/api/"));
    expect(bare, `these helpers composed the bare origin: ${bare.join(", ")}`).toEqual([]);
  });

  it("a helper that composes a URL outside the one resolver is refused by name", () => {
    /* THE CENSUS, and it parses for the COMPOSITION rather than for a symbol appearing. The
       bare-routed family is named: a self-host stack's Caddy sends `/auth/*`, `/pair/*`,
       `/hello`, `/health`, `/events` and `/internal/*` to the API at the ROOT, so those are
       composed against the origin and say so. */
    const offenders = requestBaseCensus();
    expect(offenders, `these compose a session route off the origin: ${offenders.join(", ")}`).toEqual([]);
  });
});

/**
 * EVERY URL THIS APP COMPOSES IN `src/net`, AND WHICH BASE IT USED.
 *
 * Over the whole directory rather than a list of the five that were wrong: a census of the files
 * that had the defect cannot see the sixth helper somebody writes next week. The BARE-ROUTED
 * family is named and admitted — a self-host stack's Caddy sends `/auth/*`, `/pair/*`, `/hello`,
 * `/health`, `/events` and `/internal/*` to the API at the ROOT, so those are composed against
 * the origin and must stay there. Everything else is a `/sync`-family route, which a one-origin
 * stack serves only under the measured base.
 *
 * The COMPOSITION is parsed, not a symbol: a file that imports `requestBase` and goes on
 * appending to the origin would pass a presence check.
 */
const BARE_ROUTED = ["auth", "pair", "hello", "health", "events", "internal"];

function requestBaseCensus(): string[] {
  const dir = join(HERE, "..", "src", "net");
  const out: string[] = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") || n.endsWith(".tsx"))) {
    const src = readFileSync(join(dir, f), "utf8");
    /* THE BASE POSITION ONLY — an interpolation that OPENS the template. A `${…}` further along
       is a path segment (`${encodeURIComponent(mailboxId)}/release`), and counting those would
       make the census refuse every correct route it has. */
    for (const m of src.matchAll(/`\$\{([^}]*)\}(\/[A-Za-z0-9_-]*)/g)) {
      const expr = m[1]!.trim();
      const seg = m[2]!.slice(1);
      if (BARE_ROUTED.includes(seg)) continue;
      if (expr === "requestBase(session)") continue;
      /* A LOCAL NAME IS ADMITTED ONLY WHERE THIS FILE ASSIGNED IT FROM THE RESOLVER. */
      if (/^[A-Za-z_$][\w$]*$/.test(expr)
        && new RegExp(`const ${expr} = (apiBaseOf|requestBase)\\(`).test(src)) continue;
      out.push(`${f}: \${${expr}}/${seg}`);
    }
  }
  return out;
}

/* ══ D — the controls are torn down by the stop's SUCCESS, never by the attempt ════════════ */

const NOTICE: ServiceNotice = {
  channelName: EN.stateOrganizing,
  body: EN.notifBody("held@example.test"),
  stopLabel: EN.notifStop,
  stopFailedBody: EN.notifStopFailed,
};

function bgEngine(over: { stopOrganizing?: StopOrganizingOutcome; organizing?: boolean } = {}) {
  const calls: string[] = [];
  let organizing = over.organizing ?? true;
  const impl: BackgroundEngine = {
    handBack: async () => { calls.push("handBack"); organizing = false; return [{ mailboxId: "m1", released: 1 }]; },
    resume: async () => { calls.push("resume"); return [{ mailboxId: "m1", served: 1 }]; },
    organizing: () => [{ mailboxId: "m1", organizing, standDown: false, claimed: organizing }],
    stopOrganizing: async () => {
      calls.push("stopOrganizing");
      const answer = over.stopOrganizing ?? "released";
      if (answer === "released") organizing = false;
      return answer;
    },
    claimHere: async () => { calls.push("claimHere"); return "claimed" as const; },
  };
  return { engine: impl, calls, stillOrganizing: () => organizing };
}

function bgService() {
  const calls: string[] = [];
  const notices: ServiceNotice[] = [];
  let running = false;
  let fire: (() => void) | null = null;
  const impl: BackgroundService = {
    start: async (n) => { calls.push("start"); notices.push(n); running = true; return true; },
    stop: async () => { calls.push("stop"); running = false; },
    running: () => running,
    restricted: () => false,
    canPost: () => true,
    beat: () => running,
    beatIntervalMs: () => 20_000,
    onStopRequested: (listener) => { fire = listener; return () => { fire = null; }; },
    onTimedOut: () => () => undefined,
  };
  return { service: impl, calls, notices, press: () => fire?.(), up: () => running };
}

describe("D — a Stop that could not complete never hides the running engine", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps the notification and the watchdog when the release fails, and says so on it", async () => {
    const e = bgEngine({ stopOrganizing: "refused", organizing: true });
    const s = bgService();
    const live = createBackgroundOrganizing({
      platform: "android",
      engine: e.engine,
      service: s.service,
      notice: () => NOTICE,
      announceRestricted: () => undefined,
      announceNotificationsOff: () => undefined,
      sayStartFailed: () => undefined,
      sayHandBackLate: () => undefined,
    });
    await live.phaseChanged("background");
    /* THE WATCHDOG IS A TIMER, so it is counted under fake ones — and the baseline is taken
       after the service is up, because the session arms a second interval of its own. */
    const before = vi.getTimerCount();
    s.press();
    /* PAST THE WHOLE BOUND — three attempts and their backoffs — so what is asserted below is the
       settled state and not a moment inside the retry. */
    await vi.advanceTimersByTimeAsync(STOP_BACKOFF_MS * STOP_ATTEMPTS * 4);
    expect(e.calls.filter((c) => c === "stopOrganizing").length).toBe(STOP_ATTEMPTS);

    /* THE ENGINE IS ASSERTED STILL RUNNING, not merely the notification present: the two have
       already come apart here once. */
    expect(e.stillOrganizing(), "the fixture stopped organizing, so this measures nothing").toBe(true);
    expect(s.calls, "the notification came down over an engine that is still organizing")
      .not.toContain("stop");
    expect(s.up()).toBe(true);
    expect(vi.getTimerCount(), "the watchdog was disarmed under a running engine")
      .toBeGreaterThanOrEqual(before);
    /* AND THE PRESS RENDERS WHAT HAPPENED, on the surface it was made on. */
    expect(s.notices.map((n) => n.body)).toContain(EN.notifStopFailed);
    live.dispose();
  });

  it("an ordinary Stop stops and tears the controls down", async () => {
    const e = bgEngine({ stopOrganizing: "released" });
    const s = bgService();
    const live = createBackgroundOrganizing({
      platform: "android",
      engine: e.engine,
      service: s.service,
      notice: () => NOTICE,
      announceRestricted: () => undefined,
      announceNotificationsOff: () => undefined,
      sayStartFailed: () => undefined,
      sayHandBackLate: () => undefined,
    });
    await live.phaseChanged("background");
    s.press();
    await vi.waitFor(() => { expect(s.calls).toContain("stop"); });
    await vi.advanceTimersByTimeAsync(0);
    expect(e.stillOrganizing()).toBe(false);
    expect(s.up()).toBe(false);
    live.dispose();
  });
});
