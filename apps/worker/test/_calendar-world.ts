/**
 * THE CALENDAR'S PASSES' TEST WORLD, on this checkout's own Postgres: an account with its calendar
 * switched on, a connection with a sealed sign-in, and the deps a turn is handed. The providers are
 * either the real ones over the bench's stand-ins (imported by path from `cal-providers`' tests,
 * never copied) or a scripted reader that hands out pages a test wrote, for the store's own rules.
 * Every value is invented; a seeded marker is planted where a test looks for it in a log.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, asc, eq, sql } from "drizzle-orm";
import { DEFAULT_LIMITS, intlZones, readCalendar, type CalEvent } from "@ohmail/cal-core";
import {
  serializeCredential, Secret,
  type Answer, type CalendarInfo, type CalendarProvider, type CalendarProviders, type CalendarReader, type ChangeItem,
  type ChangePage, type ChangeToken, type Connection, type HttpPort, type PageRequest, type ProviderWord, type StoredCredential,
} from "@ohmail/cal-providers";
import { StaticKeyProvider, createLogger, type Logger } from "@trafficflow/core";
import {
  accounts, calAlarms, calAttendees, calCalendars, calConnections, calCredentials, calEvents, calSettings, changeLog, mailboxes,
  type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import {
  calendarPool, newCalendarSyncMemory, type CalendarSyncDeps, type CalendarSyncMemory, type DueConnection,
} from "../src/calendar/index.js";

export const AVAILABLE = await realPgAvailable();
export const ZONES = intlZones();

/** Two key versions, so that a re-wrap and a seal under the newer one are both in reach. */
export function keyRing(): StaticKeyProvider {
  return new StaticKeyProvider({ 1: Buffer.alloc(32, 11), 2: Buffer.alloc(32, 12) });
}

export interface World {
  readonly db: Tx;
  readonly sql: ReturnType<typeof postgres>;
  readonly keys: StaticKeyProvider;
  close(): Promise<void>;
}

export async function openWorld(max = 4): Promise<World> {
  await runMigrations(PG_TEST_URL);
  const client = postgres(PG_TEST_URL, { max, onnotice: () => {} });
  const db = brandDialect(drizzle(client, { schema }), "pg") as unknown as Tx;
  return { db, sql: client, keys: keyRing(), close: () => client.end({ timeout: 5 }) };
}

export interface Seeded {
  readonly accountId: string;
  readonly connectionId: string;
  readonly due: DueConnection;
}

/** An account, its calendar on (or not), one connection of `provider`, and its sealed sign-in (or none). */
export async function seedConnection(w: World, o: {
  readonly provider: ProviderWord;
  readonly credential: StoredCredential | null;
  readonly calendarOn?: boolean;
  readonly serverUrl?: string | null;
  readonly principal?: string | null;
  readonly meta?: Record<string, unknown> | null;
  readonly mailboxAddress?: string;
}): Promise<Seeded> {
  const accountId = randomUUID();
  await w.db.insert(accounts).values({ id: accountId, name: `cal-${accountId.slice(0, 8)}` });
  if (o.calendarOn !== false) await w.db.insert(calSettings).values({ accountId, enabledAt: new Date() });
  if (o.mailboxAddress !== undefined) {
    await w.db.insert(mailboxes).values({ accountId, provider: "imap", address: o.mailboxAddress, status: "connected" });
  }
  const [conn] = await w.db.insert(calConnections).values({
    accountId, provider: o.provider, label: "", status: "active",
    serverUrl: o.serverUrl ?? null, principal: o.principal ?? null,
  }).returning({ id: calConnections.id });
  const connectionId = conn!.id;
  if (o.credential !== null) await sealCredential(w, accountId, connectionId, o.credential, o.meta ?? null);
  return { accountId, connectionId, due: { accountId, id: connectionId, provider: o.provider, status: "active" } };
}

/** The credential sealed as the store keeps it, replacing any of its kind. */
export async function sealCredential(
  w: World, accountId: string, connectionId: string, credential: StoredCredential, meta: Record<string, unknown> | null,
  keys: StaticKeyProvider = w.keys,
): Promise<void> {
  const text = serializeCredential(credential);
  if (text === null) throw new Error("the test's credential would not open again");
  const env = await keys.encrypt(text);
  await w.db.delete(calCredentials).where(and(eq(calCredentials.accountId, accountId), eq(calCredentials.connectionId, connectionId)));
  await w.db.insert(calCredentials).values({ accountId, connectionId, kind: credential.kind, secretEnc: env.ciphertext, keyVersion: env.keyVersion, meta });
}

/** The credential as stored now, opened. */
export async function openedCredential(w: World, accountId: string, connectionId: string): Promise<string | null> {
  const [row] = await w.db.select({ secretEnc: calCredentials.secretEnc, keyVersion: calCredentials.keyVersion }).from(calCredentials)
    .where(and(eq(calCredentials.accountId, accountId), eq(calCredentials.connectionId, connectionId))).limit(1);
  return row === undefined ? null : w.keys.decrypt(row.secretEnc, row.keyVersion);
}

/** A capturing logger: the real one, its lines kept. */
export function capturedLog(): { readonly log: Logger; readonly lines: string[] } {
  const lines: string[] = [];
  return { lines, log: createLogger({ service: "worker", level: "debug", sink: (line: string) => { lines.push(line); } }) };
}

/** A turn's deps over `providers`; everything else this world's. */
export function depsFor(w: World, providers: CalendarProviders, more: Partial<CalendarSyncDeps> = {}): CalendarSyncDeps & { memory: CalendarSyncMemory } {
  return {
    db: calendarPool(w.db),
    providers,
    keys: w.keys,
    clock: { now: () => Date.now() },
    zones: ZONES,
    random: () => 0.5,
    oauth: { google: null, microsoft: null },
    memory: newCalendarSyncMemory(),
    halted: () => false,
    log: capturedLog().log,
    ...more,
  } as CalendarSyncDeps & { memory: CalendarSyncMemory };
}

/** Providers that serve exactly these. */
export function providersOf(served: Partial<Record<ProviderWord, CalendarProvider>>): CalendarProviders {
  return { get: (word) => served[word] ?? null };
}

/** A request port that must never be asked: a test counts on its silence. */
export function silentHttp(): HttpPort & { asked: number } {
  const port = {
    asked: 0,
    async request() {
      port.asked += 1;
      return { arrived: false as const, reason: "connection_failed" as const };
    },
  };
  return port;
}

// ── a scripted provider ───────────────────────────────────────────────────────

/** An event as a calendar text, the calendar core's own reading of it. */
export function eventOf(lines: readonly string[]): CalEvent {
  const text = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ohmail//calendar sync test//EN", "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
  const read = readCalendar(text, DEFAULT_LIMITS);
  if (!read.ok || read.calendar.events.length !== 1) throw new Error("the test's event did not read");
  return read.calendar.events[0]!;
}

/** A single event at 09:00 UTC on a day of November 2026, an hour long. */
export function single(uid: string, day: number, summary = `Event ${uid}`, more: readonly string[] = []): CalEvent {
  const d = String(day).padStart(2, "0");
  return eventOf([`UID:${uid}`, "DTSTAMP:20261113T120000Z", `DTSTART:202611${d}T090000Z`, `DTEND:202611${d}T100000Z`, `SUMMARY:${summary}`, ...more]);
}

export const upsert = (id: string, version: string, event: CalEvent, text: string | null = null): ChangeItem =>
  ({ kind: "upsert", id, version, event, text });

export interface ScriptedPage extends Partial<ChangePage> {
  readonly items: readonly ChangeItem[];
}

/**
 * A reader that answers from a script: for each reading (by the token it starts from, `""` for
 * none) the pages in order, the cursor written by the reader itself. A refusal in the script is
 * answered as one. Every call is counted.
 */
export function scriptedReader(word: ProviderWord, script: {
  readonly calendars?: readonly CalendarInfo[];
  readonly readings: Map<string, readonly (ScriptedPage | { readonly refuse: Answer<never> & { ok: false } })[]>;
  readonly endToken?: (since: string | null) => string | null;
  /**
   * Ask the connection's bearer before every request, as Google's and Microsoft's readers do; `seen`
   * gets each short sign-in, and `sent` runs where the request would leave with it.
   */
  readonly bearer?: { readonly seen: string[]; readonly sent?: () => Promise<void> };
}): CalendarReader & { calls: { readonly since: string | null; readonly cursor: string | null }[]; lists: number } {
  const calls: { since: string | null; cursor: string | null }[] = [];
  const signedIn = async (c: Connection): Promise<(Answer<never> & { ok: false }) | null> => {
    if (script.bearer === undefined || c.credential.kind !== "bearer") return null;
    const a = await c.credential.accessToken(new AbortController().signal);
    if (!a.ok) return { ok: false, reason: a.reason, retryAfterMs: a.retryAfterMs };
    script.bearer.seen.push(a.token);
    await script.bearer.sent?.();
    return null;
  };
  const reader = {
    provider: word,
    calls,
    lists: 0,
    async checkSignIn(): Promise<Answer<{ principal: string | null; addresses: readonly string[] }>> {
      return { ok: true, value: { principal: null, addresses: [] } };
    },
    async listCalendars(c: Connection): Promise<Answer<readonly CalendarInfo[]>> {
      reader.lists += 1;
      const refused = await signedIn(c);
      if (refused !== null) return refused;
      return { ok: true, value: script.calendars ?? [{ id: "cal-1", name: "Studio", color: null, writable: true, byToken: true, zone: null }] };
    },
    async readChanges(c: Connection, _cal: { id: string }, since: ChangeToken | null, page: PageRequest): Promise<Answer<ChangePage>> {
      calls.push({ since: since?.value ?? null, cursor: page.cursor });
      const refused = await signedIn(c);
      if (refused !== null) return refused;
      const pages = script.readings.get(since?.value ?? "") ?? [];
      const at = page.cursor === null ? 0 : Number(page.cursor);
      const one = pages[at];
      if (one === undefined) return { ok: false, reason: "token_gone", retryAfterMs: null };
      if ("refuse" in one) return one.refuse;
      const last = at === pages.length - 1;
      const token = script.endToken === undefined ? `t${pages.length}` : script.endToken(since?.value ?? null);
      return {
        ok: true,
        value: {
          mode: since === null ? "whole" : "delta",
          unchanged: false,
          left: [],
          expanded: null,
          refreshMs: null,
          ...one,
          items: one.items,
          cursor: last ? { kind: "end", token: token === null ? null : { provider: word, value: token } } : { kind: "more", value: String(at + 1) },
        },
      };
    },
  };
  return reader;
}

// ── what the store holds ──────────────────────────────────────────────────────

export interface EventView {
  readonly providerId: string;
  readonly recurrenceId: string;
  readonly uid: string;
  readonly title: string;
  readonly versionTag: string | null;
  readonly excluded: readonly string[];
  readonly invitees: readonly string[];
}

/** The account's events as the store keeps them, in a stable order, without their row ids. */
export async function eventsOf(w: World, accountId: string): Promise<EventView[]> {
  const rows = await w.db.select({
    id: calEvents.id, providerId: calEvents.providerId, recurrenceId: calEvents.recurrenceId, uid: calEvents.uid,
    title: calEvents.title, versionTag: calEvents.versionTag, excluded: calEvents.excludedDates,
  }).from(calEvents).where(eq(calEvents.accountId, accountId)).orderBy(asc(calEvents.providerId), asc(calEvents.recurrenceId));
  const people = await w.db.select({ eventId: calAttendees.eventId, address: calAttendees.address }).from(calAttendees)
    .where(eq(calAttendees.accountId, accountId)).orderBy(asc(calAttendees.address));
  return rows.map((r) => ({
    providerId: r.providerId, recurrenceId: r.recurrenceId, uid: r.uid, title: r.title, versionTag: r.versionTag,
    excluded: (Array.isArray(r.excluded) ? (r.excluded as { value: string }[]) : []).map((t) => t.value).sort(),
    invitees: people.filter((p) => p.eventId === r.id).map((p) => p.address),
  }));
}

/** The calendar rows of an account. */
export async function calendarsOf(w: World, accountId: string) {
  return w.db.select({
    id: calCalendars.id, providerId: calCalendars.providerId, name: calCalendars.name, syncToken: calCalendars.syncToken,
    errorCode: calCalendars.errorCode, nextPollAt: calCalendars.nextPollAt, lastSyncedAt: calCalendars.lastSyncedAt,
    color: calCalendars.color, timeZone: calCalendars.timeZone,
  }).from(calCalendars).where(eq(calCalendars.accountId, accountId)).orderBy(asc(calCalendars.providerId));
}

/** The connection row of an account. */
export async function connectionOf(w: World, accountId: string, connectionId: string) {
  const [row] = await w.db.select({
    status: calConnections.status, errorCode: calConnections.errorCode, nextPollAt: calConnections.nextPollAt,
    lastSyncedAt: calConnections.lastSyncedAt,
  }).from(calConnections).where(and(eq(calConnections.accountId, accountId), eq(calConnections.id, connectionId)));
  return row!;
}

/** How many changes the account's log holds, by kind and op. */
export async function changesOf(w: World, accountId: string): Promise<Record<string, number>> {
  const rows = await w.db.select({ kind: changeLog.entityType, op: changeLog.op, n: sql<number>`count(*)::int` })
    .from(changeLog).where(eq(changeLog.accountId, accountId)).groupBy(changeLog.entityType, changeLog.op);
  return Object.fromEntries(rows.map((r) => [`${r.kind}:${r.op}`, Number(r.n)]));
}

/** Rows left in the event family's children for an account. */
export async function childrenOf(w: World, accountId: string): Promise<{ invitees: number; alarms: number }> {
  const [a] = await w.db.select({ n: sql<number>`count(*)::int` }).from(calAttendees).where(eq(calAttendees.accountId, accountId));
  const [b] = await w.db.select({ n: sql<number>`count(*)::int` }).from(calAlarms).where(eq(calAlarms.accountId, accountId));
  return { invitees: Number(a?.n ?? 0), alarms: Number(b?.n ?? 0) };
}

export { Secret };

/** A token address of a provider, answered by the test: every form it was sent, as the request port carried it. */
export function tokenEndpoint(answer: (form: URLSearchParams, url: string) => Promise<{ status: number; body: unknown }>):
  HttpPort & { readonly forms: { url: string; form: URLSearchParams; headers: Record<string, string> }[] } {
  const forms: { url: string; form: URLSearchParams; headers: Record<string, string> }[] = [];
  return {
    forms,
    async request(url, req) {
      const form = new URLSearchParams(req.body ?? "");
      forms.push({ url, form, headers: { ...req.headers } as Record<string, string> });
      const a = await answer(form, url);
      const bytes = new TextEncoder().encode(JSON.stringify(a.body));
      return { arrived: true, status: a.status, header: () => null, body: bytes, location: null, url, hops: 0 };
    },
  };
}
