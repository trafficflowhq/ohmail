import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  assertOrganizerRole,
  accountSettings, messages, messageBodies, folderState, unsubscribeRecords, type Tx,
} from "@trafficflow/db";
import {
  authVerdictFromHeaders, oneClickUnsubscribeUri, unsubscribeHeaderState,
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
  post(url: string, pin: readonly string[]): Promise<{ status: number }>;
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
  const timeoutMs = opts.timeoutMs ?? ONE_CLICK_TIMEOUT_MS;
  return {
    async post(url: string, pin: readonly string[]) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
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
 * HOW FAR BACK THE DRAIN LOOKS. `since` has no default by design — a mature mailbox holds
 * thousands of pre-feature screen-outs and sweeping them would announce the address to the very
 * senders it was screened away from — and a scheduled pass has nobody to type a date. This is
 * that date, DERIVED rather than chosen: three of the drain's own cadences — one hour, the
 * cadence its production caller is scheduled at — so two missed runs still reach what the last
 * one deferred, plus a 24-hour envelope for an outage of the host that runs it. It reaches what a
 * RECENT request deferred and never the historical backlog. What makes a row eligible at all is
 * the COMMITTED decision: `folder_state.desired_folder` is written in the decision's own
 * transaction, so a decision that did not commit has no candidate here.
 *
 * The outage envelope is the part that is DECLARED rather than measured: how long this
 * deployment has actually been dark in one stretch is a reading the 0.19.1 rig does not take
 * yet, and it is filed as owed. Twenty-four hours is above every outage this deployment has had.
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
export const UNSUB_DRAIN_BUDGET_MS = 45_000;

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
      ({ status } = await this.deps.post.post(url!, pin));
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
    // NO CEILING HERE YET, AND THE ORDER IS THE POINT. A cap on this path without a drain behind
    // it converts an over-long request into silently unfinished work — the row this closes says
    // so in its own words, and the drain has no production caller until it is wired. The
    // parameter exists so that the cap is a two-value change with a control, made in the commit
    // that can honestly promise the remainder is picked up.
    return this.postEach(ctx, messageIds, {
      count: messageIds.length, budgetMs: Number.POSITIVE_INFINITY,
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
    ceiling: { count: number; budgetMs: number },
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

    // The clock starts at the first post, not at the ceiling's declaration: the switch read above
    // is the caller's cost, not this budget's.
    const startedAt = Date.now();
    for (const id of messageIds) {
      // BOTH AXES, CHECKED BEFORE THE POST AND NEVER AFTER IT. A count-only ceiling leaves five
      // eight-second posts inside a request that has twenty seconds left; a clock-only one lets a
      // mailbox whose targets all refuse instantly walk the whole list. Whatever is left when
      // either fires is `remaining`, which is a promise the drain keeps.
      if (sweep.considered >= ceiling.count || Date.now() - startedAt >= ceiling.budgetMs) {
        sweep.remaining += 1;
        continue;
      }
      sweep.considered += 1;
      try {
        // `"automatic"`, which is what turns on the identity gate above. The button calls
        // `unsubscribe()` and does not get it.
        const result = await this.run(ctx, id, "automatic");
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
    ctx: ServiceContext, opts: { since: Date; limit: number; budgetMs?: number },
  ): Promise<UnsubscribeSweep> {
    if (!(opts.since instanceof Date) || Number.isNaN(opts.since.getTime())) {
      throw new ServiceError("unsubscribe_no_cutoff", 400,
        "a sweep needs an explicit cutoff — there is no default, by design");
    }
    if (!Number.isInteger(opts.limit) || opts.limit < 1) {
      throw new ServiceError("unsubscribe_no_limit", 400, "a sweep needs an explicit positive limit");
    }

    // LEFT JOIN … IS NULL rather than NOT IN (…): the record is keyed by (mailbox, list) and the
    // list key is only knowable from the message's headers, so the candidate query cannot filter
    // on it. It filters on the MESSAGE not yet having supplied a record, and `unsubscribe`'s
    // claim does the real de-duplication a moment later against the key that actually matters.
    // This join is an optimisation; the unique index is the correctness.
    //
    // THE TWO HEADER KEYS, AND WHY A DRAIN WITHOUT THEM IS DECORATIVE. `run()` refuses a message
    // with no `List-Unsubscribe`, or one whose `-Post` is missing, BEFORE the claim — so no
    // record row is written and the message stays a candidate for ever. Most screened-out mail
    // publishes no one-click route at all, so a bounded pass would spend its whole budget
    // re-refusing the same rows and never reach what a request deferred. These are KEY EXISTENCE
    // tests and not a second copy of the grammar: `list-unsubscribe-post` present at all is RFC
    // 8058's own precondition, and every value question stays in the parser that owns it. What
    // still survives a pass is the malformed shape — a `-Post` over `mailto:` only — and the
    // window is what bounds that.
    const candidates = await asTx(ctx).select({ id: messages.id })
      .from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      // INNER, not LEFT: the headers live on the body row, and a message with no body row has no
      // headers, so it can never be actionable. Its absence is a filter, not a missing value.
      .innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .leftJoin(unsubscribeRecords, eq(unsubscribeRecords.messageId, messages.id))
      .where(and(
        eq(messages.accountId, ctx.accountId),
        inArray(folderState.desiredFolder, REJECT_DESTINATIONS as string[]),
        gte(folderState.updatedAt, opts.since),
        isNull(unsubscribeRecords.id),
        sql`jsonb_exists(${messageBodies.headers}, 'list-unsubscribe')`,
        sql`jsonb_exists(${messageBodies.headers}, 'list-unsubscribe-post')`,
      ))
      // OLDEST FIRST. An unordered LIMIT is a sample, and a sample can hand back the same rows
      // for ever while the oldest never move — here that would mean the rows closest to falling
      // out of the drain's window are the ones it never reaches.
      .orderBy(asc(folderState.updatedAt), asc(messages.id))
      .limit(opts.limit);

    return this.postEach(ctx, candidates.map((c) => c.id), {
      count: opts.limit, budgetMs: opts.budgetMs ?? UNSUB_DRAIN_BUDGET_MS,
    });
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
      accounts?: number; perAccount?: number; budgetMs?: number;
    },
  ): Promise<{ accounts: number; sweep: UnsubscribeSweep; remaining: boolean }> {
    const accounts = opts.accounts ?? UNSUB_DRAIN_ACCOUNTS_PER_RUN;
    const perAccount = opts.perAccount ?? UNSUB_DRAIN_TARGETS_PER_ACCOUNT;
    const budgetMs = opts.budgetMs ?? UNSUB_DRAIN_BUDGET_MS;
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
    const oldest = sql<string>`min(${folderState.updatedAt})`;
    const owed = await tx.select({ accountId: messages.accountId })
      .from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
      .leftJoin(unsubscribeRecords, eq(unsubscribeRecords.messageId, messages.id))
      .leftJoin(accountSettings, eq(accountSettings.accountId, messages.accountId))
      .where(and(
        inArray(folderState.desiredFolder, REJECT_DESTINATIONS as string[]),
        gte(folderState.updatedAt, since),
        isNull(unsubscribeRecords.id),
        isNull(accountSettings.blockAutoUnsubscribeAt),
        sql`jsonb_exists(${messageBodies.headers}, 'list-unsubscribe')`,
        sql`jsonb_exists(${messageBodies.headers}, 'list-unsubscribe-post')`,
      ))
      .groupBy(messages.accountId)
      .orderBy(asc(oldest))
      .limit(accounts);

    const sweep: UnsubscribeSweep = {
      considered: 0, posted: 0, skipped: 0, failed: 0, remaining: 0,
    };
    const startedAt = Date.now();
    let visited = 0;
    let cutShort = false;
    for (const row of owed) {
      const spent = Date.now() - startedAt;
      if (spent >= budgetMs) { cutShort = true; break; }
      visited += 1;
      const one = await this.sweepScreenedOut(
        { db, accountId: row.accountId, userId: null, now: opts.now, requestId: opts.requestId },
        { since, limit: perAccount, budgetMs: budgetMs - spent },
      );
      sweep.considered += one.considered;
      sweep.posted += one.posted;
      sweep.skipped += one.skipped;
      sweep.failed += one.failed;
      sweep.remaining += one.remaining;
    }

    // WHETHER ANYTHING IS STILL OWED, stated rather than inferred by the caller: the clock cut
    // this run short, an account's own ceiling left targets behind, or the account list came back
    // full and there may be another behind it. The next run picks up where this one stopped.
    return {
      accounts: visited,
      sweep,
      remaining: cutShort || sweep.remaining > 0 || owed.length >= accounts,
    };
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
