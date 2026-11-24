/**
 * THE STORE'S SIDE OF THE PREVIEW BATCH'S CALENDAR-WRITES RUN: what that run reads of the
 * preview stack's database, and the one statement of its lost close. A program, not a test: the run
 * (`packages/cal-providers/test/cal-write-preview.live.ts`) starts it once for each verb, and the
 * dispatcher may too. It reads the stack's database from the preview's file named in
 * OHCAL_PREVIEW_ENV_FILE (never from an argument), and the account from the same file.
 *
 *   node apps/worker/test/cal-write-preview-rig.live.ts <verb> [arguments]
 *
 * It prints one line of JSON (the rows asked for: ids, states, words, invented titles) or, on a fault,
 * one line naming its code. Never an address, a password or a connection string.
 */
import { readFileSync } from "node:fs";
import postgres from "postgres";

const env = process.env.OHCAL_PREVIEW_ENV_FILE;
if (!env) {
  process.stderr.write("cal-write-preview-rig: the preview's file is not named\n");
  process.exit(2);
}
const found = new Map<string, string>();
for (const raw of readFileSync(env, "utf8").split("\n")) {
  const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(raw.trim());
  if (m) found.set(m[1]!, m[2]!);
}
const url = found.get("OHCAL_PREVIEW_DB_URL");
const account = found.get("OHCAL_PREVIEW_ACCOUNT_ID");
if (!url || !account) {
  process.stderr.write("cal-write-preview-rig: the preview's file names no database or no account\n");
  process.exit(2);
}

const db = postgres(url, { max: 1, onnotice: () => {} });
const [verb, ...args] = process.argv.slice(2);
const arg = (i: number): string => {
  const v = args[i];
  if (v === undefined || v === "") throw Object.assign(new Error("an argument is missing"), { code: "usage" });
  return v;
};

async function answer(): Promise<unknown> {
  switch (verb) {
    /** The account's calendars with their connection's provider word. */
    case "calendars":
      return db`select c.id, c.provider_id, c.connection_id, k.provider from cal_calendars c
        join cal_connections k on k.id = c.connection_id and k.account_id = c.account_id where c.account_id = ${account!}`;
    /** The write rows under one key. */
    case "row":
      return db`select id, state, refusal, attempts, event_id from cal_writes where account_id = ${account!} and idempotency_key = ${arg(0)}`;
    /** One event row, or null. */
    case "event": {
      const [e] = await db`select provider_id, version_tag, title, updated_at from cal_events where account_id = ${account!} and id = ${arg(0)}`;
      return e === undefined ? null : { ...e, updated_at: (e.updated_at as Date).toISOString() };
    }
    /** The event rows of one calendar under one title. */
    case "count": {
      const [n] = await db`select count(*)::int as n from cal_events where account_id = ${account!} and calendar_id = ${arg(0)} and title = ${arg(1)}`;
      return n!.n;
    }
    /** One calendar's next reading and its token. */
    case "calendar": {
      const [c] = await db`select next_poll_at, sync_token from cal_calendars where id = ${arg(0)} and account_id = ${account!}`;
      return c === undefined ? null : { next: (c.next_poll_at as Date | null)?.toISOString() ?? null, token: c.sync_token };
    }
    /** A calendar due now, its connection woken: answers the database's own now. */
    case "due": {
      const [c] = await db`update cal_calendars set next_poll_at = now() where id = ${arg(0)} and account_id = ${account!} returning now() as at`;
      await db`update cal_connections set next_poll_at = now() where id = ${arg(1)} and account_id = ${account!}`;
      return { at: (c!.at as Date).toISOString() };
    }
    /**
     * THE LOST CLOSE: an applied create set back to owed with its act (an applied row keeps none), its
     * event named by the write again, as if the provider took it and the store never heard; the
     * connection woken. Arguments: write id, event id, connection id, the payload as JSON.
     */
    case "lost-close":
      return db.begin(async (t) => {
        const payload = JSON.parse(arg(3)) as postgres.JSONValue;
        const back = await t`update cal_writes set state = 'pending', refusal = null, attempts = 0, next_attempt_at = null,
            payload = ${t.json(payload)}, updated_at = now()
          where id = ${arg(0)} and account_id = ${account!} and state = 'applied' returning id`;
        const named = await t`update cal_events set provider_id = ${`pending:${arg(0)}`}, uid = ${`pending:${arg(0)}`}, version_tag = null,
            updated_at = now() where id = ${arg(1)} and account_id = ${account!} returning id`;
        if (back.length !== 1 || named.length !== 1) throw Object.assign(new Error("not set up"), { code: "lost_close_not_set" });
        await t`update cal_connections set next_poll_at = now() where id = ${arg(2)} and account_id = ${account!}`;
        return { set: true };
      });
    /** Writes still owed whose event's title starts with the run's mark. */
    case "owed": {
      const [n] = await db`select count(*)::int as n from cal_writes w join cal_events e on e.id = w.event_id and e.account_id = w.account_id
        where w.account_id = ${account!} and w.state = 'pending' and starts_with(e.title, ${arg(0)})`;
      return n!.n;
    }
    default:
      throw Object.assign(new Error("no such verb"), { code: "usage" });
  }
}

try {
  process.stdout.write(`${JSON.stringify(await answer())}\n`);
  await db.end({ timeout: 5 });
} catch (err) {
  process.stderr.write(`cal-write-preview-rig: ${String((err as { code?: unknown }).code ?? "error")}\n`);
  await db.end({ timeout: 5 });
  process.exit(1);
}
