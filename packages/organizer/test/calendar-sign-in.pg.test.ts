/**
 * THE CALENDAR'S SEALED SIGN-IN, ON A REAL POSTGRES: opened for one turn after both gates, traded
 * once a turn for a short one, and Microsoft's new lasting sign-in sealed again before the short one
 * reaches a reader, only where the stored one is still the one traded with. A stop is written only
 * where the stored sign-in is still the turn's, and nothing asks again after it.
 *
 * Microsoft's token address is a double behind the provider's own request port; every value is
 * invented.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Secret, type StoredCredential } from "@ohmail/cal-providers";
import { StaticKeyProvider } from "@trafficflow/core";
import { calendarSyncPass } from "../src/calendar/sync-pass.js";
import { CalendarKeyRingFault } from "../src/calendar/sign-in.js";
import {
  AVAILABLE, connectionOf, depsFor, eventsOf, openWorld, openedCredential, providersOf, scriptedReader, sealCredential, seedConnection,
  silentHttp, single, tokenEndpoint, upsert, type World,
} from "./_calendar-world.js";

const never = new AbortController().signal;
const lasting = (name: string): Secret => new Secret(["lasting", name, "fixture"].join("-"));
const microsoft = (name: string): StoredCredential => ({ kind: "oauth", provider: "microsoft", refreshToken: lasting(name) });
const MS_REGISTRATION = { clientId: "calendar-test-client", clientSecret: ["ms", "registration", "fixture"].join("-"), defaultTenant: "common", kind: "confidential" as const };
const GOOGLE_REGISTRATION = { clientId: "calendar-test.apps.example", clientSecret: ["registration", "fixture"].join("-") };
const ONE_PAGE = new Map([["", [{ items: [upsert("m1", "v1", single("m1@x.test", 17))] }]]]);

describe.skipIf(!AVAILABLE)("the calendar's sealed sign-in", () => {
  let w: World;
  beforeAll(async () => { w = await openWorld(); }, 120_000);
  afterAll(async () => { await w?.close(); });
  afterEach(() => { vi.restoreAllMocks(); });

  /** A Microsoft connection whose token address answers by `answer`, and whose reader asks its bearer. */
  async function msWorld(answer: Parameters<typeof tokenEndpoint>[0], name = "first", sent?: () => Promise<void>) {
    const seeded = await seedConnection(w, { provider: "microsoft", credential: microsoft(name) });
    const seen: string[] = [];
    const http = tokenEndpoint(answer);
    const reader = scriptedReader("microsoft", { readings: ONE_PAGE, bearer: { seen, ...(sent ? { sent } : {}) } });
    const deps = depsFor(w, providersOf({ microsoft: { reader, http } }), {
      oauth: { google: null, microsoft: async () => MS_REGISTRATION },
    });
    return { ...seeded, seen, http, reader, deps };
  }

  it("Microsoft: one trade a turn, the calendar's permission only, over the provider's own port; the new lasting sign-in is sealed before Graph is first asked", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const storedWhenSent: (string | null)[] = [];
    let t!: Awaited<ReturnType<typeof msWorld>>;
    t = await msWorld(
      async () => ({ status: 200, body: { access_token: "short-one", expires_in: 3600, refresh_token: ["lasting", "rotated", "fixture"].join("-") } }),
      "first",
      async () => { storedWhenSent.push(await openedCredential(w, t.accountId, t.connectionId)); },
    );
    expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced" });
    expect(t.http.forms.length).toBe(1);
    const { url, form, headers } = t.http.forms[0]!;
    expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    expect(form.get("scope")).toBe("Calendars.ReadWrite offline_access");
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(headers).toEqual({ "content-type": "application/x-www-form-urlencoded", accept: "application/json" });
    expect(t.seen).toEqual(["short-one", "short-one"]);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The stored sign-in held the rotated one when Graph was first asked, and every time after.
    expect(storedWhenSent.map((text) => JSON.parse(text ?? "{}").refreshToken)).toEqual([0, 1].map(() => ["lasting", "rotated", "fixture"].join("-")));
  }, 60_000);

  it("Microsoft: a lasting sign-in found on another connection's row is traded with nobody; one a turn sealed again is still its own row's", async () => {
    const rotated = ["lasting", "rotated", "fixture"].join("-");
    const traded: (string | null)[] = [];
    const holder = await msWorld(async (form) => {
      traded.push(form.get("refresh_token"));
      return { status: 200, body: { access_token: "short", expires_in: 3600, refresh_token: rotated } };
    }, "holder");
    const other = await msWorld(async () => ({ status: 200, body: { access_token: "short", expires_in: 3600 } }), "other");
    // The first connection's sealed row written over the other's, by whoever can write rows and holds no key.
    const moved = await w.sql`update cal_credentials t set secret_enc = s.secret_enc, key_version = s.key_version
      from cal_credentials s where s.connection_id = ${holder.connectionId} and t.connection_id = ${other.connectionId} returning t.connection_id`;
    expect(moved.length).toBe(1);
    expect(await calendarSyncPass(other.deps, other.due, never)).toEqual({ kind: "stopped", word: "sign_in_incomplete" });
    expect([other.http.forms.length, other.seen]).toEqual([0, []]);
    expect(await connectionOf(w, other.accountId, other.connectionId)).toMatchObject({ status: "reconnect", errorCode: "sign_in_incomplete" });
    // On its own row it is traded, the new one sealed there, and the next turn opens and trades that one.
    expect(await calendarSyncPass(holder.deps, holder.due, never)).toMatchObject({ kind: "synced" });
    await w.sql`update cal_calendars set next_poll_at = null where connection_id = ${holder.connectionId}`;
    expect(await calendarSyncPass(depsFor(w, providersOf({ microsoft: { reader: holder.reader, http: holder.http } }), {
      oauth: { google: null, microsoft: async () => MS_REGISTRATION },
    }), holder.due, never)).toMatchObject({ kind: "synced" });
    expect(traded).toEqual([lasting("holder").reveal(), rotated]);
  }, 60_000);

  it("Microsoft: a turn cut between the trade and its seal leaves the stored sign-in, which the next turn trades; a spent one stops for the person and asks nothing more", async () => {
    let n = 0;
    const t = await msWorld(async (form) => {
      n += 1;
      expect(form.get("refresh_token")).toBe(lasting("first").reveal());
      return n === 1
        ? { status: 200, body: { access_token: "short", expires_in: 3600, refresh_token: ["lasting", "lost", "fixture"].join("-") } }
        : { status: 400, body: { error: "invalid_grant" } };
    });
    // The answer arrived and the worker died before its seal: the new envelope is never made.
    const dying = Object.assign(Object.create(Object.getPrototypeOf(w.keys)), w.keys, {
      encrypt: async () => { throw new Error("the worker died here"); },
    }) as typeof w.keys;
    await expect(calendarSyncPass({ ...t.deps, keys: dying }, t.due, never)).rejects.toThrow();
    expect(JSON.parse((await openedCredential(w, t.accountId, t.connectionId)) ?? "{}").refreshToken).toBe(lasting("first").reveal());
    expect(await calendarSyncPass(t.deps, t.due, never)).toEqual({ kind: "stopped", word: "consent_needed" });
    expect(await connectionOf(w, t.accountId, t.connectionId)).toMatchObject({ status: "reconnect", errorCode: "consent_needed" });
    for (let i = 0; i < 3; i++) expect(await calendarSyncPass(t.deps, t.due, never)).toEqual({ kind: "gone" });
    expect(t.http.forms.length).toBe(2);
  }, 60_000);

  it("Microsoft: two turns that traded at once: the first seal stands, the second writes nothing and the connection stays active", async () => {
    let n = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => { release = r; });
    const t = await msWorld(async () => {
      n += 1;
      const mine = n;
      if (n === 2) release();
      await both;
      return { status: 200, body: { access_token: `short-${mine}`, expires_in: 3600, refresh_token: ["lasting", `turn${mine}`, "fixture"].join("-") } };
    });
    const other = depsFor(w, providersOf({ microsoft: { reader: t.reader, http: t.http } }), { oauth: { google: null, microsoft: async () => MS_REGISTRATION } });
    const outcomes = await Promise.all([calendarSyncPass(t.deps, t.due, never), calendarSyncPass(other, t.due, never)]);
    expect(outcomes.map((o) => o.kind).sort()).toEqual(["superseded", "synced"]);
    const stored = JSON.parse((await openedCredential(w, t.accountId, t.connectionId)) ?? "{}").refreshToken;
    expect([["lasting", "turn1", "fixture"].join("-"), ["lasting", "turn2", "fixture"].join("-")]).toContain(stored);
    expect((await connectionOf(w, t.accountId, t.connectionId)).status).toBe("active");
  }, 60_000);

  it("Microsoft: a person who reconnects during the trade keeps the new sign-in; the turn's rotated one is not written over it", async () => {
    let t!: Awaited<ReturnType<typeof msWorld>>;
    t = await msWorld(async () => {
      await sealCredential(w, t.accountId, t.connectionId, microsoft("reconnected"), null);
      return { status: 200, body: { access_token: "short", expires_in: 3600, refresh_token: ["lasting", "rotated", "fixture"].join("-") } };
    });
    expect(await calendarSyncPass(t.deps, t.due, never)).toEqual({ kind: "superseded" });
    expect(JSON.parse((await openedCredential(w, t.accountId, t.connectionId)) ?? "{}").refreshToken).toBe(lasting("reconnected").reveal());
    expect(await eventsOf(w, t.accountId)).toEqual([]);
  }, 60_000);

  it("Microsoft: a key re-wrap during the trade is the same sign-in, and the rotated one still lands", async () => {
    let t!: Awaited<ReturnType<typeof msWorld>>;
    t = await msWorld(async () => {
      // The same lasting sign-in, sealed again under the ring's newer key: another envelope, the same token.
      await sealCredential(w, t.accountId, t.connectionId, microsoft("first"), null, new StaticKeyProvider({ 1: Buffer.alloc(32, 11), 2: Buffer.alloc(32, 12) }));
      return { status: 200, body: { access_token: "short", expires_in: 3600, refresh_token: ["lasting", "rotated", "fixture"].join("-") } };
    });
    expect(await calendarSyncPass(t.deps, t.due, never)).toMatchObject({ kind: "synced" });
    expect(JSON.parse((await openedCredential(w, t.accountId, t.connectionId)) ?? "{}").refreshToken).toBe(["lasting", "rotated", "fixture"].join("-"));
  }, 60_000);

  it("Microsoft: this deployment's own registration refused is a wait, never the person's sign-in; a missing registration asks nobody", async () => {
    const refused = await msWorld(async () => ({ status: 401, body: { error: "invalid_client" } }));
    expect(await calendarSyncPass(refused.deps, refused.due, never)).toMatchObject({ kind: "backed_off", word: "unavailable" });
    expect((await connectionOf(w, refused.accountId, refused.connectionId)).status).toBe("active");

    const missing = await msWorld(async () => ({ status: 200, body: {} }));
    const deps = { ...missing.deps, oauth: { google: null, microsoft: async () => ({ ...MS_REGISTRATION, clientSecret: "" }) } };
    expect(await calendarSyncPass(deps, missing.due, never)).toEqual({ kind: "off", why: "provider_off" });
    expect(missing.http.forms).toEqual([]);
  }, 60_000);

  it("Google: a refused sign-in at the calendar stops for the person, and ten more turns ask nothing", async () => {
    const seeded = await seedConnection(w, { provider: "google", credential: { kind: "oauth", provider: "google", refreshToken: lasting("google") } });
    const reader = scriptedReader("google", { readings: new Map([["", [{ refuse: { ok: false, reason: "sign_in_refused", retryAfterMs: null } }]]]) });
    const http = silentHttp();
    const deps = depsFor(w, providersOf({ google: { reader, http } }), { oauth: { google: GOOGLE_REGISTRATION, microsoft: null } });
    expect(await calendarSyncPass(deps, seeded.due, never)).toEqual({ kind: "stopped", word: "sign_in_refused" });
    expect(await connectionOf(w, seeded.accountId, seeded.connectionId)).toMatchObject({ status: "reconnect", errorCode: "sign_in_refused" });
    const asked = reader.calls.length + reader.lists;
    for (let i = 0; i < 10; i++) expect(await calendarSyncPass(deps, seeded.due, never)).toEqual({ kind: "gone" });
    expect(reader.calls.length + reader.lists).toBe(asked);
    expect(http.asked).toBe(0);
  }, 60_000);

  it("Google: the registration refused at the trade is a wait that reads failing from the third, never a stop", async () => {
    const seeded = await seedConnection(w, { provider: "google", credential: { kind: "oauth", provider: "google", refreshToken: lasting("google2") } });
    const http = tokenEndpoint(async () => ({ status: 401, body: { error: "invalid_client" } }));
    const reader = scriptedReader("google", { readings: ONE_PAGE, bearer: { seen: [] } });
    const deps = depsFor(w, providersOf({ google: { reader, http } }), { oauth: { google: GOOGLE_REGISTRATION, microsoft: null } });
    const kinds: string[] = [];
    for (let i = 0; i < 3; i++) kinds.push((await calendarSyncPass(deps, seeded.due, never)).kind);
    expect(kinds).toEqual(["backed_off", "backed_off", "backed_off"]);
    expect(await connectionOf(w, seeded.accountId, seeded.connectionId)).toMatchObject({ status: "failing", errorCode: "sign_in_refused" });
    // One trade a turn: the stop is kept for the rest of the turn.
    expect(http.forms.length).toBe(3);
  }, 60_000);

  it("a connection with no sealed sign-in, or one of another kind, waits for the person and asks nobody", async () => {
    const none = await seedConnection(w, { provider: "caldav", credential: null, serverUrl: "https://dav.example.test/dav/" });
    const reader = scriptedReader("caldav", { readings: ONE_PAGE });
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }));
    expect(await calendarSyncPass(deps, none.due, never)).toEqual({ kind: "stopped", word: "sign_in_incomplete" });
    expect(await connectionOf(w, none.accountId, none.connectionId)).toMatchObject({ status: "reconnect", errorCode: "sign_in_incomplete" });
    const wrong = await seedConnection(w, { provider: "caldav", credential: { kind: "address", url: new Secret("https://feeds.example.test/b.ics") } });
    expect(await calendarSyncPass(deps, wrong.due, never)).toEqual({ kind: "stopped", word: "sign_in_incomplete" });
    expect({ reads: reader.calls.length, lists: reader.lists }).toEqual({ reads: 0, lists: 0 });
  }, 60_000);

  it("a server's sign-in sealed for another server than its connection's row names is no sign-in: it waits for the person and nobody is asked; a turn is handed the sealed text's server", async () => {
    const SEALED_FOR = "https://dav.example.test/dav/";
    const typed = { kind: "basic" as const, server: SEALED_FOR, user: "mila", password: new Secret(["kiln", "wheel"].join("-")) };
    const reader = scriptedReader("caldav", { readings: ONE_PAGE });
    /** The server every request of a turn was handed, as the reader got it. */
    const handed: (string | null)[] = [];
    const list = reader.listCalendars.bind(reader);
    reader.listCalendars = async (c, signal) => { handed.push(c.start); return list(c, signal); };
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }));
    // The row's server written by somebody who holds no key: to another host, to another path of the same host, to none.
    for (const serverUrl of ["https://dav.elsewhere.example.net/dav/", `${SEALED_FOR}other/`, null]) {
      const moved = await seedConnection(w, { provider: "caldav", credential: typed, serverUrl });
      expect(await calendarSyncPass(deps, moved.due, never), String(serverUrl)).toEqual({ kind: "stopped", word: "sign_in_incomplete" });
      expect(await connectionOf(w, moved.accountId, moved.connectionId)).toMatchObject({ status: "reconnect", errorCode: "sign_in_incomplete" });
    }
    expect({ reads: reader.calls.length, lists: reader.lists, handed }).toEqual({ reads: 0, lists: 0, handed: [] });
    // The control: on the row it was sealed for it opens, and the reader is handed the server the text names.
    const own = await seedConnection(w, { provider: "caldav", credential: typed, serverUrl: SEALED_FOR });
    expect((await calendarSyncPass(deps, own.due, never)).kind).toBe("synced");
    expect({ lists: reader.lists, handed }).toEqual({ lists: 1, handed: [SEALED_FOR] });
  }, 60_000);

  it("a sealed sign-in this host's keys cannot open is the host's fault: nothing is written and nobody is asked", async () => {
    const seeded = await seedConnection(w, { provider: "caldav", credential: null, serverUrl: "https://dav.example.test/dav/" });
    await sealCredential(w, seeded.accountId, seeded.connectionId, { kind: "basic", server: "https://dav.example.test/dav/", user: "mila", password: new Secret(["other", "ring"].join("-")) }, null,
      new StaticKeyProvider({ 1: Buffer.alloc(32, 99) }));
    const reader = scriptedReader("caldav", { readings: ONE_PAGE });
    const deps = depsFor(w, providersOf({ caldav: { reader, http: silentHttp() } }));
    const before = await connectionOf(w, seeded.accountId, seeded.connectionId);
    await expect(calendarSyncPass(deps, seeded.due, never)).rejects.toBeInstanceOf(CalendarKeyRingFault);
    expect(await connectionOf(w, seeded.accountId, seeded.connectionId)).toEqual(before);
    expect({ reads: reader.calls.length, lists: reader.lists }).toEqual({ reads: 0, lists: 0 });
  }, 60_000);
});
