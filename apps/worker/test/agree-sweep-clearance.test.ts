import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { accounts, mailboxes } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { formatProfileMessage, makeProfileDoc, type ProfileIo } from "@trafficflow/core/adapters/organizer-profile";
import { OrganizerProfileSync, sweepHeld } from "../src/profile.js";

/**
 * THE AGREE'S SWEEP FAILS CLOSED (LOW-1). A one-time bulk move runs only
 * on a FRESH, clean read of the shared settings folder that finds no question open. A read fault, a
 * garbled settings document and an adapter that cannot reach the folder each answer `unread`, which
 * `agreeSweepSlice` turns into "nothing moved"; `importHoldNow` keeps its own routing answer.
 */

const SELF = "W-self";

function rawDoc(): string {
  return formatProfileMessage(makeProfileDoc(
    { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs"], signature: null },
    { updatedAt: new Date("2026-10-01T00:00:00.000Z"), producer: { kind: "local", version: "dev" } },
  ), { installId: "W-other" });
}

function io(list: ProfileIo["listProfileMessages"]): ProfileIo {
  return {
    ensureMetaFolder: async () => {},
    listProfileMessages: list,
    appendProfile: async () => {},
    removeProfiles: async () => {},
  };
}

async function syncOver(folder: ProfileIo | null, flushIntervalMs = 0): Promise<OrganizerProfileSync> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `clr-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `clr-${accountId.slice(0, 8)}@example.test`, organizerRole: "organizer",
  }).returning();
  const adapter = folder === null ? {} : { profileIo: () => folder };
  return new OrganizerProfileSync({
    db: db as never, accountId, mailboxId: mb!.id, adapter: adapter as never,
    self: { installId: SELF, kind: "local" }, producerVersion: "dev", flushIntervalMs,
  });
}

describe("the agree sweep's clearance", () => {
  it("a clean read of an empty folder clears the sweep", async () => {
    const sync = await syncOver(io(async () => []));
    const c = await sync.sweepClearance();
    expect(c).toEqual({ kind: "clear" });
    expect(sweepHeld(c)).toBe(false);
  });

  it("a read fault fails closed", async () => {
    const sync = await syncOver(io(async () => { throw new Error("SEARCH refused"); }));
    const c = await sync.sweepClearance();
    expect(c).toEqual({ kind: "unread", why: "read_fault" });
    expect(sweepHeld(c)).toBe("unread");
  });

  it("a garbled settings document fails closed, where routing reads it as no question", async () => {
    const garbled = rawDoc().replace(/\{[\s\S]*\}/, "this is not a settings document");
    const sync = await syncOver(io(async () => [{ ref: 1, raw: garbled, generation: { uidvalidity: 1n } as never }]));
    expect(await sync.sweepClearance()).toEqual({ kind: "unread", why: "garbled" });
    expect(await sync.importHoldNow(), "routing's answer is unchanged").toBeUndefined();
  });

  it("CONTROL — the same document readable is no garbled verdict", async () => {
    const sync = await syncOver(io(async () => [{ ref: 1, raw: rawDoc(), generation: { uidvalidity: 1n } as never }]));
    expect(await sync.sweepClearance()).not.toEqual({ kind: "unread", why: "garbled" });
  });

  it("the clearance reads the folder fresh: a clean answer routing cached does not clear a folder that now faults", async () => {
    let fault = false;
    const sync = await syncOver(io(async () => { if (fault) throw new Error("SEARCH refused"); return []; }), 3_600_000);
    expect(await sync.importHoldNow()).toBeUndefined();
    fault = true;
    expect(await sync.importHoldNow(), "routing serves its cached answer").toBeUndefined();
    expect(await sync.sweepClearance()).toEqual({ kind: "unread", why: "read_fault" });
  });

  it("an adapter that cannot reach the folder fails closed", async () => {
    const sync = await syncOver(null);
    expect(await sync.sweepClearance()).toEqual({ kind: "unread", why: "no_folder" });
  });
});
