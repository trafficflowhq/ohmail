import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  PROFILE_FOUND_AUDIT_ACTION, PROFILE_IMPORT_ASK_TTL_MS, accounts, auditLog, importAskSignature, latestProfileFoundMarker, mailboxCredentials,
  mailboxes, rules, recordImportAsk, resolveImportAsk, stampMailboxErasure, type Tx,
} from "@trafficflow/db";
import {
  ProfileUnavailableError, makeProfileDoc, profileFingerprint, type ProfileReadResult,
} from "@trafficflow/core/adapters/organizer-profile";
import { profileImportService } from "../src/profile-import-service.js";
import { mailboxService } from "../src/mailbox-service.js";
import { ServiceError } from "../src/errors.js";
import type { Db, ServiceContext } from "../src/context.js";

/**
 * A PRESS WHOSE READ DOES NOT FIT THE REQUEST IS HANDED TO THE ORGANIZER. The reader here is the
 * seam the route builds: a door timeout arrives as `ProfileUnavailableError` coded
 * `mailbox_read_timeout` (`routes/mailboxes.ts#profileReader`), any other dial failure uncoded.
 * The ask lives on the mailbox row (mail 0129); the status read answers from it and never dials.
 */

const NOW = new Date("2026-09-26T20:00:00.000Z");

const DOC = makeProfileDoc({
  screener: [{ address: "anna@example.com", name: "Anna" }],
  rules: [{ kind: "sender", match: "anna@example.com", destination: "INBOX", priority: 0, enabled: true, provenance: "promoted" }],
  notifyRules: [], awayResponder: null, tagNames: ["Invoices"], signature: null,
}, { updatedAt: new Date("2026-09-20T09:00:00.000Z"), producer: { kind: "local", version: "0.25.1" } });
const FP = profileFingerprint(DOC);

async function world(at: Date = NOW) {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `handover-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${accountId.slice(0, 8)}@trafficflow.test`,
  }).returning();
  // Reachable: the card's question offers nothing for a mailbox this install holds no credential for.
  await db.insert(mailboxCredentials).values({ mailboxId: mb!.id, transport: "imap", secretEnc: "sealed", keyVersion: 1 });
  let now = at;
  const ctx = { db, accountId, now: () => now } as unknown as ServiceContext;
  return { db, ctx, accountId, mailboxId: mb!.id, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const slow = async (): Promise<ProfileReadResult> => {
  throw new ProfileUnavailableError("the mailbox did not answer in time", { op: "list_profiles", code: "mailbox_read_timeout" });
};
const undialled = async (): Promise<ProfileReadResult> => {
  throw new ProfileUnavailableError("the mailbox could not be dialled", { op: "list_profiles" });
};
const found = async (): Promise<ProfileReadResult> =>
  ({ state: "found", doc: DOC, installId: "other", ref: 7, generation: 1, residue: 0 });

async function askRow(db: Db, mailboxId: string) {
  const [row] = await db.select({
    fp: mailboxes.profileImportAskFingerprint, at: mailboxes.profileImportAskAt,
    outcome: mailboxes.profileImportAskOutcome, reason: mailboxes.profileImportAskReason,
    rung: mailboxes.syncRequestedAt,
  }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
  return row!;
}

describe("the press the request cannot finish", () => {
  it("a door timeout records the ask, rings the worker and answers importing `slow`", async () => {
    const w = await world();
    const got = await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: slow });
    expect(got).toEqual({ state: "importing", fingerprint: FP, reason: "slow" });
    const row = await askRow(w.db, w.mailboxId);
    expect(row).toMatchObject({ fp: FP, outcome: null, reason: null });
    expect(row.at?.getTime()).toBe(NOW.getTime());
    expect(row.rung, "the worker's doorbell").not.toBeNull();
    expect(await w.db.select().from(rules).where(eq(rules.accountId, w.accountId)), "nothing applied").toEqual([]);
  });

  it("a handed-over press keeps what the card said of the signature for the organizer's answer", async () => {
    const said = await world();
    const receipt = "5".repeat(32);
    await profileImportService.apply(said.ctx, said.mailboxId, { fingerprint: FP, signatureReplaces: receipt }, { read: slow });
    const ask = { fingerprint: FP, since: NOW };
    expect(await importAskSignature(said.db as unknown as Tx, { accountId: said.accountId, mailboxId: said.mailboxId, ...ask })).toBe(receipt);
    const silent = await world();
    await profileImportService.apply(silent.ctx, silent.mailboxId, { fingerprint: FP }, { read: slow });
    expect(await importAskSignature(silent.db as unknown as Tx, { accountId: silent.accountId, mailboxId: silent.mailboxId, ...ask })).toBeNull();
    // A later ask of the same document is its own press: the earlier one's word does not carry over.
    expect(await importAskSignature(said.db as unknown as Tx, {
      accountId: said.accountId, mailboxId: said.mailboxId, fingerprint: FP, since: new Date(NOW.getTime() + 1),
    })).toBeNull();
  });

  it("a dial that failed here is handed over too, as `unreachable`", async () => {
    const w = await world();
    const got = await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: undialled });
    expect(got).toEqual({ state: "importing", fingerprint: FP, reason: "unreachable" });
  });

  it("the same press again is the same ticket and dials nothing", async () => {
    const w = await world();
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: slow });
    let reads = 0;
    const counted = async (): Promise<ProfileReadResult> => { reads += 1; return found(); };
    const again = await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: counted });
    expect(again).toEqual({ state: "importing", fingerprint: FP });
    expect(reads).toBe(0);
  });

  it("CONTROL: a read that fits answers in one request, and asks nobody", async () => {
    const w = await world();
    const got = await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: found });
    expect(got).toMatchObject({ imported: { screener: 1, rules: 1, tags: 1 }, skippedRules: 0 });
    expect((await askRow(w.db, w.mailboxId)).fp).toBeNull();
  });

  it("a document that cannot be read refuses BY NAME — never 'changed since you looked', never 502", async () => {
    const w = await world();
    const unreadable = async (): Promise<ProfileReadResult> => ({ state: "unreadable", reason: "not JSON" });
    const err = await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: unreadable })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("profile_document_unreadable");
    expect((err as ServiceError).message).toBe("The saved settings in the mailbox cannot be read. Nothing was changed.");
    expect((await askRow(w.db, w.mailboxId)).fp, "an answer is not handed over").toBeNull();
  });
});

describe("GET …/status — where a handed-over press stands, from the row alone", () => {
  const st = (w: Awaited<ReturnType<typeof world>>, fingerprint = FP) =>
    profileImportService.status(w.ctx, w.mailboxId, { fingerprint });

  it("importing while the ask stands; imported with what ARRIVED once the merge answered it", async () => {
    const w = await world();
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: slow });
    expect(await st(w)).toEqual({ state: "importing", fingerprint: FP });
    // The organizer's merge answers the ask in its own commit — driven here through the inline
    // path, which calls the same merge on a standing ask.
    const applied = await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: "another" }, { read: found })
      .catch(() => null);
    expect(applied, "a different fingerprint is refused, not applied").toBeNull();
    await (w.db as unknown as Tx).update(mailboxes).set({ profileImportAskAt: NOW }).where(eq(mailboxes.id, w.mailboxId));
    w.advance(PROFILE_IMPORT_ASK_TTL_MS + 1);
    const inline = await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: found });
    expect(inline).toMatchObject({ imported: { screener: 1, rules: 1, tags: 1 } });
    expect(await st(w)).toEqual({
      state: "imported", imported: { screener: 1, rules: 1, notifyRules: 0, tags: 1, awayResponder: false, signature: false }, skippedRules: 0,
    });
  });

  it("an ask no organizer answered reads `timed_out` from its own age — never a spinner", async () => {
    const w = await world();
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: slow });
    w.advance(PROFILE_IMPORT_ASK_TTL_MS - 1);
    expect((await st(w)).state).toBe("importing");
    w.advance(2);
    expect(await st(w)).toMatchObject({ state: "refused", reason: "timed_out" });
  });

  it("a later press replaces the ticket: the earlier one reads `superseded`, the later one stands", async () => {
    const w = await world();
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: slow });
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: "a-later-document" }, { read: slow });
    expect(await st(w)).toMatchObject({ state: "refused", reason: "superseded" });
    expect(await st(w, "a-later-document")).toEqual({ state: "importing", fingerprint: "a-later-document" });
  });

  it("the answer is compare-and-set on the ticket: answering a replaced press writes nothing", async () => {
    const w = await world();
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: slow });
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: "a-later-document" }, { read: slow });
    const tx = w.db as unknown as Tx;
    expect(await resolveImportAsk(tx, { accountId: w.accountId, mailboxId: w.mailboxId, fingerprint: FP, outcome: "imported" })).toBe(false);
    expect(await askRow(w.db, w.mailboxId)).toMatchObject({ fp: "a-later-document", outcome: null });
  });

  it("a refusal the organizer recorded is said with its sentence", async () => {
    const w = await world();
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: slow });
    await resolveImportAsk(w.db as unknown as Tx, {
      accountId: w.accountId, mailboxId: w.mailboxId, fingerprint: FP, outcome: "refused", reason: "changed",
    });
    expect(await st(w)).toEqual({
      state: "refused", reason: "changed",
      message: "The saved settings changed since you looked. Review them again before importing.",
    });
  });

  it("a mailbox this install no longer organizes answers `not_organizer`", async () => {
    const w = await world();
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: slow });
    await (w.db as unknown as Tx).update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, w.mailboxId));
    expect(await st(w)).toMatchObject({ state: "refused", reason: "not_organizer" });
  });

  it("another account's mailbox is 404 before any row is read", async () => {
    const w = await world();
    const other = { ...w.ctx, accountId: randomUUID() } as ServiceContext;
    const err = await profileImportService.status(other, w.mailboxId, { fingerprint: FP }).then(() => null, (e: unknown) => e);
    expect((err as ServiceError).httpStatus).toBe(404);
  });
});

describe("the candidate and the erasure", () => {
  it("the card's question answers `importing` while the ask stands, from rows, with no dial", async () => {
    const w = await world();
    await w.db.insert(auditLog).values({
      accountId: w.accountId, action: PROFILE_FOUND_AUDIT_ACTION,
      payload: { mailboxId: w.mailboxId, state: "found", fingerprint: FP, heldForImport: true },
      inverse: null,
    });
    await recordImportAsk(w.db as unknown as Tx, { accountId: w.accountId, mailboxId: w.mailboxId, fingerprint: FP, now: NOW });
    const dto = await profileImportService.candidate(w.ctx, w.mailboxId);
    expect(dto).toEqual({ state: "importing", fingerprint: FP });
  });

  it("the mailbox erasure takes the ask with it, in its first statement", async () => {
    const w = await world();
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: slow });
    await (w.db as unknown as Tx).transaction(async (tx) => {
      await stampMailboxErasure(tx as unknown as Tx, { accountId: w.accountId, mailboxId: w.mailboxId, now: NOW });
    });
    expect(await askRow(w.db, w.mailboxId)).toMatchObject({ fp: null, at: null, outcome: null, reason: null });
  });

  it("the erasure's stamp takes the signature's receipts off the press's row and the found copy's marker", async () => {
    const w = await world();
    const live = "5".repeat(32);
    const copy = "6".repeat(32);
    await w.db.insert(auditLog).values({
      accountId: w.accountId, action: PROFILE_FOUND_AUDIT_ACTION, inverse: null,
      payload: { mailboxId: w.mailboxId, state: "found", fingerprint: FP, heldForImport: true, signatureReceipt: copy },
    });
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP, signatureReplaces: live }, { read: slow });
    const said = () => importAskSignature(w.db as unknown as Tx, { accountId: w.accountId, mailboxId: w.mailboxId, fingerprint: FP, since: NOW });
    const marker = () => latestProfileFoundMarker(w.db as unknown as Tx, w.accountId, w.mailboxId);
    expect([await said(), (await marker())?.signatureReceipt]).toEqual([live, copy]);
    await (w.db as unknown as Tx).transaction(async (tx) => {
      await stampMailboxErasure(tx as unknown as Tx, { accountId: w.accountId, mailboxId: w.mailboxId, now: NOW });
    });
    expect([await said(), (await marker())?.signatureReceipt], "a receipt outlived the stamp").toEqual([null, undefined]);
    expect((await marker())?.fingerprint, "the marker row went with its receipt").toBe(FP);
  });

  it("a removal takes the ask with it, beside the credential: nothing answers a tombstone", async () => {
    const w = await world();
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: slow });
    expect(await askRow(w.db, w.mailboxId)).toMatchObject({ fp: FP, outcome: null });
    await mailboxService.delete(w.ctx, w.mailboxId);
    expect(await askRow(w.db, w.mailboxId)).toMatchObject({ fp: null, at: null, outcome: null, reason: null });
  });
});
