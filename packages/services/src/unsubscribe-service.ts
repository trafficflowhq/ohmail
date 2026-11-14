import type { AuthVerdict, UnsubscribeHeaderState } from "@ohmail/wire";
import { and, eq, sql } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  assertOrganizerRole, senderScreenedOutByPersonSql,
  accountSettings, mailboxes, messages, messageBodies, folderState, unsubscribeRecords,
  unsubscribeExamined, type Tx,
} from "@trafficflow/db";
import {
  authVerdictFromHeaders, createLogger, httpsUnsubscribeUri, oneClickUnsubscribeUri, unsubscribeHeaderState,
  UNSUB_DRAIN_CLOSE_RESERVE_MS, UNSUB_DRAIN_RUN_BUDGET_MS,
  type Destination, type Logger,
} from "@trafficflow/core/mail";
import { bridgeTx, type ServiceContext, type UnboundDb } from "./context.js";
import { ServiceError } from "./errors.js";
import { assertPublicHttpUrl, type HostResolver } from "./ssrf-guard.js";
import { pinnedHttpRequest } from "./pinned-fetch.js";

const asTx = (ctx: ServiceContext): Tx => bridgeTx(ctx.db);
const defaultLog = createLogger({ service: "unsubscribe" });

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
  /** Where the sweep's failures are written: the hardened logger, so an error is its class and code. */
  log?: Logger;
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
   * provider saying "this is forged". This one is nothing confirming the author — the mailbox's
   * provider saying nothing conclusive, or a provider no authserv-id is known for whose letter's
   * own signature ingest could not confirm either — on the one path where nobody is looking at the
   * message. See {@link UnsubscribeService.onScreenOut}.
   */
  | "sender_identity_unverified"
  /**
   * The AUTOMATIC arm declined: no rule a PERSON decided screens this sender out
   * (`senderScreenedOutByPersonSql`). A reject folder alone is not that — import adoption and the
   * auto-act pass file there too. Server-only, like the one above: the button never meets it.
   */
  | "not_person_decided"
  /** No `List-Unsubscribe` at all. */
  | "no_header"
  /** An unsubscribe route exists but it is `mailto:` — refused, never used. */
  | "mailto_only"
  /** An `https:` URI exists but the sender did not advertise RFC 8058 one-click. */
  | "not_one_click"
  /**
   * This mailbox has already asked to leave this list AND THE LIST ACCEPTED IT (a 2xx). NOT a
   * failure — it is the record table doing its whole job, and the honest answer is "nothing more
   * to send". It is the only refusal a surface may render as a completed unsubscribe.
   */
  | "already_recorded"
  /**
   * A record for this list exists and its send did NOT settle as done — claimed and stranded,
   * failed on the wire, or refused by our own address gate or by the list. A CLAIM IS NOT AN
   * OUTCOME: this used to answer `"already_recorded"`, so a person whose unsubscribe was
   * claimed and never sent was told it had been done while the mail kept arriving. A person's
   * press re-attempts a stranded or failed one; the automatic pass never does, because it cannot
   * tell an unattended retry from a second send.
   */
  | "previous_attempt_unsettled"
  /**
   * The list answered and did not accept: a redirect or a 4xx but 408/429 (`oneClickSettleOf`).
   * A person's press says so with the letter's own https link; the list is never asked again.
   */
  | "list_refused"
  /** The list could not take it: a 5xx, 408, 429, a timeout or no connection. A person may ask again. */
  | "list_failed"
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
  /** Requests a list accepted (a 2xx). A list's refusal or failure after the request is `failed`. */
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
function emptySweep(): UnsubscribeSweep {
  return { considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0 };
}

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
 * mailbox whose targets all refuse instantly walk a thousand messages. The press ends when either ceiling is reached.
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
 * WHAT A LIST'S ANSWER SETTLES AS. Done only on a 2xx (RFC 8058). A redirect (never followed) or a
 * 4xx is the list's own answer: `refused`, and one request per list stands, because asking again
 * gets the same answer and tells the list that something reads this address. A 5xx, 408 or 429
 * says nothing about what the list decided: `failed`, which a person's press may retry.
 */
export function oneClickSettleOf(status: number): "sent" | "refused" | "failed" {
  if (status >= 200 && status < 300) return "sent";
  if (status >= 500 || status === 408 || status === 429) return "failed";
  return "refused";
}

/** The `refusal` a record carries when the LIST refused, apart from our own gate's `ssrf_gate`. */
export const LIST_REFUSED = "list_refused";

/**
 * A stored record's outcome by the same rule. A row settled `sent` before the rule existed kept
 * the list's status, so a `sent` over a 405 is read as the refusal it was and never as done.
 */
function recordOutcome(
  held: { state: string; refusal: string | null; httpStatus: number | null },
): "sent" | "refused" | "failed" | "claimed" | "gate_refused" {
  if (held.state === "sent") return held.httpStatus === null ? "sent" : oneClickSettleOf(held.httpStatus);
  if (held.state === "refused") return held.refusal === LIST_REFUSED ? "refused" : "gate_refused";
  return held.state === "failed" ? "failed" : "claimed";
}

const LIST_ANSWERS: ReadonlySet<string> = new Set([
  "unsubscribe_list_refused", "unsubscribe_list_failed",
]);

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
 * `ohmail/Screened` and `ohmail/Quarantine`. Necessary, not sufficient for the automatic arm: the
 * automatic passes and import adoption file there too, so that arm also needs a rule a person
 * decided (`senderScreenedOutByPersonSql`, see `run`). Absent, deliberately: `ohmail/Reads` and
 * `ohmail/Receipts` (mail the user CHOSE TO KEEP — a receipt's sender would stop sending it);
 * `ohmail/Screener` (not decided — acting would make first contact an unsubscribe); `INBOX`.
 * These five are the whole `Destination` union, so the set is exhaustive by construction.
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
 * RFC 2919 §2 caps a `list-id` at 255 octets. A longer one is sender-written junk, and the key it made
 * met `unsubscribe_records_mailbox_list_uq`'s btree ceiling (`54000`), so it is treated as absent and
 * the list falls back to the author's address, which ingest bounds.
 */
export const MAX_LIST_ID_BYTES = 255;

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
    if (identity !== "" && Buffer.byteLength(identity, "utf8") <= MAX_LIST_ID_BYTES) {
      return `list:${escapeKeyPart(author)}|${escapeKeyPart(identity)}`;
    }
  }
  // No `@` in the claimed author means no namespace to put a `list:` claim in, so the sender-
  // chosen `List-ID` is dropped rather than trusted on its own — the branch it used to take.
  return `addr:${fromAddress.trim().toLowerCase()}`;
}

interface MessageRow {
  mailboxId: string;
  fromAddress: string;
  headers: Record<string, unknown>;
  /** `messages.auth_verdict` as ingest stored it: the sender's own signature's `pass` lives only here. */
  storedVerdict: string | null;
  desiredFolder: string | null;
  /** A person's rule screens this sender out — the automatic arm's licence; see {@link run}. */
  personDecided: boolean;
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

  private get log(): Logger { return this.deps.log ?? defaultLog; }

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
    // {@link UnsubscribeDeps.trustedAuthservIdsFor}. An empty set answers `unavailable` from the
    // headers; there the only confirmation is the sender's own signature, which ingest checked from
    // the raw message and stored, so a stored `pass` stands and anything else reads `unavailable`.
    const trusted = await within(
      this.deps.trustedAuthservIdsFor(asTx(ctx), row.mailboxId), "the trust read");
    const fromHeaders = authVerdictFromHeaders(row.headers, row.fromAddress, trusted);
    const authVerdict: AuthVerdict = trusted.size === 0 && row.storedVerdict === "pass" ? "pass" : fromHeaders;
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
    // THE LIST'S ANSWER, BY NAME. A 409 and not a 5xx: a stranger's server being down is not a
    // fault of this API. Only a refusal carries the letter's https link, for the person to open.
    const answered = (
      refusal: "list_refused" | "list_failed", status: number | null, cause?: unknown,
    ): ServiceError => {
      const refused = refusal === "list_refused";
      const sentence = refused
        ? "the list did not accept the unsubscribe request, and ohmail does not ask a list twice"
        : "the list could not take the unsubscribe request right now; try again";
      const e = new ServiceError(`unsubscribe_${refusal}`, 409, sentence, {
        messageId, header, authVerdict, status,
        ...(refused ? { siteUrl: httpsUnsubscribeUri(row.headers) } : {}),
      }, !refused);
      if (cause !== undefined) e.cause = cause;
      return e;
    };

    if (row.desiredFolder === null || !ACTIONABLE_FOLDERS.has(row.desiredFolder)) {
      refuse("not_actionable", 409,
        "unsubscribe applies to a sender you have screened out — not to mail you chose to keep");
    }

    // THE COUPLING THIS CHECK EXISTS TO CLOSE. The unsubscribe URI is chosen by whoever wrote the
    // message, and `From` by the same person: if the claimed author is forged, the list we leave
    // is a stranger's choice — at best confirming to a spammer that this address is read, at
    // worst carrying somebody ELSE'S subscription token and unsubscribing a third party.
    // BOTH ARMS refuse an explicit failure from the account's own provider. Absent evidence
    // refuses only the automatic arm, below: a person pressing the button is looking at the mail.
    if (authVerdict === "fail") {
      refuse("author_failed_authentication", 409,
        "your provider reports that this message failed authentication for its claimed sender");
    }

    // THE AUTOMATIC PASS WANTS A CONFIRMED AUTHOR, THE BUTTON DOES NOT. `unsubscribeListKey`
    // namespaces under the CLAIMED author domain; the residual is a FORGED `From`, and this gate
    // is its other half. AUTOMATIC ONLY: `unsubscribe()` is a person looking at the mail;
    // `onScreenOut` is a pass nobody watches. ANY VERDICT BUT `pass` REFUSES, `unavailable`
    // included: confirmed means by the mailbox's provider or by the signature the sender's own
    // domain put on the letter, and without either an automatic request is made for whoever wrote
    // the `From`. Before the claim, so a refusal writes no record and the person's button on the
    // same letter still posts; the drain's walk reads the verdict saved above and does not offer
    // the letter again (`scanChunk`).
    if (mode === "automatic" && authVerdict !== "pass") {
      refuse("sender_identity_unverified", 409,
        "neither your mail provider nor a signature from the sender's own domain confirmed who " +
        "sent this, and ohmail only leaves lists automatically for senders it can confirm");
    }

    // THE AUTOMATIC ARM ACTS ONLY FOR A SENDER A PERSON SCREENED OUT (UD-R4-03). This seam is the
    // decision and the drain's flag the optimisation: the post-decide courtesy and any direct id
    // hand-off never pass the drain's walk. The button is a person looking at the mail.
    if (mode === "automatic" && !row.personDecided) {
      refuse("not_person_decided", 409,
        "ohmail leaves a list on its own only for a sender you screened out yourself");
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
    // Only a `sent` the list accepted is done. A stranded or failed one is retryable BY A PERSON —
    // their press is an explicit act — and never by the automatic pass, which cannot tell an
    // unattended retry from a second send. A refusal stays consumed: the list's own answer does not
    // change on asking again, and a URL our own gate rejected is not evidence that a different URL
    // for the same list would be safe.
    if (!held.fresh) {
      const was = recordOutcome(held);
      if (was === "sent") {
        return {
          messageId, posted: false, status: null, refusal: "already_recorded", header, authVerdict,
        };
      }
      // The list said no: the person is told so again, and the list is not asked again.
      if (was === "refused" && mode === "manual") throw answered("list_refused", held.httpStatus);
      // A `claimed` row younger than {@link UNSUB_CLAIM_STRANDED_MS} is an attempt IN FLIGHT, not
      // a stranded one, and re-attempting it is the duplicate send the unique index exists to
      // stop — eight concurrent presses would each find the winner's fresh claim and send.
      const inFlight = was === "claimed"
        && ctx.now().getTime() - held.updatedAt.getTime() < UNSUB_CLAIM_STRANDED_MS;
      if (mode === "automatic" || was === "refused" || was === "gate_refused" || inFlight) {
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
      // The transport itself raised — DNS, TLS, a timeout. Recorded as `failed`: we cannot tell
      // whether the sender received it, so the automatic pass never sends again; a person may.
      await this.settle(ctx, claim, { state: "failed", refusal: null });
      throw answered("list_failed", null, err);
    }
    // THE LIST'S ANSWER DECIDES THE STATE: only a 2xx is `sent`. Every status is kept on the row.
    const settled = oneClickSettleOf(status);
    await this.settle(ctx, claim, {
      state: settled, refusal: settled === "refused" ? LIST_REFUSED : null, httpStatus: status,
    });
    if (settled === "refused") throw answered("list_refused", status);
    if (settled === "failed") throw answered("list_failed", status);
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
    const sweep = emptySweep();

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
      // either fires is `remaining`, which is mail this press did not attempt. An item is STARTED only
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
        // A list's answer after the request left is counted as failed, never as a skip: a list
        // refusing every request is a drain whose requests are dying. Logged by the hardened
        // logger, so a cause is its class and code: its text can carry the list's server or link.
        if (err instanceof ServiceError && LIST_ANSWERS.has(err.code)) {
          sweep.failed += 1;
          this.log.error("unsubscribe_list_failed", { messageId: id, code: err.code, err: err.cause });
        } else if (err instanceof ServiceError) sweep.skipped += 1;
        else {
          sweep.failed += 1;
          this.log.error("unsubscribe_sweep_failed", { messageId: id, err });
        }
      }
    }
    return sweep;
  }

  /** Compatibility entry for callers that still poll for background requests. */
  async sweepScreenedOut(
    _ctx: ServiceContext,
    opts: { since: Date; limit: number; budgetMs?: number; budget?: DrainBudget },
  ): Promise<UnsubscribeSweep> {
    if (!(opts.since instanceof Date) || Number.isNaN(opts.since.getTime())) {
      throw new ServiceError("unsubscribe_no_cutoff", 400, "a sweep needs an explicit cutoff");
    }
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new ServiceError("unsubscribe_no_limit", 400, "a sweep needs an explicit positive limit");
    }
    return emptySweep();
  }

  /** Existing schedulers can poll this endpoint without granting any permission to send. */
  async drainScreenedOut(
    _db: UnboundDb,
    opts: {
      now: () => Date; requestId: string;
      accounts?: number; perAccount?: number; budgetMs?: number; budget?: DrainBudget;
    },
  ): Promise<DrainRun> {
    return { accounts: 0, sweep: emptySweep(), remaining: 0, elapsedMs: opts.budget?.elapsedMs() ?? 0 };
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
      this.log.error("unsubscribe_switch_read_failed", { accountId: ctx.accountId, err });
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
  ): Promise<{
    id: string; fresh: boolean; state: string; refusal: string | null; httpStatus: number | null; updatedAt: Date;
  }> {
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
    if (won !== undefined) {
      return { id: won.id, fresh: true, state: "claimed", refusal: null, httpStatus: null, updatedAt: ctx.now() };
    }

    // THE CONFLICT CARRIES ITS OWN STATE. Answering only "somebody else has it" is what let a
    // claim be read as an outcome; the caller decides on the STATE, and the row it names is the
    // one a re-attempt settles — never a second row.
    const [existing] = await asTx(ctx).select({
      id: unsubscribeRecords.id,
      state: unsubscribeRecords.state,
      // What the list answered, when it did: a `sent` over a 405 is a refusal (`recordOutcome`).
      refusal: unsubscribeRecords.refusal,
      httpStatus: unsubscribeRecords.httpStatus,
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
      refusal: existing.refusal ?? null, httpStatus: existing.httpStatus ?? null,
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
      storedVerdict: messages.authVerdict,
      headers: messageBodies.headers,
      desiredFolder: folderState.desiredFolder,
      // A VERDICT WORD, for the drain's reason: the stores spell a boolean differently, and an
      // absent answer must read `no`.
      personDecided: sql<string>`(case when ${senderScreenedOutByPersonSql(
        dialect(ctx.db), sql`${messages.accountId}`, sql`lower(${messages.fromAddress})`, REJECT_DESTINATIONS,
      )} then 'yes' else 'no' end)`,
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
      mailboxId: row.mailboxId, fromAddress: row.fromAddress, storedVerdict: row.storedVerdict ?? null,
      headers, desiredFolder: row.desiredFolder, mailboxStatus: row.mailboxStatus,
      personDecided: row.personDecided === "yes",
    };
  }
}

export function makeUnsubscribeService(deps: UnsubscribeDeps): UnsubscribeService {
  return new UnsubscribeService(deps);
}
