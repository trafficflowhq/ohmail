import { closeSync, fsyncSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, asc, desc, eq, gt, isNull, ne, notInArray, sql } from "drizzle-orm";
import { recordChange, recordChanges, accountSettings, CAPABILITY_REQUESTS,
} from "@trafficflow/db";
import {
  approvals, attachments, drafts, flagState, folderState, mailboxCredentials, mailboxFolders,
  mailboxes, messageBodies, messageFailures, messageInstances, messageStates, messages, messageTags,
  outboundSends, routingDecisions, rules, tags, threadNotes, threads, trackerEvents,
  unsubscribeRecords,
} from "@trafficflow/db/mail";
import { BODIES_IDS_MAX } from "@trafficflow/services/mail";
// THE SHARED DRAIN POLICY — the ONE definition of "is this mirror behind", of the three
// freshness states, and of the dense-page limit, held with `packages/client-engine`
// (INSTANT-ARCH §6.7, stage 7's first adopted responsibility). Dependency-free core source —
// no store, no clock, no network, no DOM — on its own subpath for the reason `./ics` has one:
// this process must NOT link `@ohmail/client-engine` itself, and it does not. See
// `packages/core/package.json`'s `//drain-policy` note; `test/one-pipeline.test.ts` holds this
// import to that subpath, and the Cloud census resolves it like every other workspace edge.
import {
  drainPageLimit, mirrorFreshness, mirrorStale, type MirrorFreshness,
} from "@trafficflow/core/drain-policy";
import type {
  ApprovalDTO, ChangeOp, DraftDTO, EntityType, MailboxDTO, MessageBodyBatchItem, MessageDTO,
  MessageStateDTO, Page, RoutingDecisionDTO, RuleDTO, SnapshotResponse, SyncChange, SyncResponse,
  TagDTO, ThreadDTO,
} from "@trafficflow/services/mail";
import type { LocalDb } from "./db.js";
import type { LocalWorld } from "./identity.js";
import type { CloudAuth } from "./cloud-auth.js";
import { stampSynced } from "./sync-stamp.js";
import { createFirstSyncReporter } from "./first-sync.js";
import { mirroredMessageCount } from "./local-mirror.js";
import type { Diagnostic } from "./log.js";

/**
 * The cloud mirror: pull the hosted account's `/sync` feed into the local mail schema so the
 * desktop reads a complete mirror WITHOUT organizing. A Cloud install has no IMAP adapter, lease
 * or sync loop (`cloud-engine-census.test.ts` makes that structural), so the hosted worker stays
 * the single organizer. The five convergence rules (`apply.ts`) hold as idempotent (type,id)
 * upserts. `accountId` is remapped to `world.accountId`; `mailboxId` is copied VERBATIM (remapping
 * it to the synthetic row broke drafts, From and replies), so mailbox rows are mirrored first
 * ({@link makeMailboxRefresh}) before the drain for the FK, and each entity appends one local
 * change-log row. A bootstrap runs NEWEST FIRST — the snapshot window before the seq replay.
 */

/**
 * The nine `/sync` entity types the hosted feed carries (`packages/api/src/routes/sync.ts`).
 *
 * `"tag"` IS ONE OF THEM, and its absence here is why a hosted account's tags did not reach the
 * desktop. This list is sent as `?types=`, so it is a request as well as a description: leaving a
 * type out asks the server not to send it. Tag ASSIGNMENTS are not a type of their own — they ride
 * `message`, as `MessageDTO.labels`, which is why {@link applyUpsert} writes both from one change.
 */
export const CLOUD_SYNC_TYPES = [
  "message", "thread", "routing_decision", "approval",
  "draft", "rule", "message_state", "folder", "tag",
  /**
   * The account's settings row — the doorbell that lets a consent knob flipped on ANY surface
   * reach an open desktop window without a restart. The hosted writers append one `settings`
   * change per knob write (`consent-seed.ts`); pulling it here re-emits it into the LOCAL change
   * log (see `applyUpsert`), so the webview's own drain bumps its mirror version and the shell
   * re-asks `GET /consent` — which this door FORWARDS to the hosted account, so the re-ask is
   * live truth. Unlike `"tag"` above, there is no stale-mirror repair to run for this type: a
   * settings row is re-askable state, not history — a mirror that missed old settings rows loses
   * nothing, because its next `GET /consent` answers from the account itself.
   */
  "settings",
] as const satisfies readonly EntityType[];

/**
 * And every `EntityType` is in that list — a COMPILE-TIME assertion, in `src` where it compiles.
 * `CLOUD_SYNC_TYPES` is sent as `?types=`, so it is a REQUEST: a type left out asks the feed not
 * to send it and the mirror converges — by its own rules — missing a whole kind of state (it
 * shipped without `"tag"`, so tags never reached any desktop until `repairStaleTags`, and nothing
 * was red because an under-asking client looks like an account with no tags). Adding an
 * `EntityType` without listing it makes `Exclude<…>` stop being `never` and this fails to compile;
 * `satisfies` above catches the reverse. The `as const` is load-bearing — a widened annotation
 * makes the assertion vacuous.
 */
type CloudSyncTypeMissing = Exclude<EntityType, (typeof CLOUD_SYNC_TYPES)[number]>;
type CloudSyncTypesAreComplete = [CloudSyncTypeMissing] extends [never] ? true
  : { "EntityType missing from CLOUD_SYNC_TYPES — the desktop would never be sent it": CloudSyncTypeMissing };
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const cloudSyncTypesAreComplete: CloudSyncTypesAreComplete = true;
void cloudSyncTypesAreComplete;

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
  "settings", "folder", "tag", "thread", "message", "message_state", "rule", "draft", "approval", "routing_decision",
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
 * How many of the NEWEST body-less messages each pull asks for ahead of the first body walk's
 * turn — five `?ids=` requests at the server's cap, roughly the first screenful of a list. See
 * `backfillBodies` for why this runs beside the walk rather than reordering it.
 */
export const NEWEST_BODIES_FIRST = 5 * BODIES_IDS_MAX;

/**
 * THE ON-DISK MARKER FOR A FINISHED BODY WALK. Written into the cursor file's `bodies` field, where
 * every other value is a `messages.id` — a UUID — so the two can never be confused, and an old
 * build reading it would send `after=complete` and get a `400 invalid cursor` rather than silently
 * mirroring the wrong rows.
 */
export const BODIES_WALK_COMPLETE = "complete";

/**
 * Where the body walk has got to — three states, in the field that once held two. `GET
 * /messages/bodies` answers `nextCursor: null` on the LAST page, and storing that verbatim meant
 * both "the walk finished" and "no `after=`, start again" — so a completed walk restarted on every
 * poll, re-fetching every body for as long as the app was open (converging on identical rows, so
 * it went unnoticed). Splitting the states is the fix, and it must survive cursor files written
 * before it existed — see {@link resolveBodiesWalk} for how a `null` read off disk is decided.
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
 * THE ON-DISK MARKER FOR A FINISHED OPENING WINDOW — {@link BODIES_WALK_COMPLETE}'s trick, for its
 * reason: every other value in the cursor file's `window` field is a hosted snapshot cursor
 * (base64url JSON, which cannot spell this word), so the two can never be confused, and a build
 * from before the field existed ignores it altogether.
 */
export const WINDOW_PASS_COMPLETE = "complete";

/**
 * WHERE THE BOOTSTRAP'S OPENING WINDOW HAS GOT TO — the header's NEWEST FIRST section. Persisted
 * after every landed page so a kill inside the window resumes at the page after the last committed
 * one, against the same generation's marks, instead of re-reading the window from page 1.
 */
type WindowPass =
  /** Not started: a fresh generation, or a cursor file written before the pass existed. */
  | { phase: "pending" }
  /** Mid-window. `next` is the hosted snapshot cursor of the page to fetch next. */
  | { phase: "paging"; next: string }
  /** Every page of this generation's window has landed; the replay owns the rest. */
  | { phase: "complete" };

/** The on-disk `window` field for a pass state. The inverse of {@link readWindowPass}. */
function writeWindowPass(w: WindowPass): string | null {
  switch (w.phase) {
    case "complete":
      return WINDOW_PASS_COMPLETE;
    case "paging":
      return w.next;
    default:
      return null;
  }
}

/** A cursor file's `window` field as a pass state. The inverse of {@link writeWindowPass}. */
function readWindowPass(raw: unknown): WindowPass {
  if (raw === WINDOW_PASS_COMPLETE) return { phase: "complete" };
  if (typeof raw === "string" && raw !== "") return { phase: "paging", next: raw };
  return { phase: "pending" };
}

/**
 * How many CONSECUTIVE pulls may be refused at the opening window before the bootstrap proceeds
 * without it. Three, on the reconnect ladder's 1 s / 2 s steps: a cold query or a blip clears well
 * inside that, and a route that is still refusing after three asks is not going to answer this
 * launch — holding the whole first sync on it would be the failure the window exists to shorten.
 * A 404 is definitive and skips at once. See {@link drainWindowFirst}.
 */
export const WINDOW_REFUSALS_MAX = 3;

/**
 * The cursor file's format version — an ABSENT version means 0, which means RE-KEY. The mirror's
 * rows changed meaning when mailbox attribution stopped being the synthetic local id (see the
 * header), and no delta can repair a row that has not changed on Cloud, so the version IS the
 * migration and the default is the dangerous direction on purpose: a file with no `version` reads
 * as 0 and forces a `since=0` re-bootstrap through the corrected upsert (the inverse default would
 * leave every upgraded install silently wrong). The re-pull is the ordinary resumable bootstrap,
 * not a discard (`message_bodies` is keyed on `message_id`). VERSION 2 is the same shape for
 * `message_states`, whose local random id served every triage state as a delete tombstone.
 */
export const CURSOR_VERSION = 2;

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
   * Set while a `since=0` bootstrap is in flight and its trailing sweep has NOT run; cleared once
   * it has. It makes mark-and-sweep crash-safe: a bootstrap that commits a page then dies leaves a
   * non-zero cursor, and resuming is safe ONLY against the same generation's marks (a resume
   * against a partial rebuild would sweep real rows). So a launch that finds this set RESUMES from
   * the committed cursor when the generation file is there to mark into, and restarts from zero
   * when it is not. Restart-from-zero on every interruption never finishes a large mailbox — a
   * long replay that starts over on any sleep or quit serves week-old mail while looking alive.
   */
  bootstrapping: boolean;
  /**
   * The opening window's progress inside the CURRENT bootstrap generation — see {@link WindowPass}
   * and the header's NEWEST FIRST section. Meaningful only while `bootstrapping` is set: reset to
   * pending whenever a generation starts (fresh, 410, re-key) and when the bootstrap completes.
   * Absent from every cursor file written before the pass existed, which reads as pending — so an
   * install upgraded mid-replay runs the window once before continuing its replay, which costs the
   * window's pages and brings forward the newest mail the replay was otherwise hours from reaching.
   */
  window: WindowPass;
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
  /**
   * The mirror's own "when was I last caught up" — the instant the last pull drained `/sync` to the
   * horizon, this process's clock, written only at pull completion (a cut pull leaves the old stamp
   * so the next pull freshens again; idempotent). The sidecar's copy of the engine's
   * `LAST_DRAIN_AT_META` (INSTANT-ARCH §6.6), read by two things: {@link createCloudMirror}'s
   * stale-resume freshen (a warm mirror past `STALE_RESUME_MS` fetches snapshot page 1 first) and
   * {@link CloudMirror.freshness} (the window's "as of <time> · catching up" label). `null` is
   * every pre-freshen cursor and every mirror that never completed a pull — the honest default.
   */
  lastDrainAt: string | null;
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
   * Stop polling, ask any in-flight pull to leave, and resolve once it has. The await is the point
   * (and why this is not `void`): clearing the poll timer stopped the NEXT pull and did nothing
   * about the running one, so quitting closed the database under a drain still enqueuing work,
   * missed the shell's grace period and was killed with a page half-applied. The walk checks
   * between pages and id batches, so a caller waits for one request and one page apply. Nothing is
   * left half-written — the cursor advances only after a page commits, and an interrupted bootstrap
   * stays marked so the next launch restarts it rather than sweeping against a partial mark.
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
   * How many messages the hosted account holds, per hosted mailbox id — the numbers this mirror is
   * draining TOWARD, not the ones it holds. Empty until the first counted refresh (see {@link
   * HOSTED_COUNTS_TTL_MS}) and empty for ever on an account that answers no counts. An empty map
   * means "this process cannot tell", and every consumer must render that as an ABSENT number, not
   * zero — `0` would assert somebody's account is empty, the one thing a mirror may never say about
   * the master copy. In memory on purpose: it is not a mirrored row (the `mailboxes` table is the
   * shared schema), and a count is a measurement whose honest lifetime is short.
   */
  hostedCounts(): ReadonlyMap<string, number>;
  /**
   * The freshness contract's verdict for this mirror (INSTANT-ARCH §6.6) — the same three states
   * the client engine's `freshness()` derives, from this mirror's completion stamp ({@link
   * CursorState.lastDrainAt}) against the shared `STALE_RESUME_MS`, the same `mirrorFreshness`
   * call: `unknown` (no pull ever completed), `stale` (last pull older than the threshold; the
   * store is renderable truth as of `asOf`), `current` (recent; the steady state). Served to the
   * window over `GET /mirror/freshness` — the desktop's WINDOW engine is always "current" relative
   * to this process, so the honest "as of" is THIS process's stamp against the account, not the window's.
   */
  freshness(): MirrorFreshness;
}

export const DEFAULT_CLOUD_POLL_MS = 20_000;

/**
 * How old the hosted message counts may get before the next refresh asks again.
 * `GET /mailboxes?counts=1` is one grouped aggregate over the account's whole `messages` table,
 * made opt-in (`routes/mailboxes.ts`) precisely so a POLLED route cannot put that scan behind a
 * heartbeat — and this mirror polls three times a minute. Fifteen minutes, with {@link
 * HOSTED_COUNTS_MIN_GAP_MS} as a hard floor, puts a steady install at four counted reads an hour;
 * the count feeds a sentence about a shortfall of dozens of messages and needs no more. The cases
 * that DO need it fresh (a just-started process, a bootstrap, a backlog) are asked for by name.
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
  /** The serialized {@link WindowPass}; absent on every file from before the opening window. */
  window?: unknown;
  tagBackfill?: unknown;
  folderBackfill?: unknown;
  capMarkerRepair?: unknown;
  /** ISO instant of the last completed pull; absent on every file from before the freshen. */
  lastDrainAt?: unknown;
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
      window: readWindowPass(j.window),
      tagBackfill: j.tagBackfill === true,
      folderBackfill: j.folderBackfill === true,
      // `=== true`, never `?? true`: an absent key must read FALSE. The inverse would silently
      // exempt every install that HAS the defect and leave only fresh ones correct.
      capMarkerRepair: j.capMarkerRepair === true,
      // Absent (every pre-freshen file) reads NULL — "not known to be current" — so an upgraded
      // stale install freshens on its first resume, which is the population the port is for.
      lastDrainAt: typeof j.lastDrainAt === "string" && j.lastDrainAt !== "" ? j.lastDrainAt : null,
    };
  } catch {
    // No file at all is a FRESH install, not an upgraded one: there are no rows to re-key, and the
    // `sync: "0"` below already bootstraps. Stamping the current version keeps the re-key a
    // statement about mirrors that exist.
    return {
      version: CURSOR_VERSION, sync: "0", bodies: { phase: "unresolved" },
      bootstrapping: false, window: { phase: "pending" }, tagBackfill: false, folderBackfill: false,
      // A fresh install has no pre-marker rows and its walk writes markers from the start.
      capMarkerRepair: true,
      // And it has never completed a pull: the bootstrap's own window owns "newest first" here.
      lastDrainAt: null,
    };
  }
}

function writeCursor(path: string, state: CursorState): void {
  const onDisk: CursorFile = {
    version: state.version,
    sync: state.sync,
    bodies: writeBodiesWalk(state.bodies),
    bootstrapping: state.bootstrapping,
    window: writeWindowPass(state.window),
    tagBackfill: state.tagBackfill,
    folderBackfill: state.folderBackfill,
    capMarkerRepair: state.capMarkerRepair,
    ...(state.lastDrainAt !== null ? { lastDrainAt: state.lastDrainAt } : {}),
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
 * A bootstrap generation: the ids a `since=0` re-pull touched, tagged per entity type. A `since=0`
 * replay carries the account's CURRENT entities, so a message deleted on Cloud while the mirror
 * was offline — its tombstone since fallen below the retention horizon — is simply absent, and a
 * plain re-pull would leave the local row a PHANTOM for ever. The fix is mark-and-sweep: tag every
 * managed row this generation writes, then delete the managed rows it never touched. Membership is
 * keyed by each table's own id — `message_state` included, whose DTO carries no `id`, which once
 * made this set key on the messageId while {@link applyPage} recorded the row id.
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
  /**
   * This generation's marks were written under a DIFFERENT `CURSOR_VERSION`, so the ids they name
   * are not this build's ids for every type. See {@link BOOTSTRAP_GEN_FILE}: the resume still
   * happens (it has to — a restart on every interruption never finishes on a large mailbox), and
   * {@link sweepPhantoms} skips the ONE type whose keying moved instead of sweeping it against
   * marks it cannot read.
   */
  keyingStale: boolean;
}

/**
 * The generation file, beside the cursor: one `<type> <id>` line per marked row under a
 * `#keying <CURSOR_VERSION>` header. THE HEADER makes the marks comparable — a mark is an entity's
 * id, so a re-key that changes WHICH id marks an entity makes earlier marks unreadable, and the
 * sweep reads an unreadable mark as "the feed never sent this row" and deletes it (version 2 moved
 * `message_state` from the messageId to the row id, so a v1 bootstrap resumed under v2 would sweep
 * every applied triage state). It refuses a MISMATCHED file rather than every re-key: the
 * same-version resume is load-bearing (a restart on every interruption never finishes), so only
 * the cross-version one starts over, once. A headerless file is a version-1 file and is refused.
 */
const BOOTSTRAP_GEN_FILE = "cloud-bootstrap-gen.marks";
const GEN_KEYING_PREFIX = "#keying ";

function genPathFor(cursorPath: string): string {
  return join(dirname(cursorPath), BOOTSTRAP_GEN_FILE);
}

const GEN_TYPES = [
  "folder", "thread", "message", "message_state", "rule", "draft", "approval", "routing_decision", "tag",
] as const;
type GenType = (typeof GEN_TYPES)[number];

function genOver(path: string, sets: Record<GenType, Set<string>>, keyingStale = false): BootstrapGen {
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
    keyingStale,
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

/** A FRESH generation: truncate the file, stamp the keying, start marking from nothing. */
function newBootstrapGen(path: string): BootstrapGen {
  writeFileSync(path, `${GEN_KEYING_PREFIX}${CURSOR_VERSION}\n`);
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
  // The keying stamp. A file written under another keying is LOADED, not refused: the resume is
  // load-bearing, and only `message_state`'s keying moved, so the sweep skips that one type
  // rather than the whole generation. Absent ⇒ a version-1 file ⇒ stale.
  const keyingStale = !raw.startsWith(`${GEN_KEYING_PREFIX}${CURSOR_VERSION}\n`);
  const sets = emptyGenSets();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const t = line.slice(0, sp) as GenType;
    if (!(GEN_TYPES as readonly string[]).includes(t)) continue;
    sets[t].add(line.slice(sp + 1));
  }
  return genOver(path, sets, keyingStale);
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

async function draftPresent(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.select({ id: drafts.id }).from(drafts).where(eq(drafts.id, id)).limit(1);
  return rows.length > 0;
}

async function threadPresent(tx: Tx, id: string): Promise<boolean> {
  const rows = await tx.select({ id: threads.id }).from(threads).where(eq(threads.id, id)).limit(1);
  return rows.length > 0;
}

/**
 * A hosted `MailboxDTO` as the local row that mirrors it — minus the two progress stamps.
 * `lastSyncAt` and `initialImportCompletedAt` are DELIBERATELY ABSENT: copying them breaks the
 * body walk as blank mail. `initial_import_completed_at` is what `resolveBodiesWalk` reads to tell
 * a finished body walk from one that never started, and a hosted account finished ITS import long
 * ago, so copying the stamp onto a mirror that has fetched no body resolves the walk `complete` and
 * hands it to `fetchMissingBodies` — which asks only about messages already held, none on a first
 * pull. They are stamps about THIS mirror's own progress, written by `stampSynced`.
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
    /* Mail 0083's six facts, which this projection used to drop. `MailboxDTO` carries all of them
     * and this copied `disabledReason` and stopped, so the row asserted the default
     * `organizer_role = 'organizer'` about a mailbox the DTO may say Cloud only READS. `?? null` on
     * each: this object IS the `onConflictDoUpdate` set, so a key left out persists a Cloud-cleared
     * value. A mirrored role means nothing for WRITES — a Cloud engine forwards every mutation with
     * the bearer and the hosted API applies `assertOrganizerRole` (`cloud-engine-census.test.ts`) —
     * so these columns feed the READ surfaces (the mailbox pane's reader banner), and a door switch
     * to standalone (`ensureLocalWorld`) then lets `standDownMemory` answer truthfully. */
    organizerRole: m.organizerRole ?? "organizer",
    organizedByKind: m.organizedBy?.kind ?? null,
    organizedByName: m.organizedBy?.name ?? null,
    organizedSince: asDate(m.organizedBy?.since ?? null),
    organizerState: m.organizerState ?? null,
    /* The notice's two instants travel with the role (mail 0088), and the argument is sharper: the
     * notice is DERIVED (`event_at > seen_at`), so a mirror carrying the role and not the instants
     * would show a Cloud desktop a changed organizer with no line saying so — or leave `seen_at`
     * NULL against a live `event_at` and re-show a notice already dismissed in the browser. BOTH,
     * never one: `event_at` alone re-shows a dismissed notice, `seen_at` alone hides a real one.
     * The hosted row is the authority for both; a Cloud client writes neither of its own — its
     * dismiss goes to the hosted route and the next pull brings the answer back. */
    organizerEventAt: asDate(m.organizerEventAt),
    organizerEventSeenAt: asDate(m.organizerEventSeenAt),
    /* And so do the two facts the pane reads beside them — the columns the mailbox pane and the
     * Screener derive their controls from. `organizerReleasedAt` separates a mailbox this account
     * let go on purpose from one whose holder vanished (both readers with no holder; only the first
     * has a sentence about something the person did). The holder's capabilities decide whether a
     * decision made here has anywhere to go: dropping them degrades to "nothing can be decided",
     * the safe screen while no organizer offers the channel and the WRONG one the day some do. The
     * hosted row is the authority for both; the capability travels as the DERIVED answer and is
     * stored back in the column the local read derives from, `false` writing NULL. */
    organizerReleasedAt: asDate(m.organizerReleasedAt),
    organizedByCapabilities: m.organizerAcceptsRequests === true ? CAPABILITY_REQUESTS : null,
    organizeConsentedAt: asDate(m.organizeConsentedAt),
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
 * retirement, and why it is a two-step. A FRESH install reaches this in the refresh transaction
 * with the synthetic row holding zero references (the refresh precedes the first drain), so it goes
 * at once; an UPGRADED install reaches it with every mirrored message still pointing at that row,
 * so it survives as a tombstone until the re-key has moved them and runs again after the drain.
 * The zero-reference guard makes the two cases one rule, and is the honest answer for a mailbox
 * REMOVED on Cloud: its mail is still here, so its row stays, as `mailboxes_active_address_uq` expects.
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
 * Apply one hosted mailbox list into the local table — retire, upsert, prune, IN ONE TRANSACTION,
 * in that order. The order is a unique-constraint dodge: `mailboxes_active_address_uq` is
 * `(account_id, lower(address)) where status <> 'disabled'`, and the synthetic row's address is
 * the hosted mailbox's, so inserting while it is still `connected` violates it — retiring first
 * frees the index. The single transaction is why `GET /mailboxes` never answers `[]`: split, a
 * reader between transactions sees only tombstones and gets "No mailbox connected". A retirement is
 * an ordinary tombstone with `disabled_reason` NULL — a reason would let a later launch resurrect it.
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
 * Replace a message's tag assignments with exactly the ones its DTO carries. It is a REPLACE, not
 * an upsert, because `labels` is the whole set — an unassign arrives as the same `message` change
 * with one fewer id — so an insert-only apply would add tags and never remove one; delete-then-
 * insert inside the page transaction gives the set semantics the wire has, idempotently. An id
 * naming a tag we have NOT got is skipped, not stubbed: `message_tags.tag_id` has a foreign key,
 * {@link APPLY_ORDER} lands a tag before its assignment, and the residual (a tag create fallen
 * below the retention horizon) is better skipped than hung on a nameless stub the client can't draw.
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
 * Apply one non-delete change. Returns false when a foreign-key referent is missing and the row is
 * skipped — the cursor still advances (a later update re-emits it), the forward-compatible posture
 * `apply.ts` takes. That re-emission is true of the FK skips and FALSE of the mailbox one: a
 * message whose thread has not arrived changes again, but a message naming a MAILBOX this database
 * lacks does not (mail at rest emits nothing), which is why the refresh runs BEFORE the drain and
 * is a hard failure. `known` is every local mailbox id whatever its status (a tombstone satisfies
 * the FK), because attributing mail to a DIFFERENT mailbox is the one thing this may never do — a
 * message it cannot place honestly is better absent.
 */
async function applyUpsert(
  tx: Tx,
  world: LocalWorld,
  ch: SyncChange,
  now: Date,
  gen: BootstrapGen | null,
  known: ReadonlySet<string>,
): Promise<boolean | "partial"> {
  switch (ch.type) {
    case "settings": {
      /**
       * The account's settings row — applied for its STAMP, never for authority. The hosted-door
       * consent reads forward to the hosted account, so nothing a user sees is served from these
       * columns; this write moves the local row's `updated_at` so the local `/sync`'s
       * `materializeSettings` answers a stamp that MOVED, which tells the shell to re-ask. Two
       * columns are deliberately NOT written: `folders_enabled_at` (`reconcileLocalFoldersFlag`
       * derives the flag from what the feed sent, and a second writer would fight it) and the
       * per-mailbox exceptions (they live on the mirrored `mailboxes` rows, not this change's).
       */
      const st = ch.entity as {
        dormancyDays?: number | null; autoSuggestAt?: string | null;
        blockRemoteImagesAt?: string | null; loadTrackingPixelsAt?: string | null;
        blockAutoUnsubscribeAt?: string | null; locale?: string | null; updatedAt?: string;
      } | undefined;
      if (!st) return false;
      const stamp = asDate(st.updatedAt) ?? now;
      const cols = {
        dormancyDays: st.dormancyDays ?? null,
        autoSuggestAt: asDate(st.autoSuggestAt),
        blockRemoteImagesAt: asDate(st.blockRemoteImagesAt),
        loadTrackingPixelsAt: asDate(st.loadTrackingPixelsAt),
        blockAutoUnsubscribeAt: asDate(st.blockAutoUnsubscribeAt),
        locale: st.locale ?? null,
        updatedAt: stamp,
      };
      await tx.insert(accountSettings)
        .values({ accountId: world.accountId, ...cols })
        .onConflictDoUpdate({ target: accountSettings.accountId, set: cols });
      return true;
    }
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
      /* THE ARRIVAL, AND IT IS IN THE CONFLICT SET. `created_at` defaults to the moment THIS
         process wrote the row, which on a mirror is not when the mailbox recorded the message —
         and the cutline dates an undated message by exactly that column, so the local reader
         would call every dateless sender active for ever. Carried from the wire when the server
         sends it (the same instant each time, so the update is idempotent); omitted for a server
         older than the field, which leaves the row as it was rather than moving it to now. */
      const arrived = asDate(m.arrivedAt);
      // `created_at` is NOT NULL: an unparseable value must leave the column alone, never reach it.
      const rowArrival = arrived && Number.isFinite(arrived.getTime()) ? { createdAt: arrived } : {};
      await tx.insert(messages).values({
        id: m.id,
        accountId: world.accountId,
        // A mirror carries no raw body, so it derives no dedup/body hash. `dedup_key` is unique per
        // mailbox; keying it to the message id keeps the constraint honest without a body to hash.
        bodyHash: "",
        dedupKey: `cloud:${m.id}`,
        ...display,
        ...rowArrival,
      }).onConflictDoUpdate({ target: messages.id, set: { ...display, ...rowArrival } });
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
      /**
       * The hosted row's id, carried — the one field this case left to `defaultRandom()`.
       * `MessageStateDTO` is the only DTO on the wire with no `id`, so this insert let PGlite mint a
       * random uuid while `applyPage` recorded the change-log under the HOSTED id, and the local
       * `/sync` — materializing by `message_states.id` — found nothing and served a DELETE
       * tombstone: parked and piled mail vanished from the Ohbox and Resurface while
       * `MessageDTO.triage` (joined by MESSAGE id) kept its chip. The conflict target stays
       * `message_id`, so rows minted before this HEAL in place on the next page; `id` is in the set.
       */
      const stateId = ch.id;
      await tx.insert(messageStates).values({
        id: stateId,
        accountId: world.accountId,
        messageId: s.messageId,
        state: s.state,
        bubbleUpAt: asDate(s.bubbleUpAt),
        setAt: asDate(s.setAt) ?? now,
        updatedAt: asDate(s.updatedAt) ?? now,
      }).onConflictDoUpdate({
        target: messageStates.messageId,
        set: {
          id: stateId,
          state: s.state,
          bubbleUpAt: asDate(s.bubbleUpAt),
          setAt: asDate(s.setAt) ?? now,
          updatedAt: asDate(s.updatedAt) ?? now,
        },
      });
      // Marked by the ROW id, which is what `sweepPhantoms` now selects and what `applyDelete`
      // keys on — one spelling of this entity's identity across all three.
      gen?.message_state.add(stateId);
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
      // `in_reply_to_message_id` has an FK; keep it only when the parent is mirrored. A draft
      // whose parent is absent still lands (user writing is never dropped) but lands DEGRADED —
      // reported as `"partial"` below so the stale-resume freshen's supersession ledger never
      // treats it as the entity's full state: the replay's own copy of the same draft, applying
      // AFTER its parent message lands (message precedes draft in APPLY_ORDER), is what
      // restores the reply relationship, and a ledger that superseded it would leave the draft
      // detached until its next edit (found in the diet's client half).
      const wantsReplyParent = Boolean(d.inReplyToMessageId);
      const inReplyTo = d.inReplyToMessageId && (await messagePresent(tx, d.inReplyToMessageId))
        ? d.inReplyToMessageId
        : null;
      /* ── THE ONE FIELD A PAGE MAY LEAVE OUT, AND `?? ""` WAS THE WAY TO LOSE MAIL ─────────
         `DraftDTO.body` is `null` when a bounded page would not carry it (a stored body past
         `DRAFT_BODY_MAX_BYTES`). Coalescing that to `""` wrote an EMPTY body over the mirror's
         copy, and `drafts.body` is `NOT NULL` here, so this store cannot say "unknown" the way
         the browser mirror can — the compose surface would then open an empty editor on a
         message that is not empty and autosave the blank back to the account. So the body is
         left out of the write entirely: a row we already hold keeps its text and lands
         `"partial"` (the ledger must not read it as the entity's full state), and a row we have
         never seen is not created at all, which is the arm an unknown mailbox already takes.
         The next single-row read or edit carries the body and settles it. */
      const bodyCarried = typeof d.body === "string";
      if (!bodyCarried && !(await draftPresent(tx, d.id))) return false;
      const body = {
        accountId: world.accountId,
        // The draft's OWN sending mailbox — see the message branch. A draft written against the
        // synthetic id could never be sent: the hosted `PUT /drafts` refuses a mailbox that does
        // not belong to the account, which is the 400 every Cloud-door send used to collect.
        mailboxId: d.mailboxId,
        threadId: d.threadId ?? null,
        inReplyToMessageId: inReplyTo,
        subject: d.subject ?? "",
        ...(bodyCarried ? { body: d.body as string } : {}),
        html: d.html ?? null,
        to: d.to ?? [],
        cc: d.cc ?? [],
        rationale: d.rationale ?? null,
        status: d.status,
        updatedAt: asDate(d.updatedAt) ?? now,
      };
      if (bodyCarried) {
        await tx.insert(drafts).values({ id: d.id, ...body, body: d.body as string })
          .onConflictDoUpdate({ target: drafts.id, set: body });
      } else {
        // UPDATE, never an upsert: an insert would need a `body` value, and the only one
        // available is the empty string this branch exists to refuse. The row was present a
        // statement ago; if it has since gone, nothing is written and nothing is invented.
        await tx.update(drafts).set(body).where(eq(drafts.id, d.id));
      }
      gen?.draft.add(d.id);
      if (d.threadId) gen?.thread.add(d.threadId);   // the thread stub this draft pinned
      return !bodyCarried || (wantsReplyParent && inReplyTo === null) ? "partial" : true;
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
 * Apply one delete, children before the message so its own FKs are clear — and every `message_id`
 * foreign key, not just the ones this file writes. A missed FK-holder does not lose one row: it
 * ABORTS the whole page transaction (23503), the cursor never advances, and the retry replays it,
 * wedging the mirror while it looks transient (measured 2026-08-24: one draft's
 * `in_reply_to_message_id` pinned the cursor two days). The hosted store's delete is a `deleted_at`
 * stamp, so this clears every table `schema-mail.ts` points at `messages.id`, the five the Cloud
 * door never writes included. A replying draft is DETACHED (→ NULL), never deleted, and every
 * detach is reported so the local `/sync` redraws the survivor.
 */
interface DetachedSurvivor { type: "message" | "draft"; id: string }

/**
 * How many survivor announcements one `recordChanges` call may carry. PGlite 0.2.17 accepts at
 * most 32,767 bind parameters per statement, and a change-log insert spends six per row, so an
 * unchunked batch THROWS (`RangeError: Invalid array length`) at exactly 5,462 rows — the same
 * wedge this slice removes, reached by repairing it (a page rolls back, the cursor never advances,
 * every poll replays). 1,000 rows is 6,000 parameters: under the cap, ~5 statements for the
 * largest plausible thread.
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
      // BY ROW ID, the same identity the upsert carries. Keyed on `message_id` this matched
      // nothing for a hosted delete, whose change names the row — so an un-park done on another
      // device left the pile entry standing here for ever.
      await tx.delete(messageStates).where(eq(messageStates.id, ch.id));
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
  /**
   * When present, every change that ACTUALLY applied adds its wire identity (`type:id`) here —
   * the stale-resume freshen's ledger of what it landed, which the replay behind it uses to
   * skip the superseded copies (see `drainSync`). Applied-only on purpose: a row applyUpsert
   * FK-skipped was NOT landed, so the replay must stay free to deliver it once its referent
   * arrives.
   */
  appliedKeys?: Set<string>,
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
        const outcome = await applyUpsert(tx, world, ch, now, gen, known);
        if (outcome) {
          // Every entity keeps its hosted id verbatim — EXCEPT the settings row, whose id IS an
          // account id, and the one identity the two worlds do not share is the account's own:
          // the local `materializeSettings` answers only for the LOCAL account and reads a
          // foreign id as "not this account's" — a null entity, which the local feed then
          // drains as a DELETE. Re-keyed here so the doorbell that arrived rings instead of
          // tombstoning the very record it announces.
          await record(type, type === "settings" ? world.accountId : ch.id, ch.op, ch.move);
          // A PARTIAL apply (a reply draft landed with its parent still unmirrored) is real
          // enough to record and count, but it is NOT the entity's full state — the ledger
          // must leave the replay's own copy free to heal it once the parent lands.
          if (outcome !== "partial") appliedKeys?.add(`${ch.type}:${ch.id}`);
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
          appliedKeys?.add(`${ch.type}:${ch.id}`);
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
 * The mark-and-sweep. After a `since=0` bootstrap drain, delete every managed mail row the
 * generation never touched — the phantoms. FK-safe, children before parents: routing decisions,
 * approvals, drafts, message states and rules first (each an independent phantom off a surviving
 * message), then messages (whose delete cascades bodies, states and folder_state as a tombstone
 * would), then threads last, whose delete detaches surviving drafts rather than taking user writing
 * with them. Each swept entity appends a local DELETE change-log row so the projection drops it too,
 * and {@link applyDelete} is reused verbatim so the cascade matches the incremental path.
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
    // By ROW id, like every other type: a `message_state`'s /sync id IS its row id (the DTO is
    // the one with no `id` field, which is what made this read as the messageId).
    //
    // SKIPPED ENTIRELY for a generation written under another keying, because its marks name
    // messageIds and this query names row ids: every live state would read as unmarked and be
    // deleted — which is the defect this release fixes, arriving through its own repair. Skipping
    // can only LEAVE a row, and there is almost nothing to leave: the replay re-applies each
    // state under its hosted id onto the unique `message_id`, so the row is healed in place, and
    // a state whose message really is a phantom goes with that message's cascade below.
    if (!gen.keyingStale) {
      for (const r of await tx.select({ id: messageStates.id }).from(messageStates).where(eq(messageStates.accountId, world.accountId)))
        if (!gen.message_state.has(r.id)) await sweepOne("message_state", r.id);
    }
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
 * The one-time stale-mirror tag repair: apply `GET /sync/snapshot` pages into a mirror whose cursor
 * ran past tags it never asked for. `CLOUD_SYNC_TYPES` gained `"tag"` after the first mirrors were
 * running, and `types=` is a REQUEST, so those mirrors were served no tag change and the old tags
 * sit BELOW their cursor — a delta only looks forward and never delivers them (a fresh `since=0`
 * sign-in is unaffected, which is why the fix looked proven). Tags alone light no chip: assignments
 * ride `MessageDTO.labels` and {@link applyLabels} SKIPS an id for a missing tag, so the caller
 * ({@link repairStaleTags}) pages to the labeled tail to re-hang older tagged mail. It rewrites no
 * message row, touches only non-empty `labels`, and is idempotent per message.
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
  /* THE SAME INSTRUMENT AS THE STANDALONE DOOR'S, from the same stamps — one per mirror, because
     the "already announced" half is per launch. `cfg.log` is optional here, so an install with no
     logger reports nothing rather than needing a second code path. See `first-sync.ts`. */
  const firstSync = createFirstSyncReporter(cfg.log ?? ((): void => {}));
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
   * Did anything get deleted since the counts were read? — the one direction that makes a held
   * count a LIE rather than merely old. The counts refresh on a cadence of minutes, and inside that
   * window the mirror keeps draining: a drain that ADDS mail biases the shortfall toward silence
   * (harmless), but one that applies TOMBSTONES moves the local number DOWN while the held total
   * stays, so the shortfall is a sentence about mail that no longer exists (deleted from another
   * device). So a delete drops the held counts on the spot (the strip then says nothing) and makes
   * the next refresh ask; a phantom sweep counts as a delete, since it also removes local rows.
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
   * Pull the account's mailboxes and apply them. Runs at the start of every pull, before the drain,
   * and a failure here fails the WHOLE pull — the safe direction. Continuing without a mailbox set
   * skips every message it cannot attribute, and on a `since=0` bootstrap a skipped message is one
   * the generation never marked, so the trailing sweep would delete it: a transient 500 would empty
   * somebody's mirror. The cost of throwing is bounded and visible — `runPull` flips `reachable`
   * false, the read surface keeps serving every held row, the write-through proxy answers
   * `503 offline_read_only`, and the poll retries on the same backoff a failed `/sync` uses.
   */
  /**
   * May this refresh ask for the counts? Reasons named rather than folded into a shorter interval,
   * because each is a different question: this process has NEVER ASKED (the launch after days
   * closed — "never asked", not "holds no numbers", or an account that serves no counts would ask
   * one aggregate a minute for ever); a BOOTSTRAP is running (the denominator is all that makes the
   * count mean anything); the last drain saw `hasMore`; the last drain applied a DELETE (the held
   * total is now too high); or the numbers are older than {@link HOSTED_COUNTS_TTL_MS}. The floor
   * ({@link HOSTED_COUNTS_MIN_GAP_MS}) is checked FIRST, so no combination puts two within a minute.
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
   * Rules before mail — the bootstrap's one ordering promise. A `since=0` replay interleaves by
   * hosted seq, so a sender decided AFTER their mail replays mail-first, and the consent cutline
   * reads the absent rule as "no decision" — already-screened senders present in the Screener until
   * the replay catches up (measured; unknown is not undecided). So a bootstrap first drains
   * `?types=rule` from zero through the SAME `applyPage` without touching the committed cursor, and
   * re-runs on a resumed bootstrap; a failure propagates as any drain page failure. Reads are NOT
   * gated on this pass — the bridge renders before the first pull, and gating local reads on a
   * network request would blank a device whose mail is local; a client corrects on its next poll.
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
   * One refetch of the mailbox list per drain — see {@link landPage}'s pre-scan. Reset at the top
   * of every drain, and shared by the window and the replay because both land pages of one pull.
   */
  let refetched = false;
  /**
   * Consecutive pulls refused at the opening window — see {@link drainWindowFirst}. Reset by a
   * landed window page; never persisted, so a relaunch gets its own {@link WINDOW_REFUSALS_MAX}.
   */
  let windowRefusals = 0;

  /**
   * LAND ONE PAGE OF ENTITIES — the half the window and the replay share, so the mailbox guard, the
   * FK-detaching delete path, the folder reconciliation and the generation marks behave identically
   * whichever phase delivered the page. Returns what it applied; the CALLER owns the cursor write
   * that follows, which is why the marks are flushed here and no cursor is.
   */
  const landPage = async (
    body: SyncResponse, gen: BootstrapGen | null, appliedKeys?: Set<string>,
  ): Promise<number> => {
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
    const applied = await applyPage(cfg.db, cfg.world, body, now(), gen, knownMailboxes, appliedKeys);
    // AFTER the commit: the generation's marks land BEFORE either cursor moves past the page they
    // describe — the ordering {@link BootstrapGen.flush} rests on.
    gen?.flush();
    return applied;
  };

  /**
   * The opening window — phase 1 of a bootstrap; the header's NEWEST FIRST section is the contract.
   * Pages `GET /sync/snapshot` from the cursor file's `window`, lands each through {@link landPage}
   * as a page of creates, and persists the next page's cursor only after it committed and its marks
   * flushed. `cursor.sync` is never written. Three answers are not the page asked for: a 410 to a
   * PERSISTED cursor re-reads from page 1 once per drain (its marks stay); a second 410 or a 410 to
   * a cursorless page is definitive (skip, uncounted); a 404 skips to the plain replay; anything
   * else non-OK is a REFUSAL — the first {@link WINDOW_REFUSALS_MAX}−1 propagate as a drain failure,
   * the next skips. The skip is not persisted here — `complete` rides the replay's first cursor write.
   */
  const drainWindowFirst = async (gen: BootstrapGen | null): Promise<{ applied: number; cut: boolean }> => {
    let applied = 0;
    let restarted = false;
    for (;;) {
      if (aborted) return { applied, cut: true };
      const w = cursor.window;
      if (w.phase === "complete") return { applied, cut: false };
      const q = new URLSearchParams({ limit: String(pageLimit) });
      if (w.phase === "paging") q.set("cursor", w.next);
      const res = await cfg.auth.authedFetch(`/sync/snapshot?${q.toString()}`);
      if (res.status === 410 && w.phase === "paging" && !restarted) {
        restarted = true;
        cursor.window = { phase: "pending" };
        cfg.log?.("cloud_window_restarted", {
          reason: "the hosted snapshot refused the window's persisted page cursor; the window is " +
            "re-read from its first page inside the same bootstrap generation",
        });
        continue;
      }
      /* A 200 whose body is not JSON — an HTML fallback page, an empty 204 — is a REFUSAL like a
         non-snapshot body, not a transport failure: `res.json()` rejecting here would propagate past
         the count below and retry the window for ever on exactly the broken route the count exists
         to give up on. */
      let snap: SnapshotResponse | null = null;
      if (res.ok) {
        try {
          snap = (await res.json()) as SnapshotResponse;
        } catch {
          snap = null;
        }
      }
      if (snap === null || !Array.isArray(snap.changes)) {
        /* DEFINITIVE refusals skip at once: a 404 (no such route), and a 410 the one restart above
           did not cure — the server refusing the cursor it just issued, or refusing a cursorless
           page 1. Counting a 410 instead would let the restart's landed page 1 reset the count, and
           the drain would restart → page 1 → 410 → fail on every pull without ever reaching the
           replay. */
        windowRefusals = res.status === 404 || res.status === 410 ? WINDOW_REFUSALS_MAX : windowRefusals + 1;
        if (windowRefusals < WINDOW_REFUSALS_MAX) {
          throw new Error(`the hosted /sync/snapshot answered HTTP ${res.status} to the opening window`);
        }
        cursor.window = { phase: "complete" };
        cfg.log?.("cloud_window_skipped", {
          status: res.status,
          reason: "the hosted snapshot did not answer the opening window (no such route, or refused " +
            "on consecutive pulls), so this bootstrap fills oldest-first from the feed alone; the " +
            "mirror converges the same, only later at the top",
        });
        return { applied, cut: false };
      }
      windowRefusals = 0;
      const page: SyncResponse = {
        changes: { creates: snap.changes, updates: [], moves: [], deletes: [] },
        cursor: cursor.sync,
        hasMore: snap.nextCursor !== null,
        serverTime: now().toISOString(),
      };
      applied += await landPage(page, gen);
      // The window's position moves only after the page committed and its marks flushed. A
      // `nextCursor` that is not a non-empty string is the end of the window, not a page to ask
      // for: `cursor=undefined` would 410, restart, and loop.
      cursor.window = typeof snap.nextCursor === "string" && snap.nextCursor !== ""
        ? { phase: "paging", next: snap.nextCursor }
        : { phase: "complete" };
      writeCursor(cfg.cursorPath, cursor);
      // A page LANDED, so Cloud demonstrably answers — the replay's own rule, from the first page.
      reachable = true;
    }
  };

  /**
   * A stale resume fetches the newest page before it replays its backlog — the engine's
   * `freshenStaleResume`, ported (INSTANT-ARCH §3.3/§8). The newest-first window exists only for the
   * cursor-0 bootstrap, so a WARM mirror reopened days later replayed oldest-first and the mail the
   * person wanted landed last. So when {@link CursorState.lastDrainAt} is past `STALE_RESUME_MS`,
   * fetch snapshot page 1 through the SAME {@link landPage} before the replay's first ask — sound
   * because every apply is an idempotent upsert of current state, a Cloud deletion is absent and the
   * replay's tombstone removes it, and `cursor.sync` is NEVER touched. NEVER during a bootstrap (its
   * pages land `gen: null`, so the sweep would delete them). Returns the ledger plus `asOfSeq`.
   */
  const freshenStaleResume = async (): Promise<{ keys: Set<string>; asOfSeq: number } | null> => {
    if (aborted) return null;
    // THE SHARED STALENESS VERDICT — `mirrorStale`, the same call the engine's `isStaleResume`
    // makes over its own stamp, absent-and-unparseable-are-stale arms included. The BOOTSTRAP
    // gate is this driver's own (the caller passes `sweep === null`); "am I bootstrapping" is a
    // fact about this mirror's generation file, not about the policy.
    if (!mirrorStale(cursor.lastDrainAt, now())) return null;
    try {
      const q = new URLSearchParams({ limit: String(pageLimit) });
      const res = await cfg.auth.authedFetch(`/sync/snapshot?${q.toString()}`);
      let snap: SnapshotResponse | null = null;
      if (res.ok) {
        try {
          snap = (await res.json()) as SnapshotResponse;
        } catch {
          snap = null;
        }
      }
      if (snap === null || !Array.isArray(snap.changes)) {
        cfg.log?.("cloud_freshen_deferred", {
          status: res.status,
          reason: "the hosted snapshot did not answer the stale-resume freshen; the replay from " +
            "the committed cursor still converges, only later at the top",
        });
        return null;
      }
      const page: SyncResponse = {
        changes: { creates: snap.changes, updates: [], moves: [], deletes: [] },
        cursor: cursor.sync,
        hasMore: false,
        serverTime: now().toISOString(),
      };
      const appliedKeys = new Set<string>();
      const landed = await landPage(page, null, appliedKeys);
      reachable = true;
      cfg.log?.("cloud_freshen_applied", {
        count: landed,
        reason: "this mirror resumed stale, so the newest page landed before the backlog replay " +
          "— the view is current after one round trip instead of after the whole replay",
      });
      // The freshened screenful's text, before the replay — the window's own rule, for the
      // window's reason: the body pass only runs after the drain returns, and a stale resume's
      // replay can hold that back for tens of seconds. Bounded, best-effort, and only when the
      // page actually landed rows — a freshen that changed nothing owes no ask.
      if (landed > 0) {
        try {
          await fetchMissingBodies(NEWEST_BODIES_FIRST);
        } catch (err) {
          cfg.log?.("cloud_freshen_bodies_deferred", {
            reason: "the freshened screenful's body ask failed; the body walk still owes every body",
            // The THROWN value, not a string: the hardened logger reduces it to class+code, and
            // `String(err)` collapses every failure to `errorClass: "String"` with no code.
            err,
          });
        }
      }
      return { keys: appliedKeys, asOfSeq: snap.asOfSeq };
    } catch (err) {
      cfg.log?.("cloud_freshen_deferred", {
        // Raw, for the class+code reduction — see the bodies deferral above.
        err,
        reason: "the stale-resume freshen did not complete; the replay from the committed cursor " +
          "still converges, only later at the top",
      });
      return null;
    }
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
    // A drain that begins at since=0 — a first launch, or a healed/absent cursor — or that finds an
    // unfinished bootstrap is a BOOTSTRAP: tag what it touches, sweep at the end. It RESUMES from
    // the committed cursor when its generation file is there to mark into (the union of marks across
    // segments covers exactly the pages the feed served, the sweep's whole requirement) and
    // restarts from zero when it is not — restart-on-every-interruption never finishes a large
    // mailbox, which is why the generation persists. A cursor in an older FORMAT is the fourth way
    // in: its rows carry the wrong mailbox attribution, so the whole feed replays through the
    // corrected upsert, never resumed (see {@link CURSOR_VERSION}).
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
      // A window still paging is the OTHER shape an interrupted bootstrap takes: the feed cursor
      // is still zero (phase 1 never writes it) and the marks on disk are the window's. Resumed on
      // the same terms — against the loaded generation — never re-read from page 1.
      const resumed = cursor.bootstrapping && (!isBootstrapCursor(cursor.sync) || cursor.window.phase !== "pending")
        ? loadBootstrapGen(genPath)
        : null;
      if (resumed) {
        sweep = resumed;
        cfg.log?.("cloud_bootstrap_resumed", {
          reason: resumed.keyingStale
            ? "an interrupted bootstrap continues from its committed cursor, and its marks were " +
              "written under an earlier keying, so the one type whose keying moved is not swept " +
              "against ids those marks cannot name"
            : "an interrupted bootstrap continues from its committed cursor against the same " +
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
        // A new generation owes the whole window, whatever an older file said about an earlier one.
        cursor.window = { phase: "pending" };
        sweep = newBootstrapGen(genPath);
      }
    }
    refetched = false;
    // A bootstrap (fresh, resumed, re-keyed — anything that set `sweep`) owes the rules-first
    // pass before its first page; the 410 branch below re-owes it with the fresh generation.
    let rulesFirstOwed = sweep !== null;
    // …and, after the rules, the opening window. The header's NEWEST FIRST section is the contract.
    // A replay resumed past its window owes nothing here: `drainWindowFirst` reads the persisted
    // `complete` and returns without an ask, so the file is the one place that decision lives.
    let windowOwed = sweep !== null;
    // A WARM resume converges its newest page FIRST when the mirror is stale — before the loop,
    // once per drain, and only outside a bootstrap (whose window owns "newest first" and whose
    // sweep would eat unmarked rows — see the method). `stale-resume` in `cloud-mirror.test.ts`
    // watches the gate and the ordering red.
    //
    // The freshen's return value is the backlog diet's second half (stage 3): the ledger of
    // what it landed, at what point. The replay below then (a) asks for DENSE pages — the
    // server coalesces a stale span, so page count is the cost that matters — and (b) skips
    // every change the ledger supersedes, because re-upserting a row the freshen just wrote is
    // the measured majority of the desktop replay's serial PGlite work.
    const freshened = sweep === null ? await freshenStaleResume() : null;
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
      if (windowOwed) {
        windowOwed = false;
        const w = await drainWindowFirst(sweep);
        applied += w.applied;
        if (w.cut) return { applied, sweep: null, cut: true };
        // ── THE FIRST SCREENFUL'S TEXT, BEFORE THE REPLAY — not after it ────────────────────
        //
        // The replay behind this point can run for HOURS on a large account, and the body pass
        // (`backfillBodies`) only runs after `drainSync` returns — so without this ask the
        // window's messages sat bodiless for the replay's whole life, opening blank in exactly
        // the period the newest-first bootstrap exists to make usable (an argument was made for the
        // CHANGELOG's sentence against the code, which is the standard the sentence is written
        // to). One bounded newest-first ask, and best-effort: a failure costs nothing the walk
        // does not still owe, so it is logged and the replay proceeds.
        try {
          await fetchMissingBodies(NEWEST_BODIES_FIRST);
        } catch (err) {
          cfg.log?.("cloud_window_bodies_deferred", {
            reason: "the window's first-screenful body ask failed; the body walk still owes every body",
            err,
          });
        }
        // The between-pages stop check, REPEATED after this await: `stop()` can set the flag
        // while the pre-pass is in flight, and falling through would start the replay's next
        // /sync request after shutdown was asked for — past the shell's grace window (review
        // round). Same cut shape as the loop's own check: the bootstrap resumes next launch.
        if (aborted) return { applied, sweep: null, cut: true };
      }
      const q = new URLSearchParams({
        since: cursor.sync || "0",
        // A warm-STALE replay is a backlog catch-up and asks for the dense page — the shared
        // `BACKLOG_PAGE_LIMIT`, through `drainPageLimit`, which is the same decision the
        // engine's drain makes. Keyed on the freshen's own verdict so the ask and
        // the freshen can never fire on different staleness readings; a freshen that failed or
        // found the mirror current leaves the deployed page size untouched. `sweep === null`
        // too: a mid-drain 410 turns this drain INTO a bootstrap, and bootstraps keep their
        // deployed shape (this slice does not touch mark-and-sweep behaviour).
        limit: String(drainPageLimit(freshened !== null && sweep === null, pageLimit)),
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
        // The re-bootstrap owes the rules-first pass AND the window again, against the fresh
        // generation — whatever the last window had got to describes marks that no longer exist.
        rulesFirstOwed = true;
        cursor.window = { phase: "pending" };
        windowOwed = true;
        cfg.log?.("cloud_cursor_expired", { reason: "410 from /sync; re-bootstrapping from since=0 with mark-and-sweep" });
        continue;
      }
      if (!res.ok) throw new Error(`the hosted /sync answered HTTP ${res.status}`);
      let body = (await res.json()) as SyncResponse;
      // The freshen-supersession skip (stage 3). A change at `seq ≤ asOfSeq` for an identity the
      // freshen LANDED is a superseded copy — the freshen's copy is the entity's state AT `asOfSeq`,
      // tombstones included — so dropping it is the engine's older-or-equal seq guard expressed for
      // a mirror with no per-row seq. Anything newer, or anything the freshen could not land,
      // applies as before, and the cursor still advances over what was skipped. `sweep === null` is
      // LOAD-BEARING: a mid-drain 410 arms a fresh generation while `freshened` still holds the
      // pre-410 ledger, so a bootstrap page filtered by it would leave the skipped identities
      // UNMARKED and the sweep would delete them — the skip exists only outside bootstraps.
      if (freshened !== null && sweep === null) {
        const superseded = (ch: SyncChange): boolean =>
          ch.seq <= freshened.asOfSeq && freshened.keys.has(`${ch.type}:${ch.id}`);
        body = {
          ...body,
          changes: {
            creates: body.changes.creates.filter((c) => !superseded(c)),
            updates: body.changes.updates.filter((c) => !superseded(c)),
            moves: body.changes.moves.filter((c) => !superseded(c)),
            deletes: body.changes.deletes.filter((c) => !superseded(c)),
          },
        };
      }
      // The pre-scan, the apply and the marks flush are {@link landPage}'s — the window's pages
      // go through the identical sequence, which is what keeps the two phases one mirror.
      applied += await landPage(body, sweep);
      // AFTER the commit and the flush: a crash before this line re-applies the page next launch,
      // which converges, and the marks are already on disk ahead of the cursor that names them.
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
   * The stale-mirror tag repair, once per install (see {@link applyTagBackfill} for the damage).
   * Three gates in cost order, each also a correctness statement: the cursor flag (never asked
   * twice); ZERO local tag rows (the whole detection — any tag means the type was served, so it is
   * left alone, and a fresh sign-in arrives already bootstrapped); and the hosted account HAS tags.
   * A failed probe is NOT a failed pull — it swallows, leaves the flag unset and retries, or it
   * would put the write-through proxy into `503 offline_read_only`. It drains the WHOLE snapshot
   * (the tail carries tagged mail older than the window), sets the flag only on completion, and is
   * an idempotent upsert, so a crash re-run converges.
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
   * The one-time folder backfill — `repairStaleTags`' shape for its reason, with one gate
   * difference. Between the drain first asking for `folder` entities and the apply loop learning to
   * store them, a mirror could drain folder creates, drop them, and persist a cursor past them — a
   * delta only looks forward, so the Folders rail stays empty for the life of the install. Unlike
   * tags, "no local folder rows" is AMBIGUOUS (the account may have folders off), so there is no
   * present-rows gate: the snapshot's page 1 is the answer itself (it carries folder entities iff
   * the hosted flag is on), and applying it plus reconciling the local flag settles both readings.
   * Marked considered only when read; a failed fetch retries; the apply is idempotent.
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
   * Decide what an old cursor's `bodies: null` meant — the migration read, and a one-way door.
   * Every pre-walk install carries `null` for two populations of unequal size: a mirror up more
   * than the few minutes a walk takes has FINISHED it, while only a brand-new install between its
   * first `/sync` and first body page has not started. The discriminator on disk is
   * `initial_import_completed_at` ({@link stampSynced} stamps it when a pass drains with the walk
   * spent): stamped ⇒ complete, unstamped ⇒ walk. A wrong "walk" costs one pass; a wrong "complete"
   * leaves mail blank for ever. It reads every ACTIVE mirrored row ({@link mailboxRow} does not copy
   * the hosted stamp); no rows at all is `walking`.
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
   * The steady state: fetch bodies for the messages this mirror holds that have none, and nothing
   * else — zero rows means zero requests, what a settled mailbox does every poll. The obvious
   * incremental source is the drain's own output, and it is wrong at scale: a `since=0` re-bootstrap
   * applies EVERY message, so driving off the feed re-requests every body; and a body skipped by the
   * FK skip in {@link storeBodies} is in no later page, so nothing comes back for it. Asking the
   * database which messages have no body answers both with one indexed read that cannot drift. It is
   * also why the keyset walk's terminal state is safe: `getBodies` LEFT-JOINs, so a completed walk
   * wrote a row (empty if that is the account's answer) for every message, and "missing" means absent.
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
        * An absent id has TWO meanings, and only one is "stop asking". The ids mode drops an id for
        * two reasons the wire cannot distinguish: the account does not own it (a 404 would be an
        * existence oracle) and `BODIES_BYTE_BUDGET` was crossed before its row was reached (whose
        * contract is the OPPOSITE — asked per message by the client). Reading every absence as the
        * first parked ids in `unanswered`, so a message after a budget's worth mirrored blank for
        * ever (owner report, 2026-08-21). The discriminator is the answer's shape: an OWNED message
        * always yields an item (the service LEFT-JOINs), so absence from a non-empty answer is the
        * budget and an empty answer is "none owned" — re-ask the leftovers, mark only from empty.
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

  /**
   * Newest first, here too — the gap is filled from the top of the list down. Which body-less
   * messages a pull asks for first used to be uuid order, a random permutation, so the message at
   * the top of the list could get its body LAST; after the newest-first bootstrap the list is
   * current within seconds while bodies still arrived in that random order, so a newest message
   * opened blank until the fill reached it. The order is now the list's own — `date desc nulls
   * last, id desc`, the snapshot window's sort (`sync-service.ts`). Ordering ONLY: same gap
   * predicate, `BODIES_CATCHUP_MAX` bound, `unanswered` filter and `askForIds` writer as before.
   */
  const NEWEST_FIRST = [sql`${messages.date} desc nulls last`, desc(messages.id)];

  const fetchMissingBodies = async (limit: number = BODIES_CATCHUP_MAX): Promise<number> => {
    const rows = await cfg.db.select({ id: messages.id })
      .from(messages)
      .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .where(and(eq(messages.accountId, cfg.world.accountId), isNull(messageBodies.messageId)))
      .orderBy(...NEWEST_FIRST)
      .limit(limit);
    const wanted = rows.map((r) => r.id).filter((id) => !unanswered.has(id));
    if (wanted.length === 0) return 0;
    return askForIds(wanted);
  };

  /**
   * The one-time cap-marker repair — an old sidecar's empty row is not the same fact as an empty
   * message. A pre-cap sidecar ignores `item.withheld` and inserts an ordinary empty row; upgrading
   * adds `withheld_reason` NULL, indistinguishable from "ordinarily empty", and {@link
   * fetchMissingBodies} only offers ABSENT rows, so a withheld body serves as empty for ever. A
   * {@link CURSOR_VERSION} bump leaves `bodies` alone and fetches none, and widening the predicate
   * is a standing poll with no termination — so termination is a property of the CURSOR, considered
   * once and recorded (absent files read `false`, the population that needs it). Deferred WITHOUT
   * marking while the first body walk runs, or it would ask twice and mark done over a filling mirror.
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

  /**
   * The body pass: walk the account once, then keep only the newcomers topped up. `walkAllBodies`
   * is a keyset walk in the SERVER's order (`messages.id`, a uuid — a random permutation) and must
   * stay so: the `after` cursor is what makes an interrupted walk resume. So during a bootstrap the
   * list is current within seconds while the bodies at its TOP arrive whenever uuid space reaches
   * them. The fix is not to reorder the walk but to put a bounded newest-first ask IN FRONT of each
   * turn — {@link fetchMissingBodies} in the list's order, capped at {@link NEWEST_BODIES_FIRST} —
   * so each pull takes the next newest screenful and the two converge on the same set. The bounded
   * price is the bodies the walk re-sends (`storeBodies` upserts); the walk's own state is untouched.
   */
  const backfillBodies = async (): Promise<number> => {
    if (cursor.bodies.phase === "unresolved") {
      cursor.bodies = await resolveBodiesWalk();
      writeCursor(cfg.cursorPath, cursor);
    }
    if (cursor.bodies.phase === "walking") {
      const newest = await fetchMissingBodies(NEWEST_BODIES_FIRST);
      if (aborted) return newest;
      return newest + await walkAllBodies();
    }
    return fetchMissingBodies();
  };

  const runPull = async (): Promise<number> => {
    /* WHEN THIS PULL BEGAN, for the first-import clock below. A pull walks the whole feed before it
       can stamp anything, so the pull that finds a first import open is where a large mirror's
       first pages land; handing the reporter the moment it reported would leave that pull outside
       the duration it announces. See `first-sync.ts`. */
    const pullStartedAt = performance.now();
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
        // The window belonged to the generation that just finished; the next bootstrap owes its own.
        cursor.window = { phase: "pending" };
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
       /* The two stamps the progress surface reads (see {@link stampSynced}) — on a mirrored install
          this process is the only writer, and without them the window's sync line cannot tell a
          first import from a settled mailbox. The body walk reaching its end is part of "drained":
          the mail list completes before its bodies, and a first import that claims finished while
          messages open blank claimed too early. It is also the fact {@link resolveBodiesWalk} reads
          back later. ON EVERY ACTIVE MIRRORED ROW, never a tombstone: the old single synthetic id is
          gone (stamping it updates no row and the line says "Syncing your mail" for ever), and a
          removed mailbox has no import to report finishing. */
      for (const row of await activeMirroredMailboxes()) {
        const stamps = await stampSynced(cfg.db, row.id, now(), cursor.bodies.phase === "complete");
        await firstSync.report(row.id, stamps, () => mirroredMessageCount(cfg.db, row.id), pullStartedAt);
      }
      // THE PULL'S LAST WORD — this mirror drained the hosted feed to its horizon at this
      // moment, on this process's own clock. Written at COMPLETION and nowhere earlier, exactly
      // as the engine writes LAST_DRAIN_AT_META: a pull that failed or was cut above leaves the
      // old stamp standing, so the next pull still reads as a stale resume and freshens again.
      // What `freshness()` reports and what the freshen compares are this one write.
      cursor.lastDrainAt = now().toISOString();
      writeCursor(cfg.cursorPath, cursor);
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
    // THE SHARED THREE-STATE DERIVATION — literally the function `OhmailEngine.freshness()`
    // calls, over this mirror's own stamp and this process's own clock. One derivation, three
    // renderers (the web ladder, the phone's wordmark line, the desktop window over
    // `GET /mirror/freshness`), so a label can never disagree with a freshen.
    freshness: () => mirrorFreshness(cursor.lastDrainAt, now()),
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
