import { and, asc, eq, sql } from "drizzle-orm";
import {
  assertOrganizerRole,
  awayResponders, contacts, mailboxes, notifyRules, rules, tags,
  latestProfileFoundMarker, profileImportResolutionExists, recordProfileImportResolution,
  recordChanges,
  type ChangeInput, type Tx,
} from "@trafficflow/db";
import { DESTINATIONS } from "@trafficflow/core/mail";
import {
  ProfileUnavailableError, profileFingerprint,
  type OrganizerProfileDoc, type ProfileReadResult, type ProfileRuleEntry,
} from "@trafficflow/core/adapters/organizer-profile";
import { serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { MAX_BODY_CONTAINS_CHARS, MAX_SUBJECT_CONTAINS_CHARS } from "./rules-service.js";
import { AWAY_AUDIENCES, nextEnabledAt } from "./away-responder-service.js";
import { AWAY_THROTTLES, type AwayThrottle } from "./away-responder-pass.js";
import { MAX_TAG_NAME_CHARS } from "./tags-service.js";

/**
 * THE PROFILE IMPORT — the answer side of the portable organizer profile.
 *
 * A mailbox can arrive carrying its own ohmail configuration: a versioned JSON document in the
 * unsubscribed `ohmail/_meta` folder, written by whichever organizer ran this mailbox before
 * (`packages/core/src/adapters/organizer-profile.ts` is the format). The organizer that finds
 * one it has not been told to adopt NEVER applies it — it records a durable found-marker and
 * holds its own write-behind (`apps/worker/src/profile.ts`), and the decision comes here, to a
 * human, through three verbs:
 *
 *   · {@link ProfileImportService.candidate} — is there something to ask about, and what would
 *     an import bring? Answered from the marker first (one indexed read — this is the cheap,
 *     pollable path) and then from a FRESH read of the mailbox, so the counts on the screen are
 *     the counts of the document that will actually be applied, never a stale record's.
 *   · {@link ProfileImportService.apply} — the user said yes. The document's sections are
 *     written into the local store BY NATURAL KEYS, in one transaction, with the resolution
 *     marker that releases the organizer's hold committed alongside them.
 *   · {@link ProfileImportService.decline} — the user said keep local. Nothing is applied and
 *     nothing in the mailbox is touched; the same resolution marker records the answer, so the
 *     prompt is dismissed durably and the organizer's write-behind resumes over its own store.
 *
 * ── THE MERGE RULE, PRECISELY ───────────────────────────────────────────────────────────────
 *
 * **The profile wins for every natural key it names; local rows whose keys it does not name are
 * untouched.** Concretely, per section:
 *
 *   · screener — key: the sender address. The document's entry becomes the row for that address
 *     (name included: the entry is the whole truth for its key, so a document without a display
 *     name clears one). Local contacts the document does not name stay.
 *   · rules — key: (kind, match, subjectContains, bodyContains); value: (destination, priority,
 *     enabled, provenance). For a named key the local row set becomes EXACTLY the document's
 *     rows for that key — retargeted in place where a row exists, inserted where none does, and
 *     surplus local duplicates of the same key deleted, because two rules answering one key with
 *     different destinations would leave the priority/id tie-break deciding where mail files,
 *     which is the coin toss the sender sheet's retarget-not-duplicate rule exists to prevent.
 *     Local rules under keys the document does not name stay.
 *   · notifyRules — key: (kind, target), which is also the whole value. Inserted where missing.
 *   · awayResponder — key: the account's single responder row. A non-null document section
 *     replaces it wholly; a null section leaves the local one alone (null is "the travelling
 *     mailbox had none", not an instruction to delete).
 *   · tagNames — key: the tag name, case-insensitively (the store's own uniqueness). Missing
 *     names are created; local tags stay; existing names keep their case and hue.
 *
 * Idempotent by construction: every write is keyed on what it means, so re-applying the same
 * document is a no-op that emits no change rows. Applied rules do NOT request the retroactive
 * pass — an import restores configuration for a mailbox whose mail the previous organizer
 * already filed; it must not turn a confirmation click into thousands of IMAP moves.
 *
 * ── WHAT IS REFUSED RATHER THAN GUESSED ─────────────────────────────────────────────────────
 *
 * The document format is public and anything can have written it, so each rule passes the same
 * validation the product's own create enforces (known kind, canonical destination, non-blank
 * bounded terms, terms on sender rules only); a rule that fails is SKIPPED and counted, never
 * half-imported — and a skipped rule means the local store does not equal the document, which
 * is exactly why the resolution marker (not only convergence) releases the organizer's hold.
 * A document from a NEWER format version is never partially imported: the candidate reports
 * `newer` and offers nothing, because applying the fields this build knows would silently drop
 * the ones it does not.
 */

/** A fresh read of the mailbox's profile document. Built by the route from the live adapter. */
export type ProfileReader = () => Promise<ProfileReadResult>;

/** What an import would bring, in the units the confirm screen speaks. */
export interface ProfileImportCounts {
  screener: number;
  rules: number;
  notifyRules: number;
  tags: number;
  awayResponder: boolean;
}

export type ProfileImportCandidateDTO =
  /** Nothing to ask about. The resting answer, and the only one the cheap no-dial path gives. */
  | { state: "none" }
  /** A document is waiting on the user's answer. `fingerprint` names its exact content. */
  | {
    state: "found";
    fingerprint: string;
    updatedAt: string;
    producer: { kind: string; version: string };
    counts: ProfileImportCounts;
  }
  /** Written by a later ohmail. Nothing is offered — a partial import would be a silent loss. */
  | { state: "newer"; v: number }
  /**
   * Too large to apply in one transaction. Nothing is offered, for the same reason `newer` offers
   * nothing: a partial import is a settings restore that silently omits some of them.
   *
   * It carries the offending list and both numbers, and the document's `fingerprint` so the
   * content-keyed `decline` can be recorded against it — without that a client could never stop
   * being asked, and every poll would re-dial the mailbox.
   *
   * **What it does NOT yet get is a card.** The shared reader (`ProfileImportCard#asOffer`) treats
   * any unrecognised state as no offer, which is the safe behaviour and a silent one: the person
   * is not told why their settings are not being offered. Stated here rather than implied — the
   * wire half is done and the surface half is not.
   */
  | { state: "too_large"; fingerprint: string; list: string; count: number; max: number };

export interface ProfileImportApplied {
  imported: ProfileImportCounts;
  /** Document rules that failed the product's own validation and were left out. */
  skippedRules: number;
  /** The highest change_log seq the apply emitted, or null when everything was already there. */
  seq: number | null;
}

const KINDS = new Set(["sender", "domain", "header"]);
const FOLDER_SET = new Set<string>(DESTINATIONS);

/**
 * The `classid` half of the apply's `pg_advisory_xact_lock(int4, int4)` — the second half is
 * `hashtext(account_id)`. The attachment-staging mint's argument, restated for this writer: the
 * merge reads the account's rule/notify/tag rows and then acts on what it read, and two
 * concurrent applies (two tabs answering the same card) would each see the pre-state and each
 * insert — a duplicate rule under one natural key, which is exactly the coin toss the merge rule
 * exists to remove. There is no single row to lock (the interesting case is the ABSENT row), so
 * the mutex is transaction-scoped and per-account, taken FIRST, released at commit. Nothing else
 * in the product takes this class, and the transaction holds no lock across any network call —
 * the mailbox re-read happens strictly BEFORE the transaction opens.
 */
export const PROFILE_IMPORT_LOCK_CLASS = 420_727_016;

/** The document could not be read from the mailbox — never "there is nothing to import". */
const profileUnreadable = (): ServiceError => new ServiceError(
  "profile_unreadable", 502,
  "The mailbox could not be checked for saved ohmail settings. Try again.",
);

/** One rule as the apply writes it — the document entry, validated and normalized. */
interface ApplicableRule {
  kind: string;
  match: string;
  destination: string;
  priority: number;
  enabled: boolean;
  provenance: string;
  subjectContains: string | null;
  bodyContains: string | null;
}

/**
 * A term, normalized as `RulesService.validSubjectContains` normalizes one — or the `invalid`
 * sentinel where the service would 400. The import cannot 400 a document nobody typed into a
 * form, so an invalid term invalidates its RULE (skipped and counted) rather than the request.
 * Coercing a blank term to null instead would silently WIDEN the rule to the sender's whole
 * mail, which is the exact misreading the service refuses.
 */
const INVALID_TERM = Symbol("invalid-term");
function normTerm(v: string | undefined, max: number): string | null | typeof INVALID_TERM {
  if (v === undefined || v === null) return null;
  const term = v.trim();
  if (term.length === 0 || term.length > max || hasNul(term)) return INVALID_TERM;
  return term;
}

/**
 * PostgreSQL text cannot hold a NUL, so a public document's string carrying one would turn the
 * merge into a mid-transaction database error — a 500 where "this entry was skipped" is the
 * honest answer. Checked wherever a document string becomes a stored value.
 */
const hasNul = (v: string): boolean => v.includes("\u0000");

/** The store's integer bounds — a document may claim any JavaScript number. */
const INT4_MAX = 2_147_483_647;

/** The document rule, admitted under the product's own create rules — or null (skip + count). */
function applicableRule(r: ProfileRuleEntry): ApplicableRule | null {
  if (!KINDS.has(r.kind)) return null;
  if (typeof r.match !== "string" || r.match.length === 0 || hasNul(r.match)) return null;
  if (!FOLDER_SET.has(r.destination)) return null;
  // Bounded to what the store's integer column can hold: an overflowing priority would abort
  // the whole transaction as a database error, which is a 500 dressed as an import.
  if (!Number.isInteger(r.priority) || Math.abs(r.priority) > INT4_MAX) return null;
  const subjectContains = normTerm(r.subjectContains, MAX_SUBJECT_CONTAINS_CHARS);
  const bodyContains = normTerm(r.bodyContains, MAX_BODY_CONTAINS_CHARS);
  if (subjectContains === INVALID_TERM || bodyContains === INVALID_TERM) return null;
  if ((subjectContains !== null || bodyContains !== null) && r.kind !== "sender") return null;
  const provenance = typeof r.provenance === "string" && r.provenance.length > 0 ? r.provenance : "manual";
  if (hasNul(provenance)) return null;
  return {
    kind: r.kind,
    match: r.match,
    destination: r.destination,
    priority: r.priority,
    enabled: r.enabled === true,
    provenance,
    subjectContains,
    bodyContains,
  };
}

/**
 * The natural key a rule is merged under, CASE-FOLDED the way the routing engine folds at match
 * time: `Alice@Example.com` and `alice@example.com` are one rule to the thing that files mail,
 * so they must be one key to the thing that merges rules — keyed apart, an import would insert
 * a duplicate whose winner is the priority/id tie-break. The stored row keeps its own casing
 * (a retarget replaces the VALUE fields only); the comparison alone folds. Terms are never `""`
 * after normalization, so the empty slot is unambiguous.
 */
const ruleKey = (r: { kind: string; match: string; subjectContains: string | null; bodyContains: string | null }): string =>
  [r.kind, r.match.toLowerCase(), (r.subjectContains ?? "").toLowerCase(), (r.bodyContains ?? "").toLowerCase()]
    .join("\u0000");

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;

/**
 * HOW LARGE A DOCUMENT `apply` WILL IMPORT, PER LIST.
 *
 * ── WHY THIS NEEDED A BOUND AT ALL ────────────────────────────────────────────────────────
 *
 * `apply` walks `doc.screener`, `doc.rules`, `doc.notifyRules` and `doc.tagNames` one entry at a
 * time inside ONE transaction, holding an account-scoped advisory lock, issuing an upsert or an
 * update per entry and appending a change-log row for each rule it writes. None of those lists
 * had a ceiling, and the counts do not come from the request: they come from a JSON document in
 * the `ohmail/_meta` folder of an IMAP server the user chose and we do not run. So the size of
 * the transaction, the length of the lock and the number of change rows were all decided by the
 * mail server, and the confirmation the user gives is a fingerprint of the content — it proves
 * they saw the same document, not that the document is a reasonable size.
 *
 * (The READ side of the same document — its bytes and message count coming off the wire — is
 * the unbounded-read and adapter-door gaps, which belong to the peek and the adapter.
 * This is the WRITE side, and it needs its own bound whatever the read grows: a document that
 * arrives legitimately can still be too large to apply in one transaction.)
 *
 * ── THE NUMBERS ──────────────────────────────────────────────────────────────────────────
 *
 * ── THE FAILURE MODE OF A TIGHT BOUND HERE IS SEVERE AND PERMANENT ─────────────────────────
 *
 * `serializeOrganizerProfile` exports EVERY contact, rule, notify rule and tag an account holds,
 * and none of the write services impose an account-wide total — so an account can legitimately
 * create more of any of them than a felt ceiling allows, export all of them, and then be unable
 * to restore its own settings. A review round caught exactly that shape at a `tagNames` cap of
 * 500 against an account that could hold 501.
 *
 * So each number is set far above what any real account holds rather than at a comfortable
 * round figure, and the residual — an account already past one of them — is recorded as a known
 * limit rather than argued away. `screener` is an address book and gets the largest, 20 000 —
 * four times `SEED_SCAN_LIMIT` and chosen AGAINST it as a rough scale rather than derived from
 * it, because that constant counts MESSAGES and one message contributes every distinct recipient
 * on it. The document bounded here is an address book another install wrote, not a review, so the
 * two are only loosely related and this is a product ceiling.
 *
 * REFUSED, not truncated. A partial import is a settings restore that silently omits some of the
 * user's rules, and they would have no way to see which — the counts on the confirm screen said
 * one thing and the account holds another.
 *
 * AND REFUSED IN `candidate()` TOO, which is the half that makes the refusal honest: the confirm
 * screen is built from `candidate()`, so a ceiling only `apply()` knew about would OFFER an
 * import and then refuse the press. `candidate()` answers `too_large` with the counts, the limits
 * and the fingerprint, exactly as it answers `newer` for a document this build cannot read — and
 * the shared card, whose reader treats an unrecognised state as no offer, therefore shows
 * nothing rather than something wrong. Explaining it on the surface is a separate change.
 */
export const PROFILE_IMPORT_MAX = {
  screener: 20_000,
  rules: 5_000,
  notifyRules: 2_000,
  tagNames: 2_000,
} as const;

/** The first list that is over its ceiling, or null. One answer, used by both entry points. */
function oversizedList(doc: OrganizerProfileDoc): { list: string; count: number; max: number } | null {
  for (const key of ["screener", "rules", "notifyRules", "tagNames"] as const) {
    const n = doc[key].length;
    const max = PROFILE_IMPORT_MAX[key];
    if (n > max) return { list: key, count: n, max };
  }
  return null;
}

/**
 * Refuse a document whose lists are larger than one transaction should carry. Called BEFORE
 * `apply` opens its transaction, which is the whole point — inside it, the lock is already held.
 */
function refuseOversizedProfile(doc: OrganizerProfileDoc): void {
  const over = oversizedList(doc);
  if (over) {
    throw new ServiceError(
      "payload_too_large", 413,
      `these saved settings hold ${over.count} ${over.list} entries, over the ${over.max} this ` +
        "import can apply in one go. Nothing was changed.",
    );
  }
}

/** Counts of a document, in the confirm screen's units. */
function countsOf(doc: OrganizerProfileDoc): ProfileImportCounts {
  return {
    screener: doc.screener.length,
    rules: doc.rules.length,
    notifyRules: doc.notifyRules.length,
    tags: doc.tagNames.length,
    awayResponder: doc.awayResponder !== null,
  };
}

export class ProfileImportService {
  /**
   * Is there a document waiting on this mailbox, and what would importing it bring?
   *
   * The MARKER decides whether the mailbox is dialled at all: no marker, an unheld one (the
   * incumbent-organizer posture — last-incumbent-wins, nothing to import), or one the user has
   * already answered, and the answer is `none` from one indexed read. Only an OPEN question
   * costs an IMAP connection, and what it returns is the folder's CURRENT document — fresher
   * than the marker, so a document that changed since detection is offered as what it now is,
   * under its own fingerprint, and one that disappeared is not offered at all.
   */
  async candidate(
    ctx: ServiceContext, mailboxId: string, opts: { read: ProfileReader },
  ): Promise<ProfileImportCandidateDTO> {
    await this.assertMailbox(ctx, mailboxId);
    const db = asTx(ctx);

    const marker = await latestProfileFoundMarker(db, ctx.accountId, mailboxId);
    if (!marker) return { state: "none" };

    if (marker.state === "newer") {
      if (typeof marker.v === "number"
        && await profileImportResolutionExists(db, { accountId: ctx.accountId, mailboxId, newerV: marker.v })) {
        return { state: "none" };
      }
      // Confirm against the folder: a marker outlives its document (the newer build's copy may
      // have been superseded or deleted by hand), and "update ohmail to import" must only be
      // said over a document that is still there.
      const fresh = await this.readFresh(opts.read);
      return fresh.state === "newer" ? { state: "newer", v: fresh.v } : { state: "none" };
    }

    // `found`: only a HELD document is an open import question. Unheld means the organizer met
    // it as the incumbent and will supersede it — offering an import of content the next
    // write-behind flush is about to replace would be asking about a decision already made.
    if (!marker.heldForImport || marker.fingerprint === null) return { state: "none" };
    if (await profileImportResolutionExists(db, {
      accountId: ctx.accountId, mailboxId, fingerprint: marker.fingerprint,
    })) {
      return { state: "none" };
    }

    const fresh = await this.readFresh(opts.read);
    if (fresh.state === "newer") return { state: "newer", v: fresh.v };
    if (fresh.state !== "found") return { state: "none" };

    /**
     * THE SIZE REFUSAL COMES BEFORE THE FINGERPRINT, and the fingerprint before the lookup.
     *
     * `profileFingerprint` copies and locale-sorts all four arrays and serializes the whole
     * canonical document to hash it. Refusing after it would bound the TRANSACTION and nothing
     * else, while the sort and the whole-document buffer the ceiling exists to prevent had
     * already run — the same "the ceiling is applied to the result and not to the read" shape
     * this slice is named for, one layer up.
     *
     * The cost of putting it first is that a `too_large` answer carries a fingerprint computed
     * for an oversized document — which it must, because that fingerprint is what makes the
     * answer DISMISSIBLE. So the order is: refuse on COUNTS (free), then canonicalize once for
     * the id, then ask whether this exact content has already been answered about.
     */
    const over = oversizedList(fresh.doc);
    const fingerprint = profileFingerprint(fresh.doc);

    /**
     * THE RESOLUTION LOOKUP COMES BEFORE THE SIZE ANSWER, and the order is a correction.
     *
     * `too_large` used to be answered BEFORE this, which quietly broke the dismissal it carries a
     * fingerprint for: with a stale marker (A) over a changed, oversized document (B),
     * `candidate` answered `too_large(B)`, a client recorded `decline(B)`, and the next poll —
     * which only checks the MARKER's fingerprint above — re-dialled IMAP and answered
     * `too_large(B)` again, forever. The answer was durable and the question was not.
     *
     * Asking about the FRESH fingerprint here settles that for every state at once: a document
     * the user has already answered about is `none`, whether the answer was "keep local" or an
     * import, and whether or not it is one this build would offer.
     */
    if (await profileImportResolutionExists(db, { accountId: ctx.accountId, mailboxId, fingerprint })) {
      return { state: "none" };
    }

    /**
     * A document `apply` would refuse is not OFFERED. Before this the ceiling lived only in
     * `apply`, so the confirm screen showed counts and a button that was going to 413 — see
     * {@link PROFILE_IMPORT_MAX}. Answered like `newer`: nothing is offered.
     *
     * IT CARRIES THE FINGERPRINT, and that is what makes the state actionable rather than a
     * dead end. `decline` is content-keyed, so a client holding the fingerprint can record a
     * durable "keep local" for this exact document and stop being asked. The shared card
     * currently reads any state it does not recognise as NO OFFER, so today this is silent
     * rather than explained; the fingerprint is what a card that explains it will need.
     */
    if (over) {
      return { state: "too_large", fingerprint, list: over.list, count: over.count, max: over.max };
    }
    // (The "already answered for this exact content" check that used to live here has moved ABOVE
    // the size refusal — see the note there. It is the same question and the same query; only its
    // position changed, so that a `too_large` answer can be dismissed like any other.)
    // Already what the local store says ⇒ nothing an import would change, so nothing is asked.
    // (The organizer releases its own hold by this same comparison — one serializer, one answer.)
    const local = await serializeOrganizerProfile(db, ctx.accountId);
    if (profileFingerprint(local) === fingerprint) return { state: "none" };

    return {
      state: "found",
      fingerprint,
      updatedAt: fresh.doc.updatedAt,
      producer: { kind: fresh.doc.producer.kind, version: fresh.doc.producer.version },
      counts: countsOf(fresh.doc),
    };
  }

  /**
   * The user confirmed: write the document's sections into the local store, by natural keys,
   * in one transaction that also records the resolution releasing the organizer's hold.
   *
   * `fingerprint` is REQUIRED and is the confirm screen's receipt: the document is re-read from
   * the mailbox and applied only if its content is still exactly what the user was shown —
   * counts and all. A document that changed in between answers 409 `profile_changed`, and the
   * screen asks again over the new content rather than applying something nobody confirmed.
   */
  async apply(
    ctx: ServiceContext, mailboxId: string, body: { fingerprint?: unknown }, opts: { read: ProfileReader },
  ): Promise<ProfileImportApplied> {
    await this.assertMailbox(ctx, mailboxId);
    /* -- ONLY AN ORGANIZER IMPORTS A TRAVELLING PROFILE (mail 0083) -------------------------
     *
     * The import writes the account's rules, screener entries, notify rules, away responder and
     * tag names out of a document another install left in `ohmail/_meta`. Every one of those is
     * configuration this install would then act on — and a reader acts on none of it, so an
     * import here would rewrite the account's screening on the strength of a handover that did
     * not happen to this side.
     *
     * It is also the mirror image of the hold: the hold exists so an INCOMING organizer does not
     * re-screen what it is inheriting. An install that is not the incoming organizer has nothing
     * to inherit, and its cycle never arms the hold (`engine.ts`, `index.ts` — both skip
     * `armHoldFromFolder` for a reader), so this door is the one place a reader could still have
     * reached the document.
     *
     * PER MAILBOX, because the document belongs to one mailbox's `_meta` folder.
     */
    await assertOrganizerRole(asTx(ctx), ctx.accountId, mailboxId);
    const fingerprint = body.fingerprint;
    if (typeof fingerprint !== "string" || fingerprint.length === 0) {
      throw new ServiceError("validation_failed", 400, "fingerprint is required");
    }

    const fresh = await this.readFresh(opts.read);
    if (fresh.state === "newer") {
      throw new ServiceError(
        "profile_newer", 409,
        "These settings were saved by a newer version of ohmail — update ohmail to import them.",
      );
    }
    // BEFORE the fingerprint, not after it. `profileFingerprint` copies and locale-sorts all four
    // arrays and serializes the whole canonical document to hash it — so a ceiling that fires
    // afterwards is a ceiling on the transaction and on nothing else, while the sort and the
    // buffer it was meant to prevent have already happened. A review round caught it there.
    if (fresh.state === "found") refuseOversizedProfile(fresh.doc);
    if (fresh.state !== "found" || profileFingerprint(fresh.doc) !== fingerprint) {
      throw new ServiceError(
        "profile_changed", 409,
        "The saved settings changed since you looked. Review them again before importing.",
      );
    }
    const doc = fresh.doc;

    return asTx(ctx).transaction(async (tx) => {
      // FIRST, before any read the merge will act on — see {@link PROFILE_IMPORT_LOCK_CLASS}.
      await tx.execute(sql`select pg_advisory_xact_lock(${PROFILE_IMPORT_LOCK_CLASS}, hashtext(${ctx.accountId}))`);
      const changes: ChangeInput[] = [];
      const now = ctx.now();

      // ── screener → contacts, keyed by address ──────────────────────────────────────────
      // Last entry wins within the document (the reader does not deduplicate), lowercased as
      // the format specifies; the row becomes the entry, display name included.
      const byAddress = new Map<string, string | null>();
      for (const s of doc.screener) {
        const address = s.address.trim().toLowerCase();
        if (address.length === 0 || hasNul(address)) continue;
        const name = s.name !== undefined && !hasNul(s.name) ? s.name : null;
        byAddress.set(address, name);
      }
      for (const [address, name] of byAddress) {
        await tx.insert(contacts)
          .values({ accountId: ctx.accountId, address, name })
          .onConflictDoUpdate({
            target: [contacts.accountId, contacts.address],
            set: { name },
          });
      }

      // ── rules, merged per natural key ──────────────────────────────────────────────────
      const applicable: ApplicableRule[] = [];
      let skippedRules = 0;
      for (const r of doc.rules) {
        const a = applicableRule(r);
        if (a === null) skippedRules += 1;
        else applicable.push(a);
      }
      const docByKey = new Map<string, ApplicableRule[]>();
      for (const a of applicable) {
        const k = ruleKey(a);
        const group = docByKey.get(k);
        if (group) group.push(a);
        else docByKey.set(k, [a]);
      }
      const localRules = await tx.select({
        id: rules.id, kind: rules.kind, match: rules.match, destination: rules.destination,
        priority: rules.priority, enabled: rules.enabled, provenance: rules.provenance,
        subjectContains: rules.subjectContains, bodyContains: rules.bodyContains,
      }).from(rules).where(eq(rules.accountId, ctx.accountId)).orderBy(asc(rules.createdAt), asc(rules.id));
      const localByKey = new Map<string, typeof localRules>();
      for (const row of localRules) {
        const k = ruleKey(row);
        const group = localByKey.get(k);
        if (group) group.push(row);
        else localByKey.set(k, [row]);
      }
      for (const [key, docRows] of docByKey) {
        const localRows = localByKey.get(key) ?? [];
        const n = Math.max(docRows.length, localRows.length);
        for (let i = 0; i < n; i++) {
          const want = docRows[i];
          const have = localRows[i];
          if (want && have) {
            const same = have.destination === want.destination && have.priority === want.priority
              && have.enabled === want.enabled && have.provenance === want.provenance;
            if (same) continue; // already the document's row — no write, no change row
            await tx.update(rules).set({
              destination: want.destination, priority: want.priority,
              enabled: want.enabled, provenance: want.provenance, updatedAt: now,
              // Deliberately NOT re-requesting the retroactive pass: an import restores
              // configuration; the travelling mailbox's mail was filed by its previous
              // organizer, and a confirm click must not become a bulk re-filing.
            }).where(and(eq(rules.id, have.id), eq(rules.accountId, ctx.accountId)));
            changes.push({ accountId: ctx.accountId, entityType: "rule", entityId: have.id, op: "update", meta: null });
          } else if (want) {
            const [row] = await tx.insert(rules).values({
              accountId: ctx.accountId,
              kind: want.kind, match: want.match, destination: want.destination,
              priority: want.priority, enabled: want.enabled, provenance: want.provenance,
              subjectContains: want.subjectContains, bodyContains: want.bodyContains,
              retroRequestedAt: null,
            }).returning({ id: rules.id });
            changes.push({ accountId: ctx.accountId, entityType: "rule", entityId: row!.id, op: "create", meta: null });
          } else if (have) {
            // A surplus local duplicate of a key the document names — see the merge rule.
            await tx.delete(rules).where(and(eq(rules.id, have.id), eq(rules.accountId, ctx.accountId)));
            changes.push({ accountId: ctx.accountId, entityType: "rule", entityId: have.id, op: "delete", meta: null });
          }
        }
      }

      // ── notifyRules, keyed by (kind, target); the key is the whole value ───────────────
      const localNotify = await tx.select({ kind: notifyRules.kind, target: notifyRules.target })
        .from(notifyRules).where(eq(notifyRules.accountId, ctx.accountId));
      const notifyHave = new Map<string, number>();
      const notifyKey = (kind: string, target: string): string => `${kind}\u0000${target.toLowerCase()}`;
      for (const nr of localNotify) {
        const k = notifyKey(nr.kind, nr.target);
        notifyHave.set(k, (notifyHave.get(k) ?? 0) + 1);
      }
      let notifyApplied = 0;
      for (const nr of doc.notifyRules) {
        if (hasNul(nr.kind) || hasNul(nr.target)) continue;
        notifyApplied += 1;
        const k = notifyKey(nr.kind, nr.target);
        const have = notifyHave.get(k) ?? 0;
        if (have > 0) { notifyHave.set(k, have - 1); continue; }
        await tx.insert(notifyRules).values({
          accountId: ctx.accountId, kind: nr.kind, target: nr.target, createdAt: now,
        });
      }

      // ── awayResponder — the single per-account row, replaced wholly when the document
      //    carries one. The audience is narrowed, never widened, when unrecognised: a reply to
      //    a stranger cannot be recalled, and `screened_in` is the value the column's own
      //    default writes.
      let awayApplied = false;
      if (doc.awayResponder !== null) {
        const a = doc.awayResponder;
        const audience = (AWAY_AUDIENCES as readonly string[]).includes(a.audience) ? a.audience : "screened_in";
        const date = (v: string | null): Date | null | typeof INVALID_TERM => {
          if (v === null) return null;
          const d = new Date(v);
          return Number.isNaN(d.getTime()) ? INVALID_TERM : d;
        };
        const startsAt = date(a.startsAt);
        const endsAt = date(a.endsAt);
        // The section is applied WHOLE or not at all, under the away service's own rules: an
        // unparseable date silently becoming NULL would turn "away for a week" into an
        // unbounded responder — a widening this import must never be the door for — and a
        // reversed range is the same refusal the PUT gives. NUL-carrying text cannot be stored.
        const valid = startsAt !== INVALID_TERM && endsAt !== INVALID_TERM
          && !(startsAt !== null && endsAt !== null && startsAt.getTime() > endsAt.getTime())
          && !(a.body !== null && hasNul(a.body));
        if (valid) {
          awayApplied = true;
          const enabled = a.enabled === true;
          // The throttle is narrowed the same way the audience is, and for a sharper reason: an
          // unrecognised member here is a document written by a NEWER ohmail than this one, and the
          // safe reading of a rate we do not understand is the default rate rather than the fastest
          // one. `per_day` is the column's default and what 0087 wrote onto every migrated row.
          const throttle = (AWAY_THROTTLES as readonly string[]).includes(a.throttle)
            ? a.throttle as AwayThrottle : "per_day";
          /* THE SAME `nextEnabledAt` THE PUT USES — the one implementation, and this is the second
             writer it exists for. An import that lands on an account whose responder is ALREADY ON
             must not move the floor, or importing settings mid-trip would strand exactly the
             backlog `enabled_at` was added to keep answerable. */
          const [prevAway] = await tx.select({ enabledAt: awayResponders.enabledAt })
            .from(awayResponders).where(eq(awayResponders.accountId, ctx.accountId)).limit(1);
          const enabledAt = nextEnabledAt(prevAway?.enabledAt ?? null, enabled, now);
          await tx.insert(awayResponders).values({
            accountId: ctx.accountId, enabled,
            body: a.body,
            startsAt, endsAt,
            audience, throttle, enabledAt, updatedAt: now,
          }).onConflictDoUpdate({
            target: awayResponders.accountId,
            // `subject` is neither read from the document nor written: the responder is reply-only
            // since 0087. A document produced by an older ohmail still carries one, and it is
            // ignored exactly as the PUT ignores a legacy client's.
            set: {
              enabled, body: a.body,
              startsAt, endsAt, audience, throttle, enabledAt, updatedAt: now,
            },
          });
        }
      }

      // ── tagNames, keyed case-insensitively like the store's own uniqueness ─────────────
      const localTags = await tx.select({ name: tags.name }).from(tags)
        .where(eq(tags.accountId, ctx.accountId));
      const haveTag = new Set(localTags.map((t) => t.name.toLowerCase()));
      let tagsApplied = 0;
      for (const rawName of doc.tagNames) {
        // The tag store's own hygiene, applied to a public document's names: trimmed, bounded
        // by the same ceiling the create refuses over, never a control byte.
        const name = rawName.trim();
        if (name.length === 0 || name.length > MAX_TAG_NAME_CHARS || hasNul(name)) continue;
        tagsApplied += 1;
        if (haveTag.has(name.toLowerCase())) continue;
        haveTag.add(name.toLowerCase());
        const [row] = await tx.insert(tags).values({
          accountId: ctx.accountId, name, createdAt: now, updatedAt: now,
        }).returning({ id: tags.id });
        changes.push({ accountId: ctx.accountId, entityType: "tag", entityId: row!.id, op: "create", meta: null });
      }

      // One allocation for every change row (contacts/notify/away are REST-only, so only the
      // rule and tag writes wake the mirrors), then the answer itself — in THIS transaction, so
      // the applied sections and the resolution that releases the organizer's hold are one
      // commit. A crash between them cannot leave settings applied with the hold still on.
      const seqs = await recordChanges(tx, changes);
      await recordProfileImportResolution(tx, {
        accountId: ctx.accountId, mailboxId, decision: "imported", fingerprint,
      });

      return {
        // What ARRIVED, never what the document claimed: the difference is the skipped entries,
        // and a confirmation that repeated the claim would overstate the restore.
        imported: {
          screener: byAddress.size,
          rules: applicable.length,
          notifyRules: notifyApplied,
          tags: tagsApplied,
          awayResponder: awayApplied,
        },
        skippedRules,
        seq: seqs.length > 0 ? Number(seqs[seqs.length - 1]) : null,
      };
    });
  }

  /**
   * The user said keep local. Nothing is applied, nothing in the mailbox is touched — the
   * declined document stays where it is, still readable by whatever wrote it — and the durable
   * resolution dismisses the prompt and releases the organizer's hold, so this install's own
   * configuration travels again. Keyed to the exact content that was declined: a DIFFERENT
   * document appearing later legitimately re-asks.
   */
  async decline(
    ctx: ServiceContext, mailboxId: string, body: { fingerprint?: unknown; v?: unknown },
  ): Promise<void> {
    await this.assertMailbox(ctx, mailboxId);
    const fingerprint = typeof body.fingerprint === "string" && body.fingerprint.length > 0
      ? body.fingerprint : null;
    const newerV = typeof body.v === "number" && Number.isSafeInteger(body.v) && body.v > 1
      ? body.v : null;
    if (fingerprint === null && newerV === null) {
      throw new ServiceError("validation_failed", 400, "fingerprint (or v for a newer document) is required");
    }
    // Under the same per-account lock the apply takes, in a transaction, so the write-once
    // check and its insert are one serialized step: two tabs declining together write one row,
    // and a decline racing an apply cannot interleave inside either's bookkeeping.
    await asTx(ctx).transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${PROFILE_IMPORT_LOCK_CLASS}, hashtext(${ctx.accountId}))`);
      await recordProfileImportResolution(tx, fingerprint !== null
        ? { accountId: ctx.accountId, mailboxId, decision: "declined", fingerprint }
        // Dismissing the "written by a newer ohmail" notice. There is no payload to fingerprint
        // at this version, so the answer is keyed to the refused version number instead.
        : { accountId: ctx.accountId, mailboxId, decision: "declined", newerV: newerV! });
    });
  }

  /** Ownership first, before any dial: a cross-account mailbox id is indistinguishable from a missing one. */
  private async assertMailbox(ctx: ServiceContext, mailboxId: string): Promise<void> {
    const rows = await ctx.db.select({ id: mailboxes.id }).from(mailboxes)
      .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, ctx.accountId))).limit(1);
    if (rows.length === 0) throw new ServiceError("not_found", 404, "mailbox not found");
  }

  /** One fresh read, with the IO failure translated: "could not look" is 502, never "none". */
  private async readFresh(read: ProfileReader): Promise<ProfileReadResult> {
    try {
      return await read();
    } catch (err) {
      if (err instanceof ProfileUnavailableError) throw profileUnreadable();
      throw err;
    }
  }
}

export const profileImportService = new ProfileImportService();
