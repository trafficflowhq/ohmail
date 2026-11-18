import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { calendarRoutes } from "@trafficflow/api/calendar";
import { eq } from "drizzle-orm";
import { fencedAccountWrite, recordCalendarChanges } from "@trafficflow/db";
import { calCalendars, calConnections, calEvents, calSettings, calWrites } from "@trafficflow/db/mail";
import type { CalendarWriteAnswer, SyncResponse } from "@ohmail/wire";
import { calendarFeed } from "@trafficflow/services/calendar";
import { makeDeps, req, seedSession, FIXED_NOW } from "./helpers.js";

/**
 * THE SWITCH'S ROUTES AND THE WORD, through the composed pipeline: the seq a change answers and
 * none when nothing changed, an unverified account refused at the gate a `work` route carries, the
 * word on `/hello` only where the composition says it keeps a calendar, and the feed carrying a
 * calendar record exactly while the switch is on — what one composition does with the routes, the
 * port and the word together.
 */

const withCalendar = createApp([...apiRoutes, ...calendarRoutes]);
const withoutCalendar = createApp(apiRoutes);

async function rig(opts: { calendar: boolean; verified?: boolean }) {
  const { db, deps } = await makeDeps();
  // What a composition says of itself, the calendar's word read from the same member as the port.
  deps.hello = {
    flavor: "managed", needsSetup: false,
    auth: { password: true, totp: true, webauthn: true, publicSignup: false },
    features: {
      sse: false, staging: false, ai: false, pairing: false, remoteImages: true, scheduleFiles: false,
      ...(opts.calendar ? { calendar: true } : {}),
    },
  };
  if (opts.calendar) deps.services = { ...deps.services, calendar: calendarFeed } as never;
  const s = await seedSession(db, { now: FIXED_NOW, ...(opts.verified === false ? { emailVerified: false } : {}) });
  const app = opts.calendar ? withCalendar : withoutCalendar;
  const ask = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> => app.handle(
    req(method, path, {
      bearer: s.token, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      headers: { "x-requested-with": "ohmail", ...headers },
    }),
    { ...deps, session: null, idempotency: null } as ApiDeps,
  );
  return { db, deps, s, ask };
}

describe("PATCH /calendar/settings", () => {
  it("answers the seq of the settings change it made, and none for a request that changed nothing", async () => {
    const r = await rig({ calendar: true });
    const on = await r.ask("PATCH", "/calendar/settings", { enabled: true });
    expect(on.status).toBe(200);
    const seq = on.headers.get("x-sync-seq");
    expect(seq).toMatch(/^\d+$/);
    expect(await on.json()).toMatchObject({ enabledAt: FIXED_NOW.toISOString() });
    const again = await r.ask("PATCH", "/calendar/settings", { enabled: true });
    expect(again.status).toBe(200);
    expect(again.headers.get("x-sync-seq")).toBeNull();
    // The settings change it names is the one the feed carries, with the switch on it.
    const feed = await (await r.ask("GET", "/sync?since=0&types=settings")).json() as SyncResponse;
    const changes = [...feed.changes.creates, ...feed.changes.updates];
    expect(changes.map((c) => [c.type, String(c.seq)])).toEqual([["settings", seq]]);
    expect(changes[0]!.entity).toMatchObject({ calendarEnabledAt: FIXED_NOW.toISOString() });
    expect(await (await r.ask("GET", "/calendar/settings")).json()).toMatchObject({ enabledAt: FIXED_NOW.toISOString() });
  });

  it("is refused to an account whose address is not verified, and writes nothing", async () => {
    const r = await rig({ calendar: true, verified: false });
    const res = await r.ask("PATCH", "/calendar/settings", { enabled: true });
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("email_unverified");
    expect(await calendarFeed.enabledAt(r.db, r.s.accountId)).toBeNull();
  });

  it("is not a route where the composition keeps no calendar", async () => {
    const r = await rig({ calendar: false });
    expect((await r.ask("GET", "/calendar/settings")).status).toBe(404);
    expect((await r.ask("PATCH", "/calendar/settings", { enabled: true })).status).toBe(404);
  });
});

describe("GET /hello says the word only where the composition keeps a calendar", () => {
  it("absent, the answer is the one it always was; present, it says calendar", async () => {
    const off = await rig({ calendar: false });
    const offBody = await (await off.ask("GET", "/hello")).json() as { features: Record<string, unknown> };
    expect(Object.keys(offBody.features)).not.toContain("calendar");
    const on = await rig({ calendar: true });
    const onBody = await (await on.ask("GET", "/hello")).json() as { features: Record<string, unknown> };
    expect(onBody.features.calendar).toBe(true);
    const { calendar: _word, ...rest } = onBody.features;
    expect(rest).toEqual(offBody.features);
  });
});

describe("a calendar record leaves the server only with the word and the switch on", () => {
  /** A connection and a calendar on the account, and their changes through the one door. */
  async function planted(r: Awaited<ReturnType<typeof rig>>) {
    const connection = randomUUID();
    const calendar = randomUUID();
    await r.db.insert(calConnections).values({ id: connection, accountId: r.s.accountId, provider: "google", label: "Personal" });
    await r.db.insert(calCalendars).values({
      id: calendar, accountId: r.s.accountId, connectionId: connection, providerId: "primary", name: "Home", access: "owner",
    });
    await fencedAccountWrite(r.db as never, { accountId: r.s.accountId }, (tx) => recordCalendarChanges(tx as never, r.s.accountId, [
      { kind: "calendar_connection", id: connection, op: "create" }, { kind: "calendar", id: calendar, op: "create" },
    ]));
    return { connection, calendar };
  }
  const kinds = async (r: Awaited<ReturnType<typeof rig>>): Promise<string[]> => {
    const all = "message,thread,settings,calendar_connection,calendar,calendar_event,calendar_suggestion";
    const page = await (await r.ask("GET", `/sync?since=0&types=${all}`)).json() as SyncResponse;
    return [...page.changes.creates, ...page.changes.updates, ...page.changes.deletes].map((c) => c.type).sort();
  };

  it("word off: nothing of the calendar, whatever the account's own row says", async () => {
    const r = await rig({ calendar: false });
    await planted(r);
    await r.db.insert(calSettings).values({ accountId: r.s.accountId, enabledAt: FIXED_NOW });
    expect(await kinds(r)).toEqual([]);
  });

  it("word on, switch off: nothing; switched on: both records", async () => {
    const r = await rig({ calendar: true });
    await planted(r);
    expect(await kinds(r)).toEqual([]);
    expect((await r.ask("PATCH", "/calendar/settings", { enabled: true })).status).toBe(200);
    expect(await kinds(r)).toEqual(["calendar", "calendar_connection", "settings"]);
  });
});

describe("the calendar's write routes", () => {
  async function writable(r: Awaited<ReturnType<typeof rig>>) {
    const connection = randomUUID();
    const calendar = randomUUID();
    await r.db.insert(calConnections).values({ id: connection, accountId: r.s.accountId, provider: "google", label: "Personal" });
    await r.db.insert(calCalendars).values({ id: calendar, accountId: r.s.accountId, connectionId: connection, providerId: "primary", name: "Home", access: "owner" });
    await r.db.insert(calSettings).values({ accountId: r.s.accountId, enabledAt: FIXED_NOW });
    return { calendar };
  }
  const create = (calendarId: string, eventId = randomUUID()) => ({
    kind: "calendar_event_create", eventId, calendarId,
    event: {
      title: "Glaze firing", start: { kind: "instant", value: "20261117T090000Z" }, end: { kind: "instant", value: "20261117T100000Z" },
      notes: null, place: null, callLink: null, busy: true, private: false, repeat: null, invitees: [], alarms: [],
    },
  });

  it("records an act under its key, answers 202 with the write and the event's record, and calls no provider", async () => {
    const r = await rig({ calendar: true });
    const { calendar } = await writable(r);
    const fetched = vi.spyOn(globalThis, "fetch");
    try {
      const act = create(calendar);
      const res = await r.ask("POST", "/calendar/writes", act, { "idempotency-key": "press-route-1" });
      expect(res.status).toBe(202);
      expect(res.headers.get("x-sync-seq")).toMatch(/^\d+$/);
      const body = await res.json() as CalendarWriteAnswer;
      expect(body.write).toMatchObject({ key: "press-route-1", state: "pending", reason: null });
      expect(body.events.map((e) => [e.id, e.writes.map((w) => w.key)])).toEqual([[act.eventId, ["press-route-1"]]]);
      const again = await r.ask("POST", "/calendar/writes", act, { "idempotency-key": "press-route-1" });
      expect([again.status, (await again.json() as CalendarWriteAnswer).write?.id, again.headers.get("x-sync-seq")]).toEqual([202, body.write!.id, null]);
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
    expect((await r.db.select({ id: calWrites.id }).from(calWrites).where(eq(calWrites.accountId, r.s.accountId))).length).toBe(1);
  });

  it("asks for the key, and is refused to an unverified account and where the composition keeps no calendar", async () => {
    const r = await rig({ calendar: true });
    const { calendar } = await writable(r);
    const none = await r.ask("POST", "/calendar/writes", create(calendar));
    expect([none.status, (await none.json() as { error: { code: string } }).error.code]).toEqual([400, "idempotency_key_required"]);
    const unverified = await rig({ calendar: true, verified: false });
    const u = await writable(unverified);
    expect((await unverified.ask("POST", "/calendar/writes", create(u.calendar), { "idempotency-key": "k" })).status).toBe(403);
    const off = await rig({ calendar: false });
    expect((await off.ask("POST", "/calendar/writes", create(calendar), { "idempotency-key": "k" })).status).toBe(404);
    expect((await r.db.select({ id: calEvents.id }).from(calEvents).where(eq(calEvents.accountId, r.s.accountId))).length).toBe(0);
  });

  it("lets a write not tried yet go, and the new event with it", async () => {
    const r = await rig({ calendar: true });
    const { calendar } = await writable(r);
    const made = await (await r.ask("POST", "/calendar/writes", create(calendar), { "idempotency-key": "press-route-2" })).json() as CalendarWriteAnswer;
    const gone = await r.ask("DELETE", `/calendar/writes/${made.write!.id}`);
    expect([gone.status, await gone.json()]).toEqual([200, { write: null, events: [] }]);
    const retry = await r.ask("POST", `/calendar/writes/${made.write!.id}/retry`);
    expect(retry.status).toBe(404);
  });
});
