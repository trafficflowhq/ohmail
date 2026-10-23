/**
 * SEND LATER ON THE PHONE (mail 0077) — the composer's second way for a message to end, and
 * the Scheduled surface that holds what it produced, driven through the SAME `bootEngine`
 * composition the app runs, against the loopback mail server's real `/drafts/:id/schedule`
 * routes.
 *
 * What bites:
 *  · the press becomes an APPOINTMENT, not a delivery — `POST /drafts` then
 *    `POST /drafts/:id/schedule`, and NOTHING reaches `/send`;
 *  · a plain reply's mutation is byte-identical to the one built before the field existed —
 *    no `sendAt` key on the wire, no scheduled row in the mirror;
 *  · the confirmed sentence NEVER says "sent" over a message still on the account;
 *  · the empty-body refusal is judged before the appointment, exactly as before the signature;
 *  · CANCEL has three outcomes and only `confirmed` is a cancellation — the server's 409
 *    ("already being sent") and a queued cancel each get their own sentence;
 *  · the Scheduled projection lists soonest-first, keeps a row whose time is unknown, and says
 *    so rather than inventing one;
 *  · the picker cannot name a past instant: the hour rows are filtered by the lead, the evening
 *    preset drops inside it, and the press re-checks against the real clock.
 */
import { composeBodyMin } from "../src/ui/compose-fit";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sayArg } from "../src/refusal";
import type { EntityReader } from "@ohmail/client-engine";
import { bootEngine, type MobileEngineDeps } from "../src/engine/boot";
import {
  WALL_CLOCK_CASES, WALL_CLOCK_ZONE, askedTime, daysAhead,
} from "../../../test/support/wall-clock-days";
import {
  confirmedSendSay,
  DAY_OFFSETS,
  dayAt,
  dayAtHour,
  flushQueued,
  liveActions,
  liveScheduled,
  scheduleLabel,
  SEND_LATER_HOURS,
  SEND_LATER_MIN_LEAD_MS,
  todayEvening,
  usableHours,
  type LiveWorldActions,
} from "../src/state/live";
import { Copy } from "../src/copy";
import { dto, listen, mailServer } from "./helpers/mail-server";
import { sqlWorld } from "./helpers/pair-server";

const world = sqlWorld();
const uuid = (() => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
})();
const deps: MobileEngineDeps = { openExecutor: world.open, deleteDatabase: world.drop, uuid };

async function scene(extra: (fake: ReturnType<typeof mailServer>) => void = () => undefined) {
  const fake = mailServer();
  const origin = await listen(fake.server);
  fake.addMessage(dto("m-1", { subject: "Invoice 12", from: { name: "Ada", address: "ada@fake.test" } }));
  extra(fake);
  const boot = await bootEngine(deps, { origin, token: "tok-1", accountId: "acct-1" });
  if (boot.kind !== "ready") throw new Error("boot refused");
  await boot.verifyIdentity();
  await boot.engine.start();
  const toasts: string[] = [];
  /**
   * THE MUTATION OBJECTS THEMSELVES, recorded on the way through. The wire alone cannot
   * settle "a plain reply is byte-identical to one built before Send later existed": the
   * adapter never puts `sendAt` in a request body — it reads the field to choose a ROUTE —
   * so a mutation carrying an inert `sendAt: null` is invisible downstream and a wire-only
   * assertion passes over it. The claim is about the object, so the object is what is read.
   */
  const mutations: Record<string, unknown>[] = [];
  const engine = new Proxy(boot.engine, {
    get(target, prop) {
      if (prop === "mutate") {
        return (m: Record<string, unknown>, o?: unknown) => {
          mutations.push(m);
          return (target.mutate as (a: unknown, b?: unknown) => unknown)(m, o);
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const actions: LiveWorldActions = liveActions({
    engine,
    toast: (m) => toasts.push(sayArg(m)),
    uuid,
    zone: "UTC",
  });
  return { fake, origin, ...boot, actions, toasts, mutations };
}

const wire = (fake: ReturnType<typeof mailServer>, method: string, path: RegExp | string) =>
  fake.seen.filter((r) => r.method === method && (typeof path === "string" ? r.url === path : path.test(r.url)));

/** An instant far enough ahead that no clock skew inside a test run can make it past. */
const soon = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

/* ── the appointment on the wire ─────────────────────────────────────────────────────────── */

describe("a Send-later press is an appointment, never a delivery", () => {
  it("posts the draft, then /schedule with the picked time — and NOTHING reaches /send", async () => {
    const live = await scene();
    const at = soon();
    const res = await live.actions.sendReply("m-1", "on its way", false, null, at);
    expect(res.outcome).toBe("sent");
    expect(wire(live.fake, "POST", "/drafts")).toHaveLength(1);
    const scheduled = wire(live.fake, "POST", /^\/drafts\/[^/]+\/schedule$/);
    expect(scheduled).toHaveLength(1);
    expect(JSON.parse(scheduled[0]!.body)).toEqual({ sendAt: at });
    // The field is on the MUTATION, which is what picks the route — see `scene`'s recorder.
    expect(live.mutations.filter((m) => m.kind === "mail_send")).toHaveLength(1);
    expect(live.mutations.find((m) => m.kind === "mail_send")!.sendAt).toBe(at);
    // The whole point: no SMTP was dialled. A single /send here would be mail leaving early.
    expect(wire(live.fake, "POST", /^\/drafts\/[^/]+\/send$/)).toHaveLength(0);
    const row = live.fake.draftRows().find((d) => d.status === "scheduled");
    expect(row).toBeDefined();
    expect(row!.sendAt).toBe(at);
    live.store.close();
    live.fake.server.close();
  });

  it("the confirmed sentence names the appointment and never claims a send", async () => {
    const live = await scene();
    const at = soon();
    await live.actions.sendReply("m-1", "later please", false, null, at);
    expect(live.toasts).toEqual([Copy.scheduledFor(scheduleLabel(at, new Date(), "UTC"))]);
    expect(live.toasts[0]).not.toBe(Copy.replySent);
    live.store.close();
    live.fake.server.close();
  });

  it("a plain reply is BYTE-IDENTICAL to one built before Send later existed", async () => {
    const live = await scene();
    await live.actions.sendReply("m-1", "now please", false, null);
    expect(wire(live.fake, "POST", /^\/drafts\/[^/]+\/send$/)).toHaveLength(1);
    expect(wire(live.fake, "POST", /^\/drafts\/[^/]+\/schedule$/)).toHaveLength(0);
    // No `sendAt` key ON THE MUTATION — not merely absent from the wire, which the adapter
    // never puts it on either way — and none anywhere on the wire, and no scheduled row.
    const sends = live.mutations.filter((m) => m.kind === "mail_send");
    expect(sends).toHaveLength(1);
    expect(Object.keys(sends[0]!)).not.toContain("sendAt");
    for (const req of live.fake.seen) expect(req.body).not.toContain("sendAt");
    expect(liveScheduled(live.engine.read(), { now: new Date(), zone: "UTC" })).toEqual([]);
    expect(live.toasts).toEqual([Copy.replySent]);
    live.store.close();
    live.fake.server.close();
  });

  it("the empty-body refusal is judged BEFORE the appointment — nothing goes on the wire", async () => {
    const live = await scene();
    const res = await live.actions.sendReply("m-1", "   ", false, null, soon());
    expect(res.outcome).toBe("failed");
    expect(wire(live.fake, "POST", "/drafts")).toHaveLength(0);
    /* TOLD since the attachments slice: this belt returns before `sent()`'s toast site, and a
       refusal that rendered nothing was measured on a device as a silent no-op. The
       empty assertion here was pinning that silence. Nothing on the wire is still the point. */
    expect(live.toasts).toEqual([Copy.composeNeedContent]);
    live.store.close();
    live.fake.server.close();
  });

  it("a FORWARD cannot wear an appointment — refused before any request, not after the row", async () => {
    const live = await scene();
    // The composer never offers Send later on a forward; this is the SAME rule where the
    // surface cannot bypass it — a draft row stores no forward reference (§14), so the
    // adapter refuses the combination outright rather than scheduling something else.
    const res = await live.engine.mutate({
      kind: "mail_send",
      inReplyTo: null,
      forwardOf: "m-1",
      mailboxId: "mb-1",
      subject: "Fwd: Invoice 12",
      body: "have a look",
      to: [{ name: null, address: "bo@fake.test" }],
      sendAt: soon(),
    });
    expect(res.status).toBe("rolled_back");
    expect(res.error?.code).toBe("schedule_unsupported_content");
    expect(wire(live.fake, "POST", /^\/drafts\/[^/]+\/schedule$/)).toHaveLength(0);
    expect(wire(live.fake, "POST", /^\/drafts\/[^/]+\/send$/)).toHaveLength(0);
    live.store.close();
    live.fake.server.close();
  });

  it("the server's future-only precondition is reported, not papered over", async () => {
    const live = await scene();
    // The past instant the picker refuses to offer, forced past the surface: the SERVER's
    // clock is the authority, and its refusal must reach the reader as a failure.
    const res = await live.actions.sendReply("m-1", "too late", false, null, "2020-01-01T00:00:00.000Z");
    expect(res.outcome).toBe("failed");
    expect(live.toasts).toEqual([Copy.replyFailed]);
    expect(liveScheduled(live.engine.read(), { now: new Date(), zone: "UTC" })).toEqual([]);
    live.store.close();
    live.fake.server.close();
  });
});

describe("a Send-later that had to wait for a connection still confirms as an APPOINTMENT", () => {
  it("the flush ledger carries the appointment, so no background confirm can claim a delivery", async () => {
    const live = await scene();
    const at = soon();
    // The wire refuses RETRYABLY, twice: `sendReply` retries once on the spot (a transport
    // blip is the common case), so two refusals are what actually parks the intent on the
    // queue with its key — the phone in a tunnel.
    live.fake.failNextStatus("POST", "/drafts", 503);
    live.fake.failNextStatus("POST", "/drafts", 503);
    const res = await live.actions.sendReply("m-1", "later, offline", false, null, at);
    expect(res.outcome).toBe("queued");

    // …and lands on the reconnect flush the world layer runs after every successful drain.
    const settled = await flushQueued(live.engine, live.actions.releaseConfirmed);
    expect(settled.size).toBe(1);
    const [outcome] = [...settled.values()];
    expect(outcome.status).toBe("confirmed");
    expect(outcome.kind).toBe("mail_send");
    /* WITHOUT THIS FIELD the world layer's ledger sees a confirmed non-forward `mail_send`
       and says "Reply sent." over a message that is still sitting on the account waiting for
       its time. The appointment has to survive the queue for the sentence to be true. */
    expect(outcome.sendAt, "the appointment did not survive the retry queue").toBe(at);
    expect(outcome.forward).toBe(false);
    // And it really was scheduled, not sent.
    expect(wire(live.fake, "POST", /^\/drafts\/[^/]+\/schedule$/)).toHaveLength(1);
    expect(wire(live.fake, "POST", /^\/drafts\/[^/]+\/send$/)).toHaveLength(0);
    live.store.close();
    live.fake.server.close();
  });

  it("an ordinary queued reply still carries no appointment", async () => {
    const live = await scene();
    live.fake.failNextStatus("POST", "/drafts", 503);
    live.fake.failNextStatus("POST", "/drafts", 503);
    expect((await live.actions.sendReply("m-1", "now, offline", false, null)).outcome).toBe("queued");
    const [outcome] = [...(await flushQueued(live.engine, live.actions.releaseConfirmed)).values()];
    expect(outcome.status).toBe("confirmed");
    expect(outcome.sendAt).toBeNull();
    live.store.close();
    live.fake.server.close();
  });
});

/* ── the cancel's three outcomes ─────────────────────────────────────────────────────────── */

describe("cancelling an appointment — only CONFIRMED is a cancellation", () => {
  it("a confirmed cancel says cancelled and the row leaves the Scheduled list", async () => {
    const live = await scene();
    await live.actions.sendReply("m-1", "hold it", false, null, soon());
    const listed = liveScheduled(live.engine.read(), { now: new Date(), zone: "UTC" });
    expect(listed).toHaveLength(1);
    live.toasts.length = 0;
    expect(await live.actions.cancelSchedule(listed[0]!.id)).toBe(true);
    expect(live.toasts).toEqual([Copy.scheduleCancelled]);
    expect(liveScheduled(live.engine.read(), { now: new Date(), zone: "UTC" })).toEqual([]);
    live.store.close();
    live.fake.server.close();
  });

  it("the pass got there first (409): the phone says TOO LATE and the row stays scheduled", async () => {
    const live = await scene();
    await live.actions.sendReply("m-1", "hold it", false, null, soon());
    const listed = liveScheduled(live.engine.read(), { now: new Date(), zone: "UTC" });
    live.fake.claimScheduled(listed[0]!.id);
    live.toasts.length = 0;
    expect(await live.actions.cancelSchedule(listed[0]!.id)).toBe(false);
    expect(live.toasts).toEqual([Copy.scheduleCancelTooLate]);
    // The overlay rolled back with the rejection: the row never falsely reads "cancelled".
    expect(liveScheduled(live.engine.read(), { now: new Date(), zone: "UTC" })).toHaveLength(1);
    live.store.close();
    live.fake.server.close();
  });

  it("a cancel refused for ANY OTHER REASON does not claim the message is being sent", async () => {
    const live = await scene();
    await live.actions.sendReply("m-1", "hold it", false, null, soon());
    const listed = liveScheduled(live.engine.read(), { now: new Date(), zone: "UTC" });
    live.toasts.length = 0;
    // A non-retryable refusal that is NOT the pass's claim (the fake's armed 422). "Already
    // being sent" would be a specific claim about the server that nothing here supports.
    live.fake.failNext("DELETE", "/drafts/");
    expect(await live.actions.cancelSchedule(listed[0]!.id)).toBe(false);
    expect(live.toasts).toEqual([Copy.liveSaveFailed]);
    live.store.close();
    live.fake.server.close();
  });

  it("a row the mirror no longer holds is not 'already being sent' either", async () => {
    const live = await scene();
    live.toasts.length = 0;
    // The engine's local `not_found` — a concurrent drain took the row. The appointment is
    // gone, not in flight, and nothing reaches the wire.
    expect(await live.actions.cancelSchedule("d-nope")).toBe(false);
    expect(live.toasts).toEqual([Copy.liveSaveFailed]);
    live.store.close();
    live.fake.server.close();
  });

  it("a QUEUED cancel says the appointment still stands — never 'cancelled'", async () => {
    const live = await scene();
    await live.actions.sendReply("m-1", "hold it", false, null, soon());
    const listed = liveScheduled(live.engine.read(), { now: new Date(), zone: "UTC" });
    live.toasts.length = 0;
    // A dead wire: the engine parks the intent under its key and answers `queued`.
    live.fake.server.close();
    expect(await live.actions.cancelSchedule(listed[0]!.id)).toBe(false);
    expect(live.toasts).toEqual([Copy.scheduleCancelQueued]);
    live.store.close();
  });
});

/* ── the Scheduled projection ────────────────────────────────────────────────────────────── */

/** A bare reader over hand-built draft rows — the projection's own contract, no wire needed. */
function readerOf(drafts: Record<string, unknown>[]): EntityReader {
  return {
    list: <T,>(type: string): T[] => (type === "draft" ? (drafts as unknown as T[]) : []),
    get: <T,>(type: string, id: string): T | undefined =>
      type === "draft" ? (drafts.find((d) => d.id === id) as T | undefined) : undefined,
  } as unknown as EntityReader;
}

const draftRow = (over: Record<string, unknown>) => ({
  id: "d-x", mailboxId: "mb-1", threadId: null, inReplyToMessageId: null,
  subject: "Invoice 12", body: "the body", to: [{ name: "Ada", address: "ada@fake.test" }],
  cc: [], bcc: [], rationale: null, status: "scheduled",
  createdAt: "2026-08-30T09:00:00.000Z", updatedAt: "2026-08-30T09:00:00.000Z",
  ...over,
});

describe("the Scheduled projection — soonest first, and honest about what it does not know", () => {
  const now = new Date("2026-08-30T09:00:00.000Z");
  const v = { now, zone: "UTC" };

  it("orders by the appointment, not by when the row was touched", () => {
    const rows = liveScheduled(readerOf([
      draftRow({ id: "late", sendAt: "2026-09-02T18:00:00.000Z" }),
      draftRow({ id: "soon", sendAt: "2026-08-30T18:00:00.000Z" }),
    ]), v);
    expect(rows.map((r) => r.id)).toEqual(["soon", "late"]);
  });

  it("a row whose time the mirror does not carry still LISTS, and says the time is unknown", () => {
    const rows = liveScheduled(readerOf([draftRow({ id: "no-time", sendAt: null })]), v);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.when).toBeNull();
  });

  it("an ordinary draft is not an appointment and is not listed", () => {
    const rows = liveScheduled(readerOf([
      draftRow({ id: "d-1", status: "draft", sendAt: null }),
      draftRow({ id: "d-2", sendAt: "2026-08-31T09:00:00.000Z" }),
    ]), v);
    expect(rows.map((r) => r.id)).toEqual(["d-2"]);
  });

  it("AN APPOINTMENT THAT FAILED STAYS ON THE SCREEN — it does not vanish into a Drafts list", () => {
    /* The pass closes a refused appointment back to `draft` with the server's sentence. The
       shared selector lists `scheduled` alone, which is right for the webapp (the row falls
       into Drafts underneath). The phone lists it on BOTH screens: filtered here the message
       would leave the only surface that ever mentioned it, and "it disappeared" reads as "it
       was sent". */
    const rows = liveScheduled(readerOf([
      draftRow({ id: "standing", sendAt: "2026-08-31T09:00:00.000Z" }),
      draftRow({ id: "failed", status: "draft", sendAt: null, sendError: "the mailbox refused" }),
    ]), v);
    expect(rows.map((r) => r.id)).toEqual(["standing", "failed"]);
    const failed = rows[1]!;
    expect(failed.failure).toBe("the mailbox refused");
    // No appointment stands, so there is no time to name and nothing left to cancel.
    expect(failed.when).toBeNull();
    expect(failed.cancellable).toBe(false);
    expect(rows[0]!.cancellable).toBe(true);
  });

  it("a plain draft with no refusal is still not listed — only the failed appointments are", () => {
    const rows = liveScheduled(readerOf([
      draftRow({ id: "half-written", status: "draft", sendAt: null }),
      draftRow({ id: "empty-error", status: "draft", sendAt: null, sendError: "" }),
    ]), v);
    expect(rows).toEqual([]);
  });

  it("stands in for an empty subject and reads the recipients as one line", () => {
    const rows = liveScheduled(readerOf([draftRow({
      subject: "  ",
      to: [{ name: "Ada", address: "ada@fake.test" }, { name: null, address: "bo@fake.test" }],
      sendAt: "2026-08-31T09:00:00.000Z",
    })]), v);
    expect(rows[0]!.subject).toBe(Copy.scheduledNoSubject);
    expect(rows[0]!.to).toBe("Ada, bo@fake.test");
  });

  it("quotes the server's own failure sentence verbatim", () => {
    const rows = liveScheduled(readerOf([draftRow({
      sendAt: "2026-08-31T09:00:00.000Z", sendError: "the mailbox refused the connection",
    })]), v);
    expect(rows[0]!.failure).toBe("the mailbox refused the connection");
  });
});

/* ── the clock the picker and the labels read ────────────────────────────────────────────── */

describe("scheduleLabel — the weekday inside the week, the date beyond it", () => {
  const now = new Date("2026-08-30T09:00:00.000Z");

  it("names the weekday for an appointment inside the coming week", () => {
    expect(scheduleLabel("2026-09-01T18:00:00.000Z", now, "UTC")).toBe("Tue 18:00");
  });

  it("names the DAY past a week — a bare weekday would be ambiguous about which one", () => {
    expect(scheduleLabel("2026-09-12T18:00:00.000Z", now, "UTC")).toBe("12 Sep, 18:00");
  });

  it("echoes anything that is not an instant, exactly as the reference does", () => {
    expect(scheduleLabel("later", now, "UTC")).toBe("later");
  });
});

describe("the picker's rows can never name a moment already gone", () => {
  // Mid-morning, so today's 08:00 and 09:00 are behind and the afternoon hours are ahead.
  // Built with the LOCAL constructor on purpose: the picker's arithmetic is `Date`'s local
  // setters (09:00 means 09:00 where the reader is), so a UTC literal would make these
  // expectations depend on the runner's zone rather than on the rule.
  const openedAt = new Date(2026, 7, 30, 10, 17, 0, 0);

  it("today offers only the hours still ahead of the lead", () => {
    expect(usableHours(openedAt, 0)).toEqual([12, 15, 18, 21]);
  });

  it("every later day offers the whole vocabulary", () => {
    expect(usableHours(openedAt, 1)).toEqual([...SEND_LATER_HOURS]);
    expect(usableHours(openedAt, 90)).toEqual([...SEND_LATER_HOURS]);
  });

  it("an hour inside the lead is refused — the boundary, not just the far side", () => {
    // 12:00 local on the picker's own day, opened one minute before it.
    const noon = dayAtHour(openedAt, 0, 12).instant;
    const justBefore = new Date(noon.getTime() - 60 * 1000);
    expect(usableHours(justBefore, 0)).not.toContain(12);
    const wellBefore = new Date(noon.getTime() - 10 * 60 * 1000);
    expect(usableHours(wellBefore, 0)).toContain(12);
  });

  it("EVERY row the days and hours steps can draw is in the future", () => {
    for (const offset of DAY_OFFSETS) {
      for (const hour of usableHours(openedAt, offset)) {
        expect(dayAtHour(openedAt, offset, hour).instant.getTime() - openedAt.getTime())
          .toBeGreaterThanOrEqual(SEND_LATER_MIN_LEAD_MS);
      }
    }
  });

  it("the day span is the resurface chooser's quarter ahead, today included", () => {
    expect(DAY_OFFSETS[0]).toBe(0);
    expect(DAY_OFFSETS[DAY_OFFSETS.length - 1]).toBe(90);
  });

  it("a day with no usable hour left is not a day the picker offers", () => {
    // Past the last offered hour: today has nothing to give, tomorrow has everything.
    const lateTonight = new Date(2026, 7, 30, 22, 30, 0, 0);
    expect(usableHours(lateTonight, 0)).toEqual([]);
    expect(usableHours(lateTonight, 1)).toEqual([...SEND_LATER_HOURS]);
  });
});

describe("the evening preset is offered only while it is meaningfully ahead", () => {
  it("18:00 today, in the reader's own clock", () => {
    const at = todayEvening(new Date(2026, 7, 30, 9, 0, 0, 0));
    expect(at.hour).toBe(18);
    expect(at.minute).toBe(0);
    // Read back off the instant, and exact: no zone in the tz database moves its clocks at dinner.
    expect(at.verdict).toBe("exact");
    expect(at.instant.getHours()).toBe(18);
  });

  it("inside the lead it is in the past by the picker's own test", () => {
    const late = new Date(todayEvening(new Date()).instant);
    late.setHours(18, 0, 0, 0);
    const openedAt = new Date(late.getTime() - 60 * 1000);
    expect(late.getTime() - openedAt.getTime() > SEND_LATER_MIN_LEAD_MS).toBe(false);
  });
});

/* ── the surfaces, pinned to their source ───────────────────────────────────────────────── */

const at = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(at(p), "utf8");
const en = JSON.parse(read("../../webapp/messages/en.json")) as {
  compose: Record<string, string>;
  drafts: Record<string, string>;
};

describe("the Send-later strings are the webapp catalogue's, word for word", () => {
  it("the composer's", () => {
    expect(Copy.sendLater).toBe(en.compose.sendLater);
    expect(Copy.sendLaterWhat).toBe(en.compose.sendLaterWhat);
    expect(Copy.sendLaterTonight("Fri 18:00")).toBe(en.compose.sendLaterTonight!.replace("{when}", "Fri 18:00"));
    expect(Copy.sendLaterTomorrow("Sat 09:00")).toBe(en.compose.sendLaterTomorrow!.replace("{when}", "Sat 09:00"));
    expect(Copy.sendLaterMonday("Mon 09:00")).toBe(en.compose.sendLaterMonday!.replace("{when}", "Mon 09:00"));
    expect(Copy.sendLaterPick).toBe(en.compose.sendLaterPick);
    expect(Copy.sendLaterClose).toBe(en.compose.sendLaterClose);
    expect(Copy.sendLaterPast).toBe(en.compose.sendLaterPast);
    expect(Copy.sendLaterZone("Europe/Zurich")).toBe(en.compose.sendLaterZone!.replace("{zone}", "Europe/Zurich"));
    expect(Copy.sendLaterUnavailable).toBe(en.compose.sendLaterUnavailable);
    expect(Copy.scheduledFor("Fri 18:00")).toBe(en.compose.toastScheduled!.replace("{when}", "Fri 18:00"));
  });

  it("the Scheduled surface's", () => {
    expect(Copy.scheduled).toBe(en.drafts.scheduledTitle);
    expect(Copy.scheduledWhen("Fri 18:00")).toBe(en.drafts.scheduledWhen!.replace("{when}", "Fri 18:00"));
    expect(Copy.scheduledCancel).toBe(en.drafts.scheduledCancel);
    expect(Copy.scheduledNoSubject).toBe(en.drafts.noSubject);
    expect(Copy.scheduledNoRecipient).toBe(en.drafts.noRecipient);
    expect(Copy.scheduleFailedNote("nope")).toBe(en.drafts.scheduleFailedNote!.replace("{reason}", "nope"));
    expect(Copy.scheduleCancelled).toBe(en.drafts.scheduleCancelled);
    expect(Copy.scheduleCancelTooLate).toBe(en.drafts.scheduleCancelTooLate);
    expect(Copy.scheduleCancelQueued).toBe(en.drafts.scheduleCancelQueued);
  });
});

describe("the composer's affordance and the Scheduled screen — the shapes that carry the rules", () => {
  const actions = read("../src/ui/MessageActions.tsx");
  const screen = read("../app/scheduled.tsx");
  const more = read("../app/(tabs)/more.tsx") +
    /* The rows moved into the shared MoreNav (the big-screen drawer mounts the same list, so
       the two cannot drift) — the More screen's properties live in the pair. */
    read("../src/ui/MoreNav.tsx");

  it("a FORWARD is never offered Send later — a draft row cannot hold the forward reference", () => {
    /* RE-DERIVED, not relaxed. The rule is unchanged; its MECHANISM moved. The affordance gained a
       second reason to be withheld — a phone that organizes its own mailbox keeps no appointments —
       so the condition is one predicate over both (`sendLaterOffered`) instead of a bare `!forward`
       in the markup. The forward half is driven directly in
       `test/send-later-not-on-this-phone.test.ts`; what is asserted HERE is that the markup asks
       that predicate, which is what makes the forward rule reach the button at all. */
    expect(actions).toMatch(/const laterOffered = sendLaterOffered\(\{ standalone: w\.standalone, forward, hasAttachments: attachments\.length > 0 \}\)/);
    expect(actions).toMatch(/\{laterOffered \? \(\s*<Button\s*label=\{Copy\.sendLater\}/);
  });

  it("Send later rides the SAME lock as Send — one predicate owns both buttons", () => {
    expect(actions).toMatch(/disabled=\{!canSend\}\s*\n\s*onPress=\{openLater\}/);
    /* Send's press gained a third arm with the attachments slice: a message that lacks ONLY
       content stays pressable and the press SAYS so (`setNeedNote`) — it dials nothing, so the
       one-predicate lock on dispatch is intact and `canSend` still guards the only `send()`. */
    /* RE-DERIVED: the press reads one act (`sendPressAct`); `send` goes out from its `send` arm
       alone, which only `canSend` yields — the unconfirmed-send arm answers with a sentence. */
    expect(actions).toMatch(/const pressAct = sendPressAct\(\{ canSend, contentOnlyMissing, phase \}\)/);
    expect(actions).toMatch(/if \(act === "send"\) void send\(null, andDone\);/);
    expect(actions).toMatch(/disabled=\{pressAct === "none"\}/);
    expect(actions.match(/void send\(null, andDone\)/g), "a second dispatch site would be a second lock to drift").toHaveLength(1);
  });

  it("the press re-checks the frozen presets against the REAL clock before the wire", () => {
    expect(actions).toMatch(/at\.getTime\(\) - Date\.now\(\) < SEND_LATER_MIN_LEAD_MS/);
    expect(actions).toMatch(/setPastNote\(true\)/);
  });

  it("the panel yields height to the picker rather than growing past the viewport", () => {
    // The signature block's own ceiling exists because an unbounded control here buries Send
    // under the keyboard. The picker is a taller control than the block; while it is open the
    // writing area keeps its first line and the block steps aside, and a single Back restores
    // both. What SHIPS is untouched — the assertion below is the one that matters.
    expect(actions).toContain("minHeight: composeBodyMin(later !== null, heightClass),");
    expect(composeBodyMin(true, "medium"), "the picker open leaves the writing area one line").toBe(44);
    expect(actions).toMatch(/\{sigText !== null && later === null \? \(/);
    // `sigText` is derived ABOVE the picker state and handed to `send` regardless of it, so a
    // signature hidden while a time is chosen is still sealed into the scheduled message.
    expect(actions).toMatch(/const sigText =\s*w\.signatures === null \|\| mailboxId === null \? null : effectiveSignature\(/);
    expect(actions).toMatch(/sendReply\(m!\.id, body, mode === "replyAll", sigText, sendAt, files, andDone, draftId\)/);
  });

  it("the Scheduled screen never claims emptiness over an unsettled mirror", () => {
    expect(screen).toMatch(/rows\.length === 0 && !settled \? \(/);
    expect(screen).toMatch(/Copy\.scheduledEmpty/);
  });

  it("the More row is present while the mirror is unsettled — unknown is not empty", () => {
    expect(more).toMatch(/!w\.boot\.settled \|\| w\.scheduled\.length > 0 \? \(/);
  });

  it("one press is one delivery — the picker cannot dispatch a second send", () => {
    // The Send button locks on `phase`; the picker's rows are their own dispatch site, so
    // without both of these a reader can press Send and then tap a preset while the first
    // request is still out, minting a second Idempotency-Key.
    expect(actions).toMatch(/if \(phase !== "idle"\) \{\s*setLater\(null\);\s*return;\s*\}/);
    // …and any dispatch closes the panel, so no stale picker stands over a message in flight.
    expect(actions).toMatch(/const send = async \(sendAt: string \| null = null, andDone = false\) => \{[\s\S]{0,400}?setLater\(null\);\s*setPhase\("sending"\);/);
  });

  it("a background-confirmed appointment is announced as one, not as a delivery", () => {
    /* The flush's sentence is chosen from `o.sendAt` and announces the appointment, for every kind. */
    const at = "2030-01-02T09:00:00Z";
    const now = new Date("2030-01-01T09:00:00Z");
    for (const kind of [{ forward: false, fresh: false }, { forward: false, fresh: true }, { forward: true, fresh: false }]) {
      expect(sayArg(confirmedSendSay({ ...kind, sendAt: at, earlierWent: false }, now, "UTC")))
        .toBe(Copy.scheduledFor(scheduleLabel(at, now, "UTC")));
    }
  });

  it("a failed appointment shows what happened and offers no cancel", () => {
    expect(screen).toMatch(/\{row\.cancellable \? \(/);
    expect(screen).toMatch(/!row\.cancellable \? Copy\.scheduledNotSent/);
    // …and the foot note about cancelling only stands while something can be cancelled.
    expect(screen).toMatch(/rows\.some\(\(r\) => r\.cancellable\) \? \(/);
  });

  it("the cancel is the row's one verb, and it locks while its own dispatch is in flight", () => {
    expect(screen).toMatch(/label=\{Copy\.scheduledCancel\}/);
    expect(screen).toMatch(/disabled=\{asking\}/);
    expect(screen).toMatch(/cancelSchedule\(row\.id\)\.finally\(\(\) => setAsking\(false\)\)/);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────────────────
   THE TWO NIGHTS A YEAR — the phone's half of the one composition.

   `todayEvening` and `dayAtHour` wrote the hour with `Date`'s local setters, which answer a
   skipped or a repeated wall clock without saying which rule they applied, and counted the day
   in the PROCESS's zone rather than the reader's. Every row below is the answer the shared
   table at `test/support/wall-clock-days.ts` holds — the SAME file the webapp's
   `resurface-dst` suite asserts against, so a surface that composes its own arithmetic fails
   here rather than in a sibling test nobody runs in the same pass.
   ───────────────────────────────────────────────────────────────────────────────────────── */

describe("send later composes the wall clock the webapp composes", () => {
  const Z = WALL_CLOCK_ZONE;
  /** Three calendar days before the case, so the offset path is the one the picker walks. */
  const baseFor = (iso: string): Date => new Date(Date.parse(iso) - 3 * 86_400_000);

  it("answers the shared table on every case", () => {
    for (const c of WALL_CLOCK_CASES) {
      const from = baseFor(c.iso);
      const ahead = daysAhead(from, c);
      /* THE RESURFACE DOOR takes the whole clock, so it answers every row; `dayAtHour` takes
         whole hours only, which is what the send-later list offers, so it answers the rows
         whose minute is zero. Both are the same composition, and the table says so once. */
      const picked = dayAt(from, ahead, askedTime(c), Z);
      expect(picked.at.toISOString(), c.name).toBe(c.iso);
      expect(picked.time, c.name).toBe(c.time);
      expect(picked.verdict, c.name).toBe(c.verdict);
      if (c.minute !== 0) continue;
      const sendAt = dayAtHour(from, ahead, c.hour, Z);
      expect(sendAt.instant.toISOString(), c.name).toBe(c.iso);
      expect(sendAt.verdict, c.name).toBe(c.verdict);
      expect(`${String(sendAt.hour).padStart(2, "0")}:${String(sendAt.minute).padStart(2, "0")}`, c.name)
        .toBe(c.time);
    }
  });

  it("a send-later hour the clocks skip carries its verdict", () => {
    // 02:00 on 28 March 2027 does not exist in Zurich. `setHours(2)` answered 03:00 and said
    // nothing; the composition answers the same instant and states WHY it is not the asked hour.
    const at = dayAtHour(new Date("2027-03-25T09:00:00.000Z"), 3, 2, Z);
    expect(at.instant.toISOString()).toBe("2027-03-28T01:00:00.000Z");
    expect(at.hour).toBe(3);
    expect(at.verdict).toBe("shifted_forward");
  });

  it("a send-later hour that happens twice takes the first of the two", () => {
    const at = dayAtHour(new Date("2026-10-22T09:00:00.000Z"), 3, 2, Z);
    expect(at.instant.toISOString()).toBe("2026-10-25T00:00:00.000Z");
    expect(at.verdict).toBe("first_of_two");
  });

  it("the evening preset is a composition too, verdict and all", () => {
    const evening = todayEvening(new Date("2027-03-27T09:00:00.000Z"), Z);
    expect(evening.instant.toISOString()).toBe("2027-03-27T17:00:00.000Z");
    expect(evening.hour).toBe(18);
    // Exact because no zone in the tz database moves its clocks at dinner — stated, not assumed.
    expect(evening.verdict).toBe("exact");
  });

  it("the hours the picker actually offers are all exact, on both nights", () => {
    // The rows on screen today cannot reach a transition, and that is a MEASUREMENT, not a
    // premise: the arms above hold whatever `SEND_LATER_HOURS` becomes.
    for (const [from, ahead] of [
      [new Date("2027-03-25T09:00:00.000Z"), 3], [new Date("2026-10-22T09:00:00.000Z"), 3],
    ] as const) {
      for (const hour of usableHours(from, ahead, Z)) {
        expect(dayAtHour(from, ahead, hour, Z).verdict, `hour ${hour}`).toBe("exact");
      }
    }
  });
});
