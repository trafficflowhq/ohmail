/**
 * THE ONE STATEMENT OF WHAT `ohmail_admin` MAY DO, and the query that asks Postgres
 * what it actually does.
 *
 * ## Why this module exists at all
 *
 * The first cut of this boundary shipped two halves that never met. `scripts/harden-staff-role.sql`
 * granted a column list; `test/staff-role.pg.test.ts` asserted a column list; and
 * `assertContentBlind` asked ONE question — `select subject from messages where false` — and
 * treated a single 42501 as proof of blindness. An external security review put it plainly:
 *
 * > Provision or drift a `DATABASE_URL_ADMIN` role so it lacks `SELECT(messages.subject)` but
 * > retains `SELECT(message_bodies.*)` […] the first staff request […] brands the connection
 * > `AdminDb`. The staff surface now runs on a handle that is not content-blind.
 *
 * A one-column oracle cannot answer "is this role content-blind"; only an enumeration can. So
 * the boot path now asks Postgres for the role's **entire effective capability set** and
 * compares it to {@link STAFF_SELECT_GRANTS} / {@link STAFF_TABLE_GRANTS} — the same
 * allowlist the pg guard compares against, imported, not copied. This repo has been bitten
 * twice by a constant that existed in two places (an error taxonomy, and the pooler
 * predicate); a privacy boundary is not the third.
 *
 * ## "Effective", and why that word is load-bearing
 *
 * {@link STAFF_CAPABILITY_SQL} is built out of `has_column_privilege` / `has_table_privilege`
 * / `pg_has_role`, not out of the ACL columns. That distinction is the entire point:
 * PostgreSQL has no negative grant, so a privilege can arrive from four places and a `REVOKE
 * … FROM ohmail_admin` only removes one of them.
 *
 *   · a direct grant                     — `REVOKE` removes it
 *   · a grant to a role it is a MEMBER of (including predefined `pg_read_all_data`)
 *   · a grant to `PUBLIC`
 *   · OWNERSHIP of the relation
 *
 * `has_column_privilege` returns true for all four. Verified against PostgreSQL 16 before this
 * module was written, because a census that silently missed one of them would be worse than
 * no census: it would be a green light nobody re-examines.
 *
 * ## Read-only, catalog-only, safe to name in an error
 *
 * Every value the query returns is a `pg_catalog` identifier — a schema, a relation, a column,
 * a role, a privilege verb. None of it is application data, so {@link describeCapability} can
 * be quoted verbatim into a log line or a `NotContentBlindError` without leaking anything.
 */

/** The role `scripts/harden-staff-role.sql` creates. One spelling, three consumers. */
export const STAFF_ROLE = "ohmail_admin";

/**
 * IS THE COLUMN-RESTRICTED ROLE LIVE IN PRODUCTION? — and the copy this word makes false the
 * day it flips.
 *
 * `scripts/harden-staff-role.sql` is a hand-run script; nothing provisions `ohmail_admin`
 * automatically, so today the database does NOT refuse mail columns to staff tooling — the
 * isolation is an APPLICATION property, and the FAQ and the privacy policy say exactly that,
 * in the honest direction. Two published claims rest on it:
 *
 *  · `apps/webapp/messages/en.json` q5 (a5): *"built and tested but not yet live"*, *"the
 *    database itself does not yet refuse those columns"*.
 *  · the product privacy policy, §5: *"not yet provisioned on our production
 *    database"*, *"an enforced property of the application, not of the database"*.
 *
 * The DAY `ohmail_admin` is provisioned in production BOTH become false-by-understatement — the
 * protection is now database-enforced and the copy still disclaims it. Claims are contracts:
 * a statement a shipping change makes false is fixed in the SAME change.
 *
 * So this flag is the provisioning DECLARATION, and flipping it to `true` is coupled to the
 * copy edit by two mechanisms, neither of them manual discipline:
 *
 *  1. `test/staff-role-copy-gate.test.ts` FAILS the build unless the flag and the
 *     two copy sites agree — false ⇒ the copy must still disclaim; true ⇒ the disclaimers must
 *     be gone. It is bidirectional, so neither the flag nor the copy can move without the other.
 *  2. `packages/db/src/provision-staff-role.ts` REFUSES `--apply` while this is `false`, so the
 *     production provisioning run itself cannot happen until the flag (and therefore the copy)
 *     has been updated in the same commit.
 *
 * Leave it `false` until the deploy that actually provisions the role, and flip it in that
 * deploy's commit alongside the two copy edits — never ahead of them, never after.
 */
export const STAFF_ROLE_LIVE_IN_PRODUCTION = false;

/**
 * The schemas the census ranges over: the application's own, plus the one the script creates
 * for its redaction views. A relation outside these two is not part of this application and
 * is covered by the SCHEMA half of the census instead — `ohmail_admin` may hold `USAGE` on
 * exactly these two and nothing else, so a new schema is unreachable until somebody says so.
 */
export const STAFF_SCHEMAS = ["public", "admin"] as const;

/**
 * EVERY relation schema `admin` may contain — the provisioning script's §12b census, widened
 * from one view to exactly two.
 *
 * `admin` is the schema `scripts/harden-staff-role.sql` creates, and it is FIRST on the staff
 * role's `search_path`. A review finding is why the census exists at all: a view reads its base
 * tables with the VIEW OWNER's privileges, so an `admin.mail_preview` over
 * `messages(subject, from_address)` answers with mail while every column grant in the script
 * stays exactly as narrow as it reads. Anything in this schema that nobody reviewed is a
 * content path around the whole slice, and it also SHADOWS the `public` relation of the same
 * name for this role.
 *
 * So the rule is an equality, not a subset: schema `admin` holds these relations and no
 * others. Three consumers, one list — the script's own §12b (which cannot import TypeScript
 * and therefore states it a second time, deliberately), the pre-flight in
 * `provision-staff-role.ts`, and the pg guard.
 *
 *  · `audit_log`     — `WHERE action LIKE 'admin.%'`, four named scalars, no jsonb bag.
 *  · `credit_ledger` — the money columns verbatim and a REDACTED `source`; see
 *                      {@link STAFF_SELECT_GRANTS} for what redaction means and why.
 */
export const STAFF_ADMIN_VIEWS = ["audit_log", "credit_ledger"] as const;

/**
 * Every column `ohmail_admin` may SELECT, keyed `schema.relation`.
 *
 * This is the SECOND independent statement of what `scripts/harden-staff-role.sql` grants —
 * deliberately spelled out rather than derived from the script, so that a diff in either one
 * is visible. Adding a column here without adding it to the script fails the pg guard's
 * strict-equality census; adding it to the script without adding it here fails the guard AND
 * refuses to boot. Both failures name the column.
 *
 * The rationale for each omission lives in the script, beside the GRANT it omits it from. Two
 * things are worth repeating here because they are the ones a future reader will want to "just
 * add": `messages.subject_tsv` reconstructs `subject` and `from_address` out of its lexemes,
 * and — since the row-existence finding below — the whole of `messages`, `change_log`, `folder_state` and `flag_state`,
 * whose absence is a ROW-EXISTENCE finding rather than a column one and therefore cannot be
 * partially conceded. See the block above `public.accounts`.
 */
export const STAFF_SELECT_GRANTS: Readonly<Record<string, readonly string[]>> = {
  // ── `public.messages` IS ABSENT, AND THE ABSENCE IS THE POINT (a row-existence oracle) ───
  //
  // It used to read `"public.messages": ["id", "mailbox_id"]` — a primary key and a foreign
  // key, the narrowest grant in the file, recorded during provisioning as a POSITIVE result.
  // The security review read the same line as the vulnerability and was right:
  //
  //   > … reads the current `messages.id` set (or just `count(*)`) for that `mailbox_id`. It
  //   > sends the chosen probe carrying the candidate RFC822 Message-ID, polls the same query,
  //   > and observes a new message row in that mailbox.
  //
  // The information is in the ROW'S EXISTENCE, not in a column, and `count(*)` names no column
  // — so no narrower column list closes it and only the absence of the relation does. The same
  // sentence retires `public.change_log`, `public.folder_state` and `public.flag_state`:
  // each is one row per message or per mutation, carrying a joinable id and an event time.
  //
  // Do not re-add any of the four to serve a console field. The three fields they served
  // (`MailboxHealth.pendingMoves`, `.oldestPendingMoveSeconds`, `AccountSummary.lastActivityAt`)
  // are now the honest nothing, and `packages/services/src/admin-service.ts` carries the whole
  // argument for why a bucketed replacement view cannot be built above a population of one
  // account and where the real replacement belongs.
  "public.accounts": ["id", "name", "ai_enabled", "created_at"],
  // Presence-is-state suspension (cloud migration 0008). TWO columns only: WHO is suspended and
  // SINCE WHEN, which is all the roster and the account page render. `suspended_by` (a staff id)
  // and `note` are deliberately NOT granted — no console screen shows them, and the WRITE that
  // records them runs on the runtime role, never this blind one. Widen this list in the same diff
  // that adds a projection, never ahead of one.
  "public.account_suspensions": ["account_id", "suspended_at"],
  "public.users": [
    "id", "account_id", "email", "display_name", "email_verified_at", "created_at",
  ],
  // `sync_blocked_reason` / `sync_blocked_since` (mail 0029) are the only thing that can explain a
  // `connected` mailbox with a growing `sync_lag` — a state an operator otherwise stares at with
  // no explanation — so the console projects them as a bucket distinct from `lastError`, and this
  // census has to name them or `assertContentBlind` refuses the very grant the console needs.
  //
  // They are the SAFEST columns on this list to hand staff: a CLOSED set of three
  // (`MAILBOX_SYNC_BLOCK_REASONS`) behind a CHECK constraint, so unlike `error_detail` — whose
  // safety rests on an allowlist applied at the write site — no value a mail server chose can reach
  // this column at all.
  //
  // `disabled_reason` and `takeover_authorized_at` (mail 0027) are deliberately still ABSENT:
  // `admin-service.ts` does not project them, and this list is what the console reads, not what the
  // table holds. Add them in the diff that adds the projection.
  "public.mailboxes": [
    "id", "account_id", "provider", "address", "created_at", "display_name", "status",
    "last_sync_at", "auth_kind", "error_code", "error_detail", "failed_at", "retry_count",
    "kickstart_at", "sync_blocked_reason", "sync_blocked_since",
  ],
  // PRESENCE ONLY: the composite primary key, and nothing that makes a mailbox connectable.
  "public.mailbox_credentials": ["mailbox_id", "transport"],
  // `public.folder_state`, `public.flag_state` and `public.change_log`: deliberately ABSENT. See
  // the block above `public.accounts`, and `scripts/harden-staff-role.sql` §7 and §8.
  "public.billing_customers": [
    "account_id", "stripe_customer_id", "email", "created_at", "updated_at",
  ],
  "public.billing_subscriptions": [
    "id", "account_id", "stripe_subscription_id", "stripe_price_id", "plan", "status",
    "mailbox_limit", "monthly_credits", "storage_bytes_limit", "current_period_start",
    "current_period_end", "cancel_at_period_end", "grace_until", "stripe_event_ts",
    // cloud 0022 — cadence and add-on quantities: subscription data by the isolation rule's own
    // words (staff see billing; the admin MRR and the at-cap alert now compose these).
    "billing_interval", "addon_storage_units", "addon_mailboxes",
    "created_at", "updated_at",
  ],
  // `account_storage` (mail 0062) — the stored-body byte counter. Usage data by the isolation
  // rule's own words (staff see billing and usage, never content): an id, a byte count, a
  // timestamp — nothing derived from what any message says. Granted because the alert pass
  // runs on this role and its `storage_at_cap` rule counts this table.
  "public.account_storage": ["account_id", "bytes", "updated_at"],
  "public.credit_balances": ["account_id", "balance", "updated_at"],
  // Minus `meta` — a bag that once had to be cleaned up after `pipeline.ts` wrote a Message-ID
  // into it — and minus `source`, which is the OTHER mail-derived column on this table.
  //
  // `source` is `classify:<mailbox>:<sha256(mid:<Message-ID>)[0:32]>` or
  // `draft:<message>:<sha256(<Idempotency-Key>)[0:32]>`. A digest of a GUESSABLE input is not
  // a redaction: hash a candidate Message-ID or a candidate subject and compare, and you have
  // confirmed that this account received that exact mail. That is inside the isolation rule
  // (staff may see billing and usage data, never anything derived from mail content), so the
  // column is un-granted here and history closes with the grant — no rewrite, no migration.
  "public.credit_ledger": [
    "id", "account_id", "delta", "balance_after", "reason", "created_at",
  ],
  // Minus `payload` — the raw Stripe event, which carries a customer's name and address.
  "public.billing_events": [
    "stripe_event_id", "type", "account_id", "event_ts", "received_at", "error", "status",
  ],
  // ── FUNNEL TOP — invite/waitlist DATES ONLY, so the admin console can see the signup funnel
  //    on an invite-only beta (task: admin funnel). Both tables were fully un-granted before,
  //    and the ONLY reason they are named now is that their whole point — how many invites are
  //    outstanding, how many people are waiting — is invisible without a count.
  //
  //    THE HARD BOUNDARY: these are COUNTS AND DATES, and no PII column is granted, not now and
  //    not "just the domain", ever. `invites.email` is the binding address of someone who is not
  //    a customer yet; `invites.code_hash` is a live invite secret; `waitlist.email` is a
  //    prospect's address; `waitlist.tier`/`source`/`note`/`issued_by`/`revoked_by`/`revoked_reason`
  //    are all either free text or identity and none is projected by the funnel. Every one of
  //    them is ABSENT here, and `staff-role.pg.test.ts` proves `invites.email` and `waitlist.email`
  //    still raise 42501 — the guard that keeps a later hand from widening this to PII.
  //
  //    `consumed_at` is the "accepted" date (an invite is accepted when it is consumed). The
  //    funnel reads issued/consumed/revoked as counts to show outstanding invites; it never
  //    joins these rows to an account or a person.
  "public.invites": ["created_at", "consumed_at", "revoked_at"],
  "public.waitlist": ["created_at", "invited_at"],
  "public.worker_heartbeats": [
    "shard_index", "instance_id", "leader", "shards", "mailboxes", "expected", "accounts",
    "quarantined", "degraded", "last_cycle_at", "started_at", "beat_at",
  ],
  // NOT `idempotency_key` (the client's header, verbatim), NOT the two Message-IDs, NOT
  // `draft_id` (a handle onto draft content).
  "public.outbound_sends": ["id", "account_id", "status", "created_at"],
  "public.alert_state": [
    "alert_key", "kind", "severity", "opened_at", "last_seen_at", "notified_at",
    "notify_count", "detail",
  ],
  // The `security_barrier` view, and the ONLY route to `audit_log`. Four named scalars: no
  // `payload`, no `inverse`. The bags are never granted, in any shape.
  "admin.audit_log": ["id", "account_id", "action", "created_at"],
  // The ONLY route to a ledger `source`, and the column is REDACTED in the view rather
  // than projected. Six money columns verbatim; `source` keeps its NAMESPACE TOKEN and nothing
  // else, because a namespace token is a literal from `ledgerSources` and everything after it
  // is a value.
  //
  // The redaction is DENY-BY-DEFAULT: five namespaces (`invoice:`, `expiry:`, `propose:`,
  // `workflow_run:`, `admin:`, each also accepted under a `refund:` wrapper) pass through
  // verbatim because every one of them is a Stripe id, one of our own uuids or a timestamp;
  // EVERYTHING ELSE is truncated. That is not fussiness about a hypothetical: today it is what
  // catches `refund:classify:%` and `refund:draft:%`, which embed the original digest whole
  // (`ledgerSources.refund`, `credits.ts:208`) and which a redaction written as
  // "truncate `classify:%` and `draft:%`" would have passed through intact — a finished-looking
  // view with the oracle completely re-opened. Tomorrow it is what catches namespace nine.
  //
  // **The truncation was widened from the last `:`-segment to everything after the namespace**
  // after review. Dropping only the final segment left `draft:<message UUID>:` and
  // `classify:<mailbox UUID>:` standing, and both of those uuids are database identifiers —
  // `messages.id` and `mailboxes.id`. The rule is now stated on what SURVIVES rather than on
  // what is removed, which is the only form of it that a new namespace cannot slip past.
  "admin.credit_ledger": [
    "id", "account_id", "delta", "balance_after", "reason", "source", "created_at",
  ],
};

/**
 * Every TABLE-level privilege `ohmail_admin` may hold, keyed `schema.relation`.
 *
 * `has_table_privilege` deliberately ignores column-level grants (verified on PG 16), so a
 * `SELECT` row in the census means somebody wrote `GRANT SELECT ON <table>` without a column
 * list — the exact "for support" incident the script exists to undo, and the one that would
 * silently extend to whatever column the next migration adds. It is allowed on precisely the
 * two VIEWS in {@link STAFF_ADMIN_VIEWS}, whose column lists are fixed by their own
 * definitions and cannot grow when a migration adds a column to a base table.
 *
 * `alert_state` is the one table this role writes, and `DELETE` is the ONLY table-level verb it
 * may hold on it. `runAlertPass` resolves an alert by deleting its row — without `DELETE` every
 * clearing alert raises 42501 and the pass 503s exactly as the incident ends — and Postgres has
 * no column-scoped DELETE, so that verb has nowhere narrower to go.
 *
 * INSERT and UPDATE moved to {@link STAFF_SELECT_GRANTS}'s eight columns and are therefore
 * ABSENT here on purpose. The table-level pair granted nothing extra today (the SELECT list
 * already names every column the table has) and everything tomorrow: the next migration to add a
 * column would make it writable by this blind role automatically while leaving it unreadable.
 * Because this census is an equality in both directions, a re-widened `GRANT INSERT ON
 * public.alert_state` now FAILS rather than being silently permitted.
 */
export const STAFF_TABLE_GRANTS: Readonly<Record<string, readonly string[]>> = {
  "public.alert_state": ["DELETE"],
  "admin.audit_log": ["SELECT"],
  "admin.credit_ledger": ["SELECT"],
};

/** Schema-level privileges. `USAGE` on the two application schemas. Never `CREATE`, anywhere. */
export const STAFF_SCHEMA_GRANTS: Readonly<Record<string, readonly string[]>> = {
  public: ["USAGE"],
  admin: ["USAGE"],
};

/**
 * One row of the census. `kind` says which question was asked; `subject` and `detail` are
 * catalog identifiers only.
 *
 *  · `column`    — `subject` is `schema.relation`, `detail` a column with effective SELECT
 *  · `table`     — `subject` is `schema.relation`, `detail` a table-level privilege verb
 *  · `sequence`  — a sequence privilege. There is no legitimate one.
 *  · `schema`    — `subject` is a schema, `detail` `USAGE` or `CREATE`
 *  · `role`      — `subject` is a role this role is a MEMBER of. There is no legitimate one.
 *  · `attribute` — `subject` is a role attribute that is set and must not be
 *  · `owns`      — `subject` is an application relation this role OWNS
 *  · `secdef`    — `subject` is an executable SECURITY DEFINER routine, which runs as its
 *                  owner and is therefore a hole straight through every grant above
 *  · `session`   — `subject` is `session_user`, `detail` is `current_user`, emitted only when
 *                  they DIFFER. There is no legitimate one: the staff connection logs
 *                  in as `ohmail_admin` directly, and any wrapper arrangement means an
 *                  unprivileged `SET ROLE NONE` recovers the session role's own capabilities
 */
export interface StaffCapability {
  readonly kind: string;
  readonly subject: string;
  readonly detail: string;
}

const SCHEMA_LIST = STAFF_SCHEMAS.map((s) => `'${s}'`).join(", ");

/**
 * THE CENSUS. One statement, one round trip, and it asks about **both of the connection's
 * identities** — `current_user` AND `session_user` — so the answer is the connection's own,
 * not a claim made on its behalf by a privileged observer, and not a claim made by a costume.
 *
 * ── WHY `session_user` IS IN EVERY PREDICATE ───────────────────────────────────────────────
 *
 * The census used to key every question on `current_user` alone. That attests the role the
 * connection is WEARING, not the role it IS: a login role with `ALTER ROLE … SET role =
 * ohmail_admin` connects with `current_user = ohmail_admin` (blind — every bite refuses, the
 * census matches the allowlist exactly) while `session_user` remains the wrapper, and one
 * `SET ROLE NONE` — which needs no privilege at all — recovers the wrapper's own capabilities
 * on the same attested connection. A `DATABASE_URL_ADMIN` handed out as "blind" would not be.
 *
 * So `me` now enumerates BOTH identities (one row when they agree, which is the only
 * legitimate state), every `has_*_privilege` / `pg_has_role` / ownership / attribute question
 * is asked of each — whatever `SET ROLE NONE` could recover is precisely `session_user`'s
 * effective privilege set, so guarding SET ROLE is a matter of enumerating it, not of trying
 * to intercept the statement — and a dedicated `session` row names the mismatch itself, so
 * the headline failure reads as one line rather than as a pile of the wrapper's columns.
 * Membership checks over `pg_roles` cover the predefined roles (`pg_read_all_data` and kin)
 * for both identities, because they are ordinary `pg_roles` rows. For the legitimate direct
 * `ohmail_admin` login the two identities coincide, `me` is one row, and the census is
 * byte-identical in cost and result to the single-identity version.
 *
 * `pg_catalog` is world-readable, which matters: `information_schema` filters its rows BY the
 * caller's privileges, so a role asking it about itself sees only what it already has and
 * could never discover a relation it must not reach. The enumeration therefore comes from
 * `pg_class`/`pg_attribute` and the PRIVILEGE comes from `has_*_privilege`.
 *
 * `WHERE false` is not needed and not possible here: nothing in this query reads an
 * application row. It is catalog scans and privilege lookups, all of them cached in the
 * backend's syscache after the first.
 */
export const STAFF_CAPABILITY_SQL = `
with me as (
  select r.oid, r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb,
         r.rolreplication
    from pg_catalog.pg_roles r
   where r.rolname in (current_user, session_user)
),
rel as (
  select c.oid, n.nspname, c.relname, c.relkind, c.relowner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname in (${SCHEMA_LIST})
     and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
)
select distinct kind, subject, detail from (
select 'column' as kind,
       rel.nspname || '.' || rel.relname as subject,
       a.attname::text as detail
  from rel
  join pg_catalog.pg_attribute a
    on a.attrelid = rel.oid and a.attnum > 0 and not a.attisdropped
  cross join me
 where rel.relkind <> 'S'
   and has_column_privilege(me.oid, rel.oid, a.attnum, 'SELECT')
union all
select 'table', rel.nspname || '.' || rel.relname, p.priv
  from rel
  cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
       as p(priv)
  cross join me
 where rel.relkind <> 'S'
   and has_table_privilege(me.oid, rel.oid, p.priv)
union all
select 'sequence', rel.nspname || '.' || rel.relname, p.priv
  from rel
  cross join unnest(array['SELECT','UPDATE','USAGE']) as p(priv)
  cross join me
 where rel.relkind = 'S'
   and has_sequence_privilege(me.oid, rel.oid, p.priv)
union all
select 'owns', rel.nspname || '.' || rel.relname, rel.relkind::text
  from rel, me
 where rel.relowner = me.oid
union all
select 'schema', n.nspname::text, p.priv
  from pg_catalog.pg_namespace n
  cross join unnest(array['USAGE','CREATE']) as p(priv)
  cross join me
 where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
   and n.nspname not like 'pg\\_temp\\_%'
   and n.nspname not like 'pg\\_toast\\_temp\\_%'
   and has_schema_privilege(me.oid, n.oid, p.priv)
union all
select 'role', g.rolname::text, ''
  from pg_catalog.pg_roles g, me
 where g.oid <> me.oid
   and pg_has_role(me.oid, g.oid, 'MEMBER')
union all
select 'attribute', x.attr, ''
  from me,
       lateral (values ('SUPERUSER', me.rolsuper),
                       ('BYPASSRLS', me.rolbypassrls),
                       ('CREATEROLE', me.rolcreaterole),
                       ('CREATEDB', me.rolcreatedb),
                       ('REPLICATION', me.rolreplication)) as x(attr, held)
 where x.held
union all
select 'secdef',
       n.nspname || '.' || p.proname
         || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
       ''
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  cross join me
 where p.prosecdef
   and n.nspname in (${SCHEMA_LIST})
   and has_function_privilege(me.oid, p.oid, 'EXECUTE')
union all
select 'session', session_user::text, current_user::text
 where session_user <> current_user
) capabilities
order by 1, 2, 3`;

/** A capability as one line of prose. Catalog identifiers only — safe in a log or an error. */
export function describeCapability(c: StaffCapability): string {
  switch (c.kind) {
    case "column": return `SELECT on ${c.subject}.${c.detail}`;
    case "table": return `table-level ${c.detail} on ${c.subject}`;
    case "sequence": return `${c.detail} on sequence ${c.subject}`;
    case "schema": return `${c.detail} on schema ${c.subject}`;
    case "role": return `MEMBER of role ${c.subject}`;
    case "attribute": return `role attribute ${c.subject}`;
    case "owns": return `OWNS relation ${c.subject}`;
    case "secdef": return `EXECUTE on SECURITY DEFINER routine ${c.subject}`;
    case "session":
      return `connected as SESSION role ${c.subject} wearing ${c.detail} — SET ROLE NONE recovers ${c.subject}`;
    default: return `${c.kind} ${c.subject} ${c.detail}`.trim();
  }
}

/** Coerce one driver row into a {@link StaffCapability}. Unknown shapes become empty strings. */
function asCapability(row: unknown): StaffCapability {
  const r = row as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
  return { kind: str(r?.kind), subject: str(r?.subject), detail: str(r?.detail) };
}

/** Coerce a driver result set. postgres-js hands back an array; drizzle may wrap it. */
export function asCapabilities(rows: unknown): StaffCapability[] {
  const list = Array.isArray(rows)
    ? rows
    : Array.isArray((rows as { rows?: unknown[] })?.rows)
      ? (rows as { rows: unknown[] }).rows
      : [];
  return list.map(asCapability);
}

function allowed(c: StaffCapability): boolean {
  switch (c.kind) {
    case "column": return (STAFF_SELECT_GRANTS[c.subject] ?? []).includes(c.detail);
    case "table": return (STAFF_TABLE_GRANTS[c.subject] ?? []).includes(c.detail);
    case "schema": return (STAFF_SCHEMA_GRANTS[c.subject] ?? []).includes(c.detail);
    // `sequence`, `role`, `attribute`, `owns`, `secdef`: the allowlist for every one of these
    // is EMPTY, and it is empty by construction rather than by a lookup that could be widened.
    default: return false;
  }
}

/**
 * Every capability the connected role holds that the allowlist does not name.
 *
 * **This is the direction that fails closed.** An EXCESS is a privacy defect and must refuse
 * the brand; a SHORTFALL is a broken console, which announces itself at the first query with
 * a 42501 an operator can read. Making a boot attestation refuse on a shortfall would mean a
 * migration that drops one allowlisted column takes the whole staff surface down — a safety
 * mechanism whose failure mode is an outage gets disabled, and then there is no attestation
 * at all. The pg guard asserts EQUALITY, where drift must be caught and nothing is down.
 */
export function staffCapabilityExcess(rows: readonly StaffCapability[]): StaffCapability[] {
  return rows.filter((c) => !allowed(c));
}

/**
 * Every allowlisted capability the connected role does NOT hold. The pg guard's half; see
 * {@link staffCapabilityExcess} for why the boot path deliberately does not refuse on these.
 */
export function staffCapabilityShortfall(rows: readonly StaffCapability[]): string[] {
  const held = new Set(rows.map((c) => `${c.kind}${c.subject}${c.detail}`));
  const missing: string[] = [];
  const want = (kind: string, table: Readonly<Record<string, readonly string[]>>): void => {
    for (const [subject, details] of Object.entries(table)) {
      for (const detail of details) {
        if (!held.has(`${kind}${subject}${detail}`)) {
          missing.push(describeCapability({ kind, subject, detail }));
        }
      }
    }
  };
  want("column", STAFF_SELECT_GRANTS);
  want("table", STAFF_TABLE_GRANTS);
  want("schema", STAFF_SCHEMA_GRANTS);
  return missing;
}
