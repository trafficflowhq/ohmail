// The search tier vocabulary, shared with the hosted service — a dependency-free core subpath
// like the two above. The archive's answer names its tier on the wire, and the local index
// decides its own by the same rule, so the merged list can put both under one heading.
import type { SearchTier } from "@trafficflow/core/search-rank";
import type { ReadIntent } from "../adapters/adapter.js";
import type { StoreKeyset, StoreTimelineFn } from "../store-pages.js";
import type { EngineMessage, MessageBodyBatchWire, OhmailView, SyncSnapshotPage } from "../types.js";

/**
 * WHAT `GET /search` ANSWERS, as much of it as this client reads. The route returns `{ items, facets, total }`.
 * `items` are canonical `MessageDTO`s, and an {@link EngineMessage} is exactly a `MessageDTO` plus optional fixture
 * extras, so a DTO IS one — no conversion, no second shape. `facets` is deliberately NOT read: the server's facet
 * keys are raw folder paths (`SearchService.folderExpr` → `desired_folder` / the native locator), while the local
 * index keys its facets by VIEW id or by folder leaf, and rendering the server's keys would put a namespaced IMAP
 * path straight on screen. The surface keeps its local facets; forward-compatible parsing (§8) means the extra field
 * is not an error.
 */
export interface ServerSearchWire {
  items: EngineMessage[];
  /** Matches for the query across the WHOLE corpus, which is more than `items.length`. */
  total: number;
  /**
   * WHICH TIER THE ARCHIVE'S ANSWER IS — `exact` when its lexical arm matched, `similar` when these rows are
   * typo-tolerant guesses because nothing matched literally. The rule and its floor are
   * `@trafficflow/core/search-rank`'s, applied identically by the local index. Optional on the wire, and ABSENT MEANS
   * `exact`. That is not a shrug: every server before this field existed returned its lexical answer (fused with a
   * fuzzy arm, but intending an answer, not a guess), and a client that read the absence as `similar` would file a
   * real result under a "Similar" heading. The unknown case takes the reading that does not mislabel a hit — and a
   * client and a server ship in the same wave, so the window is short.
   */
  tier?: SearchTier;
  /** `false` when `total` is a lower bound (the page alone was asked for). Absent ⇒ exact. */
  totalExact?: boolean;
  /** When `total` is a lower bound: about how many match, from the store's statistics. */
  totalEstimate?: number;
  /** The server's own time for this answer, in milliseconds. Absent on an older server. */
  ms?: number;
  /** The next page's cursor for the same question; `null`/absent on the last page. */
  nextCursor?: string | null;
  /** The last relevance page of a fused set cut at its top rows — the date orders walk them all. */
  bounded?: boolean;
  /** Present while the store is still indexing this account's older mail. */
  indexed?: { done: number; total: number };
  /** Present while the store has not taken in the whole mailbox: a first import is still open. */
  importing?: true;
  /** Counts over the WHOLE match set (the summary part), keyed as the store keys them. */
  facets?: ServerSearchFacets;
  /** A paired desktop's door answered from its mirror, a window of the account, which was unreachable. */
  answeredFrom?: "mirror";
}

/** The store's facets: folder by its stored path, senders by address, attachments and unread. */
export interface ServerSearchFacets {
  folder: Record<string, number>;
  sender: Array<{ address: string; count: number }>;
  hasAttachments: { true: number; false: number };
  unread: { true: number; false: number };
}

/** A facet pressed: the store answers the narrowed question, never a filter over one page. */
export interface ServerSearchFilters {
  folder?: string;
  sender?: string;
  hasAttachments?: boolean;
}

/**
 * THE ORDER THE ARCHIVE IS ASKED FOR — the same closed vocabulary the search service declares on the server, spelled
 * out again here for the reason `owner-cookie.ts` repeats a cookie name: this package is the STANDALONE desktop
 * payload and cannot import the hosted service, so the list is written out twice and held together by a test on the
 * server's side that reads both declarations and fails if they drift. Adding an order HERE that the server does not
 * accept is the dangerous direction — the route refuses what it does not recognise, so every search a user ran with
 * it would fail. `relevance` is the default at every layer, and an absent value means it: the parameter is left OFF
 * the wire rather than sent explicitly, so a client on this build asks an older server exactly the question it asked
 * before.
 */
export const SERVER_SEARCH_SORTS = ["relevance", "date_desc", "date_asc", "mailbox", "sender"] as const;
export type ServerSearchSort = (typeof SERVER_SEARCH_SORTS)[number];

/** The parts of one answer a caller may name — `estimate` answers {@link ServerEstimateOutcome}. */
export type ServerSearchPart = "page" | "summary" | "estimate";

/** What a caller may ask of one archive pass. */
export interface ServerSearchOpts {
  limit?: number;
  /** Absent ⇒ `relevance`, and nothing is put on the wire. */
  sort?: ServerSearchSort;
  /**
   * `page` asks for the first page alone, at index speed (its `total` exact only when
   * `totalExact`); `estimate` for the count and facets over the page's candidates, no rows;
   * `summary` for the exact count with no rows. Absent ⇒ both, and nothing is put on the wire,
   * so an older server is asked what it always was.
   */
  parts?: ServerSearchPart;
  /** The `nextCursor` of the previous page for the same query and sort. */
  cursor?: string;
  filters?: ServerSearchFilters;
  /**
   * The asking walker and its question ({@link EngineOptions.searchSupersede}): the desktop engine
   * drops a lane's older requests when a newer generation arrives. Never sent with the option off.
   */
  lane?: { id: string; generation: number };
}

/**
 * The transport `searchServer` runs on. Optional everywhere: the demo has no server, the
 * desktop tier has no Cloud, and neither may be given one.
 */
export type ServerSearchFn = (
  query: string,
  opts: ServerSearchOpts,
) => Promise<ServerSearchWire | null>;

/**
 * WHAT `GET /search?address=&direction=` ANSWERS — the archive half of the address view. `items` are canonical
 * `MessageDTO`s, so an {@link EngineMessage} IS one, exactly as {@link ServerSearchWire} explains. No `tier`: an
 * address query is an EQUALITY, so there is no lexical arm to have missed and no typo-tolerant guess to label.
 * `direction` is on the wire and is not assumed: the client asks the direction on screen, and a server that predates
 * the recipient index (mail 0154) is asked `from` instead ({@link OhmailEngine.searchAddressServer}), so this field,
 * not the request, labels what came back.
 */
export interface ServerAddressWire {
  items: EngineMessage[];
  /** Matches across the WHOLE corpus in the answered direction, which is more than `items.length`. */
  total: number;
  /** `false`: the server counted up to its cap, and `total` is a lower bound. Absent ⇒ exact. */
  totalExact?: false;
  /** Which side the server actually searched. Absent ⇒ `from`, all a server before the field served. */
  direction?: ServerAddressDirection;
  /** Present while the store has not taken in the whole mailbox: `total` is of the mail synced so far. */
  importing?: true;
}

/**
 * THE DIRECTIONS THE ARCHIVE'S VOCABULARY HAS — written out here rather than imported, for the
 * reason {@link SERVER_SEARCH_SORTS} gives one screen up: this package is the standalone desktop
 * payload and cannot import the hosted service.
 *
 * `SERVED` is the subset this client asks the server; all three since mail 0154. An older server
 * refuses `to`/`any` by name and is asked `from` instead, so the view still states the shortfall.
 */
export const SERVER_ADDRESS_DIRECTIONS = ["any", "from", "to"] as const;
export type ServerAddressDirection = (typeof SERVER_ADDRESS_DIRECTIONS)[number];
/** The directions `GET /search?address=` is asked. See {@link ServerAddressWire.direction}. */
export const SERVER_ADDRESS_DIRECTIONS_SERVED: readonly ServerAddressDirection[] = ["any", "from", "to"];

/** The refusal code of a server that cannot search the asked direction (one before mail 0154). */
const DIRECTION_UNSUPPORTED = "search_direction_unsupported";

/** What a caller may ask of one archive address pass. */
export interface ServerAddressOpts {
  limit?: number;
  /** Which side of the message; absent ⇒ `from`. */
  direction?: ServerAddressDirection;
}

/**
 * The transport {@link OhmailEngine.searchAddressServer} runs on. Optional everywhere, exactly
 * as {@link ServerSearchFn} is: the demo has no server and the desktop tier has no Cloud, and
 * both must read as "there is no archive here" rather than as broken.
 */
export type ServerAddressSearchFn = (
  address: string,
  opts: ServerAddressOpts,
) => Promise<ServerAddressWire | null>;

/**
 * The adapter capability this reaches for when no `serverSearch` was injected.
 *
 * Declared structurally HERE rather than as a member of `EngineAdapter` because the engine is
 * the only thing that calls it and the two adapters answer it differently in kind — the
 * FixturesAdapter has no server to ask and the HttpAdapter has one endpoint. An adapter
 * without the method is not broken; it is a client with no archive behind it, which
 * {@link OhmailEngine.serverSearchAvailable} reports and the UI states.
 */
interface ServerSearchCapableAdapter {
  searchServer?: ServerSearchFn;
}

/**
 * The address arm of the same capability, declared separately for the same structural reason —
 * and separately from `searchServer` because an adapter can have one and not the other: a
 * wrapper that forwards capabilities explicitly (`sync-scheduler.ts`'s read gate) forwards them
 * one at a time, and a build that predates this arm has the text search and not this.
 */
interface ServerAddressSearchCapableAdapter {
  searchAddressServer?: ServerAddressSearchFn;
}

/**
 * WHAT `GET /messages` ANSWERS for ONE view's page, as much of it as this client reads.
 *
 * The route returns `{ items, nextCursor }`, keyset-paged `date desc, id desc`. `items` are
 * canonical `MessageDTO`s, and an {@link EngineMessage} is exactly a `MessageDTO` plus optional
 * fixture extras — so a DTO IS one, with no conversion and no second shape (the same reasoning as
 * {@link ServerSearchWire}). `nextCursor` is the server's own opaque paging token: it is echoed
 * back untouched on the following call and is `null` on the last page.
 */
export interface ListOlderWire {
  items: EngineMessage[];
  nextCursor: string | null;
}

/**
 * The transport {@link OhmailEngine.listOlder} runs on. Optional everywhere, exactly as
 * {@link ServerSearchFn} is: a client whose whole mailbox is already on the device has nothing
 * behind the end of the list, and must be able to say so rather than spin.
 */
export type ListOlderFn = (
  view: OhmailView | "folder" | "all",
  opts: {
    cursor?: string;
    limit?: number;
    /**
     * One of the mailbox's own folders, by `folder` ENTITY id — required with `view: "folder"`
     * and meaningless otherwise (the folders foundation: a fresh web mirror is a window, and a
     * folder's older mail lives past it exactly as a pile's does). A transport that predates
     * the feature ignores it and resolves `null`, which reads as "nothing further back".
     */
    folderId?: string;
    /**
     * Start the FIRST page strictly below this (date, id) keyset position — the caller's mirror
     * boundary, so page one begins where the mirror ends instead of re-serving the newest rows
     * the mirror already renders. Ignored once a cursor exists (the cursor IS the position).
     */
    startBelow?: { date: string | null; id: string };
  },
) => Promise<ListOlderWire | null>;

/**
 * The adapter capability the out-of-window read reaches for. Declared STRUCTURALLY here, exactly as {@link
 * ServerSearchCapableAdapter} and {@link SnapshotCapableAdapter} are, and for the same reason: absence is a real
 * answer. A fixtures client has no server, and a client keeping the WHOLE mailbox has nothing older to fetch — both
 * must read as "there is nothing beyond this list", not as a broken adapter. It carries the same wiring risk the
 * other two do, and the risk has been paid for three times already: a wrapper that rebuilds the adapter surface as an
 * object literal drops a structural capability silently and still satisfies `EngineAdapter`.
 */

/**
 * `apps/webapp/app/shell/sync-scheduler.ts` has exactly such a wrapper, so it must spread this the way it spreads the
 * others: ...(adapter.listMessages ? { listMessages: adapter.listMessages.bind(adapter) } : {}) conditionally, never
 * unconditionally.
 */
interface ListMessagesCapableAdapter {
  listMessages?: ListOlderFn;
}

/** `GET /messages/timeline` — History's month rail and total. Structural, like the three above. */
interface TimelineCapableAdapter {
  timeline?: StoreTimelineFn;
}

/** `GET /messages/:id` — one message the store holds, `null` for one it does not. Structural too. */
export type MessageByIdFn = (messageId: string) => Promise<EngineMessage | null>;
interface MessageByIdCapableAdapter {
  getMessage?: MessageByIdFn;
}

/** {@link OhmailEngine.fetchMessage}'s answer. `missing`: the store holds no such message here. */
export type FetchMessageOutcome =
  | { state: "unavailable" }
  | { state: "ready"; message: EngineMessage }
  | { state: "missing" }
  | { state: "failed"; errorClass: string };

/** The batch body read, as {@link OhmailEngine.hydrateThread} calls it. */
export type FetchBodiesFn = (messageIds: string[], opts?: ReadIntent) => Promise<MessageBodyBatchWire[] | null>;

/**
 * ONE BODY'S READS IN THE AIR, beside its single-flight entry: what lets an open's own read go beside a
 * background read of the same body and the record still be written once ({@link OhmailEngine.hydrateBody}).
 */
interface BodyAsk {
  /** Its read is the person's (sent `{ urgent: true }`): an open's, a thread's on screen, a promoted one. */
  asked: boolean;
  /** Its read left the engine's queue: on the wire, or held where the engine cannot see it. */
  left: boolean;
  /** An open arrived before it left: it leaves as the person's, past the four slots. */
  urged: boolean;
  /** Reads of this body still running; the entry goes with the last. */
  reads: number;
  /** Answers still to come, one per read out: a failure waits for them, an omission is left to them. */
  pending: number;
  /** An answer was taken for the record (a body, or a failure no other read can still answer). */
  landed: boolean;
  /** A failure heard while another answer was still to come: written only if none brings the body. */
  failure: { err: unknown } | null;
  /** For an open that raced a background read: settles once the record is decided. */
  decided: { promise: Promise<void>; resolve: () => void } | null;
}

/**
 * The adapter capability a thread open reaches for.
 *
 * Declared STRUCTURALLY here for the same reason the three above it are, and carrying the same
 * wiring risk they do: `apps/webapp/app/shell/sync-scheduler.ts` rebuilds the adapter surface as
 * an object literal, and a literal that forgets a structural capability still satisfies
 * `EngineAdapter`. The failure would be invisible in the suite and live on the LIVE path only —
 * every real thread quietly back to N requests — so that wrapper must spread this the way it
 * spreads the others, conditionally and never unconditionally.
 */
interface FetchBodiesCapableAdapter {
  fetchBodies?: FetchBodiesFn;
}

/**
 * How many ids one batch body request may name.
 *
 * The server refuses more (400) rather than truncating, because a truncated answer is
 * indistinguishable from "those messages have no body". The engine therefore does the splitting
 * itself: a thread longer than this becomes two requests, not one refusal. Twenty is well past
 * any conversation a reader scrolls — the widest real thread measured here is nine — and it is the
 * count at which the byte budget rather than the id list is the binding constraint.
 */
export const BODIES_IDS_MAX = 20;

/**
 * WHAT PAGE 1 CARRIES BESIDES ITS OWN MESSAGES — the account-wide rows small enough to have no page of their own.
 *
 * This used to be a sentence, and the sentence went stale: it read "all live state" for a release after the server
 * had started paging children with their parents. `test/snapshot-page-1-definition.test.ts` derives the same set from
 * the producer and refuses a disagreement, so the definition cannot drift again without a red.
 *
 * `approval` is in the set and is NOT page-1-only: an approval whose message the window excludes has no page to ride
 * with, so it rides here. `draft` is NOT in the set: drafts are paged newest-first like messages.
 */
export const SNAPSHOT_PAGE_1_STATE_KINDS = [
  "rule", "approval", "tag", "folder", "settings", "mailbox_profile",
] as const;

/**
 * `GET /sync/snapshot` as the engine calls it — see {@link SyncSnapshotPage} for the protocol. `cursor` is the
 * server's own opaque paging token from the previous page, absent on the first. `limit` is a hint the engine does not
 * currently send. PAGE 1 IS NOT "ALL LIVE STATE": a message's children ride with the page carrying their parent and
 * DRAFTS ride the pages newest-first, so no page holds the whole of anything and a client-imposed limit would cut a
 * message away from its own children. Page 1 is the newest page of messages, the state belonging to them, and
 * {@link SNAPSHOT_PAGE_1_STATE_KINDS}. The drain follows `nextCursor` and nothing else: it stays non-null when drafts
 * outlive the window and its tail, and stopping early leaves them below the cursor adopted.
 */
export type SnapshotFn = (params: { cursor?: string; limit?: number; phase?: "tail" }) => Promise<SyncSnapshotPage>;

/**
 * The adapter capability the cold-start path reaches for. Declared STRUCTURALLY, exactly as {@link
 * ServerSearchCapableAdapter} is: absence is a real answer, not a broken adapter — the FixturesAdapter has no server
 * and a `?demo=1` tab must issue zero requests, and an older HttpAdapter simply has no `snapshot`, so the engine
 * falls back to `since=0`, which converges to the same mirror. The wiring risk this shape carries: an adapter WRAPPER
 * that rebuilds the surface as an object literal silently drops it and still satisfies `EngineAdapter` —
 * `sync-scheduler.ts`'s `guard` is exactly such a wrapper, and `fetchBody`, `searchServer` and the three attachment
 * methods each shipped unforwarded on the LIVE path for precisely this reason (the demo is unwrapped, so every test
 * stayed green).
 */

/**
 * A wrapper must spread it conditionally (`...(adapter.snapshot ? { snapshot: adapter.snapshot.bind(adapter) } :
 * {})`), never unconditionally — defining it always would make a gated fixtures adapter claim a snapshot endpoint it
 * has no server for.
 */
interface SnapshotCapableAdapter {
  snapshot?: SnapshotFn;
}

/**
 * HOW MUCH OF THE MAILBOX THIS CLIENT KEEPS ON DISK. `full` is the DEFAULT and the absent-config branch, and that
 * ordering is the whole safety property: the desktop tier's entire promise is that the mail is on the device, so a
 * host that forgets to configure this must get today's behaviour — nothing is ever evicted — rather than a quietly
 * truncated mailbox. A policy that pruned by omission would be a data-loss default. `windowed` is the browser's
 * answer, where the mirror is a cache in front of a Cloud that still holds everything: keep the newest `minRows`
 * messages unconditionally, plus anything within `days`, and drop the rest. Dropped rows are not lost — they are one
 * `/sync` change or one re-snapshot away, because {@link MirrorStore.prune} deletes rather than tombstones.
 */
/**
 * `maxRows` is the CEILING beside `minRows`'s floor, and it is what makes the window a function of
 * the POLICY rather than of the mailbox: without it `days` keeps everything recent, so a mailbox
 * whose mail is dense inside `days` sits almost entirely in a "windowed" mirror. Measured on the
 * rig's own large corpus: what falls inside ninety days is 2.7x the floor. Absent is today's
 * behaviour exactly — days and the floor, no ceiling — because an embedder that never set one must
 * not start evicting. It must be >= `minRows`, or the floor would be unreachable.
 */
export type StorePolicy =
  | { mode: "full" }
  | { mode: "windowed"; days: number; minRows: number; maxRows?: number };

/**
 * WHAT A HOST THAT CONFIGURES NOTHING GETS — and it is a WINDOW, not the mailbox.
 *
 * The absent branch was `full`, so a host that forgot kept everything. Both failures are silent
 * and only one is recoverable: a pruned row is one `/sync` change or one re-snapshot away
 * ({@link MirrorStore.prune} deletes rather than tombstones), while memory the app never gives
 * back is a machine somebody has to restart.
 */
/**
 * `{ mode: "full" }` still means what it meant — it is now SAID rather than inherited. The
 * numbers are the shipped windows' own (`apps/webapp/app/shell/store-windows.ts`), held equal by
 * the census beside them, so an unconfigured host is bounded the way a configured one is.
 */
export const DEFAULT_STORE_POLICY: StorePolicy =
  { mode: "windowed", days: 90, minRows: 5000, maxRows: 10000 };

/**
 * The two `/sync` entity types the pin set reads, narrowed to the ONE field each that decides whether the user still
 * owes it an answer. Declared here rather than in `types.ts` for the same reason {@link SnapshotCapableAdapter} is:
 * this is the only code in the package that looks at either type, and mirroring the server's whole
 * `RoutingDecisionDTO`/`ApprovalDTO` would be a second copy of a shape nothing else reads — which is a shape that can
 * drift without anything noticing. Every field is optional-safe: a status this build has never heard of is simply not
 * one of the pinning values, and the row is treated as resolved.
 */
interface PendingRoutingDecision {
  messageId?: string;
  status?: string;
}
interface PendingApproval {
  messageId?: string | null;
  status?: string;
}

/**
 * WHEN a message is, for windowing purposes — the mail's own date, falling back to the row's
 * `updatedAt`, and 0 for a row with neither; an open read later than that wins.
 *
 * 0 sorts oldest, which is the conservative direction ONLY because the `minRows` floor and the
 * pin set are both checked independently of this number: an undated row can be evicted for being
 * undated, but never one of the newest N and never one something still references.
 */
function messageTime(m: EngineMessage): number {
  const t = Date.parse(m.date ?? m.updatedAt ?? "");
  // An open read is as recent as when it was read: the row sits at the top of "Earlier", so the
  // window neither ages it out nor counts it old for the newest-N floor.
  const read = m.openReadAt == null ? Number.NaN : Date.parse(m.openReadAt);
  const at = Number.isFinite(t) ? t : 0;
  return Number.isFinite(read) ? Math.max(at, read) : at;
}

/**
 * ONE ORDER FOR BOTH HALVES OF THE BODY CACHE — `runEagerBodies` takes the newest by it,
 * {@link OhmailEngine.trimBodyCache} evicts the oldest by it. They must not merely both mean
 * "by date": two mails sharing a timestamp may be ordered arbitrarily, but a boundary row the
 * two ordered differently would be fetched by one and dropped by the other on every drain, so
 * the id breaks the tie and makes the pair a total order.
 */
function olderFirst(a: { id: string; t: number }, b: { id: string; t: number }): number {
  return a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * The outcome of one archive pass. It NEVER rejects — see {@link OhmailEngine.searchServer}.
 *
 * `unavailable` is a first-class answer and not an error: it is what the demo and the desktop
 * get, and the difference between "there is no archive behind this client" and "the archive
 * refused" is the difference between two true sentences the UI has to be able to tell apart.
 */
export type ServerSearchOutcome =
  | { state: "unavailable" }
  | {
    state: "ready"; items: EngineMessage[]; total: number; tier: SearchTier; totalExact: boolean; ms: number | null;
    nextCursor: string | null; bounded: boolean; indexed: { done: number; total: number } | null;
    facets: ServerSearchFacets | null;
    /** The store answered over part of the mailbox ({@link ServerSearchWire.importing}). */
    importing?: true;
    /** The answer is a paired desktop's mirror's, not the whole mailbox's ({@link ServerSearchWire.answeredFrom}). */
    fromMirror?: true;
  }
  /** `errorClass` is what a log line may carry ({@link errorClassOf}); `error` is the text. */
  | { state: "failed"; error: string; errorClass: string };

/**
 * THE ESTIMATE'S ANSWER (`parts: "estimate"`): the count and facets over the page's candidates,
 * no rows and no cursor, so it cannot be read as a page. `totalExact` means the candidates were
 * the whole match set; otherwise `totalEstimate` is about how many match (`null` when the store
 * did not say) and the exact count is the summary's.
 */
export type ServerEstimateOutcome =
  | { state: "unavailable" }
  | {
    state: "ready"; total: number; totalExact: boolean; totalEstimate: number | null; tier: SearchTier;
    ms: number | null; indexed: { done: number; total: number } | null; facets: ServerSearchFacets | null;
    importing?: true;
    fromMirror?: true;
  }
  | { state: "failed"; error: string; errorClass: string };

type ReadySearch = Extract<ServerSearchOutcome, { state: "ready" }>;

/** A page-shaped reading taken as the estimate; an estimate below the lower bound is the bound. */
function estimateFrom(r: ReadySearch, totalEstimate: unknown): Extract<ServerEstimateOutcome, { state: "ready" }> {
  const about = !r.totalExact && typeof totalEstimate === "number" && Number.isFinite(totalEstimate)
    ? Math.max(r.total, Math.round(totalEstimate)) : null;
  return {
    state: "ready", total: r.total, totalExact: r.totalExact, totalEstimate: about, tier: r.tier, ms: r.ms,
    indexed: r.indexed, facets: r.facets, ...(r.importing ? { importing: true as const } : {}),
    ...(r.fromMirror ? { fromMirror: true as const } : {}),
  };
}

/**
 * A failure's CLASS for a log line — its name, and a refusal's status and classified code —
 * never its message, which can carry what the person typed or what the server said about them.
 * A thrown non-Error is named by its type alone.
 */
/** The store's indexing progress, read defensively; `null` once it is done or when absent. */
function indexedOf(wire: unknown): { done: number; total: number } | null {
  if (typeof wire !== "object" || wire === null) return null;
  const { done, total } = wire as { done?: unknown; total?: unknown };
  if (typeof done !== "number" || typeof total !== "number" || total <= 0 || done >= total) return null;
  return { done: Math.max(0, done), total };
}

export function errorClassOf(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const { status, code } = err as { status?: unknown; code?: unknown };
  const parts = [err.name, typeof status === "number" ? String(status) : "", typeof code === "string" ? code : ""];
  return parts.filter((x) => x !== "").join(" ");
}

/**
 * THE ARCHIVE'S ANSWER ABOUT ONE ADDRESS. It never rejects — the outcome is a value the UI
 * renders, exactly as {@link ServerSearchOutcome} is.
 *
 * `ready` carries the direction the server ANSWERED, which the caller may not have asked for.
 * That is the whole reason this is not simply `ServerSearchOutcome` without the tier: a view
 * whose toggle says "All" or "To them" is handed the FROM half and has to say so
 * ("N in the archive, by sender"), and the field is what lets it. Inferring the direction from
 * the request would let a client claim the archive answered a question it did not.
 */
export type ServerAddressOutcome =
  | { state: "unavailable" }
  | { state: "ready"; items: EngineMessage[]; total: number; direction: ServerAddressDirection; importing?: true; totalExact?: false }
  /** `errorClass` is `errorClassOf`'s — which door refused, for the sentence and the wire's re-ask. */
  | { state: "failed"; error: string; errorClass: string };

/**
 * The outcome of one page of out-of-window mail. It NEVER rejects — see {@link OhmailEngine.listOlder}. Deliberately
 * shaped like {@link ServerSearchOutcome}, `unavailable` first-class and for the same reason: "this client holds the
 * whole mailbox, there is nothing further back" and "the server refused" are two true sentences, and a list that
 * renders them identically is lying about one of them. `ready` with an EMPTY `items` is a third: the server answered
 * and this view has nothing older. `nextCursor` is `null` on the last page, which is what lets a surface stop asking
 * rather than poll the end of the mailbox forever. `code` on a failure is the server's own error code, or `null` when
 * the failure never reached a server (a dead network, a bug in this client).
 */

/**
 * It is here because `error` is NOT uniformly showable text: some of what a server puts in an error message is
 * written for whoever reads a log, and some of it — the spend gate's explanation of what ran out — is written for the
 * person holding the mailbox. Only the code tells them apart, and a surface that guesses ends up printing an internal
 * vocabulary into somebody's mail.
 */
export type ListOlderOutcome =
  | { state: "unavailable" }
  | { state: "ready"; items: EngineMessage[]; nextCursor: string | null }
  | { state: "failed"; error: string; code: string | null };

/**
 * Whether the store holds mail this mirror does not ({@link OhmailEngine.storeCoverage}). `whole`:
 * nothing older exists to fetch. `partial`: `below` is where a reach-past page starts. `unknown`:
 * the store cannot say, and a list keeps offering. `unread`: not asked yet, or owed a re-ask.
 */
export type StoreCoverage =
  | { state: "unread" }
  | { state: "unknown" }
  | { state: "whole" }
  | { state: "partial"; below: StoreKeyset };

// the Trash read, and putting one message back: MAIL THIS ACCOUNT DELETED IN OHMAIL, which is off-mirror by
// construction. A delete tombstones the row (`apply.ts` rule 4, `entity: null`), so the mirror holds NOTHING for a
// deleted message on any door — there is no local list to filter, and this is not a projection over `reader`. It is
// `listOlder`'s shape one verb over: the server answers a page, the view holds it in its own state, and it is gone
// when the view changes. AND THE RESTORE IS NOT AN `EngineMutation`: the row it brings back is a TOMBSTONE here,
// which `mutate` refuses as a target (a held row whose effects are empty), and the route answers with where it went.
// So there is no optimistic overlay and no outbox entry here; the durable record of a pressed restore is the intents
// journal the surface keeps (`delete-intents.ts`), exactly as the delete's own held window does.

/**
 * `GET /messages?view=trash&cursor=&limit=` as this client reads it.
 *
 * The items are `MessageDTO`s with two additions the list renders — `trashedAt` and a
 * server-RESOLVED `restoreTo` — so an {@link EngineMessage} plus those two, with no conversion
 * and no second shape (the same reasoning as {@link ListOlderWire}). Both are optional at the
 * type level because a client can be newer than the server it talks to: a build that predates
 * them reads `undefined` and the view falls back to the message's own date and to the inbox,
 * which is what those two values MEAN when nothing said otherwise.
 */
export interface TrashRowWire extends EngineMessage {
  trashedAt?: string;
  restoreTo?: string;
}

export interface ListTrashWire {
  items: TrashRowWire[];
  nextCursor: string | null;
}

/**
 * The transport {@link OhmailEngine.listTrash} runs on. Optional everywhere, exactly as
 * {@link ListOlderFn} is: the demo is fixtures and zero network, and a surface with no server
 * behind it must be able to say "Trash is not available here" rather than spin.
 */
export type ListTrashFn = (opts: { cursor?: string; limit?: number }) => Promise<ListTrashWire | null>;

/**
 * `POST /messages/:id/restore` as this client calls it.
 *
 * `restoreTo` is the folder the server decided on — which may not be the row's own `restoreTo`
 * if the origin folder disappeared between the page and the press — so the toast names THIS
 * value, not the one the row was rendered with. `pending` is carried rather than assumed: true
 * when the restore is a filing the mail server has not performed yet, false when it cancelled a
 * delete the server never saw (the letter is back at once).
 */
export interface RestoreFromTrashWire {
  restoreTo: string;
  pending: boolean;
}

export type RestoreFromTrashFn = (
  messageId: string,
  /**
   * The `Idempotency-Key` for this ONE intent, when the caller has a durable record of it.
   *
   * The route is `idempotent`-marked: a replay under the same key is answered with the first
   * response, where without one it met the state check and answered 409 `not_in_trash` about a
   * restore the server had already committed to. Optional because a caller with no durable
   * record has no stable key to send, and an invented one would make two presses one.
   */
  opts?: { idempotencyKey?: string },
) => Promise<RestoreFromTrashWire | null>;

/**
 * The adapter capabilities the two reach for. Declared STRUCTURALLY here, exactly as {@link
 * ListMessagesCapableAdapter} and the three beside it are, and carrying the identical wiring risk:
 * `apps/webapp/app/shell/sync-scheduler.ts` rebuilds the adapter surface as an object literal, and a literal that
 * forgets a structural capability still satisfies `EngineAdapter` — the failure is invisible in the suite and live on
 * the LIVE path only. That wrapper must spread these the way it spreads the others, conditionally and never
 * unconditionally. TWO capabilities and not one, for `ListMessagesCapableAdapter`'s own reason: a wrapper forwards
 * them one at a time, so a client can legitimately have the list and not the verb, and deriving one from the other
 * would make a control call a method that is not there.
 */

/**
 * They are reported TOGETHER by {@link OhmailEngine.trashAvailable}, because a Trash view you cannot restore from is
 * not the feature.
 */
interface ListTrashCapableAdapter {
  listTrash?: ListTrashFn;
}
interface RestoreFromTrashCapableAdapter {
  restoreFromTrash?: RestoreFromTrashFn;
}

/**
 * What one Trash page answered — {@link ListOlderOutcome}'s three states, for the same reasons.
 *
 * `unavailable` is a real answer and never an error: the demo has no server, and a surface must
 * render "Trash is not available here" rather than an empty list that reads as "you have deleted
 * nothing". `failed` carries the server's code beside its text so a surface can tell a sentence
 * written for a person from one written for a log.
 */
export type ListTrashOutcome =
  | { state: "unavailable" }
  | { state: "ready"; items: TrashRowWire[]; nextCursor: string | null }
  | { state: "failed"; error: string; code: string | null };

/**
 * What one restore answered.
 *
 * `rolled_back` is the vocabulary the held-verb window already branches on for a delete
 * (`delete-undo.ts` reads `res.status === "rolled_back"` to put the row back and say so), so the
 * restore answers in the same words rather than in a second dialect the surface would have to
 * translate. A 409 `not_in_trash` — the message is no longer there, restored from another client
 * or filed by its owner — arrives as `rolled_back` with that code, because from the surface's
 * point of view it is exactly a press that did not take effect.
 */
export type RestoreOutcome =
  | { state: "unavailable" }
  | { state: "restored"; restoreTo: string; pending: boolean }
  | { state: "rolled_back"; error: string; code: string | null };

export {
  type BodyAsk, DIRECTION_UNSUPPORTED, estimateFrom, type FetchBodiesCapableAdapter, indexedOf,
  type ListMessagesCapableAdapter, type ListTrashCapableAdapter, type MessageByIdCapableAdapter, messageTime,
  olderFirst, type PendingApproval, type PendingRoutingDecision, type ReadySearch,
  type RestoreFromTrashCapableAdapter, type ServerAddressSearchCapableAdapter, type ServerSearchCapableAdapter,
  type SnapshotCapableAdapter, type TimelineCapableAdapter,
};
