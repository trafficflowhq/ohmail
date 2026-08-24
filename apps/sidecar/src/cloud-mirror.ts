import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, asc, eq, gt, isNull, ne, notInArray } from "drizzle-orm";
import { recordChange, recordChanges, accountSettings,
} from "@trafficflow/db";
import {
  approvals, attachments, drafts, flagState, folderState, mailboxCredentials, mailboxFolders,
  mailboxes, messageBodies, messageFailures, messageInstances, messageStates, messages, messageTags,
  outboundSends, routingDecisions, rules, tags, threadNotes, threads, trackerEvents,
  unsubscribeRecords,
} from "@trafficflow/db/mail";
import { BODIES_IDS_MAX } from "@trafficflow/services/mail";
import type {
  ApprovalDTO, ChangeOp, DraftDTO, EntityType, MailboxDTO, MessageBodyBatchItem, MessageDTO,
  MessageStateDTO, Page, RoutingDecisionDTO, RuleDTO, SnapshotResponse, SyncChange, SyncResponse,
  TagDTO, ThreadDTO,
} from "@trafficflow/services/mail";
import type { LocalDb } from "./db.js";
import type { LocalWorld } from "./identity.js";
import type { CloudAuth } from "./cloud-auth.js";
import { stampSynced } from "./sync-stamp.js";
import type { Diagnostic } from "./log.js";

/**
 * THE CLOUD MIRROR — pull the hosted account's change feed and apply it into the local mail
 * schema, so the desktop reads a complete mirror WITHOUT ever organizing the mailbox.
 *
 * This is the CloudMirror SOURCE. It is deliberately the whole of what a Cloud-mode install does
 * to the mail store: it has no IMAP adapter, takes no organizer lease and runs no sync loop —
 * `cloud-engine.ts`'s module graph reaches none of the three, and a census
 * (`test/cloud-engine-census.test.ts`) makes that structural rather than a matter of discipline.
 * The hosted worker stays the single organizer; this process is a reader of what the worker filed.
 *
 * ── THE FIVE CONVERGENCE RULES, PORTED INTO UPSERTS ───────────────────────────────────────────
 *
 * `packages/client-engine/src/apply.ts` proves the `/sync` contract against a `Map`; the same five
 * rules hold here against SQL:
 *
 *   1. sort a page's merged buckets by ascending `seq` (the order of record);
 *   2. apply keyed on (type,id) as an idempotent upsert;
 *   3. an older-or-equal seq never overwrites — satisfied structurally, since a page is applied in
 *      ascending seq and pages are applied in cursor order, so the last write for an id wins and a
 *      replay re-applies the same or newer state;
 *   4. delete ⇒ remove the row (a later create resurrects via the upsert);
 *   5. move ⇒ the carried DTO is upserted like any other, and its folder lands in `folder_state`.
 *
 * Applying the same page twice — the crash-recovery case, since the cursor is written AFTER the
 * commit — converges, because every write is an upsert and every delete is unconditional.
 *
 * ── THE ACCOUNT IS REMAPPED. THE MAILBOX IS NOT — AND THAT ASYMMETRY IS THE POINT ─────────────
 *
 * Every DTO carries the HOSTED account's `accountId` and `mailboxId`, and the two are treated
 * completely differently.
 *
 * `accountId` IS REMAPPED to `world.accountId`. The local database is scoped by the single
 * synthetic local identity (`identity.ts`) and every read service filters on the caller's own
 * account, so a mirror keyed to the hosted account renders EMPTY — `materializeMessages` would
 * find nothing.
 *
 * `mailboxId` IS COPIED VERBATIM, and it used to be remapped the same way. That was the defect.
 * `identity.ts` mints ONE synthetic mailbox row — a random uuid, addressed with the ACCOUNT LOGIN
 * address — and every mirrored message and draft was attributed to it. Three consequences, all of
 * them visible to the user:
 *
 *  · a hosted `POST`/`PUT /drafts` carrying that id is refused `400 mailboxId does not belong to
 *    this account` (`drafts-service.ts`, `validMailbox`), so EVERY send from the Cloud door failed;
 *  · the From selector reads `GET /mailboxes` (`compose-from.ts`), which was answered from the
 *    synthetic row, so it rendered one static option whose address was the login rather than the
 *    account's actual sending addresses — and an account with two mailboxes could not pick;
 *  · a reply inherits `parent.mailboxId` (`Engine.enrich`), which named a mailbox no option list
 *    contained, so `resolveReplyFrom` announced a SUBSTITUTION on every reply.
 *
 * So the mailbox rows are mirrored too — {@link makeMailboxRefresh} pulls hosted `GET /mailboxes`
 * at the START of every pull, keyed on the HOSTED id, before a single change is drained. That
 * ordering is mandatory rather than tidy: a message can only be attributed to a mailbox row that
 * already exists (`messages.mailbox_id` has a foreign key), so the refresh has to precede the
 * drain. Entity IDs (message id, thread id, …) are the `/sync` feed's own keys and are preserved
 * unchanged, and mailbox ids now join them.
 *
 * The synthetic row is retired in the same transaction the hosted rows land in. It is never left
 * beside them: two active rows for one address violate `mailboxes_active_address_uq`, and a
 * lingering login-address row would render in Settings as a mailbox nobody has.
 *
 * ── AND ONE LOCAL `recordChange` PER APPLIED ENTITY ───────────────────────────────────────────
 *
 * The Swift projection reads the sidecar's OWN `/sync`, which is `change_log` over the local
 * database. So each applied entity appends one local change-log row inside the same transaction —
 * a LOCAL seq unrelated to the Cloud cursor — and that is what makes the projection's `/sync`
 * advance. Message bodies are the exception: they are not a `/sync` entity (the client hydrates
 * them separately), so they are upserted without a change-log row.
 */

/**
 * The nine `/sync` entity types the hosted feed carries (`packages/api/src/routes/sync.ts`).
 *
 * `"tag"` IS ONE OF THEM, and its absence here is why a hosted account's tags did not reach the
 * desktop. This list is sent as `?types=`, so it is a request as well as a description: leaving a
 * type out asks the server not to send it. Tag ASSIGNMENTS are not a type of their own — they ride
 * `message`, as `MessageDTO.labels`, which is why {@link applyUpsert} writes both from one change.
 */
export const CLOUD_SYNC_TYPES: readonly EntityType[] = [
  "message", "thread", "routing_decision", "approval",
  "draft", "rule", "message_state", "folder", "tag",
];

/**
 * FK-safe application order for a page's non-deletes. A message references its thread, a triage
 * state / routing decision references its message, so parents land first and a message upserts a
 * thread stub for a thread that has not arrived yet. Deletes run in the reverse of this order.
 *
 * `tag` is FIRST, ahead of `message`, and that ordering is what makes the label writes work: a
 * message's `labels` are foreign keys into `tags`, and the tag they name is always created before
 * it can be assigned — so within a page ordered by seq the tag's own change is already in hand by
 * the time the message carrying the assignment is applied.
 */
const APPLY_ORDER: readonly EntityType[] = [
  "folder", "tag", "thread", "message", "message_state", "rule", "draft", "approval", "routing_decision",
];

const DEFAULT_PAGE_LIMIT = 500;
const DEFAULT_BODIES_LIMIT = 100;

/**
 * How many body-less messages one pull may repair. Ten `?ids=` requests at the server's cap — enough
 * to absorb a burst of new mail in a single poll, small enough that a mirror which has been offline
 * for a week catches up over several polls instead of firing hundreds of requests at once.
 */
const BODIES_CATCHUP_MAX = 10 * BODIES_IDS_MAX;

/**
 * THE ON-DISK MARKER FOR A FINISHED BODY WALK. Written into the cursor file's `bodies` field, where
 * every other value is a `messages.id` — a UUID — so the two can never be confused, and an old
 * build reading it would send `after=complete` and get a `400 invalid cursor` rather than silently
 * mirroring the wrong rows.
 */
export const BODIES_WALK_COMPLETE = "complete";

/**
 * WHERE THE BODY WALK HAS GOT TO — three states, in the one field that used to hold two of them.
 *
 * `GET /messages/bodies` keyset-pages the account by `messages.id` and answers `nextCursor: null`
 * on the LAST page. The cursor stored that answer verbatim, so `null` meant BOTH "the walk finished"
 * and — because the next pull read it as "no `after=` to send" — "start again from the first
 * message". A completed walk therefore restarted on every poll, re-fetching and re-upserting every
 * body in the account for as long as the app was open. Nothing was wrong with the mirror it
 * produced, which is why it went unnoticed: it converged on identical rows, at the cost of a
 * permanently busy process and a write-ahead log that never stopped growing.
 *
 * Splitting the states is the fix, and the split has to survive cursor files written before it
 * existed — see {@link resolveBodiesWalk} for how a `null` read off disk is decided.
 */
type BodiesWalk =
  /** An on-disk `null`: complete or never-started, and only the mailbox row can say which. */
  | { phase: "unresolved" }
  /** Mid-walk. `after` is the last id a page returned, or null to begin at the first message. */
  | { phase: "walking"; after: string | null }
  /** Every message in the account has been offered a body. Later pulls fetch only what is missing. */
  | { phase: "complete" };

/** The on-disk `bodies` field for a walk state. The inverse of {@link readBodiesWalk}. */
function writeBodiesWalk(walk: BodiesWalk): string | null {
  switch (walk.phase) {
    case "complete":
      return BODIES_WALK_COMPLETE;
    case "walking":
      return walk.after;
    default:
      return null;
  }
}

/** A cursor file's `bodies` field as a walk state. The inverse of {@link writeBodiesWalk}. */
function readBodiesWalk(raw: unknown): BodiesWalk {
  if (raw === BODIES_WALK_COMPLETE) return { phase: "complete" };
  if (typeof raw === "string" && raw !== "") return { phase: "walking", after: raw };
  return { phase: "unresolved" };
}

/**
 * THE CURSOR FILE'S FORMAT VERSION — **and an ABSENT version means 0, which means RE-KEY.**
 *
 * The mirror's rows changed meaning when mailbox attribution stopped being the synthetic local id
 * (see this file's header). Every mirror written before that carries messages and drafts pointing
 * at a mailbox row the hosted account has never heard of, and no delta can repair them: a message
 * that has not changed on Cloud emits no change, so an incremental drain would leave the whole
 * back catalogue mis-attributed for ever while fresh installs came up correct.
 *
 * So the version is the migration, and the DEFAULT IS THE DANGEROUS DIRECTION ON PURPOSE. A cursor
 * file with no `version` field — which is every file any earlier build wrote — reads as 0 and
 * forces a `since=0` re-bootstrap, which re-applies every entity through the corrected upsert. The
 * inverse default (absent ⇒ current) is the one failure that would be invisible in testing: fresh
 * installs would be green and every UPGRADED install would silently keep the defect.
 *
 * The re-pull is the ordinary bootstrap machinery — 500-row pages, one transaction and one cursor
 * write per page, resumable after a crash — not a discard: `message_bodies` is keyed on
 * `message_id` alone and entity ids are preserved, so the body store is untouched by it.
 */
export const CURSOR_VERSION = 1;

interface CursorState {
  /**
   * The format this cursor file was written by. See {@link CURSOR_VERSION}: below it, the next
   * drain is forced to `since=0` so every row is re-applied with the attribution it should have.
   */
  version: number;
  /** The hosted `/sync` cursor. `"0"` bootstraps a full replay. */
  sync: string;
  /** How far the body walk has got. See {@link BodiesWalk} for why this is not just an id. */
  bodies: BodiesWalk;
  /**
   * Set while a `since=0` bootstrap is in flight and its trailing sweep has NOT yet run; cleared
   * only once the sweep has. It is what makes the mark-and-sweep crash-safe, and what it demands
   * changed when the generation learned to persist ({@link BootstrapGen.flush}): a bootstrap that
   * commits a page then dies leaves a NON-zero cursor, and resuming from it is safe ONLY against
   * the SAME generation's marks — a resume against a partial rebuild would sweep real rows. So a
   * launch that finds this set RESUMES from the committed cursor when the generation file is
   * there to continue marking into, and restarts the whole bootstrap from zero when it is not
   * (a pre-generation-file cursor, an unreadable file). The restart-from-zero-on-every-failure
   * form this replaces cannot finish on a large mailbox: a replay hundreds of pages long that
   * starts over on ANY interruption — a sleep, a network change, an app quit — never reaches the
   * horizon, and the mirror silently serves week-old mail forever while every retry looks alive.
   */
  bootstrapping: boolean;
  /**
   * Set once the one-time stale-mirror tag repair has been CONSIDERED — see {@link CloudMirrorConfig}
   * and the repair in {@link createCloudMirror}. Absent from every cursor file written before that
   * repair existed, which reads as `false` — and that population is exactly the one it is for: the
   * mirrors bootstrapped while the drain still asked for eight of the feed's nine types.
   */
  tagBackfill: boolean;
  /** The one-time folder backfill's consumed flag — `tagBackfill`'s shape, for the folder
   *  entities the pre-folders apply loop dropped while the cursor advanced past them. */
  folderBackfill: boolean;
  /**
   * Set once the one-time cap-marker repair has been CONSIDERED — see {@link repairCapMarkers}.
   * Absent from every cursor file written before that repair existed, which reads as `false`, and
   * that population is exactly the one it is for: mirrors an old sidecar filled with ordinary
   * empty body rows for bodies the hosted store was withholding.
   */
  capMarkerRepair: boolean;
}

export interface CloudMirrorConfig {
  db: LocalDb;
  world: LocalWorld;
  auth: CloudAuth;
  /** `<dataDir>/cloud-cursor.json` — a file beside `sidecar.lock`, never a table (the journal is shared). */
  cursorPath: string;
  log?: Diagnostic;
  now?: () => Date;
  /** `/sync` page size. Production takes the default; a test shrinks it to force multiple pages. */
  pageLimit?: number;
  /** How long to wait between full pulls when caught up. */
  pollIntervalMs?: number;
}

export interface CloudMirror {
  /** Drain `/sync` to the horizon, then backfill bodies. Returns the number of applied entities. */
  pullOnce(): Promise<number>;
  /**
   * A WAKE: something committed on the hosted account — pull now, without disturbing the poll.
   *
   * The push channel's entry point (`cloud-wake.ts` calls it per `sync` frame), shaped for
   * bursts: a kick while a pull is IN FLIGHT queues exactly ONE follow-up pull, however many
   * kicks arrive — the in-flight pull may have read `/sync` before the commit that woke us,
   * and the single follow-up reads everything, so N would buy nothing over 1. Failures are
   * not retried here: the poll owns retries and backoff, and a kick is a hint, never a
   * schedule. Fire-and-forget on purpose — a wake has no caller waiting on it.
   */
  kick(): void;
  /** Pull now, then poll. */
  start(): Promise<void>;
  /**
   * Stop polling, ASK ANY IN-FLIGHT PULL TO LEAVE, and resolve once it has.
   *
   * The await is the whole point, and it is why this is not `void`. A pull is a long walk over the
   * network with a database transaction per page; clearing the poll timer stopped the NEXT one and
   * did nothing about the one already running, so quitting closed the database underneath a drain
   * that was still enqueuing work against it. The close waited behind that queue, missed the
   * shell's grace period and the process was killed — every quit, with a page half-applied.
   *
   * The walk checks between pages and between id batches, so what a caller waits for here is one
   * request and one page apply, not the rest of the mailbox. Nothing is left half-written: the
   * cursor is only ever advanced after a page commits, so an interrupted walk resumes from the last
   * page that landed, and a bootstrap interrupted mid-generation stays marked as one so the next
   * launch restarts it rather than sweeping against a partial mark.
   */
  stop(): Promise<void>;
  /**
   * Is a pull running right now? Read by the shutdown log so the line can say whether the mirror
   * was the thing holding the quit up — the stdio host's own in-flight count says nothing about it.
   */
  draining(): boolean;
  /**
   * Is the hosted account reachable right now? True optimistically at construction; a pull that
   * fails (bad network, spent token) flips it false, a pull that succeeds flips it back. The
   * write-through proxy reads this to answer `503 offline_read_only` rather than forward into a
   * void, and `/health` surfaces it so the shell can render the mode.
   */
  online(): boolean;
  /** Report connectivity observed elsewhere — the proxy's own forward reaching Cloud, or not. */
  markConnectivity(reachable: boolean): void;
  /**
   * The hosted `change_log` seq the mirror has drained `/sync` up to, decoded from the cursor.
   * This is the CLOUD sequence — the one an `X-Sync-Seq` echo is expressed in — NOT the local
   * `change_log`, which is a different sequence entirely. `0n` before the first page.
   */
  cloudSeq(): bigint;
  /**
   * Pull (single-flight) until `cloudSeq() >= target`, or until `deadlineMs` elapses; returns
   * whether it covered. This is the write-through echo: a hosted mutation echoes its `X-Sync-Seq`
   * (a cloud seq) and the proxy waits here so the client's immediate re-drain of the local `/sync`
   * already contains its own write.
   */
  awaitCloudSeq(target: bigint, deadlineMs: number): Promise<boolean>;
  /**
   * HOW MANY MESSAGES THE HOSTED ACCOUNT HOLDS, per hosted mailbox id — the numbers this mirror
   * is draining TOWARD, not the ones it holds.
   *
   * Empty until the first counted refresh (see {@link HOSTED_COUNTS_TTL_MS}), and empty for ever
   * on an install whose account answers no counts. An empty map means "this process cannot tell",
   * and every consumer must render that as an ABSENT number rather than a zero: `0` here would
   * assert that somebody's account is empty, which is the one thing a mirror may never say about
   * the master copy.
   *
   * In memory on purpose. It is not a mirrored row: the `mailboxes` table is the shared mail
   * schema, running on hosted Postgres and on this PGlite from one journal, and a column that
   * means something only inside a mirror would be dead and misnamed on the hosted side. It also
   * SHOULD die with the process — a count is a measurement with a timestamp, and the honest
   * lifetime of an unrefreshed one is short.
   */
  hostedCounts(): ReadonlyMap<string, number>;
}

export const DEFAULT_CLOUD_POLL_MS = 20_000;

/**
 * HOW OLD THE HOSTED MESSAGE COUNTS MAY GET before the next refresh asks for them again.
 *
 * `GET /mailboxes?counts=1` is one grouped aggregate over the account's whole `messages` table,
 * and `packages/api/src/routes/mailboxes.ts` makes it opt-in precisely so that a POLLED route
 * cannot put that scan behind a heartbeat. This mirror polls every {@link DEFAULT_CLOUD_POLL_MS},
 * which is three times a minute — so asking for counts on every refresh would be exactly the
 * thing that doc-block refuses, from a client instead of a tab.
 *
 * Fifteen minutes, with {@link HOSTED_COUNTS_MIN_GAP_MS} as a hard floor beneath it, puts a steady
 * install at four counted reads an hour. The number the counts feed is a sentence about a
 * shortfall of dozens of messages or more; it does not need to be fresher than this, and the
 * cases where it DOES need to be fresh — a process that has just started, a bootstrap, a drain
 * that reported a backlog — are asked for by name rather than by shortening this.
 */
export const HOSTED_COUNTS_TTL_MS = 15 * 60_000;

/**
 * The floor under every reason to ask for counts, including the by-name ones.
 *
 * `refreshMailboxes` runs at the top of every pull AND once more mid-drain when a page names a
 * mailbox the list did not (a real sequence on a fresh install). Without a floor, "the map is
 * empty" and "the drain saw a backlog" would both re-trigger inside one pull and a bootstrap
 * would ask for the aggregate repeatedly while it was doing the most work. One a minute at the
 * very most, whatever the reason.
 */
export const HOSTED_COUNTS_MIN_GAP_MS = 60_000;

/**
 * Reconnect backoff. A pull that fails (dropped network, spent token) retries soon and then backs
 * off exponentially to a ceiling, rather than waiting a full poll interval or hammering every tick.
 * A success resets it and returns to the steady poll cadence.
 */
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 300_000;

const asDate = (iso: string | null | undefined): Date | null => (iso ? new Date(iso) : null);

/** The cursor file's shape. `bodies` is the serialized {@link BodiesWalk}. */
interface CursorFile {
  version?: unknown;
  sync?: unknown;
  bodies?: unknown;
  bootstrapping?: unknown;
  tagBackfill?: unknown;
  folderBackfill?: unknown;
  capMarkerRepair?: unknown;
}

function readCursor(path: string): CursorState {
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as CursorFile;
    return {
      // ABSENT ⇒ 0 ⇒ re-key. Read {@link CURSOR_VERSION} before changing this expression: the
      // whole migration hangs off an unrecognised value defaulting to the OLD format, and a
      // `?? CURSOR_VERSION` here would silently exempt every install that has the defect.
      version: typeof j.version === "number" && Number.isFinite(j.version) ? j.version : 0,
      sync: typeof j.sync === "string" && j.sync !== "" ? j.sync : "0",
      bodies: readBodiesWalk(j.bodies),
      bootstrapping: j.bootstrapping === true,
      tagBackfill: j.tagBackfill === true,
      folderBackfill: j.folderBackfill === true,
      // `=== true`, never `?? true`: an absent key must read FALSE. The inverse would silently
      // exempt every install that HAS the defect and leave only fresh ones correct.
      capMarkerRepair: j.capMarkerRepair === true,
    };
  } catch {
    // No file at all is a FRESH install, not an upgraded one: there are no rows to re-key, and the
    // `sync: "0"` below already bootstraps. Stamping the current version keeps the re-key a
    // statement about mirrors that exist.
    return {
      version: CURSOR_VERSION, sync: "0", bodies: { phase: "unresolved" },
      bootstrapping: false, tagBackfill: false, folderBackfill: false,
      // A fresh install has no pre-marker rows and its walk writes markers from the start.
      capMarkerRepair: true,
    };
  }
}

function writeCursor(path: string, state: CursorState): void {
  const onDisk: CursorFile = {
    version: state.version,
    sync: state.sync,
    bodies: writeBodiesWalk(state.bodies),
    bootstrapping: state.bootstrapping,
    tagBackfill: state.tagBackfill,
    folderBackfill: state.folderBackfill,
    capMarkerRepair: state.capMarkerRepair,
  };
  writeFileSync(path, JSON.stringify(onDisk));
}

/** Drop the cursor file. The 410 path deletes it before re-bootstrapping from zero. */
function deleteCursor(path: string): void {
  rmSync(path, { force: true });
}

/** A drain begins as a bootstrap iff it starts at `since=0` — a `""`/`"0"` cursor. */
const isBootstrapCursor = (s: string): boolean => !s || s === "0";

/**
 * A BOOTSTRAP GENERATION: the ids a since=0 re-pull touched, tagged per entity type.
 *
 * A `since=0` replay carries the account's CURRENT entities, not ancient tombstones. So a message
 * deleted on Cloud while the mirror was offline — its tombstone since fallen below the retention
 * horizon — is simply absent from the replay, and a plain re-pull would leave the local row as a
 * PHANTOM forever. The fix is mark-and-sweep: tag every managed row this generation writes, then
 * delete the managed rows it never touched. Membership is keyed by each table's own id, except
 * `message_state`, whose `/sync` id is its `messageId` (as {@link applyPage} records it).
 */
interface MarkSet {
  add(id: string): void;
  has(id: string): boolean;
}

interface BootstrapGen {
  folder: MarkSet;
  thread: MarkSet;
  message: MarkSet;
  message_state: MarkSet;
  rule: MarkSet;
  draft: MarkSet;
  approval: MarkSet;
  routing_decision: MarkSet;
  tag: MarkSet;
  /**
   * Append every id marked since the last flush to the generation file, fsynced. Called after
   * a page's transaction commits and BEFORE the cursor advances past it — the cursor is the
   * barrier: a crash between the commit and this flush leaves the cursor on the previous page,
   * so the next launch re-applies the page (idempotent upserts) and re-marks it. The dangerous
   * direction — a cursor past rows the file never recorded — is unreachable, and a duplicate
   * line from a re-applied page is absorbed by the set on load.
   */
  flush(): void;
}

/** The generation file, beside the cursor. NDJSON-ish: one `<type> <id>` line per marked row. */
const BOOTSTRAP_GEN_FILE = "cloud-bootstrap-gen.marks";

function genPathFor(cursorPath: string): string {
  return join(dirname(cursorPath), BOOTSTRAP_GEN_FILE);
}

const GEN_TYPES = [
  "folder", "thread", "message", "message_state", "rule", "draft", "approval", "routing_decision", "tag",
] as const;
type GenType = (typeof GEN_TYPES)[number];

function genOver(path: string, sets: Record<GenType, Set<string>>): BootstrapGen {
  const pending: string[] = [];
  const mark = (t: GenType): MarkSet => ({
    add(id: string): void {
      const s = sets[t];
      if (!s.has(id)) {
        s.add(id);
        pending.push(`${t} ${id}`);
      }
    },
    has: (id: string): boolean => sets[t].has(id),
  });
  return {
    folder: mark("folder"),
    thread: mark("thread"), message: mark("message"), message_state: mark("message_state"),
    rule: mark("rule"), draft: mark("draft"), approval: mark("approval"),
    routing_decision: mark("routing_decision"), tag: mark("tag"),
    flush(): void {
      if (pending.length === 0) return;
      const fd = openSync(path, "a");
      try {
        // The WHOLE buffer, looped: `writeSync` may return a short count, and an append that
        // stopped short would fsync a truncated record, clear the pending marks, and let the
        // cursor advance past rows the file never named — which the next resume's sweep would
        // then remove as phantoms. Loop or throw; the cursor must never outrun the marks.
        const buf = Buffer.from(pending.join("\n") + "\n", "utf8");
        let written = 0;
        while (written < buf.length) {
          written += writeSync(fd, buf, written, buf.length - written);
        }
        // Fsynced so an OS-level loss cannot leave the cursor ahead of the marks it rode with.
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      pending.length = 0;
    },
  };
}

const emptyGenSets = (): Record<GenType, Set<string>> => ({
  folder: new Set(),
  thread: new Set(), message: new Set(), message_state: new Set(), rule: new Set(),
  draft: new Set(), approval: new Set(), routing_decision: new Set(), tag: new Set(),
});

/** A FRESH generation: truncate the file, start marking from nothing. */
function newBootstrapGen(path: string): BootstrapGen {
  writeFileSync(path, "");
  return genOver(path, emptyGenSets());
}

/**
 * The generation an interrupted bootstrap left behind, or null when there is none (a fresh
 * install, a pre-generation-file build's leftover, an unreadable file). Null means the caller
 * restarts the bootstrap from zero — the always-safe answer, and the only one available when
 * the marks cannot be trusted.
 */
function loadBootstrapGen(path: string): BootstrapGen | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const sets = emptyGenSets();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const t = line.slice(0, sp) as GenType;
    if (!(GEN_TYPES as readonly string[]).includes(t)) continue;
    sets[t].add(line.slice(sp + 1));
  }
  return genOver(path, sets);
}

/** Drop the generation file — the bootstrap completed and swept, or is starting over. */
function deleteBootstrapGen(path: string): void {
  rmSync(path, { force: true });
}

/** The tx handle `db.transaction` hands its callback. */
type Tx = Parameters<Parameters<LocalDb["transaction"]>[0]>[0];

/** For the one apply path that carries no mailbox-bearing entity — see `applyTagBackfill`. */
const EMPTY_MAILBOXES: ReadonlySet<string> = new Set<string>();

async function messagePresent(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.select({ id: messages.id }).from(messages).where(eq(messages.id, id)).limit(1);
  return rows.length > 0;
}

async function threadPresent(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.select({ id: threads.id }).from(threads).where(eq(threads.id, id)).limit(1);
  return rows.length > 0;
}

/**
 * A hosted `MailboxDTO` as the local row that mirrors it — **minus the two progress stamps.**
 *
 * `lastSyncAt` and `initialImportCompletedAt` are DELIBERATELY ABSENT and copying them would break
 * the body walk in a way that shows as blank mail. `initial_import_completed_at` is what
 * `resolveBodiesWalk` reads back to tell a finished body walk from one that never started; a
 * hosted account has finished ITS import long ago, so copying the stamp onto a mirror that has
 * fetched no body yet resolves the walk as `complete` and hands the account to
 * `fetchMissingBodies` — which asks only about messages this mirror already holds. On a first pull
 * that is none of them, so every message would open blank for ever.
 *
 * They are stamps about THIS mirror's own progress, written by `stampSynced` when a pull of THIS
 * process drains with the walk spent, and the hosted account's answer to the same question is a
 * different fact with the same name.
 */
function mailboxRow(world: LocalWorld, m: MailboxDTO, now: Date) {
  return {
    // THE ACCOUNT IS REMAPPED, THE ID IS NOT — the asymmetry this file's header is about. The row
    // keeps the HOSTED id, because that id is what every mirrored message names and what a send
    // has to carry back to Cloud.
    accountId: world.accountId,
    provider: m.provider,
    address: m.address,
    displayName: m.displayName ?? null,
    status: m.status,
    authKind: m.authKind,
    // `?? null` on every one of these rather than omission, for the reason the rule upsert states:
    // this object IS the `onConflictDoUpdate` set, so a key left out would make a value that was
    // CLEARED on Cloud persist locally — a mailbox that recovered would keep rendering its old
    // failure.
    errorCode: m.errorCode ?? null,
    errorDetail: m.errorDetail ?? null,
    failedAt: asDate(m.failedAt),
    retryCount: m.retryCount ?? 0,
    syncBlockedReason: m.syncBlockedReason ?? null,
    syncBlockedSince: asDate(m.syncBlockedSince),
    disabledReason: m.disabledReason ?? null,
    smtpMaxSizeBytes: m.smtpMaxSizeBytes ?? null,
    // NOT decoration: `compose-from.ts` orders the From options by `createdAt` ascending and calls
    // the first sendable one the default sender. A mirror that stamped its own clock here would
    // pick a different default from the browser tab looking at the same account.
    createdAt: asDate(m.createdAt) ?? now,
  };
}

/**
 * Does anything still point at this mailbox row? The guard on deleting a retired one.
 *
 * Seven tables carry `mailbox_id` foreign keys (`schema-mail.ts`). Only two of them can hold rows
 * on the Cloud door — `messages` and `drafts`, both written by this file — but the other five are
 * checked anyway: this runs on a database that may have been a STANDALONE install before the door
 * was switched, and a delete that trips a foreign key aborts the whole refresh transaction.
 */
async function mailboxReferenced(tx: Tx, id: string): Promise<boolean> {
  const hit = async (rows: Promise<readonly unknown[]>): Promise<boolean> => (await rows).length > 0;
  if (await hit(tx.select({ x: messages.id }).from(messages).where(eq(messages.mailboxId, id)).limit(1))) return true;
  if (await hit(tx.select({ x: drafts.id }).from(drafts).where(eq(drafts.mailboxId, id)).limit(1))) return true;
  if (await hit(tx.select({ x: messageInstances.id }).from(messageInstances).where(eq(messageInstances.mailboxId, id)).limit(1))) return true;
  if (await hit(tx.select({ x: messageFailures.id }).from(messageFailures).where(eq(messageFailures.mailboxId, id)).limit(1))) return true;
  if (await hit(tx.select({ x: unsubscribeRecords.id }).from(unsubscribeRecords).where(eq(unsubscribeRecords.mailboxId, id)).limit(1))) return true;
  if (await hit(tx.select({ x: mailboxFolders.id }).from(mailboxFolders).where(eq(mailboxFolders.mailboxId, id)).limit(1))) return true;
  if (await hit(tx.select({ x: mailboxCredentials.mailboxId }).from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, id)).limit(1))) return true;
  return false;
}

/**
 * Remove retired mailbox rows nothing references any more — the second half of the synthetic row's
 * retirement, and the reason it is a two-step.
 *
 * A FRESH install reaches this inside the refresh transaction with the synthetic row holding zero
 * references (the refresh precedes the first drain), so it goes immediately. An UPGRADED install
 * reaches it with every mirrored message still pointing at that row, so it survives as a tombstone
 * until the re-key has moved them, and this runs again once the drain has finished.
 *
 * The zero-reference guard is what makes the two cases one rule instead of a special case for
 * each — and it is also the honest answer for a mailbox REMOVED on Cloud: its mail is still here,
 * so its row stays, exactly as `mailboxes_active_address_uq`'s partial index expects a tombstone to.
 */
async function dropRetiredMailboxes(tx: Tx, world: LocalWorld, hostedIds: readonly string[]): Promise<string[]> {
  const rows = await tx.select({ id: mailboxes.id }).from(mailboxes).where(
    and(
      eq(mailboxes.accountId, world.accountId),
      eq(mailboxes.status, "disabled"),
      ...(hostedIds.length > 0 ? [notInArray(mailboxes.id, [...hostedIds])] : []),
    ),
  );
  const dropped: string[] = [];
  for (const row of rows) {
    if (await mailboxReferenced(tx, row.id)) continue;
    await tx.delete(mailboxes).where(eq(mailboxes.id, row.id));
    dropped.push(row.id);
  }
  return dropped;
}

/** What one mailbox refresh did, for the log line and for the tests that watch the ordering. */
export interface MailboxRefreshOutcome {
  /** Every local mailbox id after the refresh — what an incoming DTO's `mailboxId` is checked against. */
  known: Set<string>;
  /** Rows that were active and are not in the hosted answer: the synthetic row, or a removed mailbox. */
  retired: string[];
  /** Retired rows nothing referenced, so they are gone rather than tombstoned. */
  dropped: string[];
}

/**
 * APPLY ONE HOSTED MAILBOX LIST INTO THE LOCAL TABLE — retire, upsert and prune, IN ONE
 * TRANSACTION, in that order.
 *
 * ── THE ORDER IS A UNIQUE-CONSTRAINT DODGE ────────────────────────────────────────────────────
 *
 * `mailboxes_active_address_uq` is `(account_id, lower(address)) where status <> 'disabled'`. On
 * the common install the synthetic row's address IS the hosted mailbox's address — the account
 * login and the mailbox are the same string — so inserting the hosted row while the synthetic one
 * is still `connected` violates it. Retiring first frees the index; the upsert then lands.
 *
 * ── AND THE TRANSACTION IS WHY `GET /mailboxes` NEVER ANSWERS `[]` ────────────────────────────
 *
 * `DesktopMailboxes.tsx` states the rule from the other side: the mailbox probe must REJECT rather
 * than return an empty list, because "we could not ask" and "there are none" render differently —
 * the second puts "No mailbox connected, so nothing can arrive" in front of somebody whose mailbox
 * is working. This read is served locally and cannot fail that way, so the empty window has to be
 * closed here instead: split into two transactions, a reader between them sees a table holding
 * only tombstones and gets exactly that sentence.
 *
 * ── A RETIREMENT IS AN ORDINARY TOMBSTONE, WITH `disabled_reason` NULL ────────────────────────
 *
 * Deliberately not one of the `organized_elsewhere:*` members: `identity.ts`'s lookup returns a
 * disabled row only when it carries a reason (a lease stand-down is the SAME mailbox, paused), so
 * a NULL reason is what stops a later launch resurrecting the synthetic row it just retired.
 */
export async function applyMailboxRefresh(
  db: LocalDb,
  world: LocalWorld,
  hosted: readonly MailboxDTO[],
  now: Date,
): Promise<MailboxRefreshOutcome> {
  const hostedIds = hosted.map((m) => m.id);
  return db.transaction(async (tx) => {
    // (i) RETIRE what the hosted account does not name — the synthetic row on a first refresh, a
    //     mailbox somebody removed in the browser on any later one.
    const retired = await tx.update(mailboxes)
      .set({ status: "disabled", disabledReason: null })
      .where(and(
        eq(mailboxes.accountId, world.accountId),
        ne(mailboxes.status, "disabled"),
        ...(hostedIds.length > 0 ? [notInArray(mailboxes.id, hostedIds)] : []),
      ))
      .returning({ id: mailboxes.id });

    // (ii) UPSERT the hosted rows, keyed on the HOSTED id.
    for (const m of hosted) {
      const row = mailboxRow(world, m, now);
      await tx.insert(mailboxes).values({ id: m.id, ...row } as typeof mailboxes.$inferInsert)
        .onConflictDoUpdate({ target: mailboxes.id, set: row });
    }

    // (iii) PRUNE. A tombstone nothing references is not a mailbox, it is a phantom disconnection
    //       in somebody's Settings pane.
    const dropped = await dropRetiredMailboxes(tx, world, hostedIds);

    const all = await tx.select({ id: mailboxes.id }).from(mailboxes)
      .where(eq(mailboxes.accountId, world.accountId));
    return { known: new Set(all.map((r) => r.id)), retired: retired.map((r) => r.id), dropped };
  });
}

/**
 * REPLACE a message's tag assignments with exactly the ones its DTO carries.
 *
 * ── WHY IT IS A REPLACE AND NOT AN UPSERT ───────────────────────────────────────────────────
 *
 * `labels` is the whole set, not a delta: an UNassign is delivered as the same `message` change
 * with one fewer id in it. An insert-only apply would therefore add tags and never remove one, so
 * a tag taken off a message in the browser would stay on it here for ever. Delete-then-insert
 * inside the page transaction gives the set semantics the wire actually has, and it is idempotent
 * on replay for the same reason every other write here is.
 *
 * ── AN ID NAMING A TAG WE HAVE NOT GOT IS SKIPPED, NOT STUBBED ──────────────────────────────
 *
 * `message_tags.tag_id` has a foreign key, so an assignment can only be written for a tag that is
 * already mirrored. The ordinary case is covered by {@link APPLY_ORDER}: a tag exists before it can
 * be assigned, so its change carries a lower seq and lands first. What is left is the case where
 * the tag's create has fallen below the feed's retention horizon while the message's own change has
 * not — and there the honest answer is to skip the assignment rather than invent a nameless tag to
 * hang it on. The client filters its tag list against each message's labels, so a label it cannot
 * resolve would draw nothing anyway; a stub would draw an empty chip.
 */
async function applyLabels(tx: Tx, world: LocalWorld, messageId: string, labels: readonly string[] | undefined): Promise<void> {
  await tx.delete(messageTags).where(eq(messageTags.messageId, messageId));
  if (!labels || labels.length === 0) return;
  for (const tagId of new Set(labels)) {
    const known = await tx.select({ id: tags.id }).from(tags).where(eq(tags.id, tagId)).limit(1);
    if (known.length === 0) continue;
    await tx.insert(messageTags)
      .values({ accountId: world.accountId, messageId, tagId })
      .onConflictDoNothing();
  }
}

/**
 * Apply one non-delete change. Returns false when a foreign-key referent is missing and the row
 * is skipped — the cursor still advances (a later update to the same entity re-emits it), which is
 * the forward-compatible posture `apply.ts` takes toward an unknown type.
 *
 * ── "A LATER UPDATE RE-EMITS IT" IS TRUE OF THE FK SKIPS AND FALSE OF THE MAILBOX ONE ─────────
 *
 * A message whose thread has not arrived is skipped and will come back, because something about
 * that message will change again. A message naming a MAILBOX this database does not hold will not:
 * mailboxes change far less often than mail, and a message already at rest emits nothing. That is
 * why the refresh runs BEFORE the drain and why {@link CloudMirrorConfig} makes it a hard failure
 * when it cannot — the skip below is the last resort, not the mechanism.
 *
 * `known` is every local mailbox id, whatever its status: a tombstoned row still satisfies the
 * foreign key, so mail belonging to a mailbox removed on Cloud keeps landing where it belongs
 * rather than being attributed to a different address. **Attributing to a different mailbox is the
 * one thing this may never do** — that is the wrong-sender class of defect the From selector's own
 * rules exist to prevent, and a message the mirror cannot place honestly is better absent.
 */
async function applyUpsert(
  tx: Tx,
  world: LocalWorld,
  ch: SyncChange,
  now: Date,
  gen: BootstrapGen | null,
  known: ReadonlySet<string>,
): Promise<boolean> {
  switch (ch.type) {
    case "folder": {
      // ONE OF THE MAILBOX'S OWN FOLDERS (the folders foundation). The local row takes the
      // HOSTED entity's id verbatim — the local /sync materializes folder entities BY ROW ID
      // and the shell deep-links `#/folder/<id>`, so hosted and local links are one namespace.
      // Guarded on the mirrored mailbox exactly as messages are: never re-attributed, never
      // invented. The local "Use folders" flag is reconciled after the page (see applyPage) —
      // the local SyncService gates its folder reads on it, and the honest local value is
      // derived from what the hosted feed actually sent.
      const f = ch.entity as { id?: string; name?: string; mailboxId?: string } | undefined;
      if (!f?.name || !f.mailboxId) return false;
      if (!known.has(f.mailboxId)) return false;
      await tx.insert(mailboxFolders).values({
        id: ch.id, mailboxId: f.mailboxId, folder: f.name, updatedAt: now,
      }).onConflictDoUpdate({
        target: mailboxFolders.id,
        set: { mailboxId: f.mailboxId, folder: f.name, updatedAt: now },
      });
      gen?.folder.add(ch.id);
      return true;
    }
    case "thread": {
      const t = ch.entity as ThreadDTO | undefined;
      if (!t) return false;
      await tx.insert(threads).values({
        id: t.id,
        accountId: world.accountId,
        subject: t.subject ?? "",
        participants: t.participants ?? [],
        lastMessageAt: asDate(t.lastMessageAt),
        muted: !!t.muted,
        updatedAt: asDate(t.updatedAt) ?? now,
      }).onConflictDoUpdate({
        target: threads.id,
        set: {
          subject: t.subject ?? "",
          participants: t.participants ?? [],
          lastMessageAt: asDate(t.lastMessageAt),
          muted: !!t.muted,
          updatedAt: asDate(t.updatedAt) ?? now,
        },
      });
      gen?.thread.add(t.id);
      return true;
    }
    case "message": {
      const m = ch.entity as MessageDTO | undefined;
      if (!m) return false;
      // The mailbox this message belongs to has to be mirrored before the message can be. See the
      // header: never re-attributed, never invented.
      if (!known.has(m.mailboxId)) return false;
      // A thread STUB before the message, so the FK holds even when the thread's own change has
      // not arrived. A later `thread` change overwrites the stub with the real row.
      if (m.threadId) {
        await tx.insert(threads)
          .values({ id: m.threadId, accountId: world.accountId, updatedAt: now })
          .onConflictDoNothing({ target: threads.id });
      }
      const display = {
        /* THE ATTRIBUTION, AND IT IS IN THE CONFLICT SET FOR A REASON. This object is both the
           insert's display half and the `onConflictDoUpdate` set; `mailbox_id` used to be in
           neither, written once from the synthetic local id at insert time. Leaving it out of the
           set here would make the re-key a no-op — every already-mirrored message would keep the
           id it was first written with, which is precisely the row this slice exists to correct. */
        mailboxId: m.mailboxId,
        messageIdHeader: m.messageIdHeader ?? null,
        subject: m.subject ?? "",
        fromAddress: m.from?.address ?? "",
        fromName: m.from?.name ?? null,
        date: asDate(m.date),
        nativeLocator: { folder: m.folder },
        noAi: !!m.sensitivity?.no_ai,
        noForward: !!m.sensitivity?.no_forward,
        noKb: !!m.sensitivity?.no_kb,
        priority: !!m.sensitivity?.priority,
        sensitivityCategory: m.sensitivity?.category ?? null,
        threadId: m.threadId ?? null,
        unread: !!m.unread,
        snippet: m.snippet ?? "",
        toAddresses: m.to ?? [],
        ccAddresses: m.cc ?? [],
        hasAttachments: !!m.hasAttachments,
        attachmentCount: m.attachmentCount ?? 0,
        updatedAt: asDate(m.updatedAt) ?? now,
      };
      await tx.insert(messages).values({
        id: m.id,
        accountId: world.accountId,
        // A mirror carries no raw body, so it derives no dedup/body hash. `dedup_key` is unique per
        // mailbox; keying it to the message id keeps the constraint honest without a body to hash.
        bodyHash: "",
        dedupKey: `cloud:${m.id}`,
        ...display,
      }).onConflictDoUpdate({ target: messages.id, set: display });
      // `folder_state.desired_folder` is what `message-service.ts` projects as the message's folder.
      await tx.insert(folderState).values({
        messageId: m.id,
        desiredFolder: m.folder,
        observedFolder: m.folder,
        lastSetBy: "external",
        reconcileStatus: "reconciled",
        updatedAt: now,
      }).onConflictDoUpdate({
        target: folderState.messageId,
        set: { desiredFolder: m.folder, observedFolder: m.folder, updatedAt: now },
      });
      // The tag assignments this message carries. Written from the message change because that is
      // how the wire delivers them — see {@link applyLabels}.
      await applyLabels(tx, world, m.id, m.labels);
      gen?.message.add(m.id);
      // Mark the thread STUB too: a surviving message pins its thread via the FK, so the sweep must
      // not treat that thread as a phantom even when the thread's own change never arrives.
      if (m.threadId) gen?.thread.add(m.threadId);
      return true;
    }
    case "tag": {
      const t = ch.entity as TagDTO | undefined;
      if (!t) return false;
      const body = {
        accountId: world.accountId,
        name: t.name,
        hue: t.hue ?? "moss",
        updatedAt: asDate(t.updatedAt) ?? now,
      };
      /* ON CONFLICT on the ID, not on the account/name unique index. Two tags cannot share a name
         on the hosted account either, so the index is satisfied by the source; targeting the id is
         what makes a RENAME land as a rename instead of colliding with the row it is renaming. */
      await tx.insert(tags).values({ id: t.id, createdAt: asDate(t.createdAt) ?? now, ...body })
        .onConflictDoUpdate({ target: tags.id, set: body });
      gen?.tag.add(t.id);
      return true;
    }
    case "message_state": {
      const s = ch.entity as MessageStateDTO | undefined;
      if (!s) return false;
      if (!(await messagePresent(tx, s.messageId))) return false;
      await tx.insert(messageStates).values({
        accountId: world.accountId,
        messageId: s.messageId,
        state: s.state,
        bubbleUpAt: asDate(s.bubbleUpAt),
        setAt: asDate(s.setAt) ?? now,
        updatedAt: asDate(s.updatedAt) ?? now,
      }).onConflictDoUpdate({
        target: messageStates.messageId,
        set: {
          state: s.state,
          bubbleUpAt: asDate(s.bubbleUpAt),
          setAt: asDate(s.setAt) ?? now,
          updatedAt: asDate(s.updatedAt) ?? now,
        },
      });
      gen?.message_state.add(s.messageId);
      return true;
    }
    case "rule": {
      const r = ch.entity as RuleDTO | undefined;
      if (!r) return false;
      const stats = r.stats ?? { hits: 0, lastHitAt: null, demotions: 0 };
      const body = {
        accountId: world.accountId,
        kind: r.kind,
        match: r.match,
        destination: r.destination,
        priority: r.priority ?? 0,
        provenance: r.provenance ?? "manual",
        enabled: r.enabled ?? true,
        // The rule's second term. `?? null` and not omission: this object is ALSO the
        // `onConflictDoUpdate` set, so leaving the key out would make a term that was CLEARED in
        // Cloud persist for ever in the local mirror — the row would keep filing a narrow slice of
        // the sender's mail after the user had widened the rule back to all of it. A mirror that
        // cannot un-set a field is not a mirror.
        subjectContains: r.subjectContains ?? null,
        // The third term (mail 0052): `?? null` for the identical un-set reason.
        bodyContains: r.bodyContains ?? null,
        hits: stats.hits ?? 0,
        lastHitAt: asDate(stats.lastHitAt),
        demotions: stats.demotions ?? 0,
        updatedAt: asDate(r.updatedAt) ?? now,
      };
      await tx.insert(rules).values({ id: r.id, ...body })
        .onConflictDoUpdate({ target: rules.id, set: body });
      gen?.rule.add(r.id);
      return true;
    }
    case "draft": {
      const d = ch.entity as DraftDTO | undefined;
      if (!d) return false;
      // The mailbox a draft SENDS FROM, same rule as a message's. A draft whose sender this mirror
      // cannot name is one the hosted API would refuse on send anyway.
      if (!known.has(d.mailboxId)) return false;
      if (d.threadId) {
        await tx.insert(threads)
          .values({ id: d.threadId, accountId: world.accountId, updatedAt: now })
          .onConflictDoNothing({ target: threads.id });
      }
      // `in_reply_to_message_id` has an FK; keep it only when the parent is mirrored.
      const inReplyTo = d.inReplyToMessageId && (await messagePresent(tx, d.inReplyToMessageId))
        ? d.inReplyToMessageId
        : null;
      const body = {
        accountId: world.accountId,
        // The draft's OWN sending mailbox — see the message branch. A draft written against the
        // synthetic id could never be sent: the hosted `PUT /drafts` refuses a mailbox that does
        // not belong to the account, which is the 400 every Cloud-door send used to collect.
        mailboxId: d.mailboxId,
        threadId: d.threadId ?? null,
        inReplyToMessageId: inReplyTo,
        subject: d.subject ?? "",
        body: d.body ?? "",
        html: d.html ?? null,
        to: d.to ?? [],
        cc: d.cc ?? [],
        rationale: d.rationale ?? null,
        status: d.status,
        updatedAt: asDate(d.updatedAt) ?? now,
      };
      await tx.insert(drafts).values({ id: d.id, ...body })
        .onConflictDoUpdate({ target: drafts.id, set: body });
      gen?.draft.add(d.id);
      if (d.threadId) gen?.thread.add(d.threadId);   // the thread stub this draft pinned
      return true;
    }
    case "approval": {
      const a = ch.entity as ApprovalDTO | undefined;
      if (!a) return false;
      const body = {
        accountId: world.accountId,
        kind: a.kind,
        messageId: a.messageId ?? null,
        routingDecisionId: a.routingDecisionId ?? null,
        action: a.proposed?.action ?? "",
        summary: a.proposed?.summary ?? "",
        payload: (a.proposed?.payload ?? null) as unknown,
        confidence: a.confidence ?? null,
        status: a.status,
        expiresAt: asDate(a.expiresAt),
        updatedAt: asDate(a.updatedAt) ?? now,
      };
      await tx.insert(approvals).values({ id: a.id, ...body })
        .onConflictDoUpdate({ target: approvals.id, set: body });
      gen?.approval.add(a.id);
      return true;
    }
    case "routing_decision": {
      const rd = ch.entity as RoutingDecisionDTO | undefined;
      if (!rd) return false;
      if (!(await messagePresent(tx, rd.messageId))) return false;
      const body = {
        accountId: world.accountId,
        messageId: rd.messageId,
        inputProvenance: rd.inputProvenance,
        matchedRuleId: rd.matchedRuleId ?? null,
        destination: rd.destination,
        confidence: rd.confidence ?? null,
        rationale: rd.rationale ?? null,
        spam: !!rd.spam,
        status: rd.status,
        updatedAt: asDate(rd.updatedAt) ?? now,
      };
      await tx.insert(routingDecisions).values({ id: rd.id, ...body })
        .onConflictDoUpdate({ target: routingDecisions.id, set: body });
      gen?.routing_decision.add(rd.id);
      return true;
    }
    default:
      // Forward-compatible: an unknown type (e.g. "folder", which has no local table) is skipped
      // exactly as `apply.ts` tolerates an unknown entity rather than wedging the feed.
      return false;
  }
}

/**
 * Apply one delete. Children of a message go first, so the message's own FKs are clear.
 *
 * ── EVERY `message_id` FOREIGN KEY, NOT JUST THE ONES THIS FILE WRITES ────────────────────────
 *
 * A delete that misses one FK-holder does not lose that one row — it ABORTS THE WHOLE PAGE
 * TRANSACTION with 23503, the cursor never advances past the page, and the retry replays the
 * identical page into the identical violation: the mirror is wedged for ever while looking like
 * a transient network error. Measured live 2026-08-24 on a Linux install: one local draft whose
 * `in_reply_to_message_id` named a message deleted on Cloud pinned the cursor for two days
 * (`cloud_pull_failed` code 23503 on every poll), which the user experiences as "the desktop is
 * stale". The hosted store never hits this because ITS delete is a `deleted_at` stamp — the row
 * stays and every FK stays satisfied; the mirror's hard delete has to clear the children itself.
 *
 * So this clears every table `schema-mail.ts` points at `messages.id` — including the five the
 * Cloud door never writes (instances, flag state, tracker events, attachments, unsubscribe
 * records), for `mailboxReferenced`'s reason: this can run on a database that was a STANDALONE
 * install before the door was switched, and those tables hold that era's rows.
 *
 * A replying draft is DETACHED (`in_reply_to_message_id` → NULL), not deleted: the draft is the
 * user's writing and outlives its target, exactly as the hosted store keeps it when the message
 * it answers goes to Trash. A re-emitted draft converges — the upsert guards that column on
 * `messagePresent` and writes NULL for a target the mirror no longer holds. A draft on a DELETED
 * THREAD is detached the same way (`thread_id` → NULL), never deleted with it: the hosted store
 * still holds that draft, and a mirror that destroyed it would resurrect it only on its next
 * hosted edit — a draft at rest emits nothing.
 *
 * ── AND EVERY DETACH IS REPORTED, so the projection hears about the survivor ─────────────────
 *
 * A detach is a real change to a row the incoming feed did not name. The local `/sync` is
 * `change_log` over this database, so a detach nothing records is a detach the window never
 * redraws — a message still grouped under a deleted thread, for as long as that message stays at
 * rest. `detached` collects the survivors; the caller appends one local `update` change-log row
 * per entry in the same transaction, exactly as it records the delete itself.
 */
interface DetachedSurvivor { type: "message" | "draft"; id: string }

/**
 * How many survivor announcements one `recordChanges` call may carry.
 *
 * PGlite 0.2.17 accepts at most 32,767 bind parameters per statement, and a change-log insert
 * spends six per row — so a single unchunked batch THROWS (`RangeError: Invalid array length`) at
 * exactly 5,462 rows, measured. The failure mode is the one this whole slice removes: the page
 * transaction rolls back, the cursor never advances, and every poll replays the same tombstone —
 * a thread hoarding 5,462 stale messages would wedge the mirror by being repaired. 1,000 rows is
 * 6,000 parameters: comfortably under the cap, still ~5 statements for the largest plausible
 * thread instead of three per survivor.
 */
const DETACHED_BATCH_MAX = 1000;

/** Announce detached survivors on the local change log, in parameter-safe slices. */
async function recordDetached(tx: Tx, world: LocalWorld, detached: readonly DetachedSurvivor[]): Promise<void> {
  for (let i = 0; i < detached.length; i += DETACHED_BATCH_MAX) {
    await recordChanges(tx, detached.slice(i, i + DETACHED_BATCH_MAX).map((d) => ({
      accountId: world.accountId, entityType: d.type, entityId: d.id, op: "update" as const, meta: null,
    })));
  }
}

async function applyDelete(tx: Tx, ch: SyncChange, detached?: DetachedSurvivor[]): Promise<boolean> {
  switch (ch.type) {
    case "message": {
      if (!(await messagePresent(tx, ch.id))) return false;
      const replying = await tx.select({ id: drafts.id }).from(drafts)
        .where(eq(drafts.inReplyToMessageId, ch.id));
      await tx.update(drafts).set({ inReplyToMessageId: null })
        .where(eq(drafts.inReplyToMessageId, ch.id));
      for (const d of replying) detached?.push({ type: "draft", id: d.id });
      await tx.delete(folderState).where(eq(folderState.messageId, ch.id));
      await tx.delete(messageStates).where(eq(messageStates.messageId, ch.id));
      await tx.delete(messageBodies).where(eq(messageBodies.messageId, ch.id));
      await tx.delete(routingDecisions).where(eq(routingDecisions.messageId, ch.id));
      // The assignments hang off the message by FK, so they go before it.
      await tx.delete(messageTags).where(eq(messageTags.messageId, ch.id));
      // The standalone era's children (see header) — empty on a pure Cloud-door database.
      await tx.delete(messageInstances).where(eq(messageInstances.messageId, ch.id));
      await tx.delete(flagState).where(eq(flagState.messageId, ch.id));
      await tx.delete(trackerEvents).where(eq(trackerEvents.messageId, ch.id));
      await tx.delete(attachments).where(eq(attachments.messageId, ch.id));
      await tx.delete(unsubscribeRecords).where(eq(unsubscribeRecords.messageId, ch.id));
      await tx.delete(messages).where(eq(messages.id, ch.id));
      return true;
    }
    case "folder":
      // The inventory row alone: a folder entity's delete says "stop showing this folder", never
      // anything about mail — the messages that lived there keep their own lifecycle (the
      // hosted feed tombstones them separately if they go).
      await tx.delete(mailboxFolders).where(eq(mailboxFolders.id, ch.id));
      return true;
    case "tag":
      // Assignments first, for the same FK reason, and this is also what a deleted tag MEANS: the
      // messages stay, they simply stop carrying it.
      await tx.delete(messageTags).where(eq(messageTags.tagId, ch.id));
      await tx.delete(tags).where(eq(tags.id, ch.id));
      return true;
    case "thread": {
      if (!(await threadPresent(tx, ch.id))) return false;
      // The thread's drafts are DETACHED, never deleted with it (see the header): the hosted
      // store still holds them, and their send records (`outbound_sends.draft_id`, standalone
      // era) would otherwise be one more foreign key wedging the page. A later hosted edit of
      // the draft re-points it — the upsert's own thread stub covers a thread that is gone.
      const orphaned = await tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.threadId, ch.id));
      await tx.update(drafts).set({ threadId: null }).where(eq(drafts.threadId, ch.id));
      for (const d of orphaned) detached?.push({ type: "draft", id: d.id });
      // Notes hang off the thread by a NOT NULL FK (standalone era; the Cloud door writes none),
      // so they cannot be detached — they go with the thread they annotate.
      await tx.delete(threadNotes).where(eq(threadNotes.threadId, ch.id));
      // Same wedge as the message case, from the other side: `messages.thread_id` is an FK, and
      // a hosted merge deletes the losing thread (`thread-service.ts#merge`). Ordinarily the same
      // page re-points every message first (updates apply before deletes), but a message whose
      // upsert was SKIPPED — unknown mailbox, or its update fell below the feed's retention
      // horizon — still holds the old thread id, and one such row would pin the cursor for ever.
      // Detach rather than delete: the message is real mail; its own next update re-threads it.
      const unthreaded = await tx.select({ id: messages.id }).from(messages).where(eq(messages.threadId, ch.id));
      await tx.update(messages).set({ threadId: null })
        .where(eq(messages.threadId, ch.id));
      for (const m of unthreaded) detached?.push({ type: "message", id: m.id });
      await tx.delete(threads).where(eq(threads.id, ch.id));
      return true;
    }
    case "message_state":
      await tx.delete(messageStates).where(eq(messageStates.messageId, ch.id));
      return true;
    case "rule":
      await tx.delete(rules).where(eq(rules.id, ch.id));
      return true;
    case "draft":
      // Send records reference the draft (standalone era; the Cloud door proxies sends to the
      // hosted account and writes none locally).
      await tx.delete(outboundSends).where(eq(outboundSends.draftId, ch.id));
      await tx.delete(drafts).where(eq(drafts.id, ch.id));
      return true;
    case "approval":
      await tx.delete(approvals).where(eq(approvals.id, ch.id));
      return true;
    case "routing_decision":
      await tx.delete(routingDecisions).where(eq(routingDecisions.id, ch.id));
      return true;
    default:
      return false;
  }
}

/**
 * Apply one `/sync` page in ONE transaction, emitting a local change-log row per applied entity.
 * `gen`, when present, is the bootstrap generation this page belongs to: every upsert marks the row
 * it touched so the trailing sweep can tell survivors from phantoms.
 */
async function applyPage(
  db: LocalDb,
  world: LocalWorld,
  resp: SyncResponse,
  now: Date,
  gen: BootstrapGen | null,
  known: ReadonlySet<string>,
): Promise<number> {
  const changes: SyncChange[] = [
    ...resp.changes.creates, ...resp.changes.updates, ...resp.changes.moves, ...resp.changes.deletes,
  ];
  if (changes.length === 0) return 0;
  changes.sort((a, b) => a.seq - b.seq);   // rule 1: ascending seq
  const nonDeletes = changes.filter((c) => c.op !== "delete");
  const deletes = changes.filter((c) => c.op === "delete");

  return db.transaction(async (tx) => {
    let applied = 0;
    const record = async (type: EntityType, id: string, op: ChangeOp, move?: SyncChange["move"]): Promise<void> => {
      await recordChange(tx, {
        accountId: world.accountId,
        entityType: type,
        entityId: id,
        op,
        meta: op === "move" && move ? { from: move.from ?? null, to: move.to } : null,
      });
    };

    for (const type of APPLY_ORDER) {
      for (const ch of nonDeletes) {
        if (ch.type !== type) continue;
        if (await applyUpsert(tx, world, ch, now, gen, known)) {
          await record(type, ch.id, ch.op, ch.move);
          applied++;
        }
      }
    }
    for (const type of [...APPLY_ORDER].reverse()) {
      for (const ch of deletes) {
        if (ch.type !== type) continue;
        const detached: DetachedSurvivor[] = [];
        if (await applyDelete(tx, ch, detached)) {
          await record(type, ch.id, "delete");
          // The survivors the delete DETACHED (a draft losing its reply target, a message losing
          // its thread) changed too, and the feed did not name them — see applyDelete's header.
          // Batched (not a per-row loop holding the seq counter), and CHUNKED (not one statement
          // that dies on PGlite's bind-parameter cap) — see DETACHED_BATCH_MAX.
          await recordDetached(tx, world, detached);
          applied++;
        }
      }
    }
    // A page that moved the folder inventory also settles the local flag it is read behind —
    // same transaction, so the local /sync can never see rows the flag disowns or vice versa.
    if (changes.some((c) => c.type === "folder")) {
      await reconcileLocalFoldersFlag(tx, world, now);
    }
    return applied;
  });
}

/**
 * THE MARK-AND-SWEEP. After a `since=0` bootstrap drain, delete every managed mail row the
 * generation never touched — the phantoms.
 *
 * FK-safe, children before parents: routing decisions, approvals, drafts, message states and rules
 * first (each can be an independent phantom hanging off a SURVIVING message when only that child was
 * removed on Cloud), then messages — whose delete cascades folder_state, bodies, states and routing
 * decisions exactly as a tombstone would — and threads last, whose delete detaches their surviving
 * drafts and messages rather than taking user writing with it.
 *
 * Each swept entity appends a local DELETE change-log row, so the Swift projection's own `/sync`
 * drops it too; a sweep the reader never hears about would leave the phantom on screen. `applyDelete`
 * is reused verbatim so the cascade matches the incremental delete path byte for byte.
 */
async function sweepPhantoms(db: LocalDb, world: LocalWorld, gen: BootstrapGen, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    let swept = 0;
    const sweepOne = async (type: EntityType, id: string): Promise<void> => {
      const ch: SyncChange = { type, op: "delete", id, seq: 0, updatedAt: now.toISOString() };
      const detached: DetachedSurvivor[] = [];
      if (await applyDelete(tx, ch, detached)) {
        await recordChange(tx, { accountId: world.accountId, entityType: type, entityId: id, op: "delete", meta: null });
        // Survivors the sweep detached are announced exactly as the incremental path announces
        // them — a change the projection never hears about is a row it never redraws. Batched
        // and chunked for the incremental path's reasons (the seq counter is a lock; the bind
        // parameters are a cap) — see DETACHED_BATCH_MAX.
        await recordDetached(tx, world, detached);
        swept++;
      }
    };

    for (const r of await tx.select({ id: routingDecisions.id }).from(routingDecisions).where(eq(routingDecisions.accountId, world.accountId)))
      if (!gen.routing_decision.has(r.id)) await sweepOne("routing_decision", r.id);
    for (const r of await tx.select({ id: approvals.id }).from(approvals).where(eq(approvals.accountId, world.accountId)))
      if (!gen.approval.has(r.id)) await sweepOne("approval", r.id);
    for (const r of await tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.accountId, world.accountId)))
      if (!gen.draft.has(r.id)) await sweepOne("draft", r.id);
    // `message_state`'s /sync id is its messageId (see applyPage's record call).
    for (const r of await tx.select({ messageId: messageStates.messageId }).from(messageStates).where(eq(messageStates.accountId, world.accountId)))
      if (!gen.message_state.has(r.messageId)) await sweepOne("message_state", r.messageId);
    for (const r of await tx.select({ id: rules.id }).from(rules).where(eq(rules.accountId, world.accountId)))
      if (!gen.rule.has(r.id)) await sweepOne("rule", r.id);
    for (const r of await tx.select({ id: messages.id }).from(messages).where(eq(messages.accountId, world.accountId)))
      if (!gen.message.has(r.id)) await sweepOne("message", r.id);
    for (const r of await tx.select({ id: threads.id }).from(threads).where(eq(threads.accountId, world.accountId)))
      if (!gen.thread.has(r.id)) await sweepOne("thread", r.id);
    /* Tags LAST. A tag deleted on Cloud is a tag whose messages survive and stop carrying it, so
       sweeping one has to happen after the messages it might still be attached to have settled —
       `applyDelete` clears the assignments with it. */
    for (const r of await tx.select({ id: tags.id }).from(tags).where(eq(tags.accountId, world.accountId)))
      if (!gen.tag.has(r.id)) await sweepOne("tag", r.id);
    /* Folder entities the bootstrap never named — a folder deleted (or the feature disabled)
       while this mirror was offline. Scoped through the mirrored mailbox list: `mailbox_folders`
       has no account column, and the mirrored mailboxes ARE this account's. */
    for (const r of await tx.select({ id: mailboxFolders.id }).from(mailboxFolders)
      .innerJoin(mailboxes, eq(mailboxes.id, mailboxFolders.mailboxId))
      .where(eq(mailboxes.accountId, world.accountId)))
      if (!gen.folder.has(r.id)) await sweepOne("folder", r.id);

    await reconcileLocalFoldersFlag(tx, world, now);
    return swept;
  });
}

/**
 * THE LOCAL "USE FOLDERS" FLAG, derived from what the hosted feed actually sent. The local
 * SyncService (cloud-read serves the shell from this database with the SAME service the hosted
 * API uses) gates folder reads on `account_settings.folders_enabled_at` — and the honest local
 * value is exactly "does this mirror hold folder entities": the hosted feed emits them ONLY
 * while the hosted flag is on, and deletes them all on a disable. So: rows present ⇒ ensure the
 * flag is set; none ⇒ ensure it is NULL. (An enabled-but-folderless hosted account mirrors to
 * NULL here, which serves the same empty answer the hosted /sync gives — the shell's own switch
 * reads the hosted /consent over the bridge and stays authoritative for the interface.)
 */
async function reconcileLocalFoldersFlag(tx: Tx, world: LocalWorld, now: Date): Promise<void> {
  const [row] = await tx.select({ id: mailboxFolders.id }).from(mailboxFolders)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxFolders.mailboxId))
    .where(eq(mailboxes.accountId, world.accountId)).limit(1);
  const wantOn = row !== undefined;
  const [settings] = await tx.select({ at: accountSettings.foldersEnabledAt })
    .from(accountSettings).where(eq(accountSettings.accountId, world.accountId)).limit(1);
  const isOn = (settings?.at ?? null) !== null;
  if (wantOn === isOn) return;
  await tx.insert(accountSettings)
    .values({ accountId: world.accountId, foldersEnabledAt: wantOn ? now : null })
    .onConflictDoUpdate({
      target: accountSettings.accountId,
      set: { foldersEnabledAt: wantOn ? now : null, updatedAt: now },
    });
}

/**
 * THE ONE-TIME STALE-MIRROR TAG REPAIR — apply a `GET /sync/snapshot` page into a mirror whose
 * cursor has already run past the tags it never asked for.
 *
 * ── THE SHAPE OF THE DAMAGE ───────────────────────────────────────────────────────────────────
 *
 * `CLOUD_SYNC_TYPES` gained `"tag"` after the first Cloud mirrors were already running. `types=` is
 * a REQUEST, so those mirrors were served no tag change at all — and the tags on the account are
 * old, so their `change_log` rows sit BELOW the cursor those mirrors hold. A delta drain only ever
 * looks forward: it will never deliver them, on any launch, for the life of the install. Signing in
 * fresh is not affected (a `since=0` bootstrap asks for everything from zero and now names `tag`),
 * which is precisely why the fix looked proven when it was not — the case that was tested was the
 * only case that was never broken.
 *
 * ── AND WHY THE TAGS ALONE WOULD NOT LIGHT A SINGLE CHIP ──────────────────────────────────────
 *
 * Assignments do not travel as their own entity: they ride `MessageDTO.labels`, and {@link applyLabels}
 * SKIPS an id naming a tag the mirror has not got, because `message_tags.tag_id` is a foreign key.
 * So on these installs every already-mirrored message applied its labels against an empty `tags`
 * table and kept none of them. Writing the tag rows now would restore the rail and leave every
 * message bare. The repair therefore has two halves, and the second is the one that shows.
 *
 * ── ONE PAGE AT A TIME; THE CALLER PAGES ──────────────────────────────────────────────────────
 *
 * This applies ONE snapshot page. Page 1 carries the account's live state — EVERY tag
 * (`sync-service.ts` refuses to page them, for its own rail-boots-empty reason) — and the caller
 * (`repairStaleTags`) then follows `nextCursor` through the windowed pages and the LABELED TAIL,
 * applying each. The tail is the half that matters here: it carries tagged mail OLDER than the
 * bootstrap window, which the mirror holds (its `/sync?since=0` bootstrap replayed every message,
 * unbounded by the snapshot window) but whose labels were skipped when the tag did not yet exist
 * locally. Paging to the tail is the only way those chips come back — the delta never will, because
 * their `message_tags` changes sit below the cursor this mirror already holds.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────────────────────────
 *
 * It rewrites no message row — only the assignments — so a snapshot read cannot walk a message
 * backwards over a delta the drain has already applied. And it touches only messages whose snapshot
 * DTO carries a NON-EMPTY `labels`: on the mirror this repairs, `message_tags` is necessarily empty
 * (the FK cannot hold a row without a tag), so nothing local can need CLEARING and a message with no
 * labels is already correct. That keeps the change-log churn to the messages that actually gain a
 * chip rather than the whole mailbox. The apply is idempotent (delete-then-insert per message), so a
 * re-run after a mid-drain failure converges rather than doubling anything.
 */
async function applyTagBackfill(
  db: LocalDb,
  world: LocalWorld,
  snap: SnapshotResponse,
  now: Date,
): Promise<{ tags: number; messages: number }> {
  return db.transaction(async (tx) => {
    let tagCount = 0;
    for (const ch of snap.changes) {
      if (ch.type !== "tag" || ch.op === "delete") continue;
      // A tag names no mailbox, so the empty set below is not a shortcut — it is the honest
      // statement that this repair touches nothing a mailbox id could gate.
      if (await applyUpsert(tx, world, ch, now, null, EMPTY_MAILBOXES)) {
        await recordChange(tx, { accountId: world.accountId, entityType: "tag", entityId: ch.id, op: "create", meta: null });
        tagCount++;
      }
    }

    let msgCount = 0;
    // AFTER the tags, in the same transaction, for the FK reason `APPLY_ORDER` exists.
    for (const ch of snap.changes) {
      if (ch.type !== "message" || ch.op === "delete") continue;
      const m = ch.entity as MessageDTO | undefined;
      if (!m?.labels || m.labels.length === 0) continue;
      // Only messages this mirror already holds. A snapshot message that is missing locally is not
      // this repair's business — the drain owns the mail, and it will carry its labels when it lands.
      if (!(await messagePresent(tx, m.id))) continue;
      await applyLabels(tx, world, m.id, m.labels);
      // An `update`, because the message existed before this ran. This row is the only reason the
      // window re-reads the message: without it the projection never asks again and the chips stay
      // off until something else touches the message.
      await recordChange(tx, { accountId: world.accountId, entityType: "message", entityId: m.id, op: "update", meta: null });
      msgCount++;
    }

    return { tags: tagCount, messages: msgCount };
  });
}

export function createCloudMirror(cfg: CloudMirrorConfig): CloudMirror {
  const now = cfg.now ?? ((): Date => new Date());
  const pageLimit = cfg.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const cursor = readCursor(cfg.cursorPath);
  /** The bootstrap generation's on-disk marks, beside the cursor. See {@link BootstrapGen}. */
  const genPath = genPathFor(cfg.cursorPath);
  let stopped = false;
  /**
   * The abort every loop in this file checks. Set by `stop()` and never cleared: a mirror that has
   * been asked to leave does not come back, it is replaced by the next launch's.
   */
  let aborted = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Optimistic: a mirror is assumed reachable until a pull proves otherwise. */
  let reachable = true;
  /** The single-flight pull: the poll timer and an echo-await share ONE drain. */
  let inflight: Promise<number> | null = null;
  /** Current reconnect delay; grows on failure, resets on success. See {@link scheduleAfter}. */
  let backoffMs = RECONNECT_BASE_MS;
  /**
   * Every mailbox id this database holds, as of the last refresh — what an incoming `mailboxId` is
   * checked against before a message or draft may be written under it. Empty until the first
   * refresh, which is why nothing drains before one has run.
   */
  let knownMailboxes: ReadonlySet<string> = EMPTY_MAILBOXES;
  /** The ids the hosted account named last, for the post-drain prune. */
  let hostedMailboxIds: string[] = [];
  /**
   * The hosted account's own message count per mailbox — see {@link CloudMirror.hostedCounts}.
   * Empty until a counted refresh lands, and an empty map is served as "no number", never as 0.
   */
  let hostedCounts = new Map<string, number>();
  /** When counts were last ASKED for (not when they last changed). `-Infinity` ⇒ never. */
  let countsAskedAt = Number.NEGATIVE_INFINITY;
  /**
   * Did the last drain leave the hosted account with more to give? Set from `/sync`'s `hasMore`,
   * cleared by the counted ask it triggers.
   *
   * This is the signal that matters: a mirror that is behind is exactly the case where the
   * denominator is worth a request, and `hasMore` is the hosted account saying so in the answer
   * the mirror was already reading.
   */
  let sawBacklog = false;
  /**
   * DID ANYTHING GET DELETED SINCE THE COUNTS WERE READ? — the one direction that makes a held
   * count a LIE rather than merely old.
   *
   * The counts are refreshed on a cadence measured in minutes, and inside that window the mirror
   * keeps draining. A drain that ADDS mail moves the local number toward the held total, which
   * biases the comparison toward silence and is harmless. A drain that applies TOMBSTONES moves
   * the local number DOWN while the held total stays where it was — and a shortfall computed
   * against it is a sentence about mail that no longer exists on either side. Mail deleted from
   * another device is the ordinary way that happens.
   *
   * So a delete does two things: it drops the held counts on the spot (the strip then says
   * nothing, which is the honest answer to "we do not know"), and it makes the next refresh ask.
   * A phantom sweep counts as a delete for the same reason — it also removes local rows.
   */
  let sawDeletes = false;

  /** The cloud seq the cursor encodes — the inverse of `SyncService.encodeCursor`. */
  const cloudSeq = (): bigint => {
    const s = cursor.sync;
    if (!s || s === "0") return 0n;
    try {
      const dec = Buffer.from(s, "base64url").toString("utf8");
      return /^\d+$/.test(dec) ? BigInt(dec) : 0n;
    } catch {
      return 0n;
    }
  };

  /**
   * PULL THE ACCOUNT'S MAILBOXES AND APPLY THEM. Runs at the start of every pull, before the drain.
   *
   * ── A FAILURE HERE FAILS THE WHOLE PULL, AND THAT IS THE SAFE DIRECTION ───────────────────────
   *
   * Throwing looks harsh for a list of two rows, and continuing is the dangerous option. A drain
   * that proceeds without a mailbox set skips every message it cannot attribute — and on a
   * `since=0` bootstrap a skipped message is one the generation never marked, so the trailing
   * mark-and-sweep would delete it. A transient 500 on this route would empty somebody's mirror.
   *
   * The cost of throwing is bounded and visible: `runPull` flips `reachable` false, the local read
   * surface keeps serving every row it already holds, the write-through proxy answers
   * `503 offline_read_only` rather than forwarding into a void, and the poll retries on the same
   * backoff a failed `/sync` uses.
   */
  /**
   * MAY THIS REFRESH ASK FOR THE COUNTS?
   *
   * Four reasons to say yes, one floor under all of them, and the reasons are named rather than
   * folded into a shorter interval because each is a different question:
   *
   *  · this process has never ASKED — the launch that follows an install being closed for days,
   *    which is the one moment a shortfall is most likely and least visible. "Never asked" and
   *    not "holds no numbers": an account whose build does not serve counts would answer the
   *    second condition for ever, and past the floor below that is one full-table aggregate a
   *    minute, indefinitely — the storm this cadence exists to prevent, re-entered through its
   *    own failure case. Such an account is asked again on the TTL, like any other.
   *  · a BOOTSTRAP is running — the mirror is rebuilding from zero, so the denominator is the
   *    only thing that makes the count on screen mean anything.
   *  · the last drain saw `hasMore` — the hosted account said there was more; a shortfall is not
   *    hypothetical here.
   *  · the last drain applied a DELETE — the held total is now too high by construction, and the
   *    map has already been dropped for that reason; this is the ask that replaces it.
   *  · the numbers are older than {@link HOSTED_COUNTS_TTL_MS}.
   *
   * The floor is checked FIRST and applies to every reason, so no combination of them can put two
   * aggregates within a minute of each other.
   */
  const countsWanted = (): boolean => {
    const t = now().getTime();
    if (t - countsAskedAt < HOSTED_COUNTS_MIN_GAP_MS) return false;
    if (countsAskedAt === Number.NEGATIVE_INFINITY) return true;
    if (cursor.bootstrapping) return true;
    if (sawBacklog) return true;
    if (sawDeletes) return true;
    return t - countsAskedAt >= HOSTED_COUNTS_TTL_MS;
  };

  const refreshMailboxes = async (): Promise<MailboxRefreshOutcome> => {
    /* THE ONE PLACE COUNTS ARE ASKED FOR. `packages/api`'s route computes them only for
       `?counts=1`, so the ordinary refresh — three a minute — stays the cheap read it has always
       been, and the aggregate happens on the cadence above and nowhere else. The local read
       surface must never compute a count of its OWN: a mirror's aggregate under a hosted field
       name would read "N of N" for ever, which is worse than saying nothing. */
    const wantCounts = countsWanted();
    if (wantCounts) {
      /* STAMPED WHEN THE REQUEST IS ISSUED, and this is not a detail. Stamping after a successful
         apply looks tidier and re-opens the storm from the failure side: a malformed answer or a
         failed local apply THROWS out of this function, the stamp never lands, and the reconnect
         backoff (1 s, 2 s, 4 s, …) re-asks for the full-table aggregate on every retry. What the
         floor is protecting is the ACCOUNT's database, so what has to be recorded is the ASK. */
      countsAskedAt = now().getTime();
    }
    const res = await cfg.auth.authedFetch(wantCounts ? "/mailboxes?counts=1" : "/mailboxes");
    if (!res.ok) throw new Error(`the hosted /mailboxes answered HTTP ${res.status}`);
    const body = (await res.json()) as { items?: unknown };
    // A wire boundary, so the shape is checked rather than assumed — an answer that is not a list
    // would otherwise retire every local mailbox and take the mirror with it.
    if (!Array.isArray(body.items)) {
      throw new Error("the hosted /mailboxes answered something that is not a mailbox list");
    }
    const hosted = body.items as MailboxDTO[];
    const out = await applyMailboxRefresh(cfg.db, cfg.world, hosted, now());
    knownMailboxes = out.known;
    hostedMailboxIds = hosted.map((m) => m.id);
    if (wantCounts) {
      /* The ask is already stamped (above, at issue time) — what lands here is the ANSWER. Both
         reasons that bought this request are spent whether or not it carried numbers: a hosted
         build that serves no `messageCount` must not re-trigger on the next refresh for ever,
         which was the request storm this cadence exists to prevent, reached through its own
         failure case. */
      sawBacklog = false;
      sawDeletes = false;
      /* REBUILT, NOT MERGED: a mailbox the account no longer names must not keep a stale count in
         a map the strip sums. Rows that carry no number are simply absent, and an absent number
         withdraws the whole denominator downstream — which is the correct answer to "one of your
         mailboxes did not report". */
      const next = new Map<string, number>();
      for (const m of hosted) {
        // `typeof`-guarded even though the DTO types it as `number | undefined`: this is a wire
        // boundary, and a hosted build that answers a string or a null here must leave the entry
        // ABSENT rather than put a non-number into a sum.
        const n = m.messageCount;
        if (typeof n === "number" && Number.isFinite(n) && n >= 0) next.set(m.id, n);
      }
      hostedCounts = next;
    }
    if (out.retired.length > 0 || out.dropped.length > 0) {
      /* THREE COUNTS AND NO ADDRESS. `count` is how many mailboxes the account has, `pruned` how
         many local rows it no longer names (retired to tombstones, because mail still points at
         them) and `dropped` how many of those were then removed outright. The names are the ones
         `ALLOWED_FIELDS` already carries — a mailbox address on this line would be exactly the
         identifying signal that census exists to keep off it. */
      cfg.log?.("cloud_mailboxes_refreshed", {
        count: hosted.length,
        pruned: out.retired.length,
        dropped: out.dropped.length,
        reason: "a local mailbox row the hosted account does not name was retired; mail that still " +
          "points at it keeps it as a tombstone, and a row nothing references is removed",
      });
    }
    return out;
  };

  /** The mailbox ids a page's messages and drafts name — the pre-scan the refetch decision reads. */
  const mailboxIdsNamedBy = (resp: SyncResponse): Set<string> => {
    const out = new Set<string>();
    for (const ch of [...resp.changes.creates, ...resp.changes.updates, ...resp.changes.moves]) {
      if (ch.type === "message") {
        const m = ch.entity as MessageDTO | undefined;
        if (m?.mailboxId) out.add(m.mailboxId);
      } else if (ch.type === "draft") {
        const d = ch.entity as DraftDTO | undefined;
        if (d?.mailboxId) out.add(d.mailboxId);
      } else if (ch.type === "folder") {
        // A page can name a NEW mailbox through its folder inventory alone — a just-connected
        // mailbox whose first mirrored change is a folder entity. Without this the apply's
        // known-mailbox guard dropped the folder while the cursor advanced past it, and no
        // later refresh could recover it.
        const f = ch.entity as { mailboxId?: string } | undefined;
        if (f?.mailboxId) out.add(f.mailboxId);
      }
    }
    return out;
  };

  /**
   * RULES BEFORE MAIL — the bootstrap's one ordering promise.
   *
   * A `since=0` replay interleaves by hosted seq, and a sender the account decided AFTER their
   * mail arrived replays as mail-first: for the whole stretch between the mail's seqs and the
   * rule's, the mirror holds messages whose sender looks undecided. Every reader downstream —
   * the shell's snapshot off this database, its delta off the local `change_log` — inherits that
   * order, and the consent cutline reads the absent rule as "no decision", so already-screened
   * senders present in the Screener until the replay catches up. Measured live on a desktop
   * initial sync; unknown is not undecided.
   *
   * So a drain that is a bootstrap first drains `?types=rule` from zero to its horizon, applied
   * through the SAME `applyPage` (local change-log rows and generation marks included), without
   * ever touching the drain's committed cursor. Two consequences, both deliberate:
   *
   *  · the local `change_log` carries every rule before any message, so a client that snapshots
   *    this mirror mid-bootstrap gets the full rule set on page 1 and one that tails the delta
   *    gets rules first — the ordering holds at every interleaving;
   *  · the main replay re-delivers every rule change at its natural seq and re-applies it
   *    (idempotent — the DTO is re-materialized CURRENT state on both passes), which also
   *    re-marks it in the generation, so the trailing sweep needs nothing special.
   *
   * It re-runs on a RESUMED bootstrap too: rules decided while the install was interrupted sit
   * above the committed cursor, and the remaining replay would otherwise serve their senders'
   * mail first. The pass is cheap — rules are the smallest type in the feed.
   *
   * A failure is a failure of the same wire the main drain uses, so it propagates as any drain
   * page failure does rather than degrading to an unordered bootstrap.
   *
   * ── THE RESIDUAL WINDOW ON A RESUME, AND WHY READS ARE NOT GATED ON THIS PASS ────────────
   *
   * The bridge is deliberately exposed before the first pull (`main.ts` — the window must render
   * sign-in and locally-held mail with no network at all), so a client that connects between
   * process start and this pass landing can still read an interrupted bootstrap's message-only
   * stretch — last session's state, which is what that client was already showing. Review round
   * 1 proposed gating the read surface until this pass completes; refused, because the gate
   * would hold LOCAL reads hostage to a NETWORK request — a dead network would blank a desktop
   * whose whole promise is that the mail is on the device. What bounds the window instead is
   * that this pass is the first thing the first pull does: the rules land in the local
   * change_log ahead of everything the resumed replay adds, so a connected client corrects on
   * its next delta poll (seconds), instead of at the end of the replay (minutes).
   */
  const drainRulesFirst = async (gen: BootstrapGen | null): Promise<{ applied: number; cut: boolean }> => {
    let applied = 0;
    let since = "0";
    for (;;) {
      if (aborted) return { applied, cut: true };
      const q = new URLSearchParams({ since, limit: String(pageLimit), types: "rule" });
      const res = await cfg.auth.authedFetch(`/sync?${q.toString()}`);
      if (!res.ok) throw new Error(`the hosted /sync answered HTTP ${res.status} to the rules-first pass`);
      const body = (await res.json()) as SyncResponse;
      applied += await applyPage(cfg.db, cfg.world, body, now(), gen, knownMailboxes);
      gen?.flush();
      reachable = true;
      since = body.cursor;
      if (!body.hasMore) break;
    }
    return { applied, cut: false };
  };

  /**
   * Drain `GET /sync` to the horizon. Returns what it applied and, when the drain was a `since=0`
   * bootstrap, the generation it marked so the caller can sweep phantoms afterwards.
   *
   * A drain that STARTS at `since=0` is a bootstrap — a first launch, a healed/absent cursor, or the
   * relaunch after a 410 deleted the cursor mid-drain. A 410 mid-drain resets to zero and restarts
   * the generation. An incremental drain (a real cursor) marks nothing and sweeps nothing.
   */
  const drainSync = async (): Promise<{ applied: number; sweep: BootstrapGen | null; cut: boolean }> => {
    let applied = 0;
    // A drain that begins at since=0 — a first launch, or a healed/absent cursor — OR that finds a
    // bootstrap left unfinished by a crash is a BOOTSTRAP: tag what it touches, sweep at the end.
    //
    // An unfinished bootstrap RESUMES from the committed cursor when its generation file is there
    // to continue marking into — the union of marks across every segment covers exactly the pages
    // the feed served, which is the sweep's whole requirement — and restarts from zero when it is
    // not. Restart-from-zero-on-every-interruption cannot finish on a large mailbox (a replay
    // hundreds of pages long, any sleep or quit starting it over; the mirror serves stale mail
    // while looking alive), which is why the generation persists at all.
    //
    // A cursor written by an older format is the FOURTH way in: its rows carry the wrong mailbox
    // attribution and no delta can correct them, so the whole feed is replayed through the
    // corrected upsert — never resumed, whatever files are lying around. See {@link CURSOR_VERSION}.
    let sweep: BootstrapGen | null = null;
    const reKeying = cursor.version < CURSOR_VERSION;
    if (isBootstrapCursor(cursor.sync) || cursor.bootstrapping || reKeying) {
      // The re-key RESUMES on the same terms as any bootstrap: an interrupted replay whose marks
      // survived continues from its committed cursor, and every seq still passes through the
      // corrected upsert exactly once. This is the upgraded-install case measured live — the
      // replay is the account's whole feed, and a form that restarted it from zero on every
      // interruption never finished on a real mailbox. (`bootstrapping` is only ever true for a
      // replay that STARTED from zero, so resuming it cannot skip the re-key's early pages; the
      // version stamp still lands only when the sweep completes.)
      const resumed = cursor.bootstrapping && !isBootstrapCursor(cursor.sync)
        ? loadBootstrapGen(genPath)
        : null;
      if (resumed) {
        sweep = resumed;
        cfg.log?.("cloud_bootstrap_resumed", {
          reason: "an interrupted bootstrap continues from its committed cursor against the same " +
            "generation's marks, instead of replaying the whole feed from zero",
        });
      } else {
        if (reKeying && !isBootstrapCursor(cursor.sync)) {
          // The event name IS the fact, so the line carries only the reason — the same discipline
          // `packages/core/src/log.ts` prescribes for the cron passes: a version number would be a
          // new allowlist entry to say what the event already says.
          cfg.log?.("cloud_mirror_rekey", {
            reason: "this mirror's mail was filed under a local placeholder mailbox rather than the " +
              "account's own; the feed is replayed from the start so every row is re-attributed",
          });
        }
        cursor.sync = "0";
        cursor.bootstrapping = true;
        sweep = newBootstrapGen(genPath);
      }
    }
    /** One refetch per drain — see the pre-scan below. */
    let refetched = false;
    // A bootstrap (fresh, resumed, re-keyed — anything that set `sweep`) owes the rules-first
    // pass before its first page; the 410 branch below re-owes it with the fresh generation.
    let rulesFirstOwed = sweep !== null;
    for (;;) {
      // BETWEEN PAGES, so a quit costs at most the page already in flight. `sweep: null` is the
      // load-bearing half: a bootstrap generation that stopped early has marked only part of the
      // account, and sweeping against it would delete rows the feed simply had not reached yet.
      // `cursor.bootstrapping` is left SET, so the next launch restarts the bootstrap in full.
      if (aborted) return { applied, sweep: null, cut: true };
      if (rulesFirstOwed) {
        rulesFirstOwed = false;
        const rf = await drainRulesFirst(sweep);
        applied += rf.applied;
        if (rf.cut) return { applied, sweep: null, cut: true };
      }
      const q = new URLSearchParams({
        since: cursor.sync || "0",
        limit: String(pageLimit),
        types: CLOUD_SYNC_TYPES.join(","),
      });
      const res = await cfg.auth.authedFetch(`/sync?${q.toString()}`);
      if (res.status === 410) {
        // The cursor fell behind the retention horizon (`sync-service.ts` — a malformed or
        // sub-horizon cursor). DELETE the cursor file and re-bootstrap from zero. A since=0 replay
        // carries only CURRENT entities, so anything deleted on Cloud while we were away is absent
        // from it and would linger locally as a phantom — the fresh generation below tags what the
        // bootstrap touches so the trailing sweep removes exactly the rest. `bootstrapping` is
        // persisted by the first page commit below, so a crash mid-bootstrap still resumes as one.
        deleteCursor(cfg.cursorPath);
        cursor.sync = "0";
        // The body walk restarts with it. Not `unresolved`, which would consult the import stamp
        // and, on a mirror that had finished, settle on `complete` — leaving the bodies to
        // {@link fetchMissingBodies}. That would be cheaper and it would also be correct, since
        // bodies are immutable once ingested and the sweep takes a phantom's body with the
        // phantom. It is not what this does, because a 410 is the one moment the mirror is told
        // its own position is untrustworthy, and rebuilding from zero is the answer that does not
        // depend on the local rows being right. It costs one walk, on a path reached only when a
        // cursor has fallen below the feed's retention horizon.
        cursor.bodies = { phase: "walking", after: null };
        cursor.bootstrapping = true;
        // A fresh generation, never a resume: the 410 is the one moment the mirror's own position
        // is untrustworthy, and that verdict covers any marks it made from that position.
        sweep = newBootstrapGen(genPath);
        applied = 0;
        // The re-bootstrap owes the rules-first pass again, against the fresh generation.
        rulesFirstOwed = true;
        cfg.log?.("cloud_cursor_expired", { reason: "410 from /sync; re-bootstrapping from since=0 with mark-and-sweep" });
        continue;
      }
      if (!res.ok) throw new Error(`the hosted /sync answered HTTP ${res.status}`);
      const body = (await res.json()) as SyncResponse;
      /* A MAILBOX ADDED SINCE THE REFRESH AT THE TOP OF THIS PULL. The page is scanned BEFORE it is
         applied, so the extra request happens outside the page transaction rather than inside one —
         a network call under an open transaction is how a slow hop becomes a held lock. Once per
         drain: a page that still names an unknown mailbox after a fresh list is naming one the
         account does not have, and asking again per page would turn that into a request storm. */
      const named = mailboxIdsNamedBy(body);
      const unknown = [...named].filter((id) => !knownMailboxes.has(id));
      if (unknown.length > 0 && !refetched) {
        refetched = true;
        await refreshMailboxes();
      }
      const stillUnknown = [...named].filter((id) => !knownMailboxes.has(id));
      if (stillUnknown.length > 0) {
        cfg.log?.("cloud_mirror_unattributable", {
          count: stillUnknown.length,
          reason: "the feed carried mail for a mailbox the account did not list, so it is skipped " +
            "rather than filed under a different address; a later refresh picks it up",
        });
      }
      /* A TOMBSTONE IN THIS PAGE INVALIDATES THE HELD COUNTS — see `sawDeletes`. Noted BEFORE the
         apply, so a crash between the two leaves the counts dropped rather than believed: the
         safe error is forgetting a number, never keeping one that is too high. */
      if (body.changes.deletes.length > 0) {
        sawDeletes = true;
        hostedCounts = new Map();
      }
      applied += await applyPage(cfg.db, cfg.world, body, now(), sweep, knownMailboxes);
      // AFTER the commit: a crash before this line re-applies the page next launch, which converges.
      // The generation's marks land BEFORE the cursor moves past the page they describe — the
      // ordering {@link BootstrapGen.flush} rests on.
      sweep?.flush();
      cursor.sync = body.cursor;
      writeCursor(cfg.cursorPath, cursor);
      // A page LANDED, so Cloud demonstrably answers: reachable heals per page, not only when
      // the whole pull completes. Without this, an install part-way through a long bootstrap
      // wore the "this install is offline" banner while actively landing pages.
      reachable = true;
      // The hosted account has more to give, which is the one cheap signal that this mirror is
      // BEHIND. Read at the top of the next pull to decide whether the denominator is worth an
      // aggregate; nothing else reads it, and it changes no drain decision here.
      if (body.hasMore) sawBacklog = true;
      if (!body.hasMore) break;
    }
    return { applied, sweep, cut: false };
  };

  /**
   * THE STALE-MIRROR TAG REPAIR, ONCE PER INSTALL. See {@link applyTagBackfill} for what is broken
   * and why the snapshot is the probe; this is the decision to run it.
   *
   * Three gates, in cost order, and each one is also a correctness statement:
   *
   *  1. the cursor flag — a mirror that has already been through here is never asked again, so a
   *     second startup does nothing and no steady-state pull carries an extra request;
   *  2. ZERO local tag rows — the whole detection. A mirror that holds any tag has been served the
   *     `tag` type and is not the damaged population, so it is left completely alone. A fresh
   *     sign-in reaches this line with its bootstrap already applied and is skipped by it;
   *  3. the hosted account HAS tags — an account with none has nothing to repair, and a tag it makes
   *     later arrives as a delta above the cursor like any other change.
   *
   * A FAILED PROBE IS NOT A FAILED PULL. This is a one-time repair on top of a mirror that works;
   * letting it throw would mark the mirror offline and put the write-through proxy into
   * `503 offline_read_only` over a snapshot request. So it swallows, leaves the flag unset, and the
   * next pull tries again.
   *
   * IT DRAINS THE WHOLE SNAPSHOT, NOT PAGE 1. Page 1 carries the tags; the windowed pages and the
   * labeled tail carry the assignments to re-hang, and the tail specifically carries tagged mail
   * OLDER than the window — the older-tags case, which page 1 alone never reached. So it follows
   * `nextCursor` to the end. The flag is set only once that drain COMPLETES: a mid-drain failure
   * returns without marking, so the next launch re-runs from page 1, and the apply is idempotent so
   * the re-run converges. The honest limit: if page 1 lands and applies tags but a later page then
   * fails on every launch, gate 2 (tags now present) will settle it — the rail is fixed and some
   * below-window chips may wait for whatever next touches their message. That is strictly better
   * than the pre-tail repair, which never reached them at all.
   *
   * Crash safety is the flag being the LAST write: a repair that commits and then dies re-probes on
   * the next launch, finds tags present, and skips at gate 2 — the apply is an upsert either way.
   */
  /**
   * THE FIRST SNAPSHOT PAGE, fetched at most once per pull across BOTH one-time repairs (tags,
   * folders). `undefined` = not asked yet; `null` = asked and did not answer, so the second
   * repair defers with the first instead of dialling again. The repairs are the only readers,
   * and once both are marked consumed the cache is never consulted again.
   */
  let snapshotPage1: SnapshotResponse | null | undefined;
  const fetchSnapshotPage = async (pageCursor?: string): Promise<SnapshotResponse | null> => {
    if (!pageCursor && snapshotPage1 !== undefined) return snapshotPage1;
    const q = new URLSearchParams({ limit: String(pageLimit) });
    if (pageCursor) q.set("cursor", pageCursor);
    const res = await cfg.auth.authedFetch(`/sync/snapshot?${q.toString()}`);
    if (!res.ok) {
      if (!pageCursor) snapshotPage1 = null;
      cfg.log?.("cloud_tag_backfill_deferred", {
        status: res.status,
        reason: "a snapshot page for the one-time tag repair did not answer; the mirror is " +
          "unaffected and the next pull retries",
      });
      return null;
    }
    const snap = (await res.json()) as SnapshotResponse;
    // A wire boundary, so the shape is checked rather than assumed: marking the repair done off a
    // body that is not a snapshot would spend the one chance this install gets at it.
    if (!pageCursor) snapshotPage1 = Array.isArray((snap as { changes?: unknown }).changes) ? snap : null;
    if (!Array.isArray(snap.changes)) {
      cfg.log?.("cloud_tag_backfill_deferred", {
        reason: "a snapshot page answered something that is not a snapshot; the mirror is " +
          "unaffected and the next pull retries",
      });
      return null;
    }
    return snap;
  };

  const repairStaleTags = async (): Promise<number> => {
    if (cursor.tagBackfill) return 0;
    const markConsidered = (): void => {
      cursor.tagBackfill = true;
      writeCursor(cfg.cursorPath, cursor);
    };

    const held = await cfg.db.select({ id: tags.id }).from(tags)
      .where(eq(tags.accountId, cfg.world.accountId)).limit(1);
    if (held.length > 0) {
      markConsidered();
      return 0;
    }

    try {
      let totalTags = 0;
      let totalMessages = 0;
      let pageCursor: string | undefined;
      for (;;) {
        // Asked to leave mid-repair: return WITHOUT marking it considered, so the next launch
        // starts again from page 1. The apply is idempotent, so the re-run converges.
        if (aborted) return totalTags;
        const snap = await fetchSnapshotPage(pageCursor);
        if (!snap) return totalTags;   // a page failed → NOT marked done; the next pull retries
        const written = await applyTagBackfill(cfg.db, cfg.world, snap, now());
        totalTags += written.tags;
        totalMessages += written.messages;
        if (!snap.nextCursor) break;
        pageCursor = snap.nextCursor;
      }
      markConsidered();
      if (totalTags > 0) {
        cfg.log?.("cloud_tag_backfill_applied", {
          tags: totalTags,
          messages: totalMessages,
          reason: "this mirror was bootstrapped before the drain asked for tags, so its tags sat " +
            "below the cursor and no delta could ever deliver them",
        });
      }
      return totalTags;
    } catch (err) {
      cfg.log?.("cloud_tag_backfill_deferred", {
        err,
        reason: "the one-time tag repair did not complete; the mirror is unaffected and the next " +
          "pull retries",
      });
      return 0;
    }
  };

  /**
   * THE ONE-TIME FOLDER BACKFILL — `repairStaleTags`' shape, for `repairStaleTags`' reason with
   * one difference in the gates. Between the drain first asking for `folder` entities and the
   * apply loop learning to store them, a mirror could drain folder creates, drop them, and
   * persist a cursor past them — a delta only ever looks forward, so no later pull re-delivers
   * them and the desktop's Folders rail stays empty for the life of the install.
   *
   * Unlike tags, "no local folder rows" is AMBIGUOUS (the account may simply have folders off),
   * so there is no present-rows gate: the snapshot's first page is the answer itself — it
   * carries the account's folder entities IFF the hosted flag is on (they are live small state,
   * page 1 only, never the tail) — and applying whatever it holds plus reconciling the local
   * flag settles both readings. Marked considered only when the page was READ; a failed fetch
   * retries on the next pull, and the apply is idempotent so a crash re-run converges.
   */
  const repairStaleFolders = async (bootstrapped: boolean): Promise<number> => {
    if (cursor.folderBackfill) return 0;
    // A pull that just BOOTSTRAPPED replayed the whole account through the folder-capable
    // apply — the entities are already here natively, so the repair is consumed without a
    // fetch. Only a mirror carrying a PRE-FOLDERS cursor forward has anything to recover.
    if (bootstrapped) {
      cursor.folderBackfill = true;
      writeCursor(cfg.cursorPath, cursor);
      return 0;
    }
    let snap: SnapshotResponse | null = null;
    try {
      snap = await fetchSnapshotPage();
    } catch (err) {
      // Non-fatal by contract, like every other outcome of this one-time repair: a transport
      // rejection must not fail an otherwise successful pull or mark the mirror offline. Not
      // marked consumed — the next pull retries.
      cfg.log?.("cloud_folder_backfill_deferred", {
        err,
        reason: "the one-time folder repair could not read the snapshot; the mirror is " +
          "unaffected and the next pull retries",
      });
      return 0;
    }
    if (!snap) return 0;   // did not answer → not marked; the next pull retries
    const folderChanges = snap.changes.filter((c) => c.type === "folder" && c.op !== "delete");
    let appliedCount = 0;
    // The mirrored mailboxes as the DATABASE holds them — the drain's own known-set is a local
    // of the pull and may not be populated on this path.
    const knownRows = await cfg.db.select({ id: mailboxes.id }).from(mailboxes)
      .where(eq(mailboxes.accountId, cfg.world.accountId));
    const knownHere = new Set(knownRows.map((r) => r.id));
    await cfg.db.transaction(async (tx) => {
      for (const ch of folderChanges) {
        if (await applyUpsert(tx, cfg.world, ch, now(), null, knownHere)) {
          await recordChange(tx, {
            accountId: cfg.world.accountId, entityType: "folder", entityId: ch.id, op: "create", meta: null,
          });
          appliedCount++;
        }
      }
      await reconcileLocalFoldersFlag(tx, cfg.world, now());
    });
    cursor.folderBackfill = true;
    writeCursor(cfg.cursorPath, cursor);
    if (appliedCount > 0) {
      cfg.log?.("cloud_folder_backfill_applied", {
        folders: appliedCount,
        reason: "this mirror drained folder entities before the apply loop stored them, so they " +
          "sat below the cursor and no delta could ever re-deliver them",
      });
    }
    return appliedCount;
  };

  /**
   * Message ids the hosted account did not answer for. See {@link fetchMissingBodies} — asked at
   * most once per launch, so a message deleted on Cloud between the drain that mirrored it and the
   * tombstone that removes it cannot make every later pull re-ask for a body that is not there.
   */
  const unanswered = new Set<string>();

  /** Upsert one page of bodies. Not a `/sync` entity, so no change-log row. */
  const storeBodies = async (items: readonly MessageBodyBatchItem[]): Promise<number> => {
    let written = 0;
    await cfg.db.transaction(async (tx) => {
      for (const item of items) {
        // The FK requires the message; a body whose message is not yet mirrored is skipped, and
        // {@link fetchMissingBodies} is what comes back for it once the message lands.
        if (!(await messagePresent(tx, item.messageId))) continue;
        const row = {
          text: item.text ?? "",
          html: item.html ?? null,
          loadedRemoteContent: !!item.loadedRemoteContent,
          // The hosted store's withheld marker, mirrored verbatim (mail 0062 — the local journal
          // has the column too). Without it a cap-withheld body lands here as an empty COMPLETE
          // one and the desktop tells the lie the marker exists to end; with it, the same honest
          // state renders on every tier. The mirror's own counter is deliberately untouched —
          // this store copies the hosted one, whose counter is the hosted counter.
          withheldReason: item.withheld === "storage_cap" ? ("storage_cap" as const) : null,
        };
        await tx.insert(messageBodies).values({ messageId: item.messageId, ...row })
          .onConflictDoUpdate({ target: messageBodies.messageId, set: row });
        written++;
      }
    });
    return written;
  };

  /**
   * DECIDE WHAT AN OLD CURSOR'S `bodies: null` MEANT — the migration read, and it is a one-way door.
   *
   * Every install running before the walk had a terminal state carries `null` in that field, and the
   * two populations it stands for are not the same size. A mirror that has been up for more than the
   * few minutes a first walk takes has FINISHED its walk; only a brand-new install, caught between
   * its first `/sync` drain and its first body page, has genuinely not started one. So the read has
   * to distinguish them, and there is already a fact on disk that does: `initial_import_completed_at`
   * on the mailbox row is stamped by {@link stampSynced} exactly when a pass drains with the body
   * walk spent, and never unstamped. Stamped ⇒ the walk finished ⇒ complete. Unstamped ⇒ it has not
   * ⇒ walk from the first message.
   *
   * Reading it the other way round is the expensive mistake in both directions: calling a finished
   * walk unstarted re-fetches the whole account once per launch, and calling an unfinished walk
   * complete would leave a half-imported mailbox with bodies missing and nothing to fetch them —
   * which is why the fallback is to walk. A wrong "walk" costs one pass; a wrong "complete" would
   * cost correctness.
   *
   * ── IT READS THE MIRRORED ROWS, AND ONLY THIS PROCESS EVER STAMPS THEM ────────────────────────
   *
   * The row it used to read was the synthetic one, which no longer exists once the refresh has
   * retired it. It now reads every ACTIVE mirrored mailbox — and the stamp on those rows is still a
   * fact about THIS mirror, because {@link mailboxRow} deliberately does not copy the hosted
   * account's own `initial_import_completed_at`. If it did, a brand-new mirror would inherit the
   * hosted account's finished import, resolve `complete` before fetching a single body, and leave
   * every message opening blank.
   *
   * EVERY active row must be stamped, and no rows at all is `walking`. The walk is account-wide, so
   * a partially-stamped account is one whose walk has not finished — and the fallback stays the
   * cheap direction rather than the wrong one.
   */
  const activeMirroredMailboxes = async (): Promise<Array<{ id: string; importedAt: Date | null }>> =>
    cfg.db.select({ id: mailboxes.id, importedAt: mailboxes.initialImportCompletedAt })
      .from(mailboxes)
      .where(and(eq(mailboxes.accountId, cfg.world.accountId), ne(mailboxes.status, "disabled")));

  const resolveBodiesWalk = async (): Promise<BodiesWalk> => {
    const rows = await activeMirroredMailboxes();
    const finished = rows.length > 0 && rows.every((r) => r.importedAt !== null);
    return finished ? { phase: "complete" } : { phase: "walking", after: null };
  };

  /**
   * THE FIRST PASS: keyset-walk `GET /messages/bodies` to the end of the account, once.
   *
   * It ends by writing `complete`, which is the state that was missing — see {@link BodiesWalk}. The
   * cursor advances only after a page has been committed, so an interrupted walk (a quit, a dropped
   * network) resumes from the last page that landed rather than from the beginning.
   */
  const walkAllBodies = async (): Promise<number> => {
    let written = 0;
    for (;;) {
      const walk = cursor.bodies;
      if (walk.phase !== "walking" || aborted) return written;
      const q = new URLSearchParams({ limit: String(DEFAULT_BODIES_LIMIT) });
      if (walk.after !== null) q.set("after", walk.after);
      const res = await cfg.auth.authedFetch(`/messages/bodies?${q.toString()}`);
      if (!res.ok) throw new Error(`the hosted /messages/bodies answered HTTP ${res.status}`);
      const page = (await res.json()) as Page<MessageBodyBatchItem>;
      written += await storeBodies(page.items);
      cursor.bodies = page.nextCursor === null
        ? { phase: "complete" }
        : { phase: "walking", after: page.nextCursor };
      writeCursor(cfg.cursorPath, cursor);
      if (page.nextCursor === null) return written;
    }
  };

  /**
   * THE STEADY STATE: fetch bodies for the messages this mirror holds that have none, and nothing
   * else. Zero rows ⇒ zero requests, which is what a settled mailbox does on every poll.
   *
   * ── WHY THE LOCAL GAP, AND NOT THE CHANGE FEED ────────────────────────────────────────────────
   *
   * The obvious incremental source is the drain's own output — the messages it just applied — and it
   * is the wrong one, for two reasons that only show up at scale. A `since=0` re-bootstrap applies
   * EVERY message, so driving off the feed would re-request every body in the mailbox even though
   * the mirror already holds them; and a body skipped because its message had not landed yet (the FK skip in
   * {@link storeBodies}) is not in any subsequent page of the feed, so nothing would ever come back
   * for it. Asking the database which messages have no body row answers both cases with one indexed
   * read, and it cannot drift from the thing it is meant to keep true.
   *
   * It is also why the keyset walk's terminal state is safe to trust. `getBodies` LEFT-JOINs the body
   * row, so a completed walk has written a row — empty if that is what the account holds — for every
   * message in it. "Missing" therefore means genuinely absent, not merely empty.
   */
  /**
   * ASK THE HOSTED ids MODE FOR A SET OF BODIES and store what comes back.
   *
   * Extracted verbatim from {@link fetchMissingBodies} so the cap-marker repair below asks the
   * same way rather than growing a second, subtly different copy of the leftover-round rule. Every
   * caller therefore inherits the two-meanings discipline documented inside, and `storeBodies`
   * stays the single writer — which is what keeps the withheld normalization and the
   * mirror-never-touches-the-counter rule in one place.
   */
  const askForIds = async (wanted: readonly string[]): Promise<number> => {
    let written = 0;
    for (let i = 0; i < wanted.length; i += BODIES_IDS_MAX) {
      /*
       * ── AN ABSENT ID HAS TWO MEANINGS, AND ONLY ONE OF THEM IS "STOP ASKING" ────────────────
       *
       * The ids mode drops an id from its answer for two reasons the wire cannot distinguish:
       * the account does not own it (deliberate — a 404 would be an existence oracle), and
       * `BODIES_BYTE_BUDGET` was crossed before the id's uuid-ordered row was reached, whose
       * documented contract is the OPPOSITE instruction ("What is left out is asked for per
       * message by the client" — `message-service.ts#getBodiesByIds`). This loop used to read
       * every absence as the first meaning and park the id in `unanswered` for the launch's
       * lifetime — so one message that sorted after a budget's worth of catch-up neighbours in a
       * single batch mirrored as a row with NO body, permanently on a long-running install:
       * rendered on webmail, blank on the desktop (owner report, 2026-08-21). The webmail engine
       * reads the same answer correctly (`hydrateThread`: ids the answer did not carry are
       * fetched singly); this was the one consumer that conflated the two meanings.
       *
       * The discriminator is in the answer's own shape. An OWNED message always yields an item —
       * the service LEFT-JOINs the body row and answers empty text rather than omitting the row —
       * so absence from a NON-EMPTY answer can only be the budget, and an EMPTY answer to a
       * non-empty ask can only be "none of these ids are owned". So: re-ask the leftovers in
       * their own request, and mark `unanswered` only from an empty answer.
       *
       * It terminates without a round cap doing the work: the budget rule includes the row that
       * CROSSES the budget, so every non-empty answer carries the batch's first outstanding id
       * and the leftover set strictly shrinks. The cap is pure defence against a server that
       * stops honouring that shape — leftovers it strands are NOT marked, so the gap query
       * simply re-offers them on the next pull rather than never again.
       */
      let batch = wanted.slice(i, i + BODIES_IDS_MAX);
      for (let round = 0; batch.length > 0 && round < BODIES_IDS_MAX; round++) {
        if (aborted) return written;
        const res = await cfg.auth.authedFetch(`/messages/bodies?ids=${batch.join(",")}`);
        if (!res.ok) throw new Error(`the hosted /messages/bodies answered HTTP ${res.status}`);
        const page = (await res.json()) as Page<MessageBodyBatchItem>;
        written += await storeBodies(page.items);
        const answered = new Set(page.items.map((item) => item.messageId));
        const leftover = batch.filter((id) => !answered.has(id));
        if (page.items.length === 0) {
          // The whole ask went unanswered: this account owns none of these ids any more.
          for (const id of leftover) unanswered.add(id);
          break;
        }
        batch = leftover;
      }
    }
    return written;
  };

  const fetchMissingBodies = async (): Promise<number> => {
    const rows = await cfg.db.select({ id: messages.id })
      .from(messages)
      .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(and(eq(messages.accountId, cfg.world.accountId), isNull(messageBodies.messageId)))
      .orderBy(asc(messages.id))
      .limit(BODIES_CATCHUP_MAX);
    const wanted = rows.map((r) => r.id).filter((id) => !unanswered.has(id));
    if (wanted.length === 0) return 0;
    return askForIds(wanted);
  };

  /**
   * THE ONE-TIME CAP-MARKER REPAIR — an old sidecar's empty row is not the same fact as an empty
   * message, and until this pass ran there was no way for this mirror to tell.
   *
   * A sidecar from before the storage-cap marker receives a withheld batch item, ignores
   * `item.withheld`, and inserts an ordinary empty `message_bodies` row. Upgrading adds
   * `withheld_reason` as NULL, which is indistinguishable from "ordinarily stored and empty" —
   * and {@link fetchMissingBodies} only ever offers rows that are ABSENT, so a present-but-empty
   * row is never re-asked. That mirror then serves a withheld body as an ordinary empty one for
   * ever, on the one tier whose whole promise is that the honest state renders everywhere.
   *
   * ── WHY A CURSOR FLAG AND NOT THE TWO OBVIOUS ALTERNATIVES ──────────────────────────────────
   *
   *  · A {@link CURSOR_VERSION} bump cannot reach this: the re-key resets `sync`/`bootstrapping`
   *    and deliberately leaves `bodies` alone (`message_bodies` is not a `/sync` entity), so it
   *    would replay every message and fetch no bodies at all.
   *  · Widening `fetchMissingBodies`'s predicate permanently would be a standing poll with no
   *    termination: a genuinely empty body re-asked answers empty again, matches the predicate
   *    again, and does so on every pull for ever. The SQL layer has no "answered" tri-state and
   *    inventing one would fork the meaning of a column defined once in the shared schema.
   *
   * So termination is a property of the CURSOR, exactly as the stale-tag repair's is: considered
   * once, recorded, never revisited. Absent from every cursor file written before this pass, which
   * reads as `false` — and that population is precisely the one that needs it.
   *
   * Deferred, WITHOUT marking, while the first body walk is still running: the walk stores markers
   * correctly for everything it covers, so repairing underneath it would ask twice for the same
   * rows and could mark the repair done over a mirror that is still filling.
   */
  const repairCapMarkers = async (): Promise<number> => {
    if (cursor.capMarkerRepair) return 0;
    if (cursor.bodies.phase !== "complete") return 0;   // deliberately NOT marked — see above
    const markConsidered = (): void => {
      cursor.capMarkerRepair = true;
      writeCursor(cfg.cursorPath, cursor);
    };

    let examined = 0;
    let written = 0;
    // The keyset's start is ABSENT, not the empty string: `message_id` is a uuid column and
    // `> ''` is not a uuid, so seeding it that way makes the very first page throw — which the
    // catch below would then log as a deferral, leaving the repair silently doing nothing on every
    // launch. That is how this pass first "passed" its own test while healing not one row.
    let after: string | null = null;
    try {
      for (;;) {
        // Asked to leave mid-repair: return WITHOUT marking, so the next launch starts again. The
        // upsert in `storeBodies` makes the re-run converge.
        if (aborted) return written;
        const rows = await cfg.db.select({ id: messageBodies.messageId })
          .from(messageBodies)
          .innerJoin(messages, eq(messages.id, messageBodies.messageId))
          .where(and(
            eq(messages.accountId, cfg.world.accountId),
            eq(messageBodies.text, ""),
            isNull(messageBodies.html),
            isNull(messageBodies.withheldReason),
            ...(after === null ? [] : [gt(messageBodies.messageId, after)]),
          ))
          .orderBy(asc(messageBodies.messageId))
          .limit(BODIES_IDS_MAX);
        if (rows.length === 0) break;
        const ids = rows.map((r) => r.id);
        after = ids[ids.length - 1]!;
        examined += ids.length;
        written += await askForIds(ids.filter((id) => !unanswered.has(id)));
      }
    } catch (err) {
      // A failed page leaves the flag UNSET: the next launch resumes rather than losing the
      // repair. Never fatal to the pull — the mirror is exactly as correct as it was before.
      cfg.log?.("cloud_cap_marker_repair_deferred", {
        reason: "a bodies page failed; the mirror is unaffected and the next launch retries",
        err: String(err),
      });
      return written;
    }
    // COMPLETION IS "every matching row was EXAMINED once", not "every row changed": a row the
    // server no longer carries stays as it is, and the sweep owns deletions.
    markConsidered();
    // `examined`/`written` and not `offered`: the logger keeps an allow-list of field names and
    // silently drops anything absent from it, so an unlisted name is a line that says nothing.
    if (examined > 0) cfg.log?.("cloud_cap_marker_repair_done", { examined, written });
    return written;
  };

  /** The body pass: walk the account once, then keep only the newcomers topped up. */
  const backfillBodies = async (): Promise<number> => {
    if (cursor.bodies.phase === "unresolved") {
      cursor.bodies = await resolveBodiesWalk();
      writeCursor(cfg.cursorPath, cursor);
    }
    if (cursor.bodies.phase === "walking") return walkAllBodies();
    return fetchMissingBodies();
  };

  const runPull = async (): Promise<number> => {
    try {
      /* THE MAILBOXES FIRST, ALWAYS. A message's `mailbox_id` is a foreign key and the drain writes
         it verbatim from the feed, so the rows it points at have to exist before the first page is
         applied. This ordering is the whole reason the mirror can attribute mail honestly, and a
         version of it that ran AFTER the drain would skip every message of a mailbox added since
         the last pull — a first pull on a fresh install would land nothing at all. */
      // The repairs' shared snapshot cache is PER PULL: a page-1 failure cached across pulls
      // would return the same refusal forever and the promised next-pull retry would never dial.
      snapshotPage1 = undefined;
      await refreshMailboxes();
      const { applied, sweep, cut } = await drainSync();
      // REACHABLE MEANS REACHABLE. The drain came back, so Cloud demonstrably answers — flip the
      // flag here, not only at the end of the whole pull. It used to flip only after the sweep,
      // the tag repair and the body walk all completed, so an install part-way through a long
      // bootstrap wore the "this install is offline" banner for the replay's whole life while
      // it was actively landing pages — measured on an upgraded install whose replay was
      // interrupted for days: the person read "offline" on a machine that was online the whole
      // time. Writes forward correctly from here too: the proxy's gate is this flag, and Cloud
      // is the thing that just answered.
      reachable = true;
      if (cut) {
        cfg.log?.("cloud_pull_stopped", {
          count: applied,
          reason: "the mirror was asked to stop mid-drain; the committed cursor holds where it " +
            "got to and the next launch resumes from it",
        });
        return applied;
      }
      // Sweep BEFORE bodies: a phantom message is gone, so `backfillBodies` never fetches its body.
      if (sweep) {
        const swept = await sweepPhantoms(cfg.db, cfg.world, sweep, now());
        if (swept > 0) {
          cfg.log?.("cloud_mirror_swept", { count: swept, reason: "bootstrap phantoms removed after a since=0 re-pull" });
          // Rows left the mirror without a tombstone in the feed, which is the same arithmetic
          // problem a delete is: the held total is now above what either side holds.
          sawDeletes = true;
          hostedCounts = new Map();
        }
        // The bootstrap AND its sweep have completed: clear the flag so the next drain resumes
        // incrementally instead of re-bootstrapping. The format version rides the same write —
        // this is the point where a re-key has finished, and until it lands the next launch
        // correctly starts over.
        cursor.bootstrapping = false;
        cursor.version = CURSOR_VERSION;
        writeCursor(cfg.cursorPath, cursor);
        // The generation completed and swept: its marks have no further reader. AFTER the cursor
        // write, so a crash between the two leaves a stale file a fresh generation truncates,
        // never a finished bootstrap the next launch mistakes for an interrupted one.
        deleteBootstrapGen(genPath);
        /* AND NOW THE RETIRED ROWS CAN GO. On an upgraded install the placeholder mailbox was
           still holding every mirrored message when the refresh retired it, so it survived as a
           tombstone; the re-pull above has just moved them onto the account's own mailboxes, and a
           tombstone nobody references would otherwise render in Settings as a mailbox that has
           disconnected itself. */
        const dropped = await cfg.db.transaction((tx) => dropRetiredMailboxes(tx, cfg.world, hostedMailboxIds));
        if (dropped.length > 0) {
          cfg.log?.("cloud_mailboxes_refreshed", {
            dropped: dropped.length,
            reason: "the placeholder mailbox this mirror used to file mail under holds none of it " +
              "any more and has been removed",
          });
        }

      }
      // AFTER the drain, so a bootstrap has already delivered the tags natively and is skipped by
      // the zero-tags gate rather than by a special case for it.
      await repairStaleTags();
      await repairStaleFolders(sweep !== null && sweep !== undefined);
      await backfillBodies();
      // AFTER the body pass, deliberately: `backfillBodies` is what resolves the walk and moves it
      // to `complete`, and the repair defers (without marking) while it is still walking — so
      // running it first would defer for ever on an install whose walk finishes in this same pull.
      await repairCapMarkers();
      if (aborted) {
        cfg.log?.("cloud_pull_stopped", {
          count: applied,
          reason: "the mirror was asked to stop after the drain; nothing is stamped, because a " +
            "pass that did not finish is not a pass that finished",
        });
        return applied;
      }
      /* THE TWO STAMPS THE PROGRESS SURFACE READS. See {@link stampSynced} — on a mirrored
         install this process is the only thing that could write them, and without them the
         window's sync line has no way to tell a first import from a settled mailbox. The body
         walk reaching its end is part of "drained": the mail list is complete before its bodies
         are, and a first import that claims to be finished while messages still open blank has
         claimed too early. This is also the fact {@link resolveBodiesWalk} reads back on a later
         launch to tell a finished walk from one that never started.

         ON EVERY ACTIVE MIRRORED ROW, AND NEVER ON A TOMBSTONE. It used to be the single synthetic
         mailbox, which no longer exists once the refresh has retired it — stamping that id would
         update no row at all and the sync line would say "Syncing your mail" for the life of the
         install. A retired row is excluded for the inverse reason: a mailbox that is gone has no
         import to report finishing. */
      for (const row of await activeMirroredMailboxes()) {
        await stampSynced(cfg.db, row.id, now(), cursor.bodies.phase === "complete");
      }
      // A completed pull is the definition of reachable: the local database keeps serving what it
      // holds either way, but the proxy needs to know it can forward a write again.
      reachable = true;
      cfg.log?.("cloud_pull_applied", { count: applied });
      return applied;
    } catch (err) {
      // A failed pull is a bad network or a spent token — offline, not stopped. The proxy answers
      // `503 offline_read_only` off this flag; the poll keeps retrying and flips it back on success.
      reachable = false;
      throw err;
    }
  };

  /**
   * Single-flight `pullOnce`: the poll timer and an echo-await can ask concurrently, and sharing
   * one drain keeps the cursor writes serialized. Two concurrent drains would still CONVERGE (every
   * apply is an upsert), but one is cheaper and avoids two writers racing the cursor file.
   */
  const pullOnce = (): Promise<number> => {
    inflight ??= runPull().finally(() => {
      inflight = null;
    });
    return inflight;
  };

  /** One queued follow-up, at most — see {@link CloudMirror.kick}. */
  let kickQueued = false;
  const kick = (): void => {
    if (stopped) return;
    if (inflight) {
      kickQueued = true;
      return;
    }
    void pullOnce()
      .catch(() => {
        // `runPull` logged it and flipped `reachable`; the POLL owns retries. A kick that also
        // retried would double every backoff the moment the wake stream got chatty.
      })
      .finally(() => {
        if (kickQueued && !stopped) {
          kickQueued = false;
          kick();
        }
      });
  };

  const awaitCloudSeq = async (target: bigint, deadlineMs: number): Promise<boolean> => {
    const end = Date.now() + Math.max(0, deadlineMs);
    for (;;) {
      if (cloudSeq() >= target) return true;
      // A stopped mirror never advances again, so waiting on it is waiting for ever — and this loop
      // would otherwise keep starting pulls against a database that is being closed.
      if (aborted) return false;
      try {
        await pullOnce();
      } catch {
        // Offline mid-echo — `runPull` already flipped the flag. Keep trying to the deadline in
        // case it was a blip, then let the caller answer anyway (the write landed on Cloud).
      }
      if (cloudSeq() >= target) return true;
      const remaining = end - Date.now();
      if (remaining <= 0) return false;
      await new Promise((r) => setTimeout(r, Math.min(50, remaining)));
    }
  };

  /**
   * Schedule the next pull. A SUCCESS resets the backoff and polls at the steady cadence; a FAILURE
   * retries on an exponential backoff bounded by {@link RECONNECT_MAX_MS}, so a dropped network or a
   * spent token reconnects promptly without hammering. Either way the next drain RESUMES FROM THE
   * CURSOR FILE — the last committed page already wrote it — so no progress is re-fetched.
   */
  const scheduleAfter = (failed: boolean): void => {
    if (stopped) return;
    let delay: number;
    if (failed) {
      delay = backoffMs;
      backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
    } else {
      backoffMs = RECONNECT_BASE_MS;
      delay = cfg.pollIntervalMs ?? DEFAULT_CLOUD_POLL_MS;
    }
    timer = setTimeout(() => {
      void pullOnce()
        .then(() => scheduleAfter(false))
        .catch((err: unknown) => {
          // A failed pull is a bad network or an expired token, not a reason to stop being a mirror.
          // The local database keeps serving what it holds; the next attempt resumes from the cursor.
          cfg.log?.("cloud_pull_failed", { err, reason: "the pull did not complete; the mirror keeps serving what it holds and retries with backoff" });
          scheduleAfter(true);
        });
    }, delay);
    timer.unref?.();
  };

  return {
    pullOnce,
    kick,
    draining: () => inflight !== null,
    online: () => reachable,
    markConnectivity: (v: boolean) => {
      reachable = v;
    },
    cloudSeq,
    awaitCloudSeq,
    // The live map, not a copy: the only caller reads it synchronously to decorate one response,
    // and the map is REPLACED rather than mutated on each counted refresh, so a reader can never
    // observe a half-built one.
    hostedCounts: () => hostedCounts,
    async start() {
      // A first pull that fails is a bad network or an expired token, not a launch failure: the
      // mirror serves what it holds and the poll retries (on backoff). Scheduling regardless is what
      // keeps a transient bootstrap failure from stopping the mirror forever.
      try {
        await pullOnce();
        scheduleAfter(false);
      } catch (err) {
        cfg.log?.("cloud_pull_failed", { err, reason: "the first pull did not complete; the mirror serves what it holds and the poll retries with backoff" });
        scheduleAfter(true);
      }
    },
    async stop() {
      stopped = true;
      // Set BEFORE the await, or the walk this is waiting on never sees the ask and the wait is
      // the very hang it exists to prevent.
      aborted = true;
      if (timer) clearTimeout(timer);
      timer = null;
      // A pull that fails on the way out is still a pull that has left, which is all a caller
      // closing the database needs to know.
      await inflight?.catch(() => undefined);
    },
  };
}
