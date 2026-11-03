/**
 * ═══ THE WIRING — the door's confirm starts the organizer, the Settings stop ends it ═══════════
 *
 * `background.ts` landed with every arm measured and NO CALL SITE: nothing subscribed to
 * `AppState`, so an Android phone posted no notification and an iPhone left its claim standing
 * while it was suspended. This file measures the two ends of that subscription.
 *
 * ── WHY THE TWO CALL SITES ARE READ AS SOURCE AND THE MECHANISM IS DRIVEN ─────────────────────
 *
 * There is no React Native renderer in this workspace (`test/fourth-door.test.ts` records the
 * measurement), so a case that mounted the door would be no case at all. The split is therefore
 * the one that file already uses: everything that DECIDES lives in `src/engine/organizer-session.ts`
 * and is driven here through real transitions against a recording engine, and the two routes are
 * read to prove the decisions are actually wired to the presses — the confirm to the start, the
 * Settings sheet's confirm to the stop.
 *
 * ── THE ENGINE FIXTURE FAILS THE WAY THE ARTIFACT FAILS ───────────────────────────────────────
 *
 * `runtimes()` is the artifact's own shape (a record keyed by mailbox id), not the shape
 * `BackgroundEngine.organizing` wants, because the adapter between them is the thing that can be
 * wrong. `handBack` answers a count or `null`, both.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BackgroundService, ServiceNotice } from "../src/engine/background";
import {
  appPhaseOf,
  endStandaloneForRemoval,
  forgetOrganizerSessionForTests,
  holdStandaloneDoor,
  organizerBackgrounded,
  organizerHandedBack,
  organizerRestrictedSaid,
  organizerSessionLive,
  organizerSettingsLeft,
  organizerSettingsLeftOnlyHere,
  claimHereStandalone,
  stopOrganizingStandalone,
  sayOrganizerRestricted,
  standaloneHere,
  standaloneLaunchGeneration,
  startOrganizerSession,
  stopOrganizerSession,
} from "../src/engine/organizer-session";
import { CLAIM_LAPSES_AFTER_MINUTES, type StandaloneEngine } from "../src/engine/standalone-door";
import { claimChipLabel, claimHere, settingsLeftLine } from "../src/ui/standalone-form";
import { EN } from "../src/copy.en";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOOR = readFileSync(join(APP, "app/standalone.tsx"), "utf8");
const SETTINGS = readFileSync(join(APP, "app/settings.tsx"), "utf8");
const SESSION = readFileSync(join(APP, "src/engine/organizer-session.ts"), "utf8");
const NATIVE = readFileSync(join(APP, "src/engine/organizer-session-native.ts"), "utf8");
const CONNECTION = readFileSync(join(APP, "src/net/connection.tsx"), "utf8");

afterEach(() => {
  forgetOrganizerSessionForTests();
});

/** The artifact's own `runtimes()` shape, and the acts the background half drives. */
function engine(over: {
  organizing?: boolean;
  standDown?: boolean;
  /** Whether this install's claim stands. Defaults to `organizing`: a phone that organizes holds
   *  its mailbox, and every case here that says otherwise is a stand-down. */
  claimed?: boolean;
  released?: number | null;
  claimHere?: "claimed" | "held" | "refused";
  /** What the person's stop settles — see `StopOrganizingOutcome`. Default: the ordinary release. */
  stopOrganizing?: "released" | "not_organizing" | "refused";
} = {}) {
  const log = { handBacks: 0, resumes: 0, reads: 0, stops: 0, claims: 0 };
  return {
    log,
    engine: {
      handBack: async () => {
        log.handBacks += 1;
        return [{ mailboxId: "mb-1", released: over.released ?? 1 }];
      },
      resume: async () => { log.resumes += 1; return [{ mailboxId: "mb-1", served: 1 }]; },
      organizing: () => {
        log.reads += 1;
        return [{
          mailboxId: "mb-1",
          organizing: over.organizing ?? true,
          standDown: over.standDown ?? false,
          claimed: over.claimed ?? (over.standDown === true ? false : over.organizing ?? true),
        }];
      },
      stopOrganizing: async () => { log.stops += 1; return over.stopOrganizing ?? "released"; },
      claimHere: async () => { log.claims += 1; return over.claimHere ?? "held"; },
    },
  };
}

function service(over: { showing?: boolean; restricted?: boolean } = {}) {
  const log = {
    started: 0, stopped: 0, running: false, notice: null as ServiceNotice | null,
    fire: null as (() => void) | null, unsubscribed: 0,
  };
  const impl: BackgroundService = {
    start: async (notice) => {
      log.started += 1;
      log.notice = notice;
      log.running = over.showing ?? true;
      return log.running;
    },
    stop: async () => { log.stopped += 1; log.running = false; },
    running: () => log.running,
    restricted: () => over.restricted ?? false,
    canPost: () => true,
    beat: () => log.running,
    beatIntervalMs: () => 30_000,
    onStopRequested: (listener) => {
      log.fire = listener;
      return () => { log.unsubscribed += 1; log.fire = null; };
    },
  };
  return { service: impl, log };
}

/** A driver standing in for `AppState`, so a real transition can be pushed through the wiring. */
function phases() {
  const log = { subscribed: 0, unsubscribed: 0, push: null as ((s: string) => void) | null };
  return {
    log,
    appPhases: (listener: (s: string) => void) => {
      log.subscribed += 1;
      log.push = listener;
      return () => { log.unsubscribed += 1; log.push = null; };
    },
  };
}

/**
 * A DOOR, minimally — the two members {@link standaloneHere} reads, and the rest typed so the
 * double cannot drift from the artifact's shape. `runtimes()` answers the free state (this install
 * organizes nothing, nobody else holds it), which is exactly what a phone's row looks like the
 * moment after it has handed its claim back: the transitional state is NOT visible in this answer,
 * which is why the panel needed the session's flag and why reading it is the fix under test.
 */
function fakeDoor(organizer: {
  organizing: boolean; heldBy: string | null; reason: string | null; releaseRequestedAt: string | null;
  claimed: boolean;
} = { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null, claimed: false }): StandaloneEngine {
  const no = async (): Promise<never> => { throw new Error("not driven by this case"); };
  return {
    accountId: "engine-account",
    address: "held@example.test",
    sessionToken: "engine-launch-token",
    handle: no,
    stop: async () => undefined,
    /* The door's own sink. These cases read the session, not the log, so it drops what it is
       handed — but a door that carries none is a shape the app no longer builds. */
    log: () => undefined,
    handBack: async () => [{ mailboxId: "m1", released: 1 }],
    leave: () => undefined,
    forgetStoredLogin: async () => true,
    serverSettings: async () => null,
    resume: async () => [{ mailboxId: "m1", served: 1 }],
    claimHere: no,
    heldElsewhere: async () => null,
    stopOrganizing: no,
    runtimes: () => ({
      organizer: { m1: organizer },
      /* `firstSync` is the engine's own word for what the first drain produced; a door that
         answers the rest and not this one is a shape the app no longer has. */
      connection: { m1: { reachable: true, unreachableSince: null, signInRefused: false, firstSync: "finished" } },
    }),
  };
}

/* ── the mapping ─────────────────────────────────────────────────────────────────────────────── */

describe("React Native's app status, narrowed to the three edges that decide", () => {
  /**
   * `unknown` and `extension` are states in which nothing has happened to the mailbox, so they map
   * onto the phase `background.ts` IGNORES. Reading either as a background would hand the mailbox
   * back for a transition nobody made — which on iOS is a window in which a desktop takes it.
   */
  it("maps the two acts and ignores every other status", () => {
    expect(appPhaseOf("active")).toBe("active");
    expect(appPhaseOf("background")).toBe("background");
    for (const status of ["inactive", "unknown", "extension", ""]) {
      expect(appPhaseOf(status), status).toBe("inactive");
    }
  });
});

/* ── the start ───────────────────────────────────────────────────────────────────────────────── */

describe("the door's confirm starts the organizer session", () => {
  it("subscribes to the app's own lifecycle, and a background reaches the engine", async () => {
    const e = engine();
    const s = service();
    const p = phases();
    expect(startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "android", engine: e.engine, service: s.service,
      notice: () => ({ channelName: EN.stateOrganizing, body: EN.notifBody("a@b.test"), stopLabel: EN.notifStop, stopFailedBody: EN.notifStopFailed }),
      appPhases: p.appPhases,
    }), "the first start did not take").toBe(true);
    expect(organizerSessionLive()).toBe(true);
    expect(p.log.subscribed, "nothing subscribed to the app state").toBe(1);

    /* THE TRANSITION, THROUGH THE WIRING. Not `organizing.phaseChanged` — the whole point of this
       file is that the subscription exists, so the push goes in where `AppState` would put it. */
    p.log.push!("background");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.log.started, "the foreground service was never started").toBe(1);
    expect(s.log.notice?.body, "the notification does not name the mailbox")
      .toBe(EN.notifBody("a@b.test"));
    expect(organizerBackgrounded()).toBe(true);
  });

  /**
   * iOS HANDS THE MAILBOX BACK AND TAKES IT AGAIN — the same wiring, no service.
   *
   * The iPhone half has no emulator anywhere in this environment, so this transition IS the
   * measurement rather than a stand-in for one.
   */
  it("hands the mailbox back on the way out and asks the gate on the way in", async () => {
    const e = engine();
    const p = phases();
    startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "ios", engine: e.engine, service: null,
      notice: () => ({ channelName: EN.stateOrganizing, body: EN.notifBody("a@b.test"), stopLabel: EN.notifStop, stopFailedBody: EN.notifStopFailed }),
      appPhases: p.appPhases,
    });
    p.log.push!("background");
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(e.log.handBacks, "the claim was not handed back").toBe(1);
    expect(organizerHandedBack()).toBe(true);
    p.log.push!("active");
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(e.log.resumes, "the gate was not asked on the way back in").toBe(1);
    expect(organizerHandedBack()).toBe(false);
  });

  /**
   * ══ AND THE ROW SAYS SO — the wiring the flag was missing ══════════════════════════════════
   *
   * PHONE-SETTINGS-HAS-NO-HANDED-BACK-ROW. `organizerHandedBack()` was readable and nothing read
   * it, so between the release above and the resume below the panel composed its claim out of
   * `runtimes()` alone — which in this window answers the FREE state, the same answer a mailbox
   * nothing has ever organized gives. Settings therefore said "Nothing organizes this mailbox" and
   * offered "Start organizing here" about a claim this phone gave back on its way out.
   *
   * Driven through the real transition rather than by setting a flag: the pure arm is measured in
   * `fourth-door.test.ts`, and what this adds is that the fact travels from the background half to
   * the object the panel actually reads. `standaloneHere()` carries it, one reader, so the chip
   * and anything else asking cannot answer differently.
   */
  it("carries the transitional state onto the row Settings reads, and clears it on the way in", async () => {
    const e = engine();
    const p = phases();
    holdStandaloneDoor(fakeDoor());
    startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "ios", engine: e.engine, service: null,
      notice: () => ({ channelName: EN.stateOrganizing, body: EN.notifBody("a@b.test"), stopLabel: EN.notifStop, stopFailedBody: EN.notifStopFailed }),
      appPhases: p.appPhases,
    });
    /* THE PREMISE — before the transition the row is the free one, and the chip says so. Without
       this the case below could pass over a row that had always read `handedBack`. */
    const before = standaloneHere()!;
    expect(organizerHandedBack(), "the flag was up before anything handed anything back").toBe(false);
    expect(claimChipLabel(claimHere(before, "idle", organizerHandedBack())))
      .toBe(EN.phoneStateNotOrganized);

    p.log.push!("background");
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    const handed = standaloneHere()!;
    expect(organizerHandedBack(), "the reader Settings uses did not carry the hand-back").toBe(true);
    /* THE WHOLE DEFECT IN ONE LINE: the same `runtimes()` answer, and the chip is no longer the
       free one. */
    expect(claimHere(handed, "idle", organizerHandedBack())).toEqual({ k: "handedBack" });
    expect(claimChipLabel(claimHere(handed, "idle", organizerHandedBack())))
      .toBe(EN.phoneStateHandedBack);

    /* AND IT CLEARS ON THE FIRST WAY BACK IN — design risk 5: the transitional state must not
       outlive the cycle that ends it, or the row says "Handed back" over a phone that is filing. */
    p.log.push!("active");
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    const back = standaloneHere()!;
    expect(organizerHandedBack(), "`Handed back` outlived the resume that ended it").toBe(false);
    expect(claimChipLabel(claimHere(back, "idle", organizerHandedBack())))
      .toBe(EN.phoneStateNotOrganized);
  });

  /**
   * EXACTLY ONE ACTIVE ORGANIZER PER MAILBOX is the product's invariant, and two sessions are two
   * `AppState` listeners racing one release. The second start is refused AND the live one is
   * asserted afterwards: a returned `false` with the session quietly swapped is the defect.
   */
  it("keeps the first session and refuses a second", () => {
    const first = phases();
    const second = phases();
    const notice = () => ({ channelName: EN.stateOrganizing, body: EN.notifBody("a@b.test"), stopLabel: EN.notifStop, stopFailedBody: EN.notifStopFailed });
    expect(startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "ios", engine: engine().engine, service: null, notice, appPhases: first.appPhases,
    })).toBe(true);
    expect(startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "ios", engine: engine().engine, service: null, notice, appPhases: second.appPhases,
    }), "a second session was accepted").toBe(false);
    expect(second.log.subscribed, "the second session subscribed anyway").toBe(0);
    expect(first.log.unsubscribed, "the live session was torn down by the refused one").toBe(0);
  });

  /** The battery-saver record, and the deck sentence Settings renders from it. */
  it("records the restricted announcement, once, and says nothing before it", async () => {
    expect(organizerRestrictedSaid()).toBe(false);
    const s = service({ restricted: true });
    const p = phases();
    startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "android", engine: engine().engine, service: s.service,
      notice: () => ({ channelName: EN.stateOrganizing, body: EN.notifBody("a@b.test"), stopLabel: EN.notifStop, stopFailedBody: EN.notifStopFailed }),
      appPhases: p.appPhases,
    });
    p.log.push!("background");
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(s.log.started, "a restricted phone started a service anyway").toBe(0);
    expect(organizerRestrictedSaid(), "the restriction was not recorded").toBe(true);
  });

  /** A build that cannot reach its own background half says so rather than looking healthy. */
  it("records the same fact when the platform half cannot be reached at all", () => {
    expect(organizerRestrictedSaid()).toBe(false);
    sayOrganizerRestricted();
    expect(organizerRestrictedSaid()).toBe(true);
  });
});

/* ── the stop ────────────────────────────────────────────────────────────────────────────────── */

describe('"Stop organizing here" ends it', () => {
  /**
   * THE NOTIFICATION COMES DOWN WITH THE CLAIM — Android, over a service that really came up.
   *
   * The release route has already removed the claim and written `organizer_role = 'reader'`, so a
   * service left standing says "Organizing <address>" over a phone that reads, on the one surface
   * a person cannot argue with.
   */
  it("drops the notification and both subscriptions", async () => {
    const e = engine();
    const s = service();
    const p = phases();
    startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "android", engine: e.engine, service: s.service,
      notice: () => ({ channelName: EN.stateOrganizing, body: EN.notifBody("a@b.test"), stopLabel: EN.notifStop, stopFailedBody: EN.notifStopFailed }),
      appPhases: p.appPhases,
    });
    p.log.push!("background");
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(s.log.running, "the service never came up, so the stop proves nothing").toBe(true);

    await stopOrganizerSession();

    expect(s.log.stopped, "the notification was left standing over a reader").toBe(1);
    expect(s.log.running).toBe(false);
    expect(p.log.unsubscribed, "the app-state listener outlived the session").toBe(1);
    expect(s.log.unsubscribed, "the notification's stop listener outlived the session").toBe(1);
    expect(organizerSessionLive()).toBe(false);
    expect(organizerBackgrounded()).toBe(false);
  });

  /**
   * AND IT HANDS NOTHING BACK — measured on iOS, which is the arm where the wrong answer is
   * REACHABLE.
   *
   * "Stop" and "hand the mailbox back" are one act everywhere else in this app, so the obvious
   * wrong implementation of this function is to drive the machine's own background arm on the way
   * out. On iOS that arm hands the claim back, and by this point the release route has already
   * removed it and recorded this install as a reader — so the write would ask the server to
   * expunge records by our own id on a mailbox this install has been told it does not hold.
   *
   * The same mutation on the Android arm is GREEN, because a background with a healthy service
   * hands nothing back: the assertion there would have had no reachable contrary state. It is here
   * instead, where it does.
   */
  it("hands no claim back — the release route already took it", async () => {
    const e = engine();
    const p = phases();
    startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "ios", engine: e.engine, service: null,
      notice: () => ({ channelName: EN.stateOrganizing, body: EN.notifBody("a@b.test"), stopLabel: EN.notifStop, stopFailedBody: EN.notifStopFailed }),
      appPhases: p.appPhases,
    });
    expect(e.log.handBacks, "the start handed the mailbox back on its own").toBe(0);
    await stopOrganizerSession();
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(e.log.handBacks, "the stop handed back a claim it does not hold").toBe(0);
    expect(organizerSessionLive()).toBe(false);
  });

  it("is idempotent, and harmless with no session at all", async () => {
    await expect(stopOrganizerSession()).resolves.toBeUndefined();
    const s = service();
    const p = phases();
    startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "android", engine: engine().engine, service: s.service,
      notice: () => ({ channelName: EN.stateOrganizing, body: EN.notifBody("a@b.test"), stopLabel: EN.notifStop, stopFailedBody: EN.notifStopFailed }),
      appPhases: p.appPhases,
    });
    await stopOrganizerSession();
    await stopOrganizerSession();
    expect(s.log.stopped, "the second stop reached the platform again").toBe(1);
  });

  /** A platform whose stop throws must not leave the app holding a dead session. */
  it("clears the session even when the platform's stop throws", async () => {
    const p = phases();
    const s = service();
    const throwing: BackgroundService = { ...s.service, stop: async () => { throw new Error("gone"); } };
    startOrganizerSession(standaloneLaunchGeneration(), {
      platform: "android", engine: engine().engine, service: throwing,
      notice: () => ({ channelName: EN.stateOrganizing, body: EN.notifBody("a@b.test"), stopLabel: EN.notifStop, stopFailedBody: EN.notifStopFailed }),
      appPhases: p.appPhases,
    });
    await expect(stopOrganizerSession()).resolves.toBeUndefined();
    expect(organizerSessionLive()).toBe(false);
    expect(p.log.unsubscribed).toBe(1);
  });

  /** Nothing reads the session's rows once it is over — the Settings row says nothing, not false. */
  it("answers false, never a remembered state, once the session is gone", async () => {
    expect(organizerSessionLive()).toBe(false);
    expect(organizerBackgrounded()).toBe(false);
    expect(organizerHandedBack()).toBe(false);
  });
});

/* ── the two presses, read off the routes ────────────────────────────────────────────────────── */

describe("the wiring is actually on the presses", () => {
  /**
   * THE START IS INSIDE THE CONFIRM'S SUCCESS ARM, not somewhere in the file.
   *
   * A `/connect[\s\S]*?startOrganizerSessionNative/` match would pass for a call anywhere below,
   * so the slice is bounded at the top by the `outcome.ok` branch and at the bottom by the
   * navigation that ends it — the two lines that make it the confirm's own arm.
   */
  it("starts the session in the door's success arm, before the navigation away", () => {
    const ok = DOOR.indexOf("if (outcome.ok)");
    expect(ok, "the door has no success arm").toBeGreaterThan(-1);
    const nav = DOOR.indexOf('router.replace("/")', ok);
    expect(nav, "the success arm does not navigate").toBeGreaterThan(ok);
    const arm = DOOR.slice(ok, nav);
    expect(arm, "the engine is not wired to the app's lifecycle on a successful open")
      .toContain("startOrganizerSessionNative(outcome.door");
    expect(arm, "a failed load of the background half is swallowed")
      .toContain("sayOrganizerRestricted()");
  });

  /**
   * ══ BOTH WAYS IN HAND THE ENGINE A SINK, AND THE CENSUS IS THE WHOLE POINT ════════════════
   *
   * PHONE-STANDALONE-ROSTER-READ-FAILS-ON-A-DEVICE-ONLY was diagnosed off a mail server's wire
   * because the engine on a phone wrote nothing anywhere: the app composed `startEngine` without
   * a `logSink`, `startPhoneEngine` treats absence as "no channel", and every refusal inside the
   * artifact was therefore unreadable. Both entries carry one now — and nothing held them to it,
   * which is how the first one came to be missing. There are exactly TWO compositions in this app
   * and they arrive in opposite states (a press, and a cold relaunch with no screen in front of
   * it); a phone that loses either is back to reading device defects off IMAP.
   *
   * Read as source for this file's stated reason — there is no React Native renderer here, and the
   * sink's EFFECT is driven end to end over the real artifact in `engine-bundle-loads.test.ts`.
   * The needle is a call ARGUMENT, never a comment, and each is bounded to its own object literal
   * by brace depth so a `logSink` anywhere else in the file cannot answer for it.
   */
  it("hands the engine a log sink on BOTH ways in — the press and the cold relaunch", () => {
    /** The object literal that starts at `from`, by brace depth — never the rest of the file. */
    const literal = (src: string, from: number): string => {
      const open = src.indexOf("{", from);
      expect(open, "the composition passes no object at all").toBeGreaterThan(-1);
      let depth = 0;
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === "{") depth += 1;
        else if (src[i] === "}") {
          depth -= 1;
          if (depth === 0) return src.slice(open, i + 1);
        }
      }
      throw new Error("the composition's object literal never closes");
    };

    /* THE PRESS — `app/standalone.tsx`, behind the form. */
    const press = DOOR.indexOf("await openStandaloneMailbox(fields, {");
    expect(press, "the door screen no longer opens the mailbox here").toBeGreaterThan(-1);
    expect(literal(DOOR, press), "the door press starts an engine that writes no line anywhere")
      .toContain("logSink:");

    /* THE COLD RELAUNCH — `src/net/connection.tsx`, with no screen in front of it, which is the
       one that needs it most: a dial that comes up and then files nothing has no other reader. */
    const relaunch = CONNECTION.indexOf("reopen: () => reopenWithBackground({");
    expect(relaunch, "the connection layer no longer reopens the mailbox here").toBeGreaterThan(-1);
    expect(literal(CONNECTION, relaunch), "a relaunch starts an engine that writes no line anywhere")
      .toContain("logSink:");

    /* AND EXACTLY TWO, so a third way in cannot be added past this census. */
    const starts = (src: string, needle: string): number => src.split(needle).length - 1;
    expect(starts(DOOR, "openStandaloneMailbox(") + starts(CONNECTION, "reopenStandaloneMailbox("),
      "a third composition can start the engine without a sink").toBe(2);
  });

  /**
   * THE STOP IS ON THE SHEET'S CONFIRM — the deliberate press — and not on the panel's verb, which
   * only opens the sheet. A stop wired to the verb would end somebody's organizing on the press
   * that asks the question.
   */
  it("stops the session on the Settings confirm, through the one door", () => {
    const confirm = SETTINGS.indexOf("label={Copy.settingsStopHereConfirm}");
    expect(confirm, "the confirm is not rendered").toBeGreaterThan(-1);
    const row = SETTINGS.slice(confirm, SETTINGS.indexOf("Copy.settingsStopHereCancel", confirm));
    /* ── ONE ACT, AND ONE CARD IT CAN BE ABOUT ────────────────────────────────────────────
     *
     * The release and the teardown used to be two unawaited calls in this handler, beside a
     * `setAsked` the panel held for the screen's life — three writers of one instruction with
     * nothing ordering them. They are ONE act now, so the confirm reaches the one door and the
     * door's stop is what takes the notification down.
     *
     * The PAIRED half of this handler is gone with the name test that was the only thing that
     * reached it: `mayStopHere` answers true for `ours` alone, and on a paired roster nothing
     * produces one — a paired phone writes no claim, so no holder a roster names is ever this
     * install's. The route it called answers "not organizing" for every claim that is not the
     * answering server's own, which is what a press in that state actually did. */
    expect(row, "a paired row can ask the server it is paired to to give up a claim again")
      .not.toContain("releaseMailbox(");
    expect(row, "the standalone stop does not go through the one door")
      .toContain('pressOrganizeHere("stop")');
    const stop = SESSION.slice(SESSION.indexOf("async function stopHere("));
    expect(stop.slice(0, stop.indexOf("\n}")), "the notification is left standing after the stop")
      .toContain("stopOrganizerSession()");
    /* AND NOT ON THE VERB. `onPress={() => setConfirming(row.key)}` is the panel's press. */
    const verb = SETTINGS.indexOf("label={Copy.settingsStopHere}");
    const element = SETTINGS.slice(SETTINGS.lastIndexOf("<Button", verb), verb + 200);
    expect(element, "the panel's verb stops the organizing without a confirm")
      .not.toContain("pressOrganizeHere");
  });

  /**
   * The battery-saver sentence has a place to be read, which is what `announceRestricted` needs.
   *
   * The anchor moved with the design and the ORDER it exists for did not: the note under the chip
   * is `claimNoteLine` now — the platform rule for the three states it is true of, the holder's
   * sentence for the two it is not — and the restricted line still sits directly under it, because
   * the deck's note contradicts the rule line above it.
   */
  it("renders the restricted sentence in Settings, under the state's own note", () => {
    expect(SETTINGS).toContain("organizerRestrictedSaid()");
    expect(SETTINGS).toContain("Copy.organizerRestricted");
    const rule = SETTINGS.indexOf("claimNoteLine(claim, Platform.OS, { declined: declinedHere(row.key) })");
    expect(rule, "the panel renders no note under the chip").toBeGreaterThan(-1);
    expect(SETTINGS.indexOf("Copy.organizerRestricted"), "the sentence is not beside the rule")
      .toBeGreaterThan(rule);
  });

  /**
   * THE PLATFORM HALF SUPPLIES FACTS AND HAS NO DECISION OF ITS OWN.
   *
   * The four platform facts are read off the file rather than driven, because a module that
   * imports `react-native` cannot be loaded by this suite at all — the reason `background.ts` and
   * `background-native.ts` are two files. What is asserted is the shape: the task is registered,
   * the three platform seams are the ones the state machine names, and the notice is a GETTER over
   * the deck rather than a captured string, so a language switch between two backgrounds is read.
   */
  it("binds the platform's four facts and decides nothing", () => {
    expect(NATIVE, "the headless task is never registered").toContain("registerOrganizerTask()");
    expect(NATIVE, "the service is not the native one").toContain("nativeBackgroundService()");
    expect(NATIVE, "the app state is not subscribed").toContain('AppState.addEventListener("change"');
    expect(NATIVE, "the platform is not read").toContain("Platform.OS");
    /* A GETTER, so the deck is read at the moment the service starts. A captured object would
       freeze the language this door happened to be opened in. */
    expect(NATIVE).toContain("notice: () => ({");
    /* The body follows the gate (`organizer-notice.ts`, which says `Copy.notifBody` where it is open). */
    for (const key of ["Copy.stateOrganizing", "organizerNoticeBody(address, engine.runtimes().organizer)", "Copy.notifStop"]) {
      expect(NATIVE, `the notice does not carry ${key}`).toContain(key);
    }
    /* AND THE ADDRESS IS NEVER LOGGED. The notification's body carries it; nothing else may. */
    expect(NATIVE, "the platform half logs").not.toMatch(/\bconsole\./);
  });

  /**
   * THE FIFTH FACT: WHERE THE BACKGROUND HALF'S LINES GO.
   *
   * This argument was simply missing, and with it every decline the state machine makes — a
   * refused notification, battery saver, a build with no organizer service. The engine's own
   * hardened logger is handed straight through, NOT wrapped: an app that wraps this seam is one
   * edit away from composing `detail` objects of its own, which is a second logger outside the
   * field allowlist and the redaction.
   */
  it("hands the background half the engine's own logger, unwrapped", () => {
    expect(NATIVE, "the background half gets no logger, so its declines are invisible")
      .toContain("log: engine.log");
    expect(NATIVE, "the app wraps the engine's logger instead of handing it over")
      .not.toMatch(/log:\s*\((?:event|e)\b/);
  });
});

/* ── what the stop left off the mailbox ──────────────────────────────────────────────────────── */

describe("a stop that could not leave this phone's settings in the mailbox says so", () => {
  const released = { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null, claimed: false };
  function doorAfterStop(settingsLeft?: "saved" | "kept_other" | "not_saved"): StandaloneEngine {
    const door = fakeDoor({ ...released, ...(settingsLeft ? { settingsLeft } : {}) });
    return { ...door, stopOrganizing: async () => "released", claimHere: async () => "claimed" };
  }

  it("keeps the engine's kept_other or not_saved off the release record, and nothing when it saved", async () => {
    for (const [left, said] of [
      ["kept_other", EN.settingsStopLeftOther], ["not_saved", EN.settingsStopLeftUnsaved], ["saved", null], [undefined, null],
    ] as const) {
      forgetOrganizerSessionForTests();
      expect(holdStandaloneDoor(doorAfterStop(left))).toBe(true);
      expect(await stopOrganizingStandalone()).toBe("released");
      const kept = organizerSettingsLeft();
      expect(kept, String(left)).toBe(left === "kept_other" || left === "not_saved" ? left : null);
      expect(settingsLeftLine(kept, { k: "free", starting: false }), String(left)).toBe(said);
    }
  });

  /* SETTINGS' START IS A FINGER, so it carries the person's consent: the claim watch
     is the only presser without it, which is what keeps a machine from minting one. */
  it("presses the engine as a PERSON — the Start verb carries the consent the watch never does", async () => {
    forgetOrganizerSessionForTests();
    const asked: unknown[] = [];
    const door = fakeDoor(released);
    expect(holdStandaloneDoor({
      ...door, claimHere: async (opts) => { asked.push(opts); return "claimed"; },
    })).toBe(true);
    expect(await claimHereStandalone()).toBe("claimed");
    expect(asked).toEqual([{ by: "press" }]);
  });

  it("is never said over a phone still organizing, and the next start clears it", async () => {
    expect(holdStandaloneDoor(doorAfterStop("kept_other"))).toBe(true);
    await stopOrganizingStandalone();
    expect(settingsLeftLine(organizerSettingsLeft(), { k: "ours", stopping: false, releasePending: false })).toBeNull();
    expect(await claimHereStandalone()).toBe("claimed");
    expect(organizerSettingsLeft()).toBeNull();
  });

  it("Settings renders the sentence under the card", () => {
    expect(SETTINGS).toContain("settingsLeftLine(organizerSettingsLeft(), claim)");
  });
});

/* ── what a Stop and remove would drop ───────────────────────────────────────────────────────── */

describe("the store's own read of what Stop and remove would drop", () => {
  it("is the engine's answer, and null where no door, no read or a failed read can say", async () => {
    forgetOrganizerSessionForTests();
    const none = await organizerSettingsLeftOnlyHere();
    expect(holdStandaloneDoor(fakeDoor())).toBe(true);
    const older = await organizerSettingsLeftOnlyHere();
    forgetOrganizerSessionForTests();
    expect(holdStandaloneDoor({ ...fakeDoor(), settingsLeftOnlyHere: async () => "answer" })).toBe(true);
    const answered = await organizerSettingsLeftOnlyHere();
    forgetOrganizerSessionForTests();
    expect(holdStandaloneDoor({ ...fakeDoor(), settingsLeftOnlyHere: async () => { throw new Error("the store is closed"); } })).toBe(true);
    expect({ none, older, answered, failed: await organizerSettingsLeftOnlyHere() })
      .toEqual({ none: null, older: null, answered: "answer", failed: null });
  });
});

/* ── what the removal's end leaves in the store ──────────────────────────────────────────────── */

/* THE HAND-BACK'S WRITE IS THE ONE THAT FINDS A FULL MAILBOX, so the removal reads the store after it, while
   the engine still runs (its store closes with it). The forget keeps the store for anything but `null`, and `null`
   only where the store says no more than the mailbox's last copy or, with no read to go by, the hand-back saved. */
describe("the removal's end says what deleting the store would drop", () => {
  type Said = "answer" | "newer" | "none" | null;
  /**
   * A door whose hand-back leaves `left` and whose store says `said` on the way out; the press's read (no `leaving`)
   * says `pressed`, its shortcut. That read fails once the engine stopped.
   */
  function leaving(
    left: "saved" | "kept_other" | "not_saved" | undefined, said: Said | "absent" | "throws", pressed: Said = "none",
  ): StandaloneEngine {
    let stopped = false;
    const door = fakeDoor();
    const organizer = {
      organizing: false, heldBy: null, reason: null, releaseRequestedAt: null, claimed: false,
      ...(left === undefined ? {} : { settingsLeft: left }),
    };
    return {
      ...door,
      stop: async () => { stopped = true; },
      runtimes: () => ({ ...door.runtimes(), organizer: { m1: organizer } }),
      ...(said === "absent" ? {} : {
        settingsLeftOnlyHere: async (opts?: { leaving?: boolean }): Promise<Said> => {
          if (stopped || said === "throws") throw new Error("the store is closed");
          return opts?.leaving === true ? said : pressed;
        },
      }),
    };
  }
  const end = async (door: StandaloneEngine | null) => {
    forgetOrganizerSessionForTests();
    if (door !== null) expect(holdStandaloneDoor(door)).toBe(true);
    return (await endStandaloneForRemoval()).settingsKept;
  };

  it("a refused write on the way out with the store saying more keeps it: unsaved", async () => {
    expect(await end(leaving("not_saved", null))).toBe("unsaved");
  });

  it("nothing more than the mailbox's last copy, or a save, lets the store go", async () => {
    expect({ unsaved: await end(leaving("not_saved", "none")), saved: await end(leaving("saved", "none")) })
      .toEqual({ unsaved: null, saved: null });
  });

  /* THE PRESS'S SHORTCUT IS NO ANSWER ON THE WAY OUT: offline, or with the mailbox already handed back, no flush ran
     and nothing was refused, so a press would read none over a store that says more. */
  it("the way out reads the store against the last copy, never the press's shortcut", async () => {
    expect({ quiet: await end(leaving(undefined, null)), told: await end(leaving("not_saved", null)) })
      .toEqual({ quiet: "unknown", told: "unsaved" });
  });

  it("with no read to go by, a hand-back that saved lets the store go", async () => {
    expect({ unread: await end(leaving("saved", "throws")), absent: await end(leaving("saved", "absent")) })
      .toEqual({ unread: null, absent: null });
  });

  it("a store that says more than the copy the hand-back saved keeps it: a change since the flush", async () => {
    expect(await end(leaving("saved", null))).toBe("unknown");
  });

  it("no door: nothing can read the store, so it stays", async () => {
    expect(await end(null)).toBe("unknown");
  });

  it("the settings question and a newer ohmail's copy keep it, read before the engine stops", async () => {
    expect({ answer: await end(leaving(undefined, "answer")), newer: await end(leaving("kept_other", "newer")) })
      .toEqual({ answer: "answer", newer: "newer" });
  });

  it("an engine without the read: only a save lets the store go", async () => {
    expect({
      unsaved: await end(leaving("not_saved", "absent")), newer: await end(leaving("kept_other", "absent")),
      saved: await end(leaving("saved", "absent")), none: await end(leaving(undefined, "absent")),
    }).toEqual({ unsaved: "unsaved", newer: "newer", saved: null, none: "unknown" });
  });

  it("a read that fails keeps it, failing closed", async () => {
    expect({ unsaved: await end(leaving("not_saved", "throws")), unknown: await end(leaving(undefined, "throws")) })
      .toEqual({ unsaved: "unsaved", unknown: "unknown" });
  });

  it("still answers whether the claim went, and stops the engine", async () => {
    forgetOrganizerSessionForTests();
    const log = { stopped: 0 };
    const door = leaving("not_saved", null);
    expect(holdStandaloneDoor({ ...door, handBack: async () => [{ mailboxId: "m1", released: null }], stop: async () => { log.stopped += 1; } }))
      .toBe(true);
    expect({ ended: await endStandaloneForRemoval(), stopped: log.stopped })
      .toEqual({ ended: { released: false, settingsKept: "unsaved" }, stopped: 1 });
  });

  /* REMOVE ANYWAY, after a removal that kept the store, holds no door and hands nothing back: the claim that removal
     could not give back still stands, and the forget says so. A door held again (Keep the mailbox) answers for
     itself. To watch it fail: answer a removal with no door as released. */
  it("a removal behind one that kept the store says the claim that one could not give back still stands", async () => {
    forgetOrganizerSessionForTests();
    const handingBack = (released: number | null): StandaloneEngine =>
      ({ ...leaving(undefined, null), handBack: async () => [{ mailboxId: "m1", released }] });
    expect(holdStandaloneDoor(handingBack(null))).toBe(true);
    const kept = await endStandaloneForRemoval();
    const anyway = await endStandaloneForRemoval();
    expect(holdStandaloneDoor(handingBack(1))).toBe(true);
    const reopened = await endStandaloneForRemoval();
    expect({ kept, anyway, reopened, after: await endStandaloneForRemoval() }).toEqual({
      kept: { released: false, settingsKept: "unknown" }, anyway: { released: false, settingsKept: "unknown" },
      reopened: { released: true, settingsKept: "unknown" }, after: { released: true, settingsKept: "unknown" },
    });
  });

  /* The claim lapses on its own: a Remove anyway after that says nothing holds the mailbox. */
  it("a removal behind a kept one once the claim has lapsed says it went", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      forgetOrganizerSessionForTests();
      expect(holdStandaloneDoor({ ...leaving(undefined, null), handBack: async () => [{ mailboxId: "m1", released: null }] })).toBe(true);
      await endStandaloneForRemoval();
      vi.setSystemTime(Date.now() + CLAIM_LAPSES_AFTER_MINUTES * 60_000 - 1_000);
      const inside = (await endStandaloneForRemoval()).released;
      vi.setSystemTime(Date.now() + 1_000);
      expect({ inside, lapsed: (await endStandaloneForRemoval()).released }).toEqual({ inside: false, lapsed: true });
    } finally {
      vi.useRealTimers();
    }
  });
});
