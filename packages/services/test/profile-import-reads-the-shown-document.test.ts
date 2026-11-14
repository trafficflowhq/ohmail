import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  PROFILE_FOUND_AUDIT_ACTION, accounts, auditAction, auditLog, mailboxCredentials, mailboxes,
} from "@trafficflow/db";
import {
  makeProfileDoc, profileFingerprint, type ProfileLocator, type ProfileReadResult,
} from "@trafficflow/core/adapters/organizer-profile";
import { profileImportService } from "../src/profile-import-service.js";
import type { Db, ServiceContext } from "../src/context.js";

/**
 * AN IMPORT RE-READS THE DOCUMENT THE PERSON WAS SHOWN. The organizer publishes its own settings
 * beside the one it asks about, so the folder's newest is no longer that document; the confirm
 * route's reader is handed its locator, built from the organizer's found-marker (writer and write
 * stamp). A marker naming another document, or predating the install id, hands none over.
 */

const DOC = makeProfileDoc({
  screener: [{ address: "anna@example.com" }], rules: [], notifyRules: [], awayResponder: null,
  tagNames: ["theirs"], signature: null,
}, { updatedAt: new Date("2026-09-20T09:00:00.000Z"), producer: { kind: "local", version: "0.25.1" } });
const FP = profileFingerprint(DOC);

async function world(marker: Record<string, unknown>) {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "shown" });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${randomUUID()}@x.test` }).returning();
  await db.insert(mailboxCredentials).values({ mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: "sealed", keyVersion: 1 });
  await db.insert(auditLog).values({
    accountId, action: auditAction(PROFILE_FOUND_AUDIT_ACTION), inverse: null,
    payload: { mailboxId: mb!.id, state: "found", heldForImport: true, updatedAt: DOC.updatedAt, ...marker },
  });
  const ctx = { db, accountId, now: () => new Date("2026-09-28T12:00:00.000Z") } as unknown as ServiceContext;
  const asked: Array<ProfileLocator | undefined> = [];
  const read = async (retain?: ProfileLocator): Promise<ProfileReadResult> => {
    asked.push(retain);
    return { state: "found", doc: DOC, installId: "w-old", ref: 3, generation: 1, residue: 0 };
  };
  return { ctx, mailboxId: mb!.id, asked, read };
}

describe("the confirm route re-reads the document the person was shown", () => {
  it("the marker's writer and write stamp are the locator the reader is handed", async () => {
    const w = await world({ fingerprint: FP, installId: "w-old" });
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: w.read });
    expect(w.asked).toEqual([{ installId: "w-old", second: Math.floor(Date.parse(DOC.updatedAt) / 1000), fingerprint: FP }]);
  });

  it.each([
    ["a marker from before the install id", { fingerprint: FP }],
    ["a marker naming another document", { fingerprint: "1:another", installId: "w-old" }],
  ])("CONTROL: %s hands none over, and the reader answers the newest", async (_label, marker) => {
    const w = await world(marker);
    await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: FP }, { read: w.read });
    expect(w.asked).toEqual([undefined]);
  });
});
