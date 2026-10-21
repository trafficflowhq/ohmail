import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxCredentials, mailboxes, rules } from "@trafficflow/db";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
  type OrganizerProfileDoc, type ProfileReadResult, type ProfileRuleEntry,
} from "@trafficflow/core/adapters/organizer-profile";
import { profileImportService } from "../src/profile-import-service.js";
import type { Db, ServiceContext } from "../src/context.js";

/**
 * AN IMPORTED RULE KEEPS THE AGE IT HAD WHERE IT WAS MADE. The gap
 * pass counts a letter only for a rule older than its arrival, so an import that stamps every rule
 * with its own instant counts nothing. The insert and update arms write the copy's age; an age later
 * than now is clamped to now and a copy without one gets now; a rule already as the copy says is not
 * written. Every copy goes through the message format both ways.
 */
const NOW = new Date("2026-10-13T10:00:00.000Z");
const MADE = "2026-09-01T08:00:00.000Z";
const NEWS = "ohmail/News";

async function world() {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `ages-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${accountId.slice(0, 8)}@trafficflow.test`,
  }).returning();
  await db.insert(mailboxCredentials).values({ mailboxId: mb!.id, transport: "imap", secretEnc: "sealed", keyVersion: 1 });
  const ctx = { db, accountId, userId: null, now: () => NOW, requestId: "ages" } as unknown as ServiceContext;
  return { db, ctx, accountId, mailboxId: mb!.id };
}
type World = Awaited<ReturnType<typeof world>>;

const news = (more: Partial<ProfileRuleEntry> = {}): ProfileRuleEntry =>
  ({ kind: "sender", match: "letters@news.test", destination: NEWS, priority: 0, enabled: true, provenance: "manual", ...more });

/** The copy as a mailbox carries it: written, formatted, parsed back. */
function copyOf(entries: ProfileRuleEntry[]): OrganizerProfileDoc {
  const doc = makeProfileDoc({ screener: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null, rules: entries },
    { updatedAt: new Date("2026-10-12T09:00:00.000Z"), producer: { kind: "local", version: "dev" } });
  const parsed = parseProfileMessage(formatProfileMessage(doc, { installId: "the-desktop" }));
  if (parsed === null || isMalformedProfile(parsed) || !parsed.doc) throw new Error("expected a readable copy");
  return parsed.doc;
}

async function importCopy(w: World, d: OrganizerProfileDoc): Promise<void> {
  const read = async (): Promise<ProfileReadResult> => ({ state: "found", doc: d, installId: "the-desktop", ref: 1, residue: 0, generation: 1_000 });
  const r = await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read });
  if ("state" in r) throw new Error(`the press was handed to the organizer: ${JSON.stringify(r)}`);
}

const ageOf = async (w: World, match = "letters@news.test") => (await w.db.select({ at: rules.updatedAt }).from(rules)
  .where(and(eq(rules.accountId, w.accountId), eq(rules.match, match))))[0]?.at.toISOString();

describe("an imported rule keeps the age it had where it was made", () => {
  it("a new rule is written with the copy's age", async () => {
    const w = await world();
    const copy = copyOf([news({ updatedAt: MADE })]);
    expect(copy.rules[0]!.updatedAt, "premise: the copy carries the age").toBe(MADE);
    await importCopy(w, copy);
    expect(await ageOf(w)).toBe(MADE);
  });

  it("a rule the copy changes takes the copy's age", async () => {
    const w = await world();
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "letters@news.test", destination: "ohmail/Receipts",
      provenance: "manual", enabled: true, createdAt: NOW, updatedAt: NOW,
    });
    await importCopy(w, copyOf([news({ updatedAt: MADE })]));
    expect(await ageOf(w)).toBe(MADE);
  });

  it("an age later than now is clamped to now, and a copy without one gets now", async () => {
    const w = await world();
    await importCopy(w, copyOf([
      news({ updatedAt: "2027-01-01T00:00:00.000Z" }),
      news({ match: "plain@news.test" }),
    ]));
    expect(await ageOf(w)).toBe(NOW.toISOString());
    expect(await ageOf(w, "plain@news.test")).toBe(NOW.toISOString());
  });

  it("a rule already as the copy says is not written", async () => {
    const w = await world();
    const held = new Date("2026-10-10T00:00:00.000Z");
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: "letters@news.test", destination: NEWS,
      provenance: "manual", enabled: true, createdAt: held, updatedAt: held,
    });
    await importCopy(w, copyOf([news({ updatedAt: MADE })]));
    expect(await ageOf(w)).toBe(held.toISOString());
  });
});
