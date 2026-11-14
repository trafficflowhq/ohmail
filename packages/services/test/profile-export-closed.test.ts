import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, auditLog, contacts, mailboxCredentials, mailboxes, notifyRules, rules, tags, PROFILE_FOUND_AUDIT_ACTION } from "@trafficflow/db";
import {
  PROFILE_LIST_MAX, makeProfileDoc, profileFingerprint,
  type OrganizerProfileDoc, type ProfileReadResult,
} from "@trafficflow/core/adapters/organizer-profile";
import { serializeOrganizerProfile, serializeOrganizerProfileCounted } from "@trafficflow/core/adapters/organizer-profile-store";
import { PROFILE_IMPORT_MAX, profileImportService, type ProfileImportApplied } from "../src/profile-import-service.js";
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
 * Nothing caps what an account holds, the serializer published all
 * of it, and the importer on another machine refused anything past its per-list ceiling — so an
 * account one tag past the importer's ceiling exported settings the same product could not import. The serializer
 * now publishes within the importer's own number (one constant), keeping the newest of each list
 * and letting automatic rules go first. Proved here across two stores, every list one past it.
 */
const NOW = new Date("2026-09-22T12:00:00.000Z");

interface Machine { db: Db; ctx: ServiceContext; accountId: string; mailboxId: string }

async function machine(): Promise<Machine> {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `closed-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${accountId.slice(0, 8)}@trafficflow.test`,
  }).returning();
  // Reachable: the card's question offers nothing for a mailbox this install holds no credential for.
  await db.insert(mailboxCredentials).values({ mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: "sealed", keyVersion: 1 });
  return { db, ctx: { db, accountId, now: () => NOW } as unknown as ServiceContext, accountId, mailboxId: mb!.id };
}

/** Row `i` is `i` ms newer than row 0, so "the newest N" has one answer. */
const at = (i: number): Date => new Date(Date.UTC(2026, 0, 1) + i);

async function inChunks<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) await write(rows.slice(i, i + 1000));
}

describe("a profile this product exports, another machine imports", () => {
  it("the import's ceiling IS the format's list bound — one number, not two kept in step", () => {
    expect(PROFILE_IMPORT_MAX).toBe(PROFILE_LIST_MAX);
  });

  it("an account one past every list's ceiling publishes a document AT it, and it applies whole", async () => {
    const a = await machine();
    const n = (k: keyof typeof PROFILE_LIST_MAX): number => PROFILE_LIST_MAX[k] + 1;
    await inChunks(Array.from({ length: n("screener") }, (_, i) => i), (c) => a.db.insert(contacts)
      .values(c.map((i) => ({ accountId: a.accountId, address: `p${i}@example.com`, createdAt: at(i) }))));
    // Every rule deliberate but the NEWEST, which is automatic: the automatic one goes, not the oldest.
    await inChunks(Array.from({ length: n("rules") }, (_, i) => i), (c) => a.db.insert(rules)
      .values(c.map((i) => ({
        accountId: a.accountId, kind: "sender", match: `r${i}@example.com`, destination: "ohmail/News",
        provenance: i === n("rules") - 1 ? "promoted" : "manual", createdAt: at(i),
      }))));
    await inChunks(Array.from({ length: n("notifyRules") }, (_, i) => i), (c) => a.db.insert(notifyRules)
      .values(c.map((i) => ({ accountId: a.accountId, kind: "sender", target: `n${i}@example.com`, createdAt: at(i) }))));
    await inChunks(Array.from({ length: n("tagNames") }, (_, i) => i), (c) => a.db.insert(tags)
      .values(c.map((i) => ({ accountId: a.accountId, name: `t${i}`, createdAt: at(i) }))));

    const { payload, leftOut } = await serializeOrganizerProfileCounted(a.db as never, a.accountId, a.mailboxId);
    // One past every bound: one of each left out, said BESIDE the document, never in it.
    expect(leftOut).toEqual({ screener: 1, rules: 1, notifyRules: 1, tagNames: 1 });
    expect(JSON.stringify(payload)).not.toContain("leftOut");
    expect(payload.screener).toHaveLength(PROFILE_LIST_MAX.screener);
    expect(payload.rules).toHaveLength(PROFILE_LIST_MAX.rules);
    expect(payload.notifyRules).toHaveLength(PROFILE_LIST_MAX.notifyRules);
    expect(payload.tagNames).toHaveLength(PROFILE_LIST_MAX.tagNames);
    expect(payload.screener.some((s) => s.address === "p0@example.com"), "the oldest contact stays behind").toBe(false);
    expect(payload.tagNames.includes("t0"), "the oldest tag stays behind").toBe(false);
    expect(payload.rules.some((r) => r.provenance === "promoted"), "the automatic rule goes first").toBe(false);
    expect(payload.rules.some((r) => r.match === "r0@example.com"), "…so the oldest deliberate rule stays").toBe(true);

    // Another machine: offered, applied whole, and it then holds exactly what was published.
    const b = await machine();
    const d: OrganizerProfileDoc = makeProfileDoc(payload, { updatedAt: NOW, producer: { kind: "local", version: "0.23.1" } });
    const fingerprint = profileFingerprint(d);
    await b.db.insert(auditLog).values({
      accountId: b.accountId, action: PROFILE_FOUND_AUDIT_ACTION, inverse: null,
      payload: {
        mailboxId: b.mailboxId, state: "found", fingerprint, heldForImport: true,
        updatedAt: d.updatedAt, producer: d.producer,
        counts: { screener: d.screener.length, rules: d.rules.length, notifyRules: d.notifyRules.length, tagNames: d.tagNames.length, awayResponder: 0 },
      },
    });
    const read = async (): Promise<ProfileReadResult> => ({
      state: "found", doc: d, installId: "machine-a", ref: 1, residue: 0, generation: 1_000,
    });
    const offer = await profileImportService.candidate(b.ctx, b.mailboxId);
    expect((offer as { state: string }).state, "offered, not refused as too large").toBe("found");
    const applied = await inlineApply(b.ctx, b.mailboxId, { fingerprint }, { read });
    expect(applied.imported).toMatchObject({
      screener: PROFILE_LIST_MAX.screener, rules: PROFILE_LIST_MAX.rules,
      notifyRules: PROFILE_LIST_MAX.notifyRules, tags: PROFILE_LIST_MAX.tagNames,
    });
    expect(applied.skippedRules).toBe(0);
    const back = await serializeOrganizerProfile(b.db as never, b.accountId, b.mailboxId);
    expect(profileFingerprint(back, d.v), "machine B holds what machine A published").toBe(fingerprint);
  }, 240_000);
});
