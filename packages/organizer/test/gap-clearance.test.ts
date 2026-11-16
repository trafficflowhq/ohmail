import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accounts, mailboxes, recordProfileImportResolution } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  formatProfileMessage, makeProfileDoc, profileFingerprint, type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { OrganizerProfileSync } from "../src/profile.js";

/**
 * THE GAP PASS'S CLEARANCE. The gap pass may not open IMAP, so
 * it is handed what the routing evaluation last found, synchronously and with no read of its own.
 * `clear` only after an evaluation that read the folder cleanly with no question open; before any
 * evaluation, after a fault, over a garbled document or while a question stands it withholds.
 */

const SELF = "W-self";
const FOREIGN = makeProfileDoc(
  { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs"], signature: null },
  { updatedAt: new Date("2026-10-01T00:00:00.000Z"), producer: { kind: "local", version: "dev" } },
);
const RAW = formatProfileMessage(FOREIGN, { installId: "W-other" });

/** A settings folder whose contents and faults a case sets, counting its listings. */
class Folder implements ProfileIo {
  messages: RawProfileMessage[] = [];
  fault = false;
  listings = 0;
  async ensureMetaFolder(): Promise<void> {}
  async listProfileMessages(): Promise<RawProfileMessage[]> {
    this.listings++;
    if (this.fault) throw new Error("FETCH refused");
    return this.messages.map((m) => ({ ...m }));
  }
  async appendProfile(): Promise<void> {}
  async removeProfiles(): Promise<void> {}
  hold(raw: string): void { this.messages = [{ ref: 1, raw, generation: 1_000 } as RawProfileMessage]; }
}

async function syncOver(folder: Folder | null, flushIntervalMs = 3_600_000) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `gcl-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `gcl-${accountId.slice(0, 8)}@example.test`, organizerRole: "organizer",
  }).returning();
  const adapter = folder === null ? {} : { profileIo: () => folder };
  const sync = new OrganizerProfileSync({
    db: db as never, accountId, mailboxId: mb!.id, adapter: adapter as never,
    self: { installId: SELF, kind: "local" }, producerVersion: "dev", flushIntervalMs,
  });
  return { sync, db, accountId, mailboxId: mb!.id };
}

describe("the gap pass's clearance is the last evaluation, read with no IO", () => {
  it("an adapter that cannot reach the folder is unread: no_folder", async () => {
    const { sync } = await syncOver(null);
    expect(sync.gapClearance()).toEqual({ kind: "unread", why: "no_folder" });
  });

  it("before any evaluation it is not clear, and asking reads nothing", async () => {
    const folder = new Folder();
    const { sync } = await syncOver(folder);
    expect(sync.gapClearance()).toEqual({ kind: "unread", why: "read_fault" });
    expect(folder.listings, "the clearance read the folder").toBe(0);
  });

  it("a hold armed before any evaluation is held", async () => {
    const folder = new Folder();
    folder.hold(RAW);
    const { sync } = await syncOver(folder);
    await sync.armHoldFromFolder();
    expect(sync.importDecisionOpen(), "premise: the preflight armed the hold").toBe(true);
    expect(sync.gapClearance()).toEqual({ kind: "held" });
  });

  it("a clean read of an empty folder clears it, and the clearance adds no listing", async () => {
    const folder = new Folder();
    const { sync } = await syncOver(folder);
    expect(await sync.importHoldNow()).toBeUndefined();
    const before = folder.listings;
    for (let i = 0; i < 5; i++) expect(sync.gapClearance()).toEqual({ kind: "clear" });
    expect(folder.listings).toBe(before);
  });

  it("an open question is held; a decline clears it after one evaluation", async () => {
    const folder = new Folder();
    folder.hold(RAW);
    const { sync, db, accountId, mailboxId } = await syncOver(folder);
    expect(await sync.importHoldNow(), "premise: a foreign document is a question").toMatchObject({ kind: "document" });
    expect(sync.gapClearance()).toEqual({ kind: "held" });
    await recordProfileImportResolution(db as never, {
      accountId, mailboxId, decision: "declined", fingerprint: profileFingerprint(FOREIGN),
    });
    expect(sync.gapClearance(), "the clearance read the store").toEqual({ kind: "held" });
    expect(await sync.importHoldNow()).toBeUndefined();
    expect(sync.gapClearance()).toEqual({ kind: "clear" });
  });

  it("a fault after a clean read withholds until a read succeeds again", async () => {
    const folder = new Folder();
    const { sync } = await syncOver(folder, 0);
    expect(await sync.importHoldNow()).toBeUndefined();
    expect(sync.gapClearance()).toEqual({ kind: "clear" });
    folder.fault = true;
    expect(await sync.importHoldNow(), "routing serves its previous answer").toBeUndefined();
    expect(sync.gapClearance()).toEqual({ kind: "unread", why: "read_fault" });
    folder.fault = false;
    await sync.importHoldNow();
    expect(sync.gapClearance()).toEqual({ kind: "clear" });
  });

  it("a garbled settings document is unread: garbled", async () => {
    const folder = new Folder();
    folder.hold(RAW.replace(/\{[\s\S]*\}/, "this is not a settings document"));
    const { sync } = await syncOver(folder);
    expect(await sync.importHoldNow(), "routing reads it as no question").toBeUndefined();
    expect(sync.gapClearance()).toEqual({ kind: "unread", why: "garbled" });
  });

  it("a hold armed after a closed verdict was cached is held, not clear", async () => {
    const folder = new Folder();
    const { sync } = await syncOver(folder);
    expect(await sync.importHoldNow()).toBeUndefined();
    folder.hold(RAW);
    await sync.armHoldFromFolder();
    expect(sync.importDecisionOpen(), "premise: the preflight armed the hold").toBe(true);
    expect(sync.gapClearance()).toEqual({ kind: "held" });
  });

  it("a demotion forgets the evaluation", async () => {
    const folder = new Folder();
    const { sync } = await syncOver(folder);
    await sync.importHoldNow();
    expect(sync.gapClearance()).toEqual({ kind: "clear" });
    sync.forgetOrganizerLife();
    expect(sync.gapClearance()).toEqual({ kind: "unread", why: "read_fault" });
  });
});
