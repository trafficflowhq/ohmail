import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { dialect } from "@trafficflow/db/dialect";
import {
  accountSettings, accounts, auditLog, awayResponders, changeLog, contacts, eraseOwedMailbox, folderState, mailboxCredentials, mailboxes,
  mailboxProfileMirror, messages, organizerRequests, profileImportWriteReleased, rules, settleReaderRuleRows, tags,
  PROFILE_COPY_AUDIT_ACTION, PROFILE_FOUND_AUDIT_ACTION, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION, recordProfileCopy,
  type Tx,
} from "@trafficflow/db";
import {
  PROFILE_VERSION, formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
  signatureReceipt,
  type OrganizerProfileDoc, type OrganizerProfilePayload, type ProfileReadResult,
} from "@trafficflow/core/adapters/organizer-profile";
import { effectiveMailboxSignatures } from "../src/consent-seed.js";
import { serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { awayScopeFitsAudience, type AwayPile } from "@trafficflow/core/mail";
import { PROFILE_IMPORT_MAX, profileImportService, type ProfileImportApplied } from "../src/profile-import-service.js";
import { mailboxService } from "../src/mailbox-service.js";
import { ServiceError } from "../src/errors.js";
import type { Db, ServiceContext } from "../src/context.js";

/**
 * The confirm's INLINE answer. Every read in this file fits the request, so a hand-over to the
 * organizer (`importing`, answered 202) is a failure of the case rather than a shape to read.
 */
async function inlineApply(
  ...args: Parameters<typeof profileImportService.apply>
): Promise<ProfileImportApplied> {
  const r = await profileImportService.apply(...args);
  if ("state" in r) throw new Error(`the press was handed to the organizer: ${JSON.stringify(r)}`);
  return r;
}


/**
 * THE PROFILE IMPORT at the service boundary (the organizer's half is `apps/worker`'s, the format
 * `packages/core`'s). (1) The candidate is the organizer's record and never dials: no marker, or an
 * answered one, is `none` (`declined` for a "Not now" still standing). (2) Apply
 * writes by natural keys and converges: an applied document serializes back to its own
 * fingerprint. (3) The merge rule: the profile wins for keys it names, local-only keys stay,
 * another account's keys are untouchable. (4) Idempotence. (5) Honest refusals: 409 for a changed
 * document, no partial newer import, 502 for an unreadable mailbox. (6) Decline is durable and
 * inert; replace is the explicit write release.
 */

const NOW = new Date("2026-08-17T12:00:00.000Z");

interface World {
  db: Db;
  ctx: ServiceContext;
  accountId: string;
  mailboxId: string;
}

async function world(): Promise<World> {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `import-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${accountId.slice(0, 8)}@trafficflow.test`,
  }).returning();
  // A mailbox this install can reach: the card's question offers nothing for one it cannot.
  await db.insert(mailboxCredentials).values({ mailboxId: mb!.id, transport: "imap", secretEnc: "sealed", keyVersion: 1 });
  const ctx = { db, accountId, now: () => NOW } as unknown as ServiceContext;
  return { db, ctx, accountId, mailboxId: mb!.id };
}

/** The travelling configuration most tests import — every section populated. */
const PAYLOAD: OrganizerProfilePayload = {
  screener: [
    { address: "anna@example.com", name: "Anna" },
    { address: "boris@example.com" },
  ],
  rules: [
    {
      kind: "sender", match: "anna@example.com", destination: "ohmail/News",
      priority: 0, enabled: true, provenance: "promoted",
    },
    {
      kind: "domain", match: "newsletter.example", destination: "ohmail/Screened",
      priority: 1, enabled: true, provenance: "manual",
    },
    {
      kind: "sender", match: "alerts@example.com", destination: "ohmail/Receipts",
      priority: 0, enabled: false, provenance: "manual", subjectContains: "[invoice]",
    },
  ],
  notifyRules: [{ kind: "sender", target: "boss@example.com" }],
  awayResponder: {
    enabled: true, body: "Back Monday.", throttle: "per_day",
    startsAt: "2026-08-01T00:00:00.000Z", endsAt: null, audience: "screened_in",
    /* EXPLICIT, and not the default, for the reason the signature key below states: a fixture that
       leaves `piles` out is not exercising the field, and this payload is what every case here
       builds its document from. It is also what makes the convergence cases a proof about a
       document THIS release writes — one written before the field existed converges only through
       the resolved-row release, which is its own case at the end of this block. */
    piles: ["INBOX", "ohmail/News"],
  },
  tagNames: ["Invoices", "Travel"],
  /* EXPLICIT, not omitted (mail 0094). `canonicalizeProfilePayload` normalises an absent value to
     null so the two spellings cannot hash differently, but a fixture that leaves the key out is
     not exercising the field — and this payload is the one every case below builds a document
     from. Null here is the ordinary case; the case where a signature actually travels is its own
     test at the end of the apply block. */
  signature: null,
};

function doc(payload: OrganizerProfilePayload = PAYLOAD): OrganizerProfileDoc {
  return makeProfileDoc(payload, {
    updatedAt: new Date("2026-08-10T09:00:00.000Z"),
    producer: { kind: "local", version: "0.9.3" },
  });
}

/** The same configuration as an ohmail on format `version` wrote it. */
function docAt(version: number, payload: OrganizerProfilePayload = PAYLOAD): OrganizerProfileDoc {
  return makeProfileDoc(payload, {
    updatedAt: new Date("2026-08-10T09:00:00.000Z"),
    producer: { kind: "local", version: "0.17.0" },
  }, version);
}

/** A reader that answers `found` with this document, counting its calls. */
function foundReader(d: OrganizerProfileDoc): { read: () => Promise<ProfileReadResult>; calls: () => number } {
  let calls = 0;
  return {
    read: async () => {
      calls += 1;
      return {
        state: "found", doc: d, installId: "someone-elses-install", ref: 1, residue: 0,
        // The generation the ref was read under: a locator is the PAIR, never the uid alone.
        generation: 1_000,
      };
    },
    calls: () => calls,
  };
}

const neverReader = (): (() => Promise<ProfileReadResult>) => async () => {
  throw new Error("the mailbox must not be dialled on this path");
};

/** Seed the organizer's found-marker exactly as `apps/worker/src/profile.ts#writeMarker` shapes it. */
async function seedHeldMarker(w: World, d: OrganizerProfileDoc, signature?: number, copyReceipt?: string): Promise<string> {
  const fingerprint = profileFingerprint(d);
  await w.db.insert(auditLog).values({
    accountId: w.accountId,
    action: PROFILE_FOUND_AUDIT_ACTION,
    payload: {
      mailboxId: w.mailboxId, state: "found", fingerprint, heldForImport: true,
      updatedAt: d.updatedAt, producer: d.producer,
      ...(copyReceipt === undefined ? {} : { signatureReceipt: copyReceipt }),
      counts: {
        screener: d.screener.length, rules: d.rules.length, notifyRules: d.notifyRules.length,
        tagNames: d.tagNames.length, awayResponder: d.awayResponder === null ? 0 : 1,
        ...(signature === undefined ? {} : { signature }),
      },
    },
    inverse: null,
  });
  return fingerprint;
}

async function seedNewerMarker(w: World, v: number): Promise<void> {
  await w.db.insert(auditLog).values({
    accountId: w.accountId,
    action: PROFILE_FOUND_AUDIT_ACTION,
    payload: { mailboxId: w.mailboxId, state: "newer", fingerprint: null, heldForImport: false, v },
    inverse: null,
  });
}

const changeRows = (db: Db, accountId: string) =>
  db.select().from(changeLog).where(eq(changeLog.accountId, accountId));

const resolutionRows = (db: Db, accountId: string) =>
  db.select().from(auditLog).where(and(
    eq(auditLog.accountId, accountId), eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION),
  ));

describe("the import candidate", () => {
  it("no marker ⇒ none, and the mailbox is never dialled", async () => {
    const w = await world();
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toEqual({ state: "none" });
  });

  it("an open held marker ⇒ the organizer's recorded counts, producer and fingerprint, and nothing dials", async () => {
    const w = await world();
    const d = doc();
    await seedHeldMarker(w, d);
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toEqual({
      state: "found",
      fingerprint: profileFingerprint(d),
      updatedAt: d.updatedAt,
      producer: { kind: "local", version: "0.9.3" },
      counts: { screener: 2, rules: 3, notifyRules: 1, tags: 2, awayResponder: true, signature: false },
    });
  });

  it("the card names the signature when the organizer counted one; a marker without the key says none", async () => {
    const w = await world();
    const d = doc({ ...PAYLOAD, signature: "-- \nMila" });
    await seedHeldMarker(w, d, 1);
    expect(await profileImportService.candidate(w.ctx, w.mailboxId))
      .toMatchObject({ state: "found", counts: { signature: true } });
    const older = await world();
    await seedHeldMarker(older, d);
    expect(await profileImportService.candidate(older.ctx, older.mailboxId))
      .toMatchObject({ state: "found", counts: { signature: false } });
  });

  it("a marker the organizer wrote as the INCUMBENT (unheld) is not an import question", async () => {
    const w = await world();
    const d = doc();
    await w.db.insert(auditLog).values({
      accountId: w.accountId,
      action: PROFILE_FOUND_AUDIT_ACTION,
      payload: {
        mailboxId: w.mailboxId, state: "found",
        fingerprint: profileFingerprint(d), heldForImport: false,
      },
      inverse: null,
    });
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toEqual({ state: "none" });
  });

  it("an already-ANSWERED marker is none, from the database alone — no dial", async () => {
    const w = await world();
    const d = doc();
    const fingerprint = await seedHeldMarker(w, d);
    await profileImportService.replace(w.ctx, w.mailboxId, { fingerprint });
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toEqual({ state: "none" });
  });

  it("a document already EQUAL to the local store asks nothing — an import would change nothing", async () => {
    const w = await world();
    const d = doc();
    await seedHeldMarker(w, d);
    // The local store already says exactly what the document says (the hand-made convergence).
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read });
    // Wipe the resolution the apply recorded, so THIS test isolates the equality check itself.
    await w.db.delete(auditLog).where(eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION));
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toEqual({ state: "none" });
  });

  it("a v1 document already equal to the local store asks nothing EITHER — a version is not a difference", async () => {
    /**
     * The fingerprint is taken over a VERSIONED canonical form. Hashing the local store at this
     * build's version and an older ohmail's document at v1 compares two different questions'
     * answers: it says "different" about configuration that is identical, and what a person sees
     * is an import card offering to restore the settings they are already using — which cannot be
     * made to go away, because the next read asks the same way. The content question is asked at
     * the DOCUMENT's version, and this is the case that says so.
     */
    const w = await world();
    const current = doc();
    await seedHeldMarker(w, current);
    await profileImportService.apply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(current) }, { read: foundReader(current).read },
    );
    await w.db.delete(auditLog).where(eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION));
    await w.db.delete(auditLog).where(eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION));

    const older = docAt(1);
    expect(older.v, "the fixture is not a v1 document").toBe(1);
    expect(profileFingerprint(older), "the two versions hash alike — the fixture proves nothing")
      .not.toBe(profileFingerprint(current));
    await seedHeldMarker(w, older);
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toEqual({ state: "none" });
  });

  it("a copy of a store holding a priority past the bound, as every reader reads both, asks nothing", async () => {
    const w = await world();
    const rule = { kind: "sender", match: "hi@example.com", destination: "ohmail/News", priority: 1500, enabled: true, provenance: "manual" };
    await w.db.insert(rules).values({ accountId: w.accountId, ...rule });
    // The copy another install wrote from the same store, as a reader parses it: the priority at the bound.
    const parsed = parseProfileMessage(formatProfileMessage(makeProfileDoc({
      screener: [], rules: [rule], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
    }, { updatedAt: new Date("2026-08-10T09:00:00.000Z"), producer: { kind: "local", version: "0.25.3" } }), { installId: "someone-elses-install" }));
    if (parsed === null || isMalformedProfile(parsed)) throw new Error("the fixture copy is unreadable");
    await seedHeldMarker(w, parsed.doc!);
    expect(await profileImportService.candidate(w.ctx, w.mailboxId)).toEqual({ state: "none" });
  });

  it("a newer-format document surfaces as `newer` and offers no import", async () => {
    const w = await world();
    await seedNewerMarker(w, PROFILE_VERSION + 1);
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toEqual({ state: "newer", v: PROFILE_VERSION + 1 });
  });

  it("a dismissed `newer` notice stays dismissed, with no dial", async () => {
    const w = await world();
    // ABOVE what this build writes — the literal `2` stopped meaning "newer" when the writer
    // reached v2, and the decline then refused the dismissal as a missing fingerprint.
    await seedNewerMarker(w, PROFILE_VERSION + 1);
    await profileImportService.decline(w.ctx, w.mailboxId, { v: PROFILE_VERSION + 1 });
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toEqual({ state: "none" });
  });

  it("a removed mailbox has nothing to offer: its held marker answers `none`, never a 502", async () => {
    const w = await world();
    const fingerprint = await seedHeldMarker(w, doc());
    expect(await profileImportService.candidate(w.ctx, w.mailboxId)).toMatchObject({ state: "found", fingerprint });
    // What the removal leaves: the tombstone, and no credential.
    await w.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, w.mailboxId));
    await w.db.delete(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, w.mailboxId));
    expect(await profileImportService.candidate(w.ctx, w.mailboxId)).toEqual({ state: "none" });
  });

  it("a mailbox this install holds no credential for (signed out) has nothing to offer", async () => {
    const w = await world();
    await seedHeldMarker(w, doc());
    await w.db.delete(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, w.mailboxId));
    expect(await profileImportService.candidate(w.ctx, w.mailboxId)).toEqual({ state: "none" });
  });

  it("a tombstone that still holds a credential row offers nothing either — `disabled` alone decides", async () => {
    const w = await world();
    await seedHeldMarker(w, doc());
    await w.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, w.mailboxId));
    expect(await profileImportService.candidate(w.ctx, w.mailboxId)).toEqual({ state: "none" });
  });

  it("a mailbox whose organizer could not keep its settings copy says so beside every answer, until a copy is kept", async () => {
    const w = await world();
    const unkept = { kept: false, code: "profile_append_unreadable" };
    await recordProfileCopy(w.db as unknown as Tx, { accountId: w.accountId, mailboxId: w.mailboxId, ...unkept, at: NOW });
    expect(await profileImportService.candidate(w.ctx, w.mailboxId)).toEqual({ state: "none", copy: unkept });
    const fingerprint = await seedHeldMarker(w, doc());
    expect(await profileImportService.candidate(w.ctx, w.mailboxId)).toMatchObject({ state: "found", fingerprint, copy: unkept });
    await recordProfileCopy(w.db as unknown as Tx, {
      accountId: w.accountId, mailboxId: w.mailboxId, kept: true, code: null, at: new Date(NOW.getTime() + 60_000),
    });
    expect(await profileImportService.candidate(w.ctx, w.mailboxId)).toMatchObject({ state: "found", copy: { kept: true, code: null } });
    // Another mailbox's record says nothing here.
    const other = await world();
    expect(await profileImportService.candidate(other.ctx, other.mailboxId)).toEqual({ state: "none" });
  });

  it("the copy record is written on a change, renewed before the audit log's age-out, and never for a mailbox that kept its copy", async () => {
    const w = await world();
    const rows = async (): Promise<unknown[]> => (await w.db.select().from(auditLog).where(and(
      eq(auditLog.accountId, w.accountId), eq(auditLog.action, PROFILE_COPY_AUDIT_ACTION),
    )).orderBy(auditLog.createdAt)).map((r) => r.payload);
    const at = (days: number): Date => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
    const record = (kept: boolean, days: number): Promise<void> => recordProfileCopy(w.db as unknown as Tx, {
      accountId: w.accountId, mailboxId: w.mailboxId, kept, code: kept ? null : "profile_append_unreadable", at: at(days),
    });
    await record(true, 0);
    expect(await rows(), "a mailbox that never failed got a record").toEqual([]);
    await record(false, 0);
    await record(false, 1);
    expect(await rows()).toHaveLength(1);
    await record(false, 31);
    expect(await rows(), "a standing refusal was not renewed").toHaveLength(2);
    await record(true, 32);
    await record(true, 33);
    expect(await rows()).toEqual([
      { mailboxId: w.mailboxId, kept: false, code: "profile_append_unreadable" },
      { mailboxId: w.mailboxId, kept: false, code: "profile_append_unreadable" },
      { mailboxId: w.mailboxId, kept: true, code: null },
    ]);
  });

  it("…and only where this install organizes: a reader or a removed mailbox carries no copy line", async () => {
    const w = await world();
    await recordProfileCopy(w.db as unknown as Tx, { accountId: w.accountId, mailboxId: w.mailboxId, kept: false, code: "profile_append_unreadable" });
    await w.db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, w.mailboxId));
    expect(await profileImportService.candidate(w.ctx, w.mailboxId)).toEqual({ state: "none" });
    await w.db.update(mailboxes).set({ organizerRole: "organizer", status: "disabled" }).where(eq(mailboxes.id, w.mailboxId));
    expect(await profileImportService.candidate(w.ctx, w.mailboxId)).toEqual({ state: "none" });
  });

  it("a cross-account mailbox id is indistinguishable from a missing one", async () => {
    const w = await world();
    const other = await world();
    await expect(profileImportService.candidate(w.ctx, other.mailboxId))
      .rejects.toMatchObject({ code: "not_found", httpStatus: 404 });
  });
});

describe("apply — natural keys, one transaction, convergence", () => {
  it("round-trips: a document applied into an empty store serializes back to its own fingerprint (the hold-release condition)", async () => {
    const w = await world();
    const d = doc();
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.imported).toEqual({ screener: 2, rules: 3, notifyRules: 1, tags: 2, awayResponder: true, signature: false });
    expect(result.skippedRules).toBe(0);
    // THE CONVERGENCE PROOF. The organizer's hold releases when the local store's own
    // serialization equals the held document — the exact comparison its dirty check makes —
    // and this is that comparison, through the same serializer.
    const local = await serializeOrganizerProfile(w.db as unknown as Tx, w.accountId, w.mailboxId);
    expect(profileFingerprint(local)).toBe(profileFingerprint(d));
    // …and the resolution that covers the non-converging outcomes is durably beside it.
    const res = await resolutionRows(w.db, w.accountId);
    expect(res).toHaveLength(1);
    expect(res[0]!.payload).toMatchObject({
      mailboxId: w.mailboxId, decision: "imported", fingerprint: profileFingerprint(d),
    });
  });

  it("mail 0094 — the signature travels, lands on THIS mailbox, and the round trip still converges", async () => {
    const w = await world();
    const SIG = "-- \nMila Brunner\nlichtgrat studio";
    const d = doc({ ...PAYLOAD, signature: SIG });

    /* THE PRECONDITION, asserted rather than assumed: the store must not already hold the value,
       or a green here would prove nothing about the importer. */
    const before = await w.db.select({ signature: mailboxes.signature })
      .from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(before[0]!.signature, "the fixture already carried a signature").toBeNull();

    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.imported.signature, "the done line cannot say the signature came back").toBe(true);

    const after = await w.db.select({ signature: mailboxes.signature })
      .from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(after[0]!.signature, "the document's signature never reached the mailbox row").toBe(SIG);

    /* AND THE HOLD RELEASES. This is the assertion the importer would fail without the write
       above, and it is the one that matters: the organizer's hold lifts when the local store's
       own serialization equals the held document. A section the importer skips makes those two
       unequal FOR EVER — the prompt returns on every cycle and nothing reports an error, because
       "these documents differ" is a true statement about a state nobody can leave. */
    const local = await serializeOrganizerProfile(w.db as unknown as Tx, w.accountId, w.mailboxId);
    expect(profileFingerprint(local),
      "the local store does not serialize back to the document it just imported")
      .toBe(profileFingerprint(d));
  });

  it("a copy with NO signature leaves the one typed on this mailbox, text and markup; the hold still ends", async () => {
    /* An Import never erases a signature (ruled 2026-11-01): the card says Import adds. The hold
       ends on the `imported` answer, not on the store converging (`profileImportWriteReleased`). */
    const w = await world();
    const TYPED = { signature: "-- \njust typed", signatureHtml: "<p>-- <br>just <em>typed</em></p>" };
    await w.db.update(mailboxes).set(TYPED).where(eq(mailboxes.id, w.mailboxId));
    const d = doc();                       // PAYLOAD carries `signature: null`
    await seedHeldMarker(w, d, 0);
    const offer = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(offer).toMatchObject({ state: "found", counts: { signature: false } });
    expect(offer.state === "found" && offer.counts.signatureReplaces, "a copy with no signature replaces one").toBeFalsy();

    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.imported).toEqual({ screener: 2, rules: 3, notifyRules: 1, tags: 2, awayResponder: true, signature: false });
    const after = await w.db.select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
      .from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(after[0], "the import erased the signature typed on this mailbox").toEqual(TYPED);
    expect((await effectiveMailboxSignatures(w.db, w.accountId)).signatures[w.mailboxId]).toBe(TYPED.signature);
    expect(await profileImportWriteReleased(w.db as unknown as Tx, {
      accountId: w.accountId, mailboxId: w.mailboxId, fingerprint: profileFingerprint(d),
    }), "the organizer's hold never ends").toBe(true);
  });

  it("the signature's MARKUP travels with it when the press names the signature it replaces", async () => {
    /* THE HOLE THIS CASE EXISTS TO CLOSE, and it was found by watching a mutation stay GREEN:
       deleting the importer's `signatureHtml` write left all 47 cases here and in the key census
       passing, so nothing measured that the markup half is applied at all.

       Both columns are ONE value — a markup save derives the text, a plain save clears the markup
       — so an importer that wrote the text alone would leave this mailbox's old formatting under
       somebody else's words, and every message sent from it would carry a sign-off nobody wrote.
       The press names the signature it replaces (the card said so), so the copy's takes its place. */
    const w = await world();
    const SIG = "-- \nMila Brunner";
    const HTML = "<p>-- <br>Mila <strong>Brunner</strong></p>";

    // The precondition, asserted: this machine holds DIFFERENT markup, so a green cannot come
    // from the fixture already agreeing with the document.
    const HAD = { signature: "-- \nsomething this machine had", signatureHtml: "<p>-- <br>something <em>this machine</em> had</p>" };
    await w.db.update(mailboxes).set(HAD).where(eq(mailboxes.id, w.mailboxId));

    const d = doc({ ...PAYLOAD, signature: SIG, signatureHtml: HTML });
    await profileImportService.apply(w.ctx, w.mailboxId, {
      fingerprint: profileFingerprint(d), signatureReplaces: signatureReceipt(HAD.signature, HAD.signatureHtml),
    }, { read: foundReader(d).read });

    const after = await w.db
      .select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
      .from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(after[0]!.signature).toBe(SIG);
    expect(after[0]!.signatureHtml, "the document's markup never reached the mailbox row")
      .toBe(HTML);
    const local = await serializeOrganizerProfile(w.db as unknown as Tx, w.accountId, w.mailboxId);
    expect(profileFingerprint(local),
      "the local store does not serialize back to the document it just imported")
      .toBe(profileFingerprint(d));
  });

  it("a document whose signature is PLAIN clears markup this machine had under it, when the press names it", async () => {
    /* The other direction, and the one that decides whether the write is `?? null` or a
       conditional: an ABSENT key means "this sign-off has no formatting", which is `null` in the
       column. An importer that only wrote markup when the document carried some would leave the
       old formatting standing under the new words — the same wrong-sign-off outcome as above,
       reached by the arm a conditional would take. */
    const w = await world();
    const HAD = { signature: "-- \nsomething this machine had", signatureHtml: "<p>-- <br>something <em>this machine</em> had</p>" };
    await w.db.update(mailboxes).set(HAD).where(eq(mailboxes.id, w.mailboxId));

    const d = doc({ ...PAYLOAD, signature: "-- \nMila Brunner" });   // no `signatureHtml` key
    await profileImportService.apply(w.ctx, w.mailboxId, {
      fingerprint: profileFingerprint(d), signatureReplaces: signatureReceipt(HAD.signature, HAD.signatureHtml),
    }, { read: foundReader(d).read });

    const after = await w.db
      .select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
      .from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    expect(after[0]!.signature).toBe("-- \nMila Brunner");
    expect(after[0]!.signatureHtml, "stale markup survived an import whose signature is plain")
      .toBeNull();
    const local = await serializeOrganizerProfile(w.db as unknown as Tx, w.accountId, w.mailboxId);
    expect(profileFingerprint(local)).toBe(profileFingerprint(d));
  });

  it("merges by natural key: retargets the existing rule IN PLACE, overwrites the contact's name, and leaves local-only keys untouched", async () => {
    const w = await world();
    // Local state that overlaps the document on two natural keys and owns two keys of its own.
    const [localRule] = await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "anna@example.com",
      destination: "INBOX", priority: 5, enabled: false, provenance: "manual",
    }).returning();
    const [ownRule] = await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "local-only@example.com",
      destination: "ohmail/Quarantine", priority: 0, enabled: true, provenance: "manual",
    }).returning();
    await w.db.insert(contacts).values({ accountId: w.accountId, address: "anna@example.com", name: "Old Name" });
    await w.db.insert(contacts).values({ accountId: w.accountId, address: "keep-me@example.com", name: "Kept" });
    await w.db.insert(tags).values({ accountId: w.accountId, name: "invoices", hue: "sky" });

    const d = doc();
    await profileImportService.apply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );

    // The overlapping rule was RETARGETED in place — same row id, the document's value — never
    // duplicated into a second rule whose winner would be a priority/id coin toss.
    const annaRules = await w.db.select().from(rules).where(and(
      eq(rules.accountId, w.accountId), eq(rules.match, "anna@example.com"),
    ));
    expect(annaRules).toHaveLength(1);
    expect(annaRules[0]!.id).toBe(localRule!.id);
    expect(annaRules[0]!).toMatchObject({
      destination: "ohmail/News", priority: 0, enabled: true, provenance: "promoted",
    });
    // …and the retarget did NOT request the retroactive pass: an import restores configuration,
    // it does not re-file a mailbox the previous organizer already organized.
    expect(annaRules[0]!.retroRequestedAt).toBeNull();

    // The local-only rule is untouched, byte for byte.
    const [own] = await w.db.select().from(rules).where(eq(rules.id, ownRule!.id));
    expect(own).toMatchObject({ destination: "ohmail/Quarantine", enabled: true });

    // The document's entry is the whole truth for its address — name overwritten…
    const [anna] = await w.db.select().from(contacts).where(and(
      eq(contacts.accountId, w.accountId), eq(contacts.address, "anna@example.com"),
    ));
    expect(anna!.name).toBe("Anna");
    // …and an address the document does not name keeps its row.
    const [kept] = await w.db.select().from(contacts).where(and(
      eq(contacts.accountId, w.accountId), eq(contacts.address, "keep-me@example.com"),
    ));
    expect(kept!.name).toBe("Kept");

    // The tag store's own uniqueness is case-insensitive, so "Invoices" matches the local
    // "invoices" — kept as the user spelled it — and only "Travel" is new.
    const tagRows = await w.db.select().from(tags).where(eq(tags.accountId, w.accountId));
    expect(tagRows.map((t) => t.name).sort()).toEqual(["Travel", "invoices"]);
  });

  it("a surplus local duplicate of a key the document names is removed — one key, one answer", async () => {
    const w = await world();
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "anna@example.com",
      destination: "INBOX", priority: 0, enabled: true, provenance: "manual",
    });
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "anna@example.com",
      destination: "ohmail/Screened", priority: 3, enabled: true, provenance: "manual",
    });
    const d = doc();
    await profileImportService.apply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    const annaRules = await w.db.select().from(rules).where(and(
      eq(rules.accountId, w.accountId), eq(rules.match, "anna@example.com"),
    ));
    expect(annaRules).toHaveLength(1);
    expect(annaRules[0]!.destination).toBe("ohmail/News");
  });

  it("is idempotent: a second apply writes nothing — no row churn, no change rows, no second resolution", async () => {
    const w = await world();
    const d = doc();
    const args = [{ fingerprint: profileFingerprint(d) }, { read: foundReader(d).read }] as const;
    await profileImportService.apply(w.ctx, w.mailboxId, ...args);

    const rulesBefore = await w.db.select().from(rules).where(eq(rules.accountId, w.accountId));
    const changesBefore = await changeRows(w.db, w.accountId);

    const second = await inlineApply(w.ctx, w.mailboxId, ...args);
    expect(second.seq, "a no-op re-apply emits no change rows").toBeNull();

    const rulesAfter = await w.db.select().from(rules).where(eq(rules.accountId, w.accountId));
    expect(rulesAfter.map((r) => r.id).sort()).toEqual(rulesBefore.map((r) => r.id).sort());
    expect((await changeRows(w.db, w.accountId)).length).toBe(changesBefore.length);
    expect(await resolutionRows(w.db, w.accountId)).toHaveLength(1);
  });

  it("emits change rows for what the mirrors watch: rule creates/updates and tag creates", async () => {
    const w = await world();
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "anna@example.com",
      destination: "INBOX", priority: 0, enabled: true, provenance: "manual",
    });
    const d = doc();
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    const changes = await changeRows(w.db, w.accountId);
    const byType = new Map<string, number>();
    for (const c of changes) byType.set(`${c.entityType}:${c.op}`, (byType.get(`${c.entityType}:${c.op}`) ?? 0) + 1);
    expect(byType.get("rule:update")).toBe(1);  // the retargeted anna rule
    expect(byType.get("rule:create")).toBe(2);  // the other two document rules
    expect(byType.get("tag:create")).toBe(2);   // Invoices, Travel
    expect(result.seq).toBe(Number(changes[changes.length - 1]!.seq));
  });

  it("refuses a document that changed since the user looked — 409, nothing applied", async () => {
    const w = await world();
    const shown = doc();
    const changed = doc({ ...PAYLOAD, tagNames: ["Something-Else"] });
    await expect(profileImportService.apply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(shown) }, { read: foundReader(changed).read },
    )).rejects.toMatchObject({ code: "profile_changed", httpStatus: 409 });
    expect(await w.db.select().from(rules).where(eq(rules.accountId, w.accountId))).toHaveLength(0);
    expect(await resolutionRows(w.db, w.accountId)).toHaveLength(0);
  });

  it("never partially imports a newer-format document", async () => {
    const w = await world();
    const read = async (): Promise<ProfileReadResult> => ({ state: "newer", v: 2 });
    await expect(profileImportService.apply(
      w.ctx, w.mailboxId, { fingerprint: "whatever-was-shown" }, { read },
    )).rejects.toMatchObject({ code: "profile_newer", httpStatus: 409 });
    expect(await w.db.select().from(rules).where(eq(rules.accountId, w.accountId))).toHaveLength(0);
  });

  it("skips (and counts) a rule the product's own create would refuse, and applies the rest", async () => {
    const w = await world();
    const payload: OrganizerProfilePayload = {
      ...PAYLOAD,
      rules: [
        ...PAYLOAD.rules,
        // A destination this build does not organize: the format is public, anything may have
        // written it, and a rule the engine cannot act on must not enter the store.
        {
          kind: "sender", match: "junk@example.com", destination: "Not/A/Folder",
          priority: 0, enabled: true, provenance: "manual",
        },
        // A blank subject term matches EVERY subject while reading as specific — the exact
        // silent widening the rules service refuses with a 400; here it invalidates its rule.
        {
          kind: "sender", match: "blank@example.com", destination: "ohmail/News",
          priority: 0, enabled: true, provenance: "manual", subjectContains: "   ",
        },
      ],
    };
    const d = doc(payload);
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.skippedRules).toBe(2);
    const stored = await w.db.select().from(rules).where(eq(rules.accountId, w.accountId));
    expect(stored).toHaveLength(3);
    expect(stored.some((r) => r.match === "junk@example.com" || r.match === "blank@example.com")).toBe(false);
  });

  it("touches nothing in another account that shares the same natural keys", async () => {
    const w = await world();
    // The bystander lives in the SAME database — a second world would prove nothing.
    const bystanderId = randomUUID();
    await w.db.insert(accounts).values({ id: bystanderId, name: "bystander" });
    const [theirRule] = await w.db.insert(rules).values({
      accountId: bystanderId, kind: "sender", match: "anna@example.com",
      destination: "INBOX", priority: 0, enabled: true, provenance: "manual",
    }).returning();
    await w.db.insert(contacts).values({
      accountId: bystanderId, address: "anna@example.com", name: "Their Anna",
    });

    const d = doc();
    await profileImportService.apply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );

    // The bystander's identically-keyed rows are untouched: the natural key is (account, key),
    // never the key alone — mutating the account scoping out of any apply write turns this red.
    const [theirs] = await w.db.select().from(rules).where(eq(rules.id, theirRule!.id));
    expect(theirs).toMatchObject({ destination: "INBOX", provenance: "manual" });
    const [theirAnna] = await w.db.select().from(contacts).where(and(
      eq(contacts.accountId, bystanderId), eq(contacts.address, "anna@example.com"),
    ));
    expect(theirAnna!.name).toBe("Their Anna");
    // …and the import wrote its own account's rows beside them — INCLUDING the rule whose
    // natural key the bystander shares. This half is what catches an unscoped local read: a
    // pairing polluted by the bystander's row consumes the document's rule against a row the
    // account-scoped update can never match, and OUR store silently ends up without it.
    const [ours] = await w.db.select().from(contacts).where(and(
      eq(contacts.accountId, w.accountId), eq(contacts.address, "anna@example.com"),
    ));
    expect(ours!.name).toBe("Anna");
    const ourAnnaRules = await w.db.select().from(rules).where(and(
      eq(rules.accountId, w.accountId), eq(rules.match, "anna@example.com"),
    ));
    expect(ourAnnaRules).toHaveLength(1);
    expect(ourAnnaRules[0]!.destination).toBe("ohmail/News");
  });

  it("requires the fingerprint — an apply with none is a 400, and nothing dials", async () => {
    const w = await world();
    await expect(profileImportService.apply(w.ctx, w.mailboxId, {}, { read: neverReader() }))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
  });
});

/**
 * AN IMPORT NEVER LOSES A SIGNATURE TYPED ON THIS MAILBOX (ruled 2026-11-01): the card says Import
 * adds. A copy's different signature replaces the one here only when the press names it — the
 * receipt the offer carries, which the card says as "replacing the one on this mailbox now"; else
 * the typed one stays and the result says so. A mailbox with no signature takes the copy's.
 */
describe("an import never loses a signature typed on this mailbox", () => {
  const TYPED = "-- \njust typed";
  const SIG = "-- \nMila Brunner";
  const signed = (): OrganizerProfileDoc => doc({ ...PAYLOAD, signature: SIG });
  const press = (w: World, signatureReplaces?: string) => inlineApply(
    w.ctx, w.mailboxId, { fingerprint: profileFingerprint(signed()), signatureReplaces }, { read: foundReader(signed()).read },
  );
  const signatureOf = async (w: World) => (await w.db.select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
    .from(mailboxes).where(eq(mailboxes.id, w.mailboxId)))[0]!;
  const replacesOf = async (w: World) => {
    const offer = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(offer).toMatchObject({ state: "found", counts: { signature: true } });
    return offer.state === "found" ? offer.counts.signatureReplaces : undefined;
  };
  async function typedWorld(typed: string | null = TYPED): Promise<World> {
    const w = await world();
    await w.db.insert(accountSettings).values({ accountId: w.accountId, updatedAt: new Date("2026-08-01T00:00:00Z") });
    if (typed !== null) await w.db.update(mailboxes).set({ signature: typed }).where(eq(mailboxes.id, w.mailboxId));
    await seedHeldMarker(w, signed(), 1, signatureReceipt(SIG)!);
    return w;
  }
  const stampOf = async (w: World) => (await w.db.select({ at: accountSettings.updatedAt }).from(accountSettings)
    .where(eq(accountSettings.accountId, w.accountId)))[0]!.at.getTime();
  const settingsRows = async (w: World) => (await changeRows(w.db, w.accountId)).filter((r) => r.entityType === "settings").length;

  it("the offer names the different signature it replaces; a press that does not name it keeps it and says so", async () => {
    const w = await typedWorld();
    const replaces = await replacesOf(w);
    const result = await press(w);
    expect(await signatureOf(w), "an import replaced the signature typed here unasked").toEqual({ signature: TYPED, signatureHtml: null });
    expect(result.imported).toMatchObject({ signature: false, signatureKept: true });
    expect(await stampOf(w), "an import that changed no signature moved the consent stamp").toBe(Date.parse("2026-08-01T00:00:00Z"));
    expect(await settingsRows(w), "an import that changed no signature appended a settings row").toBe(0);
    expect(replaces, "the offer does not name the signature it would replace").toBe(signatureReceipt(TYPED));
  });

  it("a press that names it replaces it, moves the stamp, and the result says the signature arrived", async () => {
    const w = await typedWorld();
    const result = await press(w, await replacesOf(w));
    expect(result.imported.signature).toBe(true);
    expect(result.imported.signatureKept).toBeUndefined();
    expect(await signatureOf(w)).toEqual({ signature: SIG, signatureHtml: null });
    expect(await stampOf(w)).toBe(NOW.getTime());
    expect(await settingsRows(w)).toBe(1);
  });

  it("a receipt drawn before the signature changed replaces nothing: the one typed since stays", async () => {
    const w = await typedWorld();
    const receipt = await replacesOf(w);
    await w.db.update(mailboxes).set({ signature: "-- \ntyped after the card" }).where(eq(mailboxes.id, w.mailboxId));
    expect((await press(w, receipt)).imported).toMatchObject({ signature: false, signatureKept: true });
    expect((await signatureOf(w)).signature).toBe("-- \ntyped after the card");
  });

  it("CONTROL: a mailbox with no signature takes the copy's, and the offer names nothing it replaces", async () => {
    const w = await typedWorld(null);
    expect(await replacesOf(w)).toBeUndefined();
    expect((await press(w)).imported.signature).toBe(true);
    expect(await signatureOf(w)).toEqual({ signature: SIG, signatureHtml: null });
    expect(await stampOf(w)).toBe(NOW.getTime());
  });

  it("the copy's signature already here: the offer names no replacement and nothing moves", async () => {
    const w = await typedWorld(SIG);
    expect(await replacesOf(w)).toBeUndefined();
    expect((await press(w)).imported.signature).toBe(true);
    expect(await stampOf(w)).toBe(Date.parse("2026-08-01T00:00:00Z"));
    expect(await settingsRows(w)).toBe(0);
  });
});

describe("the merge folds case where the engine folds case", () => {
  it("retargets a local rule whose match differs only in case — never a second rule for one sender", async () => {
    const w = await world();
    // The routing engine case-folds sender matching, so these two rows are ONE rule to it —
    // and an import that keyed them apart would insert a duplicate whose winner is the
    // priority/id coin toss the merge rule exists to remove.
    const [localRule] = await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "Anna@Example.com",
      destination: "INBOX", priority: 5, enabled: false, provenance: "manual",
    }).returning();
    const d = doc();
    await profileImportService.apply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    const annaRules = (await w.db.select().from(rules).where(eq(rules.accountId, w.accountId)))
      .filter((r) => r.match.toLowerCase() === "anna@example.com");
    expect(annaRules).toHaveLength(1);
    expect(annaRules[0]!.id).toBe(localRule!.id);
    expect(annaRules[0]!.destination).toBe("ohmail/News");
  });
});

/**
 * ═══ THE AWAY SCOPE TRAVELS, AND AN OLD DOCUMENT DOES NOT OVERWRITE IT ════════════════════
 *
 * `away_responders.piles` (mail 0096) is which piles the responder answers, and it defaults to the
 * Ohbox alone. The published profile had no field for it, so an install adopting this mailbox
 * applied the away section WITHOUT the scope: on a fresh row the column default won, and on an
 * existing row the organizer's choice never arrived. Either way the person's choice did not
 * travel between their own computers — which is what the release note claims it does.
 *
 * The compatibility rule is the half that needs stating. A document written by an ohmail that had
 * no such field is not saying "answer the Ohbox"; it is saying nothing about scope. So an ABSENT
 * field leaves what is stored alone, and only a PRESENT one writes. Defaulting it here would turn
 * every adoption from an older install into a silent narrowing — the same widening-versus-
 * narrowing argument the field itself was added under, one seam along.
 */
describe("the away responder's pile scope travels in the published profile", () => {
  it("applies the piles the document carries", async () => {
    const w = await world();
    const d = doc({
      ...PAYLOAD,
      awayResponder: {
        enabled: true, body: "Back Monday.", throttle: "per_day",
        startsAt: null, endsAt: null, audience: "everyone",
        piles: ["INBOX", "ohmail/News"],
      },
    });
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.imported.awayResponder).toBe(true);
    const [row] = await w.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, w.accountId));
    expect([...(row!.piles as string[])].sort())
      .toEqual(["INBOX", "ohmail/News"]);
  });

  it("leaves a stored scope UNTOUCHED when the document has no such field", async () => {
    /* THE 0.16.1 DOCUMENT. The compatibility arm, and the one that must never become a default
       overwrite: this install already answers Reads, and a document that says nothing about scope
       is not an instruction to stop. */
    const w = await world();
    await w.db.insert(awayResponders).values({
      accountId: w.accountId, enabled: false, body: "Old text",
      audience: "screened_in", throttle: "per_day", piles: ["ohmail/News"],
    });
    const d = doc({
      ...PAYLOAD,
      awayResponder: {
        enabled: true, body: "Back Monday.", throttle: "per_day",
        startsAt: null, endsAt: null, audience: "screened_in",
      },
    });
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.imported.awayResponder).toBe(true);
    const [row] = await w.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, w.accountId));
    // The rest of the section applied; the scope did not move.
    expect(row!.body).toBe("Back Monday.");
    expect(row!.piles as string[]).toEqual(["ohmail/News"]);
  });

  it("narrows a kept scope to fit an audience the document changes", async () => {
    /**
     * THE ROW THE PANE CANNOT TURN OFF. The Screener pile may only be answered with the wider
     * audience — `awayScopeFitsAudience`, which the PUT enforces UNGATED BY `enabled`. An existing
     * row answering `everyone` including the Screener, adopting a document that says `screened_in`
     * and nothing about scope, kept the Screener beside the narrower audience. The endpoint then
     * refused every save of that row, INCLUDING the save that turns the responder off, so a
     * responder the user was trying to stop kept answering.
     *
     * The importer narrows the SCOPE to fit, which is the direction this file already takes for the
     * audience and the throttle. The endpoint refuses rather than filters on purpose — a request is
     * a person asking for something — but a document is not a request, and leaving the row in a
     * state no save can repair is worse than dropping a pile the new audience cannot reach.
     */
    const w = await world();
    await w.db.insert(awayResponders).values({
      accountId: w.accountId, enabled: true, body: "Away",
      audience: "everyone", throttle: "per_day", piles: ["INBOX", "ohmail/Screener"],
    });
    const old = { ...PAYLOAD, awayResponder: { ...PAYLOAD.awayResponder!, audience: "screened_in" } };
    delete (old.awayResponder as Record<string, unknown>).piles;
    const d = doc(old);
    await profileImportService.apply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    const [row] = await w.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, w.accountId));
    expect(row!.audience).toBe("screened_in");
    expect(awayScopeFitsAudience(row!.piles as AwayPile[], "screened_in"),
      "the stored row is one the endpoint would refuse every save of").toBe(true);
    expect(row!.piles as string[]).toEqual(["INBOX"]);
  });

  it("a document written BEFORE the field does not converge, and that outcome is already covered", async () => {
    /**
     * THE COMPATIBILITY COST, STATED. Leaving a stored scope alone means `local ⊃ document`, so
     * the fingerprints never meet — not a new state: `apps/worker/src/profile.ts` treats it as the
     * MERGED import and releases the hold on the `imported` row (`profileImportWriteReleased`),
     * moving the held fingerprint to `seenForeignFingerprints` so the next write supersedes the
     * document. Asserted so the difference is a measured property of this design rather than a
     * convergence case somebody later reads as broken.
     */
    const w = await world();
    const old = { ...PAYLOAD, awayResponder: { ...PAYLOAD.awayResponder! } };
    delete (old.awayResponder as Record<string, unknown>).piles;
    const d = doc(old);
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.imported.awayResponder).toBe(true);

    const local = await serializeOrganizerProfile(w.db as unknown as Tx, w.accountId, w.mailboxId);
    expect(profileFingerprint(local), "an old document converged — the scope was written from it")
      .not.toBe(profileFingerprint(d));
    // AND THE RESOLUTION IS BESIDE IT, which is what releases the hold.
    const res = await resolutionRows(w.db, w.accountId);
    expect(res).toHaveLength(1);
    expect(res[0]!.payload).toMatchObject({ decision: "imported", fingerprint: profileFingerprint(d) });
  });

  it("narrows a member it does not recognise, the way the audience and throttle are narrowed", async () => {
    /* A document from a NEWER ohmail naming a pile this build cannot act on. Keeping it would put
       a value in the column its own CHECK refuses; the safe reading is the members we do know. */
    const w = await world();
    const d = doc({
      ...PAYLOAD,
      awayResponder: {
        enabled: true, body: "Back Monday.", throttle: "per_day",
        startsAt: null, endsAt: null, audience: "everyone",
        piles: ["INBOX", "ohmail/Nonesuch", "ohmail/Receipts"],
      },
    });
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.imported.awayResponder).toBe(true);
    const [row] = await w.db.select().from(awayResponders)
      .where(eq(awayResponders.accountId, w.accountId));
    expect([...(row!.piles as string[])].sort()).toEqual(["INBOX", "ohmail/Receipts"]);
  });
});

describe("hostile or malformed document content degrades to skips, never to a 500 or a widened state", () => {
  it("an away section with an unparseable date is SKIPPED — never an unbounded responder", async () => {
    const w = await world();
    const d = doc({
      ...PAYLOAD,
      awayResponder: {
        enabled: true, body: "Back Monday.", throttle: "per_day",
        startsAt: "not-a-date", endsAt: null, audience: "screened_in",
      },
    });
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    // The away service refuses invalid dates on its own PUT; the import must not become the
    // one door through which "enabled, no bounds" enters — a reply to a stranger cannot be
    // recalled. The section is skipped whole, and the answer says so.
    expect(result.imported.awayResponder).toBe(false);
    expect(await w.db.select().from(awayResponders).where(eq(awayResponders.accountId, w.accountId)))
      .toHaveLength(0);
  });

  it("a reversed away range is skipped on the same argument", async () => {
    const w = await world();
    const d = doc({
      ...PAYLOAD,
      awayResponder: {
        enabled: true, body: "Back Monday.", throttle: "per_day",
        startsAt: "2026-08-20T00:00:00.000Z", endsAt: "2026-08-01T00:00:00.000Z", audience: "screened_in",
      },
    });
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.imported.awayResponder).toBe(false);
    expect(await w.db.select().from(awayResponders).where(eq(awayResponders.accountId, w.accountId)))
      .toHaveLength(0);
  });

  it("tag names take the tag store's own hygiene: trimmed, bounded, no control bytes", async () => {
    const w = await world();
    const d = doc({
      ...PAYLOAD,
      tagNames: ["  Padded  ", "x".repeat(41), "ok", "nul\u0000name"],
    });
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    const names = (await w.db.select().from(tags).where(eq(tags.accountId, w.accountId)))
      .map((t) => t.name).sort();
    expect(names).toEqual(["Padded", "ok"].sort());
    expect(result.imported.tags).toBe(2); // the two invalid names are neither stored nor counted
  });

  it("a rule whose priority overflows the store's integer is skipped, not a 500", async () => {
    const w = await world();
    const d = doc({
      ...PAYLOAD,
      rules: [...PAYLOAD.rules, {
        kind: "sender", match: "overflow@example.com", destination: "ohmail/News",
        priority: 2_147_483_648, enabled: true, provenance: "manual",
      }],
    });
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.skippedRules).toBe(1);
    expect((await w.db.select().from(rules).where(eq(rules.accountId, w.accountId)))
      .some((r) => r.match === "overflow@example.com")).toBe(false);
  });

  it("a rule past the one priority bound is skipped, and one at the bound arrives", async () => {
    const w = await world();
    const d = doc({
      ...PAYLOAD,
      rules: [...PAYLOAD.rules,
        { kind: "sender", match: "at-bound@example.com", destination: "ohmail/News", priority: 1000, enabled: true, provenance: "manual" },
        { kind: "sender", match: "past-bound@example.com", destination: "ohmail/News", priority: 1001, enabled: true, provenance: "manual" },
      ],
    });
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.skippedRules).toBe(1);
    const stored = await w.db.select().from(rules).where(eq(rules.accountId, w.accountId));
    expect(stored.find((r) => r.match === "at-bound@example.com")?.priority).toBe(1000);
    expect(stored.some((r) => r.match === "past-bound@example.com")).toBe(false);
  });

  it("a rule carrying a control byte in its match is skipped — the store cannot hold it and a 500 is not an answer", async () => {
    const w = await world();
    const d = doc({
      ...PAYLOAD,
      rules: [...PAYLOAD.rules, {
        kind: "sender", match: "nul\u0000@example.com", destination: "ohmail/News",
        priority: 0, enabled: true, provenance: "manual",
      }],
    });
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.skippedRules).toBe(1);
  });

  it("imported counts say what ARRIVED, not what the document claimed", async () => {
    const w = await world();
    const d = doc({
      ...PAYLOAD,
      rules: [...PAYLOAD.rules, {
        kind: "sender", match: "junk@example.com", destination: "Not/A/Folder",
        priority: 0, enabled: true, provenance: "manual",
      }],
    });
    const result = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(result.imported.rules).toBe(3);   // the three valid ones — never the claimed four
    expect(result.skippedRules).toBe(1);
  });

  it("a `newer` marker with a version beyond the store's integer still declines cleanly", async () => {
    const w = await world();
    await seedNewerMarker(w, 2_147_483_648);
    await profileImportService.decline(w.ctx, w.mailboxId, { v: 2_147_483_648 });
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toEqual({ state: "none" });
  });
});

describe("decline — durable, inert, content-keyed", () => {
  it("dismisses durably: nothing applied, and the candidate answers `declined` from the marker without a dial", async () => {
    const w = await world();
    const d = doc();
    const fingerprint = await seedHeldMarker(w, d);
    await profileImportService.decline(w.ctx, w.mailboxId, { fingerprint });
    expect(await w.db.select().from(rules).where(eq(rules.accountId, w.accountId))).toHaveLength(0);
    expect(await w.db.select().from(contacts).where(eq(contacts.accountId, w.accountId))).toHaveLength(0);
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    // The card never offers it again; Settings shows it, with Import and Replace.
    expect(dto).toEqual({
      state: "declined",
      fingerprint,
      updatedAt: "2026-08-10T09:00:00.000Z",
      producer: { kind: "local", version: "0.9.3" },
      counts: { screener: 2, rules: 3, notifyRules: 1, tags: 2, awayResponder: true, signature: false },
    });
  });

  it("a declined marker written without its counts offers nothing rather than a row with holes", async () => {
    const w = await world();
    const fingerprint = profileFingerprint(doc());
    await w.db.insert(auditLog).values({
      accountId: w.accountId, action: PROFILE_FOUND_AUDIT_ACTION,
      payload: { mailboxId: w.mailboxId, state: "found", fingerprint, heldForImport: true },
      inverse: null,
    });
    await profileImportService.decline(w.ctx, w.mailboxId, { fingerprint });
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toEqual({ state: "none" });
  });

  it("a DIFFERENT document may ask again — the dismissal is keyed to content, not to the mailbox", async () => {
    const w = await world();
    const declined = doc();
    await seedHeldMarker(w, declined);
    await profileImportService.decline(w.ctx, w.mailboxId, { fingerprint: profileFingerprint(declined) });
    // A new document travels in later; the organizer surfaces it under its own fingerprint.
    const fresh = doc({ ...PAYLOAD, tagNames: ["New-Config"] });
    await seedHeldMarker(w, fresh);
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toMatchObject({ state: "found", fingerprint: profileFingerprint(fresh) });
  });

  it("a retried decline writes one row, not two", async () => {
    const w = await world();
    const fingerprint = profileFingerprint(doc());
    await profileImportService.decline(w.ctx, w.mailboxId, { fingerprint });
    await profileImportService.decline(w.ctx, w.mailboxId, { fingerprint });
    expect(await resolutionRows(w.db, w.accountId)).toHaveLength(1);
  });

  it("names its subject or is refused: neither fingerprint nor version is a 400", async () => {
    const w = await world();
    await expect(profileImportService.decline(w.ctx, w.mailboxId, {}))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
  });

  it("a version this build CAN read is not a newer-notice subject — it is dismissed by content", async () => {
    /**
     * The version-keyed dismissal exists for a document this build cannot represent: there is no
     * payload to fingerprint, so the answer is keyed to the number. A READABLE document has a
     * payload, and keying its dismissal to the version instead would answer for every document of
     * that version at once — including ones the person has never seen. The test was `v > 1`, which
     * meant "newer" only while this build wrote v1.
     */
    const w = await world();
    for (const v of [1, PROFILE_VERSION]) {
      await expect(
        profileImportService.decline(w.ctx, w.mailboxId, { v }),
        `v${v} is readable and must not be dismissible by its version alone`,
      ).rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    }
    // …while one above it still is, which is what the version-keyed arm is for.
    await profileImportService.decline(w.ctx, w.mailboxId, { v: PROFILE_VERSION + 1 });
    expect(await resolutionRows(w.db, w.accountId)).toHaveLength(1);
  });
});

describe("replace — the explicit write release, after a decline or instead of one", () => {
  it("records `replaced` and applies nothing: declined then replaced is two rows, and the question rests", async () => {
    const w = await world();
    const fingerprint = await seedHeldMarker(w, doc());
    await profileImportService.decline(w.ctx, w.mailboxId, { fingerprint });
    await profileImportService.replace(w.ctx, w.mailboxId, { fingerprint });
    const rows = await resolutionRows(w.db, w.accountId);
    expect(rows.map((r) => (r.payload as { decision: string }).decision).sort()).toEqual(["declined", "replaced"]);
    expect(await w.db.select().from(rules).where(eq(rules.accountId, w.accountId))).toHaveLength(0);
    expect(await w.db.select().from(tags).where(eq(tags.accountId, w.accountId))).toHaveLength(0);
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toEqual({ state: "none" });
  });

  it("a retried replace writes one row, not two", async () => {
    const w = await world();
    const fingerprint = profileFingerprint(doc());
    await profileImportService.replace(w.ctx, w.mailboxId, { fingerprint });
    await profileImportService.replace(w.ctx, w.mailboxId, { fingerprint });
    expect(await resolutionRows(w.db, w.accountId)).toHaveLength(1);
  });

  it("names the document or is refused, and a newer version is not a subject", async () => {
    const w = await world();
    await expect(profileImportService.replace(w.ctx, w.mailboxId, {}))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    await expect(profileImportService.replace(w.ctx, w.mailboxId, { v: PROFILE_VERSION + 1 } as never))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    expect(await resolutionRows(w.db, w.accountId)).toHaveLength(0);
  });

  it("a DEMOTED reader keeps its organizer-era marker and is offered nothing: none, and 409 on replace and apply", async () => {
    // ARCH-R109 (3): nothing at stand-down clears the found-marker, so without the role gate a
    // reader would render "Save this ohmail's settings" — a write press on an install that never writes.
    const w = await world();
    const d = doc();
    const fingerprint = await seedHeldMarker(w, d);
    await profileImportService.decline(w.ctx, w.mailboxId, { fingerprint });
    // The organizer control: the same marker and answer read `declined` while this install organizes.
    expect(await profileImportService.candidate(w.ctx, w.mailboxId))
      .toMatchObject({ state: "declined", fingerprint });

    await w.db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, w.mailboxId));
    expect(await profileImportService.candidate(w.ctx, w.mailboxId))
      .toEqual({ state: "none" });
    await expect(profileImportService.replace(w.ctx, w.mailboxId, { fingerprint }))
      .rejects.toMatchObject({ code: "organized_elsewhere", httpStatus: 409 });
    await expect(profileImportService.apply(w.ctx, w.mailboxId, { fingerprint }, { read: foundReader(d).read }))
      .rejects.toMatchObject({ code: "organized_elsewhere", httpStatus: 409 });
    const decisions = (await resolutionRows(w.db, w.accountId)).map((r) => (r.payload as { decision: string }).decision);
    expect(decisions, "a refused replace writes no row").toEqual(["declined"]);
  });

  it("a mailbox this account does not own is 404, before anything is written", async () => {
    const w = await world();
    await expect(profileImportService.replace(w.ctx, randomUUID(), { fingerprint: "a".repeat(64) }))
      .rejects.toMatchObject({ httpStatus: 404 });
    expect(await w.db.select().from(auditLog)
      .where(eq(auditLog.action, PROFILE_IMPORT_RESOLVED_AUDIT_ACTION))).toHaveLength(0);
  });

  it("an erased mailbox takes no answer: a stale card's Not now and Save these are 410 and write nothing", async () => {
    // The erasure takes the fingerprint off every row; an answer written after it would put it back.
    const w = await world();
    const fingerprint = await seedHeldMarker(w, doc());
    const [row] = await w.db.select({ address: mailboxes.address }).from(mailboxes).where(eq(mailboxes.id, w.mailboxId));
    await mailboxService.delete(w.ctx, w.mailboxId, { erase: { confirmAddress: row!.address } });
    const run = await eraseOwedMailbox(w.db as unknown as Tx, dialect(w.db), {
      accountId: w.accountId, mailboxId: w.mailboxId, now: () => NOW, maxSteps: 10,
    });
    expect(run.done).toBe(true);
    await expect(profileImportService.decline(w.ctx, w.mailboxId, { fingerprint }))
      .rejects.toMatchObject({ code: "mailbox_erased", httpStatus: 410 });
    await expect(profileImportService.replace(w.ctx, w.mailboxId, { fingerprint }))
      .rejects.toMatchObject({ code: "mailbox_erased", httpStatus: 410 });
    expect(await resolutionRows(w.db, w.accountId), "an answer was written for an erased mailbox").toHaveLength(0);
  });
});

/**
 * the travelling document's list lengths.
 *
 * The counts here come from a JSON document in the `ohmail/_meta` folder of an IMAP server the
 * user chose and we do not run. `apply` walks each list one entry at a time inside ONE
 * transaction, holding an account-scoped advisory lock and appending a change-log row per rule —
 * so the transaction's size, the lock's lifetime and the change volume were all decided by the
 * mail server, and the fingerprint the user confirms proves only that they saw the same content.
 *
 * TWO entry points, and the second is what makes the refusal honest: a ceiling only `apply` knew
 * about would OFFER the import on the confirm screen and then refuse the press.
 *
 * Watched fail and restored: delete the `refuseOversizedProfile(doc)` call in `apply` and the
 * first case applies tens of thousands of contacts in one transaction; delete the `oversizedCounts` check in
 * `candidate` and the second answers `found` with a button that 413s.
 */
describe("a document too large to apply in one transaction is refused, and never offered", () => {
  const oversized = (): OrganizerProfilePayload => ({
    ...PAYLOAD,
    screener: Array.from({ length: PROFILE_IMPORT_MAX.screener + 1 }, (_, i) => ({
      address: `p${i}@example.com`,
    })),
  });

  it("apply refuses with a 413 that names the list and both numbers, and writes nothing", async () => {
    const w = await world();
    const d = doc(oversized());
    await seedHeldMarker(w, d);

    const err = await profileImportService
      .apply(w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).httpStatus).toBe(413);
    expect((err as ServiceError).code).toBe("payload_too_large");
    expect((err as ServiceError).message).toContain("screener");
    expect((err as ServiceError).message).toContain(String(PROFILE_IMPORT_MAX.screener));
    // Refused BEFORE the transaction, so nothing was written and no advisory lock was taken.
    const contactRows = await w.db.select().from(contacts).where(eq(contacts.accountId, w.accountId));
    expect(contactRows).toHaveLength(0);
  });

  it("candidate answers `too_large` rather than offering an import that would be refused", async () => {
    const w = await world();
    const d = doc(oversized());
    await seedHeldMarker(w, d);

    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);

    expect(dto).toEqual({
      state: "too_large",
      // The fingerprint is load-bearing, not decoration: `decline` is content-keyed, so without
      // it a client could never record "keep local" for this document and every poll would
      // re-dial the mailbox for an answer nobody can give.
      fingerprint: profileFingerprint(d),
      list: "screener",
      count: PROFILE_IMPORT_MAX.screener + 1,
      max: PROFILE_IMPORT_MAX.screener,
    });
  });

  it("a document AT the ceiling is still offered and still applies", async () => {
    const w = await world();
    const d = doc({
      ...PAYLOAD,
      tagNames: Array.from({ length: PROFILE_IMPORT_MAX.tagNames }, (_, i) => `t${i}`),
    });
    await seedHeldMarker(w, d);

    // "at the ceiling passes" is the boundary; that an account PAST it still exports a document
    // this passes is `profile-export-closed.test.ts`, where the serializer publishes within it.
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect((dto as { state: string }).state).toBe("found");

    const applied = await inlineApply(
      w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read },
    );
    expect(applied.imported.tags).toBe(PROFILE_IMPORT_MAX.tagNames);
    // A document at every ceiling, offered and applied, no wait of its own: 1.1 s as a rule, 2.7 s once
    // on a loaded CI VM, 78 s under 10% of a CPU.
  }, 120_000);
});

/**
 * A `too_large` answer can be DISMISSED, which is the whole reason it carries a fingerprint: the
 * organizer's record names the oversized document, the card answers `too_large` from it, and after
 * a decline of that fingerprint the answer is the answered state, which the card never offers.
 *
 * Watched fail and restored: move the resolution lookup below the size answer in `candidate` and
 * the second poll answers `too_large` again.
 */
describe("declining an over-large document stops it being asked about", () => {
  it("answers the decline on the next poll, from the store alone", async () => {
    const w = await world();
    const big = doc({
      ...PAYLOAD,
      screener: Array.from({ length: PROFILE_IMPORT_MAX.screener + 1 }, (_, i) => ({
        address: `p${i}@example.com`,
      })),
    });
    await seedHeldMarker(w, big);

    const first = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect((first as { state: string }).state).toBe("too_large");
    const fingerprint = (first as { fingerprint: string }).fingerprint;
    expect(fingerprint).toBe(profileFingerprint(big));

    await profileImportService.decline(w.ctx, w.mailboxId, { fingerprint });

    expect(await profileImportService.candidate(w.ctx, w.mailboxId)).toMatchObject({ state: "declined", fingerprint });
  });
});

describe("the screen-outs an import writes reach the mail this organizer held at the gate for them", () => {
  /** One message from `from`, with its folder state — the shape the organizer's ingest leaves. */
  async function held(w: World, from: string, o: { desired?: string; setBy?: "us" | "peer" | "external" } = {}): Promise<string> {
    const at = o.desired ?? "ohmail/Screener";
    const [m] = await w.db.insert(messages).values({
      accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: `h-${randomUUID()}`,
      dedupKey: `import-held:${randomUUID()}`, subject: "held", fromAddress: from,
      nativeLocator: { folder: at, ref: `1:${Math.floor(Math.random() * 1e6)}` },
    }).returning();
    await w.db.insert(folderState).values({
      messageId: m!.id, desiredFolder: at, observedFolder: at,
      lastSetBy: o.setBy ?? "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  }
  const where = async (w: World, id: string) =>
    (await w.db.select().from(folderState).where(eq(folderState.messageId, id)))[0]!;

  it("files this organizer's gate filings where the screen-out says, and nothing a hand or another install placed", async () => {
    const w = await world();
    const screened: OrganizerProfilePayload = {
      ...PAYLOAD,
      rules: [
        { kind: "sender", match: "Spammer@Example.com", destination: "ohmail/Screened", priority: 0, enabled: true, provenance: "promoted" },
        { kind: "domain", match: "junk.example", destination: "ohmail/Quarantine", priority: 0, enabled: true, provenance: "promoted" },
        { kind: "sender", match: "narrow@example.com", destination: "ohmail/Screened", priority: 0, enabled: true, provenance: "manual", subjectContains: "[promo]" },
      ],
    };
    const ours = await held(w, "spammer@example.com");
    const hand = await held(w, "spammer@example.com", { setBy: "external" });
    const peer = await held(w, "spammer@example.com", { setBy: "peer" });
    const inbox = await held(w, "spammer@example.com", { desired: "INBOX" });
    const byDomain = await held(w, "bulk@junk.example");
    const narrow = await held(w, "narrow@example.com");

    const d = doc(screened);
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read });

    expect((await where(w, ours)).desiredFolder, "this organizer's gate filing stayed at the gate").toBe("ohmail/Screened");
    expect((await where(w, ours)).reconcileStatus).toBe("pending");
    expect((await where(w, byDomain)).desiredFolder, "a domain screen-out reaches its held bag").toBe("ohmail/Quarantine");
    for (const [id, why] of [[hand, "a hand placement"], [peer, "another install's placement"], [inbox, "mail off the gate"], [narrow, "a term-narrowed rule's sender"]] as const) {
      const fs = await where(w, id);
      expect(fs.desiredFolder, `${why} was re-filed`).toBe(id === inbox ? "INBOX" : "ohmail/Screener");
    }
    const moves = await w.db.select().from(changeLog)
      .where(and(eq(changeLog.accountId, w.accountId), eq(changeLog.entityType, "message"), eq(changeLog.op, "move")));
    expect(moves.map((c) => c.entityId).sort()).toEqual([ours, byDomain].sort());
  });

  it("an admitting rule leaves the gate alone — the held-release press is its door", async () => {
    const w = await world();
    const ours = await held(w, "anna@example.com");
    const d = doc();
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read });
    expect((await where(w, ours)).desiredFolder).toBe("ohmail/Screener");
  });
});

describe("a takeover import retires the dead rule rows of a former reader-only install", () => {
  /** A row this install kept while it only read the mailbox: no copy names it, and it is old. */
  const DEAD = { kind: "sender", match: "gone@example.com", destination: "INBOX", priority: 0, enabled: true, provenance: "manual" };
  const LONG_AGO = new Date("2026-08-01T00:00:00.000Z");
  async function dead(w: World, over: Partial<typeof rules.$inferInsert> = {}): Promise<string> {
    const [row] = await w.db.insert(rules).values({ accountId: w.accountId, ...DEAD, updatedAt: LONG_AGO, ...over }).returning();
    return row!.id;
  }
  const apply = (w: World, d: OrganizerProfileDoc) =>
    inlineApply(w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read: foundReader(d).read });
  const stillThere = async (w: World, id: string) => (await w.db.select().from(rules).where(eq(rules.id, id))).length === 1;
  async function otherMailbox(w: World, role: "organizer" | "reader", status?: string): Promise<string> {
    const [mb] = await w.db.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap", address: `${randomUUID().slice(0, 8)}@trafficflow.test`, organizerRole: role,
      ...(status === undefined ? {} : { status }),
    }).returning();
    return mb!.id;
  }
  const appliedPress = (w: World, mailboxId: string, decidedAt = NOW) => w.db.insert(organizerRequests).values({
    accountId: w.accountId, mailboxId, kind: "rule.update", state: "applied", decidedAt, resolvedAt: decidedAt,
    payload: { key: { kind: "sender", match: "Gone@example.com", subjectContains: null, bodyContains: null }, set: { destination: "inbox" } },
  }).returning();

  it("retires a row no copy names, one delete change each, says how many, and a second apply retires nothing", async () => {
    const w = await world();
    const id = await dead(w);
    const before = (await changeRows(w.db, w.accountId)).length;
    const out = await apply(w, doc());
    expect(out.retiredRules).toBe(1);
    expect(await stillThere(w, id)).toBe(false);
    const deletes = (await changeRows(w.db, w.accountId)).slice(before).filter((c) => c.entityType === "rule" && c.op === "delete");
    expect(deletes.map((c) => c.entityId)).toEqual([id]);
    expect((await resolutionRows(w.db, w.accountId))[0]!.payload).toMatchObject({ result: { retiredRules: 1 } });
    const again = await apply(w, doc());
    expect(again).toMatchObject({ retiredRules: 0, seq: null });
  });

  it("a document that skipped a rule retires nothing", async () => {
    const w = await world();
    const id = await dead(w);
    const d = doc({ ...PAYLOAD, rules: [...PAYLOAD.rules, { kind: "sender", match: "past@example.com", destination: "ohmail/News", priority: 1001, enabled: true, provenance: "manual" }] });
    expect((await apply(w, d)).retiredRules).toBe(0);
    expect(await stillThere(w, id)).toBe(true);
  });

  it("a document whose instant does not parse retires nothing", async () => {
    const w = await world();
    const id = await dead(w);
    expect((await apply(w, { ...doc(), updatedAt: "yesterday" })).retiredRules).toBe(0);
    expect(await stillThere(w, id)).toBe(true);
  });

  it("another mailbox organized here keeps the rows, live or removed (its own copy names them on its return)", async () => {
    const w = await world();
    const id = await dead(w);
    const kept = await otherMailbox(w, "organizer");
    expect((await apply(w, doc())).retiredRules).toBe(0);
    await w.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, kept));
    expect((await apply(w, doc({ ...PAYLOAD, tagNames: ["Other"] }))).retiredRules).toBe(0);
    expect(await stillThere(w, id)).toBe(true);
    await w.db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, kept));
    expect((await apply(w, doc({ ...PAYLOAD, tagNames: ["Third"] }))).retiredRules, "a removed READ mailbox reads no copy").toBe(1);
  });

  it("an Import after Not now on this document retires nothing: the rows organized here since", async () => {
    const w = await world();
    const id = await dead(w);
    const d = doc();
    const fingerprint = await seedHeldMarker(w, d);
    await profileImportService.decline(w.ctx, w.mailboxId, { fingerprint });
    expect((await apply(w, d)).retiredRules).toBe(0);
    expect(await stillThere(w, id)).toBe(true);
  });

  it("another read mailbox's copy naming the key keeps it, and so does a read mailbox with no copy", async () => {
    const w = await world();
    const id = await dead(w);
    const read = await otherMailbox(w, "reader");
    expect((await apply(w, doc())).retiredRules, "a read mailbox with no copy").toBe(0);
    await w.db.insert(mailboxProfileMirror).values({ mailboxId: read, accountId: w.accountId, readAt: NOW, doc: { rules: [{ ...DEAD, match: "GONE@example.com" }] } });
    expect((await apply(w, doc({ ...PAYLOAD, tagNames: ["Other"] }))).retiredRules, "a copy naming the key").toBe(0);
    expect(await stillThere(w, id)).toBe(true);
    await w.db.update(mailboxProfileMirror).set({ doc: { rules: [] } }).where(eq(mailboxProfileMirror.mailboxId, read));
    expect((await apply(w, doc({ ...PAYLOAD, tagNames: ["Third"] }))).retiredRules).toBe(1);
  });

  it("a row written, settled or pressed to create within the margin before the document stays", async () => {
    const w = await world();
    const at = new Date(Date.parse(doc().updatedAt) - 4 * 60_000);
    const written = await dead(w, { updatedAt: at });
    const create = (match: string, state: string, decidedAt: Date) => w.db.insert(organizerRequests).values({
      accountId: w.accountId, mailboxId: w.mailboxId, kind: "rule.create", state, decidedAt,
      payload: { key: { kind: "sender", match, subjectContains: null, bodyContains: null }, destination: "inbox" },
    }).returning();
    // A create pressed at `at` and applied here: the belt settles it on the row without writing it.
    const settled = await dead(w, { match: "settled@example.com" });
    const [press] = await create("Settled@example.com", "applied", at);
    expect(await (w.db as unknown as Tx).transaction((tx) => settleReaderRuleRows(tx as unknown as Tx, w.accountId, press!)))
      .toEqual({ settled: true, lastSeq: null });
    // A create pressed since the document, still on its way.
    const asked = await dead(w, { match: "asked@example.com" });
    await create("asked@example.com", "pending", NOW);
    const old = await dead(w, { match: "old@example.com", updatedAt: new Date(Date.parse(doc().updatedAt) - 6 * 60_000) });
    expect((await apply(w, doc())).retiredRules).toBe(1);
    expect(await Promise.all([written, settled, asked, old].map((id) => stillThere(w, id)))).toEqual([true, true, true, false]);
  });

  it("an applied press under the key keeps the row, unless it went to this mailbox and the copy names it", async () => {
    const w = await world();
    const id = await dead(w);
    const other = await otherMailbox(w, "reader");
    await w.db.insert(mailboxProfileMirror).values({ mailboxId: other, accountId: w.accountId, readAt: NOW, doc: { rules: [] } });
    const [toOther] = await appliedPress(w, other);
    expect((await apply(w, doc())).retiredRules, "a press to another mailbox").toBe(0);
    await w.db.update(organizerRequests).set({ decidedAt: new Date(NOW.getTime() - 25 * 3_600_000) }).where(eq(organizerRequests.id, toOther!.id));
    const [here] = await appliedPress(w, w.mailboxId);
    expect((await apply(w, doc({ ...PAYLOAD, tagNames: ["Other"] }))).retiredRules, "a press the copy does not name").toBe(0);
    expect(await stillThere(w, id)).toBe(true);
    const named = makeProfileDoc({ ...PAYLOAD, tagNames: ["Third"] }, {
      updatedAt: new Date("2026-08-10T09:00:00.000Z"), producer: { kind: "local", version: "0.9.3" }, applied: [here!.id],
    });
    expect((await apply(w, named)).retiredRules).toBe(1);
  });
});
