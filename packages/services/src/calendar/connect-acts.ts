/**
 * WHAT A PERSON DOES WITH A CONNECTION THAT STANDS, AND WITH ONE OF ITS CALENDARS: remove it, ask
 * its provider now, type its sign-in again, and set what is the person's own of a calendar. None
 * of it reaches a provider: each writes rows the worker's pass reads.
 *
 * EVERY ID IS READ WITH THE SESSION'S ACCOUNT IN THE SAME WHERE. A row that is another account's is
 * not found, in the same words as a row that is nobody's.
 *
 * A transaction that writes the connection's own row takes that row at the writer's strength as
 * the FIRST lock it holds on it, never over a share of its own: the worker's turns take a share
 * first and then the same strength, and two such at once each wait on the other. One that comes
 * for the stronger lock directly waits its turn instead.
 */
import { and, eq, isNull, ne, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { CredentialPlace, StoredCredential } from "@ohmail/cal-providers/connect";
import { claimIdempotencyKey, recordCalendarChanges, type CalendarChange, type Tx } from "@trafficflow/db";
import { CalendarConnectionGone, holdCalendarConnection, sweepCalendarConnectionStep } from "@trafficflow/db/calendar";
import { dialect } from "@trafficflow/db/dialect";
import { calCalendars, calConnections, calCredentials } from "@trafficflow/db/mail";
import type { CalendarConnectionRecord, CalendarPatchBody, CalendarRecord } from "@ohmail/wire";
import { bridgeDb, bridgeTx, withAccountTx, type ServiceContext } from "../context.js";
import { ServiceError } from "../errors.js";
import {
  connectRefusal, connectionRecord, connectionSeen, hasControlCharacter, parseSignInAsk, placedAddress, sealCredential, serverSealedFor,
  typedCalDavCredential, type CalendarConnectDoor,
} from "./connect.js";
import { CALENDAR_BUILDERS } from "./feed.js";
import { requireCalendarOn } from "./settings-service.js";

/** How often one connection's provider is asked on a person's word. */
export const CALENDAR_CHECK_EVERY_MS = 60_000;
/** Steps of a removal one request runs before it answers that the rest is still going. Each takes a bound of events. */
export const CALENDAR_REMOVE_STEPS_PER_REQUEST = 25;
/** A calendar's name as a person writes it. */
export const CALENDAR_NAME_MAX_CHARS = 200;

const SECOND = 1000;
const DAY_SECONDS = 86_400;
const COLOR = /^#[0-9a-f]{6}$/;

const invalid = (message: string): ServiceError => new ServiceError("validation_failed", 400, message);
const noConnection = (): ServiceError => new ServiceError("not_found", 404, "no calendar connection of this account under that id");
const noCalendar = (): ServiceError => new ServiceError("not_found", 404, "no calendar of this account under that id");
const stopped = (): ServiceError => new ServiceError("calendar_connection_stopped", 409, "the calendar's connection waits for the person");
const readOnly = (message: string): ServiceError => new ServiceError("calendar_read_only", 409, message);
const limited = (seconds: number): ServiceError =>
  new ServiceError("rate_limited", 429, "this connection was asked a moment ago; try again later", { retryAfter: Math.min(Math.max(Math.ceil(seconds), 1), DAY_SECONDS) }, true);

/**
 * An id as the store hands it back: lower case. A path's id may be written in capitals and names
 * the same row, so it is read in its one spelling before it is a key of anything: the minute a
 * check is held to, and the record looked up by it.
 */
const oneSpelling = (id: string): string => id.toLowerCase();

/** The mailbox a transaction for this connection fences beside the account: the one it rides, where it rides one. */
const fenceOf = (mailboxId: string | null): { readonly mailboxId?: string } => (mailboxId === null ? {} : { mailboxId });

interface LockedConnection {
  readonly provider: string;
  readonly serverUrl: string | null;
  readonly status: string;
  readonly errorCode: string | null;
  readonly nextPollAt: Date | null;
}

/** The connection's row, this account's, under a writer's lock as the first lock this transaction takes on it. */
async function lockedConnection(tx: Tx, accountId: string, id: string, mode: "update" | "no key update"): Promise<LockedConnection> {
  const [row] = await dialect(tx).forUpdate(
    tx.select({
      provider: calConnections.provider, serverUrl: calConnections.serverUrl, status: calConnections.status,
      errorCode: calConnections.errorCode, nextPollAt: calConnections.nextPollAt,
    }).from(calConnections).where(and(eq(calConnections.id, id), eq(calConnections.accountId, accountId))).limit(1),
    { mode },
  );
  if (row === undefined) throw noConnection();
  return row;
}

/**
 * THE CONNECTION'S MINUTE. A person's word makes a connection due at once no more than once a
 * minute, whichever route carries the word: a row of the key ledger under a name of this door's
 * own, claimed in the caller's transaction with a minute's life. `true`: this request took the
 * minute. `false`: one before it did, on whichever instance it arrived.
 */
async function takeMinute(tx: Tx, accountId: string, connectionId: string, now: Date): Promise<boolean> {
  return claimIdempotencyKey(tx, {
    accountId, key: `calendar-check:${connectionId}`, requestHash: "", responseStatus: 202, responseJson: {}, seq: null,
    now, ttlMs: CALENDAR_CHECK_EVERY_MS,
  });
}

/** The minute as the store counts it. */
const A_MINUTE = sql.raw(`interval '${CALENDAR_CHECK_EVERY_MS / SECOND} seconds'`);

/**
 * The next reading of a row whose minute is taken: a minute from now at the latest, and no later
 * than it was. A row that is due already (it holds no time) stays due: nothing is moved off.
 */
const withinTheMinute = (column: AnyColumn): SQL =>
  sql`case when ${column} is null then null else least(${column}, now() + ${A_MINUTE}) end`;

/**
 * The connection's calendars that are still read are due: now, or within the minute where the
 * connection's minute was taken already. Bookkeeping: no record a device holds moves.
 */
async function calendarsDue(tx: Tx, accountId: string, connectionId: string, when: "now" | "within the minute"): Promise<void> {
  await tx.update(calCalendars).set({ nextPollAt: when === "now" ? null : withinTheMinute(calCalendars.nextPollAt) }).where(and(
    eq(calCalendars.accountId, accountId), eq(calCalendars.connectionId, connectionId),
    or(isNull(calCalendars.errorCode), ne(calCalendars.errorCode, "ended")),
  ));
}

// ── remove ───────────────────────────────────────────────────────────────────────

/**
 * `DELETE /calendar/connections/:id`. First, in one transaction: the row taken for update (a page
 * of its sync in flight commits before), its sealed sign-in deleted and the row marked `removing`,
 * so from that commit no new turn dials for it and no turn writes under it: a turn already under
 * way finishes the one request it is in and stops where it would write its next page (the worker
 * writes every page through its hold of the connection). Then the store's own
 * bounded step, as often as one request may, until the row is gone: every record's deletion is
 * recorded, children first. `removed: false` says rows are still going; the same request again
 * goes on where this one stopped, AND NOTHING ELSE DOES: no worker pass finishes a connection left
 * at `removing`, so a caller asks again until the answer is `removed: true`.
 *
 * THE ONE ACT OF THIS DOOR THAT DOES NOT ASK WHETHER THE ACCOUNT'S CALENDAR IS ON. A removal
 * lowers what is kept, and a switch that is off must never keep a person's sealed sign-in in the
 * store against their wish. It dials nothing, makes nothing due and wakes no reading, on or off.
 */
export async function removeCalendarConnection(ctx: ServiceContext, named: string): Promise<{ removed: boolean; seq: bigint | null }> {
  const id = oneSpelling(named);
  const fence = fenceOf((await connectionSeen(ctx, id)).mailboxId);
  let seq = await withAccountTx(ctx, async (tx) => {
    const t = bridgeTx(tx);
    const row = await lockedConnection(t, ctx.accountId, id, "update");
    if (row.status === "removing") return null;
    await t.delete(calCredentials).where(and(eq(calCredentials.accountId, ctx.accountId), eq(calCredentials.connectionId, id)));
    await t.update(calConnections).set({ status: "removing", updatedAt: sql`now()` })
      .where(and(eq(calConnections.id, id), eq(calConnections.accountId, ctx.accountId)));
    const [marked] = await recordCalendarChanges(tx, ctx.accountId, [{ kind: "calendar_connection", id, op: "update" }]);
    return marked ?? null;
  }, fence);
  for (let step = 0; step < CALENDAR_REMOVE_STEPS_PER_REQUEST; step++) {
    const took = await withAccountTx(
      ctx, (tx) => sweepCalendarConnectionStep(tx, dialect(bridgeTx(tx)), { accountId: ctx.accountId, connectionId: id }), fence,
    );
    seq = took.seq ?? seq;
    if (took.done) return { removed: true, seq };
  }
  return { removed: false, seq };
}

// ── check now ────────────────────────────────────────────────────────────────────

/**
 * `POST /calendar/connections/:id/check`: the connection and its calendars are due now, once a
 * minute for each connection. The minute is the connection's (`takeMinute`), and a sign-in typed
 * again takes the same one: a second ask inside it is refused. A provider that asked to be left
 * alone is left alone until its own time has passed. The change is what rings the worker's bell.
 */
export async function checkCalendarConnection(ctx: ServiceContext, named: string): Promise<{ record: CalendarConnectionRecord; seq: bigint }> {
  const id = oneSpelling(named);
  await requireCalendarOn(ctx);
  const fence = fenceOf((await connectionSeen(ctx, id)).mailboxId);
  return withAccountTx(ctx, async (tx) => {
    const t = bridgeTx(tx);
    const row = await lockedConnection(t, ctx.accountId, id, "no key update");
    if (row.status !== "active" && row.status !== "failing") throw stopped();
    const now = ctx.now();
    const waits = row.nextPollAt === null ? 0 : row.nextPollAt.getTime() - now.getTime();
    if (row.errorCode === "throttled" && waits > 0) throw limited(waits / SECOND);
    if (!await takeMinute(t, ctx.accountId, id, now)) throw limited(CALENDAR_CHECK_EVERY_MS / SECOND);
    await t.update(calConnections).set({ nextPollAt: null, updatedAt: sql`now()` })
      .where(and(eq(calConnections.id, id), eq(calConnections.accountId, ctx.accountId)));
    await calendarsDue(t, ctx.accountId, id, "now");
    const record = await connectionRecord(ctx, tx, id);
    const [seq] = await recordCalendarChanges(tx, ctx.accountId, [{ kind: "calendar_connection", id, op: "update" }]);
    return { record, seq: seq! };
  }, fence);
}

// ── sign in again ────────────────────────────────────────────────────────────────

/**
 * THE SERVER A PASSWORD TYPED AGAIN IS SEALED FOR: the one the sign-in it replaces was sealed for,
 * read out of that sealed text, and only while the connection's row names the same one. THE ROW'S
 * OWN `server_url` IS NEVER SEALED: it stands in the clear, whoever can write rows can write
 * another address there, and a password sealed for what was written there would be sent there.
 * Where the kept sign-in does not open for this connection, or was sealed for another server than
 * the row names, nothing is sealed and the door says `sign_in_incomplete`: the person removes the
 * connection and connects again, typing its server. A connection that is being removed has lost
 * its sealed sign-in to the removal: it answers as every act on it does.
 */
async function serverOfSignInAgain(
  ctx: ServiceContext, door: CalendarConnectDoor, at: CredentialPlace, rowServer: string | null,
): Promise<string> {
  const server = await serverSealedFor(ctx, door.keys, at);
  if (server !== null && server === rowServer) return server;
  throw (await connectionSeen(ctx, at.connectionId)).status === "removing" ? stopped() : connectRefusal("sign_in_incomplete");
}

/**
 * `POST /calendar/connections/:id/sign-in`: the sign-in typed again, sealed in place of the one
 * the connection kept, and the connection active and due. The kind a connection keeps is its
 * provider's; a subscription's new address is read by its shape as at the connect, its host
 * replaces the old one, and where the old address's reading stood is forgotten with it. (A
 * reading of the old address that is under way at this instant writes where it stood when it
 * ends, after this: that turn is covered by the reader, which sends a validator to no address
 * but the one it came from.)
 *
 * DUE AT ONCE ONLY WHERE THE CONNECTION'S MINUTE IS FREE. A sign-in takes the minute a check takes
 * (`takeMinute`), or it would be a check with no limit, and for a subscription one that aims the
 * next request at a new host each time. Inside a minute that is taken, the sign-in is sealed and
 * the connection made active all the same, and its next reading is within the minute, never now.
 *
 * A connection that waits for its person has no turn under way, so the next turn is the new
 * sign-in's. On a connection that is being read at this instant, the turn under way ends with the
 * sign-in it opened: the worker keeps the connection due (it never writes over a time someone
 * asked for during its turn), and the next turn opens the new one. A calendar that turn finished
 * reading keeps the time of its next reading, so there the new sign-in is first used when that
 * calendar is next due.
 *
 * A PASSWORD TYPED AGAIN IS SEALED FOR THE SERVER THE SIGN-IN IT REPLACES WAS SEALED FOR
 * (`serverOfSignInAgain`): a request names no server for a connection that stands, and the row's
 * own is never sealed. Where that server cannot be read, nothing is sealed and the person
 * connects again.
 */
export async function signInCalendarAgain(
  ctx: ServiceContext, door: CalendarConnectDoor, named: string, body: unknown,
): Promise<{ record: CalendarConnectionRecord; seq: bigint }> {
  const id = oneSpelling(named);
  const ask = parseSignInAsk(body);
  await requireCalendarOn(ctx);
  const seen = await connectionSeen(ctx, id);
  if (door.port === undefined) throw connectRefusal("provider_off");
  if (seen.mailboxId !== null) throw readOnly("this connection signs in with its mailbox");
  const kept = seen.provider === "ics" ? "address" : seen.provider === "caldav" ? "basic" : null;
  if (kept !== ask.kind) throw invalid("that is not the sign-in this connection keeps");
  const place = ask.kind === "address" ? placedAddress("ics", ask.address.reveal(), door.port.policy) : null;
  const at = { accountId: ctx.accountId, connectionId: id };
  const credential: StoredCredential = ask.kind === "address"
    ? { kind: "address", url: ask.address }
    : typedCalDavCredential(await serverOfSignInAgain(ctx, door, at, seen.serverUrl), ask);
  const sealed = await sealCredential(door.keys, credential, at);
  return withAccountTx(ctx, async (tx) => {
    const t = bridgeTx(tx);
    const row = await lockedConnection(t, ctx.accountId, id, "no key update");
    if (row.status === "removing") throw stopped();
    // The row is no longer the one this request read and sealed for: another provider's, or with another server written into it.
    if (row.provider !== seen.provider || row.serverUrl !== seen.serverUrl) throw noConnection();
    const due = await takeMinute(t, ctx.accountId, id, ctx.now()) ? "now" : "within the minute";
    const columns = { secretEnc: sealed.ciphertext, keyVersion: sealed.keyVersion, meta: null, updatedAt: sql`now()` };
    await t.insert(calCredentials).values({ accountId: ctx.accountId, connectionId: id, kind: credential.kind, ...columns })
      .onConflictDoUpdate({ target: [calCredentials.accountId, calCredentials.connectionId, calCredentials.kind], set: columns });
    await t.update(calConnections).set({
      status: "active", errorCode: null, updatedAt: sql`now()`,
      nextPollAt: due === "now" ? null : withinTheMinute(calConnections.nextPollAt),
      ...(place === null ? {} : { sourceHost: place.sourceHost }),
    }).where(and(eq(calConnections.id, id), eq(calConnections.accountId, ctx.accountId)));
    const changes: CalendarChange[] = [];
    if (place !== null) {
      // Where a reading stands (its validators, the hash of its text) is the old address's. Under a new address it is
      // nobody's: forgotten here, with the address and in its transaction, so the calendar is read from the beginning.
      // Bookkeeping: no record a device holds moves.
      await t.update(calCalendars).set({ syncToken: null })
        .where(and(eq(calCalendars.accountId, ctx.accountId), eq(calCalendars.connectionId, id)));
      // A subscription that had ended was the old address's: under a new one its calendar is read again.
      const revived = await t.update(calCalendars).set({ errorCode: null, updatedAt: sql`now()` }).where(and(
        eq(calCalendars.accountId, ctx.accountId), eq(calCalendars.connectionId, id), eq(calCalendars.errorCode, "ended"),
      )).returning({ id: calCalendars.id });
      for (const c of revived) changes.push({ kind: "calendar", id: c.id, op: "update" });
    }
    await calendarsDue(t, ctx.accountId, id, due);
    const record = await connectionRecord(ctx, tx, id);
    changes.push({ kind: "calendar_connection", id, op: "update" });
    const seqs = await recordCalendarChanges(tx, ctx.accountId, changes);
    return { record, seq: seqs[seqs.length - 1]! };
  });
}

// ── a calendar's own ─────────────────────────────────────────────────────────────

const PATCHED: ReadonlySet<string> = new Set<keyof CalendarPatchBody>(["shown", "name", "color"]);

/** The body's fields, each checked. A name this door has no column for is refused, never passed over. */
function patchOf(body: unknown): CalendarPatchBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("the body must be an object");
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => !PATCHED.has(k));
  if (unknown !== undefined) throw invalid("a calendar takes shown, name and color, and nothing else");
  const out: CalendarPatchBody = {};
  if ("shown" in b) {
    if (typeof b.shown !== "boolean") throw invalid("shown must be true or false");
    out.shown = b.shown;
  }
  if ("name" in b) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name === "" || name.length > CALENDAR_NAME_MAX_CHARS || hasControlCharacter(name)) throw invalid("name must be a short text");
    out.name = name;
  }
  if ("color" in b) {
    const color = typeof b.color === "string" ? b.color.toLowerCase() : b.color;
    if (color !== null && (typeof color !== "string" || !COLOR.test(color))) throw invalid("color must be #rrggbb, or null");
    out.color = color;
  }
  if (Object.keys(out).length === 0) throw invalid("name at least one of shown, name and color");
  return out;
}

/**
 * `PATCH /calendar/calendars/:id`. `shown` is the person's own on every calendar. `name` and
 * `color` are the person's own only where no provider lists the calendar: a subscription's, whose
 * file is read for them once. Where a provider lists its calendars the store's two columns are the
 * provider's copy, written again by every listing, so a value set here would not stay: refused.
 * A request that changes nothing writes nothing and names no seq.
 */
export async function setCalendar(ctx: ServiceContext, named: string, body: unknown): Promise<{ record: CalendarRecord; seq: bigint | null }> {
  const id = oneSpelling(named);
  const patch = patchOf(body);
  await requireCalendarOn(ctx);
  return withAccountTx(ctx, async (tx) => {
    const t = bridgeTx(tx);
    const mine = and(eq(calCalendars.id, id), eq(calCalendars.accountId, ctx.accountId));
    const [cal] = await t.select({
      connectionId: calCalendars.connectionId, shown: calCalendars.shown, name: calCalendars.name, color: calCalendars.color,
    }).from(calCalendars).where(mine).limit(1);
    if (cal === undefined) throw noCalendar();
    try {
      await holdCalendarConnection(t, dialect(t), { accountId: ctx.accountId, connectionId: cal.connectionId });
    } catch (err) {
      if (err instanceof CalendarConnectionGone) throw err.reason === "removing" ? stopped() : noCalendar();
      throw err;
    }
    if (patch.name !== undefined || patch.color !== undefined) {
      const [conn] = await t.select({ provider: calConnections.provider }).from(calConnections)
        .where(and(eq(calConnections.id, cal.connectionId), eq(calConnections.accountId, ctx.accountId))).limit(1);
      if (conn?.provider !== "ics") throw readOnly("this calendar's name and colour are its provider's");
    }
    const next = {
      shown: patch.shown ?? cal.shown, name: patch.name ?? cal.name, color: patch.color === undefined ? cal.color : patch.color,
    };
    const record = async (): Promise<CalendarRecord> => {
      const built = (await CALENDAR_BUILDERS.calendar(bridgeDb(tx), ctx.accountId, [id])).get(id);
      if (built === undefined) throw noCalendar();
      return built;
    };
    if (next.shown === cal.shown && next.name === cal.name && next.color === cal.color) return { record: await record(), seq: null };
    await t.update(calCalendars).set({ ...next, updatedAt: sql`now()` }).where(mine);
    const kept = await record();
    const [seq] = await recordCalendarChanges(tx, ctx.accountId, [{ kind: "calendar", id, op: "update" }]);
    return { record: kept, seq: seq! };
  });
}
