import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, applyMessageMove, applyScreenerDecision, contactNotes, contacts, folderState, idempotencyKeys, learningSignals,
  listAddresses, listBrandsOf, mailboxFolders, mailboxes, messageBodies, messageInstances, messages, organizerRequests,
  routingDecisions, rules, SCREENER_SUGGESTION_PROVENANCE, SCREENER_SUGGESTION_STATUS, validateMovePayload, type Tx,
} from "@trafficflow/db";
import { carryDialect } from "@trafficflow/db/dialect";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { claimedIdentity, evaluateRules, listPostAddresses, normalizeMime } from "@trafficflow/core/mail";
import { ScreenerService } from "../src/screener-service.js";
import { materializeMessages } from "../src/dto/materialize.js";
import { resetScreeningState } from "../src/consent-reset.js";
import { heldReleaseSenders, releaseHeld } from "../src/held-release-service.js";
import type { ServiceContext } from "../src/context.js";
import { ruleRetroPass } from "../../../apps/worker/src/rule-retro.js";
import { readerDoorListClaim, readerDoorWorld } from "./helpers/list-claim-reader-door.js";

/**
 * A LIST ADDRESS ON THE SCREENER (mail 0150). The person wrote to `list@` and to a friend, and both
 * have a company claim held. The friend is somebody they wrote to: the row says so and the advice
 * stays theirs. `list@` is an address a mailing list posts as: the row carries the list sentence,
 * the claim's own fact decides the reason, and the advice bought on it is capped — never "You wrote
 * first" at the Ohbox. The mirror carries the same fact on the message. A consent reset forgets
 * the brands a press consented there and keeps the row. On whichever store the project runs.
 */
const GATE = "ohmail/Screener";
const NOW = new Date("2026-10-07T12:00:00.000Z");
const CONNECT = new Date("2026-09-01T08:00:00.000Z");
const WROTE = new Date("2026-09-22T15:12:00.000Z");
const LIST = "list@lists.invalid";
const FRIEND = "friend@corr.invalid";

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `lst-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const me = `me-${accountId.slice(0, 8)}@own.invalid`;
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: me, status: "connected", organizerRole: "organizer", createdAt: CONNECT,
  }).returning();
  await db.insert(mailboxFolders).values({ mailboxId: mb!.id, folder: "Sent", uidvalidity: 7n, uidnext: 100n });
  let uid = 0;
  const sentTo = async (to: string, source: "person" | "inferred" = "person") => {
    uid += 1;
    const [s] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `sent:${randomUUID()}`, subject: "Spring meeting",
      fromAddress: me, messageIdHeader: `post-${uid}@own.invalid`, date: WROTE, arrivedAt: WROTE,
      toAddresses: [{ name: null, address: to }], ccAddresses: [], nativeLocator: { folder: "Sent", ref: `7:${uid}` },
    }).returning();
    await db.insert(messageInstances).values({
      accountId, mailboxId: mb!.id, messageId: s!.id, folder: "Sent", uidvalidity: 7n, uid, isPrimary: true,
    });
    await db.insert(folderState).values({
      messageId: s!.id, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(messageBodies).values({ messageId: s!.id, text: "hi", headers: {} });
    await db.insert(contacts).values({ accountId, address: to, source });
  };
  await sentTo(LIST);
  // `inferred`: a person's contact's held claim is not waiting at all (the person skip), so the
  // correspondent the control reads is one the account wrote to without that consent.
  await sentTo(FRIEND, "inferred");
  await db.insert(listAddresses).values({ accountId, address: LIST, consentedBrands: ["Swisscom"] });
  /** A company claim from `from`, held at the gate, with an "Ohbox" suggestion bought on it. */
  const heldClaim = async (from: string) => {
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: `lst:${randomUUID()}`, subject: "Ihre Karte",
      snippet: "", fromAddress: from, fromName: "PostFinance", senderCheck: "impersonation", senderCheckBrand: "PostFinance",
      date: NOW, unread: true, createdAt: NOW, nativeLocator: { folder: GATE, ref: `1:${randomUUID().slice(0, 6)}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(routingDecisions).values({
      accountId, messageId: m!.id, inputProvenance: SCREENER_SUGGESTION_PROVENANCE, destination: "INBOX",
      confidence: 0.95, rationale: "a bank", spam: false, status: SCREENER_SUGGESTION_STATUS,
    } as never);
    return m!.id;
  };
  /** A newer held message from `from` claiming nothing, with an "Ohbox" suggestion bought on it. */
  const heldPlain = async (from: string) => {
    const at = new Date(NOW.getTime() + 60_000);
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: randomUUID(), dedupKey: `lst:${randomUUID()}`, subject: "Agenda",
      snippet: "", fromAddress: from, fromName: "The Lists", senderCheck: "none", date: at, unread: true, createdAt: at,
      nativeLocator: { folder: GATE, ref: `1:${randomUUID().slice(0, 6)}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(routingDecisions).values({
      accountId, messageId: m!.id, inputProvenance: SCREENER_SUGGESTION_PROVENANCE, destination: "INBOX",
      confidence: 0.95, rationale: "a list", spam: false, status: SCREENER_SUGGESTION_STATUS,
    } as never);
    return m!.id;
  };
  const ctx: ServiceContext = {
    db: db as never, accountId, userId: null, now: () => NOW, requestId: `lst-${randomUUID().slice(0, 8)}`,
  };
  const brandsOf = async (address: string) => {
    const [r] = await db.select({ b: listAddresses.consentedBrands }).from(listAddresses)
      .where(and(eq(listAddresses.accountId, accountId), eq(listAddresses.address, address)));
    return r === undefined ? null : listBrandsOf(r.b);
  };
  return { db, accountId, ctx, heldClaim, heldPlain, brandsOf };
}

describe("a list address on the Screener", () => {
  it("ACCEPTANCE 1k: the row carries the list sentence and the claim's fact caps the advice", async () => {
    const w = await world();
    const id = await w.heldClaim(LIST);
    const { items } = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    const item = items.find((i) => i.messageId === id)!;
    // The person wrote to the list (their contact), so its screen-out sets the claim aside alone.
    expect(item.checked).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: false, list: true, claimsOnly: true });
    expect(item.aiSuggestion).toMatchObject({ reasonCode: "impersonation", reasonBrand: "PostFinance" });
    expect(item.aiSuggestion!.decision, "\"You wrote first\" at the Ohbox for a list address").not.toBe("yes");
  });

  it("ACCEPTANCE 1k: an older claim in a list address's held mail caps advice bought on a newer plain message", async () => {
    const w = await world();
    await w.heldClaim(LIST);
    const plain = await w.heldPlain(LIST);
    const { items } = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    const item = items.find((i) => i.messageId === plain)!;
    expect(item.checked).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: false, list: true, claimsOnly: true });
    expect(item.aiSuggestion!.reasonCode, "\"You wrote first\" over a list address's claim").toBe("impersonation");
    expect(item.aiSuggestion!.decision).not.toBe("yes");
  });

  it("CONTROL: a person this account wrote to keeps the correspondent reading and carries no list sentence", async () => {
    const w = await world();
    const id = await w.heldClaim(FRIEND);
    const { items } = await new ScreenerService({}).list(w.ctx, { limit: 50 });
    const item = items.find((i) => i.messageId === id)!;
    expect(item.checked).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: false });
    expect(item.aiSuggestion).toMatchObject({ reasonCode: "correspondent" });
  });

  it("ACCEPTANCE 1k: the mirror's message carries the list fact beside the claim, and only there", async () => {
    const w = await world();
    const listed = await w.heldClaim(LIST);
    const friend = await w.heldClaim(FRIEND);
    const dtos = await materializeMessages(w.db as never, w.accountId, [listed, friend]);
    expect(dtos.get(listed)!.senderCheck).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: false, list: true });
    expect(dtos.get(friend)!.senderCheck).toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: false });
  });
});

describe("a consent reset and a list address", () => {
  it("ACCEPTANCE 1h: the reset forgets the brands and keeps the row, so the next claim is held", async () => {
    const w = await world();
    expect(await w.brandsOf(LIST)).toEqual(["Swisscom"]);
    await resetScreeningState(w.ctx);
    expect(await w.brandsOf(LIST), "the row is the mailbox's fact; the brands were presses").toEqual([]);
    const known = await makeDrizzleRepo(w.db as never).knownSenders(w.accountId);
    const msg = await normalizeMime(Buffer.from([
      "Message-ID: <after-reset@lists.invalid>", `From: "Swisscom" <${LIST}>`, "To: me@own.invalid",
      "Subject: Rechnung", "Content-Type: text/plain; charset=utf-8", "", "x",
    ].join("\r\n")));
    const d = evaluateRules({
      msg, rules: [], knownSenders: { ...known, addresses: new Set([...known.addresses, LIST]) }, auth: "unauthenticated",
      ohboxPolicy: "people_and_replied", ownAddresses: new Set(),
      identity: claimedIdentity({ fromName: msg.from.name, fromAddress: msg.from.address, subject: msg.subject }) ?? null,
    });
    expect(d.destination).toBe(GATE);
  });
});

/**
 * A PRESS CONSENTS ONLY THE BRANDS OF THE CLAIMS IT MOVES (HAND BACK 1): the held-release offer's
 * press over a list address moves what its offer counted, the list's ordinary post, and neither moves
 * nor consents the claim the person was never shown; the next forgery still waits. A person's own NO
 * consents nothing, and a moved claim that failed authentication consents no brand.
 */
async function pressWorld(contactSource: "person" | "inferred" | null, list = LIST) {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `lpr-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@own.invalid`, organizerRole: "organizer",
  }).returning();
  let n = 0;
  const held = async (
    name: string, brand: string | null, placedBy: "us" | "peer", auth: string | null = null, mailboxId = mb!.id,
  ) => {
    n += 1;
    const at = new Date(`2026-10-06T0${n}:00:00.000Z`);
    const [m] = await db.insert(messages).values({
      accountId, mailboxId, bodyHash: "h", dedupKey: `lpr:${randomUUID()}`, subject: `m${n}`, snippet: "",
      fromAddress: list, fromName: name, authVerdict: auth, senderCheck: brand === null ? "none" : "impersonation",
      senderCheckBrand: brand, date: at, unread: true, createdAt: at, nativeLocator: { folder: GATE, ref: `1:${n}` },
    }).returning();
    await db.insert(messageBodies).values({ messageId: m!.id, text: "", html: null, headers: {} });
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: GATE, observedFolder: GATE, lastSetBy: placedBy, reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };
  if (contactSource !== null) await db.insert(contacts).values({ accountId, address: list, source: contactSource });
  await db.insert(listAddresses).values({ accountId, address: list, consentedBrands: [] });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => NOW, requestId: `lpr-${randomUUID().slice(0, 8)}` };
  const desired = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  const brands = async () => listBrandsOf((await db.select({ b: listAddresses.consentedBrands }).from(listAddresses)
    .where(and(eq(listAddresses.accountId, accountId), eq(listAddresses.address, list))))[0]?.b);
  const nextClaimHeld = async () => {
    const known = await makeDrizzleRepo(db as never).knownSenders(accountId);
    const msg = await normalizeMime(Buffer.from([
      "Message-ID: <next@lists.invalid>", `From: "PostFinance" <${list}>`, "To: me@own.invalid",
      "Subject: Konto", "Content-Type: text/plain; charset=utf-8", "", "x",
    ].join("\r\n")));
    return evaluateRules({
      msg, rules: [], knownSenders: known, auth: "unauthenticated", ohboxPolicy: "people_and_replied", ownAddresses: new Set(),
      identity: claimedIdentity({ fromName: msg.from.name, fromAddress: msg.from.address, subject: msg.subject }) ?? null,
    }).destination === GATE;
  };
  const press = (decision: "yes" | "no") => (db as unknown as { transaction: <T>(f: (tx: unknown) => Promise<T>) => Promise<T> })
    .transaction((tx) => applyScreenerDecision(carryDialect(db as never, tx as object) as Tx, {
      accountId, scope: "sender", address: list, appliedFolder: decision === "yes" ? "INBOX" : "ohmail/Screened", decision,
      triggeringActionId: `screener:${randomUUID()}`, now: NOW, overExisting: "converge", decidedBy: "person",
    }));
  const listRules = async () => db.select().from(rules).where(and(eq(rules.accountId, accountId), eq(rules.match, list)));
  return { db, accountId, mailboxId: mb!.id, ctx, held, desired, brands, nextClaimHeld, press, listRules };
}

describe("a press over a list address consents only what it moves", () => {
  for (const source of ["person", "inferred"] as const) {
    for (const placedBy of ["peer", "us"] as const) {
      it(`the release offer's press, ${source} contact, post placed by ${placedBy}: moves the post, never the claim it did not show`, async () => {
        const w = await pressWorld(source);
        const post = await w.held("The List", null, placedBy);
        const forged = await w.held("PostFinance", "PostFinance", "us");
        expect(await heldReleaseSenders(w.db as never, w.accountId)).toEqual([{ sender: LIST, count: 1 }]);
        const r = await releaseHeld(w.ctx, { senders: [LIST] });
        expect([r.total, await w.desired(post)]).toEqual([1, "INBOX"]);
        expect(await w.desired(forged), "the offer never counted the claim").toBe(GATE);
        expect(await w.brands(), "a press that never showed the claim consents no brand").toEqual([]);
        expect(await w.nextClaimHeld(), "the next forgery still waits").toBe(true);
      });
    }
  }

  it("a person's NO over a list address's claim consents nothing", async () => {
    const w = await pressWorld("person");
    const forged = await w.held("PostFinance", "PostFinance", "us");
    await w.press("no");
    expect(await w.desired(forged)).toBe("ohmail/Screened");
    expect(await w.brands()).toEqual([]);
  });

  it("a moved claim that failed authentication consents no brand; CONTROL: the press moves it", async () => {
    const w = await pressWorld("person");
    const failed = await w.held("PostFinance", "PostFinance", "us", "fail");
    await w.press("yes");
    expect(await w.desired(failed)).toBe("INBOX");
    expect(await w.brands()).toEqual([]);
  });
});

/**
 * A SCREEN-OUT OF A LIST ADDRESS'S CLAIM DENIES THAT LETTER ONLY. Anyone on the list can write as its
 * address, so a person's no on a forgery there files the claims and nothing else: the list's rule
 * keeps its destination, priority, switch, stamps and retro, the list's letter and the next one stay
 * in News, no learning signal is written and no unsubscribe is asked. On whichever store runs.
 */
async function listWithItsRule() {
  const w = await pressWorld("person");
  const [mb] = await w.db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.accountId, w.accountId));
  const stamp = new Date("2026-09-30T08:00:00.000Z");
  await w.db.insert(rules).values({
    accountId: w.accountId, kind: "sender", match: LIST, destination: "ohmail/News", enabled: true, priority: 3,
    provenance: "manual", personDecidedAt: stamp, retroRequestedAt: stamp, retroDoneAt: stamp,
  });
  const [post] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `lst:${randomUUID()}`, subject: "Agenda",
    snippet: "", fromAddress: LIST, fromName: "The Lists", senderCheck: "none", date: stamp, createdAt: stamp,
    nativeLocator: { folder: "ohmail/News", ref: "1:900" },
  }).returning();
  await w.db.insert(folderState).values({
    messageId: post!.id, desiredFolder: "ohmail/News", observedFolder: "ohmail/News", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  const unsubscribed: string[][] = [];
  const svc = new ScreenerService({ unsubscribe: { onScreenOut: async (_ctx, ids) => { unsubscribed.push(ids); return { considered: ids.length }; } } });
  const listRule = async () => (await w.db.select().from(rules).where(and(eq(rules.accountId, w.accountId), eq(rules.match, LIST))));
  const signals = async () => w.db.select().from(learningSignals).where(eq(learningSignals.accountId, w.accountId));
  /** Where the list's NEXT ordinary letter goes, by the rules and contacts as they stand. */
  const nextListLetter = async () => {
    const repo = makeDrizzleRepo(w.db as never);
    const msg = await normalizeMime(Buffer.from([
      "Message-ID: <next-post@lists.invalid>", `From: "The Lists" <${LIST}>`, "To: me@own.invalid",
      "Subject: Next meeting", "Content-Type: text/plain; charset=utf-8", "", "x",
    ].join("\r\n")));
    return evaluateRules({
      msg, rules: await repo.listRules(w.accountId), knownSenders: await repo.knownSenders(w.accountId), auth: "pass",
      ohboxPolicy: "people_and_replied", ownAddresses: new Set(), identity: null,
    }).destination;
  };
  return { ...w, post: post!.id, svc, unsubscribed, listRule, signals, nextListLetter };
}

describe("a person's screen-out of a claim through a list address", () => {
  it("files the claim alone: the list's rule, its letters, its learning and its subscription are untouched", async () => {
    const w = await listWithItsRule();
    const claim = await w.held("PostFinance", "PostFinance", "us");
    const before = await w.listRule();
    // The row says so before the press: the surfaces key their sentences on it.
    const page = await w.svc.list(w.ctx, { limit: 50, live: true });
    expect(page.items.find((i) => i.messageId === claim)?.checked).toMatchObject({ list: true, claimsOnly: true });
    const r = await w.svc.decide(w.ctx, claim, { decision: "no", scope: "sender" }, { idempotency: { key: "lst-no", requestHash: "h" } });
    expect(r).toMatchObject({ createdRuleId: null, createdRule: null, appliedFolder: "ohmail/Screened" });
    expect(await w.desired(claim)).toBe("ohmail/Screened");
    expect(await w.listRule(), "the list's rule moved").toEqual(before);
    await ruleRetroPass(w.db as never, { accountId: w.accountId, trustedAuthservIdsFor: async () => new Set<string>() }, NOW);
    expect(await w.desired(w.post), "the list's own letter left News").toBe("ohmail/News");
    expect(await w.nextListLetter(), "the list's next letter").toBe("ohmail/News");
    expect(await w.signals(), "a forgery taught the list's address").toEqual([]);
    expect(w.unsubscribed, "a forged letter unsubscribed the person from the list").toEqual([]);
    // The replay a lost answer gets is the answer the press got.
    const [stored] = await w.db.select().from(idempotencyKeys).where(eq(idempotencyKeys.accountId, w.accountId));
    expect([stored!.responseStatus, JSON.parse(JSON.stringify(stored!.responseJson))]).toEqual([200, JSON.parse(JSON.stringify(r))]);
  });

  it("CONTROL: a list address whose held mail holds no claim is screened out as an address", async () => {
    const w = await listWithItsRule();
    const plain = await w.held("The List", null, "us");
    const r = await w.svc.decide(w.ctx, plain, { decision: "no", scope: "sender" });
    expect((await w.listRule()).map((x) => x.destination)).toEqual(["ohmail/Screened"]);
    expect(r).toMatchObject({ createdRuleId: (await w.listRule())[0]!.id });
    expect(await w.desired(plain)).toBe("ohmail/Screened");
  });

  it("CONTROL: an impersonator at an address no list posts as is screened out as an address", async () => {
    const w = await pressWorld("person");
    await w.db.delete(listAddresses).where(eq(listAddresses.accountId, w.accountId));
    const claim = await w.held("PostFinance", "PostFinance", "us");
    const r = await new ScreenerService({}).decide(w.ctx, claim, { decision: "no", scope: "sender" });
    expect(r).toMatchObject({ createdRuleId: expect.any(String) });
    const ruled = await w.db.select().from(rules).where(and(eq(rules.accountId, w.accountId), eq(rules.match, LIST)));
    expect(ruled.map((x) => x.destination)).toEqual(["ohmail/Screened"]);
  });

  it("CONTROL: a yes on the claim is the press it was: a rule, and the claim let in", async () => {
    const w = await listWithItsRule();
    const claim = await w.held("PostFinance", "PostFinance", "us");
    const r = await w.svc.decide(w.ctx, claim, { decision: "yes", scope: "sender" });
    expect(r).toMatchObject({ createdRuleId: expect.any(String) });
    expect(await w.desired(claim)).toBe("INBOX");
  });
});

/**
 * A LIST ADDRESS NO PERSON LET IN: `List-Post` is the sender's to write, so a forger names its own
 * From there and the ingest records it as a list address. Its claims are its own mail: a screen-out
 * is the address's deny, as at any address, and the next forgery from it is screened out.
 */
describe("a list address no person let in is screened out as an address", () => {
  it("a sender naming its own From in List-Post: the press writes the deny rule and the next forgery is screened out", async () => {
    const w = await pressWorld(null);
    const forged = await normalizeMime(Buffer.from([
      "Message-ID: <forged@lists.invalid>", `From: "PostFinance" <${LIST}>`, "To: me@own.invalid",
      `List-Post: <mailto:${LIST}>`, "Subject: Konto gesperrt", "Content-Type: text/plain; charset=utf-8", "", "x",
    ].join("\r\n")));
    expect(listPostAddresses(forged.headers), "premise: the header names the sender's own address").toEqual([LIST]);
    const repo = makeDrizzleRepo(w.db as never);
    await repo.recordListAddresses(w.accountId, listPostAddresses(forged.headers));
    await w.held("PostFinance", "PostFinance", "us", "pass");
    const claim = await w.held("PostFinance", "PostFinance", "us", "pass");
    const page = await new ScreenerService({}).list(w.ctx, { limit: 50, live: true });
    expect(page.items.find((i) => i.messageId === claim)?.checked)
      .toEqual({ reason: "impersonation", brand: "PostFinance", domainShared: false, list: true });
    const r = await new ScreenerService({}).decide(w.ctx, claim, { decision: "no", scope: "sender" });
    const ruled = await w.listRules();
    expect(ruled.map((x) => x.destination)).toEqual(["ohmail/Screened"]);
    expect(r).toMatchObject({ createdRuleId: ruled[0]!.id });
    const next = evaluateRules({
      msg: forged, rules: await repo.listRules(w.accountId), knownSenders: await repo.knownSenders(w.accountId), auth: "pass",
      ohboxPolicy: "people_and_replied", ownAddresses: new Set(),
      identity: claimedIdentity({ fromName: forged.from.name, fromAddress: forged.from.address, subject: forged.subject }) ?? null,
    });
    expect(next.destination, "the next forgery waits in the Screener again").toBe("ohmail/Screened");
  });

  it("CONTROL: an inferred contact is no person's word: the press is the address's deny", async () => {
    const w = await pressWorld("inferred");
    const claim = await w.held("PostFinance", "PostFinance", "us");
    const r = await new ScreenerService({}).decide(w.ctx, claim, { decision: "no", scope: "sender" });
    expect((await w.listRules()).map((x) => x.destination)).toEqual(["ohmail/Screened"]);
    expect(r).toMatchObject({ createdRuleId: expect.any(String) });
  });
});

/**
 * EVERY DOOR A PERSON LETS A LIST IN BY makes a claim's screen-out file the claim alone: a domain rule
 * they wrote or stamped, an inferred contact they named or noted, an AI filing they approved. A
 * claim that failed authentication there is filed alone too. What no person chose (an unstamped
 * rule, a paused one, a rule into Screened, a shared provider's domain, another account's word) stays
 * the address's deny.
 */
type Door =
  | "domain rule" | "stamped domain rule" | "named inferred contact" | "noted inferred contact" | "approved filing"
  | "unstamped domain rule" | "paused domain rule" | "domain rule into Screened" | "shared provider domain rule"
  | "another account's doors" | "filing approved into Screened" | "rejected filing";

async function admittedBy(door: Door) {
  const list = door === "shared provider domain rule" ? ["club", "gmail.com"].join("@") : LIST;
  const w = await pressWorld(null, list);
  const stamp = new Date("2026-09-30T08:00:00.000Z");
  const domainRule = (accountId: string, over: Partial<typeof rules.$inferInsert> = {}) => w.db.insert(rules).values({
    accountId, kind: "domain", match: list.split("@")[1]!, destination: "ohmail/News", enabled: true, priority: 3,
    provenance: "manual", personDecidedAt: stamp, retroRequestedAt: stamp, retroDoneAt: stamp, ...over,
  });
  const approvals = async (accountId: string, destination = "ohmail/News", label = "positive") => {
    for (let i = 0; i < 3; i++) {
      await w.db.insert(learningSignals).values({
        accountId, kind: "approval", label, senderAddress: list, destination,
        triggeringActionId: `approval:${randomUUID()}`,
      });
    }
  };
  if (door === "domain rule" || door === "shared provider domain rule") await domainRule(w.accountId);
  else if (door === "stamped domain rule") await domainRule(w.accountId, { provenance: "promoted" });
  else if (door === "unstamped domain rule") await domainRule(w.accountId, { provenance: "promoted", personDecidedAt: null });
  else if (door === "paused domain rule") await domainRule(w.accountId, { enabled: false });
  else if (door === "domain rule into Screened") await domainRule(w.accountId, { destination: "ohmail/Screened" });
  else if (door === "named inferred contact") {
    await w.db.insert(contacts).values({ accountId: w.accountId, address: list, source: "inferred", name: "The club list" });
  } else if (door === "noted inferred contact") {
    const [c] = await w.db.insert(contacts).values({ accountId: w.accountId, address: list, source: "inferred" }).returning();
    await w.db.insert(contactNotes).values({ accountId: w.accountId, contactId: c!.id, body: "the club list" });
  } else if (door === "approved filing") {
    // The AI's filing the person approved became the act's rule, which no person stamped.
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: list, destination: "ohmail/News", enabled: true, priority: 3,
      provenance: "promoted", personDecidedAt: null, retroRequestedAt: stamp, retroDoneAt: stamp,
    });
    await approvals(w.accountId);
  } else if (door === "filing approved into Screened") await approvals(w.accountId, "ohmail/Screened");
  else if (door === "rejected filing") await approvals(w.accountId, "ohmail/News", "negative");
  else {
    const other = randomUUID();
    await w.db.insert(accounts).values({ id: other, name: `oth-${other.slice(0, 8)}` });
    await domainRule(other);
    await w.db.insert(listAddresses).values({ accountId: other, address: list, consentedBrands: [] });
    const [c] = await w.db.insert(contacts).values({ accountId: other, address: list, source: "person", name: "The club list" }).returning();
    await w.db.insert(contactNotes).values({ accountId: other, contactId: c!.id, body: "the club list" });
    await approvals(other);
  }
  const [mb] = await w.db.select({ id: mailboxes.id }).from(mailboxes).where(eq(mailboxes.accountId, w.accountId));
  const [post] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `adm:${randomUUID()}`, subject: "Agenda",
    snippet: "", fromAddress: list, fromName: "The Lists", senderCheck: "none", date: stamp, createdAt: stamp,
    nativeLocator: { folder: "ohmail/News", ref: "1:900" },
  }).returning();
  await w.db.insert(folderState).values({
    messageId: post!.id, desiredFolder: "ohmail/News", observedFolder: "ohmail/News", lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  const unsubscribed: string[][] = [];
  const svc = new ScreenerService({ unsubscribe: { onScreenOut: async (_ctx, ids) => { unsubscribed.push(ids); return { considered: ids.length }; } } });
  const accountRules = async () => w.db.select().from(rules).where(eq(rules.accountId, w.accountId));
  const signals = async () => w.db.select().from(learningSignals).where(eq(learningSignals.accountId, w.accountId));
  const nextListLetter = async () => {
    const repo = makeDrizzleRepo(w.db as never);
    const msg = await normalizeMime(Buffer.from([
      "Message-ID: <next-post@lists.invalid>", `From: "The Lists" <${list}>`, "To: me@own.invalid",
      "Subject: Next meeting", "Content-Type: text/plain; charset=utf-8", "", "x",
    ].join("\r\n")));
    return evaluateRules({
      msg, rules: await repo.listRules(w.accountId), knownSenders: await repo.knownSenders(w.accountId), auth: "pass",
      ohboxPolicy: "people_and_replied", ownAddresses: new Set(), identity: null,
    }).destination;
  };
  return { ...w, list, post: post!.id, svc, unsubscribed, accountRules, signals, nextListLetter };
}

describe("a list a person let in by any of their doors", () => {
  for (const [door, auth] of [
    ["domain rule", null], ["stamped domain rule", null], ["named inferred contact", null],
    ["noted inferred contact", null], ["approved filing", null], ["domain rule", "fail"],
  ] as const) {
    it(`${door}${auth === null ? "" : ", a claim that failed authentication"}: the screen-out files the claim alone`, async () => {
      const w = await admittedBy(door);
      const claim = await w.held("PostFinance", "PostFinance", "us", auth);
      const before = { rules: await w.accountRules(), signals: await w.signals(), next: await w.nextListLetter() };
      const page = await w.svc.list(w.ctx, { limit: 50, live: true });
      expect(page.items.find((i) => i.messageId === claim)?.checked).toMatchObject({ list: true, claimsOnly: true });
      const r = await w.svc.decide(w.ctx, claim, { decision: "no", scope: "sender" });
      expect(r).toMatchObject({ createdRuleId: null, appliedFolder: "ohmail/Screened" });
      expect(await w.desired(claim)).toBe("ohmail/Screened");
      await ruleRetroPass(w.db as never, { accountId: w.accountId, trustedAuthservIdsFor: async () => new Set<string>() }, NOW);
      expect(await w.desired(w.post), "the list's own letter left News").toBe("ohmail/News");
      expect(await w.nextListLetter(), "the list's next letter").toBe(before.next);
      expect(await w.accountRules(), "the list's rules moved").toEqual(before.rules);
      expect(await w.signals(), "a forgery taught the list's address").toEqual(before.signals);
      expect(w.unsubscribed, "a forged letter unsubscribed the person from the list").toEqual([]);
    });
  }

  for (const door of [
    "unstamped domain rule", "paused domain rule", "domain rule into Screened", "shared provider domain rule", "another account's doors",
    "filing approved into Screened", "rejected filing",
  ] as const) {
    it(`CONTROL: ${door} is no person letting this list in: the screen-out is the address's deny`, async () => {
      const w = await admittedBy(door);
      const claim = await w.held("PostFinance", "PostFinance", "us");
      const page = await w.svc.list(w.ctx, { limit: 50, live: true });
      const checked = page.items.find((i) => i.messageId === claim)?.checked;
      expect([checked?.list, checked?.claimsOnly]).toEqual([true, undefined]);
      const r = await w.svc.decide(w.ctx, claim, { decision: "no", scope: "sender" });
      const ruled = await w.listRules();
      expect(ruled.map((x) => `${x.kind}:${x.destination}`)).toEqual(["sender:ohmail/Screened"]);
      expect(r).toMatchObject({ createdRuleId: ruled[0]!.id });
    });
  }
});

/**
 * A CLAIM NO PRESS CAN REACH: held only in a mailbox removed with ohmail's copy kept, or stood down
 * for another install. The person's screen-out of the list's own letter in the live mailbox is the
 * address's: it files that letter and writes the rule, and refuses nothing; the row promised no
 * claims-only press.
 */
describe("a list address whose claim no press can reach", () => {
  for (const shape of [
    { name: "removed with the copy kept", disabledReason: null },
    { name: "stood down for another install", disabledReason: "organized_elsewhere:local" },
  ] as const) {
    it(`a claim held only in a mailbox ${shape.name}: the screen-out of the list's own letter is the address's`, async () => {
      const w = await pressWorld("person");
      const [other] = await w.db.insert(mailboxes).values({
        accountId: w.accountId, provider: "imap", address: `old-${w.accountId.slice(0, 8)}@own.invalid`,
        organizerRole: "organizer", status: "disabled", disabledReason: shape.disabledReason,
      }).returning();
      const claim = await w.held("PostFinance", "PostFinance", "us", null, other!.id);
      const post = await w.held("The List", null, "us");
      const page = await new ScreenerService({}).list(w.ctx, { limit: 50, live: true });
      expect(page.items.find((i) => i.messageId === post)?.checked?.claimsOnly).toBeUndefined();
      const r = await new ScreenerService({}).decide(w.ctx, post, { decision: "no", scope: "sender" });
      const ruled = await w.listRules();
      expect(ruled.map((x) => x.destination)).toEqual(["ohmail/Screened"]);
      expect(r).toMatchObject({ createdRuleId: ruled[0]!.id });
      expect(await w.desired(post)).toBe("ohmail/Screened");
      expect(await w.desired(claim), "a mailbox no press reaches was written").toBe(GATE);
    });
  }
});

/**
 * A CLAIM HELD IN A MAILBOX ANOTHER INSTALL ORGANIZES: the press files this install's claims and asks
 * the holder to move its own, letter by letter. No address decision travels: the holder's store
 * holds no claim, so it would screen out the list's whole mail and license the unsubscribe there.
 */
describe("a list claim held where another install organizes", () => {
  it("asks the holder to move that claim alone: no decision travels, and the holder's list rule and mail stand", async () => {
    const w = await listWithItsRule();
    const [laptop] = await w.db.insert(mailboxes).values({
      accountId: w.accountId, provider: "imap", address: `work-${w.accountId.slice(0, 8)}@own.invalid`, organizerRole: "reader",
      organizerState: "held", organizedByCapabilities: "requests,moves", organizedByKind: "local", organizedByName: "Laptop",
    }).returning();
    const here = await w.held("PostFinance", "PostFinance", "us");
    const there = await w.held("PostFinance", "PostFinance", "us", null, laptop!.id);
    const r = await w.svc.decide(w.ctx, here, { decision: "no", scope: "sender" });
    expect(r).toMatchObject({ createdRuleId: null, mailboxes: { requested: [{ mailboxId: laptop!.id }] } });
    expect(await w.desired(here)).toBe("ohmail/Screened");
    const [{ dedupKey }] = await w.db.select({ dedupKey: messages.dedupKey }).from(messages).where(eq(messages.id, there));
    const asked = await w.db.select().from(organizerRequests).where(eq(organizerRequests.accountId, w.accountId));
    expect(asked.map((q) => [q.mailboxId, q.kind, q.payload])).toEqual([[laptop!.id, "message.move", { dedupKey, destination: "screened" }]]);
    expect(w.unsubscribed).toEqual([]);

    // The holder's own store, as its drain applies the request: the list's rule, its past letter and its retro stand.
    const h = await listWithItsRule();
    const claim = await h.held("PostFinance", "PostFinance", "us");
    await h.db.update(messages).set({ dedupKey }).where(eq(messages.id, claim));
    const before = await h.listRule();
    const move = validateMovePayload(asked[0]!.payload)!;
    await (h.db as unknown as { transaction: <T>(f: (tx: unknown) => Promise<T>) => Promise<T> }).transaction((tx) =>
      applyMessageMove(carryDialect(h.db as never, tx as object) as Tx, { accountId: h.accountId, mailboxId: h.mailboxId, payload: move, now: NOW }));
    await ruleRetroPass(h.db as never, { accountId: h.accountId, trustedAuthservIdsFor: async () => new Set<string>() }, NOW);
    expect(await h.desired(claim)).toBe("ohmail/Screened");
    expect(await h.listRule(), "the holder's list rule moved").toEqual(before);
    expect(await h.desired(h.post), "the list's own letter left News on the holder").toBe("ohmail/News");
  });
});

/**
 * NOTHING ORGANIZED HERE: both mailboxes are held by one local install, so the press is a reader's.
 * The same rule as the organizer's door (`helpers/list-claim-reader-door.ts`; the `.pg` twin runs it
 * on the server's Postgres).
 */
describe("a list claim screened out where another install organizes every mailbox", () => {
  it("asks the claim's holder to move it alone: the list's rule and letters stand, nothing is learned or unsubscribed", async () => {
    await readerDoorListClaim(await makeTestDb());
  });

  it("a forgery the identity check never reached is checked first, as the organizer's press checks it, and travels as a move alone", async () => {
    const w = await readerDoorWorld(await makeTestDb(), { unchecked: true });
    await w.svc.decide(w.ctx, w.held, { decision: "no", scope: "sender" });
    expect((await w.asked()).map((q) => [q.mailboxId, q.kind])).toEqual([[w.work.id, "message.move"]]);
  });

  it("CONTROL: the list's own letter screened out there is the address's decision, asked of every holder", async () => {
    const w = await readerDoorWorld(await makeTestDb(), { claim: false });
    await w.svc.decide(w.ctx, w.held, { decision: "no", scope: "sender" });
    const asked = (await w.asked()).map((q) => [q.mailboxId, q.kind]);
    expect(asked.sort()).toEqual([[w.work.id, "screener.decide"], [w.home.id, "screener.decide"]].sort());
  });

  it("a holder that takes no moves refuses the claim's screen-out, naming the claim's mailbox, and nothing is asked", async () => {
    const w = await readerDoorWorld(await makeTestDb(), { capabilities: "requests" });
    await expect(w.svc.decide(w.ctx, w.held, { decision: "no", scope: "sender" }))
      .rejects.toMatchObject({ code: "organized_elsewhere", mailboxId: w.work.id, details: { by: { name: "Laptop" } } });
    expect(await w.asked()).toEqual([]);
    expect(await w.desired(w.held)).toBe(GATE);
  });
});
