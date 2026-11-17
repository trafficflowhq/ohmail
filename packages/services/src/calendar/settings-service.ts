/**
 * THE ACCOUNT'S CALENDAR SWITCH AND ITS SETTINGS (`cal_settings`, one row per account).
 *
 * `enabled_at` is the switch: while it is NULL the feed sends no calendar record to this account
 * and the later calendar routes refuse ({@link requireCalendarOn}). A write is one transaction, in
 * the order every settings writer keeps: the account's fence, the consent stamp's row, this row,
 * the counter last. The stamp moves only when a field changes, beside one `settings` change, so
 * every signed-in device re-reads its settings record, which carries `calendarEnabledAt`. A
 * request that changes nothing writes nothing and answers no `X-Sync-Seq`.
 */
import { and, eq, inArray } from "drizzle-orm";
import { calCalendars, calSettings } from "@trafficflow/db/mail";
import { carryBinding, lockSettingsStamp, moveSettingsStamp, recordChanges } from "@trafficflow/db";
import type { CalendarSettingsWire } from "@ohmail/wire";
import { withAccountTx, type ServiceContext } from "../context.js";
import { ServiceError } from "../errors.js";
import { isUuid } from "../ids.js";
import { calendarEnabledAt } from "./feed.js";

/** The longest zone name stored; IANA's longest is about thirty characters. */
export const CALENDAR_ZONE_NAME_MAX = 64;
const DAY_MINUTES = 24 * 60;

interface Stored {
  enabledAt: Date | null;
  secondZone: string | null;
  weekNumbers: boolean;
  dayFromMinute: number | null;
  dayToMinute: number | null;
  newEventsCalendarId: string | null;
}

const DEFAULTS: Stored = {
  enabledAt: null, secondZone: null, weekNumbers: false, dayFromMinute: null, dayToMinute: null, newEventsCalendarId: null,
};

function wireOf(s: Stored): CalendarSettingsWire {
  return {
    enabledAt: s.enabledAt === null ? null : s.enabledAt.toISOString(),
    secondZone: s.secondZone,
    weekNumbers: s.weekNumbers,
    dayFromMinute: s.dayFromMinute,
    dayToMinute: s.dayToMinute,
    newEventsCalendarId: s.newEventsCalendarId,
  };
}

const refuse = (message: string): ServiceError => new ServiceError("validation_failed", 400, message);

function knownZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const minuteOfDay = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= DAY_MINUTES;

/** The body's fields, each checked; a field absent is left as it stands. */
function patchOf(body: unknown): Partial<Omit<Stored, "enabledAt">> & { enabled?: boolean } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw refuse("the body must be an object");
  const b = body as Record<string, unknown>;
  const out: Partial<Omit<Stored, "enabledAt">> & { enabled?: boolean } = {};
  if ("enabled" in b) {
    if (typeof b.enabled !== "boolean") throw refuse("enabled must be true or false");
    out.enabled = b.enabled;
  }
  if ("secondZone" in b) {
    const z = b.secondZone;
    if (z !== null && (typeof z !== "string" || z.length === 0 || z.length > CALENDAR_ZONE_NAME_MAX || !knownZone(z))) {
      throw refuse("secondZone must be a time zone's name, or null");
    }
    out.secondZone = z;
  }
  if ("weekNumbers" in b) {
    if (typeof b.weekNumbers !== "boolean") throw refuse("weekNumbers must be true or false");
    out.weekNumbers = b.weekNumbers;
  }
  for (const key of ["dayFromMinute", "dayToMinute"] as const) {
    if (!(key in b)) continue;
    const v = b[key];
    if (v !== null && !minuteOfDay(v)) throw refuse(`${key} must be a whole minute of the day, or null`);
    out[key] = v;
  }
  if ("newEventsCalendarId" in b) {
    const id = b.newEventsCalendarId;
    if (id !== null && !isUuid(id)) throw refuse("newEventsCalendarId must be a calendar's id, or null");
    out.newEventsCalendarId = id;
  }
  if (Object.keys(out).length === 0) throw refuse("name at least one setting to change");
  return out;
}

const same = (a: Stored, b: Stored): boolean =>
  (a.enabledAt === null) === (b.enabledAt === null) && a.enabledAt?.getTime() === b.enabledAt?.getTime()
  && a.secondZone === b.secondZone && a.weekNumbers === b.weekNumbers
  && a.dayFromMinute === b.dayFromMinute && a.dayToMinute === b.dayToMinute
  && a.newEventsCalendarId === b.newEventsCalendarId;

async function storedOf(db: ServiceContext["db"], accountId: string): Promise<Stored> {
  const [row] = await db.select().from(calSettings).where(eq(calSettings.accountId, accountId)).limit(1);
  return row === undefined ? DEFAULTS : {
    enabledAt: row.enabledAt, secondZone: row.secondZone, weekNumbers: row.weekNumbers,
    dayFromMinute: row.dayFromMinute, dayToMinute: row.dayToMinute, newEventsCalendarId: row.newEventsCalendarId,
  };
}

/** `GET /calendar/settings`: the account's row, or the defaults where it has none. */
export async function calendarSettings(ctx: ServiceContext): Promise<CalendarSettingsWire> {
  return wireOf(await storedOf(ctx.db, ctx.accountId));
}

/**
 * `PATCH /calendar/settings`. `seq` is the settings change the write recorded, `null` when the
 * request changed nothing. Switching on keeps the instant it first went on; switching off clears it.
 */
export async function setCalendarSettings(
  ctx: ServiceContext, body: unknown,
): Promise<{ settings: CalendarSettingsWire; seq: bigint | null }> {
  const patch = patchOf(body);
  return withAccountTx(ctx, async (tx) => {
    const now = ctx.now();
    // The stamp's row first, held where it stands: every settings writer takes it before its own row.
    await lockSettingsStamp(tx, ctx.accountId, now);
    const before = await storedOf(carryBinding(ctx.db, tx), ctx.accountId);
    const { enabled, ...rest } = patch;
    const next: Stored = {
      ...before, ...rest,
      enabledAt: enabled === undefined ? before.enabledAt : enabled ? (before.enabledAt ?? now) : null,
    };
    if ((next.dayFromMinute === null) !== (next.dayToMinute === null)
      || (next.dayFromMinute !== null && next.dayToMinute !== null && next.dayFromMinute >= next.dayToMinute)) {
      throw refuse("dayFromMinute and dayToMinute are set together, the first before the second");
    }
    if (next.newEventsCalendarId !== null && next.newEventsCalendarId !== before.newEventsCalendarId) {
      // The column has no key (a calendar of the account, by id): read with the account, in this transaction.
      const [cal] = await tx.select({ id: calCalendars.id }).from(calCalendars).where(and(
        eq(calCalendars.accountId, ctx.accountId), eq(calCalendars.id, next.newEventsCalendarId),
        inArray(calCalendars.access, ["owner", "writer"]),
      )).limit(1);
      if (cal === undefined) throw new ServiceError("not_found", 404, "no calendar of this account takes new events under that id");
    }
    if (same(before, next)) return { settings: wireOf(before), seq: null };
    await moveSettingsStamp(tx, ctx.accountId, now);
    const columns = {
      enabledAt: next.enabledAt, secondZone: next.secondZone, weekNumbers: next.weekNumbers,
      dayFromMinute: next.dayFromMinute, dayToMinute: next.dayToMinute, newEventsCalendarId: next.newEventsCalendarId,
      updatedAt: now,
    };
    await tx.insert(calSettings).values({ accountId: ctx.accountId, ...columns })
      .onConflictDoUpdate({ target: calSettings.accountId, set: columns });
    const [seq] = await recordChanges(tx, [{ accountId: ctx.accountId, entityType: "settings", entityId: ctx.accountId, op: "update", meta: null }]);
    return { settings: wireOf(next), seq: seq! };
  });
}

/**
 * What every later calendar route asks first: refused `409 calendar_off` while the account has not
 * switched its calendar on. Answers the instant it went on.
 */
export async function requireCalendarOn(ctx: ServiceContext): Promise<Date> {
  const at = await calendarEnabledAt(ctx.db, ctx.accountId);
  if (at === null) throw new ServiceError("calendar_off", 409, "the calendar is switched off for this account");
  return at;
}
