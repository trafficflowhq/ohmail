import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, applyScreenerDecision, contacts, folderState, listAddresses, mailboxes, messageBodies, messageStates, messages, rules,
  type Tx,
} from "@trafficflow/db";
import { sql } from "drizzle-orm";
import { checkUncheckedById } from "@trafficflow/core/adapters/drizzle-repo";
import {
  DEFAULT_OHBOX_POLICY, asAuthVerdict, evaluateRules, type AuthVerdict, type NormalizedMessage,
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ScreenerService } from "../src/screener-service.js";
import { cutlineCounts } from "../src/consent-cutline.js";
import { heldReleaseGroups, heldReleaseSenders, releaseHeld } from "../src/held-release-service.js";
import type { ServiceContext } from "../src/context.js";

/**
 * A DECIDED SENDER WHOSE CLAIM THE GATE HOLDS IS WAITING AGAIN (mail 0148, the twin readers of the
 * act's narrowed consent): the act admitted the sender (a promoted rule, an inferred contact), and
 * their next mail, naming PostFinance, sits at the gate with the fact. The queue lists them with
 * the sentence; neither release (the rule group, the contact line) offers the claim. CONTROL: the
 * same decided sender's held mail without the fact is the release's, and the queue does not list it.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const SENDER = "kundendienst@karten-service.test";

async function world(o: { claim: boolean; rule: boolean }) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `hc-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
  }).returning();
  const at = new Date("2026-10-06T09:00:00.000Z");
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `hc:${randomUUID()}`,
    subject: "Ihre Karte", snippet: "", fromAddress: SENDER, fromName: o.claim ? "PostFinance" : "Anna Meier",
    senderCheck: o.claim ? "impersonation" : "none", senderCheckBrand: o.claim ? "PostFinance" : null,
    date: at, unread: true, createdAt: at, nativeLocator: { folder: GATE, ref: "1:1" },
  }).returning();
  await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  // What the act leaves behind when it admits a sender: its promoted rule and an inferred contact.
  if (o.rule) {
    await db.insert(rules).values({
      accountId, kind: "sender", match: SENDER, destination: "INBOX", enabled: true, priority: 0, provenance: "promoted",
    });
  }
  await db.insert(contacts).values({ accountId, address: SENDER, source: "inferred" });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `hc-${randomUUID().slice(0, 8)}` };
  return { db: db as unknown as Tx, accountId, ctx };
}

const listed = async (w: Awaited<ReturnType<typeof world>>) =>
  (await new ScreenerService({}).list(w.ctx, { limit: 50 })).items.map((i) => ({ address: i.sender.address, checked: i.checked }));

describe("the gate's held claim makes a decided sender waiting again", () => {
  it("the act-admitted sender's held claim is listed, with the fact; no release offers it", async () => {
    const w = await world({ claim: true, rule: true });
    expect(await listed(w)).toEqual([
      { address: SENDER, checked: { reason: "impersonation", brand: "PostFinance", domainShared: false } },
    ]);
    expect(await heldReleaseGroups(w.db, w.accountId)).toEqual([]);
  });

  it("an inferred contact alone: the held claim is listed, and the contact line does not offer it", async () => {
    const w = await world({ claim: true, rule: false });
    expect((await listed(w)).map((i) => i.address)).toEqual([SENDER]);
    expect(await heldReleaseSenders(w.db, w.accountId)).toEqual([]);
  });

  it("CONTROL: the same decided sender's held mail without the fact is the release's, not the queue's", async () => {
    const ruled = await world({ claim: false, rule: true });
    expect(await listed(ruled)).toEqual([]);
    expect((await heldReleaseGroups(ruled.db, ruled.accountId)).map((g) => g.match)).toEqual([SENDER]);
    const contact = await world({ claim: false, rule: false });
    expect(await listed(contact)).toEqual([]);
    expect((await heldReleaseSenders(contact.db, contact.accountId)).map((g) => g.sender)).toEqual([SENDER]);
  });
});

/**
 * A SENDER A PERSON CONSENTED TO AT THE ADDRESS IS NOT WAITING OVER A HELD CLAIM (FIX-026): the gate
 * holds nothing of theirs (`rules.ts#addressLevelConsent`), so a claim held before the consent is no
 * reason to list them, and the list, the count and the gate's own answer over the same rows agree.
 * CONTROLS: inference is no such consent (an inferred contact, a promoted rule, a person's DOMAIN rule,
 * a disabled rule), and the claim stays listed while the gate goes on holding the next one.
 */
type Consent =
  | { contact: string; source: "person" | "inferred" | null }
  | { rule: { kind: "sender" | "domain"; match: string; provenance: string; destination?: string; enabled?: boolean } }
  | { list: string; brands: readonly string[] };

async function consented(cs: readonly Consent[], o: { date?: Date; auth?: string | null } = {}) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `pc-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`, organizerRole: "organizer",
    ...(o.date ? { initialImportCompletedAt: new Date("2026-01-01T00:00:00.000Z") } : {}),
  }).returning();
  // Held before the consent, then stamped by the identity check: inside the cutline by its arrival.
  // With an old `date` the server received it then too, and only the fact, written at ingest after the
  // first import, is inside the cutline: a held letter is dated by its arrival.
  const at = new Date("2026-10-06T09:00:00.000Z");
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `pc:${randomUUID()}`,
    subject: "Ihre Karte", snippet: "", fromAddress: SENDER, fromName: "PostFinance",
    senderCheck: "impersonation", senderCheckBrand: "PostFinance", authVerdict: o.auth ?? null,
    date: o.date ?? at, arrivedAt: o.date ?? at, unread: false, createdAt: at, nativeLocator: { folder: GATE, ref: "1:1" },
    ...(o.date ? { senderCheckBy: "ingest" } : {}),
  }).returning();
  await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  for (const c of cs) {
    if ("list" in c) await db.insert(listAddresses).values({ accountId, address: c.list, consentedBrands: [...c.brands] });
    else if ("contact" in c) await db.insert(contacts).values({ accountId, address: c.contact, source: c.source });
    else await db.insert(rules).values({
      accountId, kind: c.rule.kind, match: c.rule.match, destination: c.rule.destination ?? "INBOX",
      enabled: c.rule.enabled ?? true, priority: 0, provenance: c.rule.provenance,
    });
  }
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `pc-${randomUUID().slice(0, 8)}` };
  return { db: db as unknown as Tx, accountId, ctx, claimId: m!.id, mailboxId: mb!.id };
}

/** The gate's own answer for the sender's NEXT claim, over the same rows and with this verdict: is it held? */
async function gateHolds(w: Awaited<ReturnType<typeof consented>>, auth: AuthVerdict = "unavailable"): Promise<boolean> {
  const repo = makeDrizzleRepo(w.db as unknown as Parameters<typeof makeDrizzleRepo>[0]);
  const msg: NormalizedMessage = {
    canonical: { messageIdHeader: null, bodyHash: "" }, subject: "Ihre Karte",
    from: { name: "PostFinance", address: SENDER }, to: [], cc: [], date: null, headers: {},
    textBody: "", htmlBody: null, hasAttachments: false, attachments: [],
  };
  return evaluateRules({
    msg, rules: await repo.listRules(w.accountId), knownSenders: await repo.knownSenders(w.accountId),
    ownAddresses: new Set<string>(), auth, ohboxPolicy: DEFAULT_OHBOX_POLICY,
    identity: { brand: "PostFinance", via: "name" },
  }).source === "screener";
}

const waiting = async (w: Awaited<ReturnType<typeof consented>>) =>
  (await new ScreenerService({}).list(w.ctx, { limit: 50 })).items.map((i) => i.sender.address);

describe("a person's consent to the address outranks a held claim, as at the gate", () => {
  const PERSON: ReadonlyArray<[string, readonly Consent[]]> = [
    ["a person's contact", [{ contact: SENDER, source: "person" }]],
    ["a contact older than the source column", [{ contact: SENDER, source: null }]],
    ["a person's row beside an inferred twin", [{ contact: SENDER.toUpperCase(), source: "person" }, { contact: SENDER, source: "inferred" }]],
    ["a rule the person typed", [{ rule: { kind: "sender", match: ` ${SENDER.toUpperCase()} `, provenance: "manual" } }]],
    ["an imported rule", [{ rule: { kind: "sender", match: SENDER, provenance: "migrated", destination: "ohmail/News" } }]],
    ["the Sent seed", [{ rule: { kind: "sender", match: SENDER, provenance: "seeded-from-sent", destination: "ohmail/Receipts" } }]],
  ];
  for (const [what, cs] of PERSON) {
    it(`${what}: not listed, not counted, and the gate does not hold the next claim`, async () => {
      const w = await consented(cs);
      expect(await waiting(w)).toEqual([]);
      const counts = await cutlineCounts(w.ctx, {});
      expect(counts.activeUndecidedSenders).toBe(0);
      expect(await gateHolds(w)).toBe(false);
    });
    it(`${what}, AUTHENTICATION FAILED: the gate holds it, so it is listed and no release offers it`, async () => {
      const w = await consented(cs, { auth: "fail" });
      expect(await gateHolds(w, "fail")).toBe(true);
      expect(await waiting(w)).toEqual([SENDER]);
      expect(await heldReleaseSenders(w.db, w.accountId)).toEqual([]);
      expect(await heldReleaseGroups(w.db, w.accountId)).toEqual([]);
    });
  }

  const INFERENCE: ReadonlyArray<[string, readonly Consent[]]> = [
    ["an inferred contact", [{ contact: SENDER, source: "inferred" }]],
    ["a promoted rule", [{ rule: { kind: "sender", match: SENDER, provenance: "promoted" } }]],
    ["a person's domain rule", [{ rule: { kind: "domain", match: "karten-service.test", provenance: "manual" } }]],
    ["a disabled rule beside an inferred contact", [
      { rule: { kind: "sender", match: SENDER, provenance: "manual", enabled: false } }, { contact: SENDER, source: "inferred" },
    ]],
  ];
  for (const [what, cs] of INFERENCE) {
    it(`CONTROL, ${what}: the claim is listed and the gate holds the next one`, async () => {
      const w = await consented(cs);
      expect(await waiting(w)).toEqual([SENDER]);
      expect(await gateHolds(w)).toBe(true);
    });
  }

  it("the release offer takes the same skip: a person's contact's claim is offered, and its press moves it", async () => {
    const w = await consented([{ contact: SENDER, source: "person" }]);
    expect(await heldReleaseSenders(w.db, w.accountId)).toEqual([{ sender: SENDER, count: 1 }]);
    const r = await releaseHeld(w.ctx, { senders: [SENDER] });
    expect(r.total).toBe(1);
    const [row] = await w.db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, w.claimId));
    expect(row!.d).toBe("INBOX");
  });

  it("…and a person's address rule's group offers the claim; inference's does not", async () => {
    const person = await consented([{ rule: { kind: "sender", match: SENDER, provenance: "manual" } }]);
    expect((await heldReleaseGroups(person.db, person.accountId)).map((g) => [g.match, g.count])).toEqual([[SENDER, 1]]);
    const promoted = await consented([{ rule: { kind: "sender", match: SENDER, provenance: "promoted" } }]);
    expect(await heldReleaseGroups(promoted.db, promoted.accountId)).toEqual([]);
    const inferred = await consented([{ contact: SENDER, source: "inferred" }]);
    expect(await heldReleaseSenders(inferred.db, inferred.accountId)).toEqual([]);
  });

  it("the COUNT asks the list's question for a person's contact the person pinned to the gate", async () => {
    // Undecided (the pin defeats the contact) and dated years back by its header: only the claim
    // could make them active, and a person's consent takes that away from the list and the count alike.
    const w = await consented([
      { contact: SENDER, source: "person" },
      { rule: { kind: "sender", match: SENDER, provenance: "manual", destination: GATE } },
    ], { date: new Date("2020-01-06T09:00:00.000Z") });
    expect(await waiting(w)).toEqual([]);
    expect(await cutlineCounts(w.ctx, {})).toMatchObject({ activeUndecidedSenders: 0, dormantUndecidedSenders: 1 });
  });
});

/**
 * A LIST ADDRESS ANSWERS ALONE, AS AT THE GATE (mail 0150): the person's post made a contact and the
 * Sent seed a rule, and neither consents a company's name there; only a brand a press consented under
 * the address does. The list, the count, both release offers and the gate's next answer agree.
 */
describe("a list address's held claim waits whatever the person's post made of the address", () => {
  const LISTED: ReadonlyArray<[string, readonly Consent[]]> = [
    ["a person's contact", [{ contact: SENDER, source: "person" }]],
    ["the Sent seed", [{ rule: { kind: "sender", match: SENDER, provenance: "seeded-from-sent", destination: "ohmail/Receipts" } }]],
    ["a rule the person typed", [{ rule: { kind: "sender", match: SENDER, provenance: "manual" } }]],
  ];
  for (const [what, cs] of LISTED) {
    it(`${what}, the address a list's: listed, counted, the gate holds the next claim, no release offers it`, async () => {
      const w = await consented([...cs, { list: SENDER, brands: [] }]);
      expect(await waiting(w)).toEqual([SENDER]);
      expect((await cutlineCounts(w.ctx, {})).activeUndecidedSenders).toBe(1);
      expect(await gateHolds(w)).toBe(true);
      expect(await heldReleaseSenders(w.db, w.accountId)).toEqual([]);
      expect(await heldReleaseGroups(w.db, w.accountId)).toEqual([]);
    });
  }

  it("CONTROL: the brand a press consented under the list address is skipped as a person's consent is", async () => {
    const w = await consented([{ contact: SENDER, source: "person" }, { list: SENDER, brands: ["PostFinance"] }]);
    expect(await waiting(w)).toEqual([]);
    expect((await cutlineCounts(w.ctx, {})).activeUndecidedSenders).toBe(0);
    expect(await gateHolds(w)).toBe(false);
    expect(await heldReleaseSenders(w.db, w.accountId)).toEqual([{ sender: SENDER, count: 1 }]);
  });

  it("CONTROL: the COUNT asks the same brand question: a consented brand's old claim leaves its sender dormant", async () => {
    // Undecided (no rule, no contact) and dated years back by its header: only the claim could make
    // them active, and the brand a press consented under the list address takes that away from both.
    const w = await consented([{ list: SENDER, brands: ["PostFinance"] }], { date: new Date("2020-01-06T09:00:00.000Z") });
    expect(await waiting(w)).toEqual([]);
    expect(await cutlineCounts(w.ctx, {})).toMatchObject({ activeUndecidedSenders: 0, dormantUndecidedSenders: 1 });
  });

  it("CONTROL: another brand consented there is no consent for this one", async () => {
    const w = await consented([{ contact: SENDER, source: "person" }, { list: SENDER, brands: ["Swisscom"] }]);
    expect(await waiting(w)).toEqual([SENDER]);
    expect(await gateHolds(w)).toBe(true);
    expect(await heldReleaseSenders(w.db, w.accountId)).toEqual([]);
  });
});

/**
 * THE PERSON SKIP YIELDS ONLY WHERE THE GATE WOULD NOT HOLD THE ROW NOW (REVIEW-026 HIGH-1). Over every
 * value a stored verdict takes — the routing vocabulary (a `Record` over the type, so a new member
 * cannot be left out), absent, and a word of the identity check's own vocabulary — the list, the count,
 * the release offer and its press each give the gate's answer for a person's contact's claim carrying
 * it, in both directions. The census must meet both answers, or it measured one side only.
 */
const ROUTING_VERDICTS: Record<AuthVerdict, true> = { unauthenticated: true, unavailable: true, pass: true, fail: true };
const STORED_VERDICTS: ReadonlyArray<string | null> = [...Object.keys(ROUTING_VERDICTS), null, "temperror"];

describe("the person skip over every stored authentication verdict, both ways", () => {
  const answers = new Set<boolean>();
  for (const v of STORED_VERDICTS) {
    it(`stored ${v ?? "NULL"}: the list, the count, the offer and the press give the gate's answer`, async () => {
      const w = await consented([{ contact: SENDER, source: "person" }], { auth: v });
      const holds = await gateHolds(w, asAuthVerdict(v) ?? "unauthenticated");
      answers.add(holds);
      expect(await waiting(w), "the list").toEqual(holds ? [SENDER] : []);
      expect((await heldReleaseSenders(w.db, w.accountId)).map((g) => g.sender), "the offer").toEqual(holds ? [] : [SENDER]);
      const press = await releaseHeld(w.ctx, { senders: [SENDER] });
      const [row] = await w.db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, w.claimId));
      expect([press.total, row!.d], "the press").toEqual(holds ? [0, GATE] : [1, "INBOX"]);
      // The count, for the same contact pinned to the gate: undecided and dated years back, so only the claim counts.
      const pinned = await consented([
        { contact: SENDER, source: "person" },
        { rule: { kind: "sender", match: SENDER, provenance: "manual", destination: GATE } },
      ], { auth: v, date: new Date("2020-01-06T09:00:00.000Z") });
      expect((await cutlineCounts(pinned.ctx, {})).activeUndecidedSenders, "the count").toBe(holds ? 1 : 0);
    });
  }
  it("the census met both answers", () => {
    expect([...answers].sort()).toEqual([false, true]);
  });
});

/**
 * THE CONTACT PRESS MOVES EXACTLY WHAT ITS OFFER COUNTED (REVIEW-026 LOW 1): one bag for both
 * (`contactLineBag`). Beside the two rows the offer counts, a person's contact has five it leaves out —
 * a placement by a writer the offer does not know (a hand screening), a row in flight, one the person
 * set aside, a claim whose authentication failed, and an unchecked row the press's own check finds to
 * be such a claim. The press moves the two and reports two.
 */
describe("the contact line's press and its offer read one bag", () => {
  it("only the counted rows move, and the press reports what it moved", async () => {
    const w = await consented([{ contact: SENDER, source: "person" }]);
    const at = new Date("2026-10-06T10:00:00.000Z");
    const add = async (o: { name: string; check: "none" | "impersonation" | null; lastSetBy?: string; observed?: string; auth?: string; decidedAt?: Date }) => {
      const [m] = await w.db.insert(messages).values({
        accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h", dedupKey: `lo:${randomUUID()}`,
        subject: "Ihre Karte", snippet: "", fromAddress: SENDER, fromName: o.name,
        senderCheck: o.check, senderCheckBrand: o.check === "impersonation" ? "PostFinance" : null, authVerdict: o.auth ?? null,
        date: at, arrivedAt: at, unread: true, createdAt: at, nativeLocator: { folder: GATE, ref: `1:${randomUUID()}` },
      } as never).returning();
      await w.db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
      await w.db.insert(folderState).values({
        messageId: m!.id, desiredFolder: GATE, observedFolder: o.observed ?? GATE, lastSetBy: o.lastSetBy ?? "us",
        reconcileStatus: "reconciled", conflict: false, decidedAt: o.decidedAt ?? null,
      } as never);
      return m!.id as string;
    };
    const plain = await add({ name: "Anna Meier", check: "none" });
    const left = {
      // A hand screening as production records it: a move adopted from another client, with its bound.
      byHand: await add({ name: "Anna Meier", check: "none", lastSetBy: "external", decidedAt: at }),
      inFlight: await add({ name: "Anna Meier", check: "none", observed: "INBOX" }),
      setAside: await add({ name: "Anna Meier", check: "none" }),
      failed: await add({ name: "PostFinance", check: "impersonation", auth: "fail" }),
      uncheckedFailed: await add({ name: "PostFinance", check: null, auth: "fail" }),
    };
    await w.db.insert(messageStates).values({ accountId: w.accountId, messageId: left.setAside, state: "set_aside" });
    const where = async (id: string) =>
      (await w.db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
    // The offer leaves out every row that failed authentication (`contactOnlyHeldWhere`), the unchecked one
    // included, so it counts what the press moves: the claim and the plain row.
    expect(await heldReleaseSenders(w.db, w.accountId)).toEqual([{ sender: SENDER, count: 2 }]);
    const press = await releaseHeld(w.ctx, { senders: [SENDER] });
    expect(press.total).toBe(2);
    expect([await where(w.claimId), await where(plain)]).toEqual(["INBOX", "INBOX"]);
    for (const [what, id] of Object.entries(left)) expect(await where(id), what).toBe(GATE);
  });

  it("the door asks a caller's bag again over the facts its own check wrote", async () => {
    // A caller whose bag admits no claim, and a row nobody checked that the check finds to be one.
    const w = await consented([{ contact: SENDER, source: "person" }]);
    await w.db.update(messages).set({ senderCheck: null, senderCheckBrand: null }).where(eq(messages.id, w.claimId));
    const r = await w.db.transaction((tx) => applyScreenerDecision(tx as unknown as Tx, {
      accountId: w.accountId, scope: "sender", address: SENDER, appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `door:${randomUUID()}`, now: NOW, stampBaseline: false, decidedBy: "person", overExisting: "converge",
      within: sql`(${messages.senderCheck} is null or ${messages.senderCheck} <> 'impersonation')`, checkUnchecked: checkUncheckedById,
    }));
    const [row] = await w.db.select({ d: folderState.desiredFolder, c: messages.senderCheck }).from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId)).where(eq(folderState.messageId, w.claimId));
    expect([r.rerouted.length, row!.c, row!.d]).toEqual([0, "impersonation", GATE]);
  });
});
