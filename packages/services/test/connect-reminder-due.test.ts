import { describe, it, expect } from "vitest";
import type { AccessLifecycle, AccessTrial } from "@trafficflow/db";
import { makeEntitlementsClient, type EntitlementsFetch } from "@trafficflow/db/cloud";
import {
  connectReminderDue, readConnectReminderSwitch, CONNECT_REMINDER_AFTER_MS, TRIAL_REMINDER_AHEAD_MS,
} from "../src/account-lifecycle-pass.js";

/**
 * THE CONNECT REMINDER'S DUE RULE (onboarding 2026-10-25): one mail to a trial that has not connected
 * a mailbox, a day or more after it began, while more than two days of it are left and no
 * cancellation is scheduled. Every fact comes from the entitlements program, and a fact it did not
 * state is "not due". Whether a mailbox exists is the database's to say (the pg file).
 */
const NOW = new Date("2026-10-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number): string => new Date(NOW.getTime() + ms).toISOString();

const trialing = (over: Partial<AccessLifecycle> = {}): AccessLifecycle => ({
  state: "trialing", closedReason: null, trialEndsAt: at(10 * DAY), graceUntil: null, closedAt: null,
  erasureAt: null, erasedAt: null, formerlyPaid: false, ...over,
});
const STARTED = at(-2 * DAY);
const stated: AccessTrial = { startedAt: STARTED, cancelScheduled: false };
const begun = (msAgo: number): AccessTrial => ({ startedAt: at(-msAgo), cancelScheduled: false });

describe("connectReminderDue — the truth table", () => {
  it("due on a trial a day old, more than two days from its end, with no cancellation: anchored on its start", () => {
    expect(connectReminderDue(trialing(), stated, NOW)).toEqual({ anchor: new Date(STARTED) });
  });

  it("the edges: a day after the start is due and a millisecond less is not; two days left is not, a millisecond more is", () => {
    expect(connectReminderDue(trialing(), begun(CONNECT_REMINDER_AFTER_MS), NOW)).not.toBeNull();
    expect(connectReminderDue(trialing(), begun(CONNECT_REMINDER_AFTER_MS - 1), NOW)).toBeNull();
    expect(connectReminderDue(trialing({ trialEndsAt: at(TRIAL_REMINDER_AHEAD_MS) }), stated, NOW)).toBeNull();
    expect(connectReminderDue(trialing({ trialEndsAt: at(TRIAL_REMINDER_AHEAD_MS + 1) }), stated, NOW)).not.toBeNull();
    expect(CONNECT_REMINDER_AFTER_MS).toBe(DAY);
  });

  it("no reminder outside the trial", () => {
    for (const state of ["grace", "past_due", "active", "closed", "erased"] as const) {
      expect(connectReminderDue(trialing({ state }), stated, NOW), state).toBeNull();
    }
  });

  it("a scheduled cancellation is no reminder, and neither is a cancellation the program did not state", () => {
    expect(connectReminderDue(trialing(), { ...stated, cancelScheduled: true }, NOW)).toBeNull();
    expect(connectReminderDue(trialing(), { startedAt: STARTED }, NOW)).toBeNull();
  });

  it("a start the program did not state, that is no date, or that has not come yet is no reminder", () => {
    expect(connectReminderDue(trialing(), undefined, NOW)).toBeNull();
    expect(connectReminderDue(trialing(), { cancelScheduled: false }, NOW)).toBeNull();
    expect(connectReminderDue(trialing(), { startedAt: "soon", cancelScheduled: false }, NOW)).toBeNull();
    expect(connectReminderDue(trialing(), begun(-DAY), NOW)).toBeNull();
  });

  it("a trial whose end the program did not state, or not as a date, is no reminder", () => {
    expect(connectReminderDue(trialing({ trialEndsAt: null }), stated, NOW)).toBeNull();
    expect(connectReminderDue(trialing({ trialEndsAt: "later" }), stated, NOW)).toBeNull();
  });
});

describe("through the entitlements client: an absent, null or wrong-type field sends nothing", () => {
  const ACC = "11111111-1111-4111-8111-111111111111";
  const lifecycle = { ...trialing(), lifecycleEpoch: at(-60 * DAY) };
  const read = async (body: Record<string, unknown>) => {
    const impl: EntitlementsFetch = async () => ({
      status: 200,
      json: async () => ({
        entitlements: { syncEnabled: true, canAddMailbox: true, aiEnabled: true, mailboxLimit: 1, storageBytesLimit: null },
        lifecycle, ...body,
      }),
    });
    const drift: string[] = [];
    const port = makeEntitlementsClient({
      baseUrl: "https://e.example", secret: "x".repeat(24), fetchImpl: impl,
      onCallFault: () => { /* not under test */ }, onContractFault: (f) => { drift.push(f.field); },
    });
    const v = await port.access(ACC);
    expect(drift, "the trial object is never a drift of the body").toEqual([]);
    return connectReminderDue(v.lifecycle!, v.trial, NOW);
  };

  it("the program's object, well formed, is due", async () => {
    expect(await read({ trial: stated })).toEqual({ anchor: new Date(STARTED) });
  });

  it.each([
    ["absent", {}],
    ["null", { trial: null }],
    ["a string", { trial: "trialing" }],
    ["an array", { trial: [stated] }],
    ["a start that is a number", { trial: { startedAt: Date.parse(STARTED), cancelScheduled: false } }],
    ["a start that is null", { trial: { startedAt: null, cancelScheduled: false } }],
    ["a cancellation that is a string", { trial: { startedAt: STARTED, cancelScheduled: "false" } }],
    ["a cancellation that is missing", { trial: { startedAt: STARTED } }],
  ])("%s: no reminder", async (_name, body) => {
    expect(await read(body)).toBeNull();
  });
});

/**
 * THE SWITCH-ON CUTOFF (TF_CONNECT_REMINDER_SINCE): `send` reminds only trials begun at or after it, so a
 * switch-on never reaches the trials that began before. `send` without one that is an instant is
 * refused, never all trials; an earlier cutoff than meant reaches trials that were to be held, so a
 * date alone, a number or a time without its zone is not read as one.
 */
describe("readConnectReminderSwitch — send needs a cutoff that is an instant", () => {
  const SINCE = "2026-10-25T18:00:00.000Z";

  it("send beside an ISO instant sends from it, whatever zone or precision names that instant", () => {
    for (const raw of [SINCE, "2026-10-25T18:00:00Z", "2026-10-25T18:00Z", " 2026-10-25T20:00:00+02:00 ", "2026-10-25T13:00:00.000-05:00"]) {
      expect(readConnectReminderSwitch("send", raw), raw).toEqual({ mode: "send", since: new Date(SINCE) });
    }
  });

  it("send without a cutoff is refused, never a reminder to every trial", () => {
    for (const raw of [undefined, null, "", "   "]) {
      expect(readConnectReminderSwitch("send", raw), String(raw)).toEqual({ mode: "refused", why: "not_set" });
    }
  });

  it("a cutoff that is not a full instant with its zone is refused: a date, a number, a local time, a word, a day the calendar has not", () => {
    for (const raw of [
      "2026-10-25", "1", "1761415200000", "2026-10-25T18:00:00", "2026-10-25 18:00:00Z", "2026-10-25t18:00:00z",
      "yesterday", "2026-02-30T00:00:00Z", "2026-10-25T24:00:00Z", "2026-13-01T00:00:00Z", "2026-10-25T18:00:00+2:00",
    ]) {
      expect(readConnectReminderSwitch("send", raw), raw).toEqual({ mode: "refused", why: "not_an_instant" });
    }
  });

  it("log is never refused: it keeps a cutoff it can read for its count, and none otherwise", () => {
    expect(readConnectReminderSwitch("log", SINCE)).toEqual({ mode: "log", since: new Date(SINCE) });
    expect(readConnectReminderSwitch(undefined, SINCE)).toEqual({ mode: "log", since: new Date(SINCE) });
    expect(readConnectReminderSwitch("log", "2026-10-25")).toEqual({ mode: "log", since: null });
    expect(readConnectReminderSwitch(undefined, undefined)).toEqual({ mode: "log", since: null });
  });
});
