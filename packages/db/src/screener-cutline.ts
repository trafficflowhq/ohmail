import { sql, type SQL } from "drizzle-orm";
import type { Dialect } from "./dialect/index.js";

/**
 * The cutline, as SQL — one implementation of "is this sender still worth a decision", for every
 * server-side reader. It lived only inside `consent-cutline.ts#cutlineCounts`, so `GET /consent`
 * counted WAITING senders through the cutline while `GET /screener` listed every sender with mail
 * in the folder — the queue offered senders whose newest mail was years old. In `db`, not
 * `services`: the auto-suggest pass is a reader and its closure is core + db; not `core`, because
 * it names two tables. Every construct is STORE-NEUTRAL: the phone runs this engine on the device
 * store, and no cutline test would refuse a Postgres-only spelling — every one is a Postgres
 * twin. Casts and timestamps go through the {@link Dialect}.
 */

/** Every folder the product presents. Activity is measured over all six. */
export const CUTLINE_PRESENTED_FOLDERS: readonly string[] = [
  "INBOX", "ohmail/Screener", "ohmail/Reads", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine",
];

/**
 * RE-DECLARED, not imported: `db` may not depend on `@trafficflow/core` (see
 * `screener-apply.ts`), which is where the product default lives. Pinned equal to core's and to
 * the client engine's copy by `consent-cutline.pg.test.ts` — three names, one value.
 */
export const CUTLINE_DEFAULT_DORMANCY_DAYS = 60;

/**
 * TRUE when any row in the group satisfies `cond` — the server's `bool_or`, spelled so both
 * stores accept it. The device store has no boolean aggregate and no boolean type; a predicate
 * aggregates as the largest of its 0/1 values. Exported so the three readers share ONE spelling
 * rather than each closing over its own copy.
 */
export function anyOf(cond: SQL): SQL {
  return sql`(max(case when ${cond} then 1 else 0 end) = 1)`;
}

/**
 * THE INSTANT THE CUTLINE DATES A MESSAGE BY — the `Date:` header, else the arrival.
 *
 * `Date:` is sender-written and nullable, so any stranger can send mail this column holds NULL
 * for; `created_at` is when the mailbox recorded the message, which nobody outside can withhold.
 * Both readers used the header alone, as did the client engine's `messageMs`: a message filed at
 * the gate a minute earlier presented under History — "hasn't written in a while" about mail that
 * had just arrived. Exported so the readers share one spelling; `coalesce` needs no dialect
 * member for {@link anyOf}'s reason, on the store's own timestamp type either side.
 */
export function cutlineInstant(c: { date: SQL; arrivedAt: SQL }): SQL {
  return sql`coalesce(${c.date}, ${c.arrivedAt})`;
}

export interface CutlineFacts {
  /** `account_settings.screening_baseline_at`, or null for an account that never decided. */
  baselineAt?: Date | null;
  /** `account_settings.dormancy_days`, or null for the product default. */
  dormancyDays?: number | null;
  /** `account_settings.screening_scope`. Anything but `'all_time'` is the window. */
  scope?: string | null;
  now: Date;
}

export interface ResolvedCutline {
  /** The backlog edge. Bound through {@link Dialect.ts}, never cast by hand. */
  cutoff: Date;
  /** Is a baseline in force? Decides WHICH unread term applies — never the cutoff. */
  baselined: boolean;
  /** `'all_time'`: every undecided sender is active whatever any date says. */
  allTime: boolean;
}

/**
 * Resolve the stored answers into the three facts the predicate needs.
 *
 * `baselined` is separate from the cutoff on purpose: with a baseline, unread mail counts only
 * inside the window; without one, any unread mail at all outranks age, which is the behaviour
 * every account had before the baseline column existed. An unparseable baseline reads as ABSENT
 * rather than as epoch 0 — a 1970 baseline would pin every sender in the queue for ever.
 */
export function resolveCutline(f: CutlineFacts): ResolvedCutline {
  const days = typeof f.dormancyDays === "number" && Number.isFinite(f.dormancyDays) && f.dormancyDays > 0
    ? f.dormancyDays
    : CUTLINE_DEFAULT_DORMANCY_DAYS;
  const baseMs = f.baselineAt == null ? null : f.baselineAt.getTime();
  const baselined = baseMs !== null && Number.isFinite(baseMs);
  const measuredFrom = baselined ? baseMs! : f.now.getTime();
  return {
    cutoff: new Date(measuredFrom - days * 24 * 60 * 60 * 1000),
    baselined,
    allTime: f.scope === "all_time",
  };
}

/**
 * The ACTIVE test over a sender's three aggregates, which is the whole rule.
 *
 * `newest` is the newest {@link cutlineInstant} in the group, so an undated message is weighed by
 * its arrival rather than read as "not recent". The null test stays because this builder does not
 * own the expression — a caller can hand it one that answers NULL, and a sender with no datable
 * mail at all must not read as active on a comparison against nothing. The comparison binds
 * through `d.ts`, so the instant is the STORE's own timestamp type on both arms.
 */
export function activeSenderExpr(
  d: Dialect,
  c: ResolvedCutline,
  a: { anyUnread: SQL; anyUnreadInWindow: SQL; newest: SQL },
): SQL {
  if (c.allTime) return sql`true`;
  const unread = c.baselined ? a.anyUnreadInWindow : a.anyUnread;
  return sql`(${unread} or (${a.newest} is not null and ${a.newest} >= ${d.ts(c.cutoff)}))`;
}

/**
 * IS THIS ROW'S SENDER STILL WORTH A DECISION — the correlated form a row-level reader needs.
 *
 * `senderExpr` is the outer query's already-lowercased address. The aggregates are recomputed per
 * sender inside the subquery rather than joined, so a caller adds one predicate and changes
 * nothing else about its query; `having` carries {@link activeSenderExpr} unchanged, which is what
 * makes this and the counts one rule rather than two that agree today.
 */
export function senderIsActiveSql(
  d: Dialect, accountId: string, senderExpr: SQL, c: ResolvedCutline,
): SQL {
  const folders = sql`(${sql.join(CUTLINE_PRESENTED_FOLDERS.map((f) => sql`${f}`), sql`, `)})`;
  const at = cutlineInstant({ date: sql`mc.date`, arrivedAt: sql`mc.created_at` });
  const active = activeSenderExpr(d, c, {
    anyUnread: anyOf(sql`mc.unread`),
    anyUnreadInWindow: anyOf(sql`mc.unread and ${at} is not null and ${at} >= ${d.ts(c.cutoff)}`),
    newest: sql`max(${at})`,
  });
  return sql`exists (
    select 1 from messages mc
      join folder_state fsc on fsc.message_id = mc.id
     where mc.account_id = ${d.castUuid(accountId)}
       and fsc.desired_folder in ${folders}
       and lower(mc.from_address) = ${senderExpr}
     group by lower(mc.from_address)
    having ${active}
  )`;
}
