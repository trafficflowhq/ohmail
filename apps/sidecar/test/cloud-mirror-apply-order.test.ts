import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import * as mail from "@trafficflow/db/mail";
import type { EntityType } from "@trafficflow/services/mail";
import { APPLY_ORDER } from "../src/cloud-mirror.js";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE APPLY ORDER IS A TOPOLOGICAL ORDER OF THE FOREIGN KEYS THE LOCAL STORE ENFORCES.
 *
 * The released 0.20.0 wedged every fresh paired desktop's first pull: mail 0118 gave `approvals`
 * a key into `routing_decisions`, and the hand-kept `APPLY_ORDER` applied approvals first, so the
 * page aborted on 23503 for ever. That key is declared in the migration and not in the drizzle
 * schema, so the pairs are read from the migrated store's own catalog — the constraints that
 * refuse the write. The one hand-kept fact is which tables each arm of `applyUpsert` writes.
 */

/** The tables each type's upsert writes. A thread stub written by the arm itself satisfies its key. */
const WRITES: Partial<Record<EntityType, readonly PgTable[]>> = {
  mailbox: [],
  mailbox_profile: [mail.mailboxProfileMirror],
  settings: [mail.accountSettings],
  folder: [mail.mailboxFolders],
  tag: [mail.tags],
  thread: [mail.threads],
  message: [mail.messages, mail.folderState, mail.messageTags, mail.awayReplies, mail.threads],
  message_state: [mail.messageStates],
  rule: [mail.rules],
  draft: [mail.drafts, mail.threads],
  routing_decision: [mail.routingDecisions],
  screener_suggestion: [mail.routingDecisions],
  approval: [mail.approvals],
  calendar_connection: [mail.calConnections],
  calendar: [mail.calCalendars, mail.calAlarms],
  calendar_event: [mail.calEvents, mail.calAttendees, mail.calAlarms],
  calendar_suggestion: [mail.calSuggestions],
};

/**
 * A key a type's rows always leave empty, so its holder need not come first: a calendar writes
 * its own default reminders, which name the calendar and never an event.
 */
const EMPTY_KEYS: Partial<Record<EntityType, ReadonlyArray<{ referrer: string; holder: string }>>> = {
  calendar: [{ referrer: "cal_alarms", holder: "cal_events" }],
};

interface Pair { referrer: string; holder: string }

/** Every referrer → holder table pair the migrated store enforces, self-references left out. */
async function storePairs(opened: OpenLocalDb): Promise<Pair[]> {
  const res = await opened.db.execute(sql`
    select distinct c.conrelid::regclass::text as referrer, c.confrelid::regclass::text as holder
    from pg_constraint c where c.contype = 'f' and c.conrelid <> c.confrelid`);
  return (res as unknown as { rows: Pair[] }).rows.map((r) => ({ referrer: r.referrer, holder: r.holder }));
}

/** Each place `order` applies a referrer before a type that writes its holder, by name. */
function violations(order: readonly EntityType[], pairs: readonly Pair[]): string[] {
  const writes = (type: EntityType): Set<string> => new Set((WRITES[type] ?? []).map((t) => getTableName(t)));
  const out: string[] = [];
  for (const [at, a] of order.entries()) {
    for (const { referrer, holder } of pairs) {
      if (!writes(a).has(referrer) || writes(a).has(holder)) continue;
      if ((EMPTY_KEYS[a] ?? []).some((k) => k.referrer === referrer && k.holder === holder)) continue;
      for (const b of order.slice(at + 1)) {
        if (writes(b).has(holder)) out.push(`${a} (${referrer}) is applied before ${b} (${holder})`);
      }
    }
  }
  return out;
}

describe("the Cloud mirror applies holders before referrers", () => {
  let opened: OpenLocalDb;
  let dataDir: string;
  let pairs: Pair[] = [];
  beforeAll(async () => {
    dataDir = await freshDataDir("ohmail-apply-order-");
    opened = await openLocalDb(dataDir);
    pairs = await storePairs(opened);
  }, 120_000);
  afterAll(async () => {
    await opened?.close().catch(() => undefined);
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("every type the order applies names the tables it writes, and nothing else is named", () => {
    expect([...APPLY_ORDER].sort()).toEqual(Object.keys(WRITES).sort());
  });

  it("the order is topological over the schema's foreign keys", () => {
    // Not vacuous: 0118's own key is among the pairs read, so a schema read that found nothing fails here.
    expect(pairs).toContainEqual({ referrer: "approvals", holder: "routing_decisions" });
    expect(violations(APPLY_ORDER, pairs)).toEqual([]);
  });

  it("applies a calendar's family parents first, and refuses an event ahead of its calendar", () => {
    // Not vacuous: the composite keys of the calendar's family are among the pairs read.
    expect(pairs).toContainEqual({ referrer: "cal_events", holder: "cal_calendars" });
    expect(pairs).toContainEqual({ referrer: "cal_calendars", holder: "cal_connections" });
    const order = [...APPLY_ORDER];
    const e = order.indexOf("calendar_event");
    const c = order.indexOf("calendar");
    [order[e], order[c]] = [order[c]!, order[e]!];
    expect(violations(order, pairs)).toContain("calendar_event (cal_events) is applied before calendar (cal_calendars)");
  });

  it("the census refuses the 0.20.0 order: approvals ahead of the decisions they name", () => {
    const order = [...APPLY_ORDER];
    const a = order.indexOf("approval");
    const d = order.indexOf("routing_decision");
    [order[a], order[d]] = [order[d]!, order[a]!];
    expect(violations(order, pairs)).toContain("approval (approvals) is applied before routing_decision (routing_decisions)");
  });
});
