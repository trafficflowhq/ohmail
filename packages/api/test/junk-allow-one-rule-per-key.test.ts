import { accountOfMailbox } from "@trafficflow/db";
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { accountSettings, mailboxCredentials, mailboxes, rules as rulesTbl } from "@trafficflow/db";
import { acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { rescueJunk } from "../src/junk-window.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * "NOT JUNK, ALWAYS ALLOW" WRITES ONE RULE PER KEY (JUNK-ALLOW-ADDS-A-TWIN-BESIDE-AN-ACTING-SCREEN-OUT).
 * Over a sender who already has a screen-out or a spam rule, the press converges that key onto one
 * row filing into the Ohbox: the screen-out no longer outranks the allow the press asked for.
 */
const NOW = new Date("2026-10-04T03:00:00.000Z");
const ADDR = "lena@atelier.example";

async function seed() {
  const db = await makeTestDb();
  vi.restoreAllMocks();
  vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
  const accountId = randomUUID();
  await db.insert(accountSettings).values({ accountId, foldersEnabledAt: NOW });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `junk-${randomUUID().slice(0, 8)}@example.invalid`, junkFolder: "Junk",
  }).returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u" },
  });
  const deps = {
    db, keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } }, now: () => NOW,
  } as unknown as ApiDeps;
  const ctx = { accountId, now: () => NOW } as unknown as Parameters<typeof rescueJunk>[1];
  return { db, deps, ctx, accountId, mailboxId: mb!.id };
}

describe("Not junk, always allow over a sender who has a rule", () => {
  for (const dest of ["ohmail/Screened", "ohmail/Quarantine"]) {
    it(`over an enabled ${dest} sender rule`, async () => {
      const s = await seed();
      await s.db.insert(rulesTbl).values({ accountId: s.accountId, kind: "sender", match: ADDR, destination: dest, provenance: "manual" });
      await rescueJunk(s.deps, s.ctx, { mailboxId: s.mailboxId, uid: 2, uidValidity: "7", allow: { sender: ADDR } });
      const rows = (await s.db.select().from(rulesTbl).where(eq(rulesTbl.accountId, s.accountId)))
        .map((r) => `${r.destination}/${r.provenance}/${r.enabled ? "on" : "off"}`).sort();
      expect(rows).toEqual(["INBOX/manual/on"]);
    });
  }
});
