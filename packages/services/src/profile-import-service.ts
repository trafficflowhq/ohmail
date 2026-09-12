import { and, asc, eq, sql } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  assertOrganizerRole,
  awayResponders, contacts, mailboxes, notifyRules, rules, tags,
  latestProfileFoundMarker, profileImportResolutionExists, recordProfileImportResolution,
  recordChanges,
  type ChangeInput, type Tx,
} from "@trafficflow/db";
import { DESTINATIONS, isAwayPile, awayScopeFitsAudience, type AwayPile } from "@trafficflow/core/mail";
import {
  ProfileUnavailableError, profileFingerprint,
  type OrganizerProfileDoc, type ProfileReadResult, type ProfileRuleEntry,
} from "@trafficflow/core/adapters/organizer-profile";
import { serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import type { ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";
import { MAX_BODY_CONTAINS_CHARS, MAX_SUBJECT_CONTAINS_CHARS } from "./rules-service.js";
import { AWAY_AUDIENCES, nextEnabledAt, type AwayAudience } from "./away-responder-service.js";
import { AWAY_THROTTLES, type AwayThrottle } from "./away-responder-pass.js";
import { MAX_TAG_NAME_CHARS } from "./tags-service.js";

/**
 * THE PROFILE IMPORT — the answer side of the portable organizer profile: a versioned JSON
 * document in `ohmail/_meta`, left by the previous organizer (`organizer-profile.ts` is the
 * format). Never auto-applied — the organizer records a found-marker and the decision comes here:
 * `candidate` (marker first, then a FRESH mailbox read, so the confirm counts are the
 * document's), `apply` (natural-key writes in one transaction, resolution marker alongside),
 * `decline` (dismissed durably). MERGE RULE: the profile wins for every key it names; unnamed
 * local rows stay. Idempotent; applied rules do NOT request the retroactive pass. Rules pass the
 * product's own create validation (failures SKIPPED, counted); a NEWER format offers nothing.
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
   * Too large to apply in one transaction. Nothing is offered, as for `newer`: a partial import
   * is a settings restore that silently omits some. It carries the offending list, both numbers
   * and the document's `fingerprint`, so the content-keyed `decline` can be recorded — without it
   * a client could never stop being asked and every poll would re-dial the mailbox. It does NOT
   * yet get a card: the shared reader (`ProfileImportCard#asOffer`) treats any unrecognised state
   * as no offer — safe but silent; the wire half is done, the surface half is not.
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
 * The `classid` half of the apply's `pg_advisory_xact_lock(int4, int4)`; the second half is
 * `hashtext(account_id)`. The merge reads the account's rule/notify/tag rows and acts on what it
 * read; two concurrent applies (two tabs answering one card) would each see the pre-state and
 * each insert — a duplicate rule under one natural key, the coin toss the merge rule removes. No
 * single row to lock (the interesting case is the ABSENT row), so the mutex is
 * transaction-scoped, per-account, taken FIRST, released at commit. Nothing else takes this
 * class; no lock is held across a network call — the mailbox re-read happens strictly BEFORE the
 * transaction opens.
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
 * HOW LARGE A DOCUMENT `apply` WILL IMPORT, PER LIST. `apply` walks all four lists in ONE
 * transaction under the account advisory lock, and the counts come from a document on a mail
 * server we do not run — the transaction's size would otherwise be that server's choice; the
 * fingerprint proves the user saw the document, not that it is reasonable. A tight bound is
 * severe: `serializeOrganizerProfile` exports EVERYTHING an account holds and nothing caps an
 * account-wide total, so an account could export settings it cannot restore — each number sits
 * far above real accounts (`screener` largest, 20 000). REFUSED, not truncated: a partial import
 * silently omits rules. Refused in `candidate()` too — never offer what `apply` would 413.
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
     * THE SIZE REFUSAL COMES BEFORE THE FINGERPRINT, the fingerprint before the lookup.
     * `profileFingerprint` copies, locale-sorts and serializes the whole canonical document;
     * refusing after it would bound the TRANSACTION while the sort and whole-document buffer had
     * already run — the ceiling applied to the result instead of the read, one layer up. The
     * cost: a `too_large` answer carries a fingerprint computed for an oversized document — which
     * it must, because the fingerprint is what makes the answer DISMISSIBLE. Order: refuse on
     * COUNTS (free), canonicalize once for the id, then ask whether this exact content was
     * already answered.
     */
    const over = oversizedList(fresh.doc);
    const fingerprint = profileFingerprint(fresh.doc);

    /**
     * THE RESOLUTION LOOKUP COMES BEFORE THE SIZE ANSWER. `too_large` used to be answered first,
     * which broke the dismissal it carries a fingerprint for: with a stale marker (A) over a
     * changed, oversized document (B), `candidate` answered `too_large(B)`, the client recorded
     * `decline(B)`, and the next poll — which only checks the MARKER's fingerprint — re-dialled
     * IMAP and answered `too_large(B)` again, forever. Asking about the FRESH fingerprint settles
     * every state at once: a document already answered about is `none`, whatever the answer was.
     */
    if (await profileImportResolutionExists(db, { accountId: ctx.accountId, mailboxId, fingerprint })) {
      return { state: "none" };
    }

    /**
     * A document `apply` would refuse is not OFFERED — before this the ceiling lived only in
     * `apply`, so the confirm screen showed counts and a button headed for a 413
     * (`PROFILE_IMPORT_MAX`). Answered like `newer`: nothing offered. IT CARRIES THE FINGERPRINT,
     * which makes the state actionable: `decline` is content-keyed, so a client holding it can
     * record a durable "keep local" and stop being asked. The shared card reads unrecognised
     * states as NO OFFER, so today this is silent; the fingerprint is what an explaining card
     * will need.
     */
    if (over) {
      return { state: "too_large", fingerprint, list: over.list, count: over.count, max: over.max };
    }
    // (The "already answered for this exact content" check that used to live here has moved ABOVE
    // the size refusal — see the note there. It is the same question and the same query; only its
    // position changed, so that a `too_large` answer can be dismissed like any other.)
    // Already what the local store says ⇒ nothing an import would change, so nothing is asked.
    // (The organizer releases its own hold by this same comparison — one serializer, one answer.)
    const local = await serializeOrganizerProfile(db, ctx.accountId, mailboxId);
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
    /**
     * ONLY AN ORGANIZER IMPORTS A TRAVELLING PROFILE (mail 0083). The import writes rules,
     * screener entries, notify rules, the responder and tag names out of a document another
     * install left in `ohmail/_meta` — configuration this install would then act on. A reader
     * acts on none of it; an import here would rewrite screening on a handover that did not
     * happen to this side. Mirror image of the hold: the hold exists so an INCOMING organizer
     * does not re-screen what it inherits; a reader never arms it (`engine.ts`, `index.ts` skip
     * `armHoldFromFolder`), so this door is the one place a reader could still reach the
     * document. PER MAILBOX — the document belongs to one mailbox's `_meta`.
     */
    await assertOrganizerRole(asTx(ctx), dialect(ctx.db), ctx.accountId, mailboxId);
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
      await dialect(ctx.db).advisoryLock(tx, PROFILE_IMPORT_LOCK_CLASS, ctx.accountId);
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
          /* THE SCOPE (mail 0096), and only when the document STATES one. An absent field is a
             document written before the field existed — it says nothing about scope, so the stored
             value is left alone rather than reset to the column's Ohbox default, which would
             narrow the responder on every adoption from an older install. Unrecognised members are
             dropped, on the same argument the audience and throttle are narrowed on: a value this
             build cannot act on must not reach a column whose CHECK refuses it. */
          let piles = a.piles === undefined ? undefined : [...new Set(a.piles.filter(isAwayPile))];
          /* AND THE SCOPE MUST FIT THE AUDIENCE THIS IMPORT IS APPLYING. The Screener pile may only
             be answered with the wider audience, and the PUT enforces that UNGATED BY `enabled` —
             so a row left holding the Screener beside the narrower audience is one the pane cannot
             save at all, including the save that turns the responder OFF. That reaches the kept
             scope too: the document may change the audience while saying nothing about scope.
             Narrowed, as the audience and throttle are, because a document is not a person asking. */
          const keptOrStored = piles ?? (await tx.select({ piles: awayResponders.piles })
            .from(awayResponders).where(eq(awayResponders.accountId, ctx.accountId)).limit(1))[0]?.piles;
          if (keptOrStored !== undefined && !awayScopeFitsAudience(keptOrStored as AwayPile[], audience as AwayAudience)) {
            piles = (keptOrStored as AwayPile[]).filter((q) => awayScopeFitsAudience([q], audience as AwayAudience));
          }
          const [prevAway] = await tx.select({ enabledAt: awayResponders.enabledAt })
            .from(awayResponders).where(eq(awayResponders.accountId, ctx.accountId)).limit(1);
          const enabledAt = nextEnabledAt(prevAway?.enabledAt ?? null, enabled, now);
          await tx.insert(awayResponders).values({
            accountId: ctx.accountId, enabled,
            body: a.body,
            startsAt, endsAt,
            audience, throttle, enabledAt, updatedAt: now,
            ...(piles === undefined ? {} : { piles }),
          }).onConflictDoUpdate({
            target: awayResponders.accountId,
            // `subject` is neither read from the document nor written: the responder is reply-only
            // since 0087. A document produced by an older ohmail still carries one, and it is
            // ignored exactly as the PUT ignores a legacy client's.
            set: {
              enabled, body: a.body,
              startsAt, endsAt, audience, throttle, enabledAt, updatedAt: now,
              ...(piles === undefined ? {} : { piles }),
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

      /**
       * signature — the one PER-MAILBOX field in the document (mail 0094). Applied like every
       * section above: a skipped section is a setting the person loses silently. It also makes
       * the import TERMINATE: the organizer's hold releases when the local serialization equals
       * the held document, and `signature` is part of that serialization — an importer skipping
       * it would never converge and the prompt would return every cycle. Written to THIS mailbox,
       * scoped by account as well as id — the same predicate the serializer reads through. `null`
       * is written as `null`: "no signature" is a statement, and treating it as "leave what is
       * here" would make the import non-idempotent.
       */
      await tx.update(mailboxes).set({ signature: doc.signature })
        .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.accountId, ctx.accountId)));

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
      await dialect(ctx.db).advisoryLock(tx, PROFILE_IMPORT_LOCK_CLASS, ctx.accountId);
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
