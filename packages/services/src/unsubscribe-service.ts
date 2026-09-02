import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import {
  assertOrganizerRole,
  accountSettings, messages, messageBodies, folderState, unsubscribeRecords, type Tx,
} from "@trafficflow/db";
import {
  authVerdictFromHeaders, oneClickUnsubscribeUri, unsubscribeHeaderState,
  type AuthVerdict, type Destination, type UnsubscribeHeaderState,
} from "@trafficflow/core/mail";
import type { ServiceContext } from "./context.js";
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
 * ── THE OUTBOUND PORT, AND WHY ITS SIGNATURE IS A GUARANTEE ───────────────────────────────────
 *
 * `post(url, pin)` takes the URL and the validated address(es) to connect to, and NOTHING ELSE.
 * There is no headers bag, no body parameter, no request object — so there is no parameter through
 * which the user's IP, cookies, referer, address or message could reach the sender. `pin` is not
 * caller data: it is the output of {@link assertPublicHttpUrl}, the addresses that gate already
 * cleared, and it is here so the POST connects to a PRE-VALIDATED address rather than re-resolving
 * the sender's hostname — the DNS-rebinding hole a bare re-resolving fetch would leave open.
 * {@link ONE_CLICK_BODY} is fixed by the implementation, so "what we sent" is a property of this
 * module and not of its caller.
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
  post(url: string, pin: readonly string[]): Promise<{ status: number }>;
}

/**
 * Production {@link OneClickPost}.
 *
 * The POST is PINNED to the address the SSRF gate validated (see `pinned-fetch.ts`), so a sender
 * whose name resolved to a public address for {@link assertPublicHttpUrl} cannot have the POST
 * land on a private one — the DNS-rebinding hole a re-resolving fetch would leave open. Redirects
 * are never followed, which the stdlib client gives for free: a sender who answers `302 Location:
 * http://169.254.169.254/` gets that 3xx returned as-is and treated as a refusal, with no second
 * connection opened by anyone.
 *
 * The response BODY is discarded unread. We have no use for whatever a sender writes back, and not
 * reading it is one less piece of attacker-chosen data in the process.
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
   * MESSAGE from the mailbox that holds it.
   *
   * This replaced `trustedAuthservIds: ReadonlySet<string>` — one set for the whole deployment —
   * because the trusted position is a fact about the provider serving EACH mailbox, and one
   * service instance serves mailboxes at different providers. The deployment-wide set had
   * exactly one production value, the empty set, which made `authVerdictFromHeaders` answer
   * `"unavailable"` for every message and left the `author_failed_authentication` refusal
   * unreachable: a forged `From` could choose whose list the button leaves.
   *
   * **Still required, and still never defaulted** — the absent-config default is the dangerous
   * branch. Production wires `adapters/drizzle-repo.ts#mailboxProviderAuthservIds`, which reads
   * the IMAP host off the mailbox's own credential row (one indexed PK read per unsubscribe) and
   * maps it through the provider table; a caller that has decided to trust nothing types
   * `async () => NO_TRUSTED_AUTHSERV_IDS`. See `rules.ts#authVerdictFromHeaders` for what the
   * set means.
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
 * ── THE IDEMPOTENCY KEY, AND THE IDENTITY IT IS BOUND TO ──────────────────────────────────────
 *
 * The record table's uniqueness is `(mailbox_id, list_key)`, and everything the feature promises
 * — at most one request per list, per mailbox, ever — rests on this function returning the same
 * string for two messages that belong to the same subscription and different strings otherwise.
 *
 * **AND ON ONE MORE THING THIS FUNCTION USED TO GET WRONG: no sender may produce another
 * sender's key.** An at-most-once key is a scarce resource, so whoever can name it can EXHAUST
 * it. That half is written out below because it is the half that was missing.
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
 * **AND NOT RFC 2919 `List-ID` ALONE — WHICH IS WHAT IT WAS, AND WHICH WAS A DENIAL OF SERVICE
 * ON A STRANGER'S UNSUBSCRIBE.** This function took `fromAddress` and, whenever a `List-ID`
 * existed, ignored it. `List-ID` is a header the SENDER writes, so the key was a string the
 * sender chose freely:
 *
 *   1. An attacker sends ordinary mail from `evil.example`, a domain they legitimately own and
 *      pass DKIM/DMARC for — **no forgery anywhere** — carrying `List-ID: <news.victim.example>`
 *      and their own one-click URL.
 *   2. One ordinary screen-out of that sender claims `(mailbox, list:news.victim.example)`.
 *   3. A genuine message from the real `news.victim.example` is later screened out, derives the
 *      same key, loses the `ON CONFLICT`, and is answered `already_recorded`.
 *   4. **The real list's unsubscribe URL is never called, for the life of that mailbox.**
 *
 * The prefixes were not the defence they looked like: `list:`/`addr:` stop the two NAMESPACES
 * colliding, which is a different question from whether one sender can occupy another's slot
 * inside one namespace.
 *
 * **SO THE KEY IS NAMESPACED BY THE CLAIMED AUTHOR'S DOMAIN: `list:<from-domain>|<List-ID>`.**
 * The `List-ID` still does the work it was chosen for — it is the sender's own stable name for
 * the list, so one address carrying several lists yields several keys and several addresses
 * carrying one list still collapse to one — but it can only ever name a slot inside the domain
 * the message claims to come from. `evil.example` cannot reach `victim.example`'s slot, whatever
 * it writes in its own headers.
 *
 * **WHY THE DOMAIN AND NOT THE VERIFIED SIGNING DOMAIN.** Because the signing domain is not
 * knowable here for most mail, and pretending otherwise would ship a binding that is inert:
 * `authVerdictFromHeaders` answers `"unavailable"` whenever the mailbox's provider has no trusted
 * authserv-id, which measured against the production corpus is **every message** — 75 165
 * `unavailable`, 11 112 unset, and not one `pass` or `fail`. A key derived from a cryptographic
 * verdict would therefore have had exactly one value in production, which is no namespace at all.
 * The claimed domain is what the product can bind to unconditionally; whether that claim is
 * VERIFIED is a separate gate, and it lives at the automatic entry point rather than in the key
 * (see {@link UnsubscribeService.onScreenOut}).
 *
 * **THE RESIDUAL, STATED.** A sender who FORGES `From: @victim.example` still derives the
 * victim's namespace. That needs forgery plus a deployment whose provider vouches for nothing,
 * and it is the same residual the `authVerdict === "fail"` gate already carries — it is not
 * closed here and must not be read as closed. What IS closed is the no-forgery attack above,
 * unconditionally and in every deployment.
 *
 * **THE SECOND RESIDUAL, FOUND BY REVIEW AND ACCEPTED RATHER THAN CLOSED: A LIST WHOSE POSTERS
 * KEEP THEIR OWN `From` DOMAIN NO LONGER COLLAPSES TO ONE CLAIM.** Some mailing-list software
 * preserves each poster's original `From` while the list infrastructure injects one shared
 * `List-ID` and one shared one-click route — a discussion list rather than a newsletter. Under
 * this key, `alice@a.example` and `bob@b.example` posting to the SAME list now derive TWO keys,
 * not one, so the automatic pass may send an RFC 8058 POST once per author domain actually seen
 * rather than once per list.
 *
 * **NOT REVERSED, because reversing it reopens the vulnerability this whole function exists for.**
 * Any rule that collapses two different claimed domains onto one key — "same List-ID, any
 * domain" — is EXACTLY the rule an attacker exploits: `evil.example` carrying the victim's
 * `List-ID` would once again match whatever the victim's real domain claims, because nothing
 * distinguishes "a second legitimate poster" from "a hostile domain claiming the same list name"
 * without an authenticated signal, and an authenticated signal is unavailable for the entire
 * production corpus (above). There is no version of this key that is BOTH domain-independent and
 * closed against the sender-chosen-key attack; picking one is picking which failure mode to keep.
 *
 * **WHAT "BOUNDED" DOES NOT MEAN HERE — CORRECTED BY A SECOND REVIEW ROUND, WHICH IS THE REASON
 * THIS PARAGRAPH DOES NOT SAY "HARMLESS".** The first version of this note leaned on "RFC 8058
 * requests are idempotent at the sender" — true of RETRYING the SAME request (this file's own
 * `onScreenOut` doc, and the standing project decision that `POST /messages/:id/unsubscribe` is
 * not idempotent because "a repeat POST re-sends the same RFC 8058 request, which is what a mail
 * client's own button does"). It does NOT cover this case: a one-click URL normally carries a
 * PER-MESSAGE opaque token, so Alice's and Bob's messages POST to two DIFFERENT URLs. These are
 * not a replay of one request — they are two DISTINCT requests, and nothing here can promise a
 * third party's system treats "confirm from token A" and "confirm from token B" for the same
 * underlying subscription identically. **In the fully adversarial-shaped case — a discussion list
 * whose every poster happens to use a distinct domain — this key provides NO deduplication at
 * all: N messages derive N keys and N sends, exactly the per-message granularity `unsubscribeListKey`
 * was written to avoid**, proven rather than asserted by the all-distinct-domain regression
 * alongside the mixed-domain one.
 *
 * **WHY THIS DIRECTION IS STILL THE RIGHT ONE TO KEEP, ARGUED ON THE ASYMMETRY THAT ACTUALLY
 * HOLDS.** Not "the fan-out is harmless" — that a repeated send to a legitimate, real third party
 * costs at most a redundant unsubscribe confirmation at THEIR system, for a recipient who already
 * asked to leave the list, is a bounded, recoverable, self-correcting cost even without an
 * idempotency guarantee. A silenced victim list is neither: the mailbox never asks again, ever,
 * for the life of that mailbox. Over-splitting is bounded by the number of distinct domains a
 * list's own posters actually use (which the mixed-domain and all-distinct-domain regressions
 * both measure directly rather than assume); under-splitting is unbounded in the worst
 * direction — permanent. That asymmetry, not a claim of harmlessness, is the whole argument.
 *
 * **THE COST OF CHANGING THE KEY, MEASURED.** Old `list:<id>` rows no longer match the key their
 * list now derives — 58 rows across 5 mailboxes in production. Each may cost ONE further
 * one-click POST the next time a message from that list is screened out; RFC 8058 requests are
 * idempotent at the sender, and the alternative (a partial SQL rewrite of keys whose From domain
 * is only reachable through a `message_id` that deliberately carries no foreign key) could
 * collide under the unique index. Deliberately NOT reconciled, and deliberately no
 * read-the-old-key-too compatibility check: **any key an attacker has already burned is released
 * by this change**, which is the point.
 *
 * `lower(from_address)` remains the fallback for a sender that publishes `List-Unsubscribe` and
 * `List-Unsubscribe-Post` but no `List-ID` — unusual but permitted, and refusing to act on one
 * would let a sender defeat the whole feature by omitting a header. It needs no namespacing of
 * its own: the full address already contains the domain, so it was already bound to the claimed
 * author, and its bytes are unchanged so no existing `addr:` record is orphaned.
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

    /* -- A READER SENDS NO UNSUBSCRIBE (mail 0083) -----------------------------------------
     *
     * An RFC 8058 one-click POST is an IRREVERSIBLE outbound request made in the mailbox owner's
     * name to a third party, and it is made on behalf of an ORGANIZING decision: the automatic
     * arm fires on a screen-out, and the manual arm is a person acting on mail this install is
     * arranging. On a mailbox another install organizes, the decision that justifies it is not
     * ours to have taken.
     *
     * BOTH ARMS, deliberately — this is the shared body and the check is here rather than on
     * `unsubscribe()` alone. The automatic arm is already unreachable for a reader (its trigger
     * is `decide`, which is refused), so the manual one is the arm this actually closes; putting
     * the check in the shared body is what keeps a third entry point from being added past it.
     *
     * PER MAILBOX: `row.mailboxId` is already loaded and is used one line below for the trust
     * set, so this costs one indexed read on a row this request has already touched.
     */
    await assertOrganizerRole(asTx(ctx), ctx.accountId, row.mailboxId);

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

    // ── THE AUTOMATIC PASS WANTS A VOUCHED-FOR AUTHOR, THE BUTTON DOES NOT ────────────────
    //
    // `unsubscribeListKey` namespaces a `list:` claim under the CLAIMED author domain, which
    // stops one sender occupying another's slot without any forgery. The residual it cannot
    // close is a FORGED `From`: a message claiming `@victim.example` derives the victim's
    // namespace. This gate is that residual's other half, and it is deliberately narrow in two
    // directions:
    //
    //  · **Automatic only.** `unsubscribe()` is the per-message button — a person looking at the
    //    mail in front of them, who can see who it claims to be from. `onScreenOut` is a pass
    //    nobody is watching, so it is the one that must be conservative. This mirrors the account
    //    switch a few lines down, which gates the automatic pass and deliberately not the button.
    //  · **Only where the claim is CHECKABLE.** `identityCheckable` is false whenever the
    //    mailbox's provider has no trusted authserv-id, and refusing there would not be caution —
    //    it would silently retire the feature. Measured against the production corpus,
    //    `auth_verdict` is `unavailable` or unset for EVERY message (75 165 / 11 112; not one
    //    `pass`, not one `fail`), so a gate that demanded a `pass` unconditionally would refuse
    //    100% of real traffic while reading like hardening.
    //
    // **SO, STATED PLAINLY: THIS GATE IS INERT IN PRODUCTION TODAY.** It fires the day
    // `authserv-ids.ts#providerAuthservIds` resolves a real authserv-id for a mailbox's IMAP
    // host, and not before. It is written now because the alternative is writing it later, under
    // the belief that the key's namespacing already covered forgery — which it does not. The
    // tests inject a trusted set precisely so the branch is EXECUTED rather than shipped unrun.
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

    // ── THE ACCOUNT SWITCH, READ HERE AND NOWHERE ELSE (mail 0054) ────────────────────────
    //
    // `account_settings.block_auto_unsubscribe_at` NOT NULL means this account asked that a
    // screen-out stop leaving lists on their behalf. The read is at the TOP of the automatic
    // entry point, before the loop, for three reasons that are each independent:
    //
    //  1. **It is the seam, not the surface.** The client is told what will happen by the same
    //     flag, but a client is a description and this is the decision. A build that never got
    //     the setting, a stale tab, a script calling the API directly — none of them can make a
    //     request go out that this row forbids, because the request is made here.
    //  2. **`unsubscribe()` is deliberately NOT gated.** That is the per-message button: a person
    //     pressing unsubscribe on mail in front of them. A switch labelled "auto" that also
    //     disabled a manual control would be a control whose label lies, and the label is the
    //     whole contract. `sweepScreenedOut` IS gated, because it comes through here.
    //  3. **Once, not per message.** A screen-out on a domain hands over every held message from
    //     every sender under it; one row read for the pass is the same answer for all of them and
    //     cannot go half-applied between two ids.
    //
    // The zero sweep is the honest return. `considered` counts what the pass LOOKED at, and it
    // looked at nothing: reporting `considered: n, skipped: n` would put this account's opt-out
    // in the same bucket as the healthy majority of screen-outs whose senders publish no
    // one-click route at all, which is precisely the conflation `UnsubscribeSweep`'s own note
    // refuses between `skipped` and `failed`.
    if (await this.blocked(ctx)) return sweep;

    for (const id of messageIds) {
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
   * HAS THIS ACCOUNT TURNED THE AUTOMATIC PASS OFF? (mail 0054)
   *
   * One column, one row, primary key. `true` iff `block_auto_unsubscribe_at IS NOT NULL`.
   *
   * **An absent row is FALSE — the pass runs — and that is the product default rather than a
   * lenient fallback.** `account_settings` rows are created lazily by whichever feature writes
   * first, so most accounts have never had one; reading "no row" as "turned off" would switch a
   * shipping behaviour off for everybody who has not opened Settings, which is the same mistake
   * the migration refuses to make by storing the opt-out instead of an opt-in.
   *
   * ── A FAILED READ ANSWERS `true`, AND THE TRY/CATCH IS LOAD-BEARING TWICE ─────────────────
   *
   * `onScreenOut`'s contract is that it NEVER throws — its one production caller,
   * `screener-service.ts#decide`, awaits it after the commit with no `try` of its own, so an
   * escaping error would turn a screen-out that has already durably committed into a 500. This is
   * the only `await` in `onScreenOut` outside the per-message loop that already catches, so
   * without this `catch` the guard would have opened exactly that hole while adding a switch.
   *
   * It answers `true` — do not send — rather than falling through to the default. The two are not
   * symmetric: not sending is recoverable (the next message from that list is still a candidate,
   * because a blocked pass writes no record row), and sending is not. A 42703 from an API deployed
   * ahead of the migration lands here too, which is the case `/health`'s marker exists to make
   * loud rather than leave to this branch.
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
