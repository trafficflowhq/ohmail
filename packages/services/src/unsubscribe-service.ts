import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import {
  messages, messageBodies, folderState, unsubscribeRecords, type Tx,
} from "@trafficflow/db";
import {
  authVerdictFromHeaders, oneClickUnsubscribeUri, unsubscribeHeaderState,
  type AuthVerdict, type Destination, type UnsubscribeHeaderState,
} from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { assertPublicHttpUrl, type HostResolver } from "./ssrf-guard.js";

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
 * ── THE OUTBOUND PORT, AND WHY ITS SIGNATURE IS A GUARANTEE ───────────────────────────────────
 *
 * `post(url)` takes the URL and NOTHING ELSE. There is no headers bag, no body parameter, no
 * request object — so there is no parameter through which the user's IP, cookies, referer,
 * address or message could reach the sender. {@link ONE_CLICK_BODY} is fixed by the
 * implementation, so "what we sent" is a property of this module and not of its caller.
 *
 * This mirrors `PrivacyService`'s `RemoteFetch` deliberately: this repository has one shape for
 * "a server-side fetch on the user's behalf" and a second one would be a second thing to keep
 * correct. It is a separate port only because `RemoteFetch` cannot POST.
 *
 * **There is no mail port here and there must never be one.** A `mailto:` unsubscribe would mean
 * sending mail on the user's behalf to a third party, which is prohibited; the parser refuses one
 * (`rules.ts#oneClickUnsubscribeUri`), and the absence of any SMTP dependency in this file is the
 * structural half of the same rule — a defeated parser still could not send.
 */
export interface OneClickPost {
  post(url: string): Promise<{ status: number }>;
}

/**
 * Production {@link OneClickPost}.
 *
 * `redirect: "manual"` is load-bearing for the same reason it is on the image proxy:
 * {@link assertPublicHttpUrl} can only ever speak about the URL it was handed, and a sender who
 * answers `302 Location: http://169.254.169.254/` would otherwise have undici open that second
 * connection with nobody having looked at it. A 3xx is returned as-is and treated as a refusal.
 *
 * The response BODY is cancelled unread. We have no use for whatever a sender writes back, and
 * not reading it is one less piece of attacker-chosen data in the process.
 */
export function makeNodeOneClickPost(opts: { timeoutMs?: number } = {}): OneClickPost {
  const timeoutMs = opts.timeoutMs ?? ONE_CLICK_TIMEOUT_MS;
  return {
    async post(url: string) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method: "POST",
          redirect: "manual",
          referrer: "",
          signal: ac.signal,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            // Leaves the building on every unsubscribe, so it is a PUBLIC brand surface.
            "user-agent": "ohmail-Unsubscribe/1.0",
          },
          body: ONE_CLICK_BODY,
        });
        await res.body?.cancel().catch(() => {});
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
   * The authserv-ids the ACCOUNT'S OWN provider signs `Authentication-Results` with, lowercased.
   *
   * **Required, and EMPTY is the correct value for a deployment that has not named its
   * provider.** Empty means every message resolves to `"unavailable"`, which is permissive, so
   * turning this service on changes no routing and blocks no unsubscribe until somebody makes an
   * explicit decision about whose report to believe. See `rules.ts#authVerdictFromHeaders`.
   *
   * It is injected rather than read from `mailboxes` because there is no column for it: adding
   * one is a hand-written migration, and this slice was not permitted to write one.
   */
  trustedAuthservIds: ReadonlySet<string>;
}

/** Why an unsubscribe was refused. `null` on the {@link UnsubscribeResult} of a success. */
export type UnsubscribeRefusal =
  /** The user has not decided about this sender yet, or actively wants their mail. */
  | "not_actionable"
  /** The account's own provider reported an authentication failure for the claimed author. */
  | "author_failed_authentication"
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
}

/**
 * ── WHICH MESSAGES MAY BE UNSUBSCRIBED FROM: REJECT DESTINATIONS ONLY ─────────────────────────
 *
 * **THE RULE IS: REJECT DESTINATIONS ONLY, NEVER KEEP DESTINATIONS.** The user's consent to
 * leave a list is the decision they already made about the sender, and only a rejection is that
 * decision.
 *
 *  · `ohmail/Screened` and `ohmail/Quarantine` — the user said no. Every reject path lands in
 *    one of these two: the Screener's spam verb, an explicit screen-out, a block rule. That is
 *    why this set is two folders and not five verbs — `folder_state.desired_folder` is the one
 *    sink all of them write, so naming the destinations covers every route to them, including
 *    ones added later.
 *
 * Absent from the set, deliberately:
 *
 *  · `ohmail/Reads` — **THIS WAS IN THE SET AND HAS BEEN REMOVED.** An earlier design offered it
 *    on Reads too; that was withdrawn. Reads is mail the user CHOSE TO KEEP, so unsubscribing
 *    from it inverts the very decision that put it there.
 *  · `ohmail/Receipts` — removed with it, on the same reasoning and with a sharper edge: it
 *    holds order confirmations, invoices and delivery notices. A sender unsubscribed here stops
 *    sending the receipt for a purchase the user has ALREADY MADE, which is unrecoverable in a
 *    way a missed newsletter is not.
 *  · `ohmail/Screener` — the user has NOT decided. Acting here would make first contact itself
 *    an unsubscribe, which is the consent gate running backwards.
 *  · `INBOX` — the user's real mail. Nothing here should ever leave a list on their behalf.
 *
 * These five are the whole `Destination` union, so the set is exhaustive by construction rather
 * than by hoping nobody adds a sixth folder without reading this.
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

/**
 * ── THE IDEMPOTENCY KEY, AND THE TWO THINGS IT DELIBERATELY IS NOT ────────────────────────────
 *
 * The record table's uniqueness is `(mailbox_id, list_key)`, and everything the feature promises
 * — at most one request per list, per mailbox, ever — rests on this function returning the same
 * string for two messages that belong to the same subscription and different strings otherwise.
 *
 * **NOT THE UNSUBSCRIBE URL.** It is the most specific thing available and it is not a key at
 * all: a one-click URL normally carries a per-message opaque token (`…/u?t=<random>`), so a
 * URL-keyed record mints a fresh key for every message and sends once per message. That is the
 * exact defect the table exists to prevent, reintroduced by the choice that looks most precise.
 *
 * **NOT `from_address` ALONE.** A common counter-example: a mailbox receives
 * `no-reply-<opaque>@example.com`, a per-send address from a sender the user experiences as one
 * list. Keyed on `From`, every message would be a new list.
 *
 * **SO: RFC 2919 `List-ID` first.** It is the sender's OWN stable name for the list, which is
 * precisely the thing being left, and it is right in both directions — one address carrying
 * several lists yields several keys (genuinely several subscriptions), several addresses
 * carrying one list collapse to one (genuinely one subscription).
 *
 * `lower(from_address)` is the fallback and nothing more. A bulk sender that publishes
 * `List-Unsubscribe` and `List-Unsubscribe-Post` but no `List-ID` is unusual but permitted, and
 * refusing to act on one would let a sender defeat the whole feature by omitting a header — the
 * "absent evidence selects the acting branch" mistake pointed the other way.
 *
 * The `list:` / `addr:` prefixes keep the two namespaces from ever colliding: without them a
 * sender could publish `List-ID: <news@sender.example>` and claim the key another sender's From
 * address would produce.
 */
export function unsubscribeListKey(
  headers: Readonly<Record<string, unknown>>, fromAddress: string,
): string {
  const listId = firstHeaderValue(headers, LIST_ID_HEADER);
  if (listId !== null) {
    // `List-Id: Friendly Name <list.id.example.com>` — RFC 2919 §3 puts the identifier inside
    // the angle brackets and everything before it is a human-readable phrase the sender may
    // change at will. Keying on the phrase would make a renamed list a new list.
    const bracketed = /<([^>]+)>/.exec(listId);
    const identity = (bracketed?.[1] ?? listId).trim().toLowerCase();
    if (identity !== "") return `list:${identity}`;
  }
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
    const row = await this.load(ctx, messageId);

    const authVerdict = authVerdictFromHeaders(
      row.headers, row.fromAddress, this.deps.trustedAuthservIds,
    );
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

    // ── THE COUPLING THIS CHECK EXISTS TO CLOSE ───────────────────────────────────────────
    //
    // The unsubscribe URI is chosen by whoever wrote the message, and `From` is chosen by the
    // same person. If the claimed author is forged, the list we leave is a stranger's choice —
    // at best confirming to a spammer that this address is read, at worst carrying somebody
    // ELSE'S subscription token and unsubscribing a third party.
    //
    // Demote-only: an explicit failure from the account's own provider refuses. Absent evidence
    // does NOT — `"unavailable"` is the answer for every deployment that has not yet named its
    // provider, and refusing on it would make the feature dead on arrival while teaching the
    // codebase the exact "absence selects the destructive branch" habit that `rules.ts` spends a
    // page arguing against. The residual is stated in the report rather than hidden here.
    if (authVerdict === "fail") {
      refuse("author_failed_authentication", 409,
        "your provider reports that this message failed authentication for its claimed sender");
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
    // gate rejects is not evidence that a different URL for the same list would be safe.
    try {
      await assertPublicHttpUrl(url!, this.deps.resolver);
    } catch (err) {
      await this.settle(ctx, claim, { state: "refused", refusal: "ssrf_gate" });
      throw err;
    }

    let status: number;
    try {
      ({ status } = await this.deps.post.post(url!));
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
   * ── THE AUTOMATIC TRIGGER ─────────────────────────────────────────────────────────────────
   *
   * Called with the messages a screen-out just re-routed. This is the entry point that makes the
   * feature automatic rather than a button, and its contract is deliberately narrow:
   *
   * **IT NEVER THROWS, AND IT NEVER RETURNS AN ERROR THE CALLER MUST HANDLE.** The user's filing
   * decision is the product; the unsubscribe is a courtesy on top of it. A sender that times
   * out, a URL the SSRF gate refuses, a database that rejects the claim — none of those may
   * reach the caller, because the caller is a screen-out and a screen-out that fails because a
   * stranger's web server is down is a worse product than one that quietly does not unsubscribe.
   *
   * That is one of TWO independent mechanisms, and the second is stronger because it does not
   * depend on this function being written correctly: **call it AFTER the screen-out transaction
   * has committed.** Then a process that dies anywhere inside here leaves the screen-out durable,
   * because the screen-out was already durable before the first byte left the building. The
   * `try`/`catch` protects the response; the ordering protects the data.
   *
   * It filters to reject destinations itself rather than trusting the caller to have done so —
   * the caller is a screen-out path, and a screen-out path that one day also handles a promote
   * must not be able to turn this into an unsubscribe by passing the wrong ids.
   */
  async onScreenOut(ctx: ServiceContext, messageIds: readonly string[]): Promise<UnsubscribeSweep> {
    const sweep: UnsubscribeSweep = { considered: 0, posted: 0, skipped: 0, failed: 0 };
    for (const id of messageIds) {
      sweep.considered += 1;
      try {
        const result = await this.unsubscribe(ctx, id);
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
   * ── THE DRAIN, AND WHY IT REFUSES TO RUN WITHOUT A CUTOFF ─────────────────────────────────
   *
   * `folder_state.desired_folder` is the single sink every reject path writes — the Screener's
   * spam verb, an explicit screen-out, a block rule, the re-screen pass, ingest-time routing.
   * So the STATE is the queue: anything sitting in a reject destination without a record row is,
   * by definition, a screen-out this feature has not yet considered. Nothing has to be enqueued,
   * and a reject path added later is covered the day it is written rather than the day somebody
   * remembers to add a call to it.
   *
   * **`since` IS REQUIRED AND HAS NO DEFAULT, WHICH IS THE WHOLE SAFETY ARGUMENT.** A mature
   * mailbox can hold many thousands of senders screened out before this existed. A drain that
   * defaulted to "all of it" would, on its first run after one deploy, make thousands of outbound
   * requests to thousands of strangers — announcing this address to every one of them, including
   * the spam that was screened out precisely because nobody wanted it confirmed as live. Making
   * the cutoff a required argument means that sweep can only ever happen because somebody typed
   * the date.
   *
   * `limit` is required for the same reason at a smaller scale: an unbounded drain is a drain
   * whose blast radius is whatever the mailbox happens to contain.
   */
  async sweepScreenedOut(
    ctx: ServiceContext, opts: { since: Date; limit: number },
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
    const candidates = await asTx(ctx).select({ id: messages.id })
      .from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .leftJoin(unsubscribeRecords, eq(unsubscribeRecords.messageId, messages.id))
      .where(and(
        eq(messages.accountId, ctx.accountId),
        inArray(folderState.desiredFolder, REJECT_DESTINATIONS as string[]),
        gte(folderState.updatedAt, opts.since),
        isNull(unsubscribeRecords.id),
      ))
      .limit(opts.limit);

    return this.onScreenOut(ctx, candidates.map((c) => c.id));
  }

  /**
   * Win the right to send, or discover somebody already has it.
   *
   * `ON CONFLICT DO NOTHING … RETURNING` is the entire mutual exclusion. There is no
   * `SELECT … FOR UPDATE` because there is nothing to lock: the row does not exist yet, and a
   * read-then-write would have exactly the window this is written to close. Two transactions
   * inserting the same `(mailbox_id, list_key)` serialize on the unique index — the second
   * blocks until the first commits, then returns zero rows.
   *
   * `null` means "already recorded". It never means "an error happened".
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
