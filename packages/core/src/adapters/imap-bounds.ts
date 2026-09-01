/**
 * ═══ CEILINGS ON WHAT AN ARBITRARY MAIL SERVER MAY MAKE THIS PROCESS DO ═════════════════════
 *
 * The sibling rule for CALLER-chosen values — bounds on request input — closed the
 * class where a value **the caller chooses** reaches a query, a loop or a buffer before any
 * ceiling. This file is the same law aimed the other way: at values **the SERVER chooses**.
 *
 * ## Why the server is in the threat model by design, not by assumption
 *
 * The user names their own IMAP host. We do not run it, we do not vet it, and a mailbox does not
 * have to be malicious to be ruinous — a provider with a runaway folder table, a broken SEARCH,
 * or a link that has degraded to a byte a minute produces the same shapes an attacker would.
 * **And the worker is SHARED**: one connection's unbounded read is paid out of a process that
 * every other mailbox on the shard is also using. That is what separates this row from its
 * siblings — the blast radius is other people's mail, not the offending mailbox's.
 *
 * ## The one rule, and the one way it was being broken
 *
 * > **Bound the READ, not the RESULT.**
 *
 * Every instance in the row had a cap. Every cap was applied *after* the thing it was capping had
 * already been materialised, copied, sorted and retained. `searchFolderPage` is the clearest:
 * its docblock promised "never a fetch proportional to the match count", which was true of the
 * FETCH and false of the `[...found].sort()` one line above it. A cap downstream of the
 * allocation is documentation, not a bound.
 *
 * ## Three kinds of ceiling, because there are three kinds of unboundedness
 *
 *  1. **COUNT** — how many things the server may hand us (folders, UIDs, search hits).
 *  2. **SIZE** — how large one of those things may be (a folder path, a body past its own
 *     declared `RFC822.SIZE`).
 *  3. **TIME** — how long the server may take. This one is not optional and is not covered by
 *     any of the socket settings: {@link NetTimeouts.socketMs} is Node's INACTIVITY timer, so a
 *     server that emits one byte a minute resets it for ever and waits without bound. A count
 *     ceiling does not help either — the slow server is not sending too much, it is sending too
 *     slowly. Only a wall clock closes it.
 *
 * ## What a breach does, and why that is the whole isolation story
 *
 * It throws {@link ImapBoundExceeded}, and **the isolation is inherited rather than built here.**
 * The worker already attributes a throw out of `runSyncCycle` to the mailbox it came from: the
 * folder cursor is held, the cycle fails, the connection is closed and that mailbox accumulates
 * toward its ordinary quarantine cadence while every other mailbox on the shard proceeds
 * untouched (`apps/worker/src/index.ts`, the per-mailbox catch arm; `sync.ts`'s deferred-folder
 * rule). Crucially this error is **attributable BY CLASS to the mailbox** — it is not one of the
 * shared-service exemptions (`LeaderFencedError`, `LeaseUnavailableError`, a database fault)
 * that are rethrown so a shard-wide outage is not blamed on individual mailboxes. A server that
 * hands back a million folders IS this mailbox's problem, and saying so is correct.
 *
 * So the smallest true fix is a ceiling that FIRES, not a new scheduler. A per-mailbox time
 * budget in the worker's cycle loop was considered and deliberately not built:
 * {@link IMAP_CYCLE_DEADLINE_MS} is the same guarantee at the seam that already has the facts,
 * and rebuilding the scheduler to obtain it would be a much larger change for the same property.
 *
 * ## The residual, stated rather than discovered later
 *
 * `ImapFlow.list()` and `ImapFlow.search()` return ARRAYS. The driver materialises the whole
 * response inside itself before this code is given anything to look at, so for those two the
 * count ceilings here are — unavoidably, at this seam — applied to the driver's buffer rather
 * than to the socket. **{@link IMAP_READ_DEADLINE_MS} is what actually bounds them**, because a
 * response large enough to matter also takes time to deliver; the count ceiling's remaining job
 * is to stop US from copying, sorting and RETAINING that buffer, which is where the multiplier
 * was. Everything reached through `ImapFlow.fetch()` is an async iterable and IS bounded at the
 * read: {@link boundedCollect} stops consuming, so the array never grows past the ceiling.
 *
 * A deadline breach on a promise-shaped call abandons a command the driver is still running, so
 * the connection is poisoned — the same trade `fetchPart` documents for its stream abandonment,
 * and the caller closes the connection on the way out for the same reason.
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
  | "body_overrun"
  | "read_deadline"
  | "cycle_deadline";

/*
 * ── WHY THE TRUNCATING CEILINGS ARE NOT IN THAT UNION ──────────────────────────────────────
 *
 * {@link IMAP_FOLDER_PATH_MAX_CHARS}, {@link IMAP_ENVELOPE_ADDRESSES_MAX},
 * {@link IMAP_FLAG_SCAN_MAX_ROWS} and {@link IMAP_SAMPLE_MAX_ROWS} are real ceilings that DROP or
 * TRUNCATE rather than refuse, so no `ImapBoundExceeded` is ever constructed for them and they
 * have no code here.
 *
 * They were in this union first, and the census next door
 * (`imap-bounds-census.test.ts`) failed on them: it asserts that every declared kind is actually
 * raised somewhere, and these could not be. That is the repository's own named hazard — a
 * type-level guard that silently does not guard — and a code an operator can grep for but never
 * see in a log is a small version of it. Removed rather than explained away.
 *
 * **The residual, stated:** a folder whose path is dropped for length is one folder the customer
 * does not get scanned, and nothing reports it (`passiveFolderReport().excluded` covers folders
 * the passive RULE declined, not ones dropped before it ran). At 1024 characters this is far past
 * any real folder name, so it is recorded as a known gap rather than given a reporting channel.
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// COUNT CEILINGS
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Folders one LIST response may name.
 *
 * The passive-folder ceilings ({@link DEFAULT_PASSIVE_FOLDERS_MAX} = 256) bound how many folders
 * are SCANNED, and they were doing that correctly. They do not bound how many are RECEIVED: every
 * listed folder was canonicalised into a fresh string, run through the exclusion rule, pushed to
 * an array, sorted, and both halves of the split retained on the adapter — all of it before the
 * 256 was consulted. A mailbox reporting 10^6 folders therefore cost ~10^6 strings and an
 * O(n log n) sort per LIST, and `foldersToScan` re-LISTs every cycle on a LIST-STATUS server.
 *
 * 10 000 is two orders of magnitude above the largest real mailbox measured here (~137 folders,
 * and 256 is already the scan ceiling), and far below the point where retaining the response
 * registers against the worker's memory budget. It exists to catch a runaway, not to second-guess
 * an unusual filer.
 */
export const IMAP_LIST_MAX_FOLDERS = 10_000;

/**
 * Characters in one folder path from the server.
 *
 * Paths are split, joined, regex-tested and used as Map keys on every cycle, and a folder name is
 * a value the server chooses with no protocol ceiling of its own. 1024 is well past any real
 * hierarchy (RFC 3501 sets no limit, but a path is a mailbox NAME; providers cap far lower) and
 * stops one absurd entry from becoming a per-cycle cost.
 *
 * The over-long entry is DROPPED, not fatal — see {@link boundListResponse}. A folder we cannot
 * sanely name is one folder the customer does not get scanned; refusing the whole LIST over it
 * would take the other 136 folders down with it, which is a worse answer to a stranger problem.
 */
export const IMAP_FOLDER_PATH_MAX_CHARS = 1024;

/**
 * UIDs one folder enumeration may collect.
 *
 * `enumerateUids` walked `1:*` and pushed every UID in the folder into an array — then
 * `new Set(...)` and a `.filter(...)` made two more copies of it — all BEFORE the batch budget
 * ({@link DEFAULT_SYNC_BATCH_MAX_MESSAGES} = 200) was consulted. The budget bounds the bodies
 * fetched, which is what the OOM outage was about, and it says nothing at all about the
 * enumeration that feeds it. A server claiming 10^8 messages in a folder spends ~10^8 numbers
 * across three containers before one message is fetched.
 *
 * 500 000 is chosen against the container rather than against a mailbox: at three retained
 * copies of a JS number set that is a few tens of MB — survivable, and inside the same order of
 * magnitude as {@link DEFAULT_SYNC_BATCH_MAX_BYTES}. Real mailboxes here are four to five orders
 * below it. A folder genuinely past it cannot be drained by this design anyway, and failing that
 * mailbox's cycle loudly is a better answer than a silent SIGKILL of the shard — which is the
 * outage this number exists because of.
 */
export const IMAP_ENUM_MAX_UIDS = 500_000;

/**
 * UIDs one SEARCH result may carry.
 *
 * `searchFolderPage` sorted the server's ENTIRE match set to take the newest 50 of it, and
 * `destinationLook` iterates its whole candidate set issuing a **full-body fetch per element**.
 * The first is O(n log n) in a number the server picks; the second is that number multiplied by
 * message bytes, which is the more expensive of the two by a wide margin.
 *
 * 50 000 is far above any honest answer to "messages in this folder matching this word" that a
 * 50-item page is about to be taken from, and far below a response that hurts.
 */
export const IMAP_SEARCH_MAX_UIDS = 50_000;

/**
 * Message bodies the move's destination pre-check may download to disambiguate candidates.
 *
 * `destinationLook` fetches `source: true` **once per candidate** returned by a Message-ID
 * SEARCH, comparing fingerprints. Message-IDs are supposed to be unique, so the honest candidate
 * count is 0 or 1; 2 or 3 happens when a message was copied about. A server answering that SEARCH
 * with 10 000 UIDs turns one move into 10 000 full body downloads on the worker's shared
 * connection — the single worst count-to-bytes multiplier in the adapter.
 *
 * 32 is generous for the real cases and small enough that the worst case is bounded work rather
 * than an outage. Past it the move REFUSES rather than adopting: with more than 32 identically
 * identified candidates the pre-check cannot establish which message it is looking at, and
 * guessing is how a move lands on the wrong one.
 */
export const IMAP_CANDIDATE_BODY_PROBES_MAX = 32;

/**
 * Rows the FLAG DRAIN may examine in one folder, in one pass.
 *
 * The drain's existing budget (`DEFAULT_SYNC_BATCH_MAX_FLAGS` and the per-folder share derived
 * from it) counts flag CHANGES, and the two dispositions that are not changes — an unknown UID,
 * and a row that agrees with the baseline — `continue` without spending any of it. Both are the
 * COMMON case: iCloud's `CHANGEDSINCE` is inert and answers with every message in the folder, so
 * on that provider a drain streams the whole folder and the budget never engages at all. A
 * ceiling on changes is not a ceiling on rows.
 *
 * **This one DEGRADES rather than refusing**, and it is the one place in this module where that
 * is the better answer: the drain already has resume machinery (`FlagDrain.resumeUid`), so
 * stopping at the ceiling means the pass is marked truncated, the mailbox is re-kicked, and the
 * next pass continues from the last examined UID. Progress is strictly monotone and no flag is
 * lost — which is a better outcome than failing the mailbox's cycle over a provider being
 * verbose, and it is available here only because the resume point exists.
 *
 * 100 000 is well above a legitimate folder scan's row count per pass and far below a stream that
 * costs the shared process anything.
 */
export const IMAP_FLAG_SCAN_MAX_ROWS = 100_000;

/**
 * Rows a SAMPLE scan may examine — `sampleSenders` and `scanSentRecipients`.
 *
 * Both ask for an open-ended sequence range (`start:*`) and stop when they have collected `limit`
 * DISTINCT addresses. A server that answers with a million rows carrying the same address, or no
 * address at all, satisfies the exit condition never and the loop runs as long as the server
 * feels like talking.
 *
 * These TRUNCATE rather than refusing, because a sample is a sample: fewer messages examined is a
 * smaller sample and not a wrong answer. 10 000 is two orders of magnitude above the honest row
 * count (the range asks for at most `limit`, which defaults to 50 and 500).
 */
export const IMAP_SAMPLE_MAX_ROWS = 10_000;

/**
 * Addresses read out of ONE message's envelope.
 *
 * `sampleSenders` and `scanSentRecipients` bound their OUTPUT (distinct addresses) and iterate
 * `[...to, ...cc, ...bcc]` of each message to produce it — a spread that materialises one
 * message's entire recipient list first. `scanSentRecipients`' own docblock says `limit` "bounds
 * BOTH the messages scanned and the addresses returned, so a single mail with a 4 000-address
 * To: header cannot turn a bounded scan into an unbounded result". That is true of the RESULT
 * and, once again, not of the READ: the 4 000 addresses are parsed and spread regardless.
 *
 * 1 000 is above any deliverable recipient list (providers cap RCPT counts far lower) and caps
 * the per-message work at a constant. Over-long lists are TRUNCATED rather than fatal: the
 * addresses beyond it are a sender's padding, not a mailbox fault, and the scan's answer is a
 * sample by construction.
 */
export const IMAP_ENVELOPE_ADDRESSES_MAX = 1_000;

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SIZE CEILINGS
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How far past its own declared `RFC822.SIZE` a message body stream may run before it is refused,
 * as a multiplier.
 *
 * **The batch byte budget trusts a number the server chose.** `fetchCapped` pre-fetches
 * `RFC822.SIZE`, refuses anything over {@link MAX_RAW_MESSAGE_BYTES}, and accumulates the
 * declared sizes against {@link DEFAULT_SYNC_BATCH_MAX_BYTES} — and then the body fetch that
 * follows has no byte accounting of its own at all. A server that answers `RFC822.SIZE 1` and
 * then streams ten gigabytes defeats every byte ceiling in the adapter while satisfying all of
 * them on paper. This is the literal-length arm of the row, and it is the one place where the
 * count ceilings are no defence whatever: one message is enough.
 *
 * A multiplier rather than an absolute, because the honest discrepancy is small and structural:
 * `RFC822.SIZE` is the size of the message as stored, and line-ending normalisation or a
 * re-encoding on the way out can legitimately move it by a few percent. 1.5× is far outside that
 * and far inside "the declared size was a fiction". The floor beside it exists because the
 * multiplier alone is useless against a declared size of 0 or 1.
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TIME CEILINGS — the slow-loris arm
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Wall-clock ceiling on ONE adapter read against the server.
 *
 * **Nothing else in the stack bounds this.** `WORKER_NET_TIMEOUTS.socketMs` is 120 s of
 * INACTIVITY — Node resets it on every byte — so a server dribbling one byte a minute holds the
 * connection, the mailbox lock and this mailbox's slot in the shared process for ever while never
 * once being inactive. It is not sending too much, so no count ceiling sees it; it is not idle,
 * so no socket timer sees it. A wall clock is the only instrument that does.
 *
 * 180 s: comfortably above any legitimate metadata read (a 500 000-UID enumeration at this
 * module's ceiling is a few MB on the wire), comfortably below the 15-minute `sync_lag` alert, so
 * a provider that accepts a command and answers it glacially fails inside the window an operator
 * finds out in.
 */
export const IMAP_READ_DEADLINE_MS = 180_000;

/**
 * Wall-clock ceiling on ONE WHOLE `changesSince` pass.
 *
 * {@link IMAP_READ_DEADLINE_MS} bounds one read, and a hostile server is under no obligation to
 * be slow only once: six watched folders plus a Sent scan, each stopping just short of the
 * per-read ceiling, is a cycle of twenty minutes — past the `sync_lag` alert, and twenty minutes
 * during which this mailbox holds a connection and a slot. The per-read ceiling composes badly
 * by construction, so the pass needs one of its own.
 *
 * 300 s is above the slowest legitimate first-sync pass measured here and below the alert. This
 * is the *per-mailbox time budget* the row asks for, placed at the adapter rather than in the
 * worker's cycle scheduler: `changesSince` is where the pass begins and ends and where the folder
 * loop already lives, so the budget is enforceable there with a clock and a check, while getting
 * the same property from the scheduler would mean rebuilding it.
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
   * Race a promise-shaped command against this clock.
   *
   * **This abandons a command the driver is still running**, so the connection is left poisoned —
   * the identical trade `fetchPart` documents when it throws out of its own `for await`, and it
   * is affordable for the same reason: the caller closes the connection on the way out. There is
   * no way to bound `ImapFlow.list()` or `.search()` from here that does not have this shape;
   * they return an already-materialised array.
   *
   * The timer is always cleared, including on the success path — a dangling 180 s timer per read
   * would keep the process alive past its work.
   */
  async race<T>(op: Promise<T>, folder?: string): Promise<T> {
    const remaining = this.remainingMs();
    if (remaining < 0) this.check(folder);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        op,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ImapBoundExceeded(this.bound, this.budgetMs, this.budgetMs, folder)),
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

/**
 * Consume at most `max` items from a server-driven async iterable, checking the clock as it goes.
 *
 * **This is the one helper that bounds the READ rather than the result**, and it is why the
 * `ImapFlow.fetch()` paths are in better shape than the `list()`/`search()` ones: an async
 * iterable is pulled, so declining to pull is declining to receive. The array never grows past
 * the ceiling and the loop never runs past the clock.
 *
 * `onOverflow: "throw"` is the default and the right answer for anything whose completeness is
 * load-bearing — an enumeration that silently stopped early would read as "those messages were
 * expunged", which is the durable lie this adapter's `unanswered` handling exists to avoid.
 * `"stop"` is for genuine SAMPLES, where fewer items is a smaller sample and not a wrong answer.
 */
export async function boundedCollect<T, R>(
  src: AsyncIterable<T>,
  opts: {
    max: number;
    bound: ImapBoundKind;
    deadline?: ImapDeadline;
    folder?: string;
    onOverflow?: "throw" | "stop";
    map: (item: T) => R;
  },
): Promise<R[]> {
  const out: R[] = [];
  const overflow = opts.onOverflow ?? "throw";
  let seen = 0;
  for await (const item of src) {
    opts.deadline?.check(opts.folder);
    seen++;
    if (seen > opts.max) {
      if (overflow === "stop") break;
      // Thrown BEFORE the item is mapped or pushed: the ceiling is the size of the container,
      // not one past it.
      throw new ImapBoundExceeded(opts.bound, opts.max, seen, opts.folder);
    }
    out.push(opts.map(item));
  }
  return out;
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
