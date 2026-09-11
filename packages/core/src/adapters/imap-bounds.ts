/**
 * Ceilings on what an arbitrary mail server may make this process do — the server-side twin of
 * the request-input bounds. The host is user-named and the worker is shared, so one unbounded
 * read is paid by every mailbox on the shard. The rule: bound the READ, not the RESULT — a cap
 * applied after the response is materialised is documentation. Three kinds: COUNT, SIZE, TIME
 * (the socket timeout is inactivity-based; only a wall clock stops a byte-a-minute server). A
 * breach throws {@link ImapBoundExceeded}, attributable by class to the mailbox. {@link
 * IMAP_READ_DEADLINE_MS} bounds the driver-materialised `list()`/`search()`; `fetch()` is bounded
 * at the read by {@link boundedCollect}. Abandonment retires the connection.
 */

/**
 * The closed set of bounds this module enforces. A code, not a sentence, because it is written
 * to logs and compared in tests — and because an operator answering "why did this mailbox
 * quarantine" needs the same string the guard used.
 */
export type ImapBoundKind =
  | "list_folders"
  | "enumerate_uids"
  | "search_uids"
  | "candidate_body_probes"
  | "flag_scan_rows"
  | "sample_rows"
  | "page_rows"
  | "body_overrun"
  | "read_bytes"
  | "read_deadline"
  | "cycle_deadline";

/**
 * Why the truncating ceilings are not in this union: {@link IMAP_FOLDER_PATH_MAX_CHARS} and
 * {@link IMAP_ENVELOPE_ADDRESSES_MAX} drop or truncate without ending the connection, so no
 * `ImapBoundExceeded` is constructed for them. {@link IMAP_FLAG_SCAN_MAX_ROWS} refuses now;
 * {@link IMAP_SAMPLE_MAX_ROWS} truncates its answer but abandons a running command, and a
 * retirement is reported — it needed its own code rather than borrowing `read_deadline`;
 * `page_rows` covers a server over-answering a bounded page. The census
 * (`imap-bounds-census.test.ts`) asserts every declared kind is raised somewhere. Residual: a
 * folder dropped for path length is not reported — at 1024 characters, a known gap.
 */

/**
 * A ceiling on a SERVER-chosen value was crossed. One class for the whole family so a consumer
 * can recognise the class without enumerating the codes, and so the worker's catch arm can treat
 * it as mailbox-attributable by class rather than by string match.
 */
export class ImapBoundExceeded extends Error {
  readonly code = "EIMAPBOUND";
  constructor(
    readonly bound: ImapBoundKind,
    readonly limit: number,
    readonly observed: number,
    readonly folder?: string,
  ) {
    super(
      `imap server exceeded the ${bound} ceiling: ${observed} past a limit of ${limit}` +
      (folder !== undefined ? ` (folder ${folder})` : ""),
    );
    this.name = "ImapBoundExceeded";
  }
}

/** Is this the bounds refusal? Duck-typed so a consumer need not import the class. */
export function isImapBoundExceeded(err: unknown): err is ImapBoundExceeded {
  return typeof err === "object" && err !== null
    && (err as { code?: unknown }).code === "EIMAPBOUND";
}

/**
 * An operator's override of a ceiling was not a number, so nothing booted.
 *
 * Its own class carrying the VARIABLE NAME, because a ceiling silently falling back to its
 * default on a typo is the failure this refusal exists to prevent: `Number("2 000")` is `NaN`,
 * and a `NaN` ceiling compares false against every count, which is an uncapped read wearing a
 * configured one's clothes. The value is never quoted — the name is what an operator needs.
 */
export class ImapBoundConfigError extends Error {
  readonly code = "EIMAPBOUNDCONFIG";
  constructor(readonly configVar: string, message: string) {
    super(message);
    this.name = "ImapBoundConfigError";
  }
}

/**
 * A ceiling's default, overridable by environment and REFUSED BY NAME when the override is not a
 * positive integer. Read at module load, so a typo stops the process at boot rather than
 * uncapping a read at the first hostile mailbox.
 */
export function boundFromEnv(
  key: string, fallback: number, env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ImapBoundConfigError(key, `${key} must be a positive integer`);
  }
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// COUNT CEILINGS
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Folders one LIST response may name. The passive-folder ceilings ({@link
 * DEFAULT_PASSIVE_FOLDERS_MAX} = 256) bound how many folders are SCANNED, not how many are
 * RECEIVED: every listed folder was canonicalised, filtered, pushed, sorted and retained before
 * the 256 was consulted, so a mailbox reporting 10^6 folders cost ~10^6 strings and an O(n log n)
 * sort per LIST. 10 000 is two orders of magnitude above the largest real mailbox measured (~137
 * folders) and far below the worker's memory budget — it catches a runaway, not an unusual filer.
 */
export const IMAP_LIST_MAX_FOLDERS = 10_000;

/**
 * Characters in one folder path from the server. Paths are split, joined, regex-tested and used
 * as Map keys every cycle, and a folder name has no protocol ceiling of its own. 1024 is well
 * past any real hierarchy and stops one absurd entry from becoming a per-cycle cost. The
 * over-long entry is DROPPED, not fatal — see {@link boundListResponse}: refusing the whole LIST
 * over one unnameable folder would take the other 136 down with it.
 */
export const IMAP_FOLDER_PATH_MAX_CHARS = 1024;

/**
 * UIDs one folder enumeration may collect. `enumerateUids` pushed every UID in the folder into an
 * array — then a `Set` and a `.filter` made two more copies — before the batch budget ({@link
 * DEFAULT_SYNC_BATCH_MAX_MESSAGES} = 200) was consulted; that budget bounds bodies fetched, not
 * the enumeration feeding it. A server claiming 10^8 messages spends ~10^8 numbers across three
 * containers before one fetch. 500 000 is chosen against the container: a few tens of MB at three
 * retained copies, the same order as {@link DEFAULT_SYNC_BATCH_MAX_BYTES}; real mailboxes sit
 * four to five orders below. Failing loudly beats a silent SIGKILL of the shard.
 */
export const IMAP_ENUM_MAX_UIDS = 500_000;

/**
 * UIDs one SEARCH result may carry. `searchFolderPage` sorted the server's entire match set to
 * take the newest 50, and `destinationLook` issues a full-body fetch per candidate — O(n log n)
 * in a server-picked number, and that number times message bytes. 50 000 is far above any honest
 * answer a 50-item page is taken from, and far below a response that hurts.
 */
export const IMAP_SEARCH_MAX_UIDS = 50_000;

/**
 * Message bodies the move's destination pre-check may download to disambiguate candidates.
 * `destinationLook` fetches `source: true` once per candidate from a Message-ID SEARCH; the
 * honest candidate count is 0 or 1, a few when a message was copied about. A server answering
 * with 10 000 UIDs turns one move into 10 000 full-body downloads — the worst count-to-bytes
 * multiplier in the adapter. Past 32 the move REFUSES rather than adopting: with that many
 * identically identified candidates the pre-check cannot establish which message it is looking
 * at, and guessing lands a move on the wrong one.
 */
export const IMAP_CANDIDATE_BODY_PROBES_MAX = 32;

/**
 * Rows the flag drain may examine in one folder, in one pass. The drain's budget counts flag
 * CHANGES, and the two common dispositions — unknown UID, agrees-with-baseline — spend none of
 * it; iCloud's inert `CHANGEDSINCE` answers with every message in the folder, so the budget never
 * engages. The first version truncated and resumed — sound about state, wrong about the read:
 * breaking out of an ImapFlow generator does not cancel the FETCH, the queue stays owned by a
 * read nobody consumes, the next SELECT queues behind it. So this REFUSES and retires the
 * connection; the drain's ordinary per-folder truncation is untouched. 100 000 is well above a
 * legitimate scan, far below a stream that costs the shared process anything.
 */
export const IMAP_FLAG_SCAN_MAX_ROWS = 100_000;

/**
 * Rows a sample scan may examine — `sampleSenders` and `scanSentRecipients`. Both ask for an
 * open-ended range and stop at `limit` DISTINCT addresses, so a server answering with a million
 * rows of one address (or none) never satisfies the exit condition. These TRUNCATE rather than
 * refuse: a smaller sample is not a wrong answer. 10 000 is two orders of magnitude above the
 * honest row count (`limit` defaults to 50 and 500).
 */
export const IMAP_SAMPLE_MAX_ROWS = 10_000;

/**
 * Addresses read out of one message's envelope. The samplers bound their OUTPUT and iterate
 * `[...to, ...cc, ...bcc]` per message to produce it — a spread that materialises the whole
 * recipient list first, so a 4 000-address To: header is parsed and spread regardless of the
 * result cap. 1 000 is above any deliverable recipient list (providers cap RCPT far lower) and
 * caps per-message work at a constant. Over-long lists are TRUNCATED, not fatal: the excess is a
 * sender's padding, and the scan's answer is a sample by construction.
 */
export const IMAP_ENVELOPE_ADDRESSES_MAX = 1_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SIZE CEILINGS
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How far past its own declared `RFC822.SIZE` a body stream may run, as a multiplier. The batch
 * byte budget trusts a server-chosen number: `fetchCapped` refuses anything over {@link
 * MAX_RAW_MESSAGE_BYTES} and accumulates declared sizes against {@link
 * DEFAULT_SYNC_BATCH_MAX_BYTES}, but the body fetch itself had no byte accounting — a server
 * declaring `RFC822.SIZE 1` and streaming ten gigabytes satisfied every ceiling on paper. A
 * multiplier because the honest discrepancy is small and structural (line-ending normalisation
 * moves it a few percent); 1.5x is far outside that. The floor beside it exists because the
 * multiplier is useless against a declared size of 0 or 1.
 */
export const IMAP_BODY_OVERRUN_FACTOR = 1.5;

/**
 * The absolute slack under {@link IMAP_BODY_OVERRUN_FACTOR}, in bytes, for messages whose
 * declared size is small or absent. Without it `1.5 × 0` is `0` and every message with an
 * unreported size would refuse; with it, a stream is refused once it passes BOTH the multiplier
 * and this floor. 1 MiB is small against the 32 MiB batch budget and large against any honest
 * mis-declaration.
 */
export const IMAP_BODY_OVERRUN_FLOOR_BYTES = 1024 * 1024;

/** The byte ceiling a stream whose declared size is `declared` may not cross. */
export function bodyOverrunCeiling(declared: number | undefined): number {
  const base = typeof declared === "number" && Number.isFinite(declared) && declared > 0
    ? declared
    : 0;
  return Math.max(Math.ceil(base * IMAP_BODY_OVERRUN_FACTOR), IMAP_BODY_OVERRUN_FLOOR_BYTES);
}

/**
 * Bytes one read of `ohmail/_meta` may accept across the whole window. The count ceiling bounds
 * how MANY records come back, not how large one is: the fold keeps each record's raw headers, and
 * one server-sized header block satisfies a count ceiling of 500 on its own — whoever can append
 * to the folder picks which axis to spend. 8 MiB is roughly four times the largest honest window
 * (a handful of records with a 4 KiB payload ceiling) and far below the shared worker's memory
 * budget.
 */
export const IMAP_META_BYTES_MAX = boundFromEnv("TF_IMAP_META_MAX_BYTES", 8 * 1024 * 1024);

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TIME CEILINGS — the slow-loris arm
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Wall-clock ceiling on one adapter read. Nothing else in the stack bounds this:
 * `WORKER_NET_TIMEOUTS.socketMs` is 120 s of INACTIVITY, reset on every byte, so a server
 * dribbling one byte a minute holds the connection, the mailbox lock and the shared slot for ever
 * while never being idle. No count ceiling sees it either — it is not sending too much, just too
 * slowly. 180 s is comfortably above any legitimate metadata read and below the 15-minute
 * `sync_lag` alert, so a glacial provider fails inside the window an operator finds out in.
 */
export const IMAP_READ_DEADLINE_MS = 180_000;

/**
 * Wall-clock ceiling on ONE read of `ohmail/_meta` — the lease fold and the settings documents
 * alike, because it is one folder and one legitimate population.
 *
 * That folder had no clock at all, and it is the read a stalling server profits most from: it
 * runs on every cycle, it holds the folder's lock, and both a peek and an authenticated API door
 * reach it. 60 s is far above any honest read of a handful of small records and well inside the
 * general per-read ceiling, which it composes with rather than replaces.
 */
export const IMAP_META_DEADLINE_MS = boundFromEnv("TF_IMAP_META_DEADLINE_MS", 60_000);

/**
 * Wall-clock ceiling on one whole `changesSince` pass. {@link IMAP_READ_DEADLINE_MS} bounds one
 * read, and a hostile server need not be slow only once: six watched folders plus a Sent scan,
 * each just under the per-read ceiling, is a twenty-minute cycle — past the `sync_lag` alert,
 * holding a connection and a slot throughout. 300 s is above the slowest legitimate first-sync
 * pass measured and below the alert. Placed at the adapter rather than the worker's scheduler
 * because `changesSince` is where the pass begins and ends — enforceable with a clock and a
 * check, where the scheduler would need rebuilding.
 */
export const IMAP_CYCLE_DEADLINE_MS = 300_000;

/**
 * A wall clock with a bound's name on it. Constructed at the start of a read (or a pass) and
 * consulted at every point where the server could have stalled.
 */
export class ImapDeadline {
  private constructor(
    private readonly endsAtMs: number,
    private readonly bound: ImapBoundKind,
    private readonly budgetMs: number,
    private readonly now: () => number,
  ) {}

  /** A deadline `ms` from now. `now` is injectable so tests drive the clock rather than sleep. */
  static in(ms: number, bound: ImapBoundKind, now: () => number = Date.now): ImapDeadline {
    return new ImapDeadline(now() + ms, bound, ms, now);
  }

  /** Milliseconds left; negative once passed. */
  remainingMs(): number { return this.endsAtMs - this.now(); }

  /** Throw if the clock has run out. Cheap enough to call inside a stream loop. */
  check(folder?: string): void {
    const remaining = this.remainingMs();
    if (remaining < 0) {
      throw new ImapBoundExceeded(this.bound, this.budgetMs, this.budgetMs - remaining, folder);
    }
  }

  /**
   * The EARLIER of two deadlines — how a per-read ceiling is composed with the pass's budget so
   * a read inside a cycle can never outlive the cycle. Returns a deadline reporting the bound of
   * whichever clock is tighter, so the refusal names the ceiling that actually fired.
   */
  static soonest(a: ImapDeadline, b: ImapDeadline | undefined): ImapDeadline {
    if (b === undefined) return a;
    return b.endsAtMs < a.endsAtMs ? b : a;
  }

  /**
   * Race a promise-shaped command against this clock. This abandons a command the driver is still
   * running, so the connection is left poisoned — the same trade `fetchPart` documents,
   * affordable because the caller closes the connection on the way out. There is no way to bound
   * `ImapFlow.list()` or `.search()` from here without this shape; they return an
   * already-materialised array. The timer is always cleared, success path included — a dangling
   * 180 s timer per read would keep the process alive past its work.
   */
  async race<T>(
    op: Promise<T>, folder?: string,
    onAbandon?: (because: ImapBoundExceeded) => void,
  ): Promise<T> {
    const remaining = this.remainingMs();
    if (remaining < 0) {
      // Build the refusal FIRST so the retirement carries the same one the caller will see.
      const because = new ImapBoundExceeded(
        this.bound, this.budgetMs, this.budgetMs - remaining, folder,
      );
      onAbandon?.(because);
      throw because;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        op,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              // Abandoning a command is not ending it: the rejection unblocks this caller and
              // does nothing to `op` — ImapFlow's queue still belongs to it and the server may
              // still be filling it. The caller does not always close the connection (the worker
              // retains an adapter across generic failures), so a later cycle could reuse a
              // connection whose queue is owned by a command nobody reads. The connection is
              // therefore retired HERE, by the code that decided to stop reading. A deadline
              // breach means this connection is finished.
              const because = new ImapBoundExceeded(
                this.bound, this.budgetMs, this.budgetMs, folder,
              );
              onAbandon?.(because);
              reject(because);
            },
            remaining,
          );
          // Never hold the event loop open on account of a deadline.
          (timer as unknown as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE BOUNDED READS
// ─────────────────────────────────────────────────────────────────────────────────────────────

interface BoundedFetchBase<T, R> {
  /** Messages this read may take. */
  max: number;
  /**
   * The byte arm, for a read whose items carry a payload the SERVER sizes. Omitted where an item
   * is a fixed-width value the server cannot inflate (a UID), which is the only honest reason to
   * leave an axis unbounded: there is nothing on it to bound.
   */
  bytes?: { max: number; of: (item: T) => number };
  /** The wall clock, composed by the caller with any outer budget. */
  deadline?: ImapDeadline;
  folder?: string;
  /**
   * Retire the connection — the stream is being abandoned mid-command. `because` is the breach
   * the caller is about to see or, for a truncating stop that raises nothing, the same object
   * describing the ceiling that fired; always supplied, because a retirement is reported and a
   * report naming the wrong condition is worse than none. `notify` is TRUE when this function
   * will not throw, so the connection's owner must be told directly; FALSE when it is about to
   * throw — the throw is the report, and a second synthetic one would reset the caller's failure
   * accounting.
   */
  onAbandon?: (notify: boolean, because: ImapBoundExceeded) => void;
  map: (item: T) => R;
}

/**
 * What a ceiling DOES, and whether the breach therefore has a NAME.
 *
 * `throw` refuses and `stop` keeps a smaller sample; both abandon a running command and report
 * the ceiling, so both need a {@link ImapBoundKind}. `evict` reads the range to its end and keeps
 * the NEWEST items that fit — for a folder whose live records are appended last, where stopping
 * early would keep exactly the wrong half — so it abandons nothing, raises nothing, and has no
 * bound to name; it reports `evicted` instead, which its callers turn into their own UNKNOWN.
 */
export type BoundedFetchOptions<T, R> = BoundedFetchBase<T, R> & (
  | { onOverflow?: "throw" | "stop"; bound: ImapBoundKind }
  | { onOverflow: "evict" }
);

export interface BoundedFetchResult<R> {
  items: R[];
  /** A ceiling fired under `evict` and older items were dropped — the caller's UNKNOWN. */
  evicted: boolean;
  /**
   * WHICH ceiling evicted, so the refusal a caller builds from it names the one that fired.
   * A report naming the wrong condition is worse than no report: it sends whoever reads it to
   * the wrong place. The FIRST reason wins, because it is the one the window actually crossed.
   */
  evictedBy: "count" | "bytes" | null;
  /** Bytes retained, where the caller measures them; `0` with no byte arm. */
  bytes: number;
}

/**
 * Consume at most `max` items from a server-driven async iterable, checking the clock as it goes
 * — the one helper that bounds the READ: an iterable is pulled, so declining to pull is declining
 * to receive. `onOverflow: "throw"` is the default where completeness is load-bearing (an
 * enumeration stopping early would read as an expunge); `"stop"` is for genuine samples. Each
 * `next()` is raced, not the gap between pulls: a `for await` suspends inside the iterator, so a
 * server that starts a row and never finishes it parks the loop where the clock is never
 * consulted. `onAbandon` retires the connection whenever this stops consuming — breaking out of
 * an ImapFlow generator does not cancel the FETCH.
 */
/**
 * THE ONE BOUNDED READ: count, bytes and wall clock on a server-driven stream.
 *
 * Both axes take the SAME disposition, because whoever can fill the folder chooses which one to
 * spend and a read that refuses on one while truncating on the other answers two different
 * questions about one window.
 */
export async function boundedFetch<T, R>(
  src: AsyncIterable<T>, opts: BoundedFetchOptions<T, R>,
): Promise<BoundedFetchResult<R>> {
  const items: R[] = [];
  const costs: number[] = [];
  const evict = opts.onOverflow === "evict";
  const stop = opts.onOverflow === "stop";
  // `undefined` exactly when nothing can be raised, so the throwing arms below are unreachable
  // without a name rather than reachable with a wrong one.
  const countBound = evict ? undefined : opts.bound;
  const it = src[Symbol.asyncIterator]();
  let seen = 0;
  let bytes = 0;
  let evicted = false;
  let evictedBy: "count" | "bytes" | null = null;
  for (;;) {
    const step = opts.deadline === undefined
      ? await it.next()
      : await opts.deadline.race(
        it.next(), opts.folder, (because) => opts.onAbandon?.(false, because),
      );
    if (step.done === true) break;
    seen++;
    if (seen > opts.max && countBound !== undefined) {
      // Thrown BEFORE the item is mapped or pushed: the ceiling is the size of the container,
      // not one past it.
      const because = new ImapBoundExceeded(countBound, opts.max, seen, opts.folder);
      // `stop` returns a value; `throw` does not. That is exactly the distinction.
      opts.onAbandon?.(stop, because);
      if (stop) break;
      throw because;
    }
    const cost = opts.bytes === undefined ? 0 : opts.bytes.of(step.value);
    if (opts.bytes !== undefined && bytes + cost > opts.bytes.max && !evict) {
      const because = new ImapBoundExceeded(
        "read_bytes", opts.bytes.max, bytes + cost, opts.folder,
      );
      opts.onAbandon?.(stop, because);
      if (stop) break;
      throw because;
    }
    items.push(opts.map(step.value));
    costs.push(cost);
    bytes += cost;
    // A single item larger than the whole byte ceiling is evicted too: it cannot be kept, and
    // saying so is what `evicted` is for.
    while (evict && items.length > 0
      && (items.length > opts.max || (opts.bytes !== undefined && bytes > opts.bytes.max))) {
      evictedBy = evictedBy ?? (items.length > opts.max ? "count" : "bytes");
      items.shift();
      bytes -= costs.shift() ?? 0;
      evicted = true;
    }
  }
  return { items, evicted, evictedBy, bytes };
}

/** {@link boundedFetch} for a read with nothing on its byte axis — the adapter's UID streams. */
export async function boundedCollect<T, R>(
  src: AsyncIterable<T>,
  opts: Omit<BoundedFetchBase<T, R>, "bytes">
    & { bound: ImapBoundKind; onOverflow?: "throw" | "stop" },
): Promise<R[]> {
  return (await boundedFetch(src, opts)).items;
}

/**
 * The smallest element, or `empty` for an empty array — without a spread. `Math.min(...xs)`
 * passes one argument per element and throws `RangeError: Maximum call stack size exceeded`
 * around 125 000 of them, comfortably below {@link IMAP_ENUM_MAX_UIDS} — a server could
 * over-answer inside the enumeration ceiling and still crash the pass. A helper rather than an
 * inline loop so the next spread over a server-sized array has somewhere obvious to go.
 */
export function minOf(xs: readonly number[], empty: number): number {
  if (xs.length === 0) return empty;
  let m = xs[0]!;
  for (let i = 1; i < xs.length; i++) if (xs[i]! < m) m = xs[i]!;
  return m;
}

/** One entry of a LIST response, narrowed to what the bound reads. */
export interface ListLike { path: string }

/**
 * Refuse an over-long LIST and drop unusably-named entries, BEFORE anything downstream
 * canonicalises, sorts or retains it.
 *
 * Two different dispositions on purpose, and the asymmetry is the point:
 *  · too MANY folders is a mailbox-level fault — the whole response is refused, because a scan
 *    over an arbitrary prefix of it would be a silently partial view of the customer's mail;
 *  · one unusably-named folder is dropped and the rest proceed, because refusing 10 000 good
 *    folders over one bad name is a worse answer than not scanning the bad one.
 */
export function boundListResponse<T extends ListLike>(list: readonly T[]): T[] {
  if (list.length > IMAP_LIST_MAX_FOLDERS) {
    throw new ImapBoundExceeded("list_folders", IMAP_LIST_MAX_FOLDERS, list.length);
  }
  const out: T[] = [];
  for (const entry of list) {
    if (typeof entry.path !== "string") continue;
    if (entry.path.length > IMAP_FOLDER_PATH_MAX_CHARS) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Refuse an over-large SEARCH result BEFORE it is copied, sorted or iterated.
 *
 * imapflow answers a refused SEARCH with `false` rather than rejecting (its declared return is
 * `number[] | false`), which callers must not read as "no matches" — that check stays at the call
 * sites that need to distinguish the two; this function's job is only the ceiling, so a non-array
 * is passed straight back for the caller to handle as it already does.
 */
export function boundSearchResult(found: number[] | false): number[] | false {
  if (!Array.isArray(found)) return found;
  if (found.length > IMAP_SEARCH_MAX_UIDS) {
    throw new ImapBoundExceeded("search_uids", IMAP_SEARCH_MAX_UIDS, found.length);
  }
  return found;
}

/**
 * Truncate one envelope's address list. A sample's inputs may be trimmed without making the
 * sample wrong — see {@link IMAP_ENVELOPE_ADDRESSES_MAX}.
 */
export function boundEnvelopeAddresses<T>(addresses: readonly T[]): readonly T[] {
  return addresses.length > IMAP_ENVELOPE_ADDRESSES_MAX
    ? addresses.slice(0, IMAP_ENVELOPE_ADDRESSES_MAX)
    : addresses;
}
