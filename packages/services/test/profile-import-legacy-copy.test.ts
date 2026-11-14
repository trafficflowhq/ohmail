import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, approvals, mailboxCredentials, mailboxes, routingDecisions, rules } from "@trafficflow/db";
import {
  formatProfileMessage, isMalformedProfile, makeProfileDoc, parseProfileMessage, profileFingerprint,
  type OrganizerProfileDoc, type ProfileReadResult, type ProfileRuleEntry,
} from "@trafficflow/core/adapters/organizer-profile";
import { effectForDestination, evaluateRules, type NormalizedMessage, type Rule } from "@trafficflow/core/mail";
import { profileImportService } from "../src/profile-import-service.js";
import { ApprovalService, GRADUATION_THRESHOLD } from "../src/index.js";
import type { Db, ServiceContext } from "../src/context.js";
import { seedMessage } from "./helpers.js";

/**
 * A SETTINGS COPY FROM AN OLDER OHMAIL, IMPORTED AFTER 0144 RAN HERE. Its producer states no
 * `producer.stamped`, so the person's allow arrives as an unstamped promotion; the import stamps it
 * when the copy's own Screener lists the sender, and three approvals then leave it in the Inbox.
 * Every copy goes through the message format both ways, so what is measured is the parser's
 * reading; an older copy has the flag removed and its absence asserted before it is used.
 */
const ADDR = "lena@atelier.example";
const RECEIPTS = "ohmail/Receipts";
const NOW = new Date("2026-10-07T10:00:00.000Z");

async function world() {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `legacy-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${accountId.slice(0, 8)}@trafficflow.test`,
  }).returning();
  await db.insert(mailboxCredentials).values({ mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: "sealed", keyVersion: 1 });
  const ctx = { db, accountId, userId: null, now: () => NOW, requestId: "legacy" } as unknown as ServiceContext;
  return { db, ctx, accountId, mailboxId: mb!.id };
}
type World = Awaited<ReturnType<typeof world>>;

const allow = (more: Partial<ProfileRuleEntry> = {}): ProfileRuleEntry =>
  ({ kind: "sender", match: ADDR, destination: "INBOX", priority: 0, enabled: true, provenance: "promoted", ...more });

/** The copy as a mailbox carries it: written, formatted, parsed back. `older` removes the flag first. */
function copyOf(entries: ProfileRuleEntry[], o: { older: boolean; screener?: string[] }): OrganizerProfileDoc {
  const doc = makeProfileDoc({
    screener: (o.screener ?? [ADDR]).map((address) => ({ address })), notifyRules: [], awayResponder: null,
    tagNames: [], signature: null, rules: entries,
  }, { updatedAt: new Date("2026-10-06T09:00:00.000Z"), producer: { kind: "local", version: o.older ? "0.25.16" : "0.25.18" } });
  if (o.older) delete (doc.producer as { stamped?: true }).stamped;
  const parsed = parseProfileMessage(formatProfileMessage(doc, { installId: "the-other-install" }));
  if (parsed === null || isMalformedProfile(parsed) || !("doc" in parsed) || !parsed.doc) throw new Error("expected a readable copy");
  // RISK 2's guard: an "older" copy that still states the flag would measure the trusted branch.
  if ((parsed.doc.producer.stamped === true) === o.older) throw new Error(`the copy's flag read ${String(parsed.doc.producer.stamped)}`);
  return parsed.doc;
}

async function importCopy(w: World, d: OrganizerProfileDoc): Promise<void> {
  const read = async (): Promise<ProfileReadResult> => ({ state: "found", doc: d, installId: "the-other-install", ref: 1, residue: 0, generation: 1_000 });
  const r = await profileImportService.apply(w.ctx, w.mailboxId, { fingerprint: profileFingerprint(d) }, { read });
  if ("state" in r) throw new Error(`the press was handed to the organizer: ${JSON.stringify(r)}`);
}

async function approveIntoReceipts(w: World): Promise<void> {
  const svc = new ApprovalService({});
  for (let i = 0; i < GRADUATION_THRESHOLD; i++) {
    const messageId = await seedMessage(w.db as never, w.accountId, w.mailboxId, { from: ADDR, folder: "INBOX", desired: "INBOX" });
    const [rd] = await w.db.insert(routingDecisions).values({
      accountId: w.accountId, messageId, inputProvenance: "ai", destination: RECEIPTS, confidence: 0.6, status: "pending_approval",
    }).returning();
    const [card] = await w.db.insert(approvals).values({
      accountId: w.accountId, kind: "routing", messageId, routingDecisionId: rd!.id, action: "move",
      summary: `Route to ${RECEIPTS}`, payload: { folder: RECEIPTS }, confidence: 0.6, status: "pending",
    }).returning();
    await svc.decide(w.ctx, card!.id, { decision: "approve" });
  }
}

const rowsOf = async (w: World) => (await w.db.select().from(rules)
  .where(and(eq(rules.accountId, w.accountId), eq(rules.kind, "sender"))).orderBy(asc(rules.id)));
const stateOf = async (w: World) => (await rowsOf(w))
  .map((r) => ({ destination: r.destination, provenance: r.provenance, enabled: r.enabled, stamp: r.personDecidedAt?.toISOString() ?? null }));

describe("an older ohmail's settings copy, imported after 0144 ran here", () => {
  it("brings the person's allow as theirs: stamped at the import, still promoted, and three approvals leave it", async () => {
    const w = await world();
    await importCopy(w, copyOf([allow()], { older: true }));
    const mine = [{ destination: "INBOX", provenance: "promoted", enabled: true, stamp: NOW.toISOString() }];
    expect(await stateOf(w), "the allow arrived as ohmail's").toEqual(mine);
    await approveIntoReceipts(w);
    expect(await stateOf(w), "three approvals moved the person's allow").toEqual(mine);
  });

  it.each(["ohmail/News", RECEIPTS])("an allow into %s arrives stamped too", async (destination) => {
    const w = await world();
    await importCopy(w, copyOf([allow({ destination })], { older: true }));
    expect(await stateOf(w)).toEqual([{ destination, provenance: "promoted", enabled: true, stamp: NOW.toISOString() }]);
  });

  it("CONTROL: a copy whose producer states its stamps is taken as written, and the learning still files it", async () => {
    const w = await world();
    await importCopy(w, copyOf([allow()], { older: false }));
    expect(await stateOf(w)).toEqual([{ destination: "INBOX", provenance: "promoted", enabled: true, stamp: null }]);
    await approveIntoReceipts(w);
    expect(await stateOf(w)).toEqual([{ destination: RECEIPTS, provenance: "promoted", enabled: true, stamp: null }]);
  });

  it("CONTROL: a promotion of a sender the copy's Screener does not list stays ohmail's", async () => {
    const w = await world();
    await importCopy(w, copyOf([allow()], { older: true, screener: ["somebody-else@atelier.example"] }));
    expect(await stateOf(w)).toEqual([{ destination: "INBOX", provenance: "promoted", enabled: true, stamp: null }]);
    await approveIntoReceipts(w);
    expect(await stateOf(w)).toEqual([{ destination: RECEIPTS, provenance: "promoted", enabled: true, stamp: null }]);
  });

  it("CONTROL: a HEY import's rule arrives as the import's (migrated, unstamped: the import still owns it)", async () => {
    const w = await world();
    await importCopy(w, copyOf([allow({ provenance: "migrated" })], { older: true }));
    expect(await stateOf(w)).toEqual([{ destination: "INBOX", provenance: "migrated", enabled: true, stamp: null }]);
  });

  it.each(["ohmail/Quarantine", "ohmail/Screened"])("CONTROL: a screen-out into %s arrives unstamped (the stamp licenses unsubscribing)", async (destination) => {
    const w = await world();
    await importCopy(w, copyOf([allow({ destination })], { older: true }));
    expect(await stateOf(w)).toEqual([{ destination, provenance: "promoted", enabled: true, stamp: null }]);
  });

  it("CONTROL: a promotion this store already holds under the key keeps its own row and trail", async () => {
    const w = await world();
    const [local] = await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: ADDR, destination: "INBOX", enabled: true, provenance: "promoted",
    }).returning();
    await importCopy(w, copyOf([allow()], { older: true }));
    const rows = await rowsOf(w);
    expect(rows.map((r) => [r.id, r.personDecidedAt])).toEqual([[local!.id, null]]);
  });

  it("CONTROL: under people_only the arrived rule still sends the sender's automated mail to its pile", async () => {
    const w = await world();
    await importCopy(w, copyOf([allow()], { older: true }));
    const [row] = await rowsOf(w);
    const rule: Rule = {
      id: row!.id, kind: "sender", match: row!.match, destination: row!.destination as Rule["destination"],
      effect: effectForDestination(row!.destination as Rule["destination"]), priority: row!.priority,
      provenance: row!.provenance as Rule["provenance"], enabled: row!.enabled,
      subjectContains: row!.subjectContains, bodyContains: row!.bodyContains,
    };
    const bulk: NormalizedMessage = {
      canonical: { messageIdHeader: null, bodyHash: "x" }, subject: "This week", from: { name: null, address: ADDR }, to: [], cc: [],
      date: null, headers: { "list-id": ["<news.atelier.example>"] }, textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
    };
    const d = evaluateRules({
      msg: bulk, rules: [rule], ownAddresses: new Set(), knownSenders: { addresses: new Set([ADDR]), inferred: new Set<string>(), lists: new Map() },
      auth: "unauthenticated", identity: null, ohboxPolicy: "people_only",
    });
    expect([d.destination, d.source, d.overriddenRuleId]).toEqual(["ohmail/News", "policy", row!.id]);
  });
});

describe("the producer's flag in the settings message", () => {
  const payload = { screener: [{ address: ADDR }], notifyRules: [], awayResponder: null, tagNames: [], signature: null, rules: [allow()] };
  const meta = { updatedAt: new Date("2026-10-06T09:00:00.000Z"), producer: { kind: "local", version: "0.25.18" } };

  it("is written by every copy this build makes and read back, outside the fingerprint", () => {
    const doc = makeProfileDoc(payload, meta);
    expect(doc.producer.stamped).toBe(true);
    const parsed = parseProfileMessage(formatProfileMessage(doc, { installId: "a" }));
    if (parsed === null || isMalformedProfile(parsed) || !("doc" in parsed) || !parsed.doc) throw new Error("expected a readable copy");
    expect(parsed.doc.producer).toEqual({ kind: "local", version: "0.25.18", stamped: true });
    const older = { ...doc, producer: { kind: "local", version: "0.25.16" } };
    expect(profileFingerprint(older)).toBe(profileFingerprint(doc));
  });

  it("reads only the literal true: an absent or other value is an older copy", () => {
    const raw = formatProfileMessage(makeProfileDoc(payload, meta), { installId: "a" });
    for (const [label, text] of [["absent", raw.replace(/,\s*"stamped": true/, "")], ["a string", raw.replace('"stamped": true', '"stamped": "true"')]] as const) {
      expect(text, `${label}: the fixture did not change the message`).not.toBe(raw);
      const parsed = parseProfileMessage(text);
      if (parsed === null || isMalformedProfile(parsed) || !("doc" in parsed) || !parsed.doc) throw new Error(`${label}: expected a readable copy`);
      expect(Object.keys(parsed.doc.producer), label).toEqual(["kind", "version"]);
    }
  });
});
