/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE MAILBOX ON THIS PHONE, AS A SESSION — the fourth door's second half
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `bootEngine` has carried a standalone arm since the fourth door landed and nothing in the app
 * reached it. Measured before a line was written: `localEngine` had no in-app setter at all
 * (`boot.ts`'s own declaration and reader, plus `standalone-door.test.ts`), and `bootEngine` had
 * exactly one in-app caller — `buildSession`, over a stored profile and a BearerManager, which
 * refuses a row with no refresh token. So the door started an engine, dropped the handle, and
 * `router.replace("/")` landed on the chooser.
 *
 * This file drives the arm that closes it, through the seams the app really uses: the profile row,
 * `connectProfileById`, and the door the organizer session holds.
 *
 * ── WHAT IS ASSERTED BY DRIVING AND WHAT BY READING ───────────────────────────────────────
 *
 * There is no React Native renderer in this workspace — `react-test-renderer` and
 * `@testing-library/react-native` are absent from the store, which `test/unsaved-changes.test.ts`
 * measured. So the session is driven for real (the door counts the requests that reach it) and the
 * two SCREEN lines that cannot be driven are read out of their own sources, the idiom
 * `test/fourth-door.test.ts` established for the same reason.
 *
 * ── AND THE PAIRED DOOR IS ASSERTED BESIDE IT ─────────────────────────────────────────────
 *
 * Every property here comes with the paired arm still behaving as it did: a file about a new arm
 * that only exercises the new arm cannot see the regression it is most likely to cause. The paired
 * cells live in `pairing.test.ts` and are untouched; the last block here is the one that matters at
 * this seam — a refresh-token-less row on a NETWORK origin is still refused.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { SqlExecutor, SqlRow, SqlValue } from "@ohmail/client-engine";

import { LOCAL_ENGINE_ORIGIN, type MobileEngineDeps } from "../src/engine/boot";
import {
  discardStandaloneLaunch,
  endStandaloneHere,
  forgetOrganizerSessionForTests,
  releaseStandaloneLaunch,
  takeStandaloneLaunch,
  armConsentPress,
  claimHereStandalone,
  takeConsentPress,
  notifyOrganizerState,
  onOrganizerState,
  pokeOrganizerState,
  organizerStateVersion,
  stopOrganizingStandalone,
  holdStandaloneDoor,
  organizerDoor,
  organizerSessionLive,
  organizerHandedBack,
  stopOrganizerSession,
  standaloneHere,
  standaloneLaunchGeneration,
  startOrganizerSession,
  organizerInstruction,
  pressConsentHere,
  pressOrganizeHere,
} from "../src/engine/organizer-session";
import {
  CLAIM_LAPSES_AFTER_MINUTES, PHONE_CLAIM_NAME, reopenStandaloneMailbox, type ClaimHereBy, type StandaloneEngine,
  type StopOrganizingOutcome,
} from "../src/engine/standalone-door";
/* The panel's own derivation, so a cell about the instruction reads the chip a person sees
   rather than the word behind it. */
import { claimChipLabel, claimHere, mayStartHere, mayStopHere } from "../src/ui/standalone-form";
/* The chip's own label, so the cell reads the words a person sees rather than the shape behind
   them — `claimChipLabel` resolves through the active deck, which is English here. */
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";
import { organizeHere } from "../src/net/mailboxes";
import { connectProfile, connectProfileById, forgetProfile, type PairingEnv } from "../src/net/pairing";
import { refuse, sayRefusal } from "../src/refusal";
import { ServerProfileStore, type SecureKV } from "../src/state/servers";
import type { BackgroundService, ServiceNotice } from "../src/engine/background";

const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

function memoryKV(): SecureKV {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}

const handles: DatabaseSync[] = [];
const dropped: string[] = [];
/**
 * HOW MANY TIMES THE ENGINE'S OWN STORE WAS REMOVED — the fourth store a standalone forget owes.
 * Recorded rather than defaulted away: "Stop and remove" that leaves `ohmail-engine.db` and its
 * key behind is how a removed mailbox's mail turned up under the next mailbox's session, so a
 * port that quietly answered would let a case forget this phone's mailbox and prove nothing.
 */
const enginesRemoved: string[] = [];
/** How many times a port was asked to stand the mailbox on this phone down — see `standDownAway`. */
let standDowns = 0;

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

/**
 * The mirror host, plus a GLOBAL TRANSPORT ARMED TO FAIL.
 *
 * The whole claim of this arm is that a standalone install's mail never touches a network, so a
 * request that escaped the local door must be loud rather than quietly served.
 */
function engineDeps(): MobileEngineDeps {
  return {
    openExecutor: () => {
      const db = new sqlite.DatabaseSync(":memory:");
      handles.push(db);
      return nodeSqlExecutor(db);
    },
    deleteDatabase: async (name: string) => void dropped.push(name),
    uuid: () => `22222222-2222-4222-8222-${String(handles.length).padStart(12, "0")}`,
    fetch: async () => {
      throw new Error("the global transport was used on the standalone door");
    },
  };
}

/** What a door was asked, so "the session talks to the engine" is an observation. */
interface DoorLog {
  readonly urls: string[];
  readonly bearers: (string | null)[];
  stopped: number;
  handedBack: number;
  /** What the hand-back REPORTS. `null` is the engine's own word for "we cannot say it went". */
  handBackReleases: number | null;
  /** How many times the launch's sealed credential was discarded. */
  sealsDiscarded: number;
  /** Every body the consent route was given — the request's shape, asserted. */
  readonly organizeBodies: string[];
  organizeStatus: number;
  organizeOutcome: string;
  /** The holder the door's 409 names, so the app's parse is an observation. */
  organizeHolder: { name: string; kind: string };
  /**
   * The CODE inside the door's 503 body. The app reads it — `organizer_unreadable` is the look
   * that did not land and has its own sentence; anything else keeps its number — so a double that
   * could only ever say one word would let that discrimination be deleted green.
   */
  organizeErrorCode: string;
  /** How many times the person's stop reached the door, and what it answered. */
  stoppedOrganizing: number;
  /**
   * WHAT THE ENGINE'S STOP SETTLES, and the state it leaves behind with it.
   *
   * This was a boolean, and the `false` arm left `runtimes()` saying the mailbox was organized —
   * which is NOT what production does. On a refused release the engine answers a word and reports
   * `organizing: false` with the request still standing on the row, because a pass carrying out a
   * release arranges nothing either way. The double answering `false`/`organizing: true` made the
   * app's fix look measured while production defeated it.
   */
  stopOrganizingAnswers: StopOrganizingOutcome;
  /** Forced cycles the two verbs asked for — the stamp is inert until one runs. */
  resumed: number;
  /** What the door reports per mailbox. Replaced by a cell that takes the mailbox away. */
  organizer: {
    organizing: boolean; heldBy: string | null; reason: string | null;
    releaseRequestedAt: string | null;
  };
  /**
   * A GATE THE TWO VERBS AWAIT BEFORE THEY SETTLE — `null` means they answer at once.
   *
   * A cell about a press made DURING another act sets it, presses twice, and releases. Without a
   * door that can be mid-act the race the instruction exists for is unreachable here, and every
   * queue cell would be measuring its own setup.
   */
  hold: Promise<void> | null;
  /** Every act the door completed, in order — what proves a queued press ran AFTER the one it waited for. */
  readonly acts: string[];
  /**
   * EVERY DIAGNOSTIC LINE THE APP HANDED THIS DOOR. Production's `log` is the engine's own
   * hardened logger, so what a caller passes is `(event, detail)` and the line is the engine's to
   * build — this records the pair, which is exactly what a call site can be held to.
   */
  readonly lines: { event: string; detail: Record<string, unknown> }[];
}

const doorLog = (): DoorLog => ({
  urls: [], bearers: [], stopped: 0, handedBack: 0, handBackReleases: 1, sealsDiscarded: 0,
  organizeBodies: [], organizeStatus: 200, organizeOutcome: "authorized",
  organizeHolder: { name: "a laptop", kind: "local" },
  organizeErrorCode: "organizer_unreadable",
  stoppedOrganizing: 0, stopOrganizingAnswers: "released", resumed: 0,
  organizer: { organizing: true, heldBy: null, reason: null, releaseRequestedAt: null },
  hold: null, acts: [], lines: [],
});

/**
 * The engine's own local API, minimally — `/sync`, `/mailboxes`, and the acts the forget drives.
 *
 * `sessionToken` is a getter so a case can prove the bearer is read per request. `accountId` is the
 * engine's word about its one mailbox, which is what the app keys its mirror by.
 */
function fakeDoor(log: DoorLog, opts: { account?: string; token?: { value: string } } = {}): StandaloneEngine {
  const token = opts.token ?? { value: "engine-launch-token" };
  return {
    accountId: opts.account ?? "engine-account",
    address: "held@example.test",
    get sessionToken() { return token.value; },
    async handle(req: Request): Promise<Response> {
      const url = new URL(req.url);
      log.urls.push(req.url);
      log.bearers.push(req.headers.get("authorization"));
      const json = (status: number, body: unknown): Response =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.pathname === "/sync/snapshot") {
        return json(200, { asOfSeq: 0, changes: [], nextCursor: null, window: { days: 90, minRows: 5000 } });
      }
      if (url.pathname === "/mailboxes") {
        return json(200, { items: [{ id: "m1", address: "held@example.test" }] });
      }
      /* THE CONSENT ROUTE, answering what the engine's own door answers. The BODY is recorded so
         the request's shape is an assertion rather than a hope.

         THE `/local/` SPELLING, because that is the door the phone serves: the shared one is
         `stepUp: true` and a standalone launch stamps its second factor once at boot, so it is
         absent from the phone's composition. The shared spelling falls through to the 404 below,
         which is what the real door answers for it — a double that served both would hide the
         very move this spelling exists for. It answers 200 for EVERY outcome and names the
         outcome in the body, as `requestOrganizerTakeover`'s handler does. */
      if (url.pathname === "/local/mailboxes/m1/organize" && req.method === "POST") {
        log.organizeBodies.push(await req.text());
        return log.organizeStatus === 200
          ? json(200, { outcome: log.organizeOutcome, previousReason: null })
          : log.organizeStatus === 409
            ? json(409, {
              error: { code: "organized_elsewhere", message: "another install is organizing this mailbox" },
              holder: log.organizeHolder,
            })
            /* 503 IS THE DOOR'S OWN THIRD ANSWER and carries its own code. A double that
               answered a bare `refused` here would let `claimHere` below map it the way it
               used to, and the cell would measure its own fixture. */
            : log.organizeStatus === 503
              ? json(503, {
                error: {
                  code: log.organizeErrorCode,
                  message: "whether another install organizes this mailbox could not be read",
                },
              })
              : json(log.organizeStatus, { error: { code: "refused", message: "held elsewhere" } });
      }
      return json(404, { error: { code: "not_found", message: url.pathname } });
    },
    async stop() { log.stopped += 1; },
    /* THE ENGINE'S OWN LOGGER, as the artifact hands it back out. Recorded rather than dropped:
       the app's background half writes through this, and a double that swallowed it would make
       every line-shaped assertion an assertion about nothing. */
    log(event: string, detail: Record<string, unknown>) { log.lines.push({ event, detail }); },
    async handBack() { log.handedBack += 1; return [{ mailboxId: "m1", released: log.handBackReleases }]; },
    leave() { /* the latch alone: nothing to release in a double */ },
    async forgetStoredLogin() { log.sealsDiscarded += 1; return true; },
    async serverSettings() { return null; },
    async resume() { log.resumed += 1; return [{ mailboxId: "m1", served: 1 }]; },
    /* THE TWO VERBS, THROUGH THIS DOOR'S OWN `handle` — the shape the artifact has: the engine
       presses its own route and then forces a cycle, so a cell reading `urls` sees the request a
       device would make rather than a method call this double invented. */
    async heldElsewhere() { return null; },
    async claimHere() {
      await gated(log);
      const res = await this.handle(new Request("http://engine.invalid/local/mailboxes/m1/organize", {
        method: "POST",
        headers: { authorization: `Bearer ${this.sessionToken}`, "content-type": "application/json" },
        body: "{}",
      }));
      if (res.status === 409) {
        /* AND THE REFUSAL RECORDS THE HOLDER, exactly as the artifact does (`mobile.ts`'s
           `refusedHolders`, merged into `runtimes()`): the door reads the row as it refuses, so
           the state the app reads names the machine that has the mailbox. A double that answered
           the word and left `runtimes()` alone could not express this at all, and every cell about
           what the panel says after a refused press would have measured its own fixture. */
        log.organizer = {
          organizing: false,
          releaseRequestedAt: null,
          heldBy: log.organizeHolder.name === "" ? null : log.organizeHolder.name,
          reason: `organized_elsewhere:${
            ["cloud", "local", "mobile"].includes(log.organizeHolder.kind)
              ? log.organizeHolder.kind
              : "unknown"}`,
        };
        return "held" as const;
      }
      /* THE THIRD ANSWER, MAPPED AS THE ARTIFACT MAPS IT (`mobile.ts#claimHere`): 503 carrying
         `organizer_unreadable` is a look that did not land, and anything else 503 is not. */
      if (res.status === 503) {
        const body = await res.json().then(
          (b) => b as { error?: { code?: unknown } },
          () => ({ error: undefined }),
        );
        return body.error?.code === "organizer_unreadable" ? "unreadable" as const : "refused" as const;
      }
      if (res.status !== 200) return "refused" as const;
      {
        const body = await res.json() as { outcome?: unknown };
        if (body.outcome !== "authorized" && body.outcome !== "already_organizing") {
          return "refused" as const;
        }
      }
      log.resumed += 1;
      /* AND THE ENGINE'S OWN ANSWER MOVES WITH IT, which is what production does: the verb presses
         the route and forces a cycle, and the cycle is what makes `runtimes()` say this install
         organizes the mailbox. A double whose verbs left `runtimes()` alone could not express a
         transition at all, so every cell about one would have measured its own fixture. */
      log.organizer = { organizing: true, heldBy: null, reason: null, releaseRequestedAt: null };
      log.acts.push("claim");
      return "claimed" as const;
    },
    async stopOrganizing() {
      log.stoppedOrganizing += 1;
      /* NOTHING OF OURS TO GIVE UP: the route answers 200 and returns before the forced cycle, so
         no cycle runs and the report does not move. */
      if (log.stopOrganizingAnswers === "not_organizing") return "not_organizing" as const;
      await gated(log);
      log.resumed += 1;
      log.acts.push("stop");
      /* ── THE REFUSAL ARM, IN PRODUCTION'S OWN SHAPE ────────────────────────────────────────
         The cycle RAN and could not confirm the claim left the mailbox: the engine reports
         `organizing: false` — a pass honouring a release arranges nothing — with the request
         still standing on the row. That second field is the whole of what separates this from a
         release, and the double that left `organizing: true` here could not express it. */
      log.organizer = log.stopOrganizingAnswers === "refused"
        ? { organizing: false, heldBy: null, reason: null, releaseRequestedAt: "2026-09-12T09:00:00.000Z" }
        : { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null };
      return log.stopOrganizingAnswers;
    },
    runtimes: () => reports({ m1: log.organizer }),
  };
}

/** Hold both verbs open where a cell asked for it — see {@link DoorLog.hold}. */
async function gated(log: DoorLog): Promise<void> {
  if (log.hold !== null) await log.hold;
}

/** A door held mid-act, and the hand that lets it finish. */
function holdDoor(log: DoorLog): () => void {
  let release!: () => void;
  log.hold = new Promise<void>((r) => { release = r; });
  return () => { log.hold = null; release(); };
}

/**
 * ONE `runtimes()` ANSWER, BOTH HALVES — the engine reports the organizer AND the connection.
 *
 * A double that omitted the connection half made every reachability read a no-op, which is the
 * kindness the engine's own type had for a release: the facts were served and the app's interface
 * dropped them. `reachable` defaults to a live link, so a case about the organizer says nothing
 * about the connection and a case about the connection says so explicitly.
 */
function reports(
  organizer: Record<string, {
    organizing: boolean; heldBy: string | null; reason: string | null;
    releaseRequestedAt: string | null;
    /** Optional HERE and required on the engine — see below. */
    claimed?: boolean;
  }>,
  connection: Record<string, {
    reachable: boolean; unreachableSince: Date | null; signInRefused: boolean; firstSync: string;
  }> = { m1: { reachable: true, unreachableSince: null, signInRefused: false, firstSync: "finished" } },
): {
  organizer: Record<string, {
    organizing: boolean; heldBy: string | null; reason: string | null;
    releaseRequestedAt: string | null; claimed: boolean;
  }>;
  connection: typeof connection;
} {
  /* DERIVED, and stated once rather than in forty literals: every state this file drives is one
     where the two agree — an install that organizes holds its mailbox, and one that has stood
     down does not. The window where they DISAGREE (the claim landed, the pass has not said so
     yet) belongs to the background machine and is measured in its own file, so a cell here that
     wants it says `claimed` explicitly. */
  return {
    organizer: Object.fromEntries(Object.entries(organizer).map(([id, o]) => [id, {
      ...o, claimed: o.claimed ?? (o.reason === null && o.organizing),
    }])),
    connection,
  };
}

/** A standalone port over one door that is already running — the door-press state. */
function heldPort(door: StandaloneEngine): NonNullable<PairingEnv["standalone"]> {
  return {
    door: () => door,
    reopen: async () => {
      throw new Error("reopen was called while a door was already held");
    },
    removeEngine: async () => void enginesRemoved.push("held"),
    /* THE SWITCH-AWAY STAND-DOWN. Its own file drives what this does; here it is the port's
       third member, so these cells hold `buildSession` to calling it on a switch and not on a
       relaunch of this very door. */
    standDownAway: async () => { standDowns += 1; },
  };
}

/**
 * A standalone port with NOTHING running — the cold-launch state. Counts the opens.
 *
 * ── IT DELIBERATELY DOES NOT HOLD THE DOOR IT ANSWERS, AND THAT IS THE POINT ──────────────
 *
 * The first version of this double called `holdStandaloneDoor` itself, and the case below was green
 * over an app that never did: on a real relaunch `organizerDoor()` stayed null with an engine
 * running, so a second connect would have opened a SECOND engine and the forget found nothing to
 * hand back or stop — measured on a device, where the engine went on polling a mailbox that had
 * been removed. A double that performs the production step measures the double.
 *
 * So this answers the door and nothing else, exactly as `reopenStandaloneMailbox` does, and the
 * holding is the arm's to do.
 */
function coldPort(door: StandaloneEngine): NonNullable<PairingEnv["standalone"]> & { opens: () => number } {
  let opens = 0;
  return {
    door: () => organizerDoor(),
    reopen: async () => {
      opens += 1;
      return { ok: true as const, door };
    },
    removeEngine: async () => void enginesRemoved.push("cold"),
    standDownAway: async () => { standDowns += 1; },
    opens: () => opens,
  };
}

/**
 * `removeEngine` DEFAULTED to a throw rather than a no-op: the port is required on every
 * composition (a build that can open a mailbox on this phone can remove one), and every case in
 * this file is about opening, so a silent default would let a case remove a store and pass.
 */
function testEnv(standalone?: Partial<NonNullable<PairingEnv["standalone"]>>): PairingEnv {
  return {
    profiles: new ServerProfileStore(memoryKV()),
    engineDeps: engineDeps(),
    ...(standalone
      ? {
        standalone: {
          door: () => null,
          reopen: async () => { throw new Error("reopen was called by a case that supplies none"); },
          removeEngine: async () => { throw new Error("the engine store was removed by a case that does not remove one"); },
          /* COUNTED, not thrown: `standDowns` is reset per case and asserted, so a stand-down a
             case did not supply is observable rather than silent — the reason the sibling above
             throws does not apply, because nothing is destroyed by standing a mailbox down. */
          standDownAway: async () => { standDowns += 1; },
          ...standalone,
        },
      }
      : {}),
  };
}

afterEach(() => {
  standDowns = 0;
  forgetOrganizerSessionForTests();
  for (const h of handles.splice(0)) { try { h.close(); } catch { /* already closed */ } }
  dropped.splice(0);
  enginesRemoved.splice(0);
});

describe("the row this phone writes for its own mailbox", () => {
  it("is the standalone origin, the ENGINE's account, and no token", async () => {
    const profiles = new ServerProfileStore(memoryKV());
    const row = await profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "engine-account",
    });
    expect(row.origin).toBe(LOCAL_ENGINE_ORIGIN);
    expect(row.refreshToken).toBeNull();
    /* NO PIN AND NO BASE: nothing leaves the device, and the API answers at the origin. A pin here
       would be a key for a certificate that does not exist. */
    expect(row.pin).toBeNull();
    expect(row.apiBase).toBeNull();
    expect((await profiles.list()).map((p) => p.id)).toEqual([row.id]);
    expect((await profiles.active())?.id).toBe(row.id);
  });

  it("UPDATES IN PLACE on a second door for the same mailbox — never a second row", async () => {
    /* Two presses of the fourth door on one phone are one mailbox. A second row would be a second
       mirror under the same owner key and two entries in the chooser for one engine. */
    const profiles = new ServerProfileStore(memoryKV());
    const first = await profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "engine-account",
    });
    const again = await profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "engine-account",
    });
    expect(again.id).toBe(first.id);
    expect(await profiles.list()).toHaveLength(1);
  });

  it("refuses a nameless account, the way `add` does", async () => {
    const profiles = new ServerProfileStore(memoryKV());
    await expect(profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "  ",
    })).rejects.toThrow(/account/);
    expect(await profiles.list()).toEqual([]);
  });
});

describe("the session over the door this process holds", () => {
  it("goes LIVE and its requests reach the engine — counted at the door", async () => {
    const log = doorLog();
    const door = fakeDoor(log);
    const env = testEnv(heldPort(door));
    const row = await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: door.accountId,
    });

    const outcome = await connectProfileById(env, row.id);
    expect(outcome.kind, outcome.kind === "refused" ? sayRefusal(outcome.reason) : "").toBe("connected");
    if (outcome.kind !== "connected") return;

    /* THE MIRROR IS THIS MAILBOX'S AND NOT A SECOND COPY: keyed by the standalone origin and the
       id the ENGINE reported, which is the pair `mirrorOwnerKey` names a database with. */
    expect(outcome.session.ownerKey).toBe(`${LOCAL_ENGINE_ORIGIN}::engine-account`);
    /* NO MANAGER — the state, named. A faked one would have made every reader believe this session
       has a credential lifecycle it has not got. */
    expect(outcome.session.bearer).toBeNull();

    /* AND A REQUEST THROUGH THE SESSION'S TRANSPORT REACHES `door.handle`, with this launch's
       bearer on it. Driven, not read off the composition. */
    const res = await outcome.session.fetch(`${LOCAL_ENGINE_ORIGIN}/mailboxes`);
    expect(res.status).toBe(200);
    expect(log.urls).toContain(`${LOCAL_ENGINE_ORIGIN}/mailboxes`);
    expect(log.bearers.at(-1)).toBe("Bearer engine-launch-token");
    outcome.session.store.close();
  });

  it("reads the bearer PER REQUEST — a rotated launch token is not stale", async () => {
    const log = doorLog();
    const token = { value: "first" };
    const door = fakeDoor(log, { token });
    const env = testEnv(heldPort(door));
    const row = await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: door.accountId,
    });
    const outcome = await connectProfileById(env, row.id);
    if (outcome.kind !== "connected") throw new Error("not connected");
    await outcome.session.fetch(`${LOCAL_ENGINE_ORIGIN}/mailboxes`);
    token.value = "second";
    await outcome.session.fetch(`${LOCAL_ENGINE_ORIGIN}/mailboxes`);
    expect(log.bearers).toEqual(["Bearer first", "Bearer second"]);
    outcome.session.store.close();
  });

  it("lets the door's own token win over one a caller brought", async () => {
    /* A stale or foreign `authorization` reaching this engine would be refused, and a person would
       read their own mailbox rejecting them. The door's token is stamped last. */
    const log = doorLog();
    const door = fakeDoor(log);
    const env = testEnv(heldPort(door));
    const row = await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: door.accountId,
    });
    const outcome = await connectProfileById(env, row.id);
    if (outcome.kind !== "connected") throw new Error("not connected");
    await outcome.session.fetch(`${LOCAL_ENGINE_ORIGIN}/mailboxes`, {
      headers: { authorization: "Bearer somebody-elses" },
    });
    expect(log.bearers.at(-1)).toBe("Bearer engine-launch-token");
    outcome.session.store.close();
  });
});

describe("the cold relaunch — a row, and nothing running", () => {
  it("re-opens the engine from what it sealed and goes live again", async () => {
    const log = doorLog();
    const door = fakeDoor(log);
    const port = coldPort(door);
    const env = testEnv(port);
    await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: door.accountId,
    });

    /* The launch's own read: the keystore list, then a connect by id. Nothing is held. */
    const rows = await env.profiles.list();
    expect(rows).toHaveLength(1);
    const outcome = await connectProfileById(env, rows[0]!.id);
    expect(outcome.kind, outcome.kind === "refused" ? sayRefusal(outcome.reason) : "").toBe("connected");
    if (outcome.kind !== "connected") return;
    expect(port.opens()).toBe(1);
    outcome.session.store.close();

    /* THE DOOR IS HELD BY THE ARM, not by the port — see `coldPort`. Without this the forget has
       nothing to hand back or stop, and the next connect opens a second engine. */
    expect(organizerDoor(), "the arm did not hold the door it opened").toBe(door);

    /* A SECOND CONNECT IN THE SAME LAUNCH — a profile switch back, a re-adopt — finds the door the
       first one left held and does NOT open a second engine. Two engines on one mailbox would be
       two organizers, and a second open would write a second claim. */
    const again = await connectProfileById(env, rows[0]!.id);
    expect(again.kind).toBe("connected");
    expect(port.opens(), "a second engine was opened for one mailbox").toBe(1);
    if (again.kind === "connected") again.session.store.close();
  });

  it("the relaunch wires the background half too — the composition, read", () => {
    /* Measured on a device: a relaunched standalone install organized while it was open, posted no
       notification and handed nothing back on background, because the door screen's second act had
       no twin on this path. Read rather than driven for the file's stated reason — the wiring is a
       native import this workspace cannot load. */
    const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "src/net/connection.tsx"), "utf8");
    expect(src).toContain("async function reopenWithBackground(");
    /* AND IT CARRIES THE LAUNCH IT BELONGS TO. The import is not awaited, so a relaunch given up
       while it was loading must not raise a session over the engine that was stopped. */
    expect(src).toContain("const launch = standaloneLaunchGeneration();");
    expect(src).toContain("m.startOrganizerSessionNative(door, door.address, launch)");
    /* AND A BUILD THAT CANNOT REACH ITS OWN BACKGROUND HALF SAYS SO. */
    expect(src).toContain("sayOrganizerRestricted()");
    /* THE PORT USES IT, rather than the bare reopen it used to. */
    expect(src).toContain("reopen: () => reopenWithBackground({");
  });

  it("carries the engine's own refusal out rather than opening nothing quietly", async () => {
    /* `no-credential`: the row says this phone organizes a mailbox and the engine's store has
       nothing sealed. A fall-through would put somebody back on the chooser with no sentence. */
    const env = testEnv({
      door: () => null,
      standDownAway: async () => { standDowns += 1; },
      reopen: async () => (await reopenStandaloneMailbox({
        startFromSealed: async () => ({ kind: "no-credential" as const }),
        platform: async () => ({ kind: "ready" as const, exec: {}, keks: { 1: "a".repeat(64) } }),
        machineName: () => "a phone",
        installId: async () => "install-1",
      })),
    });
    const row = await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "engine-account",
    });
    const outcome = await connectProfileById(env, row.id);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason.say).toBe("standaloneNoSealedCredential");
    /* RENDERED, in the reader's own language at the moment it is shown — a refusal nobody can read
       is the same dead end as no refusal. */
    expect(sayRefusal(outcome.reason)).toContain("password");
  });

  it("refuses a build with no engine in it, by name", async () => {
    const env = testEnv({
      door: () => null,
      standDownAway: async () => { standDowns += 1; },
      reopen: async () => (await reopenStandaloneMailbox({
        startFromSealed: null,
        platform: async () => { throw new Error("the platform was opened without an engine"); },
        machineName: () => "a phone",
        installId: async () => "install-1",
      })),
    });
    const row = await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "engine-account",
    });
    const outcome = await connectProfileById(env, row.id);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason.say).toBe("standaloneNoEngine");
  });

  it("refuses when the app has no standalone port at all — never a fall-through", async () => {
    /* The composition that cannot organize here. Refused in words, because the alternative is the
       chooser again with nothing said. */
    const env = testEnv();
    const row = await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "engine-account",
    });
    const outcome = await connectProfileById(env, row.id);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason.say).toBe("standaloneNoEngine");
  });

  it("refuses when the engine serves a DIFFERENT mailbox than the row names", async () => {
    /* A restored backup can leave a row naming an account this store no longer serves. Opening a
       mirror under that name would be a second copy of a mailbox, quietly. */
    const log = doorLog();
    const door = fakeDoor(log, { account: "the-engine-really-serves-this" });
    const env = testEnv(heldPort(door));
    const row = await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "what-the-row-says",
    });
    const outcome = await connectProfileById(env, row.id);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason.say).toBe("standaloneOtherMailbox");
    /* AND NOTHING WAS OPENED. A mirror created under the wrong name is the damage, not the
       refusal's wording. */
    expect(log.urls).toEqual([]);
  });

  it("refuses a row somebody asked to forget, before the engine is touched", async () => {
    /* The resurrection this queue exists to prevent, one door over: a forget whose credential half
       was refused leaves the row in place, and the next launch must not re-open it. */
    const log = doorLog();
    const door = fakeDoor(log);
    const env = testEnv(heldPort(door));
    const row = await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: door.accountId,
    });
    await env.profiles.markPendingWipe(row.id, `${LOCAL_ENGINE_ORIGIN}::${door.accountId}`);
    const outcome = await connectProfileById(env, row.id);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason.say).toBe("forgetStillPending");
    expect(log.urls).toEqual([]);
  });
});

describe("stopping here — one verb, three effects", () => {
  /**
   * The Android service double, in the shape `organizer-session.test.ts` established — every
   * member the machine drives, so the double fails the way production fails rather than by being
   * absent. `stops` is the reading this block is about: the notification coming down.
   */
  function service(): { impl: BackgroundService; stops: () => number } {
    let running = false;
    let stops = 0;
    return {
      impl: {
        start: async (_notice: ServiceNotice) => { running = true; return true; },
        stop: async () => { running = false; stops += 1; },
        running: () => running,
        restricted: () => false,
        canPost: () => true,
        beat: () => running,
        beatIntervalMs: () => 30_000,
        onStopRequested: () => () => undefined,
      },
      stops: () => stops,
    };
  }

  it("hands the claim back, stops the session and its notification, and stops the engine", async () => {
    const log = doorLog();
    const door = fakeDoor(log);
    const svc = service();
    holdStandaloneDoor(door);
    const started = startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "android",
      engine: {
        handBack: () => door.handBack(),
        resume: () => door.resume(),
        stopOrganizing: () => door.stopOrganizing(),
        claimHere: (opts) => door.claimHere(opts),
        organizing: () => [{ mailboxId: "m1", organizing: true, standDown: false, claimed: true }],
      },
      service: svc.impl,
      notice: () => ({ channelName: "Organizing", body: "…", stopLabel: "Stop", stopFailedBody: "Stop did not complete" }),
      appPhases: () => () => undefined,
    });
    expect(started).toBe(true);
    expect(organizerDoor()).toBe(door);

    await endStandaloneHere();

    expect(log.handedBack, "the claim was not handed back").toBe(1);
    expect(log.stopped, "the engine was left running").toBe(1);
    expect(organizerSessionLive(), "the session outlived the stop").toBe(false);
    expect(organizerDoor(), "the door outlived the stop").toBeNull();
    expect(svc.stops(), "the notification was left standing").toBe(1);
  });

  it("is idempotent and never throws, so the row can always go", async () => {
    /* The forget removes the row after this. A mailbox that could not be reached must not block it:
       a row left behind does not age out. What it ANSWERS is the caller's sentence — `false` is
       "the claim may still stand", which is the whole of finding 5's block below. */
    await expect(endStandaloneHere()).resolves.toBe(true);
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    door.handBack = async () => { throw new Error("the mailbox could not be reached"); };
    await expect(endStandaloneHere()).resolves.toBe(false);
    expect(log.stopped, "the engine was not stopped after a failed hand-back").toBe(1);
  });

  it("leaves ZERO rows, and reports the forget rather than the missing server", async () => {
    /* `revokeProfile` answers `false` for a credential-less row — right for a pairing a server
       judged, a false negative here. Reported, a forget of this phone's own mailbox would show the
       Devices-list remedy for a server that does not exist. */
    const log = doorLog();
    const door = fakeDoor(log);
    const env = testEnv(heldPort(door));
    const row = await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: door.accountId,
    });
    const outcome = await forgetProfile(env, row.id);
    expect(outcome.kind, outcome.kind === "partial" ? sayRefusal(outcome.reason) : "").toBe("forgotten");
    expect(await env.profiles.list()).toEqual([]);
    /* AND THE MAIL WENT WITH IT — the mirror this row named was deleted by its owner key. */
    expect(dropped.length).toBeGreaterThan(0);
    /* AND THE ENGINE'S OWN STORE, which is the authority the mirror is only a projection of:
       account, mailbox row, sealed credential and mail. A forget that took the mirror alone left
       every one of them for the NEXT mailbox's bootstrap to attach (`forget.test.ts` measures
       each at a real store; this asserts the ceremony reaches them at all). */
    expect(enginesRemoved).toEqual(["held"]);
  });
});

describe("a refused connect leaves no engine, and a second press makes no second one", () => {
  /**
   * ══ FINDING 2 ═══════════════════════════════════════════════════════════════════════════
   *
   * The launch succeeded and the profile write was refused, and the screen said so over an engine,
   * a door and a session that were all still alive. The next Connect started a SECOND engine over
   * the same device store — two organizers of one mailbox — because `holdStandaloneDoor` and
   * `startOrganizerSession` are both first-start-wins and decline the newcomer silently.
   */
  function service(): { impl: BackgroundService; stops: () => number } {
    let running = false;
    let stops = 0;
    return {
      impl: {
        start: async (_notice: ServiceNotice) => { running = true; return true; },
        stop: async () => { running = false; stops += 1; },
        running: () => running,
        restricted: () => false,
        canPost: () => true,
        beat: () => running,
        beatIntervalMs: () => 30_000,
        onStopRequested: () => () => undefined,
      },
      stops: () => stops,
    };
  }

  const androidDeps = (door: StandaloneEngine, svc: BackgroundService) => ({
    platform: "android" as const,
    engine: {
      handBack: () => door.handBack(),
      resume: () => door.resume(),
      stopOrganizing: () => door.stopOrganizing(),
      claimHere: (opts: { by: ClaimHereBy }) => door.claimHere(opts),
      organizing: () => [{ mailboxId: "m1", organizing: true, standDown: false, claimed: true }],
    },
    service: svc,
    notice: () => ({ channelName: "Organizing", body: "…", stopLabel: "Stop", stopFailedBody: "Stop did not complete" }),
    appPhases: () => () => undefined,
  });

  it("the refusal STOPS the engine, drops the door and the session, and discards the seal", async () => {
    const log = doorLog();
    const door = fakeDoor(log);
    const svc = service();
    holdStandaloneDoor(door);
    expect(startOrganizerSession(standaloneLaunchGeneration(), androidDeps(door, svc.impl))).toBe(true);

    await discardStandaloneLaunch();

    expect(log.stopped, "the engine was left running by the refusal").toBe(1);
    expect(organizerDoor(), "the door outlived the refusal").toBeNull();
    expect(organizerSessionLive(), "the session outlived the refusal").toBe(false);
    expect(svc.stops(), "the notification was left standing over a refused connect").toBe(1);
    /* AND THE CREDENTIAL, because `resolveLogin` lets the STORE win: a second press with a
       corrected server would otherwise dial the first press's coordinates. */
    expect(log.sealsDiscarded, "the launch kept the password it had sealed").toBe(1);
  });

  it("never throws, whatever the engine answered — the screen still gets its sentence", async () => {
    await expect(discardStandaloneLaunch()).resolves.toBeUndefined();
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    door.handBack = async () => { throw new Error("the mailbox could not be reached"); };
    door.forgetStoredLogin = async () => { throw new Error("the keystore refused"); };
    await expect(discardStandaloneLaunch()).resolves.toBeUndefined();
    expect(log.stopped, "a throwing hand-back left the engine running").toBe(1);
  });

  it("a background import that settles AFTER the discard raises NO session, and the next connect does", async () => {
    /**
     * ══ FINDING 3 ═══════════════════════════════════════════════════════════════════════════
     *
     * The door screen starts the background half behind a dynamic `import()` it neither awaits nor
     * cancels, and the profile write AFTER it can be refused — which stops the engine. An import
     * settling then raised a live session over a dead engine, and the session is first-start-wins:
     * the next successful Connect could not attach its own, so the mailbox was organized behind no
     * notification, no service and neither watch for the run of the app.
     *
     * The import is a promise this cell holds, which is the only way the ordering is reachable
     * here — the native module cannot be loaded in this workspace.
     */
    const log = doorLog();
    const door = fakeDoor(log);
    const svc = service();
    expect(takeStandaloneLaunch()).toBe("open");
    holdStandaloneDoor(door);
    /* READ WHERE THE SCREEN READS IT: inside the slot, before the import is fired. */
    const launch = standaloneLaunchGeneration();
    let settle!: () => void;
    const events: string[] = [];
    let raised: boolean | null = null;
    const imported = new Promise<void>((r) => { settle = r; }).then(() => {
      raised = startOrganizerSession(launch, {
        ...androidDeps(door, svc.impl),
        log: (event: string) => { events.push(event); },
      });
    });

    /* THE PROFILE WRITE IS REFUSED while the import is still loading. */
    await discardStandaloneLaunch();
    releaseStandaloneLaunch();
    settle();
    await imported;

    expect(raised, "a session was raised over the engine the refusal had stopped").toBe(false);
    expect(organizerSessionLive(), "the discarded launch left a live session behind").toBe(false);
    expect(events, "the refusal to raise a session was swallowed")
      .toContain("organizer_session_launch_discarded");

    /* ── AND THE NEXT CONNECT GETS ITS OWN. This is the half a person feels: first-start-wins,
       so a stale session would have declined the new engine in silence. */
    const log2 = doorLog();
    const door2 = fakeDoor(log2);
    const svc2 = service();
    expect(takeStandaloneLaunch()).toBe("open");
    holdStandaloneDoor(door2);
    expect(startOrganizerSession(standaloneLaunchGeneration(), androidDeps(door2, svc2.impl)),
      "the next connect could not attach its engine").toBe(true);
    expect(organizerSessionLive()).toBe(true);
    releaseStandaloneLaunch();
  });

  it("a launch that is NOT discarded still raises its session — the positive control", async () => {
    /* Without this the refusal above is satisfied by a generation check that refuses everything.
       Same shape, same unawaited import; only the discard is missing. */
    const log = doorLog();
    const door = fakeDoor(log);
    const svc = service();
    expect(takeStandaloneLaunch()).toBe("open");
    holdStandaloneDoor(door);
    const launch = standaloneLaunchGeneration();
    let settle!: () => void;
    let raised: boolean | null = null;
    const imported = new Promise<void>((r) => { settle = r; }).then(() => {
      raised = startOrganizerSession(launch, androidDeps(door, svc.impl));
    });
    releaseStandaloneLaunch();
    settle();
    await imported;
    expect(raised, "an ordinary launch was refused its own session").toBe(true);
    expect(organizerSessionLive()).toBe(true);
  });

  it("the door screen reads the launch BEFORE the import, and passes it in — the composition, read", () => {
    /* A renderer cannot drive this screen, so the ORDER is read: the generation is taken while the
       slot is held, and the starter is given it. Read as two anchors rather than one regex, so a
       call that passed a generation read after the await would still be caught by the order. */
    const src = readFileSync(
      join(fileURLToPath(new URL(".", import.meta.url)), "..", "app/standalone.tsx"), "utf8",
    );
    const read = src.indexOf("const launch = standaloneLaunchGeneration();");
    const fired = src.indexOf('void import("../src/engine/organizer-session-native")');
    expect(read, "the door screen never reads the launch it is starting").toBeGreaterThan(-1);
    expect(read, "the launch is read after the import was fired").toBeLessThan(fired);
    expect(src).toContain("m.startOrganizerSessionNative(outcome.door, address, launch)");
  });

  it("the connect's refusal arm is the ONE exit — the composition, read", () => {
    /* A renderer cannot drive the provider, so the wiring is read: the discard precedes the
       sentence and the return, and nothing else undoes the launch. */
    const src = readFileSync(
      join(fileURLToPath(new URL(".", import.meta.url)), "..", "src/net/connection.tsx"), "utf8",
    );
    const discard = src.indexOf("await discardStandaloneLaunch()");
    const reason = src.indexOf('refuse("standaloneNotStored"');
    expect(discard, "the refused write does not undo the launch").toBeGreaterThan(-1);
    expect(discard).toBeLessThan(reason);
  });

  it("a SECOND launch while one is alive or in flight is refused, not opened", () => {
    /* The door alone cannot answer this: it is held only after a launch RETURNS, so two presses
       inside one launch both read null. The slot is that half. */
    expect(takeStandaloneLaunch()).toBe("open");
    expect(takeStandaloneLaunch(), "a second press opened a second engine").toBe("standing");
    releaseStandaloneLaunch();
    expect(takeStandaloneLaunch(), "the slot was never given back").toBe("open");
    releaseStandaloneLaunch();
    /* AND A LIVE ENGINE IS THE SAME ANSWER, with no launch in flight at all. */
    holdStandaloneDoor(fakeDoor(doorLog()));
    expect(takeStandaloneLaunch(), "a press over a live engine opened another").toBe("standing");
  });

  it("the RELAUNCH takes the same slot, so it cannot open one beside a press", async () => {
    /* The two openers are not in one gate: the fourth door opens its engine before it enters the
       connection layer's, so a relaunch reading `door()` as null mid-press is the second engine by
       the one road the door check cannot see. Driven: the slot is held, the relaunch refuses, and
       the port is never asked to open anything. */
    const log = doorLog();
    const port = coldPort(fakeDoor(log));
    const env = testEnv(port);
    const row = await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: "engine-account",
    });
    expect(takeStandaloneLaunch()).toBe("open");
    const outcome = await connectProfileById(env, row.id);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason.say).toBe("standaloneAlreadyOpen");
    expect(port.opens(), "a second engine was opened beside a launch in flight").toBe(0);
    releaseStandaloneLaunch();
    /* THE POSITIVE CONTROL: with the slot free the ordinary relaunch still opens exactly one. */
    const again = await connectProfileById(env, row.id);
    expect(again.kind, again.kind === "refused" ? sayRefusal(again.reason) : "").toBe("connected");
    expect(port.opens()).toBe(1);
    if (again.kind === "connected") again.session.store.close();
  });
});

describe("forgetting this phone's mailbox answers whether the claim actually went", () => {
  /**
   * ══ FINDING 5 ═══════════════════════════════════════════════════════════════════════════
   *
   * `endStandaloneHere` swallowed the hand-back, so the forget reported a mailbox this phone had
   * let go while its record in `ohmail/_meta` stood to expiry — the person's other machine refused
   * for the staleness window by an install that no longer lists the mailbox and has no verb left
   * to release it. `handBack` answers `released: null` for exactly this, and it is now read.
   */
  it("answers TRUE when the claim was removed — the ordinary forget is admitted", async () => {
    const log = doorLog();
    holdStandaloneDoor(fakeDoor(log));
    await expect(endStandaloneHere()).resolves.toBe(true);
    expect(log.handedBack).toBe(1);
    expect(log.stopped).toBe(1);
  });

  it("answers FALSE when the engine could not say the claim went", async () => {
    const log = doorLog();
    /* `null` is the engine's own word for "the search was refused": see `PhoneEngine.handBack`. */
    log.handBackReleases = null;
    holdStandaloneDoor(fakeDoor(log));
    await expect(endStandaloneHere()).resolves.toBe(false);
    /* AND THE ROW STILL GOES — the engine is stopped either way; only the sentence changes. */
    expect(log.stopped, "a claim that could not go back blocked the forget").toBe(1);
  });

  it("answers FALSE when the hand-back threw, which is the same fact", async () => {
    const log = doorLog();
    const door = fakeDoor(log);
    door.handBack = async () => { throw new Error("the mailbox could not be reached"); };
    holdStandaloneDoor(door);
    await expect(endStandaloneHere()).resolves.toBe(false);
    expect(log.stopped).toBe(1);
  });

  it("answers TRUE with no door — nothing of ours is holding the mailbox", async () => {
    await expect(endStandaloneHere()).resolves.toBe(true);
  });

  it("the forget's sentence names the wait, and the forget is conditioned on it — read", () => {
    const src = readFileSync(
      join(fileURLToPath(new URL(".", import.meta.url)), "..", "src/net/connection.tsx"), "utf8",
    );
    /* The provider is React, so the wiring is read: the answer is kept and it decides the outcome
       rather than being discarded into a `void`. */
    expect(src).toContain("const claimWentBack = row?.origin === LOCAL_ENGINE_ORIGIN");
    expect(src).toContain('refuse("forgetClaimStands", CLAIM_LAPSES_AFTER_MINUTES)');
    /* AND IT IS A SENTENCE A PERSON CAN READ, with the wait filled in. */
    const said = sayRefusal(refuse("forgetClaimStands", CLAIM_LAPSES_AFTER_MINUTES));
    expect(said).toContain(String(CLAIM_LAPSES_AFTER_MINUTES));
    expect(said).not.toContain("${");
  });
});

describe("what the panel that names this phone reads", () => {
  /**
   * The panel drew NOTHING on a device across three release builds, with an engine running behind
   * it. Its source was a loopback `GET /mailboxes` whose three outcomes — never asked, asked and
   * refused, answered empty — all reach Settings as one `known: false`. The whole roster path was
   * then driven end to end against the real artifact (`engine-bundle-loads.test.ts`) and answers a
   * row, so the collapse is the defect: a panel dark for three reasons says nothing about any of
   * them.
   *
   * `standaloneHere()` is the door answering for itself, with no request. These cases are its
   * three states, and the panel's own composition over them is read out of the screen.
   */
  it("answers nothing at all when this process holds no door", () => {
    expect(standaloneHere()).toBeNull();
  });

  it("answers the address and NOT-SAID-YET before the engine's first cycle", () => {
    /* The map is empty until the first gated cycle. Reading that as "nothing organizes this
       mailbox" would put a false sentence on screen a second after the door opened. */
    const log = doorLog();
    const door = fakeDoor(log);
    door.runtimes = () => reports({}, {});
    holdStandaloneDoor(door);
    expect(standaloneHere()).toEqual({
      id: null, address: "held@example.test", organizing: null, releaseRequestedAt: null,
      releaseRefusal: null,
      heldBy: null, metaBlocked: null, reachable: null, unreachableSince: null, signInRefused: false,
      certificateRefused: false,
      /* `false` and not `null`: an engine that has not answered has not said this phone needs a
         password, and a sentence asking for one must never come from a silence. */
      needsCredential: false,
      /* `true` while unsaid, the same direction: silence never reads as a connection nobody tried. */
      dialled: true,
      firstSync: null,
      writeOffsHeld: false,
      /* 0 while unsaid: silence never reads as mail set aside. */
      setAside: 0,
    });
  });

  it("answers ORGANIZING once the engine says so, and NOT once it says it does not", () => {
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    expect(standaloneHere()?.organizing, "the engine said it organizes and this did not").toBe(true);
    door.runtimes = () => reports({ m1: { organizing: false, heldBy: null, reason: null , releaseRequestedAt: null} });
    expect(standaloneHere()?.organizing, "the engine said it does not and this did not").toBe(false);
  });

  /**
   * ══ AND WHO HOLDS IT WHEN THIS INSTALL DOES NOT — the stand-down, said ════════════════════
   *
   * Measured on a device with a second install holding the claim: the phone correctly took no
   * claim, and Settings read `Nothing organizes this mailbox` — the SAME sentence it shows when
   * nobody holds it. Two states, one sentence, and the one a person needs ("another machine has
   * it") was the missing one. The engine knew: its own `runtimes().organizer` carries `heldBy`,
   * and the app's structural claim about the bundle did not name the member at all.
   */
  it("names the HOLDER when this install is standing down", () => {
    const log = doorLog();
    const door = fakeDoor(log);
    door.runtimes = () => reports({ m1: { organizing: false, heldBy: "a laptop", reason: "organized_elsewhere:local" , releaseRequestedAt: null} });
    holdStandaloneDoor(door);
    expect(standaloneHere()?.heldBy, "the engine named the holder and this did not")
      .toEqual({ name: "a laptop", standDownReason: "organized_elsewhere:local", holderState: null });
    expect(standaloneHere()?.organizing, "standing down is not organizing").toBe(false);
  });

  /**
   * ══ AND ON EVERY RELAUNCH, WHERE THE HOLDER HAS NO NAME ════════════════════════════════════
   *
   * This is the arm a read of `heldBy` alone cannot reach, and it is not an edge. The engine
   * assembles a stood-down mailbox from its OWN ROW (`engine.ts`, the `mb.standDownReason` arm),
   * and that row remembers the reason and not the holder — so after any restart under another
   * machine's claim the engine reports `heldBy: null` with the reason standing.
   *
   * Reading the name as the discriminator calls that a FREE mailbox, which is the desktop's own
   * measured defect (`reader-holder.ts`: "a name is absent in two completely different states").
   * The reason is written at the stand-down and nowhere else, so it is the fact.
   */
  it("still says another machine holds it when the claim named nobody — the relaunch arm", () => {
    const log = doorLog();
    const door = fakeDoor(log);
    door.runtimes = () => reports({ m1: { organizing: false, heldBy: null, reason: "organized_elsewhere:mobile" , releaseRequestedAt: null} });
    holdStandaloneDoor(door);
    expect(standaloneHere()?.heldBy, "a stand-down with no name read as a free mailbox")
      .toEqual({ name: "", standDownReason: "organized_elsewhere:mobile", holderState: null });
  });

  it("keeps the KIND the engine stood down for, which the sentence reads", () => {
    /* `organized_elsewhere:mobile` is the one kind that changes what somebody should expect of
       their mail, and dropping it here would leave the panel with the generic sentence. */
    const log = doorLog();
    const door = fakeDoor(log);
    for (const reason of ["organized_elsewhere:cloud", "organized_elsewhere:mobile",
                          "organized_elsewhere:unknown"]) {
      door.runtimes = () => reports({ m1: { organizing: false, heldBy: "elsewhere", reason, releaseRequestedAt: null } });
      holdStandaloneDoor(door);
      expect(standaloneHere()?.heldBy?.standDownReason, reason).toBe(reason);
    }
  });

  it("names NO holder over its OWN claim — the false state in the other direction", () => {
    /* Over our own claim the engine reports US, and rendering that as "another machine has it"
       would put a stranger's sentence over a mailbox this phone is organizing. */
    const log = doorLog();
    const door = fakeDoor(log);
    door.runtimes = () => reports({
        m1: { organizing: true, heldBy: "ohmail on a phone", reason: "organized_elsewhere:mobile" , releaseRequestedAt: null},
      });
    holdStandaloneDoor(door);
    expect(standaloneHere()?.heldBy).toBeNull();
    expect(standaloneHere()?.organizing).toBe(true);
  });

  it("names no holder where the engine has not read the claim — `free` is not `theirs`", () => {
    /* The positive control for the pair above: an engine that has read the mailbox and found
       nobody holding it must still produce "nothing organizes this mailbox", which is the true
       sentence there. */
    const log = doorLog();
    const door = fakeDoor(log);
    door.runtimes = () => reports({ m1: { organizing: false, heldBy: null, reason: null , releaseRequestedAt: null} });
    holdStandaloneDoor(door);
    expect(standaloneHere()?.heldBy).toBeNull();
    expect(standaloneHere()?.organizing).toBe(false);
  });

  it("reads an unreadable runtime as NOT-SAID, never as not-organizing", () => {
    /* The background half takes the same reading for the same reason: a momentary failure must not
       end somebody's organizing on screen. `false` here would take the chip and the stop verb away
       from a phone that is organizing. */
    const log = doorLog();
    const door = fakeDoor(log);
    door.runtimes = () => { throw new Error("the runtime could not be read"); };
    holdStandaloneDoor(door);
    expect(standaloneHere()).toEqual({
      id: null, address: "held@example.test", organizing: null, releaseRequestedAt: null,
      releaseRefusal: null,
      heldBy: null, metaBlocked: null, reachable: null, unreachableSince: null, signInRefused: false,
      certificateRefused: false,
      /* `false` and not `null`: an engine that has not answered has not said this phone needs a
         password, and a sentence asking for one must never come from a silence. */
      needsCredential: false,
      /* `true` while unsaid, the same direction: silence never reads as a connection nobody tried. */
      dialled: true,
      firstSync: null,
      writeOffsHeld: false,
      /* 0 while unsaid: silence never reads as mail set aside. */
      setAside: 0,
    });
  });

  /**
   * ══ AND WHETHER THE MAIL SERVER CAN BE REACHED — the half the app's own type dropped ═══════
   *
   * The engine has served `reachable`, `unreachableSince` and `signInRefused` per mailbox since
   * the desktop's Settings row started reading them; `StandaloneEngine.runtimes()` declared only
   * the organizer half, so on the phone those facts reached nothing. Measured on a device: a
   * 2 min 27 s outage during which the only sentence anywhere was `As of 19:42 · catching up`.
   *
   * `reachable: null` is "the engine has not said yet", on `organizing`'s own rule: the map is
   * empty until the first cycle.
   */
  it("carries the CONNECTION facts, and `not said yet` before the first cycle", () => {
    const log = doorLog();
    const door = fakeDoor(log);
    door.runtimes = () => reports({}, {});
    holdStandaloneDoor(door);
    expect(standaloneHere()?.reachable, "an empty map is not an unreachable server").toBeNull();

    const since = new Date("2026-09-11T19:42:00.000Z");
    door.runtimes = () => reports(
      { m1: { organizing: true, heldBy: null, reason: null, releaseRequestedAt: null } },
      { m1: { reachable: false, unreachableSince: since, signInRefused: false, firstSync: "finished" } },
    );
    const gone = standaloneHere();
    expect(gone?.reachable, "the engine said the server is unreachable and this did not").toBe(false);
    /* AN ISO STRING, not the `Date` the engine hands over: the world layer formats it in the
       reader's zone, and every other lifecycle instant on this seam is an ISO string. */
    expect(gone?.unreachableSince).toBe(since.toISOString());
    /* AND THE ORGANIZER HALF IS UNTOUCHED BY IT. This install is still the organizer of a
       mailbox whose server it cannot dial, which is the pair the panel has to render at once —
       collapsing them is what let `Organizing` stand over a measured outage. */
    expect(gone?.organizing).toBe(true);
  });

  it("keeps a REFUSED SIGN-IN apart from an outage — different facts, opposite remedies", () => {
    /* An unreachable server is retried and heals on its own; a rejected sign-in is not retried at
       all and needs a person. Telling somebody to check their connection when the server has
       already answered and said no sends them to look in the wrong place. */
    const log = doorLog();
    const door = fakeDoor(log);
    door.runtimes = () => reports(
      { m1: { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null } },
      { m1: { reachable: false, unreachableSince: new Date(), signInRefused: true, firstSync: "finished" } },
    );
    holdStandaloneDoor(door);
    expect(standaloneHere()?.signInRefused).toBe(true);
    expect(standaloneHere()?.reachable).toBe(false);
  });

  it("reads an unreadable runtime as NOT-SAID for the connection too", () => {
    /* The same reading the organizer half takes, and for the same reason: a momentary failure
       must not put "Connection lost" on screen over a link that is fine. */
    const log = doorLog();
    const door = fakeDoor(log);
    door.runtimes = () => { throw new Error("the runtime could not be read"); };
    holdStandaloneDoor(door);
    expect(standaloneHere()?.reachable).toBeNull();
    expect(standaloneHere()?.signInRefused).toBe(false);
  });

  it("carries the MAILBOX ID off the map's own key, and none where it cannot name one", () => {
    /* The keys of `runtimes().organizer` are mailbox ids, and this is the only id the app can have
       on this door without asking for it. The consent press needs one, and the read that used to
       fetch it is the one a device refused. */
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    expect(standaloneHere()?.id).toBe("m1");
    /* SEVERAL is a shape this reader cannot describe truthfully — consenting for whichever came
       back first would be a consent about a mailbox nobody named. */
    door.runtimes = () => reports({
        m1: { organizing: true, heldBy: null, reason: null , releaseRequestedAt: null},
        m2: { organizing: false, heldBy: null, reason: null , releaseRequestedAt: null},
      });
    expect(standaloneHere()?.id).toBeNull();
  });

  it("STOPS THROUGH THE ROW, not through a bare hand-back — the person's stop is remembered", async () => {
    /**
     * ══ CONTROL 1 (the stop half) ══════════════════════════════════════════════════════════
     *
     * This pressed the engine's `handBack`, which takes the claim out of `ohmail/_meta` and
     * deliberately leaves the ROW saying organizer so the next foreground resume takes it back
     * with no press. Measured twice on a device: swipe the notification away — the documented way
     * to stop — reopen the app with no kill, and the resume wrote a fresh claim that nothing then
     * serviced (frozen heartbeat, no notification, no service, a message unfiled for 70 s) while
     * Settings said `Organizing`. A held, unserviced claim also refuses the person's laptop.
     *
     * `stopOrganizing` is the engine's release ceremony, which the ROW records — and a reader with
     * no press never re-enters the gate, on this launch or any later one.
     */
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    await expect(stopOrganizingStandalone()).resolves.toBe("released");
    expect(log.stoppedOrganizing, "the stop did not reach the engine's own release").toBe(1);
    /* AND NOT THE BARE HAND-BACK. It is the same claim removal with none of the durability, and
       taking it here is what made a reopen re-claim. */
    expect(log.handedBack, "the stop fell back to the un-remembered hand-back").toBe(0);
    /* THE ENGINE KEEPS RUNNING — this is the Settings stop, not the forget: the phone goes on
       reading the mailbox it handed back, which is what the copy promises. */
    expect(log.stopped, "the Settings stop stopped the engine").toBe(0);
  });

  it("is a no-op with no door, so the confirm can always be pressed", async () => {
    /* `refused` and not a release: with nothing running there is no reading of the mailbox at all,
       and the caller may not take a notification down on it. */
    await expect(stopOrganizingStandalone()).resolves.toBe("refused");
  });

  it("ASKS FOR THE MAILBOX through the same one door, and reports what it answered", async () => {
    /**
     * ══ CONTROL 5 (the way back) ═══════════════════════════════════════════════════════════
     *
     * A remembered stop leaves a person needing a verb, and the panel's Start is it. Both arms
     * are driven here because only one of them owes a sentence: `held` is the ordinary state of a
     * phone whose mailbox another machine organizes and says nothing to anybody.
     */
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    await expect(claimHereStandalone()).resolves.toBe("claimed");
    expect(log.urls.some((u) => u.endsWith("/local/mailboxes/m1/organize"))).toBe(true);
    /* THE STAMP IS INERT UNTIL A CYCLE SPENDS IT, and the person is looking at the screen. */
    expect(log.resumed, "the consent was recorded and no cycle was asked for").toBe(1);

    log.organizeStatus = 409;
    await expect(claimHereStandalone()).resolves.toBe("held");
    /* NO SECOND CYCLE. A refused press has nothing for a gate to spend. */
    expect(log.resumed).toBe(1);
  });

  it("answers `refused` with no door, so the press can never report a start that did not happen", async () => {
    await expect(claimHereStandalone()).resolves.toBe("refused");
  });

  it("notifies its watchers, so a screen already open re-derives", () => {
    /**
     * ══ CONTROL 4 (the panel re-derives) ═══════════════════════════════════════════════════
     *
     * The panel read the door at RENDER and nothing re-rendered it: measured on a device showing
     * `Stopping` for minutes over a finished stop and `Organizing` for minutes over a
     * mailbox another machine held. Both settled on leaving Settings and coming back.
     */
    let woken = 0;
    const off = onOrganizerState(() => { woken += 1; });
    const before = organizerStateVersion();
    notifyOrganizerState();
    expect(woken, "nothing was told the state moved").toBe(1);
    expect(organizerStateVersion()).toBeGreaterThan(before);
    /* AND A THROWING SUBSCRIBER TAKES NOTHING WITH IT — this runs from inside a hand-back. */
    const offBad = onOrganizerState(() => { throw new Error("a screen threw"); });
    expect(() => { notifyOrganizerState(); }).not.toThrow();
    expect(woken).toBe(2);
    offBad();
    off();
    notifyOrganizerState();
    expect(woken, "an unsubscribed watcher was still called").toBe(2);
  });

  it("HANDED BACK is part of the panel's input, so the chip for it is re-derived", async () => {
    /**
     * The chip this lane added reads `organizerHandedBack()`, which lives on the session and not
     * on the door — so nothing in the engine's answer moves when it does. A fingerprint that did
     * not carry it would compare an unchanged string and notify nobody, and the transitional state
     * would render only on the next re-entry to Settings. This is the isolating arm: the door's
     * own answer is held still and the flag is the only thing that moves.
     */
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    let phase: ((status: string) => void) | null = null;
    expect(startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "ios",
      engine: {
        handBack: () => door.handBack(),
        resume: () => door.resume(),
        stopOrganizing: () => door.stopOrganizing(),
        claimHere: (opts) => door.claimHere(opts),
        /* HELD STILL, and `organizing: true` throughout: the door reports what it reported before
           the release, which is what makes the flag the only moving part. */
        organizing: () => [{ mailboxId: "m1", organizing: true, standDown: false, claimed: true }],
      },
      service: null,
      notice: () => ({ channelName: "Organizing", body: "…", stopLabel: "Stop", stopFailedBody: "Stop did not complete" }),
      appPhases: (listener: (status: string) => void) => { phase = listener; return () => { phase = null; }; },
    })).toBe(true);

    let woken = 0;
    const off = onOrganizerState(() => { woken += 1; });
    pokeOrganizerState();
    const settled = woken;
    pokeOrganizerState();
    expect(woken, "the panel was re-rendered with nothing moved").toBe(settled);

    /* THE RELEASE. On iOS the claim goes back on the way out — the state the new chip is about. */
    (phase as unknown as (status: string) => void)("background");
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(organizerHandedBack(), "the release did not complete").toBe(true);
    pokeOrganizerState();
    expect(woken, "the handed-back state never reached the panel").toBeGreaterThan(settled);
    off();
    await stopOrganizerSession();
  });

  it("wakes the screen ONLY when something moved — the watch fires on a timer", () => {
    /**
     * ══ CONTROL 4 (the cadence's own half) ═════════════════════════════════════════════════
     *
     * The claim watch ticks whether the mailbox changed or not, which is what carries an
     * ENGINE-side change onto a screen already open. An unconditional wake would also re-render
     * the panel once a minute for ever, so the tick asks this and this compares the panel's whole
     * input. Both arms, because a gate that never notifies and a gate that always does are the
     * two ways to get this wrong.
     */
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    let woken = 0;
    const off = onOrganizerState(() => { woken += 1; });
    /* THE FIRST READ always wakes: nothing has been compared yet. */
    pokeOrganizerState();
    expect(woken).toBe(1);
    /* A SETTLED MAILBOX wakes nothing, however many times the watch asks. */
    pokeOrganizerState();
    pokeOrganizerState();
    expect(woken, "a settled panel was re-rendered on every tick").toBe(1);
    /* THE GATE STOOD THIS INSTALL DOWN mid-poll — nothing in the app chose it, and this is the
       moment a screen already open must stop saying "Organizing". */
    log.organizer = { organizing: false, heldBy: "a laptop", reason: "organized_elsewhere:local" , releaseRequestedAt: null};
    pokeOrganizerState();
    expect(woken, "a stand-down left the panel on the state it was opened in").toBe(2);
    /* AND THE HOLDER LEAVING is its own change — the sentence names a machine that has gone. */
    log.organizer = { organizing: false, heldBy: null, reason: "organized_elsewhere:local" , releaseRequestedAt: null};
    pokeOrganizerState();
    expect(woken).toBe(3);
    off();
  });

  it("a STOP and a START both tell the screen the state moved", async () => {
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    let woken = 0;
    const off = onOrganizerState(() => { woken += 1; });
    await stopOrganizingStandalone();
    expect(woken, "the stop left the panel on the state it was opened in").toBeGreaterThan(0);
    const afterStop = woken;
    await claimHereStandalone();
    expect(woken, "the start left the panel on the state it was opened in").toBeGreaterThan(afterStop);
    off();
  });

  it("the panel composes its card from the DOOR, and the paired arm keeps the roster", () => {
    /* Read rather than rendered for the file's stated reason. The ORDER is the assertion: the
       door answers first, and `w.mailboxes.rows` is the arm beside it. */
    const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "app/settings.tsx"), "utf8");
    const door = src.indexOf("const here = standaloneHere()");
    const cards = src.indexOf("here !== null");
    const roster = src.indexOf(": w.mailboxes.rows.map((row) => ({");
    expect(door, "the panel never asks the door").toBeGreaterThan(-1);
    expect(cards).toBeGreaterThan(door);
    expect(roster, "the paired arm's roster source is gone").toBeGreaterThan(cards);
    /* THE GATE THAT MADE IT DARK IS GONE — `known` no longer decides whether the panel exists. */
    expect(src).not.toContain("if (!w.mailboxes.known || w.mailboxes.rows.length === 0) return null;");
    /* AND THE STOP IS THE ENGINE'S REMEMBERED ONE, on the door in this process, and its refusal is
       read. The paired arm's hand-back is gone with the name test that was the only thing that
       reached it: `mayStopHere` answers true for `ours` alone, and only {@link claimHere} — the
       door's own verdict on its own claim — produces one. */
    expect(src).toContain('void pressOrganizeHere("stop").then((outcome) => {');
    /* RE-DERIVED, and the old needle says why. It read `setStopFailed(outcome === "refused")` — a
       boolean the panel kept and that nothing but another press ever cleared, so a stop the server
       refused and then honoured left its sentence under "Nothing organizes this mailbox" with the
       Start verb beside it. The invariant is unchanged and stronger: a refused stop is RECORDED
       here, and `pressSaidLine` decides whether it is still true of the claim. */
    expect(src).toContain('setSaid(outcome === "refused" ? "stopRefused" : null);');
    expect(src, "a paired row can ask the server it is paired to to give up a claim again")
      .not.toContain("releaseMailbox(session, id)");
    /* AND THE WAY BACK IS OFFERED, on the door in this process and nowhere else. */
    expect(src).toContain("mayStartHere(claim) && row.key === HERE_CARD");
    /* `async (outcome)` since the notification ask rides this press — the invariant here is that
       the press goes through the ONE door, which the needle still names. */
    expect(src).toContain('void pressOrganizeHere("start").then(async (outcome) => {');
    /* AND THE TWO REFUSALS GET DIFFERENT SENTENCES. A boolean here collapsed "could not start" with
       "could not check whether another computer has it", and the second is the one the door now
       refuses a press over — told the first, a person goes looking for a fault on the phone. */
    /* Through `pressSaidOf`, the strip's own mapping, so the card and the strip cannot drift: the
       card's copy had dropped both `_meta` codes. Its arms are driven in `meta-blocked-said.test.ts`. */
    expect(src).toContain("setSaid(pressSaidOf(outcome));");
    /* AND THE SENTENCES THEMSELVES MOVED WITH THE DECISION — the panel names none of them now,
       which is what makes "the two refusals get different sentences" one reader's business
       (`pressSaidLine`, driven in `fourth-door.test.ts`) rather than a ternary in a screen. */
    expect(src).toContain("pressSaidLine(said, claim)");
    /* AND THE PANEL SUBSCRIBES rather than reading once at mount. */
    expect(src).toContain("useSyncExternalStore(");
    expect(src).toContain("onOrganizerState(cb)");
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  ONE STANDING INSTRUCTION — stop and start in ONE run of the app (device run 3, cell 3b)
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured twice on a release build, and it lands in one of two wrong states. Either the start is
 * refused for the life of the process — "Try again in a moment", which never works, while the
 * engine yields to a press nobody made once per poll — or the press wins and Settings reads
 * `Stopping` for three minutes over a phone that is demonstrably filing mail.
 *
 * The app's half of both: the stop was three unawaited writers of one instruction — the release,
 * the session teardown and a `setAsked` the panel held for its own screen's life — with nothing
 * ordering them and nothing spending the flag. Every press goes through one door now, the door
 * holds ONE instruction, and the ENGINE's answer is what ends a transition.
 *
 * The engine's half — the guarded release update matching no row on the device store — is measured
 * where it lives, in `apps/sidecar/test/phone-stop-then-start.test.ts`.
 */
describe("one standing instruction, and a press replaces it rather than racing it", () => {
  /** The session's platform half, iOS-shaped: no service, so no notification is in play here. */
  function sessionDeps(door: StandaloneEngine, log: { subscribed: number; unsubscribed: number }) {
    return {
      platform: "ios" as const,
      engine: {
        handBack: async () => [{ mailboxId: "m1", released: 1 }],
        resume: async () => [{ mailboxId: "m1", served: 1 }],
        organizing: () => [{ mailboxId: "m1", organizing: true, standDown: false, claimed: true }],
        stopOrganizing: () => door.stopOrganizing(),
        claimHere: (opts: { by: ClaimHereBy }) => door.claimHere(opts),
      },
      service: null,
      notice: () => ({ channelName: "Organizing", body: "Organizing.", stopLabel: "Stop", stopFailedBody: "Stop did not complete" }),
      appPhases: (_l: (s: string) => void) => {
        log.subscribed += 1;
        return () => { log.unsubscribed += 1; };
      },
    };
  }

  const phaseLog = () => ({ subscribed: 0, unsubscribed: 0 });

  /** How many times the consent route was pressed — the claim count, read off the door. */
  const claims = (log: DoorLog): number =>
    log.urls.filter((u) => u.endsWith("/local/mailboxes/m1/organize")).length;

  it("STOP THEN START in one run ends running, with ONE claim and no refusal", async () => {
    /**
     * ══ CONTROL 1 ═════════════════════════════════════════════════════════════════════════
     *
     * The sequence device run 3 met: stop, change your mind, start. At the base the start
     * claimed and left the session down — so the engine organized behind no notification, no
     * foreground service and neither watch — and the chip went on saying `Stopping` because the
     * panel's own `asked` was never spent.
     */
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    const phases = phaseLog();
    expect(startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phases))).toBe(true);
    expect(organizerInstruction(), "the engine says it organizes and the door did not").toBe("running");

    await expect(pressOrganizeHere("stop")).resolves.toBe("stopped");
    expect(organizerInstruction(), "the stop did not resolve against the engine's answer").toBe("idle");
    expect(standaloneHere()?.organizing).toBe(false);
    expect(organizerSessionLive(), "the notification outlived the claim").toBe(false);

    await expect(pressOrganizeHere("start")).resolves.toBe("started");
    expect(organizerInstruction(), "the start never became the standing instruction").toBe("running");
    expect(claims(log), "the way back pressed the consent route more than once").toBe(1);
    /* AND THE SESSION COMES BACK WITH THE CLAIM. This is the half that made it two standing
       instructions: the engine organizing with nothing in front of the person saying so. */
    expect(organizerSessionLive(), "the mailbox is organized behind no session").toBe(true);
    expect(phases.subscribed, "the re-armed session never subscribed to the app's lifecycle").toBe(2);
  });

  it("a START pressed DURING a stop is queued once, and runs AFTER it", async () => {
    /**
     * ══ CONTROL 2 ═════════════════════════════════════════════════════════════════════════
     *
     * The ruled shape: Start during a stop waits for the stop to complete and then starts — it
     * neither races it nor is refused. The order is the assertion, because a start that ran
     * BESIDE the release is the state where the release then takes the claim the start just made.
     */
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    const release = holdDoor(log);

    const stopping = pressOrganizeHere("stop");
    await Promise.resolve();
    expect(organizerInstruction(), "the stop is not the instruction in force").toBe("stopping");
    await expect(pressOrganizeHere("start")).resolves.toBe("queued");
    /* STILL STOPPING. A queued start does not become the instruction until the stop finishes. */
    expect(organizerInstruction()).toBe("stopping");

    release();
    await stopping;
    await Promise.resolve();
    expect(log.acts, "the queued start ran beside the stop rather than after it")
      .toEqual(["stop", "claim"]);
    expect(organizerInstruction()).toBe("running");
    expect(claims(log)).toBe(1);
  });

  it("a STOP pressed DURING a start cancels it — nothing organizes the mailbox", async () => {
    /**
     * ══ CONTROL 3 ═════════════════════════════════════════════════════════════════════════
     *
     * The cancel is honest rather than optimistic: the start in flight cannot be un-sent, so the
     * stop runs behind it and gives back what it claimed. What must never happen is the start
     * landing and standing.
     */
    const log = doorLog();
    const door = fakeDoor(log);
    log.organizer = { organizing: false, heldBy: null, reason: null , releaseRequestedAt: null};
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    const release = holdDoor(log);

    const starting = pressOrganizeHere("start");
    await Promise.resolve();
    expect(organizerInstruction()).toBe("starting");
    await expect(pressOrganizeHere("stop")).resolves.toBe("queued");

    release();
    await starting;
    await Promise.resolve();
    expect(log.acts, "the stop did not follow the start it cancels").toEqual(["claim", "stop"]);
    expect(organizerInstruction(), "a cancelled start left the mailbox organized here").toBe("idle");
    expect(standaloneHere()?.organizing).toBe(false);
    expect(log.stoppedOrganizing, "the cancel never reached the engine's release").toBe(1);
  });

  it("a SECOND start behind a queued one is not a second instruction", async () => {
    /**
     * ══ CONTROL 3b ════════════════════════════════════════════════════════════════════════
     *
     * Two presses of a verb that is already waiting are one instruction. Unbounded, the second
     * claims the mailbox again — and lands on a session the first has already raised.
     */
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    const release = holdDoor(log);

    const stopping = pressOrganizeHere("stop");
    await Promise.resolve();
    await expect(pressOrganizeHere("start")).resolves.toBe("queued");
    await expect(pressOrganizeHere("start"), "a second press queued a second instruction")
      .resolves.toBe("standing");

    release();
    await stopping;
    await Promise.resolve();
    expect(claims(log), "the mailbox was claimed twice for one press").toBe(1);
    expect(log.acts).toEqual(["stop", "claim"]);
  });

  it("STOP, START, STOP while the stop is in flight ends STOPPED — the LAST press wins", async () => {
    /**
     * ══ FINDING 4 ═══════════════════════════════════════════════════════════════════════════
     *
     * The word on screen was read before the queue, so this final Stop was answered `standing` —
     * the stop IS in flight — and the queued Start was never touched. It then ran, and the phone
     * organized the mailbox against the person's last press, with the notification back up.
     *
     * One standing instruction means the last press, so a press REPLACES what is queued.
     */
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    const release = holdDoor(log);

    const stopping = pressOrganizeHere("stop");
    await Promise.resolve();
    expect(organizerInstruction()).toBe("stopping");
    await expect(pressOrganizeHere("start")).resolves.toBe("queued");
    /* THE PERSON CHANGES THEIR MIND BACK. `standing` is honest — the act they want is the one
       being carried out — and what matters is that nothing is left waiting behind it. */
    await expect(pressOrganizeHere("stop"), "the last press was discarded as already standing")
      .resolves.toBe("standing");

    release();
    await stopping;
    await Promise.resolve();
    expect(log.acts, "the queued start outlived the press that countermanded it").toEqual(["stop"]);
    expect(claims(log), "the mailbox was claimed against the person's last press").toBe(0);
    expect(organizerInstruction()).toBe("idle");
    expect(standaloneHere()?.organizing).toBe(false);
    expect(organizerSessionLive(), "the notification came back up after a stop").toBe(false);
  });

  it("START, STOP, START while the start is in flight ends ORGANIZING — the mirror", async () => {
    /* The same defect the other way round: the final Start was answered `standing` and the queued
       Stop survived it, so the mailbox was released against the person's last press. */
    const log = doorLog();
    const door = fakeDoor(log);
    log.organizer = { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null };
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    const release = holdDoor(log);

    const starting = pressOrganizeHere("start");
    await Promise.resolve();
    expect(organizerInstruction()).toBe("starting");
    await expect(pressOrganizeHere("stop")).resolves.toBe("queued");
    await expect(pressOrganizeHere("start"), "the last press was discarded as already standing")
      .resolves.toBe("standing");

    release();
    await starting;
    await Promise.resolve();
    expect(log.acts, "the queued stop outlived the press that countermanded it").toEqual(["claim"]);
    expect(log.stoppedOrganizing, "the mailbox was released against the person's last press").toBe(0);
    expect(organizerInstruction()).toBe("running");
    expect(standaloneHere()?.organizing).toBe(true);
  });

  it("a press for the instruction already in force writes nothing", async () => {
    /* THE POSITIVE CONTROL for the refusals above: the ordinary presses are admitted, and only a
       press asking for what is already true answers `standing`. */
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    await expect(pressOrganizeHere("start"), "a start over a mailbox already organized here")
      .resolves.toBe("standing");
    expect(claims(log)).toBe(0);
    await expect(pressOrganizeHere("stop")).resolves.toBe("stopped");
    await expect(pressOrganizeHere("stop"), "a stop over a mailbox nothing organizes")
      .resolves.toBe("standing");
    expect(log.stoppedOrganizing, "a second stop reached the engine").toBe(1);
  });

  it("a REFUSED start is reported as refused, and leaves the instruction where the engine has it", async () => {
    /* The sentence the panel puts beside the verb is owed to a press that failed, and to no other
       state — `held` is the ordinary answer for a phone whose mailbox a laptop organizes. */
    const log = doorLog();
    const door = fakeDoor(log);
    log.organizer = { organizing: false, heldBy: null, reason: null , releaseRequestedAt: null};
    log.organizeStatus = 500;
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    await expect(pressOrganizeHere("start")).resolves.toBe("refused");
    expect(organizerInstruction(), "a refused start left `Starting` on the screen").toBe("idle");

    /* AND A LIVE FOREIGN CLAIM IS ITS OWN WORD. `standing` said "the instruction you asked for is
       already in force", which is false twice over — nothing of this install's organizes the
       mailbox, and nothing about the press was already happening. */
    log.organizeStatus = 409;
    await expect(pressOrganizeHere("start"), "a live foreign claim is not a failure")
      .resolves.toBe("held");
  });

  /**
   * ══ THE REFUSED PRESS IS RENDERED AT ONCE, AND THE FREE SENTENCE GOES WITH IT ══════════════
   *
   * Measured on the device: over a mailbox another phone was actively organizing, the panel read
   * `['Nothing organizes this mailbox', 'Start organizing here', 'Start organizing here']` at every
   * reading over the following minute after the door refused the press, and again after leaving Settings
   * and coming back. The door names the holder as it refuses, on the organizer state this panel
   * already reads, so the claim moves on the press itself rather than on a poll.
   */
  it("a press the door refuses names the holder on the spot, and withdraws the Start verb", async () => {
    const log = doorLog();
    const door = fakeDoor(log);
    /* THE MAILBOX THIS PHONE HANDED BACK: nothing of ours organizes it and no stand-down is
       remembered, which is the state where the panel said "Nothing organizes this mailbox". */
    log.organizer = { organizing: false, releaseRequestedAt: null, heldBy: null, reason: null };
    log.organizeStatus = 409;
    log.organizeHolder = { name: "ohmail on a phone", kind: "mobile" };
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    /* THE CONTROL — before the press the panel is right to offer the verb. */
    const before = claimHere(standaloneHere()!, organizerInstruction());
    expect(before).toEqual({ k: "free", starting: false });
    expect(mayStartHere(before)).toBe(true);

    await expect(pressOrganizeHere("start")).resolves.toBe("held");
    const after = claimHere(standaloneHere()!, organizerInstruction());
    expect(after, "the panel kept the free-mailbox sentence over a mailbox the door said is held")
      .toEqual({ k: "theirs", name: "ohmail on a phone", kind: "mobile" });
    expect(mayStartHere(after), "a live Start verb stood over a mailbox another install holds")
      .toBe(false);
    expect(mayStopHere(after), "a hand-back was offered over a claim this phone does not hold")
      .toBe(false);
    /* THE WORDING THE CLAIM EARNS is asserted in the claim's own file (`fourth-door.test.ts`):
       the reader chip, and the sentence with the phone clause a `mobile` holder earns. */
  });

  /**
   * THE DOOR'S CONSENT IS A START. After "Organize on this phone · Continue" the Ohbox read "Nothing
   * organizes this mailbox · Start organizing here" for over a minute until the claim: the consent
   * request ran outside the standing instruction and the gate waited for a poll. It is the `start`
   * act now, so the chip reads Starting until the claim lands, and the gate is asked at once.
   */
  it("the door's consent press reads Starting until the claim lands, and asks the gate at once", async () => {
    const log = doorLog();
    const door = fakeDoor(log);
    log.organizer = { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null };
    const forced = door.resume.bind(door);
    door.resume = async () => {
      const served = await forced();
      log.organizer = { organizing: true, heldBy: null, reason: null, releaseRequestedAt: null };
      return served;
    };
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    expect(claimHere(standaloneHere()!, organizerInstruction())).toEqual({ k: "free", starting: false });

    let letGo!: () => void;
    const answered = new Promise<void>((r) => { letGo = r; });
    const pressed = pressConsentHere(async () => { await answered; return "authorized"; });
    await Promise.resolve();
    const during = claimHere(standaloneHere()!, organizerInstruction());
    expect(during, "the consent read as a mailbox nothing organizes").toEqual({ k: "free", starting: true });
    expect(claimChipLabel(during)).toBe(EN.phoneStateStarting);
    letGo();
    await expect(pressed).resolves.toBe("started");
    expect(log.resumed, "the gate waited for a poll").toBe(1);
    expect(organizerInstruction()).toBe("running");
    expect(claimHere(standaloneHere()!, organizerInstruction()).k).toBe("ours");
  });

  it("a consent the door refuses for a live holder claims nothing, and the panel names the holder", async () => {
    const log = doorLog();
    const door = fakeDoor(log);
    log.organizer = { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null };
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    await expect(pressConsentHere(async () => {
      // The door names the holder as it refuses and records nothing, as production's does.
      log.organizer = { organizing: false, heldBy: "a laptop", reason: "organized_elsewhere:local", releaseRequestedAt: null };
      return "held";
    })).resolves.toBe("held");
    expect(log.resumed, "a refused consent forced a cycle").toBe(0);
    expect(claims(log), "a refused consent claimed").toBe(0);
    expect(organizerInstruction()).toBe("idle");
    expect(claimHere(standaloneHere()!, organizerInstruction())).toEqual({ k: "theirs", name: "a laptop", kind: "local" });
  });

  it("a holder the cycle finds after the door answered is named, never a could-not-check", async () => {
    const log = doorLog();
    const door = fakeDoor(log);
    log.organizer = { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null };
    const forced = door.resume.bind(door);
    door.resume = async () => {
      const served = await forced();
      // Another machine claimed between the door's answer and this cycle, and the gate stood down.
      log.organizer = { organizing: false, heldBy: "a laptop", reason: "organized_elsewhere:local", releaseRequestedAt: null };
      return served;
    };
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    await expect(pressConsentHere(async () => "authorized")).resolves.toBe("held");
    expect(claimHere(standaloneHere()!, organizerInstruction())).toEqual({ k: "theirs", name: "a laptop", kind: "local" });
  });

  it("the connection's consent press goes through it, with the request that states the screen's rule", () => {
    const conn = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "src/net/connection.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const body = conn.slice(conn.indexOf("const consentHere = useCallback("), conn.indexOf("const clearance = useRef("));
    expect(body).toMatch(/await pressConsentHere\(async \(\) => \{\s*said\.outcome = await organizeHere\(session, id\);/);
  });

  it("a start the door COULD NOT CHECK is `unreadable`, not `refused` and not `started`", async () => {
    /* The door answers 503 exactly where it could not see whether anybody holds the mailbox — no
       read-only accessor on the engine's adapter, or a claim folder the server would not hand
       over. Three words have to stay apart here: `started` is what this used to answer over a
       mailbox nothing had looked at, `refused` sends somebody looking for a fault on this phone,
       and `unreadable` is the one whose sentence says to press again. */
    const log = doorLog();
    const door = fakeDoor(log);
    log.organizer = { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null };
    log.organizeStatus = 503;
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    await expect(pressOrganizeHere("start")).resolves.toBe("unreadable");
    expect(organizerInstruction(), "a press the door could not check left `Starting` on screen").toBe("idle");
  });

  it("…and the SAME answer arriving LATE, after the door's own ceiling, is still `unreadable`", async () => {
    /* The door bounds the live look it pays for (`mobile.ts`, `IMAP_META_DEADLINE_MS`), so the 503
       above can now arrive a whole ceiling after the press instead of never arriving at all. The
       case above cannot say what happens meanwhile: it answers on the same tick. This one holds
       the door open across the press — `Starting` while the look is outstanding, which is the
       honest word — and asserts the late refusal still lands on the unreadable sentence rather
       than leaving the chip where device run 4 left it. */
    const log = doorLog();
    const door = fakeDoor(log);
    log.organizer = { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null };
    log.organizeStatus = 503;
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    const letGo = holdDoor(log);
    const pressing = pressOrganizeHere("start");
    await Promise.resolve();
    expect(organizerInstruction(), "the press did not say `Starting` while the look was outstanding")
      .toBe("starting");
    letGo();
    await expect(pressing, "a refusal that arrived late was not the door's own word")
      .resolves.toBe("unreadable");
    expect(organizerInstruction(), "a late 503 left `Starting` on the screen").toBe("idle");
  });

  it("a transition whose call never returns still ends on the ENGINE's word", async () => {
    /**
     * ══ CONTROL 4 (the bound) ══════════════════════════════════════════════════════════════
     *
     * The half a mutation found: every case above ends its transition by the press returning, so
     * the press's own reset and {@link settleInstruction} were two mechanisms covering one fact
     * and the second could be deleted green. It is what makes the chip bounded — a stop over a
     * wedged link can take a whole drain interval in the engine, and `Stopping` may not stand on
     * the screen for as long as a call happens to take.
     *
     * So the engine's answer is driven in mid-act, through the claim watch's own tick, with the
     * door still holding both verbs open. Both directions, because a `Stopping` that never ends
     * and a `Starting` that never ends are the same defect twice.
     */
    const log = doorLog();
    const door = fakeDoor(log);
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), sessionDeps(door, phaseLog()));
    const releaseStop = holdDoor(log);
    const stopping = pressOrganizeHere("stop");
    await Promise.resolve();
    expect(organizerInstruction()).toBe("stopping");
    /* THE GATE GOT THERE FIRST — the release landed on the server and the poll wrote it down while
       the app's own call is still outstanding. */
    log.organizer = { organizing: false, heldBy: null, reason: null , releaseRequestedAt: null};
    pokeOrganizerState();
    expect(organizerInstruction(), "`Stopping` outlived the engine saying it had stopped")
      .toBe("idle");
    expect(claimHere(standaloneHere()!, organizerInstruction())).toEqual({ k: "free", starting: false });
    releaseStop();
    await stopping;

    const releaseStart = holdDoor(log);
    const starting = pressOrganizeHere("start");
    await Promise.resolve();
    expect(organizerInstruction()).toBe("starting");
    log.organizer = { organizing: true, heldBy: null, reason: null , releaseRequestedAt: null};
    pokeOrganizerState();
    expect(organizerInstruction(), "`Starting` outlived the engine saying it held the claim")
      .toBe("running");
    releaseStart();
    await starting;
  });

  it("a release the mail server REFUSED leaves the session up, and the press says so", async () => {
    /**
     * ══ FINDING 3 ═════════════════════════════════════════════════════════════════════════
     *
     * The teardown ran unconditionally, so a refused release took the notification, the service
     * and both watches down over a phone that was STILL ORGANIZING: the row says organizer, the
     * claim stands, and the next launch resumes a mailbox nothing services — the state the
     * person's stop exists to end, arriving by the refusal arm. Android-shaped, because the
     * notification is the surface a person cannot argue with.
     */
    const log = doorLog();
    const door = fakeDoor(log);
    let running = false;
    let stops = 0;
    const service: BackgroundService = {
      start: async (_n: ServiceNotice) => { running = true; return true; },
      stop: async () => { running = false; stops += 1; },
      running: () => running,
      restricted: () => false,
      canPost: () => true,
      beat: () => running,
      beatIntervalMs: () => 30_000,
      onStopRequested: () => () => undefined,
    };
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "android",
      engine: {
        handBack: () => door.handBack(),
        resume: () => door.resume(),
        stopOrganizing: () => door.stopOrganizing(),
        claimHere: (opts) => door.claimHere(opts),
        organizing: () => [{ mailboxId: "m1", organizing: true, standDown: false, claimed: true }],
      },
      service,
      notice: () => ({ channelName: "Organizing", body: "…", stopLabel: "Stop", stopFailedBody: "Stop did not complete" }),
      appPhases: () => () => undefined,
    });
    /* ── THE REFUSAL ARM, IN PRODUCTION'S OWN SHAPE ─────────────────────────────────────────
       The cycle ran and could not confirm the claim left the mailbox. The engine answers
       `refused` AND reports `organizing: false` — a pass honouring a release arranges nothing
       either way — with the request still standing on the row. The double that answered `false`
       over `organizing: true` was the defect's twin: production answered `true` here, and this
       cell passed while the shipped app tore the notification down. */
    log.stopOrganizingAnswers = "refused";

    await expect(pressOrganizeHere("stop"), "a refused release was reported as a stop")
      .resolves.toBe("refused");

    /* THE PRESS ITSELF STOPS NOTHING. It does NOT claim the notification stands from here on: the
       claim watch drops the foreground service on its next tick off the engine's `organizing:
       false`, which is right — a notice reading "Organizing" over a pass arranging nothing is the
       false state in the other direction. What this measures is the press, and the session it
       leaves up: the watches go on, and the eventual release settles the panel. */
    expect(stops, "the press took the notification down over a refused release").toBe(0);
    expect(organizerSessionLive(), "the session was torn down by a refused release").toBe(true);
    /* ── AND THE PANEL SAYS WHAT IS TRUE: THE STOP IS STANDING, NOT DONE ────────────────────
       The press's transition is over, so the INSTRUCTION settles to `idle` — it is a word about
       an act, and the act finished. What the mailbox is in is the ROW's, and the row still holds
       the request: the chip is `ours/stopping` over a mailbox nobody else has, which is the one
       state the panel could not tell from a free mailbox before this field existed. */
    expect(organizerInstruction()).toBe("idle");
    expect(standaloneHere()?.organizing, "the engine arranges nothing while a release stands")
      .toBe(false);
    expect(standaloneHere()?.releaseRequestedAt, "the standing stop never reached the panel")
      .not.toBeNull();
    /* ── WHAT THE DEVICE PANEL SAYS, AND IT IS THE WHOLE POINT ─────────────────────────────
       Measured on a device at rc3: this arm read as a FREE mailbox with "Start organizing here"
       beside it, while the claim was still in the mailbox. The claim is `ours` — and it carries
       the ENGINE's second answer, the release still standing on the row, so the chip is its own
       word rather than `Organizing`: rendered as that it told somebody who had just pressed stop
       that nothing had happened, and offered them the same verb again. */
    const chip = claimHere(standaloneHere()!, organizerInstruction());
    expect(chip).toEqual({ k: "ours", stopping: false, releasePending: true });
    expect(claimChipLabel(chip), "the panel did not say the stop is still standing")
      .toBe(EN.phoneStateStopPending);
    /* AND THE VERB TO ASK AGAIN IS THERE, which is what `settingsStopHereFailed` tells the
       person to do: "Try again in a moment." */
    expect(mayStopHere(chip), "the only way to ask again was hidden").toBe(true);
    expect(mayStartHere(chip), "a start was offered over a mailbox this phone still holds")
      .toBe(false);
  });

  it("a stop the engine DID record still takes the notification with it", async () => {
    /* THE POSITIVE CONTROL for the cell above: the ordinary stop is admitted, and the teardown
       gated on the engine's answer must not make it conditional in the other direction. */
    const log = doorLog();
    const door = fakeDoor(log);
    let running = false;
    let stops = 0;
    const service: BackgroundService = {
      start: async (_n: ServiceNotice) => { running = true; return true; },
      stop: async () => { running = false; stops += 1; },
      running: () => running,
      restricted: () => false,
      canPost: () => true,
      beat: () => running,
      beatIntervalMs: () => 30_000,
      onStopRequested: () => () => undefined,
    };
    holdStandaloneDoor(door);
    startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "android",
      engine: {
        handBack: () => door.handBack(),
        resume: () => door.resume(),
        stopOrganizing: () => door.stopOrganizing(),
        claimHere: (opts) => door.claimHere(opts),
        organizing: () => [{ mailboxId: "m1", organizing: true, standDown: false, claimed: true }],
      },
      service,
      notice: () => ({ channelName: "Organizing", body: "…", stopLabel: "Stop", stopFailedBody: "Stop did not complete" }),
      appPhases: () => () => undefined,
    });

    await expect(pressOrganizeHere("stop")).resolves.toBe("stopped");
    expect(stops, "the notification outlived the stop").toBe(1);
    expect(organizerSessionLive()).toBe(false);
    expect(organizerInstruction()).toBe("idle");
  });

  it("the panel's whole input carries the STANDING STOP, so a completed release wakes the screen", () => {
    /* The chip reads the row's standing stop, so it is part of the panel's input. A release that
       completes moves ONLY that field — `organizing` was already false through the refusal — so a
       comparison without it leaves `Stopping` on an open screen until it is left and re-entered,
       which is the defect `pokeOrganizerState` exists to prevent, arriving through the new field. */
    const log = doorLog();
    const door = fakeDoor(log);
    log.organizer = {
      organizing: false, heldBy: null, reason: null, releaseRequestedAt: "2026-09-12T09:00:00.000Z",
    };
    holdStandaloneDoor(door);
    let woken = 0;
    const off = onOrganizerState(() => { woken += 1; });
    pokeOrganizerState();
    const settled = woken;
    pokeOrganizerState();
    expect(woken, "a settled panel was re-rendered on every tick").toBe(settled);
    /* THE RELEASE LANDS: the request is spent and nothing else about the mailbox moves. */
    log.organizer = { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null };
    pokeOrganizerState();
    expect(woken, "the completed release never reached an open screen").toBeGreaterThan(settled);
    off();
  });

  it("the panel's whole input carries the instruction, so a transition wakes an open screen", () => {
    /* `pokeOrganizerState` compares the panel's whole input. Without the instruction in it, the
       screen would not re-render between `Nothing organizes this mailbox` and `Starting`. */
    const log = doorLog();
    const door = fakeDoor(log);
    log.organizer = { organizing: false, heldBy: null, reason: null , releaseRequestedAt: null};
    holdStandaloneDoor(door);
    let woken = 0;
    const off = onOrganizerState(() => { woken += 1; });
    pokeOrganizerState();
    const settled = woken;
    pokeOrganizerState();
    expect(woken, "a settled panel was re-rendered on every tick").toBe(settled);
    const release = holdDoor(log);
    void pressOrganizeHere("start");
    expect(woken, "the transition did not reach an open screen").toBeGreaterThan(settled);
    release();
    off();
  });
});

describe("the consent the door already took", () => {
  /**
   * PHONE-STANDALONE-DOOR-CANNOT-GIVE-CONSENT. A mailbox nobody has consented to organizing is
   * READ and nothing else — no claim in `ohmail/_meta`, no `ohmail/*` tree, an Ohbox that never
   * fills. The one client that can record that consent is the client bound to the engine, and
   * until this arm existed there was none.
   *
   * These cases drive the press through the session this lane builds, over the door's own
   * transport, and assert the REQUEST's shape as well as the answer: the route, the method, and an
   * EMPTY body — the password is the engine's and inventing one here is the thing that must not
   * happen.
   */
  async function liveSession(log: DoorLog, door: StandaloneEngine) {
    const env = testEnv(heldPort(door));
    const row = await env.profiles.addStandalone({
      origin: LOCAL_ENGINE_ORIGIN, flavor: "local", accountId: door.accountId,
    });
    const outcome = await connectProfileById(env, row.id);
    if (outcome.kind !== "connected") throw new Error(`not connected: ${sayRefusal(outcome.reason)}`);
    return outcome.session;
  }

  it("presses the LOCAL consent route — the one with no second factor — with the person's marker and the rule's alone", async () => {
    const log = doorLog();
    const door = fakeDoor(log);
    const session = await liveSession(log, door);
    const out = await organizeHere(session, "m1");
    expect(out).toEqual({ kind: "authorized" });
    expect(log.urls).toContain(`${LOCAL_ENGINE_ORIGIN}/local/mailboxes/m1/organize`);
    /* THE PERSON'S MARKER, THE RULE'S, AND NOTHING ELSE. The person's lets the door record this consent
       even when another install holds the mailbox; `screenBacklog` says the screen stated
       what agreeing does to mail already there. A password here would be one this app does not hold,
       and a `screening` block a window nobody was asked for. */
    expect(log.organizeBodies).toEqual([JSON.stringify({ consent: "person", screenBacklog: true })]);
    session.store.close();
  });

  it("tells the idempotent answer apart from a fresh consent", async () => {
    /* A relaunch presses this every time. "You are now organizing" on every launch is a sentence
       about an event that did not happen. */
    const log = doorLog();
    log.organizeStatus = 200;
    log.organizeOutcome = "already_organizing";
    const door = fakeDoor(log);
    const session = await liveSession(log, door);
    expect(await organizeHere(session, "m1")).toEqual({ kind: "already" });
    session.store.close();
  });

  it("refuses the 200s that are NOT a claim rather than reporting them as organizing", async () => {
    /* FOUR outcomes share this status on the local door and two of them are a claim. `removed` and
       `no_mailbox` mean the mailbox is off this phone; reading either as organizing leaves an
       Ohbox that never fills behind a state the app called healthy. Both words, because the
       door returns each from its own branch and one of them passing proves nothing about the
       other. */
    for (const outcome of ["removed", "no_mailbox"]) {
      const log = doorLog();
      log.organizeStatus = 200;
      log.organizeOutcome = outcome;
      const door = fakeDoor(log);
      const session = await liveSession(log, door);
      const out = await organizeHere(session, "m1");
      expect(out.kind, outcome).toBe("refused");
      if (out.kind === "refused") expect(out.reason.say).toBe("organizeHereDisconnected");
      session.store.close();
    }
  });

  it("never presses the STEP-UP'D spelling, which this door answers 404", async () => {
    /* ══ THE MUTATION THIS CASE EXISTS TO CATCH ═══════════════════════════════════════════════
     *
     * Move the path back to `/mailboxes/:id/organize` and this goes red twice: no local press is
     * recorded, and the door answers 404 (its fallback, which is what the phone's engine answers
     * for that spelling too). On a device the same move answered 403 `step_up_required` from five
     * minutes after launch for the life of the process — a standalone install stamps its second
     * factor once at boot and can never produce another. */
    const log = doorLog();
    const door = fakeDoor(log);
    const session = await liveSession(log, door);
    expect(await organizeHere(session, "m1")).toEqual({ kind: "authorized" });
    expect(
      log.urls.filter((u) => u.endsWith("/mailboxes/m1/organize") && !u.includes("/local/")),
      "the app pressed the route that carries a second factor this tier cannot produce",
    ).toEqual([]);
    session.store.close();
  });

  it("carries a 409 out as HELD, with the holder and with NO sentence owed", async () => {
    /* ══ CONTROL 3 (the app's half) ═══════════════════════════════════════════════════════════
     *
     * This expected a `refused` with 409 in its sentence, which was right while the route never
     * answered 409 at all: the number was the only fact there was. The phone's door answers it
     * now, with the holder, and this refusal is not a fault — the mailbox IS being organized and
     * the panel already names the machine doing it. A sentence here would be noise over a true
     * state, once per claim-watch tick for as long as that machine kept the mailbox. */
    const log = doorLog();
    log.organizeStatus = 409;
    log.organizeHolder = { name: "a laptop", kind: "local" };
    const door = fakeDoor(log);
    const session = await liveSession(log, door);
    const out = await organizeHere(session, "m1");
    expect(out.kind).toBe("held");
    if (out.kind !== "held") return;
    expect(out.name).toBe("a laptop");
    expect(out.holderKind).toBe("local");
    session.store.close();
  });

  it("a 409 whose body says nothing is still HELD — the status is the fact", async () => {
    /* "Named nobody" and "nobody holds it" are different facts and the STATUS is what tells them
       apart; an absent name must not collapse into a free mailbox. */
    const log = doorLog();
    log.organizeStatus = 409;
    const door = fakeDoor(log);
    door.handle = async () => new Response("not json", { status: 409 });
    const session = await liveSession(log, door);
    const out = await organizeHere(session, "m1");
    expect(out.kind).toBe("held");
    if (out.kind === "held") expect(out.name).toBe("");
    session.store.close();
  });

  it("still carries EVERY OTHER status out with its number", async () => {
    /* The positive control for the arm above: 400 is a screening answer the door would not store,
       404 an engine older than the local spelling. Both are sentences a person can act on, which
       an Ohbox that never fills is not.
    
       503 LEFT THIS LIST WITH ITS REASON AND NOT WITH ITS STATUS. The door's own 503 carries
       `organizer_unreadable` and has its own sentence (the case below); a 503 this app does not
       recognise is still one of these, which is the arm kept here — the discrimination is on the
       CODE, so a build that moved every 503 would go red on this row. */
    for (const status of [400, 404, 503]) {
      const log = doorLog();
      log.organizeStatus = status;
      log.organizeErrorCode = "a_code_this_build_does_not_know";
      const door = fakeDoor(log);
      const session = await liveSession(log, door);
      const out = await organizeHere(session, "m1");
      expect(out.kind, `status ${status}`).toBe("refused");
      if (out.kind !== "refused") return;
      expect(out.reason.say).toBe("organizeHereRefused");
      expect(sayRefusal(out.reason)).toContain(String(status));
      session.store.close();
    }
  });

  it("ONLY A FINGER LICENSES IT — a launch spends nothing, and a press spends exactly one", () => {
    /**
     * ══ CONTROL 2 ════════════════════════════════════════════════════════════════════════════
     *
     * The press ran on every arrival through the shared connect body, and on a device that made a
     * plain relaunch a takeover: with a laptop holding the claim and heartbeating, the engine
     * decided `stand_down` at +2 s from boot and the app wrote a fresh `X-Ohmail-Authorized-At`
     * 2.3 s later, holding the claim at +19 s. Nobody was asked and no sentence was shown.
     *
     * `takeConsentPress` is the licence, and the two halves are each other's control: a launch
     * (nothing armed) spends nothing, and one press spends exactly once — a second connect in the
     * same run of the app must not re-spend the same finger.
     */
    /* A RELAUNCH: module state starts unarmed, which is what makes "in this run of the app" the
       real bound — a process restart clears it with no code. */
    expect(takeConsentPress(), "a launch with no press behind it recorded a consent").toBe(false);
    /* A PRESS: the door screen's Connect, or the panel's Start. */
    armConsentPress();
    expect(takeConsentPress()).toBe(true);
    /* AND IT IS SPENT. A switch away and back inside one run would otherwise press again. */
    expect(takeConsentPress(), "one press licensed two consents").toBe(false);
    /* ARMING TWICE IS STILL ONE PRESS — two taps on Connect are one act. */
    armConsentPress();
    armConsentPress();
    expect(takeConsentPress()).toBe(true);
    expect(takeConsentPress()).toBe(false);
  });

  it("the door screen ARMS it before it opens the engine — the press, read", () => {
    const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "app/standalone.tsx"), "utf8");
    const armed = src.indexOf("armConsentPress();");
    const opened = src.indexOf("await openStandaloneMailbox(fields, {");
    expect(armed, "the Connect press licenses no consent").toBeGreaterThan(-1);
    expect(armed, "the arm lands after the engine is opened").toBeLessThan(opened);
  });

  it("is made from the one connect body every standalone path shares — the composition, read", () => {
    /* Read rather than driven for the file's stated reason. The ORDER is the assertion: the press
       follows the adoption, and it is gated on the door AND on a finger. */
    const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "..", "src/net/connection.tsx"), "utf8");
    const adopted = src.indexOf("adopt(outcome.session);");
    const press = src.indexOf("if (organizesHere(outcome.session.profile) && asked) void consentHere(outcome.session);");
    expect(adopted, "the shared connect body is gone").toBeGreaterThan(-1);
    expect(press, "no standalone session records its consent").toBeGreaterThan(adopted);
    /* SPENT UNCONDITIONALLY AHEAD OF THE TEST, so a switch cannot leave an arm standing. */
    expect(src.indexOf("const asked = takeConsentPress();")).toBeGreaterThan(adopted);
    expect(src.indexOf("const asked = takeConsentPress();")).toBeLessThan(press);
    /* THE ID COMES OFF THE DOOR FIRST and the roster is only the second answer — read on a device,
       where the roster read was refused and took the press with it. */
    expect(src).toContain('const id = standaloneHere()?.id ?? (await readMailboxes(session))?.[0]?.id ?? "";');
    /* AND NEITHER ANSWERING IS A SENTENCE, not a silent skip: the defect being closed is silence. */
    expect(src).toContain('sayOrganizeRefused(refuse("organizeHereUnreadable"));');
    /* NOT `syncError`, which renders inside "Sync failed" — measured on a device announcing a sync
       failure for a mailbox whose sync had not failed. */
    expect(src).not.toContain('setSyncError(refuse("organizeHereUnreadable"));');
    /* AND A SUCCEEDING RETRY CLEARS THE PREVIOUS ATTEMPT'S SENTENCE. */
    expect(src).toContain('sayOrganizeRefused(outcome.kind === "refused" ? outcome.reason : null);');
  });

  /**
   * ══ THE FIRST CONSENT PRESS ON A PHONE THAT IS STILL CONNECTING ════════════════════════════
   *
   * Every phone mailbox is created a consent-less reader with no holder columns, so the FIRST
   * press always takes the live look (`PHONE-FIRST-CONSENT-NEEDS-A-READABLE-FOLDER`). Where the
   * launch has not finished dialling, that look does not land and the door answers 503
   * `organizer_unreadable` — deliberately never 409, because nobody may be told a machine has
   * their mailbox on a look that did not land.
   *
   * The app then read the STATUS ONLY and said *"Organizing this mailbox was refused (503).
   * Another machine may hold it — check what organizes it in Settings."* — a number a person
   * cannot act on, and the very claim the door refuses to make. The door's own code comment says
   * the app "renders this as its own sentence"; it did not until this case.
   */
  it("says what to do when the door could not read the claim, rather than a status number", async () => {
    const log = doorLog();
    log.organizeStatus = 503;
    const door = fakeDoor(log);
    const session = await liveSession(log, door);

    const out = await organizeHere(session, "m1");
    expect(out.kind).toBe("refused");
    if (out.kind !== "refused") { session.store.close(); return; }
    expect(out.reason.say).toBe("organizeHereStillLooking");
    const said = sayRefusal(out.reason);
    expect(said, "a status number reached somebody who cannot act on one").not.toMatch(/\d/);
    expect(said.length, "the sentence is empty").toBeGreaterThan(20);

    /* THE POSITIVE CONTROL, and it is the whole reason this arm is a sentence and not a defect:
       the same press once the launch has settled is RECORDED, with nothing to say about it. */
    log.organizeStatus = 200;
    expect(await organizeHere(session, "m1")).toEqual({ kind: "authorized" });

    /* AND EVERY OTHER STATUS KEEPS ITS NUMBER. 503 is the door's own third answer; the rest are
       states this app cannot name, and a number is the honest thing to carry for them. */
    log.organizeStatus = 500;
    const other = await organizeHere(session, "m1");
    expect(other.kind).toBe("refused");
    if (other.kind === "refused") expect(other.reason.say).toBe("organizeHereRefused");
    session.store.close();
  });

  /* PHONE-START-HERE-META-FOLDER-FULL: a folder the door could not read FOR A NAMED REASON is not
     "still connecting" — the press says the desktop row's sentence, the one a person can act on. */
  it.each([
    ["meta_folder_full", "phoneStateMetaFolderFull"],
    ["meta_undeletable", "phoneStateMetaUndeletable"],
  ] as const)("a 503 %s says the desktop row's sentence", async (code, say) => {
    const log = doorLog();
    log.organizeStatus = 503;
    log.organizeErrorCode = code;
    const session = await liveSession(log, fakeDoor(log));
    const out = await organizeHere(session, "m1");
    expect(out.kind).toBe("refused");
    if (out.kind === "refused") {
      expect(out.reason.say, "a named refusal read as a look still connecting").toBe(say);
      expect(sayRefusal(out.reason)).toContain("ohmail/_meta");
    }
    session.store.close();
  });
});

describe("the paired door is unchanged at this seam", () => {
  it("still refuses a NETWORK row with no refresh token", async () => {
    /* The refusal the standalone arm sits in front of. A standalone row is the one exception, and
       it is decided by the ORIGIN — so a pairing whose token a server cleared must still route to
       the re-pair and never to an engine that does not exist. */
    const env = testEnv(heldPort(fakeDoor(doorLog())));
    const paired = await env.profiles.add({
      origin: "https://srv.example", flavor: "selfhost", accountId: "a1", refreshToken: "r1",
    });
    await env.profiles.clearRefreshToken(paired.id, new Set(["r1"]));
    const row = (await env.profiles.list())[0]!;
    expect(row.refreshToken).toBeNull();
    const outcome = await connectProfile(env, row);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") return;
    expect(outcome.reason.say).toBe("pairEnded");
    expect(outcome.needsRepair).toBe(true);
  });

  it("still refuses cleartext to a network address", async () => {
    /* The admission the standalone arm is ahead of. `http://sidecar` is exempt because it is not
       an address; a real one is not, and this is the case that would go quiet if the arm were
       written as "any http origin with a door". */
    const env = testEnv(heldPort(fakeDoor(doorLog())));
    const row = await env.profiles.add({
      origin: "http://192.168.1.20:8028", flavor: "desktop", accountId: "a1", refreshToken: "r1",
    });
    const outcome = await connectProfile(env, row);
    expect(outcome.kind).toBe("refused");
    if (outcome.kind === "refused") expect(outcome.reason.say).toBe("admitCleartext");
  });
});

describe("the two screen lines a renderer cannot drive", () => {
  const HERE = fileURLToPath(new URL(".", import.meta.url));
  const read = (p: string): string => readFileSync(join(HERE, "..", p), "utf8");

  it("the door's success arm holds the engine and adopts it BEFORE it navigates", () => {
    const src = read("app/standalone.tsx");
    const hold = src.indexOf("holdStandaloneDoor(outcome.door)");
    const adopt = src.indexOf("conn.openStandalone(outcome.door)");
    const nav = src.indexOf('router.replace("/")');
    expect(hold, "the door is not held in the success arm").toBeGreaterThan(-1);
    expect(adopt, "the door is never adopted").toBeGreaterThan(-1);
    /* ORDER, not presence. The hold has to precede the adopt (the arm reads the door from there)
       and both have to precede the navigation that unmounts this screen. */
    expect(hold).toBeLessThan(adopt);
    expect(adopt).toBeLessThan(nav);
    /* AND A REFUSED ADOPTION IS SAID HERE rather than navigated past. */
    expect(src).toContain("setPhase({ k: \"failed\", reason: adopted.reason })");
  });

  it("the chooser names this phone rather than the engine's address, and never sends it to the scanner", () => {
    const src = read("app/servers.tsx");
    /* The predicate lives in `engine/standalone-door.ts`: a screen may not reach `engine/boot.ts`
       (the privacy census's rule), so it asks the door's own module for the answer. */
    expect(src).toContain("const here = organizesHere(profile)");
    /* `http://sidecar` is an address nothing dials. The row reads as the phone's own name, in the
       reader's language; the claim keeps its constant. */
    expect(src).toContain("{here ? Copy.standaloneName : profile.origin}");
    expect(src).not.toContain("PHONE_CLAIM_NAME");
    /* AND THE NEEDS-PAIR READING IS FENCED. Without this a row that carries no token by design
       would offer the QR scanner for the mailbox on the phone in somebody's hand. */
    expect(src).toContain("const needsPair = !here && profile.refreshToken === null");
    expect(src).toContain("{here ? Copy.serversStopHere : Copy.serversForget}");
    /* THE LIVE PANEL ABOVE THE LIST IS THE SAME QUESTION. It rendered the raw origin, which on
       this door is a name nothing dials — read off a device before this line existed. */
    expect(src).toContain("organizesHere(s.session.profile) ? Copy.standaloneName : s.session.profile.origin");
    /* AND THE NOTE UNDER THE LIST NAMES A DEVICES LIST ONLY WHERE A SERVER HOLDS ONE. */
    expect(src).toContain("conn.profiles.every(organizesHere) ? Copy.serversForgetNoteHere : Copy.serversForgetNote");
  });

  it("the More header names the phone's door rather than its address and account id", () => {
    /* Read off a device: the header showed the standalone origin and an opaque account id to a
       person whose mailbox is on the phone in their hand. Both facts are still there, in the words
       this door has — and the address comes from the ROW, because the profile never held one. */
    const src = read("src/state/world.tsx");
    expect(src).toContain("account: (rows) => organizesHere(session.profile)");
    expect(src).toContain('{ get name(): string { return Copy.standaloneName; }, email: rows?.[0]?.address ?? "" }');
    /* The title a German reader sees is German; the English one is the claim's own words. */
    expect(DE.standaloneName).toBe("ohmail auf diesem Handy");
    expect(EN.standaloneName).toBe(PHONE_CLAIM_NAME);
    /* THE PAIRED HEADER reads the same way since 2026-09-21: the server by its host and the
       mailbox from the row — a URL and a UUID were what the iPhone and the iPad showed. */
    expect(src).toContain('{ name: session.profile.origin.replace(/^https?:\\/\\//, ""), email: rows?.[0]?.address ?? "" }');
    expect(src).not.toContain("email: session.profile.accountId");
  });

  it("the This-phone panel turns the engine's own state into the claim, and names nobody", () => {
    /**
     * The screen line row 4 was about. RE-DERIVED with the design, and the old pin says why: it
     * held the panel to composing a `claimFrom` read whose holder came from `here.heldBy`, and
     * `claimFrom` recognises this install's own claim BY NAME. Every ohmail phone writes the same
     * display name, so with two phones on one mailbox the other phone's claim read as ours — a
     * chip saying "Organizing" and a hand-back verb over a mailbox this phone organizes nothing
     * of. The invariant the old pin was reaching for ("the panel passes the holder at all") is
     * kept and strengthened: the panel hands the door's WHOLE state to the reader that compares no
     * names, and the wording of both the chip and the sentence is asserted in the claim's own file.
     */
    const src = read("app/settings.tsx");
    expect(src, "the panel does not hand the door's state to the claim")
      .toContain("claim: claimHere(here, organizerInstruction(), organizerHandedBack()),");
    expect(src, "the door arm compares display names again")
      .not.toContain("{ name: here.heldBy");
    /* AND THE PAIRED ARM HAS NO NAME TEST EITHER. A paired phone writes no claim, so no holder a
       roster can name is ever this install's — the comparison is gone rather than re-sourced. */
    expect(src).toContain("known: w.mailboxes.known,");
    expect(src).toContain("organizer: claimHolderOf(row),");
    expect(src, "the paired arm decides identity by a display name again")
      .not.toContain("PHONE_CLAIM_NAME,");
    /* AND THE NOTE UNDER THE CHIP FOLLOWS THE STATE rather than always being the platform rule. */
    expect(src, "the panel says what a phone does about a mailbox another machine holds")
      .toContain("claimNoteLine(claim, Platform.OS, { declined: declinedHere(row.key) })");
    expect(src, "the platform rule is still rendered unconditionally")
      .not.toContain("platformRuleLine(Platform.OS)");
  });

  it("the forget ends the engine here before the row goes", () => {
    const src = read("src/net/connection.tsx");
    const end = src.indexOf("await endStandaloneHere()");
    const seam = src.indexOf("await forgetProfile(env, profileId");
    expect(end, "the forget never ends the engine on this phone").toBeGreaterThan(-1);
    expect(end).toBeLessThan(seam);
  });
});
