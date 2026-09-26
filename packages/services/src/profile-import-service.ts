import { and, eq } from "drizzle-orm";
import { dialect } from "@trafficflow/db/dialect";
import {
  assertOrganizerRole, readOrganizerRole,
  mailboxes,
  latestProfileFoundMarker, profileImportResolutionExists, profileImportWriteReleased,
  recordProfileImportResolution,
  askStands, profileImportResult, readImportAsk, recordImportAsk, ringFilingDoorbell,
  type ImportAskRefusal, type Tx,
} from "@trafficflow/db";
import {
  PROFILE_LIST_MAX, PROFILE_VERSION, ProfileUnavailableError, profileFingerprint, oversizedProfileList,
  type OrganizerProfileDoc, type ProfileReadResult,
} from "@trafficflow/core/adapters/organizer-profile";
import {
  PROFILE_IMPORT_LOCK_CLASS, applyOrganizerProfile, importRefusalFor, serializeOrganizerProfile,
  type ProfileImportApplied, type ProfileImportCounts,
} from "@trafficflow/core/adapters/organizer-profile-store";
import { bridgeTx, withAccountTx, type ServiceContext } from "./context.js";
import { ServiceError } from "./errors.js";

/**
 * THE PROFILE IMPORT — the answer side of the portable organizer profile: a versioned JSON
 * document in `ohmail/_meta`, left by the previous organizer (`organizer-profile.ts` is the
 * format). Never auto-applied — the organizer records a found-marker and the decision comes here:
 * `candidate` (marker first, then a FRESH mailbox read, so the confirm counts are the
 * document's), `apply` (natural-key writes in one transaction, resolution marker alongside),
 * `decline` (dismissed durably), `replace` (this install's settings may overwrite it). MERGE:
 * the profile wins for every key it names, unnamed local rows stay; idempotent, no retroactive
 * pass, rules through the product's own validation (failures SKIPPED); NEWER offers nothing.
 */

/** A fresh read of the mailbox's profile document. Built by the route from the live adapter. */
export type ProfileReader = () => Promise<ProfileReadResult>;

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
   * Answered "Not now" and still in the mailbox, never overwritten. Settings offers Import or
   * Replace. Read from the found-marker alone, so it never dials; the counts are the document's
   * as it was detected.
   */
  | {
    state: "declined";
    fingerprint: string;
    updatedAt: string;
    producer: { kind: string; version: string };
    counts: ProfileImportCounts;
  }
  /**
   * Too large to apply in one transaction. Nothing is offered, as for `newer`: a partial import
   * is a settings restore that silently omits some. It carries the offending list, both numbers
   * and the document's `fingerprint`, so the content-keyed `decline` can be recorded — without it
   * a client could never stop being asked and every poll would re-dial the mailbox. It does NOT
   * yet get a card: the shared reader (`ProfileImportCard#asOffer`) treats any unrecognised state
   * as no offer — safe but silent; the wire half is done, the surface half is not.
   */
  | { state: "too_large"; fingerprint: string; list: string; count: number; max: number }
  /** A press handed to the organizer and not yet answered — read from rows, never a dial. */
  | { state: "importing"; fingerprint: string };

/**
 * A press whose read did not fit the request, handed to the organizer — answered 202. `slow`: the
 * mailbox answered too slowly for one request; `unreachable`: this request could not dial it;
 * absent when the same press was already waiting. The card then asks {@link status}.
 */
export interface ProfileImportHandedOver {
  state: "importing";
  fingerprint: string;
  reason?: "slow" | "unreachable";
}

/** Why a handed-over press ended without an import: the stored reasons, and `superseded`. */
type ProfileImportStatusRefusal = ImportAskRefusal | "superseded";

/** Where a handed-over press stands, as `GET …/profile-import/status` answers it. */
export type ProfileImportStatusDTO =
  | { state: "importing"; fingerprint: string }
  | { state: "imported"; imported: ProfileImportCounts | null; skippedRules: number }
  | { state: "refused"; reason: ProfileImportStatusRefusal; message: string };

export { PROFILE_IMPORT_LOCK_CLASS, type ProfileImportApplied, type ProfileImportCounts };

/** The document could not be read from the mailbox — never "there is nothing to import". */
const profileUnreadable = (): ServiceError => new ServiceError(
  "profile_unreadable", 502,
  "The mailbox could not be checked for saved ohmail settings. Try again.",
);

/** The API door's own clock running out, by code — `imap-budget.ts#imapDoorTimedOut`. */
const MAILBOX_READ_TIMEOUT = "mailbox_read_timeout";

/**
 * THE SENTENCE FOR EACH REFUSAL, said once and naming what is true — the inline press's 409/413
 * and the organizer's answer to a handed-over one read the same words.
 */
const REFUSAL_SENTENCE: Record<ProfileImportStatusRefusal, string> = {
  changed: "The saved settings changed since you looked. Review them again before importing.",
  gone: "The saved settings are no longer in the mailbox. Nothing was changed.",
  newer: "These settings were saved by a newer version of ohmail — update ohmail to import them.",
  too_large: "These saved settings hold more entries than one import can apply. Nothing was changed.",
  unreadable: "The saved settings in the mailbox cannot be read. Nothing was changed.",
  timed_out: "The mailbox did not answer for ten minutes, so the settings were not imported.",
  not_organizer: "This ohmail no longer organizes the mailbox, so it did not import the settings.",
  superseded: "A later Import settings replaced this one.",
};

/** The inline refusals keep the wire codes the clients already read. */
const INLINE_REFUSAL: Record<ImportAskRefusal, { code: string; status: number }> = {
  changed: { code: "profile_changed", status: 409 },
  gone: { code: "profile_changed", status: 409 },
  newer: { code: "profile_newer", status: 409 },
  too_large: { code: "payload_too_large", status: 413 },
  unreadable: { code: "profile_document_unreadable", status: 409 },
  timed_out: { code: "profile_changed", status: 409 },
  not_organizer: { code: "not_organizer", status: 409 },
};

const refusalError = (reason: ImportAskRefusal): ServiceError =>
  new ServiceError(INLINE_REFUSAL[reason].code, INLINE_REFUSAL[reason].status, REFUSAL_SENTENCE[reason]);

const asTx = (ctx: ServiceContext): Tx => bridgeTx(ctx.db);

/**
 * HOW LARGE A DOCUMENT `apply` WILL IMPORT, PER LIST — the format's {@link PROFILE_LIST_MAX},
 * which the serializer publishes within, so a document ohmail wrote always fits. A document over
 * it came from elsewhere: REFUSED, not truncated, because a partial import silently omits rules.
 * Refused in `candidate()` too — never offer what `apply` would 413.
 */
export const PROFILE_IMPORT_MAX = PROFILE_LIST_MAX;


/**
 * The declined answer, from the found-marker's own payload (`profile.ts#writeMarker`). A marker
 * missing any of its fields (an older row) offers nothing rather than a row with holes in it.
 */
function declinedFrom(
  fingerprint: string, m: Awaited<ReturnType<typeof latestProfileFoundMarker>> & object,
): ProfileImportCandidateDTO {
  const c = m.counts;
  if (typeof m.updatedAt !== "string" || !m.producer || !c) return { state: "none" };
  return {
    state: "declined",
    fingerprint,
    updatedAt: m.updatedAt,
    producer: { kind: m.producer.kind, version: m.producer.version },
    counts: {
      screener: c.screener, rules: c.rules, notifyRules: c.notifyRules, tags: c.tagNames,
      awayResponder: c.awayResponder > 0,
    },
  };
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
   * already answered, and the answer is `none` (or `declined`, for a "Not now" whose document
   * still stands) from indexed reads alone. Only an OPEN question costs an IMAP connection, and
   * it returns the folder's CURRENT document, so changed content is offered under its own
   * fingerprint and a vanished document is not offered at all.
   */
  async candidate(
    ctx: ServiceContext, mailboxId: string, opts: { read: ProfileReader },
  ): Promise<ProfileImportCandidateDTO> {
    await this.assertMailbox(ctx, mailboxId);
    const db = asTx(ctx);

    // ONLY AN ORGANIZER IS ASKED. A demoted reader keeps its organizer-era marker, and a
    // `declined` answer there would offer a write press on an install that never writes.
    const role = await readOrganizerRole(db, dialect(ctx.db), ctx.accountId, mailboxId);
    if (role?.role !== "organizer") return { state: "none" };

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
    // A press already handed to the organizer: the answer is on its way, so nothing is asked again.
    const asked = await readImportAsk(db, { accountId: ctx.accountId, mailboxId });
    if (askStands(asked, ctx.now())) return { state: "importing", fingerprint: asked.fingerprint };
    if (await profileImportResolutionExists(db, {
      accountId: ctx.accountId, mailboxId, fingerprint: marker.fingerprint,
    })) {
      // Answered. A decline leaves the document standing and the write held, and Settings says so.
      if (await profileImportWriteReleased(db, {
        accountId: ctx.accountId, mailboxId, fingerprint: marker.fingerprint,
      })) return { state: "none" };
      return declinedFrom(marker.fingerprint, marker);
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
    const over = oversizedProfileList(fresh.doc);
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
    // AT THE DOCUMENT'S CANONICAL VERSION, not at this build's. The fingerprint is taken over a
    // versioned canonical form, so hashing the local store at v2 and a v1 document at v1 answers
    // "were these written by the same build", not "do they say the same thing" — and this line
    // decides whether the person is shown an import card for settings they already have.
    if (profileFingerprint(local, fresh.doc.v) === fingerprint) return { state: "none" };

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
   * screen asks again over the new content rather than applying something nobody confirmed. A
   * read that does not fit the request hands the press to the organizer (`importing`).
   */
  async apply(
    ctx: ServiceContext, mailboxId: string, body: { fingerprint?: unknown }, opts: { read: ProfileReader },
  ): Promise<ProfileImportApplied | ProfileImportHandedOver> {
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

    /* THE TICKET FIRST, and no dial when it answers: the same press already waiting is the same
       202, and one already imported is the 200 it would have been. */
    const now = ctx.now();
    const asked = await readImportAsk(asTx(ctx), { accountId: ctx.accountId, mailboxId });
    if (asked !== null && asked.fingerprint === fingerprint) {
      if (askStands(asked, now)) return { state: "importing", fingerprint };
      if (asked.outcome === "imported") {
        const result = await profileImportResult(asTx(ctx), { accountId: ctx.accountId, mailboxId, fingerprint });
        if (result !== null) return { ...result, seq: null };
      }
    }

    let fresh: ProfileReadResult;
    try {
      fresh = await opts.read();
    } catch (err) {
      if (!(err instanceof ProfileUnavailableError)) throw err;
      /* THE READ DID NOT FIT THIS REQUEST — a slow provider, or a dial that failed here. The press
         is recorded and handed to the organizer, which reads the document on its own connection
         and applies it through the same merge; the doorbell brings its next cycle forward. */
      // FOR UPDATE at the head: this transaction writes the mailbox row it fences, and two presses
      // sharing it first and upgrading after would deadlock (`erasure-fence.ts#readAccountErasedAt`).
      await withAccountTx(ctx, async (tx) => {
        await recordImportAsk(tx, { accountId: ctx.accountId, mailboxId, fingerprint, now });
        await ringFilingDoorbell(tx, mailboxId, now);
      }, { mailboxId, lock: "update" });
      return { state: "importing", fingerprint, reason: err.code === MAILBOX_READ_TIMEOUT ? "slow" : "unreachable" };
    }
    const refusal = importRefusalFor(fresh, fingerprint);
    const over = fresh.state === "found" ? oversizedProfileList(fresh.doc) : null;
    if (refusal === "too_large" && over) {
      // Inline, the list and both numbers are in hand, so the sentence names them.
      throw new ServiceError(
        "payload_too_large", 413,
        `these saved settings hold ${over.count} ${over.list} entries, over the ${over.max} this ` +
          "import can apply in one go. Nothing was changed.",
      );
    }
    if (refusal !== null || fresh.state !== "found") throw refusalError(refusal ?? "changed");
    const doc = fresh.doc;

    // The account fence alone, as before the hand-over existed: the merge's lock serializes
    // appliers, and a mailbox share taken ahead of it would deadlock their mailbox-row update.
    return withAccountTx(ctx, async (tx) => applyOrganizerProfile(tx, {
      accountId: ctx.accountId, mailboxId, doc, fingerprint, now,
    }));
  }

  /**
   * Where a press handed to the organizer stands: `importing` while it waits inside the TTL,
   * then `imported` with what arrived, or `refused` naming what is true — `timed_out` from the
   * press's own age when no organizer answered, `superseded` when a later press replaced it.
   * One primary-key read; never dials.
   */
  async status(
    ctx: ServiceContext, mailboxId: string, query: { fingerprint?: unknown },
  ): Promise<ProfileImportStatusDTO> {
    await this.assertMailbox(ctx, mailboxId);
    const fingerprint = query.fingerprint;
    if (typeof fingerprint !== "string" || fingerprint.length === 0 || fingerprint.length > 200) {
      throw new ServiceError("validation_failed", 400, "fingerprint is required");
    }
    const row = await readImportAsk(asTx(ctx), { accountId: ctx.accountId, mailboxId });
    const refused = (reason: ProfileImportStatusRefusal): ProfileImportStatusDTO =>
      ({ state: "refused", reason, message: REFUSAL_SENTENCE[reason] });
    if (row === null || row.fingerprint !== fingerprint) return refused("superseded");
    if (row.outcome === "imported") {
      const result = await profileImportResult(asTx(ctx), { accountId: ctx.accountId, mailboxId, fingerprint });
      return { state: "imported", imported: result?.imported ?? null, skippedRules: result?.skippedRules ?? 0 };
    }
    if (row.outcome === "refused") return refused(row.reason ?? "unreadable");
    if (row.organizerRole !== "organizer") return refused("not_organizer");
    return askStands(row, ctx.now()) ? { state: "importing", fingerprint } : refused("timed_out");
  }

  /**
   * The user said "Not now". Nothing is applied and nothing in the mailbox is touched: the durable
   * resolution dismisses the prompt and settles routing, and the organizer's write hold STANDS, so
   * the declined document stays in the mailbox (see {@link replace}). Keyed to the exact content
   * declined: a DIFFERENT document appearing later legitimately re-asks.
   */
  async decline(
    ctx: ServiceContext, mailboxId: string, body: { fingerprint?: unknown; v?: unknown },
  ): Promise<void> {
    await this.assertMailbox(ctx, mailboxId);
    const fingerprint = typeof body.fingerprint === "string" && body.fingerprint.length > 0
      ? body.fingerprint : null;
    // GREATER THAN WHAT THIS BUILD WRITES — the same test the reader makes. It was the literal
    // `1`, which was that test only while this build wrote v1: at v2 it would file a dismissal of
    // an ordinary readable document as a newer-format one, keyed to a version number instead of
    // to the content, and the content question would go on being asked.
    const newerV = typeof body.v === "number" && Number.isSafeInteger(body.v) && body.v > PROFILE_VERSION
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

  /**
   * "Save this ohmail's settings to the mailbox": releases the organizer's write hold on the exact
   * document named, so its next flush overwrites it. Applies nothing and never dials; the same
   * lock and write-once row as {@link decline}. A newer-format document cannot be replaced, and a
   * reader is refused (409): it does not write this mailbox's settings.
   */
  async replace(
    ctx: ServiceContext, mailboxId: string, body: { fingerprint?: unknown },
  ): Promise<void> {
    await this.assertMailbox(ctx, mailboxId);
    const fingerprint = body.fingerprint;
    if (typeof fingerprint !== "string" || fingerprint.length === 0) {
      throw new ServiceError("validation_failed", 400, "fingerprint is required");
    }
    await asTx(ctx).transaction(async (tx) => {
      await dialect(ctx.db).advisoryLock(tx, PROFILE_IMPORT_LOCK_CLASS, ctx.accountId);
      await assertOrganizerRole(tx, dialect(ctx.db), ctx.accountId, mailboxId);
      await recordProfileImportResolution(tx, {
        accountId: ctx.accountId, mailboxId, decision: "replaced", fingerprint,
      });
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
