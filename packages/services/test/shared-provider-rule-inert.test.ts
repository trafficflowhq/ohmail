import { describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, folderState, mailboxes, messageBodies, messages, rules, senderIsDecidedSql,
  validateRequestPayload,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { namesAuthor } from "@trafficflow/core/rule-order";
import { applicableProfileRule } from "@trafficflow/core/adapters/organizer-profile";
import { consentIndex, type RuleDTO } from "@ohmail/client-engine";
import { ScreenerService } from "../src/screener-service.js";
import { RulesService } from "../src/rules-service.js";
import { ServiceError } from "../src/errors.js";
import type { ServiceContext } from "../src/context.js";

/**
 * AN ALLOW RULE FOR EVERYONE AT A SHARED PROVIDER ADMITS NOBODY (mail 0148, acceptance 10 and 11),
 * over ONE fixture and on whichever store the project runs: the router's `namesAuthor`, the queue
 * SQL (`senderIsDecidedSql`, so `GET /screener` lists the stranger) and the client's `consentIndex`
 * all decline it — each red alone when its own twin is reverted — and a DENY rule there still
 * names everyone. Every write door refuses one, each beside its admitting control.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const RECENT = new Date("2026-10-06T09:00:00.000Z");
const STRANGER = personalAt("fixture.nadja", "gmail.com");

async function world(rule: { match: string; destination: string } | null) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `inert-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
  }).returning();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `inert:${randomUUID()}`,
    subject: "Bitte bestätigen", snippet: "", fromAddress: STRANGER, fromName: "PostFinance",
    senderCheck: "impersonation", senderCheckBrand: "PostFinance",
    date: RECENT, unread: true, createdAt: RECENT, nativeLocator: { folder: GATE, ref: "1:1" },
  }).returning();
  await db.insert(messageBodies).values({ messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: {} });
  await db.insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  if (rule) {
    await db.insert(rules).values({
      accountId, kind: "domain", match: rule.match, destination: rule.destination, enabled: true, priority: 0, provenance: "manual",
    });
  }
  const ctx: ServiceContext = {
    db: db as never, accountId, userId: null, now: () => NOW, requestId: `inert-${randomUUID().slice(0, 8)}`,
  };
  return { db, accountId, messageId: m!.id, ctx };
}

const decided = async (w: Awaited<ReturnType<typeof world>>): Promise<boolean> => {
  const d = dialect(w.db as never);
  const [row] = await d.exec(w.db as never, sql`select ${senderIsDecidedSql(d, w.accountId, sql`${STRANGER}`)}`);
  const v = row![0];
  return v === true || v === 1 || v === "t";
};
const listed = async (w: Awaited<ReturnType<typeof world>>) => (await new ScreenerService({}).list(w.ctx, { limit: 50 })).items;
const dto = (match: string, destination: string): RuleDTO => ({
  id: "r", kind: "domain", match, destination, enabled: true, priority: 0, provenance: "manual",
} as unknown as RuleDTO);

describe("three twins over one fixture: an allow rule at gmail.com decides about nobody", () => {
  it("ACCEPTANCE 10: the router, the queue SQL and the client index all leave the stranger undecided", async () => {
    const w = await world({ match: "gmail.com", destination: "INBOX" });
    expect(namesAuthor({ kind: "domain", match: "gmail.com", destination: "INBOX", effect: "allow" }, STRANGER)).toBe(false);
    expect(await decided(w)).toBe(false);
    expect((await listed(w)).map((i) => i.sender.address)).toEqual([STRANGER]);
    expect(consentIndex([dto("gmail.com", "INBOX")]).byDomain.has("gmail.com")).toBe(false);
  });

  it("CONTROL: a deny rule at gmail.com names the stranger on all three", async () => {
    const w = await world({ match: "gmail.com", destination: "ohmail/Screened" });
    expect(namesAuthor({ kind: "domain", match: "gmail.com", destination: "ohmail/Screened", effect: "deny" }, STRANGER)).toBe(true);
    expect(await decided(w)).toBe(true);
    expect(consentIndex([dto("gmail.com", "ohmail/Screened")]).byDomain.has("gmail.com")).toBe(true);
  });

  it("CONTROL: an allow rule on a firm's own domain still names everyone there", () => {
    expect(namesAuthor({ kind: "domain", match: "firma.example", destination: "INBOX", effect: "allow" }, "anna@firma.example")).toBe(true);
    expect(consentIndex([dto("firma.example", "INBOX")]).byDomain.has("firma.example")).toBe(true);
  });

  it("the queue row carries the sender's identity fact, aggregated over the held mail", async () => {
    const w = await world({ match: "gmail.com", destination: "INBOX" });
    const [item] = await listed(w);
    expect(item?.checked).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: true });
  });
});

describe("ACCEPTANCE 11: every write door refuses everyone at a shared provider, each beside its control", () => {
  const refused = async (p: Promise<unknown>, code: string, status: number) => {
    const err = await p.then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe(code);
    expect((err as ServiceError).httpStatus).toBe(status);
  };

  it("the Screener decide: a domain yes at gmail.com is 422, the address yes is admitted", async () => {
    const w = await world(null);
    await refused(new ScreenerService({}).decide(w.ctx, w.messageId, { decision: "yes", scope: "domain" }),
      "shared_provider_domain", 422);
    const ok = await new ScreenerService({}).decide(w.ctx, w.messageId, { decision: "yes", scope: "sender" });
    expect(ok).toBeDefined();
  });

  it("POST /rules: an allow rule at gmail.com is 400; a deny there and an allow at a brand's own domain are written", async () => {
    const w = await world(null);
    const svc = new RulesService();
    await refused(svc.create(w.ctx, { kind: "domain", match: "gmail.com", destination: "INBOX" }), "shared_provider_domain", 400);
    await expect(svc.create(w.ctx, { kind: "domain", match: "gmail.com", destination: "ohmail/Screened" })).resolves.toBeDefined();
    await expect(svc.create(w.ctx, { kind: "domain", match: "postfinance.ch", destination: "INBOX" })).resolves.toBeDefined();
  });

  it("PATCH: switching on an allow rule at gmail.com is 400; pausing it is admitted", async () => {
    const w = await world(null);
    const [row] = await w.db.insert(rules).values({
      accountId: w.accountId, kind: "domain", match: "gmail.com", destination: "INBOX", enabled: false, priority: 0, provenance: "manual",
    }).returning();
    const svc = new RulesService();
    await refused(svc.update(w.ctx, row!.id, { enabled: true }), "shared_provider_domain", 400);
    await expect(svc.update(w.ctx, row!.id, { enabled: false })).resolves.toBeDefined();
    const [after] = await w.db.select({ enabled: rules.enabled }).from(rules).where(eq(rules.id, row!.id));
    expect(after!.enabled).toBe(false);
  });

  it("a travelled request at domain scope is no payload; at sender scope it is", () => {
    expect(validateRequestPayload({ scope: "domain", decision: "yes", address: STRANGER, appliedFolder: "INBOX" })).toBeNull();
    expect(validateRequestPayload({ scope: "sender", decision: "yes", address: STRANGER, appliedFolder: "INBOX" })).not.toBeNull();
    expect(validateRequestPayload({ scope: "domain", decision: "no", address: STRANGER, appliedFolder: "ohmail/Screened" })).not.toBeNull();
  });

  it("a travelled profile carrying gmail.com → INBOX skips that rule; a firm's domain rule is applied", () => {
    const entry = (match: string) => ({
      kind: "domain", match, destination: "INBOX", priority: 0, enabled: true, provenance: "manual",
    }) as never;
    expect(applicableProfileRule(entry("gmail.com"))).toBeNull();
    expect(applicableProfileRule(entry("firma.example"))).not.toBeNull();
  });
});
