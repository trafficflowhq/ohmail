import { createHash } from "node:crypto";
import { autoReplySuppression, type AutoReplySuppression } from "./rules.js";
import { AWAY_SCREENER_FOLDER } from "./away-scope.js";

/**
 * MAY THE AWAY RESPONDER ANSWER THIS MESSAGE? — the whole suppression set, as one pure function
 * over one row, so that every guard can be deleted in place and watched to let a reply through.
 *
 * ── WHY THIS IS A MODULE AND NOT A LOOP BODY ────────────────────────────────────────────────
 *
 * The responder is the one thing in this product that sends mail with nobody looking, and its
 * safety argument is not "the pass is careful" — it is a SET OF NAMED GUARDS, each of which has
 * been watched to fire. That is only checkable if each guard is a branch a table test can reach
 * with a hand-built row. Buried in the pass's loop they would be reachable only through a database
 * fixture, an adapter and a clock, and the ones that are cheap to get wrong (the header verdict,
 * the screened-out folders) would be the ones nobody covered.
 *
 * The pass keeps exactly two decisions of its own, and neither is a suppression: CANDIDACY (the
 * WHERE clause — the episode floor, the ledger anti-join, the organizer JOIN) and the THROTTLE (an
 * atomic upsert, which is a property of the database and not of a row in hand). Everything else is
 * here.
 *
 * ── THE ORDER IS CHEAPEST-FIRST, AND IT IS PART OF THE CONTRACT ─────────────────────────────
 *
 * A caller reports the FIRST reason that holds, so the order decides which reason an operator sees
 * for a row that trips several. Cheapest first is also most-certain first: `own_address` is a set
 * membership over addresses we own, `already_replied` is a fact about the thread. A row that is
 * both our own address and a mailing list should read as `own_address`, because that is the fact
 * about it that would still be true if every other guard were removed.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────────────────────
 *
 * No database handle, no clock, no adapter, no logger. `already_replied` arrives as a decided
 * BOOLEAN and not as a query, because the query that establishes it (an own-authored message in
 * the same thread at or after this one) is the pass's, and a function that could reach the database
 * would be a function a table test could not drive.
 */

/**
 * The folders whose contents are NEVER answered, whatever the audience.
 *
 * ── `ohmail/Screened` IS NOT `ohmail/Screener`, AND THE DIFFERENCE IS THE WHOLE POINT ────────
 *
 * They are one letter apart and they mean opposite things. `ohmail/Screener` is where a stranger
 * WAITS — nobody has decided about them yet, and `audience='everyone'` exists precisely to answer
 * them. `ohmail/Screened` is where a sender this account has REJECTED goes: the "no" of the screening
 * decision, durably recorded. Quarantine is mail the pipeline judged hostile.
 *
 * So the two rejected states are audience-blind and the waiting state is not. Widening the audience
 * is a decision to answer people you have not yet met; it is not a decision to answer people you
 * have already turned away, and it is certainly not a decision to answer a phish — which would
 * confirm to whoever sent it that the address is live and attended.
 *
 * Two reasons rather than one (`screened_out` vs `not_screened_in`) because an operator reading
 * "we did not answer this" needs to know which of the two happened: one is permanent and one
 * changes the moment the sender is let in.
 */
export const AWAY_NEVER_ANSWERED_FOLDERS: Readonly<Record<string, AwaySuppression>> = {
  "ohmail/Screened": "screened_out",
  "ohmail/Quarantine": "screened_out",
  /*
   * RECEIPTS IS NOT HERE ANY MORE. It was, for one release, on the
   * reasoning that a receipt is machine mail about a transaction the account started — which is
   * true of most receipts and is enforced per HEADER by `neverAutoReply`, for every pile. What
   * this entry additionally refused was a receipt somebody typed, in a pile its owner had ticked,
   * and that is their choice to make. `ohmail/Receipts` is now an answerable pile, so the box has
   * an effect; the never-answered map keeps the two folders no setting may reach.
   */
};

/**
 * THE PILE VOCABULARY, RE-EXPORTED FROM THE LEAF THAT OWNS IT.
 *
 * It lives in `away-scope.ts` and not here because the settings control and the Ohbox banner need
 * the same members this rule refuses by, and they cannot load THIS file: {@link awayTextHash}
 * below imports `node:crypto`. Two lists that agree today is the shape the brief's own hard stop
 * names ("the designer's control offers a pile the engine refuses"), so there is one list and
 * both sides import it.
 *
 * Re-exported rather than merely imported so that every consumer already reaching for this
 * module's vocabulary — the pass, the service validator, the table test — keeps one import.
 */
export {
  AWAY_ANSWERABLE_PILES, AWAY_PILES_DEFAULT, AWAY_PILE_VIEW, AWAY_SCREENER_FOLDER,
  awayEffectivePiles, awayScopeFitsAudience, isAwayPile, type AwayPile,
} from "./away-scope.js";

/**
 * The piles a responder is configured to answer, as stored. `readonly string[]` and not
 * `readonly AwayPile[]`: the value arrives from a database column, so a member this build does
 * not know is representable in the type — and it is then refused by the `includes` test, which
 * is the fail-closed direction. Narrowing the parameter would move that decision to a cast.
 */
export type AwayPiles = readonly string[];

/**
 * WHY THIS MESSAGE GETS NO AUTOMATIC REPLY, or `null` when it may have one.
 *
 * Every member is reachable by {@link awayEligibility} from a hand-built row, and every member is
 * asserted by a mutation in `away-eligibility.test.ts` — the guard is deleted, the table goes red.
 */
export type AwaySuppression =
  | "not_an_address"
  | "own_address"
  | "sensitive"
  | "screened_out"
  | "not_screened_in"
  | "already_replied"
  /**
   * The two AWAY-ONLY header verdicts, and they are their own members rather than reusing
   * `auto_submitted` / `service_sender`.
   *
   * They were folded into those two at first, which contradicted this module's own rule one screen
   * up — "two reasons rather than one, because an operator reading 'we did not answer this' needs
   * to know which of the two happened". A stored `reason` of `auto_submitted` would have been
   * ambiguous between "the sender marked this message as automatic" (RFC 3834, the loop stop) and
   * "the sender's Exchange asked us not to auto-reply" (a policy header on ordinary human mail),
   * which are different facts with different remediations.
   *
   *  · `auto_reply_suppressed` — `X-Auto-Response-Suppress: OOF|AutoReply|All`.
   *  · `null_return_path` — an empty `Return-Path` (`<>`): a bounce, or a notification whose
   *    sender has declared it accepts no reply.
   */
  | "auto_reply_suppressed"
  | "null_return_path"
  /**
   * THE MESSAGE IS ITSELF A DELIVERY REPORT — `multipart/report; report-type=delivery-status`
   * (RFC 6522 §3 / RFC 3464), which is the shape a bounce actually arrives in.
   *
   * Its own member rather than `auto_submitted`, because the two are different facts with
   * different remediations: `auto_submitted` is a sender declaring its message automatic, and a
   * DSN is a mail system reporting that a delivery failed. Not every MTA sets RFC 3834's header
   * on one, and some send it from an address with no service local part and a present
   * `Return-Path` — which is how a bounce reaches the send path with every other guard clear and
   * earns a reply of its own.
   */
  | "bounce_report"
  /**
   * THIS CORRESPONDENT'S ADDRESS DOES NOT ACCEPT MAIL — a bounce for an earlier away reply came
   * back, so `away_sender_state.undeliverable_at` is stamped and no further reply is ever sent.
   *
   * Permanent by design. A responder that keeps writing to a dead address generates one bounce
   * per cycle into this account's own Ohbox, which is the state this member exists to end.
   */
  | "undeliverable"
  /**
   * THE MESSAGE IS IN A PILE THIS RESPONDER WAS NOT ASKED TO ANSWER — anything but the Ohbox
   * under the defaults, including a stranger held in the Screener under `audience: 'everyone'`
   * when that pile is not ticked, and any folder outside {@link AWAY_ANSWERABLE_PILES}.
   *
   * The audience is a fact about a SENDER (let in once, past the Screener for ever); this is a
   * fact about WHERE their mail landed. A shop let in to send one order confirmation is still
   * "somebody I've let in" when its newsletter files to Reads months later, which is why the
   * audience could not prevent the eight replies this member exists to stop.
   */
  | "wrong_pile"
  | AutoReplySuppression;

/**
 * WHY THIS MESSAGE MAY NEVER EARN AN AUTOMATIC REPLY WHATEVER THE SETTINGS — the reasons
 * {@link neverAutoReply} can give. A subset of {@link AwaySuppression}, named so the predicate's
 * own contract is readable without the pile and account members it knows nothing about.
 */
export type AwayNeverReason =
  | AutoReplySuppression
  | "auto_reply_suppressed"
  | "null_return_path"
  | "bounce_report";

/** The audiences, as the closed set the service validator and this module share. */
export type AwayAudience = "screened_in" | "everyone";

/** One candidate, as the pass has it in hand. Nothing here is a query. */
export interface AwayCandidate {
  /** The envelope author, as stored. Lowercased and trimmed here, never by the caller. */
  fromAddress: string | null;
  /** The message's stored headers, or `{}` when it has no body row — which reads as "no markers". */
  headers: Readonly<Record<string, unknown>>;
  /** `folder_state.desired_folder`, or null for a row placed in the same transaction that made it. */
  desiredFolder: string | null;
  /** The pipeline's sensitivity verdict — any non-null value is a keep. */
  sensitivityCategory: string | null;
  /** This account's own instruction that the message's content does not leave. */
  noForward: boolean;
  /**
   * DID SOMEBODY ALREADY ANSWER THIS? — decided by the pass, passed in as a fact.
   *
   * True when an own-authored message exists in the same thread dated at or after this candidate.
   * That covers BOTH a manual reply the person sent themselves before the pass ran and an earlier
   * automatic reply from any install, which is the same question asked once: has this correspondent
   * already heard from this mailbox about this thread.
   */
  alreadyReplied: boolean;
  /**
   * DID AN EARLIER AWAY REPLY TO THIS SENDER BOUNCE? — decided by the pass, passed in as a fact,
   * for `alreadyReplied`'s reason exactly: the evidence is a row in `away_sender_state`, and a
   * function that could reach the database would be a function a table test could not drive.
   *
   * REQUIRED, not optional with a `false` default. A fail-closed rule needs the state it fails
   * closed on to be distinguishable from "this caller has no such thing", and an omitted boolean
   * collapses "no bounce has come back" into "nobody looked" — the one shape that would let a
   * caller who forgot to join the table keep writing to a dead address.
   */
  senderUndeliverable: boolean;
}

/** Every address this account owns, lowercased — including disabled and errored mailboxes. */
export type AwayOwnAddresses = ReadonlySet<string>;

/** Lowercase, trimmed — the one normalisation of an address in this module. */
export function awayNormalizeAddress(addr: string | null | undefined): string {
  return (addr ?? "").trim().toLowerCase();
}

/**
 * The suppression that holds, or `null` when the responder may answer.
 *
 * `ownAddresses` includes every mailbox on the account, INCLUDING disabled and errored ones: an
 * address that was ours is still ours, and a responder that answers a former mailbox of its own
 * owner is the same loop as one that answers its current one.
 */
export function awayEligibility(
  candidate: AwayCandidate,
  audience: AwayAudience,
  ownAddresses: AwayOwnAddresses,
  piles: AwayPiles,
): AwaySuppression | null {
  const sender = awayNormalizeAddress(candidate.fromAddress);

  // NOT AN ADDRESS AT ALL. `@` at position 0 is not a local part, and an empty envelope author is
  // what a bounce carries. Neither is somebody to answer, and both would otherwise reach the
  // header verdict as a string that cannot match any of its tests.
  if (sender.length === 0 || sender.indexOf("@") <= 0) return "not_an_address";

  // OUR OWN. Ingest sees the Sent copy of every message the account sends; without this the
  // responder answers itself, for ever, at one round trip per cycle.
  if (ownAddresses.has(sender)) return "own_address";

  // SENSITIVITY KEEPS — a login code, a password reset, a security alert, or mail this account marked
  // as not leaving. The reply quotes nothing, but it confirms to whoever started that flow that the
  // address is live and attended, and it puts the flagged subject line into an outbound message.
  if (candidate.sensitivityCategory !== null || candidate.noForward) return "sensitive";

  // NEVER ANSWERED, WHATEVER THE AUDIENCE — see {@link AWAY_NEVER_ANSWERED_FOLDERS}. Checked
  // BEFORE the audience so that widening to `everyone` cannot reach Quarantine: the two guards read
  // the same column and only their order keeps them independent.
  const placed = candidate.desiredFolder;
  if (placed !== null) {
    const never = AWAY_NEVER_ANSWERED_FOLDERS[placed];
    if (never !== undefined) return never;
  }

  // THE AUDIENCE. A message still HELD in the Screener is a stranger this account has not admitted. A
  // row with NO placement yet (ingested this cycle) is treated as NOT screened in — absent evidence
  // may not select the acting branch, and here the acting branch sends mail to a stranger.
  if (audience !== "everyone" && (placed ?? AWAY_SCREENER_FOLDER) === AWAY_SCREENER_FOLDER) {
    return "not_screened_in";
  }

  // ── THE PILE SCOPE ────────────────────────────────────────────────────────────────────────
  //
  // AFTER the audience, and that order is what keeps the two settings from contradicting: a
  // stranger still held in the Screener is refused by the audience unless it is `everyone`, and
  // only then does this rule ask whether `ohmail/Screener` is a pile its owner ticked. The write
  // doors refuse that pile beside `screened_in` (`awayScopeFitsAudience`), so the row where the
  // two disagree is not representable.
  //
  // A row with NO placement is refused: mail whose pile nobody has decided yet is not mail known
  // to be in an answered pile, and absent evidence may not select the branch that sends mail. An
  // EMPTY `piles` therefore answers nobody, which is the fail-closed reading and not "no filter".
  if (!piles.includes(placed ?? "")) return "wrong_pile";

  // ── WHAT MAY NEVER EARN A REPLY, WHATEVER THE SETTINGS ────────────────────────────────────
  //
  // ONE predicate, COMPOSED — see {@link neverAutoReply}. It was tempting to write the sender
  // classes out here; they already exist in `rules.ts` and a second copy of them is the drift
  // that file's own header says ships an auto-reply to a mailing list.
  const never = neverAutoReply(candidate.headers, sender);
  if (never !== null) return never;

  // ── THE TWO FACTS THE PASS HAD TO GO AND FETCH ────────────────────────────────────────────
  //
  // Last, on this module's cheapest-first rule, and `undeliverable` outranks `already_replied`
  // because it is the more permanent statement about the correspondent: a thread that has been
  // answered may earn another reply tomorrow, and an address that does not accept mail never will.
  if (candidate.senderUndeliverable) return "undeliverable";
  if (candidate.alreadyReplied) return "already_replied";

  return null;
}

/**
 * MAY THIS MESSAGE EVER EARN AN AUTOMATIC REPLY? — the reason it may not, or `null`.
 *
 * ── COMPOSED, NEVER COPIED, AND THE BRIEF THAT ASKED FOR A COPY WAS WORKING FROM A GREP ─────
 *
 * The slice this predicate was written for recorded that no `no-reply@` / `mailer-daemon@` /
 * `postmaster@` / empty-`Return-Path` exclusion existed. Every one of them does, and has since
 * 0087: `SERVICE_LOCAL_PREFIXES` + `isServiceSender` in `rules.ts`, reached through
 * {@link autoReplySuppression}, plus the two away-only header tests that used to sit inline in
 * {@link awayEligibility} and now live here. Measured against the built package before anything
 * changed: `no-reply@`, `noreply@`, `no_reply@`, `do-not-reply@`, `donotreply@`,
 * `MAILER-DAEMON@`, `mailer-daemon@`, `postmaster@`, `bounce@`, `bounces@` and
 * `bounce-123-abc@` all answered `service_sender`.
 *
 * So this function ADDS one member and re-encodes nothing. The senders that actually reached the
 * send path were `hello@`, `team@`, `updates@`, `info@`, `news@`, `support@` and `store@` — none
 * a service local part, all of them ordinary human-ambiguous roles that `isServiceSender` is
 * deliberately tight enough to admit — and what those messages had in common was their PILE, not
 * their sender. The pile rule is the cure; this predicate is the floor under it.
 *
 * ── WHY IT IS ITS OWN EXPORTED FUNCTION ─────────────────────────────────────────────────────
 *
 * So that "every site that can send an away reply consults it" is a claim a census test can
 * check by name, rather than a property of one function's control flow.
 */
export function neverAutoReply(
  headers: Readonly<Record<string, unknown>>, sender: string,
): AwayNeverReason | null {
  // LIST MAIL, RFC 3834 LOOP STOPS AND SERVICE SENDERS — the SAME implementation the router's
  // machine-sent test uses, so there is no second encoding of "this was generated, not typed" to
  // drift. This call is unchanged from when it sat inline in `awayEligibility`.
  const headerVerdict = autoReplySuppression(headers, sender);
  if (headerVerdict !== null) return headerVerdict;

  // ── THE AWAY-ONLY HEADER TESTS ────────────────────────────────────────────────────────────
  //
  // These are NOT in `autoReplySuppression`, and the reason is that its other caller is the
  // ROUTER's `machineSent`, which decides where a message is FILED. `X-Auto-Response-Suppress` is
  // a request about auto-replies specifically and says nothing about whether a human typed the
  // message; folding it in would silently start filing ordinary Exchange mail as machine-sent.
  // Same for an empty `Return-Path`, which is a bounce/notification convention and not a statement
  // about authorship. So they live here, where the decision is exactly "may we auto-reply".
  const suppressHeader = awayHeaderValues(headers, "x-auto-response-suppress");
  if (suppressHeader?.some((v) => /\b(?:oof|autoreply|all)\b/i.test(v)) ?? false) {
    return "auto_reply_suppressed";
  }
  const precedence = awayHeaderValues(headers, "precedence");
  if (precedence?.some((v) => /\b(?:list|junk)\b/i.test(v)) ?? false) return "list_mail";
  // AN EMPTY `Return-Path` (`<>`) is the null reverse-path: a bounce, or a notification whose
  // sender has declared it will accept no reply. Answering it is undeliverable at best and a
  // bounce loop at worst. Only an EMPTY one — a present, non-empty Return-Path is ordinary mail.
  const returnPath = awayHeaderValues(headers, "return-path");
  if (returnPath?.some((v) => v.trim() === "" || v.trim() === "<>") ?? false) return "null_return_path";

  // THE MESSAGE IS ITSELF A BOUNCE. See {@link isDeliveryReport} — the member this predicate adds.
  if (isDeliveryReport(headers)) return "bounce_report";

  return null;
}

/**
 * IS THIS MESSAGE A DELIVERY STATUS NOTIFICATION? — `Content-Type: multipart/report` carrying
 * `report-type=delivery-status`.
 *
 * BOTH halves are required, and the second one is what keeps this off ordinary mail: a READ
 * RECEIPT is also `multipart/report`, with `report-type=disposition-notification`, and it is a
 * person's client asking for an acknowledgement rather than a mail system reporting a failure.
 * Treating one as a bounce would silence a correspondent who did nothing but tick a box.
 *
 * EXPORTED, and it has a second caller for a reason worth stating: the pass reads incoming
 * bounces to learn which correspondents are unreachable, and "is this message a bounce" must be
 * the SAME question there as it is here. Asked twice — once in this predicate and once as a SQL
 * `content-type LIKE` in the pass — the two would answer differently the first time a sender
 * folded the header, and the direction of that disagreement is that a HUMAN reply to an away
 * reply gets read as a bounce and their address is marked dead.
 *
 * The value is matched with the parameter quoted or bare (both are legal per RFC 2045 §5.1) and
 * without assuming parameter order, because a `Content-Type` may be folded across lines with
 * `boundary` between the type and the report type. `\s*` around the `=` for the same reason.
 */
export function isDeliveryReport(headers: Readonly<Record<string, unknown>>): boolean {
  const ct = awayHeaderValues(headers, "content-type");
  if (ct === null) return false;
  return ct.some((v) => /multipart\/report/i.test(v)
    && /report-type\s*=\s*"?delivery-status"?/i.test(v));
}

/**
 * ONE HEADER, EVERY VALUE — the accessor, and it exists for the reason `rules.ts` has its own.
 *
 * A stored header map is a `JSON.parse`d object, so a bare `headers["constructor"]` is a truthy
 * INHERITED value and a bare `headers["precedence"]` misses `Precedence`. This reads case-blind
 * over the object's OWN keys only, and normalises the single/array/scalar shapes the parser can
 * produce into one array of strings.
 *
 * Not imported from `rules.ts` because it is not exported there; duplicated deliberately and
 * narrowly, and the duplication is one loop with no policy in it. The POLICY that matters —
 * `autoReplySuppression` — is called, never copied.
 */
function awayHeaderValues(
  headers: Readonly<Record<string, unknown>>, name: string,
): string[] | null {
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== want) continue;
    const v = headers[key];
    if (v === null || v === undefined) return [""];
    if (Array.isArray(v)) return v.map((x) => (x === null || x === undefined ? "" : String(x)));
    return [String(v)];
  }
  return null;
}

/**
 * THE TEXT THIS RESPONDER IS CURRENTLY SAYING, as a hash — the key `throttle='per_message'` means
 * "once, until you change the text" by.
 *
 * ── WHY A HASH OF THE TEXT AND NOT A VERSION NUMBER ─────────────────────────────────────────
 *
 * A stored version id (or the row's `updated_at`, which is the same thing with a clock on it) makes
 * every SAVE a new version, and a save is not an edit: somebody who switches the responder off on
 * Friday and on again on Monday, or who opens Settings and presses Save having changed nothing, has
 * written the same words twice. Keyed by version, each of those re-arms a reply to every
 * correspondent already answered — which is precisely the "an edit answers everyone again" failure
 * the old `responder_updated_at` episode key shipped with, and the reason this slice replaces it.
 *
 * Keyed by the TEXT, the question the throttle asks is the question the setting's copy asks:
 * "Once, until you change the text". Unchanged text is unchanged, however many times it was saved.
 *
 * NFC-normalised and trimmed before hashing, so a body that differs only in Unicode composition or
 * in trailing whitespace — which is what a copy-paste through a different editor produces — is the
 * same text. Nothing else is normalised: internal whitespace and case are the author's, and a
 * responder rewritten in different words is a different message even if it says the same thing.
 */
export function awayTextHash(body: string | null | undefined): string {
  return createHash("sha256").update((body ?? "").normalize("NFC").trim(), "utf8").digest("hex");
}
