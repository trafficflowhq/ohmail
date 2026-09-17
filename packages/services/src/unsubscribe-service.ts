import { and, asc, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  assertOrganizerRole,
  accountSettings, mailboxes, messages, messageBodies, folderState, unsubscribeRecords,
  unsubscribeExamined, readDrainCursor, writeDrainCursor, UNSUB_DRAIN_PASS,
  type DrainCursor, type Tx,
} from "@trafficflow/db";
import {
  authVerdictFromHeaders, oneClickUnsubscribeUri, unsubscribeHeaderState,
  UNSUB_DRAIN_CLOSE_RESERVE_MS, UNSUB_DRAIN_RUN_BUDGET_MS,
  type AuthVerdict, type Destination, type UnsubscribeHeaderState,
} from "@trafficflow/core/mail";
import type { Db, ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { assertPublicHttpUrl, type HostResolver } from "./ssrf-guard.js";
import { pinnedHttpRequest } from "./pinned-fetch.js";

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The exact body RFC 8058 §3.1 defines for a one-click unsubscribe, and the only bytes this
 * service ever sends to a sender.
 *
 * It is a module constant rather than a parameter because it is the whole content of the
 * request: nothing about the user, the message, the account or the reader travels with it.
 */
export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

const ONE_CLICK_TIMEOUT_MS = 8_000;

/**
 * THE OUTBOUND PORT, AND WHY ITS SIGNATURE IS A GUARANTEE. `post(url, pin)` takes the URL and the
 * validated address(es) to connect to, NOTHING ELSE — no headers bag, no body, no request object
 * — so no parameter exists through which the user's IP, cookies, referer or message could reach
 * the sender. `pin` is `assertPublicHttpUrl`'s output: the POST connects to a PRE-VALIDATED
 * address rather than re-resolving. `ONE_CLICK_BODY` is fixed by the implementation. Mirrors
 * `RemoteFetch`; a separate port only because it cannot POST. There is no mail port here and
 * there must never be one: a `mailto:` unsubscribe sends mail on the user's behalf; the parser
 * refuses one, and the absence of any SMTP dependency is the structural half.
 */
export interface OneClickPost {
  /**
   * `timeoutMs`, when given, is what is LEFT of the caller's budget and never more than the
   * implementation's own ceiling. It is a deadline and not a channel: the signature still admits
   * nothing about the user, the message or the account, which is what the paragraph above is
   * about. Optional because the interactive path has its own fixed ceiling and nothing to thread.
   */
  post(url: string, pin: readonly string[], timeoutMs?: number): Promise<{ status: number }>;
}

/**
 * Production `OneClickPost`. The POST is PINNED to the address the SSRF gate validated
 * (`pinned-fetch.ts`), so a sender whose name resolved to a public address for
 * `assertPublicHttpUrl` cannot have the POST land on a private one — the DNS-rebinding hole a
 * re-resolving fetch leaves open. Redirects are never followed, which the stdlib client gives for
 * free: a `302 Location: http://169.254.169.254/` comes back as-is and is treated as a refusal,
 * no second connection opened. The response BODY is discarded unread: we have no use for whatever
 * a sender writes back, and not reading it is one less piece of attacker-chosen data in the
 * process.
 */
export function makeNodeOneClickPost(opts: { timeoutMs?: number } = {}): OneClickPost {
  const ceiling = opts.timeoutMs ?? ONE_CLICK_TIMEOUT_MS;
  return {
    async post(url: string, pin: readonly string[], timeoutMs?: number) {
      // The SMALLER of the two, never the caller's alone: a caller with seconds to spare may not
      // hold a socket open past this port's own ceiling, and one with milliseconds left may not
      // spend eight seconds it does not have.
      const budget = timeoutMs === undefined ? ceiling : Math.max(1, Math.min(ceiling, timeoutMs));
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), budget);
      try {
        const res = await pinnedHttpRequest(url, {
          method: "POST",
          pin,
          signal: ac.signal,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            // Leaves the building on every unsubscribe, so it is a PUBLIC brand surface.
            "user-agent": "ohmail-Unsubscribe/1.0",
          },
          body: ONE_CLICK_BODY,
        });
        res.stream.destroy();
        return { status: res.status };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export const nodeOneClickPost: OneClickPost = makeNodeOneClickPost();

export interface UnsubscribeDeps {
  post: OneClickPost;
  /**
   * The SSRF gate's DNS port. **Required — there is no default**, for the reason spelled out on
   * `ssrf-guard.ts#HostResolver`: a defaulted `node:dns` in a DNS-blocked sandbox makes every
   * test take the refuse branch and ships the permit branch unexecuted.
   */
  resolver: HostResolver;
  /**
   * The authserv-ids a MAILBOX's own provider signs `Authentication-Results` with, resolved PER
   * MESSAGE from the mailbox that holds it. This replaced one deployment-wide set: the trusted
   * position is a fact about EACH mailbox's provider, and the deployment-wide set had one
   * production value — the empty set — which made every verdict `"unavailable"` and left the
   * `author_failed_authentication` refusal unreachable: a forged `From` could choose whose list
   * the button leaves. Still REQUIRED and never defaulted — the absent-config default is the
   * dangerous branch. Production wires `mailboxProviderAuthservIds`; a caller that trusts nothing
   * types `async () => NO_TRUSTED_AUTHSERV_IDS`.
   */
  trustedAuthservIdsFor: (db: Tx, mailboxId: string) => Promise<ReadonlySet<string>>;
}

/** Why an unsubscribe was refused. `null` on the {@link UnsubscribeResult} of a success. */
export type UnsubscribeRefusal =
  /** The user has not decided about this sender yet, or actively wants their mail. */
  | "not_actionable"
  /** The account's own provider reported an authentication failure for the claimed author. */
  | "author_failed_authentication"
  /**
   * The AUTOMATIC pass declined to act because the author's identity was not vouched for.
   *
   * Distinct from {@link UnsubscribeRefusal} `"author_failed_authentication"`, which is a
   * provider saying "this is forged". This one is a provider we trust saying nothing conclusive,
   * on the one path where nobody is looking at the message. See
   * {@link UnsubscribeService.onScreenOut}.
   */
  | "sender_identity_unverified"
  /** No `List-Unsubscribe` at all. */
  | "no_header"
  /** An unsubscribe route exists but it is `mailto:` — refused, never used. */
  | "mailto_only"
  /** An `https:` URI exists but the sender did not advertise RFC 8058 one-click. */
  | "not_one_click"
  /**
   * This mailbox has already asked to leave this list AND THE REQUEST SETTLED AS SENT. NOT a
   * failure — it is the record table doing its whole job, and the honest answer is "nothing more
   * to send". It is the only refusal a surface may render as a completed unsubscribe.
   */
  | "already_recorded"
  /**
   * A record for this list exists and its send did NOT settle as done — claimed and stranded, or
   * failed on the wire, or refused by our own address gate. A CLAIM IS NOT AN OUTCOME: this used
   * to answer {@link UnsubscribeRefusal} `"already_recorded"`, so a person whose unsubscribe was
   * claimed and never sent was told it had been done while the mail kept arriving. A person's
   * press re-attempts a stranded or failed one; the automatic pass never does, because it cannot
   * tell an unattended retry from a second send.
   */
  | "previous_attempt_unsettled"
  /**
   * The mailbox this message belongs to is disconnected. Nothing is sent in the name of a mailbox
   * its owner stopped — removal leaves the mirrored mail and the organizer role behind, so the
   * state is the fact that decides, not the role.
   */
  | "mailbox_disconnected";

export interface UnsubscribeResult {
  messageId: string;
  /** Did we actually make the request? */
  posted: boolean;
  /** The sender's HTTP status, or `null` when nothing was sent. */
  status: number | null;
  refusal: UnsubscribeRefusal | null;
  /** What the headers said, independent of whether we were allowed to act. */
  header: UnsubscribeHeaderState;
  /** The verdict persisted to `messages.auth_verdict` on this call. */
  authVerdict: AuthVerdict;
}

/**
 * What one automatic pass did. Counts and nothing else — no sender, no address, no URL: this is
 * the shape that gets logged, and a log line naming which lists a user left is a privacy leak
 * with a long half-life.
 *
 * `skipped` and `failed` are separate on purpose. Most screened-out mail publishes no one-click
 * route at all, so a healthy pass over real mail is mostly skips; folding a genuine fault into
 * that number would let a drain whose every request is dying look exactly like a drain that is
 * correctly finding nothing to do.
 */
export interface UnsubscribeSweep {
  considered: number;
  posted: number;
  skipped: number;
  failed: number;
  /**
   * Targets this call was HANDED and did not reach, because its own ceiling stopped it. Not a
   * failure and not a skip: those two say something happened to a message, and this says the
   * call stopped before looking. It is what makes "5 of 50 done" sayable, and the drain is what
   * makes it true.
   */
  remaining: number;
}

/**
 * ONE DRAIN RUN'S ANSWER. `remaining` is a COUNT taken at the end, not a flag assembled from what
 * the run happened to notice: an operator reading a cron table needs to know whether the pass is
 * keeping up, and "something may be owed" cannot say that. `elapsedMs` is the other half — a run
 * that returns 0 in 24 s and a run that returns 0 in 300 ms are different deployments.
 */
export interface DrainRun {
  /** Accounts this run actually entered. */
  accounts: number;
  sweep: UnsubscribeSweep;
  /**
   * Candidates the window still holds after this run — what the NEXT run will look at — or `null`
   * where the counting walk did not reach the end of the window. THE TWO ARE DIFFERENT FACTS: zero
   * means nothing is owed, `null` means this run did not establish that, and collapsing them is the
   * defect the walk exists against. Not a count of unsubscribes owed: a second message from a list
   * this mailbox has already left has no record row of its own (the row is keyed by mailbox and
   * list) and stays in the window until it ages out. The question this number answers is whether the
   * pass is keeping up, so what matters about it is whether it GROWS.
   */
  remaining: number | null;
  elapsedMs: number;
}

/**
 * HOW MANY TARGETS ONE REQUEST MAY POST TO, and how long it may spend doing it.
 *
 * One post is bounded at {@link ONE_CLICK_TIMEOUT_MS} — 8 s — against a 60-second invocation, so
 * fifty targets is up to 400 s inside a request that has 60. The decision's transaction and the
 * IMAP moves come first, so the fan-out's share is that invocation minus a stated 20-second
 * margin: 40 s, five posts at the measured worst case. BOTH AXES, because a clock alone lets a
 * mailbox whose targets all refuse instantly walk a thousand messages. The remainder is not
 * dropped — `drainScreenedOut` makes stopping honest, and neither number rises without it.
 */
export const UNSUB_SYNC_MAX = 5;
export const UNSUB_SYNC_BUDGET_MS = 40_000;

/**
 * HOW FAR BACK THE DRAIN LOOKS. `since` has no default by design — sweeping a mature mailbox's
 * pre-feature screen-outs would announce the address to the senders it was screened away from —
 * and a scheduled pass has nobody to type a date. DERIVED: three of the cadence the worker's pass
 * registry states for `unsubscribe_drain` (one hour), so two missed runs still reach what the
 * last deferred, plus a 24-hour outage envelope. Eligibility is the COMMITTED decision —
 * `folder_state.desired_folder` is written in the decision's own transaction. The envelope is
 * DECLARED, not measured: how long this deployment has been dark in one stretch is a reading
 * owed to the 0.19.1 rig, and 24 h is above every outage it has had.
 */
export const UNSUB_DRAIN_WINDOW_MS = 3 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000;

/**
 * ONE DRAIN RUN'S SHAPE. Accounts first, because the candidate read is per account and an
 * unbounded account list is the same defect one level up; then targets within an account, so one
 * busy account cannot spend the whole run; then the clock, which is what actually stops it —
 * 45 s against the same 60-second invocation the sync ceiling is measured against.
 */
export const UNSUB_DRAIN_ACCOUNTS_PER_RUN = 20;
export const UNSUB_DRAIN_TARGETS_PER_ACCOUNT = 10;
/** The shared number, not a second copy of it — see `@trafficflow/core/mail`. */
export const UNSUB_DRAIN_BUDGET_MS = UNSUB_DRAIN_RUN_BUDGET_MS;

/**
 * HOW MANY SCREENED-OUT ROWS ONE CHUNK READS BEFORE IT JUDGES THEM. The selective fact is
 * `folder_state` (an indexed read); the expensive one is the per-message header probe. As one flat
 * join the planner estimates a single row, drives from `messages` and probes the body of every
 * message a deployment holds — most of a minute before anything bounded starts. A subquery carrying
 * its own LIMIT is not reordered into the join, so this is the FENCE that keeps the shape. IT IS A
 * CHUNK, NOT A PAGE: cut once at the head of the window, a chunk full of INELIGIBLE rows hides
 * everything behind it for ever. The walk below reads chunks in sequence under a cursor that
 * advances past what it rejected, so progress is monotonic.
 */
export const UNSUB_DRAIN_SCAN_PAGE = 2_000;

/**
 * HOW MANY CHUNKS ONE RUN MAY WALK. The ceiling on a walk that would otherwise be the whole
 * window; with the chunk above it is what one run examines at most. A walk stopped by this ceiling
 * has NOT reached the end of the window, which is why `remaining` can answer "not measured" — a
 * zero from a walk that stopped early is the same lie as a zero from a starved page.
 */
export const UNSUB_DRAIN_SCAN_CHUNKS = 8;

/**
 * WHEN A CLAIM STOPS MEANING "SOMEBODY IS SENDING THIS RIGHT NOW". A record is written before the
 * request and settled after it, so a `claimed` row is EITHER an attempt in flight or one whose
 * process died mid-send. Age is what tells them apart, and the difference is load-bearing in both
 * directions: treat a live one as stranded and eight concurrent presses send eight requests to a
 * stranger; treat a stranded one as live and a person is told for ever that a send which never
 * happened is done. Comfortably above one run's whole budget, so nothing in flight can look old.
 */
export const UNSUB_CLAIM_STRANDED_MS = 2 * 60 * 1000;

/**
 * The least budget one item is worth starting with. Below it the item is `remaining` — left for
 * the next tick — rather than begun: a POST cut off on the wire is recorded `failed` and never
 * retried, so starting one the clock cannot pay for spends the at-most-once claim on an outcome
 * nobody chose. Above the measured worst case of everything before the POST, under the POST's own
 * {@link ONE_CLICK_TIMEOUT_MS}.
 */
export const UNSUB_ITEM_MIN_MS = 2_000;

/**
 * ONE BUDGET, ENTERED ONCE AND THREADED THROUGH EVERY SEGMENT — the candidate reads, each
 * account, each item, each outbound POST and the closing count. A per-segment ceiling is no
 * ceiling: four segments of twenty seconds each is eighty, and a clock checked only BEFORE a
 * post lets the last one start at the wire and run its full timeout past it.
 */
export interface DrainBudget {
  /** Milliseconds left, floored at zero. */
  leftMs(): number;
  /** Milliseconds left before the closing reserve — what the POSTING phase may spend. */
  postingLeftMs(): number;
  elapsedMs(): number;
}

/**
 * Where a walk stopped, as the pair the chunk is ordered by — and it IS the stored position, one
 * type, so the walk's cursor and the durable one cannot drift apart.
 */
type ScanCursor = DrainCursor;

/** One row a chunk read, with the verdict the chunk computed rather than filtered on. */
interface ScannedRow { messageId: string; accountId: string; at: Date; eligible: boolean }

/**
 * BOUND A WAIT BY WHAT IS LEFT, and say which wait it was. One elapsed-time budget that nothing
 * derives a deadline from is a budget in name: the database calls and the resolver's DNS each wait
 * on their own clock, and three independent waits of twenty seconds are sixty. The work is not
 * cancelled — a query already sent runs to its end server-side — but the RUN returns, which is
 * what the invocation ceiling is about; a pass that is killed reports nothing at all.
 *
 * Deliberately NOT used on the claim or the settle: abandoning either is how a claim is stranded,
 * and a stranded claim is the state this service works hardest to avoid.
 */
export async function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  if (ms <= 0) throw new ServiceError("unsubscribe_budget_spent", 503, `no budget left for ${what}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ServiceError("unsubscribe_budget_spent", 503, `${what} outlived the budget`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The SSRF gate's resolver, wrapped so its DNS lookup takes a slice of the budget rather than the
 * resolver's own clock. The gate's signature is unchanged — it is handed something that resolves.
 */
function resolverWithin(resolver: HostResolver, leftMs: () => number): HostResolver {
  return { resolve: (hostname: string) => withDeadline(resolver.resolve(hostname), leftMs(), "the address check") };
}

export function startDrainBudget(
  totalMs: number, reserveMs = UNSUB_DRAIN_CLOSE_RESERVE_MS, clock: () => number = Date.now,
): DrainBudget {
  const startedAt = clock();
  const left = (): number => Math.max(0, totalMs - (clock() - startedAt));
  return {
    leftMs: left,
    postingLeftMs: () => Math.max(0, left() - reserveMs),
    elapsedMs: () => clock() - startedAt,
  };
}

/**
 * WHICH MESSAGES MAY BE UNSUBSCRIBED FROM: REJECT DESTINATIONS ONLY, NEVER KEEP DESTINATIONS.
 * `ohmail/Screened` and `ohmail/Quarantine` — the user said no; `folder_state.desired_folder` is
 * the one sink every reject path writes, so naming the destinations covers every route, later
 * ones included. Absent, deliberately: `ohmail/Reads` (removed — mail the user CHOSE TO KEEP);
 * `ohmail/Receipts` (same, sharper: a sender unsubscribed here stops sending the receipt for a
 * purchase already made); `ohmail/Screener` (the user has NOT decided — acting would make first
 * contact itself an unsubscribe); `INBOX` (the user's real mail). These five are the whole
 * `Destination` union, so the set is exhaustive by construction.
 */
const ACTIONABLE_FOLDERS: ReadonlySet<string> = new Set<Destination>([
  "ohmail/Screened", "ohmail/Quarantine",
]);

/** The reject destinations, as an array, for the drain's `IN (…)` predicate. */
const REJECT_DESTINATIONS: readonly string[] = [...ACTIONABLE_FOLDERS];

const LIST_ID_HEADER = "list-id";

/**
 * The first value of a stored header, or `null`.
 *
 * `hasOwnProperty` and not `in` or a bare index, for the reason `rules.ts#headerValues` spells
 * out: `message_bodies.headers` is jsonb through `JSON.parse`, so it inherits from
 * `Object.prototype` and `headers["constructor"]` answers something. A jsonb value may also be a
 * scalar, an array or a nested object, so only a string or an array-of-strings is believed.
 */
function firstHeaderValue(headers: Readonly<Record<string, unknown>>, name: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(headers, name)) return null;
  const raw = headers[name];
  const one = Array.isArray(raw) ? raw[0] : raw;
  return typeof one === "string" && one.trim() !== "" ? one.trim() : null;
}

/** The domain half of an address, lowercased, no trailing dot. `""` when there is no `@`. */
function authorDomain(fromAddress: string): string {
  const at = fromAddress.lastIndexOf("@");
  if (at < 0) return "";
  return fromAddress.slice(at + 1).trim().toLowerCase().replace(/\.$/, "");
}

/**
 * Percent-escape the `|` this key joins on, so `d + "|" + l` is an INJECTIVE encoding of the pair.
 *
 * Not decoration. Without it the separator is forgeable: both halves are attacker-influenced
 * strings, and `|` is legal `atext` in a domain as well as in a sender-authored `List-ID`, so a
 * pair whose concatenation equals a DIFFERENT pair's concatenation re-opens exactly the collision
 * the namespacing exists to close (`d="a.example|news"`, `l="x"` vs `d="a.example"`,
 * `l="news|x"`). `%` is escaped FIRST or the escape itself becomes forgeable.
 */
const escapeKeyPart = (s: string): string => s.replace(/%/g, "%25").replace(/\|/g, "%7c");

/**
 * THE IDEMPOTENCY KEY. Uniqueness is `(mailbox_id, list_key)`: at most one request per list per
 * mailbox — and NO SENDER MAY PRODUCE ANOTHER SENDER'S KEY. Not the URL (per-message tokens); not
 * `from_address` alone; not bare `List-ID` — sender-written, so an attacker's mail carrying a
 * victim's `List-ID` claimed the victim's slot for ever. SO: `list:<from-domain>|<List-ID>`, the
 * list name bound inside the domain the message claims. Residuals: a FORGED `From` still reaches
 * the victim's namespace; a discussion list whose posters keep their own domains derives one key
 * per author domain. NOT REVERSED: over-splitting is bounded, a silenced list permanent. 58 old
 * rows released, unreconciled. `lower(from_address)` is the no-`List-ID` fallback.
 */
export function unsubscribeListKey(
  headers: Readonly<Record<string, unknown>>, fromAddress: string,
): string {
  const author = authorDomain(fromAddress);
  const listId = firstHeaderValue(headers, LIST_ID_HEADER);
  if (listId !== null && author !== "") {
    // `List-Id: Friendly Name <list.id.example.com>` — RFC 2919 §3 puts the identifier inside
    // the angle brackets and everything before it is a human-readable phrase the sender may
    // change at will. Keying on the phrase would make a renamed list a new list.
    const bracketed = /<([^>]+)>/.exec(listId);
    const identity = (bracketed?.[1] ?? listId).trim().toLowerCase().replace(/\.$/, "");
    if (identity !== "") return `list:${escapeKeyPart(author)}|${escapeKeyPart(identity)}`;
  }
  // No `@` in the claimed author means no namespace to put a `list:` claim in, so the sender-
  // chosen `List-ID` is dropped rather than trusted on its own — the branch it used to take.
  return `addr:${fromAddress.trim().toLowerCase()}`;
}

interface MessageRow {
  mailboxId: string;
  fromAddress: string;
  headers: Record<string, unknown>;
  desiredFolder: string | null;
  /** `connected` | `error` | `disabled`, or `null` where the mailbox row is gone. */
  mailboxStatus: string | null;
}

/**
 * RFC 8058 one-click unsubscribe, performed **server-side**.
 *
 * Server-side is a privacy requirement rather than an implementation detail: a browser fetch
 * would put the reader's IP, and the timing of their reading, in the sender's log. The reader is
 * never in the loop — see {@link OneClickPost} for the structural version of that claim.
 */
export class UnsubscribeService {
  constructor(private readonly deps: UnsubscribeDeps) {}

  /**
   * Read the message, persist what its own provider said about the author, and — if every gate
   * agrees — POST the one-click request once.
   *
   * ORDER MATTERS. The verdict is persisted BEFORE any refusal is thrown, so a refusal on
   * authentication grounds leaves the evidence for it on the row rather than only in a log line.
   */
  async unsubscribe(ctx: ServiceContext, messageId: string): Promise<UnsubscribeResult> {
    return this.run(ctx, messageId, "manual");
  }

  /**
   * The shared body of both entry points, with the ONE thing that differs between them named.
   *
   * `mode` is a required parameter and not an optional flag defaulting to `"manual"`, because the
   * default would be the ungated branch: a caller added later would get the permissive path by
   * writing nothing, which is the shape this repository keeps finding in postmortems. Typing the
   * word is the point.
   */
  private async run(
    ctx: ServiceContext, messageId: string, mode: "manual" | "automatic",
    budget?: DrainBudget,
  ): Promise<UnsubscribeResult> {
    // EVERY WAIT DERIVES ITS DEADLINE FROM WHAT IS LEFT. One elapsed-time budget that only the
    // POST consults is a budget in name: these reads and the address check below each waited on
    // their own clock, and independent waits add up past the ceiling the run is measured against.
    const within = <T>(p: Promise<T>, what: string): Promise<T> =>
      budget === undefined ? p : withDeadline(p, budget.leftMs(), what);

    const row = await within(this.load(ctx, messageId), "the message read");

    /**
     * A READER SENDS NO UNSUBSCRIBE (mail 0083). An RFC 8058 one-click POST is an IRREVERSIBLE
     * outbound request made in the mailbox owner's name, on behalf of an ORGANIZING decision — on
     * a mailbox another install organizes, that decision is not ours to have taken. BOTH ARMS,
     * deliberately: the check is in the shared body, not on `unsubscribe()` alone — the automatic
     * arm is already unreachable for a reader (its trigger is `decide`, refused), so the manual
     * one is what this closes, and the shared body keeps a third entry point from being added
     * past it. PER MAILBOX: `row.mailboxId` is already loaded and used one line below for the
     * trust set, so this costs one indexed read on a row already touched.
     */
    // THE AWAIT SITS ON THE CALL, and the deadline sits around the wait. `organizer-role-census`
    // asks every write door for `await assertOrganizerRole(` because a check whose promise is
    // dropped is not a check — handing the call straight to the budget wrapper satisfied the
    // budget and made the door invisible to the census, which is the guard doing its job.
    await within((async () => {
      await assertOrganizerRole(asTx(ctx), dialect(ctx.db), ctx.accountId, row.mailboxId);
    })(), "the organizer check");

    /**
     * A DISCONNECTED MAILBOX IS ACTED FOR BY NOTHING. Beside the role check and not somewhere
     * else, because the two are one question — is this mailbox still ours to send for — and a
     * caller that asked half of it would be making an outbound request in the name of a mailbox
     * its owner stopped. Removal keeps the mirrored messages and the organizer role, so `status`
     * is the fact that decides; the drain's own walk excludes these rows too, and that one is an
     * optimisation, not a second decision-maker.
     */
    if (row.mailboxStatus === "disabled") {
      throw new ServiceError("unsubscribe_mailbox_disconnected", 409,
        "this mailbox is disconnected, and ohmail sends nothing in the name of a mailbox you stopped");
    }

    // Per-mailbox trust, resolved for the mailbox that HOLDS this message — see
    // {@link UnsubscribeDeps.trustedAuthservIdsFor}. Held rather than inlined because its SIZE is
    // a second, independent fact: it says whether an identity claim about this message is
    // CHECKABLE at all, which the verdict alone cannot distinguish from "checked, inconclusive".
    const trusted = await within(
      this.deps.trustedAuthservIdsFor(asTx(ctx), row.mailboxId), "the trust read");
    const identityCheckable = trusted.size > 0;
    const authVerdict = authVerdictFromHeaders(row.headers, row.fromAddress, trusted);
    await within(
      asTx(ctx).update(messages)
        .set({ authVerdict, updatedAt: ctx.now() })
        .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId))),
      "the verdict write",
    );

    const header = unsubscribeHeaderState(row.headers);
    const refuse = (refusal: UnsubscribeRefusal, status: number, message: string): never => {
      throw new ServiceError(`unsubscribe_${refusal}`, status, message, {
        messageId, header, authVerdict,
      } satisfies Omit<UnsubscribeResult, "posted" | "status" | "refusal">);
    };

    if (row.desiredFolder === null || !ACTIONABLE_FOLDERS.has(row.desiredFolder)) {
      refuse("not_actionable", 409,
        "unsubscribe applies to a sender you have screened out — not to mail you chose to keep");
    }

    // THE COUPLING THIS CHECK EXISTS TO CLOSE. The unsubscribe URI is chosen by whoever wrote the
    // message, and `From` by the same person: if the claimed author is forged, the list we leave
    // is a stranger's choice — at best confirming to a spammer that this address is read, at
    // worst carrying somebody ELSE'S subscription token and unsubscribing a third party.
    // Demote-only: an explicit failure from the account's own provider refuses. Absent evidence
    // does NOT — `"unavailable"` is the answer for every deployment that has not named its
    // provider, and refusing on it would make the feature dead on arrival while teaching the
    // codebase the exact "absence selects the destructive branch" habit `rules.ts` argues
    // against.
    if (authVerdict === "fail") {
      refuse("author_failed_authentication", 409,
        "your provider reports that this message failed authentication for its claimed sender");
    }

    // THE AUTOMATIC PASS WANTS A VOUCHED-FOR AUTHOR, THE BUTTON DOES NOT. `unsubscribeListKey`
    // namespaces under the CLAIMED author domain; the residual is a FORGED `From`, and this gate
    // is its other half, narrow in two directions. AUTOMATIC ONLY: `unsubscribe()` is a person
    // looking at the mail; `onScreenOut` is a pass nobody watches. ONLY WHERE THE CLAIM IS
    // CHECKABLE: `identityCheckable` is false where the provider has no trusted authserv-id — the
    // production corpus has `auth_verdict` `unavailable` or unset for EVERY message, so demanding
    // a `pass` unconditionally refuses 100% of real traffic while reading like hardening. STATED
    // PLAINLY: THIS GATE IS INERT IN PRODUCTION TODAY — it fires when `providerAuthservIds`
    // resolves a real authserv-id; the tests inject a trusted set so the branch is EXECUTED, not
    // shipped unrun.
    if (mode === "automatic" && identityCheckable && authVerdict !== "pass") {
      refuse("sender_identity_unverified", 409,
        "your provider did not confirm who sent this, and ohmail only leaves lists " +
        "automatically for senders it can confirm");
    }

    if (header === "no_header") refuse("no_header", 409, "this sender publishes no unsubscribe route");
    if (header === "mailto_only") {
      refuse("mailto_only", 409,
        "this sender only offers unsubscribe by email, and ohmail never sends mail on your behalf");
    }
    if (header === "not_one_click") {
      refuse("not_one_click", 409, "this sender does not support one-click unsubscribe");
    }

    const url = oneClickUnsubscribeUri(row.headers);
    // Unreachable while `header === "one_click"`; a positive re-check rather than a `!`, because
    // the thing being asserted is "we have a URL we are allowed to POST to" and that must never
    // be true by inference.
    if (url === null) refuse("not_one_click", 409, "this sender does not support one-click unsubscribe");

    // ── THE CLAIM. EVERYTHING ABOVE THIS LINE MAY RUN TWICE; NOTHING BELOW IT MAY ──────────
    //
    // The record row is written BEFORE the request, and winning the insert is what earns the
    // right to make it. Two concurrent callers — a re-screen and a retry, two workers, a user
    // double-clicking — both reach here, both attempt the insert, exactly ONE gets a row back.
    //
    // Note where this sits: after every gate that can say "this was never eligible", so a
    // message that merely lacked `List-Unsubscribe-Post` leaves NO row and a later message from
    // the same list can still be acted on. The absence of a row means "not yet considered", and
    // that is the only thing it is allowed to mean.
    const held = await this.claim(ctx, row, messageId);
    // THE MESSAGE IS EXAMINED, AND THE AUTOMATIC PASS SAYS SO ONCE — here, BEFORE the outcomes
    // that return. Every automatic outcome from this point is settled for THIS message while that
    // record stands: a list already left, a claim this pass may not re-attempt, or a send it is
    // about to make and will never make twice. Without it the second message of a left list cost
    // five statements an hour for ever, one of them a write to `messages`, and was counted as
    // still owed. A person's press writes nothing here — it is not the pass, and a marker it left
    // would be a look nobody took.
    if (mode === "automatic") await this.markExamined(ctx, messageId, held.id);
    // A CLAIM IS NOT AN OUTCOME. The row is written BEFORE the request, so its mere EXISTENCE says
    // only that somebody got as far as trying; reading it as "done" told a person their
    // unsubscribe had been sent when a DNS failure had stopped it, while the mail kept arriving.
    // Only a settled `sent` is done. A stranded or failed one is retryable BY A PERSON — their
    // press is an explicit act — and never by the automatic pass, which cannot tell an unattended
    // retry from a second send. A gate refusal stays consumed: a URL our own gate rejected is not
    // evidence that a different URL for the same list would be safe.
    if (!held.fresh) {
      if (held.state === "sent") {
        return {
          messageId, posted: false, status: null, refusal: "already_recorded", header, authVerdict,
        };
      }
      // A `claimed` row younger than {@link UNSUB_CLAIM_STRANDED_MS} is an attempt IN FLIGHT, not
      // a stranded one, and re-attempting it is the duplicate send the unique index exists to
      // stop — eight concurrent presses would each find the winner's fresh claim and send.
      const inFlight = held.state === "claimed"
        && ctx.now().getTime() - held.updatedAt.getTime() < UNSUB_CLAIM_STRANDED_MS;
      if (mode === "automatic" || held.state === "refused" || inFlight) {
        return {
          messageId, posted: false, status: null,
          refusal: "previous_attempt_unsettled", header, authVerdict,
        };
      }
      // …and a person's press falls through to the send, on the SAME row. No second row is ever
      // inserted: the uniqueness on `(mailbox_id, list_key)` is what stops duplicate sends.
    }
    const claim = held.id;

    // The gate runs against the URL we are about to use, immediately before we use it. It is
    // INSIDE the claim deliberately: a refusal here consumes the claim rather than leaving the
    // list open for the next message to retry. At-most-once is the promise, and a URL our own
    // gate rejects is not evidence that a different URL for the same list would be safe. It
    // RETURNS the validated addresses; the POST is pinned to them so a rebinding sender cannot
    // steer the second lookup to a private host.
    let pin: string[];
    try {
      pin = await assertPublicHttpUrl(
        url!,
        // The gate's DNS takes a slice of the budget rather than the resolver's own clock — the
        // wait UD-R4-01 named, between the claim and the POST.
        budget === undefined ? this.deps.resolver : resolverWithin(this.deps.resolver, () => budget.leftMs()),
      );
    } catch (err) {
      await this.settle(ctx, claim, { state: "refused", refusal: "ssrf_gate" });
      throw err;
    }

    let status: number;
    try {
      // THE LAST SEGMENT THE BUDGET REACHES, and the one it used to miss: the clock was read
      // before the post and never bound the post itself, so the last item of a 45 s run could
      // start at 44.9 s and hold the invocation for eight more.
      ({ status } = await this.deps.post.post(url!, pin, budget?.postingLeftMs()));
    } catch (err) {
      // The transport itself raised — DNS, TLS, a timeout. Recorded as `failed` and NOT retried:
      // we cannot tell whether the sender received it, and at-most-once resolves that ambiguity
      // toward not sending again.
      await this.settle(ctx, claim, { state: "failed", refusal: null });
      throw err;
    }
    await this.settle(ctx, claim, { state: "sent", refusal: null, httpStatus: status });
    return { messageId, posted: true, status, refusal: null, header, authVerdict };
  }

  /**
   * THE AUTOMATIC TRIGGER — called with the messages a screen-out just re-routed. IT NEVER THROWS
   * AND NEVER RETURNS AN ERROR THE CALLER MUST HANDLE: the filing decision is the product, the
   * unsubscribe a courtesy. One of TWO independent mechanisms, and the second is stronger: call
   * it AFTER the screen-out transaction commits, so a process dying here leaves the screen-out
   * durable — the `try`/`catch` protects the response; the ordering protects the data. It filters
   * to reject destinations itself: a screen-out path that one day also handles a promote must not
   * turn this into an unsubscribe by passing the wrong ids.
   */
  async onScreenOut(ctx: ServiceContext, messageIds: readonly string[]): Promise<UnsubscribeSweep> {
    return this.postEach(ctx, messageIds, {
      count: UNSUB_SYNC_MAX,
      // Its OWN budget, entered here: this one is a request's share of its invocation, and it
      // owes no closing count, so there is no reserve to hold back.
      budget: startDrainBudget(UNSUB_SYNC_BUDGET_MS, 0),
    });
  }

  /**
   * POST TO EACH OF THESE, UNDER A CEILING THE CALLER SUPPLIES — the one body both entry points
   * run, and the ceiling is a parameter for a reason the row this closes states: if the drain
   * routed through the interactive path it would inherit the interactive cap whatever its own
   * caller asked for, and would then report a remainder it could never pick up.
   *
   * It never throws. The filing decision is the product and the unsubscribe a courtesy, so a
   * caller awaiting this after its own commit must not be handed an error to decide about.
   */
  private async postEach(
    ctx: ServiceContext, messageIds: readonly string[],
    ceiling: { count: number; budget: DrainBudget },
  ): Promise<UnsubscribeSweep> {
    const sweep: UnsubscribeSweep = {
      considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0,
    };

    // THE ACCOUNT SWITCH, READ HERE AND NOWHERE ELSE (mail 0054). `block_auto_unsubscribe_at`
    // NOT NULL means this account asked that a screen-out stop leaving lists on their behalf.
    // Read at the TOP of the automatic entry point: it is the seam, not the surface — a stale tab or a
    // direct API call cannot make a request this row forbids, because the request is made here;
    // `unsubscribe()` is deliberately NOT gated — a switch labelled "auto" that also disabled a manual
    // control has a lying label (`sweepScreenedOut` IS gated, it comes through here); ONCE, not per
    // message — one read is the same answer for all ids and cannot go half-applied. The zero sweep is
    // the honest return: `considered` counts what the pass LOOKED at, and it looked at nothing.
    if (await this.blocked(ctx)) return sweep;

    for (const id of messageIds) {
      // BOTH AXES, CHECKED BEFORE THE ITEM AND NEVER AFTER IT. A count-only ceiling leaves five
      // eight-second posts inside a request that has twenty seconds left; a clock-only one lets a
      // mailbox whose targets all refuse instantly walk the whole list. Whatever is left when
      // either fires is `remaining`, which is a promise the drain keeps. An item is STARTED only
      // where the budget can pay for it: a post begun with nothing left is aborted on the wire
      // and lands as `failed`, which spends the at-most-once claim on an outcome nobody chose.
      if (sweep.considered >= ceiling.count || ceiling.budget.postingLeftMs() < UNSUB_ITEM_MIN_MS) {
        sweep.remaining += 1;
        continue;
      }
      sweep.considered += 1;
      try {
        // `"automatic"`, which is what turns on the identity gate above. The button calls
        // `unsubscribe()` and does not get it.
        const result = await this.run(ctx, id, "automatic", ceiling.budget);
        if (result.posted) sweep.posted += 1;
        else sweep.skipped += 1;
      } catch (err) {
        // A `ServiceError` here is a REFUSAL — not actionable, no header, mailto-only, a failed
        // author verdict. Those are the normal case, not an incident: most screened-out mail
        // publishes no one-click route at all. Anything else is a genuine fault and is counted
        // separately so a drain that is silently failing every request cannot look like a drain
        // that is correctly finding nothing to do.
        if (err instanceof ServiceError) sweep.skipped += 1;
        else {
          sweep.failed += 1;
          console.error(`[unsubscribe] message ${id}:`, err);
        }
      }
    }
    return sweep;
  }

  /**
   * THE DRAIN, AND WHY IT REFUSES TO RUN WITHOUT A CUTOFF. `folder_state.desired_folder` is the
   * single sink every reject path writes, so the STATE is the queue — nothing is enqueued, and a
   * later reject path is covered the day it is written. `since` IS REQUIRED, NO DEFAULT: a mature
   * mailbox holds thousands of pre-feature screen-outs, and a drain defaulting to "all of it"
   * would make thousands of outbound requests — announcing this address to the very spam screened
   * out because nobody wanted it confirmed live. The sweep happens only because somebody typed
   * the date. `limit` is required for the same reason at smaller scale.
   */
  async sweepScreenedOut(
    ctx: ServiceContext,
    opts: { since: Date; limit: number; budgetMs?: number; budget?: DrainBudget },
  ): Promise<UnsubscribeSweep> {
    if (!(opts.since instanceof Date) || Number.isNaN(opts.since.getTime())) {
      throw new ServiceError("unsubscribe_no_cutoff", 400,
        "a sweep needs an explicit cutoff — there is no default, by design");
    }
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new ServiceError("unsubscribe_no_limit", 400, "a sweep needs an explicit positive limit");
    }

    // LEFT JOIN … IS NULL, not NOT IN (…): the list key is knowable only from the headers, so the
    // query filters on the MESSAGE not yet having supplied a record and the claim de-duplicates
    // against the key that matters. This join is an optimisation; the unique index is correctness.
    //
    // THE TWO HEADER KEYS ARE WHAT MAKES THE DRAIN MORE THAN DECORATIVE: `run()` refuses a message
    // with no `List-Unsubscribe`, or no `-Post`, BEFORE the claim, so no record row is written and
    // it stays a candidate for ever — and most screened-out mail publishes no route at all. KEY
    // EXISTENCE only, never a second copy of the grammar; the malformed shape (a `-Post` over
    // `mailto:` alone) survives a pass, and the window is what bounds that.
    const budget = opts.budget ?? startDrainBudget(opts.budgetMs ?? UNSUB_DRAIN_BUDGET_MS, 0);
    const walk = await this.walkWindow(asTx(ctx), opts.since, ctx.accountId, {
      want: opts.limit, budget,
    });

    return this.postEach(ctx, walk.eligible.map((c) => c.messageId), { count: opts.limit, budget });
  }

  /**
   * ONE CHUNK OF THE WINDOW, JUDGED BUT NOT FILTERED. The fence is the subquery's own LIMIT, which a
   * planner does not reorder into the join; the eligibility facts hang off it as LEFT joins and are
   * returned as a FLAG rather than a filter, so the caller sees every row the chunk read and can
   * advance its cursor past the ones it may not act on. Filtering here is what starved the pass.
   * The two mailbox facts are asked TOGETHER — the account's automatic switch and the mailbox's own
   * connected state — because a disconnected mailbox is acted for by nothing, and a caller that
   * asked only one would send in the name of a mailbox its owner stopped.
   */
  private async scanChunk(
    tx: Tx, since: Date, accountId: string | null, after: ScanCursor | null, deadlineMs: number,
  ): Promise<{ rows: ScannedRow[]; read: number }> {
    const page = tx.select({
      messageId: folderState.messageId,
      at: folderState.updatedAt,
      accountId: messages.accountId,
      mailboxId: messages.mailboxId,
    })
      .from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(
        inArray(folderState.desiredFolder, REJECT_DESTINATIONS as string[]),
        gte(folderState.updatedAt, since),
        accountId === null ? undefined : eq(messages.accountId, accountId),
        // THE CURSOR. `updated_at` alone is not unique; `message_id` is unique in `folder_state`,
        // so the pair is a stable key, and this is that pair's comparison written out. NOT a raw
        // row-value fragment: bare literals there serialize differently under PGlite and
        // postgres@3, and casting them to fix that puts a Postgres timestamptz and uuid cast into
        // a file the PHONE bundle loads, where the store is SQLite and neither exists. Built here,
        // each side binds through its own column type on every dialect.
        after === null ? undefined : or(
          gt(folderState.updatedAt, after.at),
          and(eq(folderState.updatedAt, after.at), gt(folderState.messageId, after.messageId)),
        ),
      ))
      // OLDEST FIRST. An unordered LIMIT is a sample, and a sample can hand back the same rows
      // for ever while the oldest never move — here that would mean the rows closest to falling
      // out of the drain's window are the ones it never reaches.
      .orderBy(asc(folderState.updatedAt), asc(folderState.messageId))
      .limit(UNSUB_DRAIN_SCAN_PAGE)
      .as("scan_page");

    const rows = await withDeadline(
      tx.select({
        messageId: page.messageId,
        at: page.at,
        accountId: page.accountId,
        eligible: sql<boolean>`(
          ${unsubscribeRecords.id} is null
          and ${unsubscribeExamined.messageId} is null
          and ${accountSettings.blockAutoUnsubscribeAt} is null
          and ${mailboxes.status} <> 'disabled'
          and ${messageBodies.messageId} is not null
          and jsonb_exists(${messageBodies.headers}, 'list-unsubscribe')
          and jsonb_exists(${messageBodies.headers}, 'list-unsubscribe-post')
        )`,
      })
        .from(page)
        // EVERY join is LEFT, including the body one that used to be INNER: the caller needs the
        // chunk's own row count to know whether the window is exhausted and where its cursor goes,
        // and an inner join would silently shorten the chunk to the rows that happened to qualify.
        .leftJoin(messageBodies, eq(messageBodies.messageId, page.messageId))
        .leftJoin(unsubscribeRecords, eq(unsubscribeRecords.messageId, page.messageId))
        // THE PER-MESSAGE MARKER. The record row is keyed `(mailbox, list)`, so the second message
        // of a list already left matches nothing above it and was a candidate at every tick. This
        // join is what makes the candidate set shrink for a list, not just for a message.
        .leftJoin(unsubscribeExamined, eq(unsubscribeExamined.messageId, page.messageId))
        .leftJoin(accountSettings, eq(accountSettings.accountId, page.accountId))
        .leftJoin(mailboxes, eq(mailboxes.id, page.mailboxId))
        .orderBy(asc(page.at), asc(page.messageId)),
      deadlineMs, "the candidate read",
    );

    return {
      rows: rows.map((r) => ({
        messageId: r.messageId, accountId: r.accountId, at: r.at, eligible: r.eligible === true,
      })),
      read: rows.length,
    };
  }

  /**
   * WALK THE WINDOW IN CHUNKS UNTIL THERE IS ENOUGH TO DO, OR THERE IS NO MORE WINDOW.
   *
   * `exhausted` is the whole point of the return: it is true only where the walk reached the end
   * of the window, and it is the only state in which a count taken from this walk is a fact. A
   * walk stopped by the chunk ceiling, by the budget, or because it had enough work knows nothing
   * about what lies behind it, and must not answer zero on its behalf.
   */
  private async walkWindow(
    tx: Tx, since: Date, accountId: string | null,
    opts: { want: number; budget: DrainBudget; count?: boolean; from?: ScanCursor | null },
  ): Promise<{
    eligible: ScannedRow[]; eligibleSeen: number; exhausted: boolean; chunks: number;
    stoppedAt: ScanCursor | null;
  }> {
    const eligible: ScannedRow[] = [];
    let eligibleSeen = 0;
    let exhausted = false;
    let chunks = 0;
    // WHERE A PREVIOUS RUN STOPPED, or the head of the window. `lastRead` starts there so a walk
    // that reads nothing past the cursor leaves it where it was rather than winding it back.
    let after: ScanCursor | null = opts.from ?? null;
    let lastRead: ScanCursor | null = opts.from ?? null;

    while (chunks < UNSUB_DRAIN_SCAN_CHUNKS) {
      const left = opts.budget.leftMs();
      if (left <= 0) break;
      let chunk;
      try {
        chunk = await this.scanChunk(tx, since, accountId, after, left);
      } catch (err) {
        // A read that ran out of budget STOPS the walk; it does not fail the run and it does not
        // make `exhausted` true. Anything else is a real fault and belongs to the caller.
        if (err instanceof ServiceError && err.code === "unsubscribe_budget_spent") break;
        throw err;
      }
      chunks += 1;
      for (const row of chunk.rows) {
        if (!row.eligible) continue;
        eligibleSeen += 1;
        if (eligible.length < opts.want) eligible.push(row);
      }
      // THE CURSOR ADVANCES PAST WHAT THE CHUNK REJECTED — this is the monotonic progress the
      // single cut did not have. The last row READ, never the last row taken.
      const last = chunk.rows[chunk.rows.length - 1];
      if (last !== undefined) {
        after = { at: last.at, messageId: last.messageId };
        lastRead = after;
      }
      if (chunk.read < UNSUB_DRAIN_SCAN_PAGE) { exhausted = true; break; }
      if (!opts.count && eligible.length >= opts.want) break;
    }

    /**
     * WHERE THIS WALK STOPPED — the position a later run resumes AFTER, and the three states it
     * can be in. It is read off the RESULT and never off which `break` fired: with a window
     * smaller than one page the walk exhausts and takes its fill in the same chunk, and a rule
     * keyed on the break would call that a lap.
     *
     * Took its fill ⇒ the last row TAKEN: everything after it was read but not looked at.
     * Stopped short (budget, chunk ceiling) ⇒ the last row READ.
     * Reached the end of the window without filling ⇒ `null`: the lap is over, start at the head.
     */
    const took = eligible[eligible.length - 1];
    const stoppedAt = took !== undefined && eligible.length >= opts.want
      ? { at: took.at, messageId: took.messageId }
      : (exhausted ? null : lastRead);

    return { eligible, eligibleSeen, exhausted, chunks, stoppedAt };
  }

  /**
   * THE DRAIN'S PRODUCTION ENTRY — one bounded run over every account that has something owed.
   *
   * `sweepScreenedOut` is account-scoped and needs a cutoff somebody typed. A scheduled pass has
   * nobody to type one, so the cutoff is {@link UNSUB_DRAIN_WINDOW_MS} back from now: it reaches
   * what a recent request deferred and never the historical backlog the manual sweep's refusal
   * exists to protect. Three bounds, because there are three ways this could be unbounded — the
   * number of ACCOUNTS it looks at, the number of TARGETS within one, and the CLOCK, which is
   * what actually stops a run.
   */
  async drainScreenedOut(
    db: Db,
    opts: {
      now: () => Date; requestId: string;
      accounts?: number; perAccount?: number; budgetMs?: number; budget?: DrainBudget;
    },
  ): Promise<DrainRun> {
    const accounts = opts.accounts ?? UNSUB_DRAIN_ACCOUNTS_PER_RUN;
    const perAccount = opts.perAccount ?? UNSUB_DRAIN_TARGETS_PER_ACCOUNT;
    // ONE BUDGET, ENTERED HERE — before the first read, which is exactly where the old clock was
    // not: it started AFTER the account census, so everything that census cost was charged to
    // nothing and the run met the platform's kill with its own ceiling still unspent.
    const budget = opts.budget ?? startDrainBudget(opts.budgetMs ?? UNSUB_DRAIN_BUDGET_MS);
    const since = new Date(opts.now().getTime() - UNSUB_DRAIN_WINDOW_MS);
    const tx = db as unknown as Tx;

    // ONE WALK ACROSS THE WINDOW, oldest first, cursored so a stretch of rows this pass may not
    // act on cannot hide the work behind it. It replaces the grouped account census AND the
    // per-account candidate read: both asked the same window through the same fence, and a fence
    // cut once at the head of the window is what let a large screen-out of ineligible rows stop
    // the pass while its progress number said nothing was owed.
    //
    // The account ceiling and the per-account ceiling are applied to what the walk YIELDS, so an
    // account with a long run of candidates cannot spend the whole batch, and the walk asks for
    // exactly as much as those two ceilings admit.
    //
    // AND IT RESUMES WHERE THE LAST RUN STOPPED. The walk restarted at the head of the window at
    // every tick, so a candidate this pass can look at and never act on — a `-Post` header over a
    // `mailto:` route is the shape — held the head and the rows behind it were reached by nobody.
    const from = await readDrainCursor(tx, UNSUB_DRAIN_PASS);
    const walk = await this.walkWindow(tx, since, null, {
      want: accounts * perAccount, budget, from,
    });

    const byAccount = new Map<string, string[]>();
    for (const row of walk.eligible) {
      const held = byAccount.get(row.accountId);
      if (held === undefined) {
        if (byAccount.size >= accounts) continue;
        byAccount.set(row.accountId, [row.messageId]);
      } else if (held.length < perAccount) {
        held.push(row.messageId);
      }
    }

    const sweep: UnsubscribeSweep = {
      considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0,
    };
    let visited = 0;
    for (const [accountId, ids] of byAccount) {
      // The SAME budget every segment reads, not a slice handed down: an account entered with
      // less than one item's worth left is the next tick's, not this one's half-run.
      if (budget.postingLeftMs() < UNSUB_ITEM_MIN_MS) break;
      visited += 1;
      // `postEach` reads the account's automatic switch at the SEAM. The walk's own predicate
      // excludes a blocked account too, and that one is an optimisation: it can only remove an
      // account, never admit one, and removing the seam's read would move a decision into a query.
      const one = await this.postEach(
        { db, accountId, userId: null, now: opts.now, requestId: opts.requestId },
        ids, { count: perAccount, budget },
      );
      sweep.considered += one.considered;
      sweep.posted += one.posted;
      sweep.skipped += one.skipped;
      sweep.failed += one.failed;
      sweep.remaining += one.remaining;
    }

    // THE PASS ENDS HERE, AND THE CURSOR IS WRITTEN ONCE — never per page. A run killed mid-walk
    // resumes from the last END, which costs at most one repeat of the work it had already done;
    // a cursor written per page would leave a killed run claiming to have looked at a page it
    // never posted for. The count below is a report about the whole window and cannot move it.
    await writeDrainCursor(tx, UNSUB_DRAIN_PASS, walk.stoppedAt, opts.now());

    // WHAT IS STILL OWED, COUNTED RATHER THAN INFERRED — the reserve this budget holds back exists
    // for this one read. It is `null`, never 0, when the counting walk did not reach the end of
    // the window: a zero that is really "I stopped looking" is the sentence that told an operator
    // this pass was keeping up while it had not looked at the backlog at all.
    const remaining = await this.owedCount(tx, since, budget);

    return { accounts: visited, sweep, remaining, elapsedMs: budget.elapsedMs() };
  }

  /**
   * How many candidates the window still holds for anyone, or `null` where the walk could not
   * reach the end of it. The two are different facts and the caller may not collapse them.
   */
  private async owedCount(tx: Tx, since: Date, budget: DrainBudget): Promise<number | null> {
    const walk = await this.walkWindow(tx, since, null, {
      want: 0, count: true, budget,
    });
    return walk.exhausted ? walk.eligibleSeen : null;
  }

  /**
   * HAS THIS ACCOUNT TURNED THE AUTOMATIC PASS OFF? (mail 0054). `true` iff
   * `block_auto_unsubscribe_at IS NOT NULL`. An absent row is FALSE — the pass runs — the product
   * default: rows are created lazily, and "no row means off" would switch a shipping behaviour
   * off for everybody who never opened Settings. A FAILED READ ANSWERS `true`, load-bearing
   * twice: `onScreenOut` never throws (its caller awaits it after the commit with no `try`), and
   * "do not send" is the recoverable direction — a blocked pass writes no record row, so the next
   * message is still a candidate; sending is not recoverable. A 42703 from an API deployed ahead
   * of the migration lands here too.
   */
  private async blocked(ctx: ServiceContext): Promise<boolean> {
    try {
      const [row] = await asTx(ctx).select({ at: accountSettings.blockAutoUnsubscribeAt })
        .from(accountSettings)
        .where(eq(accountSettings.accountId, ctx.accountId))
        .limit(1);
      return row?.at != null;
    } catch (err) {
      console.error("[unsubscribe] could not read the account switch; sending nothing:", err);
      return true;
    }
  }

  /**
   * Win the right to send, or discover somebody already has it. `ON CONFLICT DO NOTHING …
   * RETURNING` is the entire mutual exclusion. No `SELECT … FOR UPDATE` because there is nothing
   * to lock: the row does not exist yet, and a read-then-write has exactly the window this
   * closes. Two transactions inserting the same `(mailbox_id, list_key)` serialize on the unique
   * index — the second blocks until the first commits, then returns zero rows. `null` means
   * "already recorded"; it never means "an error happened".
   */
  private async claim(
    ctx: ServiceContext, row: MessageRow, messageId: string,
  ): Promise<{ id: string; fresh: boolean; state: string; updatedAt: Date }> {
    const listKey = unsubscribeListKey(row.headers, row.fromAddress);
    const claimed = await asTx(ctx).insert(unsubscribeRecords).values({
      accountId: ctx.accountId,
      mailboxId: row.mailboxId,
      listKey,
      state: "claimed",
      messageId,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
    })
      .onConflictDoNothing({
        target: [unsubscribeRecords.mailboxId, unsubscribeRecords.listKey],
      })
      .returning({ id: unsubscribeRecords.id });
    const won = claimed[0];
    if (won !== undefined) return { id: won.id, fresh: true, state: "claimed", updatedAt: ctx.now() };

    // THE CONFLICT CARRIES ITS OWN STATE. Answering only "somebody else has it" is what let a
    // claim be read as an outcome; the caller decides on the STATE, and the row it names is the
    // one a re-attempt settles — never a second row.
    const [existing] = await asTx(ctx).select({
      id: unsubscribeRecords.id,
      state: unsubscribeRecords.state,
      // The AGE is half the answer: it is what tells an attempt in flight from a stranded one.
      updatedAt: unsubscribeRecords.updatedAt,
    })
      .from(unsubscribeRecords)
      .where(and(
        eq(unsubscribeRecords.mailboxId, row.mailboxId),
        eq(unsubscribeRecords.listKey, listKey),
      ))
      .limit(1);
    // The insert conflicted, so a row exists; a read that finds none means it was deleted between
    // the two statements (an erasure), and that is not this call's to invent an outcome for.
    if (existing === undefined) {
      throw new ServiceError("unsubscribe_record_vanished", 409,
        "the record for this list was removed while we were writing it");
    }
    return {
      id: existing.id, fresh: false, state: existing.state,
      updatedAt: existing.updatedAt instanceof Date ? existing.updatedAt : new Date(existing.updatedAt),
    };
  }

  /**
   * MARK THIS MESSAGE EXAMINED against the record it was judged by. `ON CONFLICT DO NOTHING`
   * because two runs may reach the same message, and the first mark is the true one; the marker
   * carries the record so an erasure that takes the list takes the look with it.
   */
  private async markExamined(ctx: ServiceContext, messageId: string, recordId: string): Promise<void> {
    await asTx(ctx).insert(unsubscribeExamined).values({
      messageId, recordId, accountId: ctx.accountId, createdAt: ctx.now(),
    }).onConflictDoNothing({ target: unsubscribeExamined.messageId });
  }

  /** Record the outcome on a claim we own. Never widens the claim, never releases it. */
  private async settle(
    ctx: ServiceContext, id: string,
    outcome: { state: "sent" | "refused" | "failed"; refusal: string | null; httpStatus?: number },
  ): Promise<void> {
    await asTx(ctx).update(unsubscribeRecords).set({
      state: outcome.state,
      refusal: outcome.refusal,
      httpStatus: outcome.httpStatus ?? null,
      updatedAt: ctx.now(),
    }).where(and(
      eq(unsubscribeRecords.id, id),
      eq(unsubscribeRecords.accountId, ctx.accountId),
    ));
  }

  /**
   * The message, its stored headers and its DESIRED folder — account-scoped, so a cross-account
   * id is a 404 and never a 403 (the existence of another account's row is not ours to
   * confirm).
   */
  private async load(ctx: ServiceContext, messageId: string): Promise<MessageRow> {
    // A non-uuid would reach Postgres as a cast error and surface as a 500. It is a 404: the
    // caller named something that is not one of this account's messages.
    if (!UUID_RE.test(messageId)) throw new ServiceError("not_found", 404, "message not found");

    const rows = await asTx(ctx).select({
      mailboxId: messages.mailboxId,
      fromAddress: messages.fromAddress,
      headers: messageBodies.headers,
      desiredFolder: folderState.desiredFolder,
      // The mailbox's own connected state, read here so the seam below can ask it in the same
      // breath as the role. Disconnection leaves the mirrored mail and the organizer role behind,
      // so the role alone cannot tell whether this mailbox is still ours to act for.
      mailboxStatus: mailboxes.status,
    })
      .from(messages)
      .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .leftJoin(folderState, eq(folderState.messageId, messages.id))
      .leftJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
      .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) throw new ServiceError("not_found", 404, "message not found");

    // `message_bodies.headers` is jsonb through `JSON.parse`, so it inherits from
    // `Object.prototype`, a missing body row leaves it null, and jsonb can hold
    // a scalar or an array as legitimately as an object. The prototype half is handled where the
    // map is READ (`rules.ts#headerValues` uses `hasOwnProperty`); the job here is to hand over
    // an object, so that a row whose jsonb is `"[]"` cannot make `headers["length"]` answer.
    const raw: unknown = row.headers;
    const headers = raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
    return {
      mailboxId: row.mailboxId, fromAddress: row.fromAddress,
      headers, desiredFolder: row.desiredFolder, mailboxStatus: row.mailboxStatus,
    };
  }
}

export function makeUnsubscribeService(deps: UnsubscribeDeps): UnsubscribeService {
  return new UnsubscribeService(deps);
}
