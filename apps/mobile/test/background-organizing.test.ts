/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  WHAT HAPPENS TO THE MAILBOX WHEN THE APP LEAVES THE SCREEN — both platforms, one file
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The fourth door makes two promises and they are different sentences on the two platforms:
 *
 *  · Android — *"It organizes while its notification is shown. Dismiss the notification to stop."*
 *  · iPhone — *"It organizes while ohmail is open. When you leave the app, it hands the mailbox
 *    back."*
 *
 * Everything below is one of those two sentences being true or false. The iPhone half is measured
 * HERE and nowhere else: the simulator is on a Mac that is not in this environment, and the
 * mechanism is entirely in the shared JS, so a twin driving real `AppState` transitions against a
 * recording engine is the measurement rather than a stand-in for one. The Android half's DECISIONS
 * are here too; the parts a node process cannot have — a real service, a real notification — are
 * asserted against the Kotlin source, which is the idiom `unified-push.test.ts` already uses, and
 * driven on a device by the lane's emulator cell.
 *
 * ── THE FIXTURES FAIL THE WAY PRODUCTION FAILS ────────────────────────────────────────────
 *
 * `handBack()` has THREE answers, not two: a count of claims removed, `0` for "none of ours were
 * there", and `null` for "could not look" — the state in which this install may still hold the
 * claim. The recorder below can produce all three, because a fixture that could only succeed or
 * throw would leave the one answer that decides whether the app may SAY the mailbox was handed
 * back untested.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  CLAIM_WATCH_MS,
  HAND_BACK_WINDOW_MS,
  STOP_ATTEMPTS,
  STOP_BACKOFF_MS,
  createBackgroundOrganizing,
  type BackgroundEngine,
  type BackgroundService,
  type OrganizerPlatform,
  type ServiceNotice,
} from "../src/engine/background";
import type { StopOrganizingOutcome } from "../src/engine/standalone-door";
import { watchedStates } from "../src/engine/organizer-session";
import { EN } from "../src/copy.en";
import { DE } from "../src/copy.de";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE_DIR = path.join(HERE, "..", "modules", "organizer-service");
const SERVICE_KT = path.join(
  MODULE_DIR, "android", "src", "main", "java", "app", "ohmail", "organizer", "OrganizerService.kt",
);
const MODULE_KT = path.join(
  MODULE_DIR, "android", "src", "main", "java", "app", "ohmail", "organizer",
  "OrganizerServiceModule.kt",
);
const HEADLESS_KT = path.join(
  MODULE_DIR, "android", "src", "main", "java", "app", "ohmail", "organizer",
  "OrganizerHeadlessService.kt",
);
const MANIFEST = path.join(MODULE_DIR, "android", "src", "main", "AndroidManifest.xml");

/** Kotlin with comments stripped — `unified-push.test.ts`'s rule: a claim in prose is not code. */
function kotlin(file: string): string {
  return fs.readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

/**
 * ONE BLOCK'S OWN BODY, by walking braces from its header.
 *
 * A `/header[\s\S]*?needle/` regex crosses every block boundary between the two and passes for a
 * needle that is somewhere else in the file entirely — measured on this very file: the assertion
 * that `OnDestroy` does not stop the service matched the `AsyncFunction("stop")` sixty lines
 * below it and would have gone red over correct code for ever.
 */
function blockBody(src: string, header: string): string {
  const at = src.indexOf(header);
  if (at < 0) throw new Error(`no block headed ${header} in this source`);
  const open = src.indexOf("{", at);
  if (open < 0) throw new Error(`the block headed ${header} has no body`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error(`the block headed ${header} is unbalanced`);
}

/** XML with comments stripped, for the same reason as the Kotlin. */
function xml(file: string): string {
  return fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "");
}

/* ── the recorders ───────────────────────────────────────────────────────────────────────── */

interface EngineLog {
  readonly calls: string[];
  /** What `handBack()` answers per mailbox, next call first. */
  handBack: (readonly { readonly mailboxId: string; readonly released: number | null }[])[];
  /** What the engine says it organizes. Replaced by a cell that takes the mailbox away. */
  organizing: {
    readonly mailboxId: string;
    readonly organizing: boolean;
    readonly standDown: boolean;
    /** Whether this install's claim stands — the fact the machine decides on. REQUIRED, so a
     *  double cannot leave it out: an absent claim fact is the double lying about the one
     *  question the module asks, which is how the window below went unmeasured for a release. */
    readonly claimed: boolean;
  }[];
  resumeThrows: boolean;
  /** What `resume()` answers per mailbox, next call first; default one served cycle. */
  resumeServed: (readonly { readonly mailboxId: string; readonly served: number }[])[];
  handBackThrows: boolean;
  /** What `stopOrganizing()` answers — three words; see `StopOrganizingOutcome`. */
  stopOrganizing: StopOrganizingOutcome;
  stopOrganizingThrows: boolean;
  /** What `claimHere()` answers, next call first; the last one repeats. */
  claimHere: ("claimed" | "held" | "refused" | "mailbox_full")[];
  claimHereThrows: boolean;
  /** Who each `claimHere` said was asking — the watch must never ask as a person. */
  claimBy: string[];
  /** Runs as a hand-back begins — the freeze case moves the wall clock here. */
  onHandBack?: () => void;
  /** What the row says about a live foreign claim, next call first; absent = a composition without it. */
  heldElsewhere?: (boolean | null)[];
}

function engine(over: Partial<EngineLog> = {}): { engine: BackgroundEngine; log: EngineLog } {
  const log: EngineLog = {
    calls: [],
    handBack: [],
    organizing: [{ mailboxId: "mb1", organizing: true, standDown: false, claimed: true }],
    resumeThrows: false,
    resumeServed: [],
    handBackThrows: false,
    stopOrganizing: "released",
    stopOrganizingThrows: false,
    claimHere: [],
    claimHereThrows: false,
    claimBy: [],
    ...over,
  };
  const impl: BackgroundEngine = {
    handBack: async () => {
      log.calls.push("handBack");
      log.onHandBack?.();
      if (log.handBackThrows) throw new Error("ohmail/_meta could not be read");
      return log.handBack.shift() ?? [{ mailboxId: "mb1", released: 1 }];
    },
    resume: async () => {
      log.calls.push("resume");
      if (log.resumeThrows) throw new Error("the lease could not be read");
      return log.resumeServed.shift() ?? [{ mailboxId: "mb1", served: 1 }];
    },
    organizing: () => {
      log.calls.push("organizing");
      return log.organizing;
    },
    stopOrganizing: async () => {
      log.calls.push("stopOrganizing");
      if (log.stopOrganizingThrows) throw new Error("the row could not be written");
      /* ── THE THREE WORDS, EACH LEAVING THE STATE PRODUCTION LEAVES ──────────────────────────
         `released` settles a runtime that organizes nothing; `not_organizing` had nothing to give
         up and was already there; `refused` ran the cycle and could not confirm, so this install
         is STILL ORGANIZING with the request standing on the row. That last one is the whole of
         what the teardown decides on, and a double that reported it as stopped made a caller
         reading the engine's state look measured while production defeated it. */
      if (log.stopOrganizing === "released") {
        log.organizing = log.organizing.map((m) => ({ ...m, organizing: false, claimed: false }));
      }
      return log.stopOrganizing;
    },
    claimHere: async (opts) => {
      log.calls.push("claimHere");
      log.claimBy.push(opts.by);
      if (log.claimHereThrows) throw new Error("the door could not be reached");
      return (log.claimHere.length > 1 ? log.claimHere.shift() : log.claimHere[0]) ?? "held";
    },
    ...(log.heldElsewhere !== undefined ? {
      heldElsewhere: async () => {
        log.calls.push("heldElsewhere");
        const said = log.heldElsewhere!;
        return (said.length > 1 ? said.shift() : said[0]) ?? null;
      },
    } : {}),
  };
  return { engine: impl, log };
}

interface ServiceLog {
  readonly calls: string[];
  readonly notices: ServiceNotice[];
  running: boolean;
  /** A platform that cannot be asked whether its service is up. Production's `running()` is a
   *  native call and can throw the same way `beat()` can. */
  runningThrows: boolean;
  restricted: boolean;
  /** What `start()` answers — `false` is a notification that is not showing. */
  starts: boolean;
  startThrows: boolean;
  stopThrows: boolean;
  fire: (() => void) | null;
  unsubscribed: number;
  /** The platform's data-sync time limit — its own listener and its own unsubscribe count. */
  fireTimedOut: (() => void) | null;
  timedOutUnsubscribed: number;
  /** How many times JS said it was still running. */
  beats: number;
  /** What the platform reports as its watchdog interval. */
  beatIntervalMs: number;
  /** What the service's own gate answers — the app switch, the permission, the channel. */
  canPost: boolean;
  canPostThrows: boolean;
  gateReads: number;
  /** Stops after which `running` still reads true — the Kotlin flag clears in `onDestroy`, later. */
  stopKeepsRunning: number;
}

function service(over: Partial<ServiceLog> = {}): { service: BackgroundService; log: ServiceLog } {
  const log: ServiceLog = {
    calls: [],
    notices: [],
    running: false,
    runningThrows: false,
    restricted: false,
    starts: true,
    startThrows: false,
    stopThrows: false,
    fire: null,
    unsubscribed: 0,
    fireTimedOut: null,
    timedOutUnsubscribed: 0,
    beats: 0,
    beatIntervalMs: 20_000,
    canPost: true,
    canPostThrows: false,
    gateReads: 0,
    stopKeepsRunning: 0,
    ...over,
  };
  const impl: BackgroundService = {
    start: async (notice) => {
      log.calls.push("start");
      log.notices.push(notice);
      if (log.startThrows) throw new Error("ForegroundServiceStartNotAllowedException");
      /* A REFUSED START DOES NOT TAKE A STANDING SERVICE DOWN, and the double has to fail that
         way: the Kotlin answers `false` from `isRestricted` / `canPostNotification` BEFORE it
         reaches `startForegroundService`, so a service already in the foreground goes on running.
         A double that cleared `running` here would make an organizer that is up look as though a
         later refusal had killed it — the one direction the arms below must read correctly. */
      if (log.starts) log.running = true;
      return log.starts;
    },
    stop: async () => {
      log.calls.push("stop");
      if (log.stopThrows) throw new Error("no such service");
      if (log.stopKeepsRunning > 0) { log.stopKeepsRunning -= 1; return; }
      log.running = false;
    },
    running: () => {
      if (log.runningThrows) throw new Error("the module could not be reached");
      return log.running;
    },
    restricted: () => log.restricted,
    canPost: () => {
      log.gateReads += 1;
      if (log.canPostThrows) throw new Error("the module could not be reached");
      return log.canPost;
    },
    beat: () => { log.beats += 1; return log.running; },
    beatIntervalMs: () => log.beatIntervalMs,
    onStopRequested: (listener) => {
      log.fire = listener;
      return () => { log.unsubscribed += 1; log.fire = null; };
    },
    onTimedOut: (listener) => {
      log.fireTimedOut = listener;
      return () => { log.timedOutUnsubscribed += 1; log.fireTimedOut = null; };
    },
  };
  return { service: impl, log };
}

const NOTICE: ServiceNotice = {
  channelName: EN.stateOrganizing,
  body: EN.notifBody("mila@example.com"),
  stopLabel: EN.notifStop,
  stopFailedBody: EN.notifStopFailed,
};

function wire(platform: OrganizerPlatform, over: {
  engine?: Partial<EngineLog>;
  service?: Partial<ServiceLog> | null;
  checkEveryMs?: number;
  now?: () => number;
  notice?: () => ServiceNotice;
} = {}) {
  const e = engine(over.engine);
  const s = over.service === null ? null : service(over.service ?? {});
  const announced: number[] = [];
  /* THE OTHER CAUSE'S OWN COUNT. Both declines used to raise `announceRestricted`, whose sentence
     names battery saver — false on an Android 13+ first install. Counted apart, so a decline
     reaching the wrong one is a red rather than an indistinguishable number. */
  const notificationsOff: number[] = [];
  /** What the machine handed the panel about a start that did not finish starting — `null` clears. */
  const startFailed: unknown[] = [];
  const logged: { event: string; detail?: Record<string, unknown> }[] = [];
  /* HOW OFTEN THE SCREEN WAS TOLD TO ASK AGAIN. The panel was correct only at mount, so every arm
     that can move the claim has to say so — this is the count that makes that an observation. */
  const moved: number[] = [];
  /** What the machine said about the last hand-back landing in time — `true` is late. */
  const late: boolean[] = [];
  const live = createBackgroundOrganizing({
    platform,
    engine: e.engine,
    service: s?.service ?? null,
    notice: over.notice ?? (() => NOTICE),
    announceRestricted: () => { announced.push(1); },
    announceNotificationsOff: () => { notificationsOff.push(1); },
    /* A START THAT DID NOT FINISH STARTING — collected, so a case can read what the machine said
       and a case that says nothing about it is not silently admitting one. */
    sayStartFailed: (detail: unknown) => { startFailed.push(detail); },
    sayHandBackLate: (l: boolean) => { late.push(l); },
    ...(over.now !== undefined ? { now: over.now } : {}),
    stateChanged: () => { moved.push(1); },
    log: (event, detail) => { logged.push({ event, ...(detail ? { detail } : {}) }); },
    ...(over.checkEveryMs !== undefined ? { checkEveryMs: over.checkEveryMs } : {}),
  });
  return {
    live, engine: e.log, service: s?.log ?? null, announced, notificationsOff, logged, moved,
    startFailed, late,
  };
}

/**
 * HOW MANY TIMERS THE CLAIM WATCH OWNS — total, minus the baseline this session already had.
 *
 * A session arms TWO independent intervals and only one of them is about the notification: the
 * claim watch lives with the service, the stood-down watch lives with the app being open. So
 * `vi.getTimerCount()` is no longer the claim watch's own count, and the cases below take a
 * baseline right after `wire(...)` and measure the difference. The invariant they hold is
 * unchanged — *the claim watch exists only while the notification does* — and it is re-derived
 * against the session rather than against the process.
 */
const watchTimers = (baseline: number): number => vi.getTimerCount() - baseline;

/** The `why` code on the first line of that event, or `null` — see {@link BackgroundReason}. */
function reason(
  logged: readonly { event: string; detail?: Record<string, unknown> }[],
  event: string,
): string | null {
  const line = logged.find((l) => l.event === event);
  const why = line?.detail?.["why"];
  return typeof why === "string" ? why : null;
}

/* ── iPhone: the three outcomes the simulator would have measured ─────────────────────────── */

describe("iPhone — the mailbox goes back when you leave and is taken again when you return", () => {
  it("releases the claim on background through the engine's own hand-back", async () => {
    const w = wire("ios", { service: null });
    await w.live.phaseChanged("background");
    expect(w.engine.calls).toEqual(["handBack"]);
    expect(w.live.handedBack()).toBe(true);
    /* NOT a stop. Both give the claim back through one door; a stop also closes the store, so the
       mirror stops being served and nothing comes back without a relaunch. */
    expect(w.engine.calls).not.toContain("stop");
    /* AND THE LINE SAYS WHICH ARM RAN. The codes exist so this can be a comparison rather than a
       prose match; unasserted they are two interchangeable strings, which is how a log stops
       telling a reader why a mailbox went back. */
    expect(reason(w.logged, "organizer_hand_back")).toBe("left_the_foreground");
  });

  it("re-claims on foreground by asking the gate, which is how it cannot displace anybody", async () => {
    const w = wire("ios", { service: null });
    await w.live.phaseChanged("background");
    await w.live.phaseChanged("active");
    expect(w.engine.calls).toEqual(["handBack", "resume"]);
    expect(w.live.handedBack()).toBe(false);
  });

  it("TAKING BACK: from the return until its resume answers, and a leave before then ends it", async () => {
    const w = wire("ios", { service: null });
    await w.live.phaseChanged("background");
    expect(w.live.takingBack(), "behind the person nothing is taken back").toBe(false);
    const back = w.live.phaseChanged("active");
    expect(w.live.takingBack(), "the return did not say so at its edge").toBe(true);
    await back;
    expect(w.live.takingBack()).toBe(false);
    await w.live.phaseChanged("background");
    const second = w.live.phaseChanged("active");
    const left = w.live.phaseChanged("background");
    expect(w.live.takingBack(), "a leave queued behind the return still read as taking back").toBe(false);
    await Promise.all([second, left]);
    expect(w.live.handedBack()).toBe(true);
    expect(w.live.takingBack()).toBe(false);
  });

  it("REFUSED: a resume that cannot take the mailbox back leaves the state saying handed back", async () => {
    /**
     * The contention cell's third outcome. A desktop took the mailbox while the phone was asleep,
     * so the forced cycle stands this install down rather than claiming — and the app must not
     * render "Organizing" over a mailbox it does not hold. The engine reports that by refusing the
     * resume; `handedBack` staying true is the honest state and is what Settings renders.
     */
    const w = wire("ios", { service: null, engine: { resumeThrows: true } });
    await w.live.phaseChanged("background");
    await w.live.phaseChanged("active");
    expect(w.live.handedBack()).toBe(true);
    expect(w.logged.map((l) => l.event)).toContain("organizer_resume_failed");
  });

  it("UNSERVED: a forced cycle that served nothing leaves `Handed back` standing, and says so", async () => {
    /**
     * The runtime answers `0` for a forced cycle that failed WITHOUT throwing, and the call
     * resolves. Cleared on the resolve alone, the panel rendered "Nothing organizes this mailbox"
     * over a row that still says organizer. The count decides; a later cycle that serves clears it.
     */
    const w = wire("ios", {
      service: null,
      engine: { resumeServed: [[{ mailboxId: "mb1", served: 0 }]] },
    });
    await w.live.phaseChanged("background");
    await w.live.phaseChanged("active");
    expect(w.live.handedBack(), "an unserved resume cleared the hand-back").toBe(true);
    expect(w.logged.find((l) => l.event === "organizer_resume_unserved")?.detail)
      .toMatchObject({ mailboxes: 1, unserved: 1, handedBack: true });
    await w.live.phaseChanged("background");
    await w.live.phaseChanged("active");
    expect(w.live.handedBack(), "a resume that served did not clear it").toBe(false);
  });

  it("UNSERVED after the person's stop: no `Handed back` over a stop", async () => {
    /* The swipe is the person's stop and leaves the row saying reader; the state after it is
       "Nothing organizes this mailbox" with the start verb. An unserved resume there changes
       nothing — `Handed back` would hide the verb until the next foreground. */
    const w = wire("android", { engine: { resumeServed: [[{ mailboxId: "mb1", served: 0 }]] } });
    await w.live.phaseChanged("background");
    w.service!.fire!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await w.live.phaseChanged("active");
    expect(w.engine.calls).toContain("resume");
    expect(w.live.handedBack()).toBe(false);
  });

  it("REFUSED: and the person is told, in words the panel can re-render", async () => {
    /**
     * A SILENT REFUSAL HERE IS A PERSON WATCHING A MAILBOX THAT NEVER CHANGES. The engine has
     * already spent its own attempts by the time the resume rejects, so this is the final answer
     * and it has to reach the panel that names this phone. A VALUE, not a sentence: the panel words
     * it at render, so switching the app to German turns it over with everything else.
     */
    const w = wire("ios", { service: null, engine: { resumeThrows: true } });
    await w.live.phaseChanged("background");
    await w.live.phaseChanged("active");
    expect(w.startFailed.length, "a start that did not start said nothing to the person").toBe(1);
    expect(w.startFailed[0], "the panel was handed a cleared refusal for a failure").not.toBeNull();
  });

  it("and a start that worked clears the sentence the last one left", async () => {
    /* A refusal may not outlive the thing it was about — `announceRestricted`'s rule, one fact
       over. The first foreground fails, the second succeeds, and the panel is handed `null`. */
    const w = wire("ios", { service: null, engine: { resumeThrows: true } });
    await w.live.phaseChanged("background");
    await w.live.phaseChanged("active");
    w.engine.resumeThrows = false;
    await w.live.phaseChanged("background");
    await w.live.phaseChanged("active");
    expect(w.startFailed, "the sentence was not cleared by a start that worked")
      .toEqual([expect.anything(), null]);
  });

  it("a hand-back that could not look is NOT a hand-back", async () => {
    /* `released: null` — the search was refused, and this install may still hold the claim. The
       app may not say the mailbox went back, because a person reading that would hand it to
       another machine and watch that machine refuse it. */
    const w = wire("ios", {
      service: null,
      engine: { handBack: [[{ mailboxId: "mb1", released: null }]] },
    });
    await w.live.phaseChanged("background");
    expect(w.live.handedBack()).toBe(false);
  });

  it("`0` claims removed IS a hand-back — the claim had already aged out", async () => {
    const w = wire("ios", {
      service: null,
      engine: { handBack: [[{ mailboxId: "mb1", released: 0 }]] },
    });
    await w.live.phaseChanged("background");
    expect(w.live.handedBack()).toBe(true);
  });

  it("one mailbox of two unreadable is enough to refuse the claim", async () => {
    const w = wire("ios", {
      service: null,
      engine: {
        handBack: [[
          { mailboxId: "mb1", released: 1 },
          { mailboxId: "mb2", released: null },
        ]],
      },
    });
    await w.live.phaseChanged("background");
    expect(w.live.handedBack()).toBe(false);
  });

  it("`inactive` is the app switcher, not leaving — the mailbox stays put", async () => {
    /**
     * Acted on, this would hand the mailbox back and take it again for every flick through the
     * switcher and every incoming call: two IMAP writes per gesture, and a window in which a
     * desktop can take a mailbox nobody meant to give up.
     */
    const w = wire("ios", { service: null });
    await w.live.phaseChanged("inactive");
    expect(w.engine.calls).toEqual([]);
    expect(w.live.handedBack()).toBe(false);
  });

  it("iOS has no service to ask for, and that is a fact about the BUILD, not a branch", async () => {
    /**
     * SUPERSEDED (dispatcher ruling, 2026-09-12) and re-derived rather than weakened. This cell
     * used to drive iOS with a service present and assert the mailbox went back anyway — *"the
     * platform decides, not the presence of a seam"* — which is the one thing the ruling forbids:
     * the claim follows the organizer's ability to RUN, read from the service's own state, never
     * from the platform name. What that cell was defending is still true and is now asserted where
     * it is real: iOS resolves NO service, so the state it drove cannot occur in a build. The
     * module ships for `android` only (asserted against `expo-module.config.json` below), and the
     * entitlement that would let iOS run later is refused (`UIBackgroundModes`, below). The
     * predicate's own control — a service that reports itself RUNNING keeps the mailbox whatever
     * the platform label says — is in the Android block.
     */
    const w = wire("ios", { service: null });
    await w.live.phaseChanged("background");
    expect(w.live.backgrounded()).toBe(false);
    expect(w.engine.calls).toEqual(["handBack"]);
    expect(reason(w.logged, "organizer_hand_back")).toBe("left_the_foreground");
  });
});

/* ── Android: the notification is the permission ──────────────────────────────────────────── */

describe("Android — it organizes behind a notification, and the notification is the only surface", () => {
  it("starts the service on background and keeps the claim", async () => {
    const w = wire("android");
    await w.live.phaseChanged("background");
    expect(w.service?.calls).toEqual(["start"]);
    expect(w.engine.calls).not.toContain("handBack");
    expect(w.live.backgrounded()).toBe(true);
    expect(w.live.handedBack()).toBe(false);
  });

  it("the notification carries the deck's words and the mailbox's address", async () => {
    const w = wire("android");
    await w.live.phaseChanged("background");
    const notice = w.service?.notices[0];
    expect(notice?.channelName).toBe(EN.stateOrganizing);
    expect(notice?.stopLabel).toBe(EN.notifStop);
    expect(notice?.body).toContain("mila@example.com");
  });

  it("the address never reaches a diagnostic", async () => {
    /**
     * The body is somebody's mail address. It goes from the deck to the platform and nowhere else:
     * a log line carrying it would put a person's address in every crash report and support
     * bundle. Asserted over EVERY line this module emitted, serialized, not over the ones a reader
     * remembers to check.
     */
    const w = wire("android", { engine: { handBackThrows: true } });
    await w.live.phaseChanged("background");
    await w.live.phaseChanged("active");
    w.service!.restricted = true;
    await w.live.phaseChanged("background");
    expect(w.logged.length).toBeGreaterThan(0);
    expect(JSON.stringify(w.logged)).not.toContain("mila@example.com");
  });

  it("battery saver: no service, the mailbox back, and the sentence said ONCE", async () => {
    const w = wire("android", { service: { restricted: true } });
    await w.live.phaseChanged("background");
    expect(w.service?.calls).not.toContain("start");
    expect(w.engine.calls).toContain("handBack");
    expect(w.announced).toHaveLength(1);
    /* Twice more. Somebody with battery saver on has it on all day; the sentence is not repeated. */
    await w.live.phaseChanged("active");
    await w.live.phaseChanged("background");
    await w.live.phaseChanged("active");
    await w.live.phaseChanged("background");
    expect(w.announced).toHaveLength(1);
  });

  it("a notification that is not showing may not organize behind itself", async () => {
    /**
     * A refused `POST_NOTIFICATIONS` or a refused background start. The service call answers
     * `false` rather than throwing, because the app's reply to all of them is one reply — and the
     * door's sentence is what forces it: *"It organizes while its notification is shown."*
     */
    const w = wire("android", { service: { starts: false } });
    await w.live.phaseChanged("background");
    expect(w.service?.calls).toEqual(["start", "stop"]);
    expect(w.engine.calls).toContain("handBack");
    expect(w.live.backgrounded()).toBe(false);
    /* AND THE SENTENCE IS THE NOTIFICATION'S, NOT BATTERY SAVER'S. This asserted `announced`,
       which reaches `Copy.organizerRestricted` — a sentence naming battery saver, false on every
       Android 13+ first install whose `POST_NOTIFICATIONS` was never granted. */
    expect(w.notificationsOff).toHaveLength(1);
    expect(w.announced).toHaveLength(0);
  });

  it("a service that throws is a service that is not showing", async () => {
    const w = wire("android", { service: { startThrows: true } });
    await w.live.phaseChanged("background");
    expect(w.engine.calls).toContain("handBack");
    expect(w.live.backgrounded()).toBe(false);
    expect(w.logged.map((l) => l.event)).toContain("organizer_service_start_failed");
  });

  it("the stop releases the claim BEFORE the notification goes", async () => {
    /**
     * The order is the property. Dropping the notification first leaves a window in which nothing
     * on the phone says the mailbox is being organized and the claim is still standing in it — the
     * state a person who pressed "Stop organizing" is entitled to assume is over.
     */
    const order: string[] = [];
    const e = engine();
    const s = service();
    const engineCalls = e.engine;
    const live = createBackgroundOrganizing({
      platform: "android",
      notice: () => NOTICE,
      announceRestricted: () => undefined,
      announceNotificationsOff: () => undefined,
      sayStartFailed: () => undefined,
      sayHandBackLate: () => undefined,
      service: {
        ...s.service,
        start: async (n) => { const r = await s.service.start(n); order.push("start"); return r; },
        stop: async () => { order.push("notification gone"); await s.service.stop(); },
      },
      engine: {
        ...engineCalls,
        /* THE REMEMBERED RELEASE, which is the act a person's stop takes now — the bare hand-back
           left the ROW saying organizer and the next foreground resume re-claimed the mailbox. The
           ORDER property is unchanged and so is the reason for it. */
        stopOrganizing: async () => { order.push("claim released"); return engineCalls.stopOrganizing(); },
      },
    });
    await live.phaseChanged("background");
    s.log.fire!();
    await vi.waitFor(() => { expect(order).toContain("notification gone"); });
    /* THE ORDER, not the presence: the release is the first of the two and the notification's
       disappearance is the last thing that happens. */
    expect(order).toEqual(["start", "claim released", "notification gone"]);
    expect(live.backgrounded()).toBe(false);
  });

  it("the service stays up when the app comes back, and Settings can say so", async () => {
    /**
     * Tearing it down here would release a mailbox this app is now in the foreground of, only to
     * claim it again: two IMAP writes and a window, for nothing. The design record's Settings
     * "background" arm is exactly this state — *"the person came back with the service still
     * up"* — and it renders from `backgrounded()`.
     */
    const w = wire("android");
    await w.live.phaseChanged("background");
    await w.live.phaseChanged("active");
    /* The service was started once and never stopped; nothing was released and nothing re-claimed. */
    expect(w.service?.calls).toEqual(["start"]);
    expect(w.live.backgrounded()).toBe(true);
    expect(w.engine.calls).not.toContain("handBack");
    expect(w.engine.calls).not.toContain("resume");
    /* The claim WAS re-checked on the way in — the notification must not survive a lost claim. */
    expect(w.engine.calls).toContain("organizing");
  });

  it("an organizer that is RUNNING keeps the mailbox, and a restriction set between two backgrounds cannot take it", async () => {
    /**
     * The ruling, as one cell. The claim follows the organizer's ability to run: the service is
     * standing, its headless task is holding the timers, so the app leaving the screen changes
     * nothing and there is nothing to give back.
     *
     * `restricted()` is asked BEFORE a start and must not be asked of a service that is already
     * up. Battery saver switched on between two backgrounds used to reach it and tear down a LIVE
     * organizer — the mailbox handed back and then locked for the staleness window with nothing
     * on the phone running. If the system does take the service, the beat and the watchdog say so
     * within two intervals and the claim goes back then, which is a fact rather than a flag.
     */
    const w = wire("android");
    await w.live.phaseChanged("background");
    await w.live.phaseChanged("active");
    w.service!.restricted = true;
    const before = w.engine.calls.length;
    await w.live.phaseChanged("background");
    expect(w.live.backgrounded()).toBe(true);
    expect(w.live.handedBack()).toBe(false);
    /* NOTHING BUT A READ. The engine was asked what it organizes and was told nothing. */
    expect(w.engine.calls.slice(before)).toEqual(["organizing"]);
    expect(w.service?.calls).not.toContain("stop");
    expect(w.announced).toHaveLength(0);
    /* AND IT SAYS SO. A device run reads this machine's decision off the log and nowhere else;
       without the line, "kept the mailbox" and "did nothing at all" are the same silence. */
    expect(reason(w.logged, "organizer_background_holds")).toBe("organizer_still_running");
  });

  it("the SERVICE decides and the platform name only picks the code — the predicate's control", async () => {
    /**
     * The label says iOS and the service reports itself running, so the mailbox stays. That state
     * does not occur in a build — the module ships for `android` only — and this cell is not a
     * claim that it should; it is the control that says WHERE the decision is read. Restore
     * `deps.platform === "ios" ||` to the head of `toBackground` and this is the cell that
     * reddens, which is the whole of the ruling.
     *
     * Its mirror is one block down: Android with no service hands the mailbox back and the code
     * on the line is the only thing the platform name chose.
     */
    const w = wire("ios", { service: { running: true } });
    await w.live.phaseChanged("background");
    expect(w.engine.calls).not.toContain("handBack");
    expect(w.live.backgrounded()).toBe(true);
    expect(reason(w.logged, "organizer_background_holds")).toBe("organizer_still_running");

    const bare = wire("ios", { service: null });
    await bare.live.phaseChanged("background");
    expect(reason(bare.logged, "organizer_hand_back")).toBe("left_the_foreground");
    const droid = wire("android", { service: null });
    await droid.live.phaseChanged("background");
    expect(reason(droid.logged, "organizer_hand_back")).toBe("no_background_service");
  });

  it("CHURN: a flip costs no lease write while the organizer runs, and two where it cannot", async () => {
    /**
     * The number the ruling turns on, counted rather than reasoned about. Android with the service
     * standing: leaving and coming back is ZERO writes to `ohmail/_meta`, however often a person
     * glances at something else. iPhone, and any build with no service: one hand-back out and one
     * claim in — two, which is the honest price of an organizer that cannot run while the app is
     * away and the ceiling above which this would need a design rather than a lane.
     */
    const writes = (calls: readonly string[]): number =>
      calls.filter((c) => c === "handBack" || c === "resume" || c === "claimHere").length;
    const FLIPS = 5;

    const up = wire("android");
    /* The first background is what starts the service; the flips are measured from there. */
    await up.live.phaseChanged("background");
    const base = writes(up.engine.calls);
    for (let i = 0; i < FLIPS; i += 1) {
      await up.live.phaseChanged("active");
      await up.live.phaseChanged("background");
    }
    expect(up.live.backgrounded()).toBe(true);
    expect(writes(up.engine.calls) - base).toBe(0);

    for (const w of [wire("ios", { service: null }), wire("android", { service: null })]) {
      const from = writes(w.engine.calls);
      for (let i = 0; i < FLIPS; i += 1) {
        await w.live.phaseChanged("background");
        await w.live.phaseChanged("active");
      }
      expect((writes(w.engine.calls) - from) / FLIPS).toBe(2);
    }
  });

  it("a platform that cannot say whether its service is up is not evidence that it is", async () => {
    /**
     * `running()` is a native call and can throw the way `beat()` can. The answer is the same
     * direction as every other unreadable state here: not running. Taking a failed read as "it is
     * organizing" would leave a claim standing over a phone with nothing behind it, which is the
     * hazard the whole hand-back exists for — and the mailbox is locked until the claim lapses.
     */
    const w = wire("android", { service: { running: true, runningThrows: true } });
    await w.live.phaseChanged("background");
    expect(w.live.backgrounded()).toBe(false);
    expect(w.engine.calls).toContain("handBack");
    expect(w.logged.map((l) => l.event)).toContain("organizer_service_state_unreadable");
  });

  it("ONE platform read in the whole machine, and it names a code rather than deciding", () => {
    /**
     * The ruling's shape, as a census over the source: `deps.platform` may be read exactly once,
     * and that once is the arm choosing which CODE the log carries for an absent service. Parsed
     * for the READ and not for the word — comments are stripped first, so the paragraph above
     * `organizerRuns` explaining that the platform decides nothing cannot satisfy the count.
     */
    const src = fs.readFileSync(
      path.join(HERE, "..", "src", "engine", "background.ts"), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const reads = src.match(/deps\.platform/g) ?? [];
    expect(reads, "one read, in the arm that names the code").toHaveLength(1);
    /* By LINE and not by `blockBody`: `absentReason` is an expression arrow with no braces, and
       that helper's own header says what a brace walk finds for a block that has none. */
    const at = src.split("\n").find((l) => l.includes("deps.platform")) ?? "";
    expect(at).toContain("left_the_foreground");
    expect(at).toContain("no_background_service");
    /* And the predicate that replaced it reads the service, every time it is asked. */
    expect(blockBody(src, "const organizerRuns =")).toContain("deps.service.running()");
  });

  it("OWNERSHIP decides the background arm and the watch; `organizing` decides the TEARDOWN", () => {
    /**
     * The ruling's shape, as a census over the source, and the `deps.platform` cell's twin.
     *
     * RE-DERIVED, not relaxed. The invariant was "`organizing` is read once and decides nothing",
     * and it was about the two OWNERSHIP decisions: the background arm and the claim watch read
     * `claimed`, because `organizing` flips a round trip after the claim lands and a mailbox just
     * given to this phone would read like one nobody consented to. Both still do. What is new is a
     * THIRD decision, and it reads `organizing` deliberately — has the engine actually stopped, the
     * one question that licenses taking the notification down — because there the field is a MASK
     * over the mechanism that can only withhold what a pass declared. So the count is two, each
     * named by the const it lives in, and the two ownership decisions are asserted unchanged.
     */
    const src = fs.readFileSync(
      path.join(HERE, "..", "src", "engine", "background.ts"), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(src.match(/m\.organizing/g) ?? [], "the organizing field is read twice").toHaveLength(2);
    /* AND THE SECOND READ IS THE TEARDOWN'S, by name. A third reader appearing anywhere else is
       what this count refuses. */
    expect(blockBody(src, "const engineStopped =")).toContain("m.organizing");
    /* And that read feeds ONE thing: the word the hold line carries. By LINE and not by
       `blockBody` — `organizingWord` is an expression arrow whose first brace is its parameter's
       type, which is the trap the platform census above already documents. */
    expect(src.match(/state\.organizing/g) ?? []).toHaveLength(1);
    const lines = src.split("\n");
    const at = lines.findIndex((l) => l.includes("state.organizing"));
    expect(lines[at], "the organizing field decides something").toContain("\"starting\"");
    expect(lines.slice(Math.max(0, at - 3), at).join("\n")).toContain("const organizingWord =");
    /* The two decisions read the other fact, and neither reads this one. */
    expect(blockBody(src, "const toBackground =")).toContain("state?.claimed === false");
    expect(blockBody(src, "const claimLostCheck =")).toContain("stateNow()?.claimed !== false");
    expect(blockBody(src, "const reclaimCheck =")).toContain("stateNow()?.standDown !== true");
  });

  it("the claim lost while backgrounded takes the notification down — WITHOUT a lease write", async () => {
    /**
     * Somebody presses "Organize here" on their desktop. This install's next gated cycle stands
     * down, and the notification would go on saying "Organizing <address>" over an install that
     * organizes nothing — a false statement on a surface a person cannot argue with.
     *
     * And no hand-back: the claim is not ours to give back, so asking the server to expunge
     * records by our own id would be a write about a mailbox we have just been told we do not hold.
     */
    vi.useFakeTimers();
    try {
      const w = wire("android", { checkEveryMs: 1000 });
      await w.live.phaseChanged("background");
      expect(w.live.backgrounded()).toBe(true);
      w.engine.organizing = [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }];
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.live.backgrounded()).toBe(false);
      expect(w.engine.calls).not.toContain("handBack");
      expect(w.logged.map((l) => l.event)).toContain("organizer_service_stopped_claim_lost");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a claim that is STILL OURS keeps its notification, whatever the pass says it arranged", async () => {
    /**
     * The watch's half of the same fix, and the second way "organizes anything" was the wrong
     * question. A pass reports `organizing: false` for reasons that are not a loss: the lease
     * could not be read this cycle (an outage, where the claim is ours and the next poll asks
     * again), and the round trip between a fresh claim and the gate's permit. Reading that as a
     * lost claim took a person's notification down over a mailbox nobody had taken, and left the
     * claim to lapse out of a folder nothing had decided to give up.
     */
    vi.useFakeTimers();
    try {
      const w = wire("android", { checkEveryMs: 1000 });
      await w.live.phaseChanged("background");
      expect(w.live.backgrounded()).toBe(true);
      w.engine.organizing = [{ mailboxId: "mb1", organizing: false, standDown: false, claimed: true }];
      await vi.advanceTimersByTimeAsync(3000);
      expect(w.live.backgrounded(), "the notification came down over a claim of ours").toBe(true);
      expect(w.logged.map((l) => l.event)).not.toContain("organizer_service_stopped_claim_lost");
      expect(w.engine.calls).not.toContain("handBack");
      w.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the watch exists only while the notification does", async () => {
    /**
     * A check running with no service is a timer nothing needs; a service with no check is the
     * false-state window above. Armed from the platform's answer, cleared with the service — so a
     * stopped service stops being asked, which is what this measures.
     *
     * The TIMER is counted, not only the calls it would have made. Asserting "`organizing` was not
     * asked again" passes for a live timer whose body returns early, which is how a watch survives
     * its notification unnoticed.
     */
    vi.useFakeTimers();
    try {
      const w = wire("android", { checkEveryMs: 1000 });
      const base = vi.getTimerCount();
      await w.live.phaseChanged("background");
      expect(watchTimers(base)).toBe(1);
      w.service!.fire!();
      await vi.waitFor(() => { expect(w.live.backgrounded()).toBe(false); });
      expect(watchTimers(base)).toBe(0);
      /* AND THE WATCH'S OWN ACT STOPS. `beat` is the claim watch's and nothing else's — the
         stood-down watch reads the engine and never touches the service — so this is what
         separates "the timer is gone" from "the timer is still running and returning early". */
      const beats = w.service!.beats;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(w.service!.beats, "the claim watch outlived its notification").toBe(beats);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a declined background arms no timer, and a live service found on return arms one", async () => {
    /**
     * Both halves of the arming rule, and each is the other's control.
     *
     * The DECLINE is the reachable state in which a watch would be armed over a notification that
     * is not showing — a timer asking a question nobody can see the answer to.
     *
     * The RETURN is a service this object did not start: a JS reload, or a React context the system
     * rebuilt, leaves the notification up with no timer behind it, and a claim lost from that
     * moment would go unnoticed for as long as the app stayed open.
     */
    vi.useFakeTimers();
    try {
      const declined = wire("android", { service: { starts: false }, checkEveryMs: 1000 });
      const base = vi.getTimerCount();
      await declined.live.phaseChanged("background");
      expect(declined.live.backgrounded()).toBe(false);
      expect(watchTimers(base)).toBe(0);
      await declined.live.phaseChanged("active");
      expect(watchTimers(base)).toBe(0);
      declined.live.dispose();

      /* A fresh object over a service that is ALREADY up — the reload. */
      const reloaded = wire("android", { service: { running: true }, checkEveryMs: 1000 });
      const reloadedBase = vi.getTimerCount();
      await reloaded.live.phaseChanged("active");
      expect(reloaded.live.backgrounded()).toBe(true);
      expect(watchTimers(reloadedBase)).toBe(1);
      reloaded.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("one service gets ONE watch, however many times it is passed through", async () => {
    /**
     * A background then a foreground reaches the arming twice for one service. A second interval
     * would ask the engine twice a minute for ever, and `clearInterval` on the handle this object
     * kept would leave the other one running past the notification it was armed for.
     */
    vi.useFakeTimers();
    try {
      const w = wire("android", { checkEveryMs: 1000 });
      const base = vi.getTimerCount();
      await w.live.phaseChanged("background");
      await w.live.phaseChanged("active");
      await w.live.phaseChanged("background");
      await w.live.phaseChanged("active");
      expect(watchTimers(base)).toBe(1);
      w.live.dispose();
      /* DISPOSE TAKES BOTH — the claim watch and the stood-down watch. A session that is over
         asks nothing about anybody's mailbox. */
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an engine that cannot be ASKED leaves the notification standing", async () => {
    /**
     * A throw from the state read is not evidence about who organizes the mailbox. Taking the
     * notification down on it would end a person's organizing over a momentary failure, and the
     * claim would then age out of a mailbox nothing had decided to give up.
     */
    vi.useFakeTimers();
    try {
      const w = wire("android", { checkEveryMs: 1000 });
      await w.live.phaseChanged("background");
      let asked = 0;
      w.engine.organizing = [];
      const live = w.live;
      /* The seam throws rather than answering. Replacing the array would be the OTHER fact — see
         the cell below — so this reaches for the recorder's own failure arm. */
      Object.defineProperty(w.engine, "organizing", {
        get(): never { asked += 1; throw new Error("the roster could not be read"); },
      });
      await vi.advanceTimersByTimeAsync(1000);
      expect(asked).toBeGreaterThan(0);
      expect(live.backgrounded()).toBe(true);
      expect(w.logged.map((l) => l.event)).toContain("organizer_state_unreadable");
    } finally {
      vi.useRealTimers();
    }
  });

  it("an empty roster is a removed mailbox, and its notification is false too", async () => {
    /**
     * The other fact, and the reason the check is `some(...)` rather than
     * `length > 0 && some(...)`: a standalone phone with no mailbox attached organizes nothing, so
     * a notification naming an address is a statement about a mailbox this install no longer runs.
     */
    vi.useFakeTimers();
    try {
      const w = wire("android", { checkEveryMs: 1000 });
      await w.live.phaseChanged("background");
      w.engine.organizing = [];
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.live.backgrounded()).toBe(false);
      expect(w.engine.calls).not.toContain("handBack");
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose drops the stop listener and the watch, and leaves the notification alone", async () => {
    /* Stopping the service is a person's act. A JS teardown — a reload, a screen unmounting — is
       not, and one that stopped organizing would make the app's own lifecycle a stop verb. */
    vi.useFakeTimers();
    try {
      const w = wire("android", { checkEveryMs: 1000 });
      await w.live.phaseChanged("background");
      w.live.dispose();
      expect(w.service?.unsubscribed).toBe(1);
      expect(w.service?.running).toBe(true);
      const before = w.engine.calls.filter((c) => c === "organizing").length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(w.engine.calls.filter((c) => c === "organizing")).toHaveLength(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a READER does not post a notification saying it organizes", async () => {
    /**
     * Another install took the mailbox and this install's gate stood down. Starting the service
     * here names this phone as the organizer on a surface a person cannot argue with, and it would
     * stand until the watch ran. The watch is the belt for a claim lost LATER; this is the state at
     * the moment of backgrounding.
     */
    const w = wire("android", { engine: { organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }] } });
    await w.live.phaseChanged("background");
    expect(w.service?.calls).not.toContain("start");
    expect(w.live.backgrounded()).toBe(false);
    /* AND NO HAND-BACK: the claim is not ours to give back — the gate already stood down — so
       asking the server to expunge records by our own id is a write about a mailbox this install
       has been told it does not hold. */
    expect(w.engine.calls).not.toContain("handBack");
    const declined = w.logged.filter((l) => l.event === "organizer_background_declined_reader");
    expect(declined).toHaveLength(1);
    /* WHICH of the two ways it is not ours. A stand-down is a mailbox this install HAD, so the
       code is the loss; the cell below is the other one, where there was never anything to lose. */
    expect(declined[0]!.detail?.["why"]).toBe("claim_lost");
  });

  it("A CLAIM THIS PHONE HAS JUST TAKEN is not a reader — the service starts and nothing goes back", async () => {
    /**
     * ══ THE WINDOW ═══════════════════════════════════════════════════════════════════════════
     *
     * Measured twice on a real server (the row this lane closes): the claim reaches
     * `ohmail/_meta` a round trip BEFORE the runtime reports itself organizing — the gate appends
     * the claim, then takes its permit, and only then flips. Press "Organize here", switch away
     * inside that window, and this arm read `organizing: false` as "another install took the
     * mailbox": it declined, disarmed the watch and handed nothing back, so a claim stood over a
     * phone that organized nothing until it lapsed and every other machine was refused the
     * mailbox meanwhile.
     *
     * Ownership is the fact. `claimed: true, organizing: false, standDown: false` IS that window.
     */
    const w = wire("android", {
      engine: { organizing: [{ mailboxId: "mb1", organizing: false, standDown: false, claimed: true }] },
    });
    await w.live.phaseChanged("background");
    expect(w.service?.calls, "the service was not started over a mailbox this phone holds")
      .toContain("start");
    expect(w.live.backgrounded()).toBe(true);
    expect(w.logged.map((l) => l.event)).not.toContain("organizer_background_declined_reader");
    expect(w.engine.calls, "a claim of ours was handed back").not.toContain("handBack");
    /* AND THE HOLD SAYS WHICH STATE IT HELD IN. The runtime's own word, not the copy's: a claim
       taken a moment ago reads `starting` until the gate's permit lands, which is what makes the
       window readable off a device log instead of off the mail server's wire. */
    const held = w.logged.filter((l) => l.event === "organizer_background_holds");
    expect(held).toHaveLength(1);
    expect(held[0]!.detail?.["state"]).toBe("starting");
  });

  it("NOTHING OF OURS — a phone nobody has consented to declines, and says so in its own word", async () => {
    /**
     * The other half of the ruling, and the reason `standDown === true` was refused as the whole
     * mechanism: before consent this install organizes nothing, is stood down from nothing and
     * holds nothing. Reading the stand-down alone would send it down the start-the-service path
     * and post "Organizing" over an install that organizes nothing — the false state this arm
     * exists to prevent. It declines exactly as it did before, and the code is not a LOSS.
     */
    const w = wire("android", {
      engine: { organizing: [{ mailboxId: "mb1", organizing: false, standDown: false, claimed: false }] },
    });
    await w.live.phaseChanged("background");
    expect(w.service?.calls).not.toContain("start");
    expect(w.live.backgrounded()).toBe(false);
    expect(w.engine.calls).not.toContain("handBack");
    const declined = w.logged.filter((l) => l.event === "organizer_background_declined_reader");
    expect(declined).toHaveLength(1);
    expect(declined[0]!.detail?.["why"]).toBe("no_claim_here");
  });

  it("the ordinary hold names the runtime's own word", async () => {
    /* The window cell's positive control at the other reading: a runtime that HAS flipped. One
       line, and the word moves with the state rather than with the copy. */
    const up = wire("android");
    await up.live.phaseChanged("background");
    expect(up.logged.find((l) => l.event === "organizer_background_holds")?.detail?.["state"])
      .toBe("organizing");
  });

  it("an engine that cannot say is not a reader — the ordinary background still runs", async () => {
    /* The positive control over the two cells above: `null` must not be read as `false`, or a
       momentary failure would decline every background and give a live mailbox back. The hold
       line says which of the three it was, so a device log does not report a guess as a state. */
    const w = wire("android");
    Object.defineProperty(w.engine, "organizing", {
      get(): never { throw new Error("the roster could not be read"); },
    });
    await w.live.phaseChanged("background");
    expect(w.service?.calls).toEqual(["start"]);
    expect(w.live.backgrounded()).toBe(true);
    expect(w.logged.find((l) => l.event === "organizer_background_holds")?.detail?.["state"])
      .toBe("unknown");
  });

  it("the runtime beats while the notification stands, and paces on the platform's number", async () => {
    /**
     * A foreground service keeps the process unfrozen; it does not keep React Native's timers
     * running. The service's watchdog takes the notification down after two silent intervals, so
     * this beat is the only thing that separates a live runtime from a frozen one — and it can only
     * be sent by a runtime that is running, which is what makes it evidence rather than a flag.
     *
     * HALF the platform's interval, so one lost tick is not a missed deadline.
     */
    vi.useFakeTimers();
    try {
      const w = wire("android", { service: { beatIntervalMs: 20_000 } });
      await w.live.phaseChanged("background");
      expect(w.service?.beats).toBe(0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(w.service?.beats).toBe(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(w.service?.beats).toBe(2);
      w.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a beat answering that the service is GONE hands the mailbox back", async () => {
    /**
     * The watchdog fired, or the system killed the service. Nothing on the phone says the mailbox
     * is being organized any more, so this install must not go on holding the claim — which is the
     * same rule every other decline follows.
     */
    vi.useFakeTimers();
    try {
      const w = wire("android", { service: { beatIntervalMs: 20_000 } });
      const base = vi.getTimerCount();
      await w.live.phaseChanged("background");
      /* The service is gone: the platform answers the beat with false. */
      w.service!.running = false;
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => { expect(w.engine.calls).toContain("handBack"); });
      expect(w.logged.map((l) => l.event)).toContain("organizer_service_gone");
      expect(watchTimers(base)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * THE GATE `start` REFUSES ON, RE-READ WHILE THE SERVICE STANDS (FIX-026 row 93). A long-press on
   * the notification turns the `organizing` channel off and Android hides it while the app switch
   * stays on; a standing service is never restarted, so only the tick can notice.
   */
  it("a channel turned off under a standing notification is the notifications-off decline in the background", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", { service: { beatIntervalMs: 20_000 } });
      const base = vi.getTimerCount();
      await w.live.phaseChanged("background");
      expect(w.engine.calls, "control: the service stood and nothing was handed back").not.toContain("handBack");
      w.service!.canPost = false;
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => { expect(w.engine.calls).toContain("handBack"); });
      expect(w.service!.gateReads).toBeGreaterThan(0);
      expect(reason(w.logged, "organizer_background_declined")).toBe("notification_not_showing");
      expect(w.service!.calls.at(-1)).toBe("stop");
      expect(w.notificationsOff, "the off state was not said").toHaveLength(1);
      expect(w.announced, "a hidden channel was announced as battery saver").toHaveLength(0);
      expect(w.logged.map((l) => l.event), "a closed gate read as a system kill").not.toContain("organizer_service_gone");
      expect(watchTimers(base)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("in the foreground the notification comes down and the off state is said; the next background hands back", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", { service: { beatIntervalMs: 20_000 } });
      await w.live.phaseChanged("background");
      await w.live.phaseChanged("active");
      expect(w.service!.running, "control: the service stays up in the foreground").toBe(true);
      const handBacks = w.engine.calls.filter((c) => c === "handBack").length;
      w.service!.canPost = false;
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => { expect(w.service!.calls.at(-1)).toBe("stop"); });
      expect(w.service!.running).toBe(false);
      expect(w.notificationsOff).toHaveLength(1);
      expect(w.logged.map((l) => l.event)).toContain("organizer_notification_hidden");
      expect(w.engine.calls.filter((c) => c === "handBack"), "the open app handed its mailbox back").toHaveLength(handBacks);
      /* The Kotlin `start` refuses on the same gate, so the double's start does too. */
      w.service!.starts = false;
      await w.live.phaseChanged("background");
      expect(w.engine.calls.filter((c) => c === "handBack")).toHaveLength(handBacks + 1);
      expect(w.notificationsOff, "said once per session, not at every edge").toHaveLength(1);
      w.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("POSITIVE CONTROL — an open gate changes nothing, and an unreadable one decides nothing", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", { service: { beatIntervalMs: 20_000 } });
      await w.live.phaseChanged("background");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(w.service!.gateReads).toBe(2);
      expect(w.service!.calls).not.toContain("stop");
      w.service!.canPostThrows = true;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(w.service!.calls, "an unreadable gate took the notification down").not.toContain("stop");
      expect(w.logged.map((l) => l.event)).toContain("organizer_service_gate_unreadable");
      expect(w.notificationsOff).toHaveLength(0);
      w.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a build with no service organizes only while it is open", async () => {
    /* The state before the native half exists in a build, and the state on any platform whose
       module did not resolve. It is not a degraded Android: it is the iPhone answer, which is
       true everywhere. */
    const w = wire("android", { service: null });
    await w.live.phaseChanged("background");
    expect(w.engine.calls).toEqual(["handBack"]);
    expect(w.live.handedBack()).toBe(true);
    expect(reason(w.logged, "organizer_hand_back")).toBe("no_background_service");
  });

  it("every decline says which one it was", async () => {
    /* Four reasons reach the log and each names a different thing a person can act on. Asserted
       because a code nothing compares is indistinguishable from any other code. */
    const saver = wire("android", { service: { restricted: true } });
    await saver.live.phaseChanged("background");
    expect(reason(saver.logged, "organizer_hand_back")).toBe("system_restricted");

    const unseen = wire("android", { service: { starts: false } });
    await unseen.live.phaseChanged("background");
    expect(reason(unseen.logged, "organizer_hand_back")).toBe("notification_not_showing");

    /* THE PERSON'S STOP HAS ITS OWN LINE, because it is no longer a hand-back: it goes through the
       release the ROW records, and a decline and a deliberate stop must not be one event in a log
       somebody is reading to find out why a mailbox stopped being organized. */
    const stopped = wire("android");
    await stopped.live.phaseChanged("background");
    stopped.service!.fire!();
    await vi.waitFor(() => { expect(stopped.live.backgrounded()).toBe(false); });
    expect(reason(stopped.logged, "organizer_stopped_by_person")).toBe("stopped_from_notification");
    expect(reason(stopped.logged, "organizer_hand_back")).toBeNull();
  });

  it("and the two causes raise DIFFERENT announcements — the sentence that was false", async () => {
    /**
     * Both declines used to arrive as `announceRestricted`, whose sentence names battery saver. On
     * an Android 13+ first install the cause is a denied `POST_NOTIFICATIONS` and that sentence is
     * false — and it was the only thing the This-phone panel said. Two causes, two records.
     */
    const saver = wire("android", { service: { restricted: true } });
    await saver.live.phaseChanged("background");
    expect(saver.announced).toHaveLength(1);
    expect(saver.notificationsOff, "battery saver announced a notification refusal").toHaveLength(0);

    const unseen = wire("android", { service: { starts: false } });
    await unseen.live.phaseChanged("background");
    expect(unseen.notificationsOff).toHaveLength(1);
    expect(unseen.announced, "a denied notification announced battery saver").toHaveLength(0);
  });

  it("says each one ONCE, and one cause never spends the other's turn", async () => {
    /* A shared latch would let the first decline consume the announcement and leave the second
       cause unsaid for the rest of the session — two facts, one of them silent. */
    const w = wire("android", { service: { restricted: true } });
    await w.live.phaseChanged("background");
    await w.live.phaseChanged("active");
    await w.live.phaseChanged("background");
    expect(w.announced, "battery saver was announced at every background").toHaveLength(1);

    const both = wire("android", { service: { starts: false } });
    await both.live.phaseChanged("background");
    both.service!.restricted = true;
    await both.live.phaseChanged("active");
    await both.live.phaseChanged("background");
    expect(both.notificationsOff).toHaveLength(1);
    expect(both.announced, "the second cause was swallowed by the first").toHaveLength(1);
  });
});

/* ── the transition order, which is where the pair of IMAP writes goes wrong ───────────────── */

/* ── Android 15+: the platform's data-sync time limit ─────────────────────────────────────── */

describe("Android's data-sync time limit ends the service, and the mailbox goes back", () => {
  /** Background with the service up, then the platform stops it at its limit (Kotlin `onTimeout`). */
  async function timedOutInBackground() {
    const w = wire("android", { checkEveryMs: 1000 });
    const base = vi.getTimerCount();
    await w.live.phaseChanged("background");
    expect(watchTimers(base)).toBe(1);
    w.service!.running = false;
    w.service!.fireTimedOut!();
    await vi.advanceTimersByTimeAsync(0);
    return { w, base };
  }
  const count = (calls: readonly string[], name: string): number => calls.filter((c) => c === name).length;

  it("in the background: one hand-back, never the person's stop, and no stale tick", async () => {
    vi.useFakeTimers();
    try {
      const { w, base } = await timedOutInBackground();
      expect(count(w.engine.calls, "handBack")).toBe(1);
      expect(w.engine.calls).not.toContain("stopOrganizing");
      expect(reason(w.logged, "organizer_service_timed_out")).toBe("system_time_limit");
      expect(reason(w.logged, "organizer_hand_back")).toBe("system_time_limit");
      expect(watchTimers(base)).toBe(0);
      expect(w.live.backgrounded()).toBe(false);
      expect(w.announced).toEqual([]);
      expect(w.notificationsOff).toEqual([]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(count(w.engine.calls, "handBack")).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opening the app resumes after the hand-back, and the next background starts it again", async () => {
    vi.useFakeTimers();
    try {
      const { w } = await timedOutInBackground();
      await w.live.phaseChanged("active");
      expect(w.engine.calls.lastIndexOf("resume")).toBeGreaterThan(w.engine.calls.indexOf("handBack"));
      await vi.advanceTimersByTimeAsync(5000);
      expect(count(w.engine.calls, "handBack")).toBe(1);
      await w.live.phaseChanged("background");
      expect(count(w.service!.calls, "start")).toBe(2);
      expect(w.live.backgrounded()).toBe(true);
      expect(count(w.logged.map((l) => l.event), "organizer_background_holds")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("while the app is open there is nothing to give back", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", { checkEveryMs: 1000 });
      await w.live.phaseChanged("background");
      await w.live.phaseChanged("active");
      w.service!.running = false;
      w.service!.fireTimedOut!();
      await vi.advanceTimersByTimeAsync(5000);
      expect(w.engine.calls).not.toContain("handBack");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a newer service already standing is left alone, its watch armed", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", { checkEveryMs: 1000 });
      const base = vi.getTimerCount();
      await w.live.phaseChanged("background");
      w.service!.fireTimedOut!();
      await vi.advanceTimersByTimeAsync(0);
      expect(w.engine.calls).not.toContain("handBack");
      expect(watchTimers(base)).toBe(1);
      expect(w.live.backgrounded()).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose drops the time-limit listener", () => {
    const w = wire("android");
    w.live.dispose();
    expect(w.service?.timedOutUnsubscribed).toBe(1);
    expect(w.service?.fireTimedOut).toBeNull();
  });
});

describe("a hand-back the platform froze on the way is said — both platforms", () => {
  /* The engine's half (`hand-back-before-the-freeze.test.ts`) ends a cycle in flight so the release
     usually lands in the few seconds a phone has. When it does not, it completes at the thaw and
     the claim blocked the other install meanwhile: that is said, on this phone's card. */
  for (const platform of ["android", "ios"] as const) {
    it(`${platform}: a hand-back that answered past the window is late, and one in time takes it back`, async () => {
      let t = 1_000_000;
      const w = wire(platform, {
        now: () => t,
        // Android declines on battery saver; iOS has no service and leaves on every background.
        service: platform === "android" ? { restricted: true } : null,
        engine: { onHandBack: () => { t += HAND_BACK_WINDOW_MS + 1; } },
      });
      await w.live.phaseChanged("background");
      expect(w.live.handedBack(), "the claim did go, at the thaw").toBe(true);
      expect(w.late.at(-1), "a hand-back past the window was not said").toBe(true);
      expect(w.logged.some((l) => l.event === "organizer_hand_back_late")).toBe(true);

      await w.live.phaseChanged("active");
      w.engine.onHandBack = undefined;         // the next one lands at once
      await w.live.phaseChanged("background");
      expect(w.late.at(-1), "a hand-back in time takes the sentence back").toBe(false);
    });
  }

  it("a hand-back that could not look is said too, and an empty roster says nothing", async () => {
    const w = wire("ios", { service: null, engine: { handBack: [[{ mailboxId: "mb1", released: null }]] } });
    await w.live.phaseChanged("background");
    expect(w.late.at(-1)).toBe(true);
    const empty = wire("ios", { service: null, engine: { handBack: [[]] } });
    await empty.live.phaseChanged("background");
    expect(empty.late.at(-1), "nothing was held, so nothing was late").toBe(false);
  });
});

describe("transitions are serialized", () => {
  it("a foreground arriving during a hand-back does not claim before the release lands", async () => {
    /**
     * Overlapped, the resume's gate reads the lease BEFORE the release lands, claims a mailbox this
     * install already holds, and the release then removes the claim it has just re-armed — an
     * install that believes it organizes a mailbox whose `ohmail/_meta` says nobody does.
     */
    let releaseLanded = false;
    let resumeSawRelease: boolean | null = null;
    const live = createBackgroundOrganizing({
      platform: "ios",
      service: null,
      notice: () => NOTICE,
      announceRestricted: () => undefined,
      announceNotificationsOff: () => undefined,
      sayStartFailed: () => undefined,
      sayHandBackLate: () => undefined,
      engine: {
        handBack: async () => {
          await new Promise((r) => setTimeout(r, 20));
          releaseLanded = true;
          return [{ mailboxId: "mb1", released: 1 }];
        },
        resume: async () => { resumeSawRelease = releaseLanded; return [{ mailboxId: "mb1", served: 1 }]; },
        organizing: () => [{ mailboxId: "mb1", organizing: true, standDown: false, claimed: true }],
        stopOrganizing: async () => "released" as const,
        claimHere: async () => "held",
      },
    });
    const bg = live.phaseChanged("background");
    const fg = live.phaseChanged("active");
    await Promise.all([bg, fg]);
    expect(resumeSawRelease).toBe(true);
  });

  /**
   * A BACK DURING A RESUME'S FORCED DRAIN. The engine's drain ends only at a cycle edge that reads
   * the latch, and with timers paused nothing else ends it — so the double's resume parks until the
   * latch is set, as production's does. Queued behind it, the Back never latched and never ran.
   */
  function drainingEngine(o: { withLeave?: boolean } = {}) {
    const calls: string[] = [];
    let latched = false;
    let edge: (() => void) | null = null;
    const reachEdge = (): void => { latched = true; edge?.(); };
    const eng: BackgroundEngine = {
      ...(o.withLeave === false ? {} : { leave: () => { calls.push("leave"); reachEdge(); } }),
      handBack: async () => { calls.push("handBack"); reachEdge(); return [{ mailboxId: "mb1", released: 1 }]; },
      resume: async () => {
        calls.push("resume");
        latched = false;
        await new Promise<void>((r) => { edge = r; if (latched) r(); });
        edge = null;
        calls.push("resume-edge");
        return [{ mailboxId: "mb1", served: 1 }];
      },
      organizing: () => [{ mailboxId: "mb1", organizing: true, standDown: false, claimed: true }],
      stopOrganizing: async () => "released" as const,
      claimHere: async () => "held",
    };
    return { eng, calls };
  }
  const settle = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const liveWith = (eng: BackgroundEngine, svc: BackgroundService | null, platform: OrganizerPlatform) =>
    createBackgroundOrganizing({
      platform, service: svc, engine: eng, notice: () => NOTICE,
      announceRestricted: () => undefined, announceNotificationsOff: () => undefined,
      sayStartFailed: () => undefined, sayHandBackLate: () => undefined,
    });

  it("a Back during a resume's forced drain latches in the caller's tick, and the claim goes back at the edge", async () => {
    const { eng, calls } = drainingEngine();
    const live = liveWith(eng, null, "ios");
    void live.phaseChanged("active");
    await settle(10);
    expect(calls, "the premise: a resume is draining").toEqual(["resume"]);
    const bg = live.phaseChanged("background");
    expect(calls, "the Back set no latch in its own tick; it waits behind the drain").toContain("leave");
    await Promise.race([bg, settle()]);
    expect(calls, "the claim never went back").toEqual(["resume", "leave", "resume-edge", "handBack"]);
    expect(live.handedBack()).toBe(true);
  });

  it("…with notifications refused on Android, the same Back hands the mailbox back", async () => {
    const { eng, calls } = drainingEngine();
    const s = service({ starts: false });
    const live = liveWith(eng, s.service, "android");
    void live.phaseChanged("active");
    await settle(10);
    const bg = live.phaseChanged("background");
    await Promise.race([bg, settle()]);
    expect(calls).toEqual(["resume", "leave", "resume-edge", "handBack"]);
    expect(s.log.calls).toContain("start");
  });

  it("a service that shows keeps the mailbox: the latch is lifted and nothing goes back", async () => {
    const { eng, calls } = drainingEngine();
    const s = service({ starts: true });
    const live = liveWith(eng, s.service, "android");
    void live.phaseChanged("active");
    await settle(10);
    const bg = live.phaseChanged("background");
    await Promise.race([bg, settle()]);
    expect(calls, "a held background gave the claim back").not.toContain("handBack");
    expect(calls.slice(0, 4), "the latch stood over a service that organizes").toEqual(
      ["resume", "leave", "resume-edge", "resume"]);
    expect(live.backgrounded()).toBe(true);
  });

  it("an idle queue sets no latch, and an engine without `leave` waits as before", async () => {
    const idle = drainingEngine();
    await liveWith(idle.eng, null, "ios").phaseChanged("background");
    expect(idle.calls).toEqual(["handBack"]);
    const old = drainingEngine({ withLeave: false });
    const live = liveWith(old.eng, null, "ios");
    void live.phaseChanged("active");
    await settle(10);
    void live.phaseChanged("background");
    await settle();
    expect(old.calls, "the positive control: behind the drain, nothing ran").toEqual(["resume"]);
  });
});

/* ── the person's stop, and the way back ──────────────────────────────────────────────────── */

describe("the notification's stop is a person's act, and it is REMEMBERED", () => {
  /**
   * ══ CONTROL 1 ════════════════════════════════════════════════════════════════════════════
   *
   * Measured twice on a device. From an organizing phone: background (notification up, claim
   * heartbeating), swipe the notification away — the documented way to stop — then open the app
   * again with no kill. A claim was WRITTEN to `ohmail/_meta` and never serviced: heartbeat frozen
   * at the instant it was written, no notification, no foreground service, no drain after the
   * first, a message sat in `INBOX` unfiled for 70 s, and Settings read `Organizing` throughout.
   * A held, unserviced claim also refuses the person's laptop until the lease goes stale.
   *
   * The mechanism was the stop: `handBack` removes the claim and leaves the ROW saying organizer,
   * because that is what an app leaving the foreground needs — the next resume takes the mailbox
   * back with no press. A person's stop is the opposite instruction and needs the opposite
   * durability, so it goes through the engine's release, which the row records.
   */
  it("presses the engine's REMEMBERED stop, never the bare hand-back", async () => {
    const w = wire("android");
    await w.live.phaseChanged("background");
    expect(w.service?.calls).toContain("start");
    w.service!.fire!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.engine.calls, "the person's stop did not reach the durable release").toContain("stopOrganizing");
    /* AND NOT THE BARE HAND-BACK, which is the un-remembered twin: the row would still say
       organizer and the next foreground resume would claim the mailbox again. */
    expect(w.engine.calls, "the stop fell back to the hand-back the row does not record")
      .not.toContain("handBack");
    /* THE NOTIFICATION COMES DOWN SECOND — the claim must not still be standing when the one
       surface that advertises it disappears. The ORDER is asserted in the case above, which
       records both acts into one list; here it is the presence. */
    expect(w.service?.calls).toContain("stop");
    /* AND THE SCREEN IS TOLD. A panel already open said `Stopping` for two and a half minutes. */
    expect(w.moved.length, "the stop left the panel on the state it was opened in").toBeGreaterThan(0);
  });

  it("KEEPS the notification when the release was REFUSED — the engine is still organizing", async () => {
    /**
     * This used to take it down, and that was the defect: press Stop on the notification, let the
     * release fail, and every visible sign that the mailbox was being organized was gone while the
     * foreground engine went on polling, organizing and renewing the lease — so no other install
     * could take the mailbox either, and there was no way back to the control that would have
     * stopped it. The controls are torn down by the stop's SUCCESS.
     */
    vi.useFakeTimers();
    try {
      const w = wire("android", { engine: { stopOrganizing: "refused" } });
      await w.live.phaseChanged("background");
      w.service!.fire!();
      await vi.advanceTimersByTimeAsync(STOP_BACKOFF_MS * STOP_ATTEMPTS * 4);
      /* THE ENGINE IS ASSERTED STILL ORGANIZING, not merely the notification present: the two have
         already come apart here once. */
      expect(w.engine.organizing.some((m) => m.organizing)).toBe(true);
      expect(w.service?.calls, "the notification came down over a running engine").not.toContain("stop");
      expect(reason(w.logged, "organizer_stopped_by_person")).toBe("stopped_from_notification");
      /* ASKED AGAIN UNDER THE BOUND, and said on the notification once it is spent. */
      expect(w.engine.calls.filter((c) => c === "stopOrganizing")).toHaveLength(STOP_ATTEMPTS);
      expect(w.logged.map((l) => l.event)).toContain("organizer_stop_did_not_complete");
      expect(w.service?.notices.map((n) => n.body)).toContain(EN.notifStopFailed);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a THROWING release keeps it up too, and says so", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", { engine: { stopOrganizingThrows: true } });
      await w.live.phaseChanged("background");
      w.service!.fire!();
      await vi.advanceTimersByTimeAsync(STOP_BACKOFF_MS * STOP_ATTEMPTS * 4);
      expect(w.logged.map((l) => l.event)).toContain("organizer_stop_by_person_failed");
      expect(w.service?.calls, "a thrown release hid a running engine").not.toContain("stop");
      expect(w.service?.notices.map((n) => n.body)).toContain(EN.notifStopFailed);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a stop is not a HANDED-BACK state — nothing resumes from it", async () => {
    /* `handedBack` is the iOS transitional state, given back and to be taken again on the way in.
       A person's stop is the opposite of a state something resumes from, and reporting it as one
       would put "Handed back" on a panel over a mailbox the person deliberately let go. */
    const w = wire("android");
    await w.live.phaseChanged("background");
    w.service!.fire!();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.live.handedBack()).toBe(false);
  });
});

describe("the holder left, and the phone in front of the person takes its mailbox back", () => {
  /**
   * ══ CONTROL 3 ════════════════════════════════════════════════════════════════════════════
   *
   * Measured on a device: the laptop handed the mailbox back through the ordinary path
   * (`organizer_claim_handed_back`, claim record 0) and minutes later the phone had not
   * re-claimed — its panel still naming a machine that had left. Only a relaunch recovered, and it
   * recovered through the launch-time consent press, which is the takeover this lane removes. The
   * stand-down was a one-way door: never re-read while the app ran.
   *
   * The rule is that a phone organizes WHILE IT IS OPEN, so a stood-down session keeps
   * asking on the claim watch's own cadence. It can displace nobody: the engine's door refuses a
   * live foreign claim, which is where the one-organizer invariant is enforced.
   */
  it("asks on the watch's cadence while stood down, and says when it got the mailbox back", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", {
        checkEveryMs: 1000,
        engine: {
          organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }],
          claimHere: ["held", "claimed"],
        },
      });
      /* FIRST TICK: the laptop is still renewing. The door refuses, and NOTHING is said — this is
         the ordinary state of a stood-down phone and a sentence per minute would be noise. */
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.engine.calls.filter((c) => c === "claimHere")).toHaveLength(1);
      /* THE WATCH ASKS AS THE WATCH: it carries no consent, so it cannot mint one. */
      expect(w.engine.claimBy).toEqual(["watch"]);
      expect(w.logged.map((l) => l.event)).not.toContain("organizer_reclaim");
      /* SECOND TICK: the holder has gone. */
      await vi.advanceTimersByTimeAsync(1000);
      const lines = w.logged.filter((l) => l.event === "organizer_reclaim");
      expect(lines, "the re-claim was not logged").toHaveLength(1);
      expect(lines[0]!.detail?.["why"]).toBe("holder_left");
      expect(lines[0]!.detail?.["verdict"]).toBe("claimed");
      expect(w.moved.length, "the screen was not told the mailbox came back").toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /* A PERSON'S REFUSED PRESS THE ENGINE KEEPS WAITING arms the watch over a reader nothing stood
     down, through the engine's own answer (`watchedStates`); without one that reader is not pressed. */
  it.each([
    [true, ["watch"]],
    [false, []],
  ] as const)("a waiting join (%s) arms the watch over a reader nothing stood down", async (joinWaits, pressed) => {
    vi.useFakeTimers();
    try {
      const w = wire("android", {
        checkEveryMs: 1000,
        engine: {
          organizing: [...watchedStates({
            mb1: { organizing: false, heldBy: null, reason: null, releaseRequestedAt: null, claimed: false, joinWaits },
          })],
          heldElsewhere: [false],
          claimHere: ["claimed"],
        },
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(w.engine.claimBy.slice(0, 1)).toEqual(pressed);
      w.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ══ AND THE PANEL RE-DERIVES IN THE STAND-DOWN DIRECTION, WHICH IS WHERE IT DID NOT ═════════
   *
   * Measured on a device: the engine stood the phone down under an OPEN Settings panel and it
   * read `Organizing` with `Stop organizing here` for minutes over a mailbox another phone
   * held, correcting only on leaving the screen and coming back. Every arm that MOVES the claim
   * already told the screen; the arm that only READS it told nobody, so a change the engine made
   * on its own poll reached no open panel. The cue is gated on the panel's whole input, so an
   * unconditional one per tick costs a comparison and notifies only on a difference.
   */
  /**
   * ══ A LIVE HOLDER IS ASKED OF THE ROW, NOT PRESSED ═════════════════════════════════════
   *
   * A phone reading a mailbox a desktop organizes pressed the consent route on every poll and was
   * refused 409 every time, for as long as the desktop ran. The watch asks the row first and
   * presses only once the row says the holder has gone; a row that cannot say is pressed as before.
   */
  it("presses nothing while the row names a live holder, and takes the mailbox once it is free", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", {
        checkEveryMs: 1000,
        engine: {
          organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }],
          heldElsewhere: [true, true, true, false],
          claimHere: ["claimed"],
        },
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(w.engine.calls.filter((c) => c === "heldElsewhere")).toHaveLength(3);
      expect(w.engine.calls.filter((c) => c === "claimHere"), "a live holder was pressed").toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.engine.calls.filter((c) => c === "claimHere")).toHaveLength(1);
      expect(w.logged.filter((l) => l.event === "organizer_reclaim")[0]?.detail?.["verdict"]).toBe("claimed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the device composition hands the watch the engine's own row read", () => {
    const native = fs.readFileSync(
      path.join(HERE, "..", "src", "engine", "organizer-session-native.ts"), "utf8",
    );
    expect(native).toContain("heldElsewhere: () => engine.heldElsewhere(),");
  });

  it("presses as before where the row cannot say who holds the mailbox", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", {
        checkEveryMs: 1000,
        engine: {
          organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }],
          heldElsewhere: [null],
          claimHere: ["held"],
        },
      });
      await vi.advanceTimersByTimeAsync(2000);
      expect(w.engine.calls.filter((c) => c === "claimHere")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the screen on every tick, so a stand-down under an open panel is re-derived", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", {
        checkEveryMs: 1000,
        engine: {
          /* STOOD DOWN and the holder still renewing — the exact state the device sat in, and the
             one where nothing below this tick says anything at all. */
          organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }],
          claimHere: ["held", "held"],
        },
      });
      const before = w.moved.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.moved.length, "the tick read the stand-down and told nobody").toBeGreaterThan(before);
      /* AND IT IS THE TICK, not a re-claim: the door refused, so nothing moved the claim. */
      expect(w.logged.map((l) => l.event)).not.toContain("organizer_reclaim");
    } finally {
      vi.useRealTimers();
    }
  });

  it("never asks for a mailbox this install is NOT stood down from", async () => {
    /* `organizing: false, standDown: false` is the pre-consent state — nobody has asked this phone
       to organize anything — and asking on its behalf would be a consent nobody gave. The
       organizing state is the other exclusion: there is nothing to come back from. */
    vi.useFakeTimers();
    try {
      for (const organizing of [false, true]) {
        const w = wire("android", {
          checkEveryMs: 1000,
          /* `claimed` follows `organizing` here: the false arm is the pre-consent phone (nothing
             of ours) and the true arm the organizing one, and neither is stood down. */
          engine: { organizing: [{ mailboxId: "mb1", organizing, standDown: false, claimed: organizing }] },
        });
        await vi.advanceTimersByTimeAsync(3000);
        expect(w.engine.calls, `organizing=${String(organizing)}`).not.toContain("claimHere");
        w.live.dispose();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("never asks when the engine could not SAY — a failed read is not a licence", async () => {
    /**
     * The opposite direction from the notification teardown, deliberately: there a `null` read
     * leaves the notification standing (ending somebody's organizing over a momentary failure is
     * the worse error), here it leaves somebody else's mailbox alone.
     *
     * Its own control is the case above, which asks on the same cadence over the same wiring with
     * a read that ANSWERS — so this is not a watch that never asks anything.
     */
    vi.useFakeTimers();
    try {
      const unreadable = wire("android", { checkEveryMs: 1000 });
      Object.defineProperty(unreadable.engine, "organizing", {
        get() { throw new Error("the runtime could not be read"); },
      });
      await vi.advanceTimersByTimeAsync(3000);
      expect(unreadable.engine.calls).not.toContain("claimHere");
      expect(unreadable.logged.map((l) => l.event)).toContain("organizer_state_unreadable");
      unreadable.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a throwing door is said, and the watch slows down rather than stopping", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", {
        checkEveryMs: 1000,
        engine: {
          organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }],
          claimHereThrows: true,
        },
      });
      /* THE FIRST REFUSAL COSTS THE NEXT TICK. One press in two ticks, not two. */
      await vi.advanceTimersByTimeAsync(2000);
      expect(w.logged.filter((l) => l.event === "organizer_reclaim_failed").length).toBe(1);
      expect(w.engine.calls.filter((c) => c === "claimHere")).toHaveLength(1);
      /* AND IT DOES NOT STOP. The ladder is 1, 2, 4 ticks, so ten more seconds buy more presses. */
      await vi.advanceTimersByTimeAsync(10_000);
      expect(
        w.engine.calls.filter((c) => c === "claimHere").length,
        "the watch stopped asking altogether",
      ).toBeGreaterThan(1);
      w.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ══ A STANDING REFUSAL IS ONE STATE, NOT TWENTY-NINE PRESSES ═══════════════════════════════
   *
   * Measured on a device: a holder released its claim, and this watch pressed every ten seconds
   * for 4 min 24 s — twenty-nine presses, every one refused for one permanent reason, every one a
   * log line and a re-render, while `ohmail/_meta` stayed empty and the panel named a machine that
   * had gone. That cause is closed at the door (`net/mailboxes.ts` presses the spelling with no
   * second factor on it), but the SHAPE is what these two cases hold: a refusal that stands costs
   * ticks and is said once, and a refusal that lifts is still answered.
   */
  /* A full mailbox is a standing refusal too: the person must make room on the server. */
  it.each(["refused", "mailbox_full"] as const)("a standing refusal (%s) backs the watch off and is said ONCE", async (answer) => {
    vi.useFakeTimers();
    try {
      const w = wire("android", {
        checkEveryMs: 1000,
        engine: {
          organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }],
          claimHere: [answer],
        },
      });
      await vi.advanceTimersByTimeAsync(30_000);
      const presses = w.engine.calls.filter((c) => c === "claimHere").length;
      /* THIRTY TICKS. Ungoverned this is thirty presses — the device's own shape. The ladder
         (1, 2, 4, 8, 8, …) admits five or six of them, and the bound is what is asserted: fewer
         than half, and more than none, so a watch that stopped asking is red too. */
      expect(presses, "the watch pressed a standing refusal on every tick").toBeLessThan(15);
      expect(presses, "the watch stopped asking altogether").toBeGreaterThan(1);
      const lines = w.logged.filter((l) => l.event === "organizer_reclaim");
      expect(lines, "a standing refusal wrote a line per press").toHaveLength(1);
      expect(lines[0]!.detail?.["verdict"]).toBe("refused");
      w.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("and the press that finally works is still answered — the backoff's positive control", async () => {
    /* Without this the case above is satisfied by a watch that gives up after one refusal. The
       door refuses twice and then has the mailbox; the claim still arrives and is said.

       SIX TICKS, which is the ladder read forward: press at tick 1 (refused, one tick skipped),
       press at tick 3 (refused, two skipped), press at tick 6 — and that is the claim. Advancing
       further would press again, because this double goes on reporting a stand-down after handing
       the mailbox back where a real engine would not. */
    vi.useFakeTimers();
    try {
      const w = wire("android", {
        checkEveryMs: 1000,
        engine: {
          organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }],
          claimHere: ["refused", "refused", "claimed"],
        },
      });
      await vi.advanceTimersByTimeAsync(6000);
      expect(w.engine.calls.filter((c) => c === "claimHere"),
        "the ladder did not admit exactly three presses in six ticks").toHaveLength(3);
      const lines = w.logged.filter((l) => l.event === "organizer_reclaim");
      expect(lines.map((l) => l.detail?.["verdict"]), "the re-claim never arrived")
        .toEqual(["refused", "claimed"]);
      expect(w.moved.length, "the screen was not told the mailbox came back").toBeGreaterThan(0);
      w.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ══ THE TICK SAYS THE STATE MAY HAVE MOVED — IN BOTH DIRECTIONS ═══════════════════════════
   *
   * `stateChanged` was called only where this machine had changed something: a re-claim that
   * landed, a notification torn down, an app-state edge. So a STAND-DOWN — the engine's own act,
   * mid-poll, with nothing in JS choosing it — reached no open screen at all. Measured: a laptop
   * took the mailbox, this install's engine stood down seconds later, and Settings read `Organizing`
   * with `Stop organizing here` for minutes, correcting only when somebody navigated away and
   * back. The claim direction corrected in 22.9 s for one reason — the re-claim ran through this
   * machine, and this machine said so.
   *
   * Both arms, on ONE mechanism: the tick says it whatever it goes on to do. `held` is the
   * stand-down arm (the engine reports a foreign holder and the door refuses every press, which is
   * the state that produced the 6 min 26 s) and `claimed` is the arm that already worked.
   */
  it("says the state may have moved on every tick, stand-down as well as re-claim", async () => {
    vi.useFakeTimers();
    try {
      for (const [verdict, why] of [["held", "the stand-down direction"], ["claimed", "the claim direction"]] as const) {
        const w = wire("android", {
          checkEveryMs: 1000,
          engine: {
            organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }],
            claimHere: [verdict],
          },
        });
        const before = w.moved.length;
        await vi.advanceTimersByTimeAsync(1000);
        expect(w.moved.length - before, why).toBeGreaterThan(0);
        w.live.dispose();
      }
      /* AND IT DOES NOT DEPEND ON THE PRESS HAPPENING AT ALL. A phone that organizes its mailbox
         normally never reaches `claimHere` — `standDownNow()` sends the tick home — and that is
         precisely the screen that has to learn about the stand-down when one arrives. */
      const organizing = wire("android", {
        checkEveryMs: 1000,
        engine: { organizing: [{ mailboxId: "mb1", organizing: true, standDown: false, claimed: true }] },
      });
      const before = organizing.moved.length;
      await vi.advanceTimersByTimeAsync(1000);
      expect(organizing.engine.calls, "a tick pressed the door over a mailbox this install organizes")
        .not.toContain("claimHere");
      expect(organizing.moved.length - before, "the tick said nothing where no press was made")
        .toBeGreaterThan(0);
      organizing.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("STOPS when the session is disposed — the app being closed, or the person stopping", async () => {
    /* The bound the ruling names. A watcher that outlived its session would ask for a mailbox on
       behalf of an app nobody has open. */
    vi.useFakeTimers();
    try {
      const w = wire("android", {
        checkEveryMs: 1000,
        engine: {
          organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }],
          claimHere: ["held"],
        },
      });
      await vi.advanceTimersByTimeAsync(1000);
      const asked = w.engine.calls.filter((c) => c === "claimHere").length;
      expect(asked).toBe(1);
      w.live.dispose();
      await vi.advanceTimersByTimeAsync(5000);
      expect(w.engine.calls.filter((c) => c === "claimHere").length, "the watch outlived its session")
        .toBe(asked);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * ══ AND BEHIND THE PERSON IT DOES NOT ASK AT ALL — IDLE TICK SITE 7, RULED ══════════════════
   *
   * The reclaim's premise is that this phone is the one IN FRONT OF the person. Backgrounded
   * without a service that premise is false twice: nobody is looking, and nothing here can renew
   * what the press would win. The press is not refused by the door either — the holder has LEFT,
   * so it is ADMITTED: the phone takes a claim it cannot service, the desktop that can organize is
   * refused for a staleness window, and the mailbox is organized by nobody. The timer stays armed
   * (the session is still alive and the panel's cue rides it); what the phase gates is the PRESS.
   */
  it("makes no press while the app is behind the person with no service running", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", {
        checkEveryMs: 1000,
        engine: {
          organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }],
          /* THE HOLDER HAS ALREADY LEFT, which is what makes this a one-organizer case rather than
             a saved round trip: every press below would be ADMITTED. */
          claimHere: ["claimed"],
        },
      });
      /* THE CONTROL FIRST — in the foreground it asks, so a zero below is the phase's doing. */
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.engine.calls.filter((c) => c === "claimHere"), "a phone in front of the person")
        .toHaveLength(1);
      w.engine.organizing = [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }];
      const before = w.engine.calls.filter((c) => c === "claimHere").length;
      await w.live.phaseChanged("background");
      /* The reader's own exit: no hand-back, no service started — `running` stays false. */
      expect(w.service!.running, "the reader started a service it is not entitled to").toBe(false);
      await vi.advanceTimersByTimeAsync(5000);
      expect(
        w.engine.calls.filter((c) => c === "claimHere").length - before,
        "a backgrounded reader took a mailbox it cannot organize",
      ).toBe(0);
      /* AND IT COMES BACK. The gate is the phase, not a one-way door: the same phone in the
         foreground asks the lease again, which is the other half of the ruling. */
      await w.live.phaseChanged("active");
      await vi.advanceTimersByTimeAsync(1000);
      expect(
        w.engine.calls.filter((c) => c === "claimHere").length - before,
        "the phone never asked again after coming back",
      ).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * THE PHASE IS NOT THE PLATFORM, which is what makes this parity by construction: iOS reaches
   * the same tick through `service: null`, where `organizerRuns()` is false by the same predicate.
   * A rule written on `deps.platform` would have had to be built twice and could disagree once.
   */
  it("makes no press on a backgrounded iPhone either, for the same reason", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("ios", {
        checkEveryMs: 1000,
        service: null,
        engine: {
          organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }],
          claimHere: ["claimed"],
        },
      });
      await vi.advanceTimersByTimeAsync(1000);
      const before = w.engine.calls.filter((c) => c === "claimHere").length;
      expect(before, "the control: an open iPhone asks").toBe(1);
      w.engine.organizing = [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }];
      await w.live.phaseChanged("background");
      await vi.advanceTimersByTimeAsync(5000);
      expect(
        w.engine.calls.filter((c) => c === "claimHere").length - before,
        "a backgrounded iPhone took a mailbox nothing on it can organize",
      ).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A SERVICE THAT IS STILL STANDING IS NOT GATED. The phone is organizing in the background
   * legitimately, so a stand-down that lands there may still be re-read — narrowing to "not in the
   * foreground" would have taken that with it, and the condition would have no reachable contrary.
   */
  it("still asks in the background where the service is running", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", {
        checkEveryMs: 1000,
        service: { running: true, starts: true },
        engine: {
          organizing: [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: true }],
          claimHere: ["held"],
        },
      });
      await w.live.phaseChanged("background");
      const before = w.engine.calls.filter((c) => c === "claimHere").length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(
        w.engine.calls.filter((c) => c === "claimHere").length - before,
        "a phone whose notification is up stopped re-reading its own stand-down",
      ).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ── the copy, in both languages ──────────────────────────────────────────────────────────── */

describe("the notification's words", () => {
  it("both decks carry all four keys, and the body renders the address", () => {
    for (const deck of [EN, DE]) {
      expect(deck.stateOrganizing.length).toBeGreaterThan(0);
      expect(deck.notifStop.length).toBeGreaterThan(0);
      expect(deck.organizerRestricted.length).toBeGreaterThan(0);
      expect(deck.notifBody("mila@example.com")).toContain("mila@example.com");
    }
  });

  it("the body does NOT promise that a tap stops it", () => {
    /**
     * The ruling's own draft said *"ohmail is organizing <address> — tap to stop"* and the design
     * record rejected it: a tap opens the app on every notification anybody has ever touched, so a
     * body promising otherwise fires the stop from the open-the-app reflex. The stop is the action
     * button, and the Kotlin below routes the tap to the launcher.
     */
    for (const deck of [EN, DE]) {
      expect(deck.notifBody("mila@example.com").toLowerCase()).not.toMatch(/tap|tippen|antippen/);
    }
  });

  it("the restriction sentence names what it is and what happens instead", () => {
    expect(EN.organizerRestricted).toMatch(/[Bb]attery saver/);
    expect(EN.organizerRestricted).toMatch(/while the app is open/);
    expect(DE.organizerRestricted).toMatch(/Energiesparmodus/);
    expect(DE.organizerRestricted).toMatch(/offen ist/);
    /**
     * AND THE FIRST CLAUSE CARRIES ITS OWN NEGATION, in both languages.
     *
     * `no-host-census.test.ts` §4 reads each clause on its own — a deck is a flat table and nothing
     * in it says which string renders under which — so a clause naming the phone and an organizing
     * verb must say in that clause that it is not happening. Written as *"Battery saver is stopping
     * ohmail from organizing … on this phone"* it read as a PROMISE to that census, which is the
     * right reading of the words in isolation.
     */
    for (const deck of [EN, DE]) {
      const first = deck.organizerRestricted.split(".")[0]!;
      expect(first, "the restriction clause reads as a promise on its own")
        .toMatch(/\b(not|nicht)\b/);
    }
  });
});

/* ── the native half, read as source ──────────────────────────────────────────────────────── */

describe("the Android service — the half a node process cannot run", () => {
  it("the action button and a swipe-dismiss are ONE constant and ONE handler", () => {
    /**
     * From Android 14 a person may swipe a foreground-service notification away. The door says
     * *"Dismiss the notification to stop."* — so a service that kept running after the swipe would
     * make that sentence false, with no surface left anywhere saying a mailbox is being organized.
     *
     * Asserted as an identity rather than as two wirings: `addAction` and `setDeleteIntent` take
     * the SAME expression, so there is no second constant a later edit could point somewhere else.
     */
    const src = kotlin(SERVICE_KT);
    expect(src).toMatch(/const val ACTION_STOP = "app\.ohmail\.organizer\.STOP"/);
    expect(src).toMatch(/\.addAction\(0, stopLabel, stop\)/);
    expect(src).toMatch(/\.setDeleteIntent\(stop\)/);
    /* One producer of that intent, and it carries the action. */
    expect(src).toMatch(/private fun stopIntent\(\)[\s\S]*?setAction\(ACTION_STOP\)/);
    expect(src).toMatch(/val stop = stopIntent\(\)/);
    /* And exactly one handler: the action is compared in one place. */
    expect(src.match(/intent\?\.action == ACTION_STOP/g)).toHaveLength(1);
  });

  it("the tap opens the app and is never the stop", () => {
    const src = kotlin(SERVICE_KT);
    expect(src).toMatch(/getLaunchIntentForPackage\(packageName\)/);
    expect(src).toMatch(/setContentIntent\(content\)/);
    /* The content intent is built from the launcher, not from `stopIntent()`. */
    expect(src).not.toMatch(/setContentIntent\(stop\)/);
  });

  it("the system never restarts it, because the engine and the address are in JavaScript", () => {
    /**
     * A service the system re-created would come back with no engine and no address: a
     * notification saying "Organizing" over nothing, which is the false-state class this design
     * exists to prevent. `START_NOT_STICKY` everywhere, and a start with no text stops itself.
     */
    const src = kotlin(SERVICE_KT);
    expect(src).not.toMatch(/START_STICKY|START_REDELIVER_INTENT/);
    expect(src.match(/START_NOT_STICKY/g)!.length).toBeGreaterThanOrEqual(3);
    expect(src).toMatch(/private fun stopBecauseUnaddressed\(\)[\s\S]*?stopSelf\(\)/);
  });

  it("nothing in the service is logged — the body is somebody's address", () => {
    const src = kotlin(SERVICE_KT);
    expect(src).not.toMatch(/\bLog\.[dviwe]\(|android\.util\.Log|println\(|Timber/);
  });

  it("the channel is low, silent and badgeless — it is showing for hours", () => {
    const src = kotlin(SERVICE_KT);
    expect(src).toMatch(/NotificationManager\.IMPORTANCE_LOW/);
    expect(src).toMatch(/setShowBadge\(false\)/);
    expect(src).toMatch(/setSound\(null, null\)/);
    expect(src).toMatch(/setOngoing\(true\)/);
    expect(src).toMatch(/const val CHANNEL_ID = "organizing"/);
  });

  it("the restriction is asked BEFORE the start, and both facts are read", () => {
    /**
     * Under a restriction Android may kill the service at any moment with nothing anywhere saying
     * why. Discovering that by its death leaves an app that says it organizes over a mailbox that
     * is not being organized, so it is asked first — and both mechanisms are read, because a
     * per-app background restriction is not battery saver and either one is fatal to the service.
     */
    const src = kotlin(SERVICE_KT);
    expect(src).toMatch(/isPowerSaveMode/);
    expect(src).toMatch(/isBackgroundRestricted/);
    expect(src).toMatch(/areNotificationsEnabled\(\)/);
    const mod = kotlin(MODULE_KT);
    const restricted = mod.indexOf("OrganizerService.isRestricted(context)");
    const canPost = mod.indexOf("OrganizerService.canPostNotification(context)");
    const start = mod.indexOf("startForegroundService");
    expect(restricted).toBeGreaterThan(-1);
    expect(canPost).toBeGreaterThan(restricted);
    expect(start).toBeGreaterThan(canPost);
  });

  it("`start` answers what the SERVICE says about itself, not that a start was asked for", () => {
    /**
     * `startForegroundService` is asynchronous — the service has five seconds to call
     * `startForeground` — so returning `true` on a requested start would report a notification
     * that may not exist.
     *
     * Read from the `start` block's OWN body. Written as a header-to-needle regex this passed over
     * a literal `true` because `OrganizerService.running` also appears in `Function("isRunning")`
     * forty lines below: measured GREEN under the mutation that replaced the answer with `true`.
     */
    const start = blockBody(kotlin(MODULE_KT), 'AsyncFunction("start")');
    expect(start).toContain("startForegroundService(context, intent)");
    /**
     * AND IT WAITS, which is the stronger form of the same rule. `OrganizerService.running` read
     * straight after the call is `false` for a start that is merely queued — the platform has five
     * seconds — and JS treats `false` as "the notification is not showing" and hands the mailbox
     * back, so every ordinary background would have been a decline. The block's value is the
     * bounded wait, and its bound is inside the platform's window.
     */
    const lines = start.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toMatch(/^OrganizerService\.awaitRunning\(\d[\d_]*L\)$/);
    const bound = Number(/awaitRunning\((\d[\d_]*)L\)/.exec(start)![1]!.replace(/_/g, ""));
    expect(bound).toBeGreaterThan(0);
    expect(bound, "the wait must finish inside the platform's own five-second window")
      .toBeLessThan(5000);
    /* The latch it waits on is counted down where the notification is actually posted. */
    const svc = kotlin(SERVICE_KT);
    const posted = svc.indexOf("startForeground(NOTIFICATION_ID");
    const counted = svc.indexOf("up.countDown()");
    expect(posted).toBeGreaterThan(-1);
    expect(counted).toBeGreaterThan(posted);
  });

  it("the app's stop is UNCONDITIONAL, so a pending start cannot outlive it", () => {
    /**
     * `startForegroundService` queues. So JS could start the service, be told `false` (nothing up
     * yet), release the claim and call `stop()` — and a `stop` gated on `running` skipped, because
     * `running` was still false. Android then brought the service up and posted "Organizing …"
     * over a mailbox whose claim had just been released, with no watch armed to take it down.
     *
     * Two halves, and both are asserted: the stop sends `stopService` whatever the state, and the
     * service refuses to go foreground while a stop is outstanding.
     */
    const stop = blockBody(kotlin(MODULE_KT), 'AsyncFunction("stop")');
    expect(stop).toContain("stopService(");
    expect(stop, "the stop is gated on a state that is false for a start still in flight")
      .not.toMatch(/if\s*\(/);
    expect(stop).toContain("OrganizerService.stopping = true");
    const svc = kotlin(SERVICE_KT);
    expect(svc).toMatch(/if \(stopping\) return stopBecauseUnaddressed\(\)/);
    /* And the next start clears it, or one stop would disarm the service for ever. */
    expect(blockBody(kotlin(MODULE_KT), 'AsyncFunction("start")'))
      .toContain("OrganizerService.stopping = false");
  });

  it("a notification only stands while the JavaScript behind it is running", () => {
    /**
     * THE FINDING THIS GUARD IS FOR. A foreground service keeps the PROCESS alive and unfrozen; it
     * does not keep React Native's timers running — `JavaTimerManager` removes its callbacks when
     * the host pauses unless a headless task is active. The engine's poll and the claim watch are
     * timers, so without the task they stop the moment the Activity pauses and the notification
     * would say "Organizing …" over a runtime that had stopped.
     *
     * Two mechanisms, and the second is what makes the first safe to rely on before a device has
     * confirmed it: the headless task keeps the timers alive, and the WATCHDOG stops the service
     * when the beats stop. So a task that does not work costs a notification that disappears —
     * which is true — rather than one that stands over a frozen engine.
     */
    const svc = kotlin(SERVICE_KT);
    /* The task is started where the notification goes up, and stopped where it comes down. */
    expect(svc).toMatch(/startService\(Intent\(this, OrganizerHeadlessService::class\.java\)\)/);
    expect(blockBody(svc, "override fun onDestroy()"))
      .toMatch(/stopService\(Intent\(this, OrganizerHeadlessService::class\.java\)\)/);
    /* The watchdog stops the SERVICE on silence — it does not merely log. */
    const dog = blockBody(svc, "private fun armWatchdog()");
    expect(dog).toContain("jsAlive(System.currentTimeMillis())");
    expect(dog).toContain("stopForeground(STOP_FOREGROUND_REMOVE)");
    expect(dog).toContain("stopSelf()");
    /* ON THE MAIN LOOPER, named. A watchdog on the clock it is watching cannot fire, and
       `Looper.myLooper()` is whatever thread happened to construct the service — which on a
       background thread is a looper that may never run. */
    expect(svc).toContain("Handler(Looper.getMainLooper())");
    expect(svc).not.toMatch(/Handler\(Looper\.myLooper/);
    /* The beat is forgotten on teardown, so a next start cannot inherit this run's last beat. */
    expect(blockBody(svc, "override fun onDestroy()")).toContain("lastBeatMs = 0L");
  });

  it("the headless task's name is one literal on both sides", () => {
    /* A task started under a name nothing registered fails at runtime with a message about a task,
       and the timers stop — which the watchdog then reads as a dead runtime. */
    const headless = fs.readFileSync(HEADLESS_KT, "utf8");
    const name = /const val TASK_NAME = "([^"]+)"/.exec(headless)?.[1];
    /**
     * READ FROM SOURCE, NOT IMPORTED. `organizer-task.ts` imports `react-native`, which ships
     * Flow-typed JavaScript the node suite's transform refuses — `Expected 'from', got 'typeOf'`,
     * and the whole FILE then reports `Tests no tests`, which is a hard failure and not a filter
     * miss. Measured here: importing the constant took every case in this file down.
     */
    const js = fs.readFileSync(path.join(HERE, "..", "src", "engine", "organizer-task.ts"), "utf8");
    const jsName = /export const ORGANIZER_TASK = "([^"]+)"/.exec(js)?.[1];
    expect(name, "the Kotlin declares no task name").toBeDefined();
    expect(jsName, "the JS declares no task name").toBeDefined();
    expect(jsName).toBe(name);
    /* The task never resolves: React Native retires a resolved task and takes the timers with it. */
    expect(js).toContain("registerHeadlessTask");
    expect(js).toMatch(/new Promise<never>\(\(\) => undefined\)/);
    /* …and the config's timeout is zero, which is the platform's "do not time it out". */
    expect(headless).toMatch(/\/\* timeout \*\/ 0L/);
    expect(headless).toMatch(/\/\* allowedInForeground \*\/ true/);
  });

  it("the app's own stop does NOT fire the person's stop event", () => {
    /**
     * JS reaching `stop()` has already handed the mailbox back. Routing the app's stop through
     * `ACTION_STOP` — the person's path — would run the hand-back twice and log the release of a
     * claim that was no longer there. So it is `stopService`, and destroying a foreground service
     * removes its notification.
     */
    const mod = kotlin(MODULE_KT);
    expect(mod).toMatch(/AsyncFunction\("stop"\)[\s\S]*?stopService\(/);
    expect(mod).not.toMatch(/AsyncFunction\("stop"\)[\s\S]*?ACTION_STOP/);
  });

  it("the module declares the one event, and drops its listener with the React context", () => {
    const mod = kotlin(MODULE_KT);
    /* One call: a second `Events(...)` replaces the first. */
    expect(mod).toMatch(/Events\("onStopRequested", "onTimedOut"\)/);
    expect(mod).toMatch(/Name\("OhmailOrganizerService"\)/);
    expect(blockBody(mod, "OnCreate")).toMatch(/OrganizerService\.onStopRequested = \{/);
    expect(blockBody(mod, "OnCreate")).toMatch(/OrganizerService\.onTimedOut = \{/);
    const destroy = blockBody(mod, "OnDestroy");
    expect(destroy).toMatch(/OrganizerService\.onStopRequested = null/);
    expect(destroy).toMatch(/OrganizerService\.onTimedOut = null/);
    /* And the service is NOT stopped on a JS teardown — see `dispose` above. Read from that
       block's OWN body: a regex from the header would match the stop function further down. */
    expect(destroy).not.toMatch(/stopService|stopSelf/);
  });

  it("the manifest declares the service and exactly the two permissions it needs", () => {
    const manifest = xml(MANIFEST);
    expect(manifest).toContain('android:name="android.permission.FOREGROUND_SERVICE"');
    expect(manifest).toContain('android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC"');
    expect(manifest).toContain('android:name="app.ohmail.organizer.OrganizerService"');
    expect(manifest).toContain('android:foregroundServiceType="dataSync"');
    /**
     * EVERY service, counted — not "an `exported="false"` appears somewhere".
     *
     * Written as a `toContain` this passed with one of the two services exported, because the
     * other one's `false` satisfied it: measured, on both halves of the pair. Nothing outside this
     * app may start or stop the organizer, and the headless task host is the same rule.
     */
    const services = [...manifest.matchAll(/<service\b([\s\S]*?)\/>/g)].map((m) => m[1]!);
    expect(services, "the module declares neither service").toHaveLength(2);
    for (const decl of services) {
      expect(decl, `a service is not exported="false": ${decl.trim()}`)
        .toContain('android:exported="false"');
      expect(decl).toContain('android:stopWithTask="false"');
    }
    expect(services.filter((d) => d.includes("OrganizerHeadlessService"))).toHaveLength(1);
    /* NOT declared here: the app already asks for it for wake notices, and a refused one is
       answered by handing the mailbox back rather than by a second request. */
    expect(manifest).not.toContain("POST_NOTIFICATIONS");
    /* Exactly two permissions — a third arriving with an edit is a thing to notice. */
    expect(manifest.match(/<uses-permission/g)).toHaveLength(2);
    /* One module, one registration. */
    const cfg = JSON.parse(fs.readFileSync(path.join(MODULE_DIR, "expo-module.config.json"), "utf8")) as {
      platforms: string[]; android: { modules: string[] };
    };
    expect(cfg.platforms).toEqual(["android"]);
    expect(cfg.android.modules).toEqual(["app.ohmail.organizer.OrganizerServiceModule"]);
  });

  it("iOS gets no background mode for organizing, and that is the decision", () => {
    /**
     * A `UIBackgroundModes` entry would let this app ask iOS to run it later, and the honest
     * sentence on the fourth door says it does not: *"When you leave the app, it hands the mailbox
     * back."* A claim held by a suspended app is the double-organizer hazard written down as a
     * feature, so the entitlement is refused rather than added and unused.
     */
    const appJson = JSON.parse(
      fs.readFileSync(path.join(HERE, "..", "app.json"), "utf8"),
    ) as { expo: { ios?: { infoPlist?: Record<string, unknown>; entitlements?: Record<string, unknown> } } };
    const plist = appJson.expo.ios?.infoPlist ?? {};
    expect(Object.keys(plist)).not.toContain("UIBackgroundModes");
    expect(Object.keys(plist)).not.toContain("BGTaskSchedulerPermittedIdentifiers");
    expect(JSON.stringify(appJson)).not.toContain("processing");
  });
});

/* ── the cadence, pinned ───────────────────────────────────────────────────────────────────── */

describe("the claim watch's cadence", () => {
  it("never leads the engine's own poll", () => {
    /* A watch faster than the gate would read a state the gate has not refreshed and take the
       notification down over a stale answer. A minute, and the engine's poll is slower. */
    expect(CLAIM_WATCH_MS).toBe(60_000);
  });
});

/* ANDROID-NOTIFICATION-SAYS-ORGANIZING-OVER-A-REFUSED-GATE: the body follows the gate while the
   service stands. Re-posted under the one id when the words change; a failed stop's body stands. */
describe("the notification's body follows the gate", () => {
  const BLOCKED: ServiceNotice = { ...NOTICE, body: EN.phoneStateMetaFolderFull };
  it("a gate refused after the background began is said on the notification at the next tick", async () => {
    vi.useFakeTimers();
    try {
      let now = NOTICE;
      const w = wire("android", { checkEveryMs: 1000, notice: () => now });
      await w.live.phaseChanged("background");
      expect(w.service!.notices.map((n) => n.body)).toEqual([NOTICE.body]);
      now = BLOCKED;
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.service!.notices.map((n) => n.body), "the notification kept saying Organizing").toEqual([NOTICE.body, BLOCKED.body]);
      expect(w.live.backgrounded(), "the notification came down: Android keeps one over a running service").toBe(true);
      now = NOTICE;
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.service!.notices.at(-1)?.body, "a healed gate kept the refusal").toBe(NOTICE.body);
      w.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("a body a failed stop left is not replaced by the gate's words", async () => {
    vi.useFakeTimers();
    try {
      let now = NOTICE;
      const w = wire("android", { checkEveryMs: 1000, engine: { stopOrganizing: "refused" }, notice: () => now });
      await w.live.phaseChanged("background");
      w.service!.fire!();
      await vi.advanceTimersByTimeAsync(STOP_BACKOFF_MS * STOP_ATTEMPTS * 4);
      expect(w.service!.notices.at(-1)?.body, "the premise: the stop's failure is said").toBe(EN.notifStopFailed);
      now = BLOCKED;
      await vi.advanceTimersByTimeAsync(3000);
      expect(w.service!.notices.at(-1)?.body, "the gate's words covered a stop that did not complete").toBe(EN.notifStopFailed);
      w.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  /* LOW-1: the claim lost and the words changed on one tick. The stop
     disarms the watch, and the refresh queued behind it may not start the service again over a
     running flag the platform clears only later. */
  for (const keeps of [1, 0]) {
    it(`a claim lost on the tick the words change is not posted again (running flag ${keeps ? "late" : "at once"})`, async () => {
      vi.useFakeTimers();
      try {
        let now = BLOCKED;
        const w = wire("android", { checkEveryMs: 1000, notice: () => now, service: { stopKeepsRunning: keeps } });
        await w.live.phaseChanged("background");
        now = NOTICE;
        w.engine.organizing = [{ mailboxId: "mb1", organizing: false, standDown: true, claimed: false }];
        await vi.advanceTimersByTimeAsync(3000);
        expect(w.service!.calls, "the notification came back over a claim this phone lost").toEqual(["start", "stop"]);
        w.live.dispose();
      } finally {
        vi.useRealTimers();
      }
    });
  }
  /* The JS reload over a live service: this runtime posted nothing, so its first tick says the gate's words. */
  it("after a JS reload over a standing notification, the first tick restores the gate's words", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", { checkEveryMs: 1000, notice: () => BLOCKED, service: { running: true } });
      await w.live.phaseChanged("active");
      expect(w.service!.notices, "the premise: the reload posted nothing").toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(w.service!.notices.map((n) => n.body)).toEqual([BLOCKED.body]);
      await vi.advanceTimersByTimeAsync(2000);
      expect(w.service!.notices, "posted again with the same words").toHaveLength(1);
      w.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("words that did not change are not posted again (control)", async () => {
    vi.useFakeTimers();
    try {
      const w = wire("android", { checkEveryMs: 1000 });
      await w.live.phaseChanged("background");
      await vi.advanceTimersByTimeAsync(3000);
      expect(w.service!.notices).toHaveLength(1);
      w.live.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

