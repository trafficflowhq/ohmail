import { createHash } from "node:crypto";
import { autoReplySuppression, type AutoReplySuppression } from "./rules.js";
import { AWAY_SCREENER_FOLDER } from "./away-scope.js";

/**
 * May the away responder answer this message? — the whole suppression set as one pure function
 * over one row, so every guard can be deleted in place and watched to let a reply through. The
 * responder is the one thing that sends mail with nobody looking; its safety argument is a SET OF
 * NAMED GUARDS, each watched to fire — checkable only if each is a branch a table test reaches
 * with a hand-built row. The pass keeps two decisions of its own, neither a suppression:
 * candidacy (the WHERE clause) and the throttle (an atomic upsert). Cheapest-first order, part of
 * the contract: the FIRST holding reason is reported. Deliberately absent: a database handle, a
 * clock, an adapter — `already_replied` arrives as a decided boolean.
 */

/**
 * The folders whose contents are never answered, whatever the audience. `ohmail/Screened` is not
 * `ohmail/Screener`, and the one-letter difference is the whole point: Screener is where a
 * stranger WAITS — `audience='everyone'` exists precisely to answer them — while Screened is a
 * sender this account has REJECTED, and Quarantine is mail judged hostile. The two rejected
 * states are audience-blind: widening the audience is a decision to answer people you have not
 * met, not to answer people you turned away — and answering a phish confirms the address is live.
 * Two reasons rather than one (`screened_out` vs `not_screened_in`) because one is permanent and
 * one changes the moment the sender is let in.
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
 * The pile vocabulary, re-exported from the leaf that owns it. It lives in `away-scope.ts`
 * because the settings control and the Ohbox banner need the same members this rule refuses by,
 * and they cannot load THIS file — {@link awayTextHash} imports `node:crypto`. Two lists that
 * agree today is exactly the hazard ("the control offers a pile the engine refuses"), so there is
 * one list and both sides import it. Re-exported rather than merely imported so every consumer of
 * this module's vocabulary keeps one import.
 */
export {
  AWAY_ANSWERABLE_PILES, AWAY_PILES_DEFAULT, AWAY_PILE_VIEW, AWAY_SCREENER_FOLDER,
  awayEffectivePiles, awayScopeFitsAudience, isAwayPile, type AwayPile,
} from "./away-scope.js";

/**
 * Mailboxes a site or a server owns, never a person — matched WHOLE, punctuation stripped, so
 * `www-data`, `www_data` and `wwwdata` are one entry. RFC 3834 §2: a responder must not answer
 * mail from a mail system or a robot. `SERVICE_LOCAL_PREFIXES` in `rules.ts` refuses the
 * `no-reply@` family; this set is the CMS/system half it deliberately omits — that list also
 * decides where mail is FILED, and `wordpress@` may well be wanted in the Ohbox; it just must not
 * be written back to. Whole-name equality, not a prefix — measured: `startsWith("wp")` refuses
 * `wpe@` and `wpeteam@` (a hosting company's people). `webmaster@` and `abuse@` are human roles
 * and deliberately absent.
 */
export const AWAY_MACHINE_LOCALS: ReadonlySet<string> = new Set([
  "wordpress", "root", "wwwdata", "daemon", "cron", "nobody",
]);

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
   * The two away-only header verdicts, and they are their own members rather than reusing
   * `auto_submitted`/`service_sender`. Folded in at first, which contradicted this module's own
   * rule — an operator reading "we did not answer this" needs to know which happened: a stored
   * `auto_submitted` would be ambiguous between the sender marking the message automatic (RFC
   * 3834, the loop stop) and the sender's Exchange asking us not to auto-reply (a policy header
   * on ordinary human mail) — different facts, different remediations. `auto_reply_suppressed` —
   * `X-Auto-Response-Suppress: OOF|AutoReply|All`; `null_return_path` — an empty `Return-Path`
   * (`<>`): a bounce, or a notification declaring it accepts no reply.
   */
  | "auto_reply_suppressed"
  | "null_return_path"
  /**
   * The message is itself a delivery report — `multipart/report; report-type=delivery-status`
   * (RFC 6522 §3 / RFC 3464), the shape a bounce actually arrives in. Its own member rather than
   * `auto_submitted`: a sender declaring its message automatic and a mail system reporting a
   * failed delivery are different facts with different remediations. Not every MTA sets RFC
   * 3834's header on a bounce, and some send it from an address with no service local part and a
   * present `Return-Path` — which is how a bounce reaches the send path with every other guard
   * clear and earns a reply of its own.
   */
  | "bounce_report"
  /**
   * THE AUTHOR IS A SITE OR SYSTEM MAILBOX — `wordpress@`, `root@`, `www-data@` and the rest of
   * {@link AWAY_MACHINE_LOCALS}. RFC 3834 §2's rule, which no pile setting may override.
   *
   * Its own member rather than `service_sender` because that verdict is `rules.ts`'s, and that
   * list also decides where mail is FILED (`machineSent` → the Receipts conjunction). These names
   * must not move a message's pile; they must only stop an automatic reply.
   */
  | "site_notification"
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
  | "bounce_report"
  | "site_notification";

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

  // The pile scope — AFTER the audience, and that order keeps the two settings from
  // contradicting: a stranger still in the Screener is refused by the audience unless it is
  // `everyone`, and only then does this ask whether `ohmail/Screener` is a pile its owner ticked;
  // the write doors refuse that pile beside `screened_in` (`awayScopeFitsAudience`), so the row
  // where the two disagree is not representable. A row with NO placement is refused: mail whose
  // pile nobody has decided is not mail known to be in an answered pile, and absent evidence may
  // not select the branch that sends mail. An EMPTY `piles` answers nobody — fail-closed, not "no
  // filter".
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
 * May this message EVER earn an automatic reply? — the reason it may not, or `null`. Composed,
 * never copied: every claimed-missing exclusion has existed since 0087 (`SERVICE_LOCAL_PREFIXES`
 * + `isServiceSender`, reached through {@link autoReplySuppression}, plus the two away-only
 * header tests now here); measured against the built package, the whole
 * `no-reply@`/`mailer-daemon@`/`postmaster@`/`bounce@` family answered `service_sender`. This
 * ADDS one member and re-encodes nothing — the senders that actually reached the send path were
 * ordinary human-ambiguous roles, and what they shared was their PILE: the pile rule is the cure,
 * this the floor under it. Exported so a census can check every send site consults it by name.
 */
export function neverAutoReply(
  headers: Readonly<Record<string, unknown>>, sender: string,
): AwayNeverReason | null {
  // LIST MAIL, RFC 3834 LOOP STOPS AND SERVICE SENDERS — the SAME implementation the router's
  // machine-sent test uses, so there is no second encoding of "this was generated, not typed" to
  // drift. This call is unchanged from when it sat inline in `awayEligibility`.
  const headerVerdict = autoReplySuppression(headers, sender);
  if (headerVerdict !== null) return headerVerdict;

  // A SITE OR SYSTEM MAILBOX — {@link AWAY_MACHINE_LOCALS}, matched whole, and it is checked
  // because the headers do not carry the fact: a WordPress install's notification has no
  // `Auto-Submitted`, no `Precedence`, no `List-*` and a present `Return-Path`, so every test
  // below reads clean and the message earns a reply on its author alone.
  const at = sender.indexOf("@");
  if (at > 0 && AWAY_MACHINE_LOCALS.has(sender.slice(0, at).replace(/[^a-z0-9]/gi, "").toLowerCase())) {
    return "site_notification";
  }

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
 * Is this message a delivery status notification? — `multipart/report` carrying
 * `report-type=delivery-status`. BOTH halves required: a read receipt is also `multipart/report`,
 * with `report-type=disposition-notification` — a person's client asking for an acknowledgement —
 * and treating one as a bounce would silence a correspondent who ticked a box. Exported for its
 * second caller: the pass reads incoming bounces to learn which correspondents are unreachable,
 * and "is this a bounce" must be the SAME question there — two copies would disagree the first
 * time a sender folded the header, reading a human reply as a bounce. Matched quoted or bare (RFC
 * 2045 §5.1), order-free, `\s*` around the `=`.
 */
export function isDeliveryReport(headers: Readonly<Record<string, unknown>>): boolean {
  const ct = awayHeaderValues(headers, "content-type");
  if (ct === null) return false;
  return ct.some((v) => /multipart\/report/i.test(v)
    && /report-type\s*=\s*"?delivery-status"?/i.test(v));
}

/**
 * One header, every value — the accessor, and it exists for the reason `rules.ts` has its own: a
 * stored header map is a `JSON.parse`d object, so a bare `headers["constructor"]` is a truthy
 * INHERITED value and a bare `headers["precedence"]` misses `Precedence`. This reads case-blind
 * over the object's OWN keys only, and normalises the single/array/scalar shapes into one array
 * of strings. Not imported from `rules.ts` because it is not exported there; duplicated
 * deliberately and narrowly — one loop with no policy in it. The POLICY that matters,
 * `autoReplySuppression`, is called, never copied.
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
 * The text this responder is currently saying, as a hash — the key `throttle='per_message'` means
 * "once, until you change the text" by. A hash of the TEXT and not a version number: a stored
 * version id makes every SAVE a new version, and a save is not an edit — pressing Save having
 * changed nothing would re-arm a reply to every correspondent already answered, the failure the
 * old `responder_updated_at` episode key shipped with. NFC-normalised and trimmed before hashing,
 * so Unicode composition and trailing whitespace do not make a new text; nothing else is
 * normalised — a responder rewritten in different words is a different message.
 */
export function awayTextHash(body: string | null | undefined): string {
  return createHash("sha256").update((body ?? "").normalize("NFC").trim(), "utf8").digest("hex");
}
