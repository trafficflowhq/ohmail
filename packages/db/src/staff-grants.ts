/**
 * The ONE statement of what `ohmail_admin` may do, and the query that asks Postgres what it
 * actually does. The first cut asked ONE question — a single 42501 as proof of blindness — and a
 * one-column oracle cannot answer "is this role content-blind"; only an enumeration can. The boot
 * path asks for the role's ENTIRE effective capability set and compares it to the same allowlist
 * the pg guard uses. "Effective" is load-bearing: the census uses
 * `has_column_privilege`/`pg_has_role`, not ACL columns — Postgres has no negative grant; a
 * privilege can arrive from a direct grant, membership, `PUBLIC`, or OWNERSHIP, and
 * `has_column_privilege` covers all four. Every value returned is a catalog identifier.
 */

/** The role `scripts/harden-staff-role.sql` creates. One spelling, three consumers. */
export const STAFF_ROLE = "ohmail_admin";

/**
 * Is the column-restricted role LIVE in production? — and the copy this word makes false the day
 * it flips. The harden script is hand-run; nothing provisions `ohmail_admin` automatically, so
 * today the isolation is an APPLICATION property, and the FAQ and privacy policy say exactly
 * that. The day the role is provisioned, both become false-by-understatement. Claims are
 * contracts: a statement a shipping change makes false is fixed in the SAME change. Two
 * mechanisms couple the flag to the copy: `test/staff-role-copy-gate.test.ts` fails unless the
 * flag and the two copy sites agree, and `provision-staff-role.ts` refuses `--apply` while this
 * is `false`. Flip it in the deploy that provisions the role — never ahead, never after.
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
 * Every relation schema `admin` may contain — the provisioning script's §12b census. `admin` is
 * the schema the harden script creates, FIRST on the staff role's `search_path`. The census
 * exists because a view reads its base tables with the VIEW OWNER's privileges: an
 * `admin.mail_preview` over message columns answers with mail while every column grant stays as
 * narrow as it reads — anything here nobody reviewed is a content path around the whole boundary,
 * and it SHADOWS the `public` relation of the same name. The rule is an EQUALITY: schema `admin`
 * holds these relations and no others. Three consumers, one list: the script's own §12b (which
 * cannot import TypeScript and states it again, deliberately), the pre-flight, and the pg guard.
 */
export const STAFF_ADMIN_VIEWS = ["audit_log"] as const;

/**
 * Every column `ohmail_admin` may SELECT, keyed `schema.relation`. The SECOND independent
 * statement of what the harden script grants — spelled out rather than derived, so a diff in
 * either is visible: a column added here without the script fails the pg guard's strict-equality
 * census; the script without here fails the guard AND refuses to boot. The rationale for each
 * omission lives in the script. Two worth repeating: `messages.subject_tsv` reconstructs
 * `subject` and `from_address` out of its lexemes, and the whole of `messages`, `change_log`,
 * `folder_state` and `flag_state` are absent as a ROW-EXISTENCE finding, which cannot be
 * partially conceded — see the block above `public.accounts`.
 */
export const STAFF_SELECT_GRANTS: Readonly<Record<string, readonly string[]>> = {
  // `public.messages` is ABSENT, and the absence is the point — a row-existence oracle. It used
  // to read `["id", "mailbox_id"]`, the narrowest grant in the file, and that exact line was the
  // vulnerability: read the row set (or `count(*)`) for a mailbox, send a probe carrying a
  // candidate Message-ID, poll, and observe a new row — delivery confirmed to a named mailbox.
  // The information is in the ROW'S EXISTENCE, not a column, and `count(*)` names no column, so
  // no narrower list closes it; only the absence of the relation does. The same sentence retires
  // `public.change_log`, `public.folder_state` and `public.flag_state`: each is one row per
  // message or mutation with a joinable id and an event time. Do not re-add any of the four to
  // serve a console field — the fields they served are now the honest nothing, and
  // `admin-service.ts` carries the argument for where the real replacement belongs.
  "public.accounts": ["id", "name", "ai_enabled", "created_at"],
  "public.users": [
    "id", "account_id", "email", "display_name", "email_verified_at", "created_at",
  ],
  // `sync_blocked_reason` / `sync_blocked_since` (mail 0029) are the only thing that can explain
  // a `connected` mailbox with a growing `sync_lag` — a state an operator otherwise stares at
  // with no explanation — so the console projects them as a bucket distinct from `lastError`, and
  // this census must name them or `assertContentBlind` refuses the very grant the console needs.
  // The SAFEST columns on this list: a CLOSED set behind a CHECK constraint, so unlike
  // `error_detail` — whose safety rests on a write-site allowlist — no value a mail server chose
  // can reach the column at all. `disabled_reason` and `takeover_authorized_at` are deliberately
  // still ABSENT: `admin-service.ts` does not project them, and this list is what the console
  // reads, not what the table holds. Add them in the diff that adds the projection.
  "public.mailboxes": [
    "id", "account_id", "provider", "address", "created_at", "display_name", "status",
    "last_sync_at", "auth_kind", "error_code", "error_detail", "failed_at", "retry_count",
    "kickstart_at", "sync_blocked_reason", "sync_blocked_since",
  ],
  // PRESENCE ONLY: the composite primary key, and nothing that makes a mailbox connectable.
  "public.mailbox_credentials": ["mailbox_id", "transport"],
  // THE SYNC-STALENESS ALERTS' INPUTS (mail 0064 + 0070). Reliability data by the isolation
  // rule's own words — ids, kinds and timestamps, the same class as `mailboxes.last_sync_at`
  // four entries up. Deliberately NOT `label` (user-chosen text) and NOT `ip`.
  //
  // `devices.created_at` joined for the never-synced arm (a NULL stamp is measured from the
  // pairing itself). `sessions` widened from the original two columns to what the
  // `session_sync_stale` rule reads: its own id (the alert key), the account (the moved-on
  // gate), `scope` (a CHECK-constrained two-value token), and the two timestamps whose spread
  // IS the alarm ("still requesting, not converging"). Never a token column, never a hash;
  // the presence and recency of a session row are not content.
  "public.devices": ["id", "account_id", "kind", "created_at", "last_synced_at"],
  "public.sessions": [
    "id", "account_id", "device_id", "scope", "revoked_at", "last_seen_at", "last_synced_at",
  ],
  // THE REUSE-REVOCATION ALERT'S INPUT and the admin account view's security row. Event NAMES
  // and timestamps only — the `event` vocabulary is a closed application set (`AuthAuditEvent`),
  // written exclusively by `AuthService.audit`. Deliberately NOT `ip` and NOT `device`: `device`
  // carries a client-chosen User-Agent string (or, on the reuse row, the family id) — foreign
  // input by the same argument that keeps `devices.label` off this list. Not `method` either;
  // no rule reads it, and the narrowest grant that serves the reader is the rule here.
  "public.auth_events": ["id", "account_id", "user_id", "event", "at"],
  // `public.folder_state`, `public.flag_state` and `public.change_log`: deliberately ABSENT. See
  // the block above `public.accounts`, and `scripts/harden-staff-role.sql` §7 and §8.
  // `account_storage` (mail 0062) — the stored-body byte counter. Usage data by the isolation
  // rule's own words (staff see usage, never content): an id, a byte count, a
  // timestamp — nothing derived from what any message says. Granted because the alert pass
  // runs on this role and its `storage_at_cap` rule counts this table.
  "public.account_storage": ["account_id", "bytes", "updated_at"],
  // Funnel top — invite/waitlist DATES ONLY, so the console can see the signup funnel on an
  // invite-only beta. Both tables were fully un-granted; the only reason they are named now is
  // that their whole point — how many invites outstanding, how many waiting — is invisible
  // without a count. THE HARD BOUNDARY: counts and dates, and no PII column is granted, not now
  // and not "just the domain", ever. `invites.email` is the binding address of someone who is not
  // a customer yet; `invites.code_hash` is a live invite secret; `waitlist.email` is a prospect's
  // address; the free-text and identity columns are all absent, and `staff-role.pg.test.ts`
  // proves the two email columns still raise 42501 — the guard that keeps a later hand from
  // widening this to PII. `consumed_at` is the "accepted" date; the funnel reads counts and never
  // joins these rows to a person.
  "public.invites": ["created_at", "consumed_at", "revoked_at"],
  "public.waitlist": ["created_at", "invited_at"],
  "public.worker_heartbeats": [
    "shard_index", "instance_id", "leader", "shards", "mailboxes", "expected", "accounts",
    // `ai_circuit_open_since` (cloud 0030): when this worker's classifier circuit first opened
    // in its current unbroken run of trips, NULL while closed. A timestamp the worker computes
    // from its own in-process fault counter — no mailbox, no account, no model call — and the
    // only evidence in this database that mail is being filed rules-only.
    // `degraded_since` (cloud 0030): when the leader first reported itself degraded in the
    // current unbroken run, NULL while healthy. A timestamp about the PROCESS, on its
    // neighbour's exact terms — no mailbox, no account, nothing a message carried — and the
    // console renders its age beside the flag so an operator can tell a boot from a fault.
    "quarantined", "degraded", "ai_circuit_open_since", "degraded_since",
    "last_cycle_at", "started_at", "beat_at",
  ],
  // NOT `idempotency_key` (the client's header, verbatim), NOT the two Message-IDs, NOT
  // `draft_id` (a handle onto draft content).
  "public.outbound_sends": ["id", "account_id", "status", "created_at"],
  "public.alert_state": [
    "alert_key", "kind", "severity", "opened_at", "last_seen_at", "notified_at",
    "notify_count", "detail",
    // When the alert was resolved (cloud 0030), NULL while it is open. The blind role must READ
    // and WRITE it: resolution marks rather than deletes — an insert cannot be fenced against a
    // row that is not there — and the API driver runs that pass over exactly this role, so a
    // grant list without it is 42501 on every external resolution.
    "resolved_at",
    // The renotify policy's condition signature (cloud 0025) — composed by `alerts.ts` itself
    // from an alert's severity and count, never from content. The blind role must read AND
    // write it: `runAlertPass`'s claim names the column, and the API driver — the sole
    // observer of `worker_down` — runs that pass over exactly this role, so a grant list
    // without it is 42501 on every external pass, which is the pager's second arm dying the
    // moment the column ships. The three-place decision the harden script demands: here,
    // `harden-staff-role.sql`'s three column-scoped grants, and the census equality.
    "notified_signature",
    // The notify claim's lease (cloud 0026) — a timestamp `alerts.ts` computes, carrying
    // nothing but "a page for this key is in flight until then". Same three-place decision,
    // same reason: the claim's SELECT and UPDATE both name it.
    "claimed_until",
    // The incident/signal split (cloud 0030). `cls` decides DELIVERY, so the blind role must read
    // AND write it, for `notified_signature`'s reason: the API driver runs the whole pass over
    // exactly this role, and a grant list without the column is 42501 on every external pass —
    // the pager's second arm dying the moment the column ships. `affected_accounts` is a COUNT
    // and `fix_href` is an internal console path this repository composes; neither derives from
    // what any message says. `title` and `count` are what the RULE said — a sentence composed
    // from counts and ages in `alerts.ts`, and an integer — granted because the console renders
    // both, persisted because two rules are driver-keyed and one role-keyed, so a blind read can
    // only get them from the row.
    "cls", "affected_accounts", "fix_href", "title", "count",
  ],
  // The alerting's own pulse (cloud 0030). Granted WHOLE, and there is nothing on the table that
  // could not be: a driver word from a two-value CHECK, a timestamp and four counts — no
  // `account_id` and no possibility of one; the row is a fact about a PROCESS. The blind role
  // writes this table as well as reading it, on `alert_state`'s exact argument: the API host's
  // driver runs its pass over this role, and its pass is one of the two whose absence the paired
  // rule exists to notice — a read-only grant would mean the arm hardest to observe is the one
  // that never records itself. `failed_sinks` is a COUNT, deliberately not the names: a sink name
  // is a vendor endpoint's identity and belongs in the log line where a drain gates it.
  "public.alert_pass_runs": [
    // `sinks_configured` is a COUNT of arms, never their names — a sink name is a vendor
    // endpoint's identity and belongs in the log line where a drain gates it. Zero is the
    // finding: an arm with no sinks cannot page, and no other column on this row can say so.
    "driver", "ran_at", "firing", "delivered", "failed_sinks", "sink_failure_streak",
    "sinks_configured",
  ],
  // What the platform served (cloud 0030). Granted whole for `platform_costs`'s reason one table
  // over: this is what a VENDOR did, not what a customer did. `project` is a deployment name this
  // repository chooses; `requests` and `errors_5xx` are counts of HTTP requests with no path, no
  // query string, no address and no request id — the poller's projection drops every one of those
  // at the adapter. No `account_id`, and there cannot be one: an HTTP request to the API host is
  // not attributable to an account at the platform's log store, and this table would be the wrong
  // place to make it so.
  "public.platform_signals": [
    "provider", "project", "window_start", "requests", "errors_5xx", "truncated", "fetched_at",
    // WHICH cause made a bucket a sample (cloud 0030). A closed vocabulary of six words this
    // repository writes — never a value from the platform, never anything a request carried —
    // and the console's sentence is keyed on it. The same three-place decision as every column
    // above: here, the harden script's column-scoped grants, and the census equality.
    "sample_cause",
  ],
  // ── THE API'S OWN 5xx RECORD (cloud 0033) ─────────────────────────────────────────────────
  //
  // Granted whole, and the reason is the same one `platform_signals` gives one table up: every
  // column is a literal this repository chose or an integer. `route` is a route PATTERN from the
  // API's own route table, never a request target; `error_class` is a class NAME and never a
  // message; `request_id` is our own uuid. No address, no subject, no parameter value.
  //
  // It is granted rather than excluded because the API arm of the alert pass reads it through
  // the blind role — `imap_admission_refused` is the row that shows what withholding costs: the
  // API arm raised 42501, emitted no key, and deleted the worker's finding on every pass.
  //
  // No `account_id`, and there cannot be one: the envelope records the fault ABOVE the session,
  // and a route that failed for want of a connection has no account resolved to attribute it to.
  "public.api_faults": [
    "id", "at", "route", "method", "status", "error_class", "request_id", "arm",
  ],
  // The `security_barrier` view, and the ONLY route to `audit_log`. Four named scalars: no
  // `payload`, no `inverse`. The bags are never granted, in any shape.
  "admin.audit_log": ["id", "account_id", "action", "created_at"],
};

/**
 * Every TABLE-level privilege `ohmail_admin` may hold. `has_table_privilege` deliberately ignores
 * column-level grants, so a `SELECT` row in the census means somebody wrote `GRANT SELECT ON
 * <table>` without a column list — the exact "for support" incident the script exists to undo,
 * and one that silently extends to whatever column the next migration adds. Allowed on precisely
 * the views in {@link STAFF_ADMIN_VIEWS}, whose column lists are fixed by their definitions.
 * INSERT and UPDATE moved to {@link STAFF_SELECT_GRANTS}' columns: the table-level pair granted
 * nothing extra today and everything tomorrow. The census is an equality in both directions, so a
 * re-widened `GRANT INSERT` now FAILS rather than being silently permitted.
 */
export const STAFF_TABLE_GRANTS: Readonly<Record<string, readonly string[]>> = {
  // NOTHING. `alert_state` held `DELETE` and no longer does. The verb was granted for resolution,
  // when resolution deleted the row, then for the tombstone prune that replaced it. There is no
  // prune any more: the row a delayed pass fences against is never removed, so nothing in this
  // bundle deletes from this table. Revoking it is NOT tidying: it is the only thing that stops a
  // PRE-0030 driver — which the migration explicitly permits to keep running through a rolling
  // deploy — from executing its old DELETE resolution path over this same role: that delete
  // removes the row a delayed observation fences on, and the resolved incident pages again. The
  // cost, stated: an old driver's resolution now raises 42501 and its pass fails loudly at that
  // step — the safe direction. A pass that fails while being replaced is visible; a fence quietly
  // deleted underneath a running deploy is not.
  "admin.audit_log": ["SELECT"],
};

/** Schema-level privileges. `USAGE` on the two application schemas. Never `CREATE`, anywhere. */
export const STAFF_SCHEMA_GRANTS: Readonly<Record<string, readonly string[]>> = {
  public: ["USAGE"],
  admin: ["USAGE"],
};

/**
 * One row of the census. `kind` says which question was asked; `subject` and `detail` are catalog
 * identifiers only. `column` — effective SELECT; `table` — a table-level verb; `sequence` — a
 * sequence privilege (no legitimate one); `schema` — `USAGE` or `CREATE`; `role` — membership (no
 * legitimate one); `attribute` — a role attribute set that must not be; `owns` — an application
 * relation this role OWNS; `secdef` — an executable SECURITY DEFINER routine, which runs as its
 * owner and is a hole through every grant above; `session` — `session_user` differing from
 * `current_user`, emitted only on a mismatch: a wrapper arrangement means an unprivileged `SET
 * ROLE NONE` recovers the session role's own capabilities.
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
