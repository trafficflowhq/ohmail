import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxCredentials, mailboxes, rules, type Tx } from "@trafficflow/db";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
  type OrganizerProfileDoc, type OrganizerProfilePayload, type ProfileReadResult,
} from "@trafficflow/core/adapters/organizer-profile";
import { serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { profileImportService } from "../src/profile-import-service.js";
import { GRADUATION_THRESHOLD, LearningService } from "../src/learning-service.js";
import type { Db, ServiceContext } from "../src/context.js";

/**
 * THE PERSON'S STAMP TRAVELS IN THE PROFILE DOCUMENT. A pause on one organizer is the person's
 * decision on the other: the merge writes a stamp it receives and never clears one it holds, so
 * the other organizer's graduation for that sender writes nothing over it. An unstamped rule
 * serializes without the key, so a document written before it keeps its fingerprint.
 */
const NOW = new Date("2026-10-05T12:00:00.000Z");
const STAMP = "2026-10-01T08:00:00.000Z";
const SENDER = "digest@anchor.example";
const NEWS = "ohmail/News";

async function world() {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `stamp-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${accountId.slice(0, 8)}@trafficflow.test`,
  }).returning();
  await db.insert(mailboxCredentials).values({ mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: "sealed", keyVersion: 1 });
  const ctx = { db, accountId, userId: null, now: () => NOW, requestId: "stamp" } as unknown as ServiceContext;
  return { db, ctx, accountId, mailboxId: mb!.id };
}
type World = Awaited<ReturnType<typeof world>>;

const payload = (rule: Partial<OrganizerProfilePayload["rules"][number]>): OrganizerProfilePayload => ({
  screener: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
  rules: [{ kind: "sender", match: SENDER, destination: NEWS, priority: 0, enabled: true, provenance: "promoted", ...rule }],
});
const docOf = (p: OrganizerProfilePayload): OrganizerProfileDoc =>
  makeProfileDoc(p, { updatedAt: new Date("2026-10-04T09:00:00.000Z"), producer: { kind: "local", version: "0.25.15" } });
const found = (d: OrganizerProfileDoc) => ({
  read: async (): Promise<ProfileReadResult> => ({ state: "found", doc: d, installId: "the-other-organizer", ref: 1, residue: 0, generation: 1_000 }),
});

async function apply(w: World, d: OrganizerProfileDoc): Promise<void> {
  const r = await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, found(d));
  if ("state" in r) throw new Error(`the press was handed to the organizer: ${JSON.stringify(r)}`);
}
const rowOf = async (w: World) => (await w.db.select().from(rules)
  .where(and(eq(rules.accountId, w.accountId), eq(rules.kind, "sender"))))
  .map((r) => ({ destination: r.destination, enabled: r.enabled, provenance: r.provenance, stamp: r.personDecidedAt?.toISOString() ?? null }));

describe("the person's stamp travels in the profile document", () => {
  it("the serializer writes it, the message carries it, and the parser reads it back", async () => {
    const w = await world();
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: NEWS, enabled: false, provenance: "promoted", personDecidedAt: new Date(STAMP),
    });
    const p = await serializeOrganizerProfile(w.db as unknown as Tx, w.accountId, w.mailboxId);
    expect(p.rules.map((r) => r.personDecidedAt)).toEqual([STAMP]);
    const parsed = parseProfileMessage(formatProfileMessage(docOf(p), { installId: "a" }));
    if (parsed === null || isMalformedProfile(parsed)) throw new Error("expected a readable document");
    expect(parsed.doc!.rules.map((r) => r.personDecidedAt)).toEqual([STAMP]);
    expect(profileFingerprint(parsed.doc!)).toBe(profileFingerprint(p));
  });

  it("an unstamped rule serializes without the key, and an unreadable stamp parses to none", () => {
    const plain = docOf(payload({}));
    expect(Object.keys(plain.rules[0]!)).not.toContain("personDecidedAt");
    const raw = formatProfileMessage(docOf(payload({ personDecidedAt: STAMP })), { installId: "a" })
      .replace(STAMP, "yesterday-ish");
    const parsed = parseProfileMessage(raw);
    if (parsed === null || isMalformedProfile(parsed)) throw new Error("expected a readable document");
    expect(Object.keys(parsed.doc!.rules[0]!)).not.toContain("personDecidedAt");
  });

  it("a pause on the other organizer reaches this one, and this one's graduation writes nothing over it", async () => {
    const w = await world();
    // What this organizer learned on its own: the sender's rule, on, nobody's stamp.
    await w.db.insert(rules).values({ accountId: w.accountId, kind: "sender", match: SENDER, destination: NEWS, enabled: true, provenance: "promoted" });
    await apply(w, docOf(payload({ enabled: false, personDecidedAt: STAMP })));
    const paused = [{ destination: NEWS, enabled: false, provenance: "promoted", stamp: STAMP }];
    expect(await rowOf(w), "the stamp did not arrive").toEqual(paused);
    const learning = new LearningService();
    for (let i = 0; i < GRADUATION_THRESHOLD; i++) {
      await learning.record(w.ctx, { triggeringActionId: `g:${i}`, kind: "approval", senderAddress: SENDER, destination: NEWS, label: "positive" });
    }
    await learning.promoteOrDemote(w.ctx, `sender:${SENDER}→${NEWS}`);
    expect(await rowOf(w), "this organizer's graduation switched the person's pause back on").toEqual(paused);
    expect(await learning.isGraduated(w.ctx, `sender:${SENDER}→${NEWS}`)).toBe(false);
  });

  it("a document without the stamp never clears one this store holds", async () => {
    const w = await world();
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: SENDER, destination: NEWS, enabled: false, provenance: "promoted", personDecidedAt: new Date(STAMP),
    });
    await apply(w, docOf(payload({ enabled: true })));
    expect(await rowOf(w)).toEqual([{ destination: NEWS, enabled: true, provenance: "promoted", stamp: STAMP }]);
  });
});
