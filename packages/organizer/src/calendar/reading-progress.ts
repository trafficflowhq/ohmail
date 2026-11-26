import { createHash, randomUUID } from "node:crypto";
import type { CalEvent } from "@ohmail/cal-core";
import type { ChangePage } from "@ohmail/cal-providers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { calCalendars, calEvents, type Tx } from "@trafficflow/db";
import { inConnection, readingBound, type ConnectionDb, type ConnectionKey } from "./connection.js";
import { storableKey } from "./storable.js";
import type { OpenReading } from "./types.js";

/** Keep recurrence facts without storing event bodies or invitee lists in the checkpoint. */
export function recurrenceMaster(event: CalEvent): CalEvent {
  return {
    ...event,
    component: { name: "VEVENT", properties: [], components: [] },
    summary: null,
    description: null,
    location: null,
    organizer: null,
    attendees: [],
    alarms: [],
    url: null,
    categories: [],
  };
}

type Checkpoint = Omit<OpenReading, "owner" | "startedAt" | "seen" | "masters"> & {
  readonly version: 2;
  readonly startedAt: string;
  readonly seen: [string, [string, (string | null)[]][]][];
  readonly masters: [string, CalEvent][];
};

interface ProgressKey {
  readonly db: ConnectionDb;
  readonly key: ConnectionKey;
  readonly calendarId: string;
}

const calendarRow = ({ key, calendarId }: ProgressKey) =>
  and(
    eq(calCalendars.accountId, key.accountId),
    eq(calCalendars.connectionId, key.id),
    eq(calCalendars.id, calendarId),
  );

/** Only the most recent turn may apply a page or finish its reading, even during a worker overlap. */
export async function claimProgress(
  scope: ProgressKey,
  token: string | null,
): Promise<{ scope: ProgressKey; owner: string; previous: string | null } | "gone"> {
  const owner = randomUUID();
  return inConnection(scope.db, scope.key, async ({ tx }) => {
    const [row] = await tx
      .select({ owner: calCalendars.readOwner })
      .from(calCalendars)
      .where(and(calendarRow(scope), sql`${calCalendars.syncToken} is not distinct from ${token}`))
      .for("no key update");
    if (row === undefined) return "gone";
    await tx.update(calCalendars).set({ readOwner: owner }).where(calendarRow(scope));
    const db = readingBound(scope.db, scope.key, async (held) => {
      const [match] = await held
        .select({ id: calCalendars.id })
        .from(calCalendars)
        .where(and(calendarRow(scope), eq(calCalendars.readOwner, owner)))
        .for("no key update");
      return match !== undefined;
    });
    return { scope: { ...scope, db }, owner, previous: row.owner };
  });
}

export async function loadProgress(
  scope: ProgressKey,
  calendarToken: string | null,
  since: string | null,
  window: OpenReading["window"],
  credentialGeneration: string | null,
  owner: string,
): Promise<OpenReading | "gone"> {
  return inConnection(scope.db, scope.key, async ({ tx }) => {
    const [row] = await tx
      .select({
        checkpoint: calCalendars.readCheckpoint,
        ms: sql<number>`floor(extract(epoch from now()) * 1000)`,
      })
      .from(calCalendars)
      .where(calendarRow(scope));
    if (row === undefined) return "gone";
    const saved = row.checkpoint === null ? null : (JSON.parse(row.checkpoint) as Checkpoint);
    if (
      saved?.version === 2 &&
      saved.connectionId === scope.key.id &&
      saved.calendarToken === calendarToken &&
      saved.since === since &&
      saved.credentialGeneration === credentialGeneration
    ) {
      return {
        ...saved,
        owner,
        end: saved.end ?? null,
        startedAt: new Date(saved.startedAt),
        seen: new Map(
          saved.seen.map(([uid, keys]) => [uid, new Map(keys.map(([key, ids]) => [key, new Set(ids)]))]),
        ),
        masters: new Map(saved.masters),
        // Older checkpoints kept one count per continuation in the cycle detector.
        pagesRead: saved.pagesRead ?? saved.cycle.span - 1 + saved.cycle.steps,
      };
    }
    return {
      connectionId: scope.key.id,
      owner,
      generation: randomUUID(),
      calendarToken,
      credentialGeneration,
      since,
      cursor: null,
      end: null,
      mode: null,
      window,
      startedAt: new Date(Number(row.ms)),
      heldCancellations: [],
      seen: new Map(),
      masters: new Map(),
      seenCount: 0,
      recurrenceChars: 0,
      pagesRead: 0,
      cycle: { anchor: null, span: 1, steps: 0 },
      changed: 0,
      unknownGone: false,
      noDrop: false,
      leftOut: false,
    };
  });
}

export async function saveProgress(
  scope: ProgressKey,
  reading: OpenReading | null,
  seen?: ReadonlySet<string>,
): Promise<"gone" | void> {
  let checkpoint: Checkpoint | null = null;
  if (reading !== null) {
    const { owner: _owner, startedAt, seen, masters, ...state } = reading;
    checkpoint = {
      ...state,
      version: 2,
      startedAt: startedAt.toISOString(),
      seen: [...seen].map(([uid, keys]) => [uid, [...keys].map(([key, ids]) => [key, [...ids]])]),
      masters: [...masters],
    };
  }
  const done = await inConnection(scope.db, scope.key, async ({ tx }) => {
    if (reading !== null && seen !== undefined && seen.size > 0)
      await markSeen(tx, scope, reading.generation, [...seen]);
    await tx
      .update(calCalendars)
      .set({ readCheckpoint: checkpoint === null ? null : JSON.stringify(checkpoint) })
      .where(calendarRow(scope));
  });
  return done === "gone" ? "gone" : undefined;
}

/** Mark existing rows even when their revisions did not change. The marks never enter the feed. */
async function markSeen(
  tx: Tx,
  scope: ProgressKey,
  generation: string,
  ids: readonly string[],
): Promise<void> {
  const names = ids.filter(storableKey);
  for (let offset = 0; offset < names.length; offset += 250) {
    await tx
      .update(calEvents)
      .set({ seenInReading: generation })
      .where(
        and(
          eq(calEvents.accountId, scope.key.accountId),
          eq(calEvents.calendarId, scope.calendarId),
          inArray(calEvents.providerId, names.slice(offset, offset + 250)),
          sql`${calEvents.seenInReading} is distinct from ${generation}::uuid`,
        ),
      );
  }
}

export function namesInPage(page: ChangePage): string[] {
  return [
    ...new Set([
      ...page.items.flatMap((item) => (item.kind === "upsert" || item.kind === "gone" ? [item.id] : [])),
      ...page.left.map((item) => item.id),
    ]),
  ];
}

/** Brent's cycle detection. A distinct continuation does not spend a finite overall page budget. */
export function advanceCycle(reading: OpenReading, next: string): OpenReading["cycle"] | null {
  if (next === reading.cursor) return null;
  const digest = createHash("sha256").update(next).digest("base64url");
  const cycle = { ...reading.cycle };
  if (digest === cycle.anchor) return null;
  cycle.steps += 1;
  if (cycle.steps === cycle.span) {
    cycle.anchor = digest;
    cycle.span *= 2;
    cycle.steps = 0;
  }
  return cycle;
}
