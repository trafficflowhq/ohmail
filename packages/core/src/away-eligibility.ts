import { createHash } from "node:crypto";
import { autoReplySuppression, type AutoReplySuppression } from "./rules.js";

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

/** Where a first-contact stranger waits — `audience='screened_in'` does not answer mail held here. */
export const AWAY_SCREENER_FOLDER = "ohmail/Screener";

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
export const AWAY_NEVER_ANSWERED_FOLDERS: readonly string[] = [
  "ohmail/Screened",
  "ohmail/Quarantine",
];

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
  | AutoReplySuppression;

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
  if (placed !== null && AWAY_NEVER_ANSWERED_FOLDERS.includes(placed)) return "screened_out";

  // THE AUDIENCE. A message still HELD in the Screener is a stranger this account has not admitted. A
  // row with NO placement yet (ingested this cycle) is treated as NOT screened in — absent evidence
  // may not select the acting branch, and here the acting branch sends mail to a stranger.
  if (audience !== "everyone" && (placed ?? AWAY_SCREENER_FOLDER) === AWAY_SCREENER_FOLDER) {
    return "not_screened_in";
  }

  // LIST MAIL, RFC 3834 LOOP STOPS AND SERVICE SENDERS — the SAME implementation the router's
  // machine-sent test uses, so there is no second encoding of "this was generated, not typed" to
  // drift. Extended below with the away-only headers; this call itself is unchanged.
  const headerVerdict = autoReplySuppression(candidate.headers, sender);
  if (headerVerdict !== null) return headerVerdict;

  // ── THE AWAY-ONLY HEADER TESTS ────────────────────────────────────────────────────────────
  //
  // These are NOT in `autoReplySuppression`, and the reason is that its other caller is the
  // ROUTER's `machineSent`, which decides where a message is FILED. `X-Auto-Response-Suppress` is
  // a request about auto-replies specifically and says nothing about whether a human typed the
  // message; folding it in would silently start filing ordinary Exchange mail as machine-sent.
  // Same for an empty `Return-Path`, which is a bounce/notification convention and not a statement
  // about authorship. So they live here, where the decision is exactly "may we auto-reply".
  const suppressHeader = awayHeaderValues(candidate.headers, "x-auto-response-suppress");
  if (suppressHeader?.some((v) => /\b(?:oof|autoreply|all)\b/i.test(v)) ?? false) {
    return "auto_submitted";
  }
  const precedence = awayHeaderValues(candidate.headers, "precedence");
  if (precedence?.some((v) => /\b(?:list|junk)\b/i.test(v)) ?? false) return "list_mail";
  // AN EMPTY `Return-Path` (`<>`) is the null reverse-path: a bounce, or a notification whose
  // sender has declared it will accept no reply. Answering it is undeliverable at best and a
  // bounce loop at worst. Only an EMPTY one — a present, non-empty Return-Path is ordinary mail.
  const returnPath = awayHeaderValues(candidate.headers, "return-path");
  if (returnPath?.some((v) => v.trim() === "" || v.trim() === "<>") ?? false) return "service_sender";

  // ALREADY ANSWERED — a manual reply the person sent themselves, or an earlier automatic one from
  // any install. Last because it is the only member whose evidence the pass had to go and fetch.
  if (candidate.alreadyReplied) return "already_replied";

  return null;
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
