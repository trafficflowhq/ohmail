/**
 * ══ WHAT THE PHONE'S BACKGROUND MACHINE ACTUALLY WRITES, THROUGH THE REAL LOGGER ═════════════
 *
 * `apps/mobile/src/engine/background.ts` decides what happens to the mailbox at every app-state
 * edge, and until this lane nothing passed it a `log` — so a decline (a refused notification,
 * battery saver, a build with no organizer service) was invisible in `adb logcat` and two lanes
 * read declines off the service table and the mail server's wire instead.
 *
 * ── WHY THIS FILE IS HERE AND NOT IN `apps/mobile/test` ──────────────────────────────────────
 *
 * The mobile suite drives that machine with a `log` that pushes `(event, detail)` onto an array,
 * which asserts what a CALL SITE HANDS OVER and never what the census LETS THROUGH. That is the
 * exact seam `packages/core/src/log.ts` has been bitten by four times (the attach-phase timings,
 * `closed`, `exported`, `messageId`): a field absent from `ALLOWED_FIELDS` is dropped and the
 * line arrives with its numbers stripped out, while every fake-logger test stays green. The real
 * logger lives in this package — `createSidecarLog` is what `startPhoneEngine` builds over the
 * app's sink — so the control belongs beside it, driving the app's own module.
 *
 * No engine, no store and no socket: the machine takes its engine and its service as seams.
 */
import { describe, expect, it } from "vitest";
import {
  createBackgroundOrganizing,
  type BackgroundEngine,
  type BackgroundOrganizing,
  type BackgroundService,
  type OrganizerPlatform,
  type ServiceNotice,
} from "../../mobile/src/engine/background.js";
import type { StopOrganizingOutcome } from "../../mobile/src/engine/standalone-door.js";
import { createSidecarLog } from "../src/log.js";

/** One emitted line, parsed. `droppedFields` is the census's own report of what it refused. */
interface Line {
  event: string;
  level: string;
  droppedFields?: string[];
  [field: string]: unknown;
}

const NOTICE: ServiceNotice = {
  channelName: "Organizing",
  body: "Organizing a mailbox.",
  stopLabel: "Stop organizing",
  /* REQUIRED on the notice: a stop the server would not confirm swaps the body for this one. */
  stopFailedBody: "Could not stop organizing — press again.",
};

interface EngineOpts {
  claimed?: boolean;
  /** What `handBack` reports per mailbox. `null` is the engine's "could not look". */
  released?: number | null;
  handBackThrows?: boolean;
  stopAnswers?: StopOrganizingOutcome;
  claim?: "claimed" | "held" | "refused";
  organizing?: boolean;
  standDown?: boolean;
  organizingThrows?: boolean;
}

function fakeEngine(o: EngineOpts): BackgroundEngine {
  return {
    handBack: async () => {
      if (o.handBackThrows === true) throw new TypeError("the store handle is closed");
      return [{ mailboxId: "m1", released: o.released === undefined ? 1 : o.released }];
    },
    resume: async () => [{ mailboxId: "m1", served: 1 }],
    stopOrganizing: async () => o.stopAnswers ?? "released",
    claimHere: async () => o.claim ?? "claimed",
    organizing: () => {
      if (o.organizingThrows === true) throw new RangeError("the runtime map is not readable");
      /* `claimed` is the fact the transition turns on, and it is not `organizing`: the engine
         calls a mailbox ours a round trip before a pass reports itself organizing. Every case
         here is a phone that HOLDS the mailbox and is deciding what to do with it. */
      return [{
        mailboxId: "m1", organizing: o.organizing ?? true,
        standDown: o.standDown ?? false, claimed: o.claimed ?? true,
      }];
    },
  };
}

interface ServiceOpts {
  starts?: boolean;
  restricted?: boolean;
  running?: boolean;
}

function fakeService(o: ServiceOpts): { service: BackgroundService; fire: () => void; timeOut: () => void } {
  let stop: (() => void) | null = null;
  let timedOut: (() => void) | null = null;
  let running = o.running ?? true;
  return {
    service: {
      start: async () => o.starts ?? true,
      stop: async () => undefined,
      beat: () => true,
      beatIntervalMs: () => 60_000,
      running: () => running,
      restricted: () => o.restricted ?? false,
      canPost: () => true,
      onStopRequested: (listener) => { stop = listener; return () => { stop = null; }; },
      onTimedOut: (listener) => { timedOut = listener; return () => { timedOut = null; }; },
    },
    fire: () => { stop?.(); },
    /* The platform stopped the service at its limit: it is down before the event arrives. */
    timeOut: () => { running = false; timedOut?.(); },
  };
}

/** The machine, wired to the REAL hardened diagnostic — the one a phone's engine hands back out. */
function wired(
  platform: OrganizerPlatform,
  o: { engine?: EngineOpts; service?: ServiceOpts | null } = {},
): { live: BackgroundOrganizing; lines: Line[]; fireStop: () => void; timeOut: () => void } {
  const lines: Line[] = [];
  const log = createSidecarLog({ sink: (line) => { lines.push(JSON.parse(line) as Line); } });
  /* A SERVICE BY DEFAULT — `null` is the iOS arm and the no-service build, and both are named. */
  const svc = o.service === null ? null : fakeService(o.service ?? {});
  const live = createBackgroundOrganizing({
    platform,
    engine: fakeEngine(o.engine ?? {}),
    service: svc?.service ?? null,
    notice: () => NOTICE,
    announceRestricted: () => undefined,
    /* THE SECOND SENTENCE. The two declines are told apart by the code, so the machine
       needs both announcers wired or the notification arm throws instead of declining. */
    announceNotificationsOff: () => undefined,
    /* A start that did not finish starting has nowhere to render in this fixture. */
    sayStartFailed: () => undefined,
    sayHandBackLate: () => undefined,
    log,
  });
  return { live, lines, fireStop: () => svc?.fire(), timeOut: () => svc?.timeOut() };
}

const only = (lines: readonly Line[], event: string): Line => {
  const hits = lines.filter((l) => l.event === event);
  expect(hits.length, `${event} was written ${hits.length} times`).toBe(1);
  return hits[0]!;
};

/**
 * EVERY FIELD THE CALL SITE HANDED OVER SURVIVED. `droppedFields` is the census's own report, so
 * this is the assertion that cannot be satisfied by a line the allowlist emptied.
 */
const nothingDropped = (line: Line): void => {
  expect(line.droppedFields, `${line.event} lost fields to the census`).toBeUndefined();
};

describe("the phone's background declines, as lines a person holding a logcat can read", () => {
  it("iOS: leaving the foreground is a decline, and the hand-back reports what it released", async () => {
    const w = wired("ios", { service: null });
    await w.live.phaseChanged("background");

    const declined = only(w.lines, "organizer_background_declined");
    expect(declined.why).toBe("left_the_foreground");
    /* NOT the system: this platform suspends the app, and announcing a restriction here would be
       a false sentence about somebody's battery settings. */
    expect(declined.restricted).toBe(false);
    expect(declined.level).toBe("info");
    nothingDropped(declined);

    const back = only(w.lines, "organizer_hand_back");
    expect(back.why).toBe("left_the_foreground");
    expect(back.mailboxes).toBe(1);
    expect(back.unresolved).toBe(0);
    expect(back.handedBack).toBe(true);
    nothingDropped(back);
  });

  it("Android with no service: the build cannot organize while closed, and says so", async () => {
    const w = wired("android", { service: null });
    await w.live.phaseChanged("background");
    const declined = only(w.lines, "organizer_background_declined");
    expect(declined.why).toBe("no_background_service");
    expect(declined.restricted).toBe(false);
    nothingDropped(declined);
  });

  it("Android under a background restriction: the decline names the system", async () => {
    /* NOT ALREADY STANDING: the restriction is asked before a START, never against a service
       that is up and organizing — so this case wires the state it is about. */
    const w = wired("android", { service: { restricted: true, running: false } });
    await w.live.phaseChanged("background");
    const declined = only(w.lines, "organizer_background_declined");
    expect(declined.why).toBe("system_restricted");
    expect(declined.restricted).toBe(true);
    nothingDropped(declined);
  });

  it("Android with the notification refused: the line names THAT, not battery saver", async () => {
    /**
     * The row this lane was filed for. A first install on Android 13+ starts with
     * `POST_NOTIFICATIONS` denied, the service answers `false`, and the app declines — and the
     * only record of it used to be a notification record that was never written. The two causes
     * are told apart by the code and not by the `restricted` flag beside it, which is `true` for
     * both: from the person's side the system said no either way.
     */
    const w = wired("android", { service: { starts: false, running: false } });
    await w.live.phaseChanged("background");
    const declined = only(w.lines, "organizer_background_declined");
    expect(declined.why).toBe("notification_not_showing");
    expect(declined.restricted).toBe(true);
    nothingDropped(declined);
  });

  it("a hand-back the engine could not complete leaves handedBack false and says why", async () => {
    const w = wired("ios", { service: null, engine: { released: null } });
    await w.live.phaseChanged("background");
    const back = only(w.lines, "organizer_hand_back");
    expect(back.unresolved).toBe(1);
    /* "Handed back" would be a false state while this install may still hold the claim. */
    expect(back.handedBack).toBe(false);
    expect(w.live.handedBack()).toBe(false);
    nothingDropped(back);
  });

  it("the person's stop from the notification carries its verdict", async () => {
    const w = wired("android", { engine: { stopAnswers: "not_organizing" } });
    w.fireStop();
    /* The stop goes through the machine's serial queue, so it settles a turn or two later. */
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const stopped = only(w.lines, "organizer_stopped_by_person");
    expect(stopped.why).toBe("stopped_from_notification");
    /* `not_organizing` is "the release recorded nothing", which is a state and not a failure —
       and the WORD is what tells it from `refused`, which a boolean could not. */
    expect(stopped.stopped).toBe("not_organizing");
    nothingDropped(stopped);
  });

  it("Android's data-sync time limit: both lines name it and lose nothing", async () => {
    const w = wired("android");
    await w.live.phaseChanged("background");
    w.timeOut();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const timedOut = only(w.lines, "organizer_service_timed_out");
    expect(timedOut.why).toBe("system_time_limit");
    nothingDropped(timedOut);
    const back = only(w.lines, "organizer_hand_back");
    expect(back.why).toBe("system_time_limit");
    expect(back.handedBack).toBe(true);
    nothingDropped(back);
  });

  it("a thrown engine becomes class and code, never a message with a path in it", async () => {
    const w = wired("ios", { service: null, engine: { handBackThrows: true } });
    await w.live.phaseChanged("background");
    const failed = only(w.lines, "organizer_hand_back_failed");
    expect(failed.why).toBe("left_the_foreground");
    expect(failed.errorClass).toBe("TypeError");
    /* THE MESSAGE IS NOT IN THE LINE. `err` is a logger-owned slot and collapses; a line carrying
       a store's own words is how a path or a credential reaches logcat. */
    expect(JSON.stringify(failed)).not.toContain("the store handle is closed");
    expect(failed.level).toBe("error");
    nothingDropped(failed);
  });

  it("an unreadable runtime is its own line, and the machine does not decide on it", async () => {
    const w = wired("android", { engine: { organizingThrows: true } });
    await w.live.phaseChanged("background");
    const unreadable = only(w.lines, "organizer_state_unreadable");
    expect(unreadable.errorClass).toBe("RangeError");
    nothingDropped(unreadable);
    /* AND IT DID NOT DECLINE. `null` is "cannot say", never "organizes nothing". */
    expect(w.lines.some((l) => l.event === "organizer_background_declined")).toBe(false);
  });
});

describe("the guard is not vacuous", () => {
  it("POSITIVE CONTROL: a field the census does not carry IS reported dropped", () => {
    /**
     * Every assertion above rests on `droppedFields` being absent meaning something. The census
     * is an allowlist in `packages/core/src/log.ts`, so a name nobody added is silently stripped
     * and the line still arrives — which is precisely how four instrumentation changes shipped
     * with their numbers missing. This drives the same logger with a name that is not on the
     * list and reads the report back.
     */
    const lines: Line[] = [];
    createSidecarLog({ sink: (l) => { lines.push(JSON.parse(l) as Line); } })(
      "organizer_background_declined",
      { why: "system_restricted", unlistedCounter: 1 },
    );
    expect(lines[0]!.droppedFields).toEqual(["unlistedCounter"]);
    /* …and the allowlisted one beside it came through, so the drop is about the NAME. */
    expect(lines[0]!.why).toBe("system_restricted");
  });
});
