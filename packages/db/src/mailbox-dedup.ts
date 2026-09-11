import { sql, type SQL } from "drizzle-orm";

/**
 * DUPLICATE ACTIVE MAILBOXES — detected before the migrator runs, resolved by a human.
 *
 * ══ WHY THIS EXISTS OUTSIDE THE JOURNAL ═══════════════════════════════════════════════════
 *
 * Mail migration `0021_mailbox_address_unique` installs a partial unique index on
 * `(account_id, lower(address)) WHERE status <> 'disabled'`. `CREATE UNIQUE INDEX` fails
 * outright against data that already violates it, so the migration opens with a dedup prelude:
 * rank the duplicates, **keep the OLDEST**, disable the rest and delete their credentials.
 *
 * An independent review found that rule to be a data-loss hazard, and it is right. "Oldest" is
 * not evidence of health. The sequence is ordinary rather than exotic:
 *
 *   row A — created in March, credentials since expired, `status='error'`, last sync in April.
 *   row B — the user's working replacement: current credentials, `status='connected'`, syncing.
 *
 * The prelude keeps A, disables B, and DELETES B's credentials — which are envelope-encrypted
 * and not recoverable from anywhere else. The new index then refuses to let B be re-enabled
 * until A is disabled. The user's mail stops, and the migration reports success.
 *
 * ══ WHY A MIGRATION IS NOT THE FIX — THE ARGUMENT, WITH ITS LOOPHOLE NAMED ════════════════
 *
 * `0021` HAS ALREADY BEEN APPLIED to deployed databases and cannot be edited. The obvious next
 * move is a corrective migration, and the obvious reason it fails is: **an APPENDED entry always
 * runs too late.** drizzle 0.36.4 reads `max(created_at)` once and applies every entry above it,
 * so anything appended must sit above `0021`'s `when` to run on an already-migrated database at
 * all — and on the one population that matters (a populated database that has NOT taken `0021`
 * yet) the migrator therefore runs `0021` first, destroys the working row, and only then reaches
 * the correction.
 *
 * That argument is true only for APPENDED entries, and the qualifier matters, because there is
 * a loophole and it should be rejected on its merits rather than by an argument that overstates
 * itself. `readMigrationFiles` ignores `idx` and applies entries in journal ARRAY ORDER against
 * that single snapshot, so an entry INSERTED into the array before `0021`, with a `when` between
 * `0020`'s and `0021`'s, would run before `0021` on every pending database and be skipped on
 * every database that has already taken it. It is mechanically possible. It is still the wrong
 * answer:
 *
 *  · **SQL can only RAISE here, never resolve.** Choosing a survivor needs evidence a human
 *    weighs; a migration has no way to receive that. So the very best a guard migration buys is
 *    the fail-loud property this module already has, at a much higher price.
 *  · **The price is journal surgery.** Inserting mid-array means editing the sha-pinned scaffold
 *    (`POST_SPLIT_STATEMENTS`), four literal journal counts, and living with a permanent
 *    idx/tag anomaly — on the one artefact in this repository whose ordering being wrong is
 *    silent and permanent.
 *  · **Where it would beat this module, it is worse.** The only caller a TS guard misses is the
 *    Desktop local engine's own migrate loop, and a `RAISE` there bricks a stranger's local
 *    database with an error they cannot act on.
 *
 * And one fact strengthens the conclusion rather than the loophole: all pending entries apply
 * inside ONE transaction, so an appended corrective migration would run after the prelude in the
 * same transaction and could not even DETECT the destruction — a row the prelude disabled and
 * stripped is, by then, indistinguishable from a tombstone that was always there.
 *
 * So the resolution has to happen BEFORE the migrator, which is what this module is:
 * {@link assertNoActiveAddressDuplicates} is called by `runMigrations` ahead of the mail pass
 * and REFUSES to migrate a database whose duplicates `0021` would silently resolve, and
 * {@link resolveActiveAddressDuplicates} is the operator's tool for resolving them.
 *
 * **It does not cover every path into the mail journal, and that is stated rather than assumed.**
 * `runMigrations` is production's only route and the one ~30 real-Postgres test files take.
 * The in-memory test harness and `apps/sidecar/src/db.ts` compose `adoptBaseline` + `migrate`
 * themselves and never reach it. For the in-memory test database that is irrelevant (it is empty
 * every time). For the sidecar it is a real gap with an empty population — no desktop build
 * predating `0021` exists, so every local database is created with the index already in the
 * journal and the prelude runs against empty tables. The functions are exported from
 * `@trafficflow/db/admin`, the seam the sidecar already imports `JOURNALS` from, so wiring it in
 * is one line the next time that file is edited. This remaining gap is tracked as deferred work.
 *
 * ══ IT DOES NOT GUESS, AND THAT IS THE DESIGN ═════════════════════════════════════════════
 *
 * The obvious improvement — rank by credentials, then by `last_sync_at`, then by status — is
 * still a guess, and a guess that deletes a credential is the same class of defect at a better
 * hit rate. Every ordering has a case where it is wrong: a user who just re-entered a password
 * on the OLD row, a replacement created by a double-submit that never synced, two rows that
 * both work because the address is genuinely reachable twice. So the resolver reports the
 * EVIDENCE and requires the operator to name a keeper per group. This is a rare, manual,
 * one-database-at-a-time event; the cost of asking is a few minutes and the cost of guessing
 * is somebody's mailbox credential.
 */

/** The index `0021` installs. Its ABSENCE plus live duplicates is what the guard fires on. */
export const ACTIVE_ADDRESS_UQ = "mailboxes_active_address_uq";

/** Minimal structural interface, mirroring `setup-prod.ts` — no schema-type coupling. */
interface SqlExecutor {
  execute(query: SQL): Promise<unknown>;
}

async function rows<T>(db: SqlExecutor, query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

/**
 * One active mailbox row in a duplicate group, with the evidence a human needs to choose.
 *
 * Everything here is a count, a timestamp or a lifecycle string. No address content beyond the
 * address itself (which the operator must see to know what they are deciding about), and never
 * a credential — the presence of one is reported, its value is not read.
 */
export interface DuplicateMailbox {
  id: string;
  accountId: string;
  address: string;
  status: string;
  createdAt: Date;
  lastSyncAt: Date | null;
  /** Transports with a row in `mailbox_credentials` — `[]` means this row cannot sync at all. */
  transports: string[];
  /** Rows in `messages` attached to this mailbox: how much history it is carrying. */
  messages: number;
  /** `mailbox_folders` rows holding a CONDSTORE cursor: how much sync state it has built. */
  foldersWithCursor: number;
}

/** Active rows on one account sharing one `lower(address)` — always two or more. */
export interface DuplicateGroup {
  accountId: string;
  /** `lower(address)` — the key the index would build. */
  key: string;
  rows: DuplicateMailbox[];
}

interface RawRow {
  id: string;
  account_id: string;
  address: string;
  status: string;
  created_at: string | Date;
  last_sync_at: string | Date | null;
  key: string;
  transports: string[] | null;
  messages: number | string;
  folders_with_cursor: number | string;
}

const asDate = (v: string | Date): Date => (v instanceof Date ? v : new Date(v));

/**
 * Does this database even have the table to check? A virgin database (every unit test, every
 * fresh provision) has no `mailboxes` yet, so the guard costs one catalog lookup and stops.
 *
 * `status` is checked alongside it because the predicate is written in terms of that column:
 * a database old enough to predate migration 0007 has `mailboxes` without `status`, and the
 * guard must not turn that into a confusing error about a column instead of letting the
 * migrator do its job.
 */
async function checkable(db: SqlExecutor): Promise<boolean> {
  const found = await rows<{ n: number | string }>(
    db,
    sql`select count(*)::int as n from information_schema.columns
         where table_schema = 'public' and table_name = 'mailboxes' and column_name = 'status'`,
  );
  return Number(found[0]?.n ?? 0) > 0;
}

/** Is `0021`'s index already there? Then duplicates are impossible and there is nothing to do. */
export async function activeAddressIndexExists(db: SqlExecutor): Promise<boolean> {
  const found = await rows<{ n: number | string }>(
    db,
    sql`select count(*)::int as n from pg_indexes
         where schemaname = 'public' and indexname = ${ACTIVE_ADDRESS_UQ}`,
  );
  return Number(found[0]?.n ?? 0) > 0;
}

/**
 * Every group of active rows that share one `(account_id, lower(address))` — the exact key
 * `0021` builds, so this finds precisely what that migration would resolve.
 *
 * Returns `[]` on a database that has no `mailboxes` table yet.
 */
export async function findActiveAddressDuplicates(db: SqlExecutor): Promise<DuplicateGroup[]> {
  if (!(await checkable(db))) return [];

  const found = await rows<RawRow>(
    db,
    sql`
      with active as (
        select m.id, m.account_id, m.address, m.status, m.created_at, m.last_sync_at,
               lower(m.address) as key
          from mailboxes m
         where m.status <> 'disabled'
      ),
      dups as (
        select account_id, key from active group by account_id, key having count(*) > 1
      )
      select a.id, a.account_id, a.address, a.status, a.created_at, a.last_sync_at, a.key,
             coalesce(
               (select array_agg(c.transport order by c.transport)
                  from mailbox_credentials c where c.mailbox_id = a.id),
               '{}'::text[]
             ) as transports,
             (select count(*)::int from messages g where g.mailbox_id = a.id) as messages,
             (select count(*)::int from mailbox_folders f
               where f.mailbox_id = a.id and f.highestmodseq is not null) as folders_with_cursor
        from active a
        join dups d on d.account_id = a.account_id and d.key = a.key
       -- The SAME order 0021's prelude ranks by, so the row it WOULD have kept is the one
       -- printed first and an operator can see the choice they are being asked to override.
       order by a.account_id, a.key, a.created_at, a.id`,
  );

  const groups = new Map<string, DuplicateGroup>();
  for (const r of found) {
    const gk = `${r.account_id}${r.key}`;
    let g = groups.get(gk);
    if (!g) {
      g = { accountId: r.account_id, key: r.key, rows: [] };
      groups.set(gk, g);
    }
    g.rows.push({
      id: r.id,
      accountId: r.account_id,
      address: r.address,
      status: r.status,
      createdAt: asDate(r.created_at),
      lastSyncAt: r.last_sync_at === null ? null : asDate(r.last_sync_at),
      transports: r.transports ?? [],
      messages: Number(r.messages),
      foldersWithCursor: Number(r.folders_with_cursor),
    });
  }
  return [...groups.values()];
}

/** `3m` / `4h 12m` / `never` — the same shape `alerts.ts` prints, restated to keep this leaf. */
function age(now: Date, then: Date | null): string {
  if (!then) return "never";
  const s = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * The per-row evidence line. Counts, ages, lifecycle, and the PRESENCE of a credential — never
 * a secret, and never the address unless the caller asks.
 *
 * `withAddress` is off by default because of where the two renderings end up. The interactive
 * CLI is at the same trust level as the database and needs the address to make the decision
 * intelligible; {@link ActiveAddressDuplicatesError} surfaces in **deploy logs and CI output**,
 * which is not a place a customer's mailbox address belongs (a privacy invariant). Ids are enough
 * to act on there — the CLI prints the rest.
 */
export function describeRow(
  r: DuplicateMailbox, now: Date = new Date(), opts: { withAddress?: boolean } = {},
): string {
  const creds = r.transports.length > 0 ? r.transports.join(",") : "NONE";
  return (
    `${r.id}  status=${r.status.padEnd(9)}  created=${r.createdAt.toISOString()}  ` +
    `last-sync=${age(now, r.lastSyncAt).padEnd(10)}  credentials=${creds}  ` +
    `messages=${r.messages}  synced-folders=${r.foldersWithCursor}` +
    (opts.withAddress ? `  address=${r.address}` : "")
  );
}

/** The whole report, one block per group. See {@link describeRow} for why addresses are opt-in. */
export function describeDuplicates(
  groups: readonly DuplicateGroup[], now: Date = new Date(), opts: { withAddress?: boolean } = {},
): string {
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(
      `  account ${g.accountId}${opts.withAddress ? ` · address "${g.key}"` : ""} — ` +
        `${g.rows.length} active rows:`,
    );
    for (const r of g.rows) lines.push(`    · ${describeRow(r, now, opts)}`);
  }
  return lines.join("\n");
}

/**
 * Thrown by {@link assertNoActiveAddressDuplicates}. Carries the groups so an interactive caller
 * can re-render them in full; the MESSAGE names ids and counts only, because this one is read
 * out of a deploy log.
 */
export class ActiveAddressDuplicatesError extends Error {
  constructor(readonly groups: readonly DuplicateGroup[], now: Date = new Date()) {
    const n = groups.reduce((sum, g) => sum + g.rows.length, 0);
    super(
      `refusing to migrate: ${groups.length} duplicate mailbox address group(s) covering ${n} ` +
        `active rows already exist in this database.\n\n` +
        `Mail migration 0021_mailbox_address_unique would resolve them by KEEPING THE OLDEST row ` +
        `and deleting the others' credentials — irreversibly, and "oldest" is not evidence of ` +
        `health. Look at the rows below: if the oldest is the broken one, that migration would ` +
        `destroy the working mailbox and then block it from being re-enabled.\n\n` +
        `${describeDuplicates(groups, now)}\n\n` +
        `Addresses are omitted here on purpose — this message lands in deploy logs. Run the ` +
        `resolver to see them, decide which row survives in each group, and name it:\n` +
        `  DATABASE_URL_SESSION=… TF_PROD_DB_HOST=… pnpm db:mailboxes:dedup --keep <mailbox-id> …\n` +
        `then re-run the migration. Nothing has been changed.`,
    );
    this.name = "ActiveAddressDuplicatesError";
  }
}

/**
 * The pre-migration guard, called by `runMigrations` before the mail pass. Returns after ONE
 * catalog query when 0021's index already exists (duplicates are then unrepresentable), and after
 * two when there is no `mailboxes.status` column — every fresh provision and every PGlite unit
 * database. Both conditions are read from the CATALOG, never from `__drizzle_migrations`: a
 * database whose 0021 row exists but whose index somebody dropped by hand is exactly a database
 * that must be checked. It is a REFUSAL and not a repair, deliberately: a migration command that
 * silently fixed data would be the same defect as the prelude with better manners.
 */
export async function assertNoActiveAddressDuplicates(
  db: SqlExecutor, now: Date = new Date(),
): Promise<void> {
  if (await activeAddressIndexExists(db)) return;
  const groups = await findActiveAddressDuplicates(db);
  if (groups.length === 0) return;
  throw new ActiveAddressDuplicatesError(groups, now);
}

/** What {@link resolveActiveAddressDuplicates} did, per group. */
export interface ResolutionOutcome {
  accountId: string;
  key: string;
  kept: string;
  disabled: string[];
  credentialsDeleted: number;
}

/** A transaction-capable interface — the resolver's writes must be one unit. */
interface TxExecutor extends SqlExecutor {
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * Resolve every duplicate group, keeping EXACTLY the rows the caller named. It refuses before it
 * writes: every group covered by exactly one id in `keeps`, every id naming a row in some group —
 * anything else aborts with nothing written. Writer-safe: the re-read takes `SELECT … FOR UPDATE`
 * on every row before deciding, closing the race where a credential PATCH that read a loser
 * commits AFTER the row was disabled; `MailboxService.update` takes the same lock, so the two
 * serialize in either order. A concurrent `POST /mailboxes` can still create a brand-new
 * duplicate (an unborn row cannot be locked); the net is the guard re-running at the next
 * `runMigrations`. Rows are locked in `id` order so two resolver runs cannot deadlock.
 */
export async function resolveActiveAddressDuplicates(
  db: TxExecutor, keeps: readonly string[], now: Date = new Date(),
): Promise<ResolutionOutcome[]> {
  const groups = await findActiveAddressDuplicates(db);
  if (groups.length === 0) return [];

  return db.transaction(async (tx) => {
    // RE-READ UNDER A ROW LOCK. The list above is a snapshot taken outside the transaction —
    // useful for reporting, not for deciding. Everything below is decided on locked rows.
    const ids = groups.flatMap((g) => g.rows.map((r) => r.id));
    const locked = await rows<{ id: string; status: string }>(
      tx,
      sql`select id, status from mailboxes
           where id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})
           order by id
             for update`,
    );
    const lockedStatus = new Map(locked.map((r) => [r.id, r.status]));

    const problems: string[] = [];
    const plan: Array<{ group: DuplicateGroup; keep: string; losers: string[] }> = [];
    const claimed = new Set<string>();

    for (const g of groups) {
      // Anything that stopped being active while we waited for the lock is out of the group:
      // another operator, or the service, may have disabled it a moment ago.
      const live = g.rows.filter((r) => (lockedStatus.get(r.id) ?? "disabled") !== "disabled");
      if (live.length < 2) continue;
      const named = live.filter((r) => keeps.includes(r.id));
      if (named.length === 0) {
        problems.push(
          `account ${g.accountId} · "${g.key}": no --keep names any of its ${live.length} active rows ` +
            `(${live.map((r) => r.id).join(", ")})`,
        );
        continue;
      }
      if (named.length > 1) {
        problems.push(
          `account ${g.accountId} · "${g.key}": --keep names ${named.length} of its rows ` +
            `(${named.map((r) => r.id).join(", ")}); exactly one row per group may survive`,
        );
        continue;
      }
      for (const r of named) claimed.add(r.id);
      plan.push({ group: g, keep: named[0]!.id, losers: live.filter((r) => r.id !== named[0]!.id).map((r) => r.id) });
    }

    for (const k of keeps) {
      if (!claimed.has(k)) problems.push(`--keep ${k} does not name an active row in any duplicate group`);
    }

    if (problems.length > 0) {
      // Throwing inside the transaction rolls back the locks and every decision with them.
      throw new Error(
        `refusing to resolve — nothing has been changed:\n  - ${problems.join("\n  - ")}\n\n` +
          `The evidence for each group:\n${describeDuplicates(groups, now, { withAddress: true })}`,
      );
    }

    const out: ResolutionOutcome[] = [];
    for (const p of plan) {
      if (p.losers.length === 0) continue;
      const loserIds = sql.join(p.losers.map((i) => sql`${i}::uuid`), sql`, `);
      // Credentials FIRST, then the status flip: a crash between them leaves a still-active row
      // with no credential (the worker skips it, the user reconnects) rather than a disabled row
      // that holds one — which is the state the whole invariant is about.
      const deleted = await rows<{ mailbox_id: string }>(
        tx,
        sql`delete from mailbox_credentials where mailbox_id in (${loserIds}) returning mailbox_id`,
      );
      await tx.execute(sql`update mailboxes set status = 'disabled' where id in (${loserIds})`);
      out.push({
        accountId: p.group.accountId,
        key: p.group.key,
        kept: p.keep,
        disabled: p.losers,
        credentialsDeleted: deleted.length,
      });
    }
    return out;
  });
}
