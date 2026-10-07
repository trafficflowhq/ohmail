import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  awayResponders, contacts, mailboxes as mailboxesTbl, notifyRules as notifyRulesTbl,
  rules as rulesTbl, tags as tagsTbl,
  fenceErased, lockAccountRuleKeys, recordChanges, recordProfileImportResolution, rerouteOwnHeldBag,
  resolveImportAsk, ruleDelta,
  type ChangeInput, type ImportAskRefusal, type LedgerTx, type Tx, upgradeContactsToPerson,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { ruleMatchKey } from "../rule-order.js";
import { AWAY_AUDIENCES, AWAY_THROTTLES, nextEnabledAt, type AwayAudience, type AwayThrottle } from "../away-eligibility.js";
import { awayScopeFitsAudience, isAwayPile, type AwayPile } from "../away-scope.js";
import {
  PROFILE_LIST_MAX, applicableProfileRule, arrivesDecided, oversizedProfileList, profileFingerprint, profileScreenerAddress,
  type ApplicableProfileRule, type OrganizerProfileDoc, type OrganizerProfilePayload, type ProfileReadResult,
} from "./organizer-profile.js";

/**
 * The serializer — the organizer's store, read into the profile document's payload. It reads ONLY
 * configuration: screened-in senders (`contacts` — a row there IS the screener's yes; the no
 * travels in `rules` as a `ohmail/Screened` destination), rules by natural keys, notification
 * opt-ins, the single autoresponder row, tag names. Deliberately not read: anything adaptive and
 * anything secret — no credential column appears in any query, and the worker's suite pins the
 * document's exact key census so a new field is a reviewed decision. It sits below both callers —
 * the organizer's write-behind and the API's import surface — because "is the found document
 * already what the local store says" must be answered from the same serialization both use.
 */
export async function serializeOrganizerProfile(
  db: Tx, accountId: string, mailboxId: string,
): Promise<OrganizerProfilePayload> {
  return (await serializeOrganizerProfileCounted(db, accountId, mailboxId)).payload;
}

/** How many entries of each bounded list stayed out of the document — 0 under the bound. */
export type ProfileLeftOut = Record<keyof typeof PROFILE_LIST_MAX, number>;

/**
 * {@link serializeOrganizerProfile}, with what the list bound left out BESIDE the payload, never
 * in it (the key census pins the document). Each list is read one past its bound, so a list at
 * exactly the bound reads 0 and one past it reads 1.
 */
export async function serializeOrganizerProfileCounted(
  db: Tx, accountId: string,
  /**
   * The mailbox, and it is why this function stopped being account-scoped (mail 0094). Everything
   * else here belongs to the ACCOUNT; `signature` does not — it is `mailboxes.signature`, the
   * text appended to mail sent from this address, and a person with two mailboxes has two of
   * them: serializing one account-wide would publish one mailbox's sign-off into the other's
   * document. Required rather than optional: an optional mailbox would default to no signature,
   * and a caller that forgot it would publish a document that silently drops the field — the
   * republish then reads as the person having cleared their signature.
   */
  mailboxId: string,
): Promise<{ payload: OrganizerProfilePayload; leftOut: ProfileLeftOut }> {
  // ONE SNAPSHOT, not five. Under READ COMMITTED each statement sees its own snapshot, so a
  // screener decide committing between the contacts read and the rules read would serialize a
  // TORN configuration — the contact without its promoted rule — and the document would say
  // something no store ever held (self-healing one flush later, but "a burst is one write" is
  // the contract, and a torn read is how it becomes two). REPEATABLE READ pins all five reads
  // to one snapshot; PGlite is real Postgres, so the same statement works on both stores.
  const [contactRows, ruleRows, notifyRows, awayRows, tagRows, mailboxRows] = await db.transaction(async (tx) => {
    return [
      // Each list is the newest PROFILE_LIST_MAX of its kind, so the import on another machine
      // takes what this one publishes; automatic (promoted) rules are the first to stay behind.
      await tx.select({ address: contacts.address, name: contacts.name })
        .from(contacts).where(eq(contacts.accountId, accountId))
        .orderBy(desc(contacts.createdAt), desc(contacts.id)).limit(PROFILE_LIST_MAX.screener + 1),
      await tx.select({
        kind: rulesTbl.kind, match: rulesTbl.match, destination: rulesTbl.destination,
        priority: rulesTbl.priority, enabled: rulesTbl.enabled, provenance: rulesTbl.provenance,
        subjectContains: rulesTbl.subjectContains, bodyContains: rulesTbl.bodyContains,
        personDecidedAt: rulesTbl.personDecidedAt,
      }).from(rulesTbl).where(eq(rulesTbl.accountId, accountId))
        .orderBy(sql`${rulesTbl.provenance} = 'promoted'`, desc(rulesTbl.createdAt), desc(rulesTbl.id))
        .limit(PROFILE_LIST_MAX.rules + 1),
      await tx.select({ kind: notifyRulesTbl.kind, target: notifyRulesTbl.target })
        .from(notifyRulesTbl).where(eq(notifyRulesTbl.accountId, accountId))
        .orderBy(desc(notifyRulesTbl.createdAt), desc(notifyRulesTbl.id)).limit(PROFILE_LIST_MAX.notifyRules + 1),
      // `subject` is not selected: the responder is reply-only since 0087 and the column is inert
      // until the 0.15 contract migration drops it. Reading it here would put a dead field back
      // into every published document.
      await tx.select({
        enabled: awayResponders.enabled, body: awayResponders.body,
        startsAt: awayResponders.startsAt, endsAt: awayResponders.endsAt,
        audience: awayResponders.audience, throttle: awayResponders.throttle,
        piles: awayResponders.piles,
      }).from(awayResponders).where(eq(awayResponders.accountId, accountId)),
      await tx.select({ name: tagsTbl.name }).from(tagsTbl).where(eq(tagsTbl.accountId, accountId))
        .orderBy(desc(tagsTbl.createdAt), desc(tagsTbl.id)).limit(PROFILE_LIST_MAX.tagNames + 1),
      // THE SIXTH READ, inside the same snapshot as the other five for the reason the comment
      // above gives: a signature edit committing between two statements would serialize a
      // configuration no store ever held. Scoped by ACCOUNT as well as by mailbox — a predicate
      // on the id alone would serialize whatever row carried that uuid, and the account column is
      // the only thing that makes "this mailbox is ours" a property of the query.
      await tx.select({
        signature: mailboxesTbl.signature,
        // The MARKUP half, in the same statement as the text for the reason the whole snapshot
        // exists: the two columns are written together by `setMailboxSignature` (a markup save
        // derives the text, a plain save clears the markup), so reading them apart could publish
        // a formatted sign-off beside somebody else's words.
        signatureHtml: mailboxesTbl.signatureHtml,
      }).from(mailboxesTbl)
        .where(and(eq(mailboxesTbl.id, mailboxId), eq(mailboxesTbl.accountId, accountId))),
    ] as const;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });

  const away = awayRows[0];
  const leftOut: ProfileLeftOut = {
    screener: Math.max(0, contactRows.length - PROFILE_LIST_MAX.screener),
    rules: Math.max(0, ruleRows.length - PROFILE_LIST_MAX.rules),
    notifyRules: Math.max(0, notifyRows.length - PROFILE_LIST_MAX.notifyRules),
    tagNames: Math.max(0, tagRows.length - PROFILE_LIST_MAX.tagNames),
  };
  contactRows.splice(PROFILE_LIST_MAX.screener);
  ruleRows.splice(PROFILE_LIST_MAX.rules);
  notifyRows.splice(PROFILE_LIST_MAX.notifyRules);
  tagRows.splice(PROFILE_LIST_MAX.tagNames);
  const payload: OrganizerProfilePayload = {
    screener: contactRows.map((c) => (c.name === null ? { address: c.address } : { address: c.address, name: c.name })),
    rules: ruleRows.map((r) => ({
      kind: r.kind, match: r.match, destination: r.destination,
      priority: r.priority, enabled: r.enabled, provenance: r.provenance,
      ...(r.subjectContains === null ? {} : { subjectContains: r.subjectContains }),
      ...(r.bodyContains === null ? {} : { bodyContains: r.bodyContains }),
      ...(r.personDecidedAt === null ? {} : { personDecidedAt: r.personDecidedAt.toISOString() }),
    })),
    notifyRules: notifyRows.map((n) => ({ kind: n.kind, target: n.target })),
    awayResponder: away === undefined ? null : {
      enabled: away.enabled,
      body: away.body,
      throttle: away.throttle,
      startsAt: away.startsAt === null ? null : away.startsAt.toISOString(),
      endsAt: away.endsAt === null ? null : away.endsAt.toISOString(),
      audience: away.audience,
      // The row's own scope, so it reaches the person's other computers. `canonicalizeProfilePayload`
      // sorts and dedupes it; this is the stored value.
      piles: [...away.piles],
    },
    tagNames: tagRows.map((t) => t.name),
    // NO ROW READS AS NO SIGNATURE, which is also what a NULL column reads as. They are the same
    // answer here on purpose: a mailbox that is not this account's is not a state this serializer
    // can report on, and its caller has already established the mailbox before asking.
    signature: mailboxRows[0]?.signature ?? null,
    /* PRESENT ONLY WHEN THERE IS MARKUP — the payload's optional key, so a mailbox whose
       signature is plain serializes byte for byte the document this serializer wrote before the
       field existed. `canonicalizeProfilePayload` applies the same rule again and drops markup
       with no text beside it; stating it here keeps the RAW payload the key census reads honest
       about what the store actually holds. */
    ...(mailboxRows[0]?.signatureHtml ? { signatureHtml: mailboxRows[0].signatureHtml } : {}),
  };
  return { payload, leftOut };
}

/**
 * THE TAG STORE'S NAME CEILING — the create refuses over it and the import skips over it. Here,
 * below both, because the organizer applies imports too and may not import the services package.
 */
export const MAX_TAG_NAME_CHARS = 40;

/**
 * The `classid` half of the import's `pg_advisory_xact_lock(int4, int4)`; the second half is
 * `hashtext(account_id)`. The merge reads the account's rule/notify/tag rows and acts on what it
 * read, so two concurrent applies (two tabs, or a press and the organizer's job) would each see
 * the pre-state and each insert. No single row to lock — the interesting case is the ABSENT row —
 * so the mutex is transaction-scoped, per account, taken FIRST, released at commit. No lock is
 * held across a network call: every caller reads the document before its transaction opens.
 */
export const PROFILE_IMPORT_LOCK_CLASS = 420_727_016;

/** What an import brings, in the units the confirm screen speaks. */
export interface ProfileImportCounts {
  screener: number;
  rules: number;
  notifyRules: number;
  tags: number;
  awayResponder: boolean;
}

export interface ProfileImportApplied {
  imported: ProfileImportCounts;
  /** Document rules that failed the product's own validation and were left out. */
  skippedRules: number;
  /** The highest change_log seq the apply emitted, or null when everything was already there. */
  seq: number | null;
}

/** An unparseable responder date — the entry is skipped rather than the import refused. */
const INVALID_TERM = Symbol("invalid-term");

/**
 * PostgreSQL text cannot hold a NUL, so a public document's string carrying one would turn the
 * merge into a mid-transaction database error. Checked wherever a document string is stored.
 */
const hasNul = (v: string): boolean => v.includes("\u0000");

/**
 * The natural key a rule is merged under, keyed as every reader keys it (`ruleMatchKey`), so
 * `Alice@Example.com` and ` alice@example.com` are one key. A new row is stored as that key; an
 * existing row keeps its bytes. Terms are never `""` after normalization.
 */
const ruleKey = (r: { kind: string; match: string; subjectContains: string | null; bodyContains: string | null }): string =>
  JSON.stringify([r.kind, ruleMatchKey(r.match), (r.subjectContains ?? "").toLowerCase(), (r.bodyContains ?? "").toLowerCase()]);

/** The destinations that screen a sender OUT of sight — where the app presents their held mail. */
const SCREEN_OUT_FOLDERS: ReadonlySet<string> = new Set(["ohmail/Screened", "ohmail/Quarantine"]);

/** A written rule that screens a sender out as a whole: its held bag follows it. */
const screensOut = (r: ApplicableProfileRule): r is ApplicableProfileRule & { kind: "sender" | "domain" } =>
  r.enabled && SCREEN_OUT_FOLDERS.has(r.destination) && (r.kind === "sender" || r.kind === "domain")
  && r.subjectContains === null && r.bodyContains === null;

/**
 * WHY A FRESH READ MAY NOT BE APPLIED UNDER `fingerprint`, or null when it may — the one decision
 * the inline press and the organizer's job both make. The size refusal comes BEFORE the
 * fingerprint: hashing sorts and serializes the whole document, and a ceiling after it bounds
 * nothing but the transaction.
 */
export function importRefusalFor(fresh: ProfileReadResult, fingerprint: string): ImportAskRefusal | null {
  if (fresh.state === "newer") return "newer";
  if (fresh.state === "none") return "gone";
  if (fresh.state === "unreadable") return "unreadable";
  if (oversizedProfileList(fresh.doc)) return "too_large";
  return profileFingerprint(fresh.doc) === fingerprint ? null : "changed";
}

/**
 * THE IMPORT ITSELF — the serializer's inverse: a found document's sections written into the
 * store by natural keys, on the CALLER'S fenced transaction, the lock taken first. The profile
 * wins for every key it names, unnamed local rows stay; idempotent; no retroactive pass; rules
 * through the product's own validation (failures skipped). The resolution that releases the
 * organizer's hold and the ask's answer commit with the sections. Two callers, one merge: the
 * request that read the document in time, and the organizer's job when it did not.
 */
export async function applyOrganizerProfile(
  tx: LedgerTx,
  o: { accountId: string; mailboxId: string; doc: OrganizerProfileDoc; fingerprint: string; now: Date },
): Promise<ProfileImportApplied> {
  // The merge writes contacts and rules: the account's rule-key lock first, as every rules writer
  // takes it, so a Screener decision (rule-key, rules, then contacts) never waits crosswise on it.
  await lockAccountRuleKeys(tx as unknown as Tx, o.accountId);
  // Then, before any read the merge will act on — see {@link PROFILE_IMPORT_LOCK_CLASS}.
  await dialect(tx).advisoryLock(tx, PROFILE_IMPORT_LOCK_CLASS, o.accountId);
  /* Then this mailbox's row FOR UPDATE, before the first write: the merge updates it last, and
     taken there it came after the contacts and held mail it writes, out of every writer's order
     (shared earlier, two appliers would deadlock at that update). Both erasures refuse here too. */
  await fenceErased(tx as unknown as Tx, dialect(tx), {
    accountId: o.accountId, mailboxId: o.mailboxId, mailboxLock: "update",
  });
  const changes: ChangeInput[] = [];
  const now = o.now;

  // ── screener → contacts, keyed by address ──────────────────────────────────────────
  // Last entry wins within the document (the reader does not deduplicate), lowercased as
  // the format specifies; the row becomes the entry, display name included.
  const byAddress = new Map<string, string | null>();
  for (const s of o.doc.screener) {
    const address = profileScreenerAddress(s);
    if (address === null) continue;
    const name = s.name !== undefined && !hasNul(s.name) ? s.name : null;
    byAddress.set(address, name);
  }
  for (const [address, name] of byAddress) {
    // A person's own list, carried from their other install: a person's contact (mail 0147).
    await tx.insert(contacts)
      .values({ accountId: o.accountId, address, name, source: "person" })
      .onConflictDoUpdate({
        target: [contacts.accountId, contacts.address],
        set: { name },
      });
    await upgradeContactsToPerson(tx, o.accountId, [address]);
  }

  // ── rules, merged per natural key ──────────────────────────────────────────────────
  const applicable: ApplicableProfileRule[] = [];
  let skippedRules = 0;
  for (const r of o.doc.rules) {
    const a = applicableProfileRule(r);
    if (a === null) skippedRules += 1;
    else applicable.push(a);
  }
  const docByKey = new Map<string, ApplicableProfileRule[]>();
  for (const a of applicable) {
    const k = ruleKey(a);
    const group = docByKey.get(k);
    if (group) group.push(a);
    else docByKey.set(k, [a]);
  }
  const localRules = await tx.select({
    id: rulesTbl.id, kind: rulesTbl.kind, match: rulesTbl.match, destination: rulesTbl.destination,
    priority: rulesTbl.priority, enabled: rulesTbl.enabled, provenance: rulesTbl.provenance,
    subjectContains: rulesTbl.subjectContains, bodyContains: rulesTbl.bodyContains,
    personDecidedAt: rulesTbl.personDecidedAt,
  }).from(rulesTbl).where(eq(rulesTbl.accountId, o.accountId)).orderBy(asc(rulesTbl.createdAt), asc(rulesTbl.id));
  const localByKey = new Map<string, typeof localRules>();
  for (const row of localRules) {
    const k = ruleKey(row);
    const group = localByKey.get(k);
    if (group) group.push(row);
    else localByKey.set(k, [row]);
  }
  const screenOuts: ApplicableProfileRule[] = [];
  for (const [key, docRows] of docByKey) {
    const localRows = localByKey.get(key) ?? [];
    const n = Math.max(docRows.length, localRows.length);
    for (let i = 0; i < n; i++) {
      const want = docRows[i];
      const have = localRows[i];
      if (want && have) {
        // The person's stamp: written when it arrives, never cleared once held.
        const stamp = have.personDecidedAt ?? want.personDecidedAt;
        const same = have.destination === want.destination && have.priority === want.priority
          && have.enabled === want.enabled && have.provenance === want.provenance
          && (stamp === null) === (have.personDecidedAt === null);
        if (same) continue; // already the document's row — no write, no change row
        if (screensOut(want)) screenOuts.push(want);
        await tx.update(rulesTbl).set({
          destination: want.destination, priority: want.priority,
          enabled: want.enabled, provenance: want.provenance, personDecidedAt: stamp, updatedAt: now,
          // Deliberately NOT re-requesting the retroactive pass: an import restores
          // configuration; the travelling mailbox's mail was filed by its previous
          // organizer, and a confirm click must not become a bulk re-filing.
        }).where(and(eq(rulesTbl.id, have.id), eq(rulesTbl.accountId, o.accountId)));
        changes.push(ruleDelta(o.accountId, have.id, "update"));
      } else if (want) {
        // An older copy's allow of a sender its own Screener lists arrives as the person's: stamped
        // at the import, provenance kept. A row already held under the key takes the arm above.
        const decided = arrivesDecided(want, { stamped: o.doc.producer.stamped === true, admitted: byAddress });
        const [row] = await tx.insert(rulesTbl).values({
          accountId: o.accountId,
          kind: want.kind, match: want.kind === "header" ? want.match : ruleMatchKey(want.match),
          destination: want.destination,
          priority: want.priority, enabled: want.enabled, provenance: want.provenance,
          subjectContains: want.subjectContains, bodyContains: want.bodyContains,
          personDecidedAt: decided ? o.now : want.personDecidedAt,
          retroRequestedAt: null,
        }).returning({ id: rulesTbl.id });
        changes.push(ruleDelta(o.accountId, row!.id, "create"));
        if (screensOut(want)) screenOuts.push(want);
      } else if (have) {
        // A surplus local duplicate of a key the document names — see the merge rule.
        await tx.delete(rulesTbl).where(and(eq(rulesTbl.id, have.id), eq(rulesTbl.accountId, o.accountId)));
        changes.push(ruleDelta(o.accountId, have.id, "delete"));
      }
    }
  }

  /* ── the mail THIS organizer held at the gate for the senders those rules screen out ──
     The app presents a screened-out sender's held mail on the Screened-out shelf, so without
     this the mailbox would keep at the gate what every surface says is screened out. The
     rules still request no retro: only 'us' rows at the gate move (`rerouteOwnHeldBag`). */
  let rerouteSeq: bigint | null = null;
  for (const r of screenOuts) {
    const moved = await rerouteOwnHeldBag(tx, {
      accountId: o.accountId, kind: r.kind as "sender" | "domain", match: r.match,
      appliedFolder: r.destination, now,
    });
    if (moved.lastSeq !== null) rerouteSeq = moved.lastSeq;
  }

  // ── notifyRules, keyed by (kind, target); the key is the whole value ───────────────
  const localNotify = await tx.select({ kind: notifyRulesTbl.kind, target: notifyRulesTbl.target })
    .from(notifyRulesTbl).where(eq(notifyRulesTbl.accountId, o.accountId));
  const notifyHave = new Map<string, number>();
  const notifyKey = (kind: string, target: string): string => JSON.stringify([kind, target.toLowerCase()]);
  for (const nr of localNotify) {
    const k = notifyKey(nr.kind, nr.target);
    notifyHave.set(k, (notifyHave.get(k) ?? 0) + 1);
  }
  let notifyApplied = 0;
  for (const nr of o.doc.notifyRules) {
    if (hasNul(nr.kind) || hasNul(nr.target)) continue;
    notifyApplied += 1;
    const k = notifyKey(nr.kind, nr.target);
    const have = notifyHave.get(k) ?? 0;
    if (have > 0) { notifyHave.set(k, have - 1); continue; }
    await tx.insert(notifyRulesTbl).values({
      accountId: o.accountId, kind: nr.kind, target: nr.target, createdAt: now,
    });
  }

  // ── awayResponder — the single per-account row, replaced wholly when the document
  //    carries one. The audience is narrowed, never widened, when unrecognised: a reply to
  //    a stranger cannot be recalled, and `screened_in` is the value the column's own
  //    default writes.
  let awayApplied = false;
  if (o.doc.awayResponder !== null) {
    const a = o.doc.awayResponder;
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
        .from(awayResponders).where(eq(awayResponders.accountId, o.accountId)).limit(1))[0]?.piles;
      if (keptOrStored !== undefined && !awayScopeFitsAudience(keptOrStored as AwayPile[], audience as AwayAudience)) {
        piles = (keptOrStored as AwayPile[]).filter((q) => awayScopeFitsAudience([q], audience as AwayAudience));
      }
      const [prevAway] = await tx.select({ enabledAt: awayResponders.enabledAt })
        .from(awayResponders).where(eq(awayResponders.accountId, o.accountId)).limit(1);
      const enabledAt = nextEnabledAt(prevAway?.enabledAt ?? null, enabled, now);
      await tx.insert(awayResponders).values({
        accountId: o.accountId, enabled,
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
  const localTags = await tx.select({ name: tagsTbl.name }).from(tagsTbl)
    .where(eq(tagsTbl.accountId, o.accountId));
  const haveTag = new Set(localTags.map((t) => t.name.toLowerCase()));
  let tagsApplied = 0;
  for (const rawName of o.doc.tagNames) {
    // The tag store's own hygiene, applied to a public document's names: trimmed, bounded
    // by the same ceiling the create refuses over, never a control byte.
    const name = rawName.trim();
    if (name.length === 0 || name.length > MAX_TAG_NAME_CHARS || hasNul(name)) continue;
    tagsApplied += 1;
    if (haveTag.has(name.toLowerCase())) continue;
    haveTag.add(name.toLowerCase());
    const [row] = await tx.insert(tagsTbl).values({
      accountId: o.accountId, name, createdAt: now, updatedAt: now,
    }).returning({ id: tagsTbl.id });
    changes.push({ accountId: o.accountId, entityType: "tag", entityId: row!.id, op: "create", meta: null });
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
  await tx.update(mailboxesTbl).set({
    signature: o.doc.signature,
    /* BOTH HALVES OR NEITHER, and the `??` is what makes it terminate. The two columns are one
       value — a markup save derives the text, a plain save clears the markup — so applying the
       text alone would leave this mailbox's old formatting under somebody else's words. An
       ABSENT key means "this sign-off has no formatting", which is `null` in the column, so it
       is written as `null` rather than left alone: the import's convergence test compares the
       local serialization to the held document, and a column the importer never clears makes
       them differ for ever. */
    signatureHtml: o.doc.signatureHtml ?? null,
  })
    .where(and(eq(mailboxesTbl.id, o.mailboxId), eq(mailboxesTbl.accountId, o.accountId)));

  // One allocation for every change row (contacts/notify/away are REST-only, so only the
  // rule and tag writes wake the mirrors), then the answer itself — in THIS transaction, so
  // the applied sections and the resolution that releases the organizer's hold are one
  // commit. A crash between them cannot leave settings applied with the hold still on.
  const seqs = await recordChanges(tx, changes);
  const applied: ProfileImportApplied = {
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
    seq: seqs.length > 0 ? Number(seqs[seqs.length - 1]) : rerouteSeq === null ? null : Number(rerouteSeq),
  };
  await recordProfileImportResolution(tx, {
    accountId: o.accountId, mailboxId: o.mailboxId, decision: "imported", fingerprint: o.fingerprint,
    result: { imported: applied.imported, skippedRules },
  });
  // The ask for this document, if one stands, is answered in the same commit (compare-and-set).
  await resolveImportAsk(tx, {
    accountId: o.accountId, mailboxId: o.mailboxId, fingerprint: o.fingerprint, outcome: "imported",
  });
  return applied;
}
