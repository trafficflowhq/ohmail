/**
 * THE CALENDAR'S CONNECT DOOR, AS THE SERVER TAKES IT. A person types a sign-in or a subscription's
 * address once; the door checks its shape, seals it and writes the connection in one transaction.
 * NOTHING IS DIALLED HERE and no name is looked up: the port this door is composed with holds no
 * resolver and no way out. The worker's pass tries the sign-in, and what came of it is the
 * connection's `status` and `error_code`, by the feed.
 *
 * What was typed lives in a `Secret` from the body's parser on. `reveal()` is called to read an
 * address's shape (the reading hands back its host alone) and to make the one text that is
 * sealed; only the envelope reaches a statement, so a store's error can quote nothing typed. A
 * refusal is a fixed sentence with a word of the closed list beside it, never anything typed.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  ICLOUD_CALDAV_START, MAX_URL_CHARS, Secret, readTypedAddress, serializeCredential, type StoredCredential,
} from "@ohmail/cal-providers/connect";
import type { KeyProvider } from "@trafficflow/core";
import { recordCalendarChanges } from "@trafficflow/db";
import { isWriteUuid } from "@trafficflow/db/calendar";
import { dialect } from "@trafficflow/db/dialect";
import { calConnections, calCredentials, calSettings } from "@trafficflow/db/mail";
import type {
  CalendarConnectRefusal, CalendarConnectWire, CalendarConnectionRecord, CalendarSyncFault, CalendarWay,
} from "@ohmail/wire";
import type { CalendarConnectPort } from "../calendar-port.js";
import { bridgeDb, bridgeTx, claimOrLose, withAccountTx, type IdempotencyClaim, type ServiceContext } from "../context.js";
import { ServiceError } from "../errors.js";
import { CALENDAR_BUILDERS, calendarEnabledAt } from "./feed.js";
import { requireCalendarOn } from "./settings-service.js";
import { wakeCalendarConnection } from "./writes.js";

/**
 * Connections one account may hold. Every connection is an address this deployment's worker asks
 * again and again, so the ceiling bounds what one account can make it ask. Counted under a lock
 * on the account's calendar settings, so connects in flight at the same instant go one after the
 * other and none passes it.
 */
export const CALENDAR_CONNECTION_CEILING = 20;
/** A user's name at a CalDAV server: a mail address at its longest, and room. */
export const CALDAV_USER_MAX_CHARS = 320;
/** A password as typed. An app password has 16 to 19 characters; a person's own may be a sentence. */
export const CALDAV_PASSWORD_MAX_CHARS = 1024;

/** What the composed door holds: the port (or none) and the keys a sign-in is sealed with. */
export interface CalendarConnectDoor {
  readonly port: CalendarConnectPort | undefined;
  readonly keys: KeyProvider;
}

/** What a person typed, read once. Every secret is held in a `Secret` from here on. */
export type CalendarConnectAsk =
  | { readonly way: "icloud"; readonly connectionId: string; readonly user: string; readonly password: Secret }
  | { readonly way: "caldav"; readonly connectionId: string; readonly server: string; readonly user: string; readonly password: Secret }
  | { readonly way: "ics"; readonly connectionId: string; readonly address: Secret }
  /** The two ways that sign in at their provider: named, and never taken by this door. */
  | { readonly way: "google"; readonly connectionId: string }
  | { readonly way: "microsoft"; readonly connectionId: string };

/** A sign-in typed again for a connection that stands. */
export type CalendarSignInAsk =
  | { readonly kind: "basic"; readonly user: string; readonly password: Secret }
  | { readonly kind: "address"; readonly address: Secret };

const invalid = (message: string): ServiceError => new ServiceError("validation_failed", 400, message);

/** What a refusal says for each word: fixed sentences, so nothing typed can ride in one. */
const REFUSAL: Readonly<Partial<Record<CalendarSyncFault, string>>> = {
  address_invalid: "that is no address a calendar can be read at",
  address_not_allowed: "this server does not read a calendar at that address",
  port_not_allowed: "no calendar is read on that port",
  too_large: "that sign-in is too long to keep",
  provider_off: "that way to connect a calendar is not offered here",
};

/** A refusal of the door's own: `400 validation_failed`, the word in `details.fault`. */
export function connectRefusal(fault: CalendarSyncFault): ServiceError {
  const details: CalendarConnectRefusal = { fault };
  return new ServiceError("validation_failed", 400, REFUSAL[fault] ?? "that calendar cannot be connected", details);
}

/** The new connection's id is a row's already: this account's or another's, the answer is the same. */
export class CalendarConnectionTaken extends ServiceError {
  constructor() {
    super("validation_failed", 400, "the new connection's id is taken");
    this.name = "CalendarConnectionTaken";
  }
}

/** A sign-in could not be sealed: the host's fault. It carries nothing of what it was handed. */
export class CalendarSealFault extends Error {
  constructor() {
    super("a calendar's sign-in could not be sealed by this host");
    this.name = "CalendarSealFault";
  }
}

// ── the parser ───────────────────────────────────────────────────────────────────

const WAYS: ReadonlySet<string> = new Set<CalendarWay>(["icloud", "caldav", "ics", "google", "microsoft"]);

function fields(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("the body must be an object");
  return body as Record<string, unknown>;
}

/** Does the text hold a character no line of a request or a name on a screen carries (U+0000 to U+001F, U+007F)? */
export function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** A user's name as a sign-in line can carry it: no colon (it ends the name there) and nothing a line breaks on. */
function userOf(v: unknown): string {
  if (typeof v !== "string") throw invalid("user must be a text");
  const user = v.trim();
  if (user === "" || user.length > CALDAV_USER_MAX_CHARS || user.includes(":") || hasControlCharacter(user)) {
    throw invalid("user must be a name a server signs in, without a colon");
  }
  return user;
}

function passwordOf(v: unknown): Secret {
  if (typeof v !== "string" || v === "" || v.length > CALDAV_PASSWORD_MAX_CHARS) throw invalid("password must be a text, and not an empty one");
  return new Secret(v);
}

/** An address as typed: bounded here, read where its way is known. */
function addressOf(v: unknown, name: string): string {
  if (typeof v !== "string" || v.trim() === "") throw invalid(`${name} must be an address`);
  if (v.length > MAX_URL_CHARS) throw connectRefusal("address_invalid");
  return v;
}

/** `POST /calendar/connections`, its body read: the way, the device's id for the connection, and what was typed. */
export function parseConnectAsk(body: unknown): CalendarConnectAsk {
  const b = fields(body);
  if (typeof b.way !== "string" || !WAYS.has(b.way)) throw invalid("way must be a way a calendar is connected");
  if (!isWriteUuid(b.connectionId)) throw invalid("connectionId must be the new connection's id, a uuid in lower case");
  const connectionId = b.connectionId;
  switch (b.way as CalendarWay) {
    case "icloud":
      return { way: "icloud", connectionId, user: userOf(b.user), password: passwordOf(b.password) };
    case "caldav":
      return { way: "caldav", connectionId, server: addressOf(b.server, "server"), user: userOf(b.user), password: passwordOf(b.password) };
    case "ics":
      return { way: "ics", connectionId, address: new Secret(addressOf(b.address, "address")) };
    case "google":
      return { way: "google", connectionId };
    case "microsoft":
      return { way: "microsoft", connectionId };
  }
}

/** `POST /calendar/connections/:id/sign-in`, its body read: one of the two sign-ins, whole. */
export function parseSignInAsk(body: unknown): CalendarSignInAsk {
  const b = fields(body);
  if ("address" in b) {
    if ("user" in b || "password" in b) throw invalid("a sign-in is an address, or a user and a password");
    return { kind: "address", address: new Secret(addressOf(b.address, "address")) };
  }
  return { kind: "basic", user: userOf(b.user), password: passwordOf(b.password) };
}

// ── the ways ─────────────────────────────────────────────────────────────────────

/**
 * Whether the sign-in ceremony of each way that needs one is built. Neither is: the task that
 * builds one turns its word here, in the change that adds its routes.
 */
export const CALENDAR_CEREMONIES_BUILT: Readonly<Record<"google" | "microsoft", boolean>> = { google: false, microsoft: false };

/**
 * The ways a composition offers. With no port, none. `google` and `microsoft` only with the
 * operator's switch on AND the client configured AND the ceremony built: each is asked as
 * exactly `true`, so a member that is missing reads as off.
 */
export function offeredWays(
  port: CalendarConnectPort | undefined, built: Readonly<Record<"google" | "microsoft", boolean>> = CALENDAR_CEREMONIES_BUILT,
): CalendarWay[] {
  if (port === undefined) return [];
  const ways: CalendarWay[] = ["icloud", "caldav", "ics"];
  for (const way of ["google", "microsoft"] as const) {
    const c = port.ceremonies?.[way];
    if (c?.on === true && c.configured === true && built[way] === true) ways.push(way);
  }
  return ways;
}

/** `GET /calendar/connect`: the ways offered to this account now; none while its calendar is off. */
export async function calendarWays(ctx: ServiceContext, port: CalendarConnectPort | undefined): Promise<CalendarConnectWire> {
  return { ways: (await calendarEnabledAt(ctx.db, ctx.accountId)) === null ? [] : offeredWays(port) };
}

// ── the address and the seal ─────────────────────────────────────────────────────

/** Where a typed address places a connection: its host as the store keeps it, and a CalDAV server's start. */
export function placedAddress(
  way: "caldav" | "ics", typed: string, policy: CalendarConnectPort["policy"],
): { readonly sourceHost: string; readonly serverUrl: string | null } {
  const read = readTypedAddress(way, typed, { kind: policy });
  if (!read.ok) throw connectRefusal(read.reason);
  // The store keeps a bare host. A numbered address written with colons has none, and is not taken.
  if (read.host === "" || read.host.includes(":") || read.host.startsWith("[")) throw connectRefusal("address_not_allowed");
  return { sourceHost: read.host, serverUrl: read.start };
}

/**
 * The sign-in sealed as the worker's pass opens it: `keys.encrypt(serializeCredential(...))`,
 * opened once again before it is kept. Outside every transaction. Whatever the key service says of
 * a failure is dropped here: it may quote what it was handed.
 */
export async function sealCredential(
  keys: KeyProvider, credential: StoredCredential,
): Promise<{ readonly ciphertext: string; readonly keyVersion: number }> {
  const text = serializeCredential(credential);
  // What would not open again is not written: refused now, never found missing at the first reading.
  if (text === null) throw connectRefusal("too_large");
  let sealed: { ciphertext: string; keyVersion: number };
  let opens: boolean;
  try {
    sealed = await keys.encrypt(text);
    opens = await keys.decrypt(sealed.ciphertext, sealed.keyVersion) === text;
  } catch {
    throw new CalendarSealFault();
  }
  if (!opens) throw new CalendarSealFault();
  return sealed;
}

// ── the connect ──────────────────────────────────────────────────────────────────

/**
 * `POST /calendar/connections`. In order: the account's calendar is on; the way is one this
 * composition offers and this door takes; the address by its shape; the ceiling; the seal; then
 * ONE fenced transaction: the connection, its sealed sign-in, the change, and the key's claim with
 * the record as the answer a second arrival is given. After the commit the connection is pulled due.
 *
 * `claim` is the press's key with a hash that names the way and the id and nothing typed. A
 * concurrent arrival under the same key loses the claim, or finds the id taken: the route answers
 * both from the winner's row.
 */
export async function connectCalendar(
  ctx: ServiceContext, door: CalendarConnectDoor, ask: CalendarConnectAsk, claim: IdempotencyClaim,
): Promise<{ record: CalendarConnectionRecord; seq: bigint }> {
  await requireCalendarOn(ctx);
  const port = door.port;
  if (port === undefined || ask.way === "google" || ask.way === "microsoft" || !offeredWays(port).includes(ask.way)) {
    throw connectRefusal("provider_off");
  }
  const place = ask.way === "ics"
    ? placedAddress("ics", ask.address.reveal(), port.policy)
    : placedAddress("caldav", ask.way === "icloud" ? ICLOUD_CALDAV_START : ask.server, port.policy);
  const credential: StoredCredential = ask.way === "ics"
    ? { kind: "address", url: ask.address }
    : { kind: "basic", user: ask.user, password: ask.password };
  const sealed = await sealCredential(door.keys, credential);

  const done = await withAccountTx(ctx, async (tx) => {
    const t = bridgeTx(tx);
    // The account's settings row is the one row every account with a calendar has: taken for update, it lets one
    // connect of the account count at a time. Nothing else is locked before it here, and the new row is nobody's yet.
    await dialect(t).forUpdate(
      t.select({ accountId: calSettings.accountId }).from(calSettings).where(eq(calSettings.accountId, ctx.accountId)).limit(1),
      { mode: "update" },
    );
    const [held] = await t.select({ n: sql<number>`count(*)::int` }).from(calConnections).where(eq(calConnections.accountId, ctx.accountId));
    if (Number(held?.n ?? 0) >= CALENDAR_CONNECTION_CEILING) {
      throw new ServiceError("conflict", 409, "this account holds as many calendar connections as it may", { limit: CALENDAR_CONNECTION_CEILING });
    }
    // The id is the device's and the row's own key: one that is taken makes no second row, whoever holds it.
    // No conflict target is named: the row has two unique keys (its id, and its id with its account), and a
    // same-key arrival that waited on the other one would be raised as a fault instead of found taken.
    const [made] = await t.insert(calConnections).values({
      id: ask.connectionId, accountId: ctx.accountId, provider: ask.way === "ics" ? "ics" : "caldav", label: "", status: "active",
      serverUrl: place.serverUrl, sourceHost: place.sourceHost, nextPollAt: null,
    }).onConflictDoNothing().returning({ id: calConnections.id });
    if (made === undefined) throw new CalendarConnectionTaken();
    await t.insert(calCredentials).values({
      accountId: ctx.accountId, connectionId: ask.connectionId, kind: credential.kind,
      secretEnc: sealed.ciphertext, keyVersion: sealed.keyVersion,
    });
    const record = await connectionRecord(ctx, tx, ask.connectionId);
    const [seq] = await recordCalendarChanges(tx, ctx.accountId, [{ kind: "calendar_connection", id: ask.connectionId, op: "create" }]);
    await claimOrLose(tx, ctx, claim, { status: 202, json: record, seq: Number(seq) });
    return { record, seq: seq! };
  });
  await wakeCalendarConnection(ctx, ask.connectionId);
  return done;
}

/** The connection's record as the feed builds it, read inside the caller's transaction. */
export async function connectionRecord(
  ctx: ServiceContext, tx: Parameters<typeof bridgeDb>[0], connectionId: string,
): Promise<CalendarConnectionRecord> {
  const built = await CALENDAR_BUILDERS.calendar_connection(bridgeDb(tx), ctx.accountId, [connectionId]);
  const record = built.get(connectionId);
  if (record === undefined) throw new ServiceError("not_found", 404, "no calendar connection of this account under that id");
  return record;
}

/** Is a connection of this id the account's? The read every route that names one begins with. */
export async function connectionSeen(
  ctx: ServiceContext, connectionId: string,
): Promise<{ readonly provider: string; readonly mailboxId: string | null }> {
  const [row] = await ctx.db.select({ provider: calConnections.provider, mailboxId: calConnections.mailboxId }).from(calConnections)
    .where(and(eq(calConnections.id, connectionId), eq(calConnections.accountId, ctx.accountId))).limit(1);
  if (row === undefined) throw new ServiceError("not_found", 404, "no calendar connection of this account under that id");
  return row;
}
