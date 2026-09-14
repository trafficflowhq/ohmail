import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  assertOrganizerRole,
  accountSettings, messages, messageBodies, folderState, unsubscribeRecords, type Tx,
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
   * This mailbox has already asked to leave this list. NOT a failure — it is the record table
   * doing its whole job, and the honest answer is "nothing more to send".
   */
  | "already_recorded";

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
   * Candidates the window still holds after this run, counted — what the NEXT run will look at.
   * Not a count of unsubscribes owed: a second message from a list this mailbox has already left
   * has no record row of its own (the row is keyed by mailbox and list) and stays in the window
   * until it ages out, looked at each run and posted to never. The question this number answers
   * is whether the pass is keeping up, so what matters about it is whether it GROWS.
   */
  remaining: number;
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
 * HOW MANY SCREENED-OUT ROWS ONE RUN MAY LOOK AT BEFORE IT FILTERS THEM, and it is the bound the
 * whole defect was missing. The selective fact is `folder_state` — a reject destination inside
 * the window, an indexed read — and the expensive one is the per-message header probe. Asked as
 * one flat join the planner estimates a single row, drives from `messages` and probes the body of
 * every message a deployment holds, which on a large one costs most of a minute before anything
 * bounded has started. The page is a FENCE: the window's rows, oldest first, capped here, and
 * everything else joins what it returns. A page that comes back FULL means there may be more
 * behind it, which is `remaining`'s job to say.
 */
export const UNSUB_DRAIN_SCAN_PAGE = 2_000;

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
    const row = await this.load(ctx, messageId);

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
    await assertOrganizerRole(asTx(ctx), dialect(ctx.db), ctx.accountId, row.mailboxId);

    // Per-mailbox trust, resolved for the mailbox that HOLDS this message — see
    // {@link UnsubscribeDeps.trustedAuthservIdsFor}. Held rather than inlined because its SIZE is
    // a second, independent fact: it says whether an identity claim about this message is
    // CHECKABLE at all, which the verdict alone cannot distinguish from "checked, inconclusive".
    const trusted = await this.deps.trustedAuthservIdsFor(asTx(ctx), row.mailboxId);
    const identityCheckable = trusted.size > 0;
    const authVerdict = authVerdictFromHeaders(row.headers, row.fromAddress, trusted);
    await asTx(ctx).update(messages)
      .set({ authVerdict, updatedAt: ctx.now() })
      .where(and(eq(messages.id, messageId), eq(messages.accountId, ctx.accountId)));

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
    const claim = await this.claim(ctx, row, messageId);
    if (claim === null) {
      return {
        messageId, posted: false, status: null, refusal: "already_recorded", header, authVerdict,
      };
    }

    // The gate runs against the URL we are about to use, immediately before we use it. It is
    // INSIDE the claim deliberately: a refusal here consumes the claim rather than leaving the
    // list open for the next message to retry. At-most-once is the promise, and a URL our own
    // gate rejects is not evidence that a different URL for the same list would be safe. It
    // RETURNS the validated addresses; the POST is pinned to them so a rebinding sender cannot
    // steer the second lookup to a private host.
    let pin: string[];
    try {
      pin = await assertPublicHttpUrl(url!, this.deps.resolver);
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
    const page = this.scanPage(asTx(ctx), opts.since, ctx.accountId);
    const candidates = await asTx(ctx).select({ id: page.messageId })
      .from(page)
      // INNER, not LEFT: the headers live on the body row, and a message with no body row has no
      // headers, so it can never be actionable. Its absence is a filter, not a missing value.
      .innerJoin(messageBodies, eq(messageBodies.messageId, page.messageId))
      .leftJoin(unsubscribeRecords, eq(unsubscribeRecords.messageId, page.messageId))
      .where(and(
        isNull(unsubscribeRecords.id),
        sql`jsonb_exists(${messageBodies.headers}, 'list-unsubscribe')`,
        sql`jsonb_exists(${messageBodies.headers}, 'list-unsubscribe-post')`,
      ))
      // OLDEST FIRST. An unordered LIMIT is a sample, and a sample can hand back the same rows
      // for ever while the oldest never move — here that would mean the rows closest to falling
      // out of the drain's window are the ones it never reaches.
      .orderBy(asc(page.at), asc(page.messageId))
      .limit(opts.limit);

    return this.postEach(ctx, candidates.map((c) => c.id), {
      count: opts.limit,
      budget: opts.budget ?? startDrainBudget(opts.budgetMs ?? UNSUB_DRAIN_BUDGET_MS, 0),
    });
  }

  /**
   * THE FENCE THE CANDIDATE READS DRIVE FROM. `folder_state` holds the selective fact — a reject
   * destination inside the window — and the per-message header probe is the expensive one. Asked
   * as one flat join the planner estimates a single row and drives from `messages`, probing every
   * body a deployment holds to find the few this pass wants. A subquery carrying its own LIMIT is
   * not reordered into the join, so the shape holds whatever the planner believes, and
   * {@link UNSUB_DRAIN_SCAN_PAGE} is what everything else joins against.
   */
  private scanPage(tx: Tx, since: Date, accountId: string | null) {
    return tx.select({
      messageId: folderState.messageId,
      at: folderState.updatedAt,
      accountId: messages.accountId,
    })
      .from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(
        inArray(folderState.desiredFolder, REJECT_DESTINATIONS as string[]),
        gte(folderState.updatedAt, since),
        accountId === null ? undefined : eq(messages.accountId, accountId),
      ))
      .orderBy(asc(folderState.updatedAt), asc(folderState.messageId))
      .limit(UNSUB_DRAIN_SCAN_PAGE)
      .as("scan_page");
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

    // The account list is the candidate query one level up, grouped: an account is owed something
    // iff it has a candidate in the window. OLDEST CANDIDATE FIRST, so the rows closest to
    // falling out of the window are reached first, and LIMITed — a run's account list is as
    // unbounded as its target list if nobody says otherwise.
    //
    // The switch predicate here is an OPTIMISATION and not a second decision-maker: it can only
    // REMOVE accounts, never admit one, and `postEach` reads the switch at the seam exactly as it
    // does for an interactive screen-out. Without it a blocked account's candidates would hold a
    // place in every run until they aged out of the window, which is starvation with a bound
    // rather than none — the bound is not the argument for leaving it.
    const page = this.scanPage(tx, since, null);
    const oldest = sql<string>`min(${page.at})`;
    const owed = await tx.select({ accountId: page.accountId })
      .from(page)
      .innerJoin(messageBodies, eq(messageBodies.messageId, page.messageId))
      .leftJoin(unsubscribeRecords, eq(unsubscribeRecords.messageId, page.messageId))
      .leftJoin(accountSettings, eq(accountSettings.accountId, page.accountId))
      .where(and(
        isNull(unsubscribeRecords.id),
        isNull(accountSettings.blockAutoUnsubscribeAt),
        sql`jsonb_exists(${messageBodies.headers}, 'list-unsubscribe')`,
        sql`jsonb_exists(${messageBodies.headers}, 'list-unsubscribe-post')`,
      ))
      .groupBy(page.accountId)
      .orderBy(asc(oldest))
      .limit(accounts);

    const sweep: UnsubscribeSweep = {
      considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0,
    };
    let visited = 0;
    for (const row of owed) {
      // The SAME budget every segment reads, not a slice handed down: an account entered with
      // less than one item's worth left is the next tick's, not this one's half-run.
      if (budget.postingLeftMs() < UNSUB_ITEM_MIN_MS) break;
      visited += 1;
      const one = await this.sweepScreenedOut(
        { db, accountId: row.accountId, userId: null, now: opts.now, requestId: opts.requestId },
        { since, limit: perAccount, budget },
      );
      sweep.considered += one.considered;
      sweep.posted += one.posted;
      sweep.skipped += one.skipped;
      sweep.failed += one.failed;
      sweep.remaining += one.remaining;
    }

    // WHAT IS STILL OWED, COUNTED RATHER THAN INFERRED — the reserve this budget holds back exists
    // for this one read. The old answer was a boolean assembled from three guesses (the clock cut
    // us short, an account left targets, the account list came back full), which cannot tell an
    // operator whether a pass is keeping up; this is the number the health row carries.
    const remaining = await this.owedCount(tx, since);

    return { accounts: visited, sweep, remaining, elapsedMs: budget.elapsedMs() };
  }

  /** How many candidates the window still holds for anyone — the closing read, one page-fenced scan. */
  private async owedCount(tx: Tx, since: Date): Promise<number> {
    const page = this.scanPage(tx, since, null);
    const [row] = await tx.select({ n: sql<number>`count(*)::int` })
      .from(page)
      .innerJoin(messageBodies, eq(messageBodies.messageId, page.messageId))
      .leftJoin(unsubscribeRecords, eq(unsubscribeRecords.messageId, page.messageId))
      .leftJoin(accountSettings, eq(accountSettings.accountId, page.accountId))
      .where(and(
        isNull(unsubscribeRecords.id),
        isNull(accountSettings.blockAutoUnsubscribeAt),
        sql`jsonb_exists(${messageBodies.headers}, 'list-unsubscribe')`,
        sql`jsonb_exists(${messageBodies.headers}, 'list-unsubscribe-post')`,
      ));
    return Number(row?.n ?? 0);
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
  ): Promise<string | null> {
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
    return claimed[0]?.id ?? null;
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
    })
      .from(messages)
      .leftJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .leftJoin(folderState, eq(folderState.messageId, messages.id))
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
      headers, desiredFolder: row.desiredFolder,
    };
  }
}

export function makeUnsubscribeService(deps: UnsubscribeDeps): UnsubscribeService {
  return new UnsubscribeService(deps);
}
