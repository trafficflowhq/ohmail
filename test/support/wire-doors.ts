import {
  HORIZONS, KEYED_TABLES, KEYED_WRITES, OPERATIONS_TABLES, STAFF_DOOR_KEY, STAFF_TABLES, UNOWNED_TABLES, WORKER_WIDE_READ,
  serverTables,
} from "@trafficflow/db/cloud";
import { keyEquals, type PgWireFlight } from "@trafficflow/db/testing";
import { OWED_STATEMENTS } from "./wire-owed-statements.js";

/**
 * THE DOORS A STATEMENT MAY COME THROUGH, AND WHAT EACH MAY NAME: the closed lists the two wire
 * tests (`apps/server/test/binding-on-the-wire.pg.test.ts`, `apps/worker/test/
 * binding-on-the-wire.pg.test.ts`) hold every statement they see against.
 *
 * A statement reaches the database one of four ways: outside any transaction's binding (`plain`),
 * in a flight that names an account, in a flight that names none, or in a flight that names none
 * and carries a key (a credential's digest before sign-in, the staff door's word). What each way
 * may name is a list here, by table and by whether the statement writes it:
 *
 * - outside a flight: a table no account owns (the operations tables), or none at all;
 * - a flight that names an account: any table but the operators' own;
 * - a flight that names none: by its door, the tables below.
 *
 * {@link OWED} holds what is admitted today and must not be: a statement that reads or writes rows
 * of many accounts on a handle that names none, or one account's row on a door that should not
 * reach it. Each row names the work that takes it away, and THE EXACT STATEMENTS it admits
 * (`wire-owed-statements.ts`): a row is met by one of its own statement texts and by no other, so
 * a new statement on an owed row's table and door is refused like any statement no list admits. A
 * row whose journeys no test drives admits nothing until a ruling lists its text. The list only
 * shrinks: a wire test fails on a statement no list admits, and on an owed row its journeys no
 * longer meet.
 */

/** A statement's verb, as the lists tell reads from writes. */
export type Verb = "read" | "write";

/** What one statement names: each table of the store in a table's position, and the one it writes. */
export interface Named { readonly reads: readonly string[]; readonly writes: string | null }

const TABLE = new Set(serverTables());

/** The identifier at `at` in `text` (quoted or bare, `public.` aside), lower-cased, or null. */
function identifierAt(text: string, at: number): string | null {
  let i = at;
  while (i < text.length && (text[i] === " " || text[i] === "\n" || text[i] === "\t" || text[i] === "\r")) i++;
  const word = (): string => {
    const quoted = text[i] === "\"";
    if (quoted) i++;
    const from = i;
    while (i < text.length) {
      const c = text.charCodeAt(i);
      const ok = (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95;
      if (!ok) break;
      i++;
    }
    const name = text.slice(from, i).toLowerCase();
    if (quoted && text[i] === "\"") i++;
    return name;
  };
  let name = word();
  if (name === "only") { while (text[i] === " ") i++; name = word(); }
  if (name === "public" && text[i] === ".") { i++; name = word(); }
  return name === "" ? null : name;
}

/**
 * The tables `statement` names where a table stands (after `from`, `join`, `into`, `update`), and
 * the one it writes (`insert into`, `update`, `delete from`), read word by word. A row lock
 * (`for update`) and an upsert's `do update` are followed by no table's name, and name none. Only
 * names of the store's own tables are answered.
 */
export function namedBy(statement: string): Named {
  const lower = statement.toLowerCase();
  const reads = new Set<string>();
  let writes: string | null = null;
  const words = ["from", "join", "into", "update"] as const;
  for (const w of words) {
    let at = 0;
    for (;;) {
      const found = lower.indexOf(w, at);
      if (found === -1) break;
      at = found + w.length;
      const before = found === 0 ? " " : lower[found - 1]!;
      const after = lower[at] ?? " ";
      const alone = !/[a-z0-9_"]/.test(before) && /[\s"]/.test(after);
      if (!alone) continue;
      const name = identifierAt(statement, at);
      if (name === null || !TABLE.has(name)) continue;
      reads.add(name);
      const head = lower.slice(Math.max(0, found - 12), found).trimEnd();
      const isWrite = w === "update" || (w === "into" && head.endsWith("insert")) || (w === "from" && head.endsWith("delete"));
      if (isWrite && writes === null) writes = name;
    }
  }
  return { reads: [...reads].sort(), writes };
}

/** Which door a flight came through. `digests`: the credentials' digests the test itself presented. */
export type Door = "plain" | "account" | "nothing" | "credential" | "staff" | "unknown-key";

export function doorOf(flight: PgWireFlight, digests: readonly string[] = []): Door {
  if (flight.door === "plain") return "plain";
  if (flight.account !== null) return flight.keyed ? "unknown-key" : "account";
  if (!flight.keyed) return "nothing";
  if (keyEquals(flight, STAFF_DOOR_KEY)) return "staff";
  return digests.some((d) => keyEquals(flight, d)) ? "credential" : "unknown-key";
}

/**
 * The tasks that take owed rows away. `walks`: the passes walk on the roster's own handle and bind
 * each row, on the API host and in the worker. `keyed doors`: each look-up before sign-in carries
 * its key and names its account once, from the row the key admitted. `console`: a staff act reads
 * its target and writes its event at the staff door. `lock`: the policies' own list.
 */
export type OwedTo = "walks" | "keyed doors" | "console" | "lock";

/** One statement admitted today that must not be: where it is, what it names, and what takes it away. */
export interface OwedRow {
  readonly login: "api" | "worker";
  readonly door: Door;
  readonly table: string;
  readonly verb: Verb;
  /** The statement's place in the product. */
  readonly where: string;
  /** Why it is owed, in a sentence. */
  readonly why: string;
  /** The work that takes it away: each task named must land before the row can go. */
  readonly to: readonly OwedTo[];
  /**
   * The wire test whose journeys always meet it, or `none`: a statement those journeys reach only
   * with rows they do not make, or not at all. A row a test is said to meet and does not is stale.
   */
  readonly metBy: "server" | "worker" | "none";
  /**
   * The statements the row admits, each by its whole shape ({@link statementShape}): those its wire
   * test's journeys send, and those a ruling named. A statement of the row's login, door, table and
   * verb whose shape is not here is refused.
   */
  readonly statements: readonly string[];
}

const owed = (
  login: OwedRow["login"], door: Door, verb: Verb, table: string, metBy: OwedRow["metBy"], to: OwedTo | readonly OwedTo[],
  where: string, why: string,
): OwedRow => ({
  login, door, table, verb, where, why, to: typeof to === "string" ? [to] : to, metBy,
  statements: OWED_STATEMENTS[`${login} ${door} ${verb} ${table}`] ?? [],
});

/** A statement's text: its runs of white space as one space, trimmed. */
export function statementText(statement: string): string {
  return statement.replace(/\s+/g, " ").trim();
}

/**
 * A statement's SHAPE, as the owed rows list it: its text, with the two parts that move with the
 * rows a journey made read as one each: a list of placeholders (`in ($1, $2)` and `in ($1, $2, $3)`
 * are one shape) and a number written into the text (the batch stamp writes its interval's
 * milliseconds there). Every table, column, condition and verb stays as sent.
 */
export function statementShape(statement: string): string {
  return statementText(statement)
    .replace(/\(\$\d+(?:, \$\d+)*\)/g, "($…)")
    .replace(/(?<![$\w])\d+(?!\w)/g, "#");
}

const OPERATIONS = new Set<string>(OPERATIONS_TABLES);
const STAFF = new Set<string>(STAFF_TABLES);
const WIDE = new Set<string>(WORKER_WIDE_READ);
/** The tables the two look-ups by a token's digest read: a session's, and an erased account's bearer. */
const TOKEN_DOORS = new Set<string>(["sessions", "erased_bearers"].filter((t) => t in KEYED_TABLES));
/** The tables a prune takes rows of by their own columns, on a handle that names no account. */
const PAST = new Set<string>(HORIZONS.filter((h) => h.runs === "unbound").map((h) => h.table));

/** `table` admitted to `verb` through `door` on `login`, by the lists the lock is made from. */
function admitted(login: "api" | "worker", door: Door, table: string, verb: Verb): boolean {
  if (OPERATIONS.has(table)) return door !== "unknown-key";
  switch (door) {
    case "plain": return false;
    case "account": return !STAFF.has(table);
    case "staff": return login === "api" && STAFF.has(table);
    // A look-up by a token's digest, before the account is known: the two tables it is compared on, read only.
    case "credential": return login === "api" && verb === "read" && TOKEN_DOORS.has(table);
    case "nothing":
      if (login === "api") return false;
      // The worker schedules from every row of ten tables and writes none of them there; a prune
      // reads and deletes what is past its table's horizon; the owed notices' counters are read.
      if (WIDE.has(table)) return verb === "read";
      if (PAST.has(table)) return true;
      return table === "account_counters" && verb === "read";
    default: return false;
  }
}

/**
 * WHAT IS OWED. A row is met by a statement of exactly its login, door, table and verb. Rows come
 * off as the work named in `to` lands; none is added without a ruling.
 */
export const OWED: readonly OwedRow[] = [
  // ── The API's login ────────────────────────────────────────────────────────────────────────
  // The session's look-up.
  owed("api", "credential", "read", "users", "server", "lock",
    "packages/services/src/auth/resolve-session.ts",
    "the session's look-up joins the user's row by id under the token's digest, and the lock compares `users` by address only: its list needs an arm for the holder of that user's session token"),
  // The staff door.
  owed("api", "staff", "read", "mailboxes", "server", "console",
    "packages/api/src/staff-audit.ts (staffActOn)",
    "the row a staff act is for is read at the staff door, which reaches the operators' tables alone"),
  owed("api", "staff", "read", "accounts", "none", "console",
    "packages/api/src/staff-audit.ts (staffActOn)",
    "the same, for an act on an account; met by packages/api/test/door-binding.pg.test.ts, which has a mailer"),
  owed("api", "account", "write", "staff_audit_events", "server", "console",
    "packages/api/src/routes/admin-actions.ts (resyncMailbox, claimBillingLink, handBackBillingLink)",
    "the staff event is written inside the act's own transaction, which names the account; the operators' tables are the door's"),
  // The clocks' routes: each pass's claim and its reads of many accounts, on the request's handle.
  owed("api", "nothing", "read", "drafts", "server", "walks",
    "packages/services/src/schedule-send-pass.ts (the claim, tidyKeptFiles), scheduled-send-files.ts (the sweeps), send-reconcile-pass.ts (claimStale)",
    "due letters of every account are found and claimed in one statement"),
  owed("api", "nothing", "write", "drafts", "server", "walks",
    "packages/services/src/schedule-send-pass.ts (the claim)",
    "the claim flips due letters of many accounts in one transaction"),
  owed("api", "nothing", "write", "scheduled_send_files", "server", "walks",
    "packages/services/src/scheduled-send-files.ts (sweepScheduledSendFiles, sweepAgedScheduledFiles)",
    "kept files of every account are swept by age in one statement"),
  owed("api", "nothing", "read", "outbound_sends", "server", "walks",
    "packages/services/src/send-reconcile-pass.ts (claimStale)", "stranded reservations of every account are claimed in one statement"),
  owed("api", "nothing", "read", "mailboxes", "server", "walks",
    "send-reconcile-pass.ts (claimStale), sent-copy-pass.ts (claimOwed, claimFilesCopy), away-responder-pass.ts (liveResponders), packages/api/src/smtp-size.ts (the selection)",
    "each claim reads its rows' mailboxes beside them, across accounts"),
  owed("api", "nothing", "read", "outbound_sent_copies", "server", "walks",
    "packages/services/src/sent-copy-pass.ts (claimOwed, claimFilesCopy, the count of what is left)", "owed copies of every account are claimed and counted"),
  owed("api", "nothing", "write", "outbound_sent_copies", "server", "walks",
    "packages/services/src/sent-copy-pass.ts (claimOwed, claimFilesCopy)",
    "the claim leases, and drops what is past its hold, across accounts"),
  owed("api", "nothing", "read", "away_responders", "server", "walks",
    "packages/services/src/away-responder-pass.ts (liveResponders)", "the live responders of every account are read in one statement"),
  owed("api", "nothing", "write", "away_responders", "server", "walks",
    "packages/services/src/away-responder-pass.ts (expireEndedResponders, healMissingEnabledAt, markConsidered)",
    "ended responders are expired, and the walked ones stamped, across accounts"),
  owed("api", "nothing", "read", "sessions", "server", ["walks", "keyed doors"],
    "packages/services/src/auth/session-reaper.ts; the doors before sign-in",
    "stale browser sessions of every account are found in one statement; and a look-up before sign-in that is not the request's own session reads there with no key"),
  owed("api", "nothing", "write", "sessions", "none", "walks",
    "packages/services/src/auth/session-reaper.ts", "and revoked in one transaction; met only with a stale session"),
  owed("api", "nothing", "write", "refresh_tokens", "none", "walks", "packages/services/src/auth/session-reaper.ts", "the reaper's same transaction, which takes what the revoked sessions leave"),
  owed("api", "nothing", "write", "push_subscriptions", "none", "walks", "packages/services/src/auth/session-reaper.ts", "the reaper's same transaction, which takes what the revoked sessions leave"),
  owed("api", "nothing", "write", "auth_events", "none", "walks", "packages/services/src/auth/session-reaper.ts", "the reaper's same transaction, which takes what the revoked sessions leave"),
  owed("api", "nothing", "read", "mailbox_credentials", "server", "walks",
    "packages/api/src/smtp-size.ts", "one mailbox's credential is read on the walk: the selection names no account to bind"),
  owed("api", "nothing", "write", "mailboxes", "server", "walks",
    "packages/api/src/smtp-size.ts", "one mailbox's size is stamped on the walk, for the same reason"),
  owed("api", "nothing", "write", "mailbox_credentials", "none", "walks",
    "packages/api/src/smtp-size.ts (the probe's dial of a Microsoft mailbox)",
    "a refresh token Microsoft replaces during the probe's dial is written on the handle that dial holds, which is the walk, for the same reason: under the lock the probe reads no credential there and never dials; met only when the probe redeems a token"),
  owed("api", "nothing", "read", "users", "none", ["walks", "keyed doors"],
    "packages/services/src/auth/auth-service.ts (drainSecurityNotices, the sign-in doors), account-lifecycle-pass.ts (the page)",
    "owed notices are matched to users of every account, the lifecycle's page reads who has a user, and a sign-in finds its user by address with no key. Not met: no notice is owed, the lifecycle needs a metered host, and no sign-in is driven"),
  owed("api", "nothing", "read", "accounts", "none", "walks",
    "packages/services/src/account-lifecycle-pass.ts (the page, the erase door's one look)",
    "the page over every live account, and the erase door's read of the row an id names; met by packages/services/test/pass-binding.pg.test.ts"),
  owed("api", "nothing", "read", "account_storage", "none", "walks",
    "packages/services/src/storage-mail-pass.ts", "the accounts storing the most are read in one statement; needs a metered host"),
  owed("api", "nothing", "read", "account_storage_holds", "none", "walks", "packages/services/src/storage-mail-pass.ts", "the holds of those accounts, in one read"),
  owed("api", "nothing", "read", "attachment_staging", "none", "walks",
    "packages/api/src/routes/internal.ts (the owed copies' uploads source)",
    "one account's uploads are read on the walk: the source is made once for the pass, over the door's handle"),
  // The doors before sign-in: each look-up runs on the request's handle, which names no account and
  // carries no key. The session's own look-up and an erased account's bearer are the two that carry one.
  ...Object.keys(KEYED_TABLES).filter((t) => !TOKEN_DOORS.has(t) && t !== "users").map((table) => owed("api", "nothing", "read", table, "none", "keyed doors",
    "packages/services/src/auth (sign-in, the refresh, pairing, recovery, the ceremonies), packages/api/src/routes (their doors)",
    "a look-up before sign-in reads by a token, a code or an address on a handle that carries no key: under the lock it finds nothing")),
  ...[...new Set<string>([...KEYED_WRITES, ...UNOWNED_TABLES])].map((table) => owed("api", "nothing", "write", table, "none",
    table === "invites" ? ["keyed doors", "walks"] : "keyed doors",
    "packages/services/src/auth (the sign-up funnel, the approvals and ceremonies made before the user is known)"
      + (table === "invites" ? "; apps/server/src/clocks.ts, packages/services/src/invites.ts (pruneExpiredInvites)" : ""),
    "a row that names no account yet is made and spent on a handle that carries no key"
      + (table === "invites" ? "; and a self-hosted server's own clock prunes spent invitations on its walk" : ""))),
  ...(["accounts", "users", "credentials", "devices"] as const).map((t) => owed("api", "nothing", "write", t, "none", "keyed doors", "packages/services/src/auth (register, pairing, the desktop claim)", "an account, its user, its credential and a device are made on the request's handle, which names no account and carries no key: under the lock nobody signs up or pairs")),
  // Outside any transaction: a server with one role reads its alert pass on the pool's own handle.
  ...(["auth_events", "devices", "mailboxes", "outbound_sends", "sessions"] as const).map((table) => owed("api", "plain", "read", table, "server", "walks",
    "apps/server/src/program.ts (alertDb), packages/db/src/alerts.ts",
    "a self-hosted server's alert pass counts rows of every account on the pool's own handle; the managed service reads them as the staff role")),
  ...(["cal_credentials", "mailbox_credentials", "mailbox_oauth_ceremonies", "mailbox_oauth_device_ceremonies", "scheduled_send_files",
    "staff_users", "totp_secrets"] as const).map((table) => owed("api", "plain", "read", table, "none", "lock",
    "apps/server/src/deps.ts (kekRetiredReferences)",
    "the key retirement check counts sealed rows of every account; under the lock it must answer `kek_retirement_unread`, never \"none in use\"")),

  // ── The worker's login ─────────────────────────────────────────────────────────────────────
  // On the view that names no account: the prunes that must run inside each account's binding.
  owed("worker", "nothing", "read", "sessions", "worker", "walks",
    "apps/worker/src/retention-prune.ts (signInRetentionPass), packages/db/src/change-log-retention.ts (an account's slowest reader), packages/db/src/alerts.ts",
    "the sessions' prune decides by rows beside the one it takes, so it runs per account after a read of the roster; it runs unbound today"),
  owed("worker", "nothing", "read", "refresh_tokens", "worker", "walks", "apps/worker/src/retention-prune.ts (signInRetentionPass)", "the sessions' prune reads the tokens a session has left, as its guard"),
  owed("worker", "nothing", "write", "sessions", "none", "walks", "apps/worker/src/retention-prune.ts (signInRetentionPass)", "the sessions' prune deletes on the roster's view; met only with a session past its horizon"),
  owed("worker", "nothing", "write", "devices", "worker", "walks", "apps/worker/src/retention-prune.ts (signInRetentionPass)", "the devices' prune, on the same terms"),
  owed("worker", "nothing", "read", "devices", "worker", "walks",
    "packages/db/src/change-log-retention.ts (an account's slowest reader), packages/db/src/alerts.ts", "one account's devices are read on the roster's view"),
  owed("worker", "nothing", "write", "outbound_send_fingerprints", "worker", "walks",
    "packages/db/src/send-fingerprints.ts (pruneSendFingerprints), mailbox-erasure.ts (eraseOwedMailbox)",
    "the fingerprints' prune, guarded by the send a claim points at; an erased mailbox's too"),
  owed("worker", "nothing", "read", "outbound_sends", "worker", "walks", "packages/db/src/send-fingerprints.ts (pruneSendFingerprints), packages/db/src/alerts.ts",
    "the fingerprints' prune reads the send a claim points at, as its guard; the alert pass counts stuck sends"),
  // The change log's retention walks the accounts and prunes each on the one handle it is handed.
  owed("worker", "nothing", "read", "account_sync_state", "worker", "walks",
    "apps/worker/src/retention-prune.ts (retentionPrunePass)", "the roster of accounts with a change log is read on the roster's view, which reaches ten tables and not this one"),
  owed("worker", "nothing", "write", "account_sync_state", "worker", "walks",
    "packages/db/src/change-log-retention.ts (pruneChangeLogForAccount)", "one account's floor is moved on the roster's view: the pass walks accounts itself and is handed one handle"),
  owed("worker", "nothing", "read", "change_log", "worker", "walks", "packages/db/src/change-log-retention.ts (pruneChangeLogForAccount)", "one account's log is read to find that floor, in the same statement"),
  owed("worker", "nothing", "write", "change_log", "none", "walks", "packages/db/src/change-log-retention.ts (pruneChangeLogForAccount)", "one account's log is deleted behind its floor; met only with a log past its keep"),
  // One statement over many accounts, on the roster's view.
  owed("worker", "nothing", "write", "mailboxes", "worker", "walks",
    "apps/worker/src/start/cycle.ts (stampMailboxSyncNow, the batch), mailbox-erasure-pass.ts",
    "every mailbox a cycle visited is stamped in one statement; the roster's view reads `mailboxes` and writes none"),
  owed("worker", "nothing", "read", "mailbox_credentials", "worker", "walks",
    "apps/worker/src/mailboxes.ts (loadAttachHosts)", "the hosts of the mailboxes to attach are read in one statement, across accounts"),
  owed("worker", "nothing", "read", "messages", "worker", "walks",
    "packages/organizer/src/html-words-backfill.ts (htmlWordsOwedAccounts), gone-letter-tidy.ts (goneLetterTidyAccounts), sender-check-backfill.ts (senderCheckReentered), packages/core/src/message-search.ts (searchIndexOwedAccounts)",
    "which accounts a backfill still owes is asked of every account's letters in one statement"),
  owed("worker", "nothing", "write", "push_subscriptions", "none", "walks",
    "apps/worker/src/mailboxes.ts (deleteParkedPushRows)", "the push rows of every parked account go in one statement; met only with a parked account"),
  owed("worker", "nothing", "write", "credit_refund_obligations", "none", "walks",
    "apps/worker/src/refund-obligation-drain.ts (refundObligationDrainPass)", "a claimed obligation is settled for its account on the roster's view; met only with an obligation owed"),
  // A mailbox's erasure is one mailbox's work, done on the roster's view by a pass that finds the owed ones itself.
  ...(["approvals", "attachments", "audit_log", "away_replies", "drafts", "flag_state", "folder_ops", "folder_state", "junk_rescues",
    "mailbox_credentials", "mailbox_folders", "mailbox_profile_mirror", "message_bodies", "message_failures", "message_instances",
    "message_invitations", "messages", "message_search", "message_states", "message_tags", "organizer_requests",
    "outbound_sends", "outbound_sent_copies", "pass_progress", "routing_decisions", "scheduled_send_files",
    "thread_notes", "threads", "tracker_events", "unsubscribe_examined", "unsubscribe_records"] as const)
    .map((table) => owed("worker", "nothing", "write", table, "none", "walks",
      "apps/worker/src/mailbox-erasure-pass.ts, packages/db/src/mailbox-erasure.ts (eraseOwedMailbox)",
      "an erased mailbox's rows are taken on the roster's view; met only with an erasure owed")),
  ...(["drafts", "routing_decisions", "threads", "unsubscribe_records"] as const).map((table) => owed("worker", "nothing", "read", table, "none", "walks",
    "packages/db/src/mailbox-erasure.ts (eraseOwedMailbox)", "an erased mailbox's rows are read on the roster's view; met only with an erasure owed")),
  // Outside any transaction: the start file's own handle, where it still names one mailbox or one account.
  owed("worker", "plain", "read", "mailboxes", "worker", "walks",
    "apps/worker/src/sync-kick.ts", "the stamped mailboxes this process serves are read on the pool's own handle"),
  owed("worker", "plain", "write", "mailboxes", "worker", "walks",
    "apps/worker/src/sync-kick.ts", "and one mailbox's stamp is cleared there: under the lock it clears nothing, and the mailbox is kicked again each scan"),
  owed("worker", "plain", "read", "account_storage_holds", "none", "walks",
    "apps/worker/src/storage-cap.ts, packages/db/src/storage-hold.ts (heldStorageLimitOf)", "one account's held limit is read on the pool's own handle; needs a metered host"),
  owed("worker", "plain", "write", "account_storage_holds", "none", "walks",
    "apps/worker/src/storage-cap.ts, packages/db/src/storage-hold.ts (heldStorageLimitOf)", "and written there through the account's fence, which the fences will refuse on a server pool: bound first, or the cap reads unmetered"),
  owed("worker", "plain", "read", "accounts", "none", "walks", "apps/worker/src/storage-cap.ts, packages/db/src/storage-hold.ts (heldStorageLimitOf)", "the account's row is read by that write's fence, on the pool's own handle"),
  owed("worker", "plain", "write", "credit_refund_obligations", "none", "walks",
    "apps/worker/src/index.ts (refundObligationsOn)", "a spend that bought nothing is remembered for its account on the pool's own handle"),
];

const owedKey = (r: Pick<OwedRow, "login" | "door" | "table" | "verb">): string => `${r.login} ${r.door} ${r.verb} ${r.table}`;
const OWED_BY_KEY = new Map(OWED.map((r) => [owedKey(r), new Set(r.statements)] as const));

/** A statement no list admits: what it named, through which door. */
export interface Refused { readonly door: Door; readonly table: string; readonly verb: Verb; readonly statement: string }

/**
 * Hold `flights` against the lists. Answers every statement no list admits; each owed row a
 * statement met is added to `met`.
 */
export function refusedOf(
  login: "api" | "worker", flights: readonly PgWireFlight[], digests: readonly string[], met: Set<string>,
): Refused[] {
  const out: Refused[] = [];
  for (const flight of flights) {
    const door = doorOf(flight, digests);
    for (const statement of flight.statements) {
      const named = namedBy(statement);
      for (const table of named.reads) {
        const verb: Verb = named.writes === table ? "write" : "read";
        if (admitted(login, door, table, verb)) continue;
        const key = owedKey({ login, door, table, verb });
        // An owed row admits its own statements and no other text on its table and door.
        if (OWED_BY_KEY.get(key)?.has(statementShape(statement)) === true) { met.add(key); continue; }
        out.push({ door, table, verb, statement: statementText(statement).slice(0, 160) });
      }
      if (door === "unknown-key" && named.reads.length === 0) {
        out.push({ door, table: "", verb: "read", statement: statement.replace(/\s+/g, " ").trim().slice(0, 160) });
      }
    }
  }
  return out;
}

/** The owed rows `test` is said to meet that `met` does not hold: rows its journeys no longer meet. */
export function unmetOf(test: "server" | "worker", met: ReadonlySet<string>): string[] {
  return OWED.filter((r) => r.metBy === test).map(owedKey).filter((k) => !met.has(k));
}
