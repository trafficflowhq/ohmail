import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP, type ImportHold } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeTestDb } from "@trafficflow/db/testing";
import { carryDialect } from "@trafficflow/db/dialect";
import {
  accounts, accountSettings, applyScreenerDecision, auditLog, contacts, folderState, listAddresses, listBrandsOf,
  mailboxFolders, mailboxes, messageBodies, messageInstances, messages, PassMayNotAdmitError, rules, type Tx,
} from "@trafficflow/db";
import type { OrganizerRole } from "@trafficflow/db";
import { runSyncCycle } from "../src/sync.js";
import { screenerCorrespondentRetroPass } from "../src/screener-correspondent-retro.js";
import { ruleRetroPass } from "../src/rule-retro.js";
import { materializeMessages, releaseHeld } from "@trafficflow/services/mail";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A LIST ADDRESS THE PERSON POSTED TO NEVER CONSENTS A COMPANY CLAIM (mail 0150), through a real
 * sync cycle on the in-process store (PGlite here, the device's SQLite in the `sqlite` project).
 * The person wrote to `list@` once, so it is a person's contact; the list's own mail names it in
 * `List-Post`, which records it as a list address; from then on `"PostFinance" <list@>` waits at
 * the Screener, the hourly retro and a rule's retro leave it there, and only a person's press
 * admits it — that brand only. A delivery report citing a copy written to `list@` is no bounce of
 * the person's mail. Every address is `.invalid`.
 */
const LIST = "list@lists.invalid";
const MEMBER = "member@elsewhere.invalid";
const FRIEND = "friend@corr.invalid";
const CONNECT = new Date("2026-09-01T08:00:00.000Z");
const WROTE = new Date("2026-09-22T15:12:00.000Z");
const POST = "post-1@own.invalid";
const NONE = async (): Promise<ReadonlySet<string>> => new Set<string>();

function eml(o: { id: string; from: string; to?: string; subject?: string; headers?: string[] }): Buffer {
  return Buffer.from([
    `Message-ID: <${o.id}>`, `From: ${o.from}`, `To: ${o.to ?? "me@own.invalid"}`,
    `Subject: ${o.subject ?? "Spring meeting"}`, ...(o.headers ?? []),
    "Content-Type: text/plain; charset=utf-8", "", "See you there.",
  ].join("\r\n"));
}
const LIST_HEADERS = [`List-Post: <mailto:${LIST}>`, "List-Id: The Lists <lists.lists.invalid>"];

/** A delivery report citing `id`: in its own In-Reply-To, or with `quoted`, only in the rfc822-headers part. */
function dsn(o: { id: string; cites: string; quoted?: boolean }): Buffer {
  return Buffer.from([
    `Message-ID: <${o.id}>`, "From: MAILER-DAEMON@their-host.invalid", "To: me@own.invalid",
    "Subject: Undelivered Mail Returned to Sender", ...(o.quoted ? [] : [`In-Reply-To: <${o.cites}>`]),
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"', "",
    "--b1", "Content-Type: text/plain; charset=utf-8", "", "Your message could not be delivered.", "",
    "--b1", "Content-Type: message/rfc822-headers", "", `Message-ID: <${o.cites}>`, "From: me@own.invalid", "",
    "--b1--",
  ].join("\r\n"));
}

/**
 * The account, its mailbox, its post to `list@` after the consent point (a Sent copy the bounce and
 * reply arms can find), and `list@` as the person's contact the post made. `role`: the install's.
 */
async function world(o: { role?: OrganizerRole; trusted?: ReadonlySet<string>; contact?: boolean } = {}) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `l026-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const me = `me-${accountId.slice(0, 8)}@own.invalid`;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: me, status: "connected", createdAt: CONNECT }).returning();
  await db.insert(mailboxFolders).values({ mailboxId: mb!.id, folder: "Sent", uidvalidity: 7n, uidnext: 100n });
  const sentCopy = async (header: string, to: string, uid: number) => {
    const [s] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `sent:${randomUUID()}`, subject: "Spring meeting",
      fromAddress: me, messageIdHeader: header, date: WROTE, arrivedAt: WROTE,
      toAddresses: [{ name: null, address: to }], ccAddresses: [], nativeLocator: { folder: "Sent", ref: `7:${uid}` },
    }).returning();
    await db.insert(messageInstances).values({
      accountId, mailboxId: mb!.id, messageId: s!.id, folder: "Sent", uidvalidity: 7n, uid, isPrimary: true,
    });
    await db.insert(folderState).values({
      messageId: s!.id, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us",
      reconcileStatus: "reconciled", conflict: false,
    });
    await db.insert(messageBodies).values({ messageId: s!.id, text: "hi", headers: {} });
  };
  await sentCopy(POST, LIST, 1);
  await sentCopy("private-1@own.invalid", FRIEND, 2);
  const teach = async () => {
    await db.insert(contacts).values({ accountId, address: LIST, source: "person" })
      .onConflictDoNothing({ target: [contacts.accountId, contacts.address] });
  };
  if (o.contact !== false) await teach();

  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } },
  );
  const queue: Array<{ from: string; subject: string; messageId: string; raw: Buffer; folder?: string; ownAuthored?: boolean }> = [];
  const deliver = async (
    messageId: string, raw: Buffer, more: { folder?: string; ownAuthored?: boolean; importHold?: ImportHold } = {},
  ) => {
    const { importHold, ...placed } = more;
    queue.push({ from: "-", subject: "-", messageId, raw, ...placed });
    fleet.behave(mb!.id, { deliver: [...queue] });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId,
      mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP, role: o.role ?? "organizer",
      trustedAuthservIds: o.trusted ?? new Set<string>(), ...(importHold ? { importHold } : {}),
    });
    const [row] = await db.select({ id: messages.id, desired: folderState.desiredFolder, check: messages.senderCheck })
      .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(eq(messages.accountId, accountId), eq(messages.messageIdHeader, messageId)));
    return row!;
  };
  const listRow = async (address: string) => {
    const [r] = await db.select({ brands: listAddresses.consentedBrands }).from(listAddresses)
      .where(and(eq(listAddresses.accountId, accountId), eq(listAddresses.address, address)));
    return r === undefined ? null : { brands: listBrandsOf(r.brands) };
  };
  const contactOf = async (address: string) => (await db.select({ source: contacts.source }).from(contacts)
    .where(and(eq(contacts.accountId, accountId), eq(contacts.address, address))))[0]?.source ?? null;
  const desiredOf = async (id: string) =>
    (await db.select({ d: folderState.desiredFolder }).from(folderState).where(eq(folderState.messageId, id)))[0]!.d;
  /** Audit payloads under one action — JSON text on the device store. */
  const audits = async (action: string) => (await db.select({ payload: auditLog.payload }).from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, action))))
    .map((r) => (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>);
  /** The gate's hold, written over whatever this tree's gate decided: the passes' own question. */
  const holdAtGate = async (messageId: string) => {
    await db.update(folderState).set({ desiredFolder: "ohmail/Screener", lastSetBy: "us" })
      .where(eq(folderState.messageId, messageId));
  };
  /* A Screener decision on `list@`, in its own transaction as every caller makes it. */
  const press = (o2: { decidedBy: "person" | "pass"; marked?: "pressed" | "none" }) =>
    db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx) as Tx, {
      accountId, scope: "sender", address: LIST, appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `screener:${randomUUID()}`, now: new Date(),
      overExisting: o2.decidedBy === "pass" ? "skip" : "converge", decidedBy: o2.decidedBy,
      ...(o2.marked ? { marked: o2.marked } : {}), stampBaseline: o2.decidedBy === "person",
    }));
  return { db, accountId, me, deliver, listRow, contactOf, desiredOf, audits, holdAtGate, press, teach };
}

const spoof = (brand: string, n: number) => eml({ id: `spoof-${n}@lists.invalid`, from: `"${brand}" <${LIST}>`, subject: "Ihre Karte" });
const listMail = (n: number) => eml({ id: `l-${n}@elsewhere.invalid`, from: MEMBER, to: LIST, headers: LIST_HEADERS });

describe("a list address at the gate, through a sync cycle", () => {
  it("ACCEPTANCE 1a: post, the list's own mail, then a claim under the list address — held, marked", async () => {
    const w = await world();
    const thread = await w.deliver("l-1@elsewhere.invalid", listMail(1));
    expect(thread.desired, "a member's new thread is a stranger's").toBe("ohmail/Screener");
    const claim = await w.deliver("spoof-1@lists.invalid", spoof("PostFinance", 1));
    expect(claim.desired, "the list address's contact consented a company's name").toBe("ohmail/Screener");
    expect(claim.check).toBe("impersonation");
    expect(await w.listRow(LIST)).toEqual({ brands: [] });
  });

  it("ACCEPTANCE 1b: the list's mail BEFORE the post makes the address a person's contact — still held", async () => {
    const w = await world({ contact: false });
    await w.deliver("l-2@elsewhere.invalid", listMail(2));
    await w.teach();
    const claim = await w.deliver("spoof-2@lists.invalid", spoof("PostFinance", 2));
    expect(claim.desired).toBe("ohmail/Screener");
  });

  it("CONTROL: the list address's own mail with no claim reaches News, the fact riding nothing", async () => {
    const w = await world();
    await w.deliver("l-3@elsewhere.invalid", listMail(3));
    const own = await w.deliver("l-own@lists.invalid", eml({ id: "l-own@lists.invalid", from: LIST, headers: LIST_HEADERS }));
    expect(own.desired).toBe("ohmail/News");
    expect(own.check).toBe("none");
  });

  it("ACCEPTANCE 1c: a READER install records the list addresses of the mail it adopts", async () => {
    const w = await world({ role: "reader" });
    await w.deliver("l-4@elsewhere.invalid", listMail(4));
    expect(await w.listRow(LIST)).toEqual({ brands: [] });
  });

  it("ACCEPTANCE 1c: the list relaying the person's own letter unchanged records the address", async () => {
    const w = await world({ contact: false });
    const letter = eml({ id: "post-relay@own.invalid", from: "me@own.invalid", to: LIST });
    await w.deliver("post-relay@own.invalid", letter, { folder: "Sent", ownAuthored: true });
    expect(await w.listRow(LIST)).toBeNull();
    await w.deliver("post-relay@own.invalid", Buffer.concat([Buffer.from(`List-Post: <mailto:${LIST}>\r\n`), letter]));
    expect(await w.listRow(LIST), "the INBOX copy of the person's own letter names the list").toEqual({ brands: [] });
  });

  it("ACCEPTANCE 1g: a stranger's HELD mail naming an address in List-Post records it, and no contact", async () => {
    const w = await world();
    const held = await w.deliver("x-1@stranger.invalid", eml({
      id: "x-1@stranger.invalid", from: "someone@stranger.invalid", headers: [`List-Post: <mailto:${FRIEND}>`],
    }));
    expect(held.desired).toBe("ohmail/Screener");
    expect(await w.listRow(FRIEND)).toEqual({ brands: [] });
    expect(await w.contactOf(FRIEND)).toBeNull();
  });

  it("ACCEPTANCE 1g: the same mail FAILING authentication records nothing", async () => {
    const w = await world({ trusted: new Set(["mx.google.com"]) });
    await w.deliver("x-2@stranger.invalid", eml({
      id: "x-2@stranger.invalid", from: "someone@stranger.invalid", headers: [
        `List-Post: <mailto:${FRIEND}>`, "Authentication-Results: mx.google.com; dmarc=fail header.from=stranger.invalid",
      ],
    }));
    expect(await w.listRow(FRIEND)).toBeNull();
  });
});

/**
 * THE LETTER THAT REVEALS A LIST ADDRESS IS A LIST LETTER (R32-01). The person wrote to `list@` and
 * no mail has named it a list: the first company claim through it carries `List-Post` naming
 * itself, was judged before its own commit recorded the row and reached News with a chip. It waits
 * with the list line now, and the second as before.
 */
const OTHER_LIST = "other@lists.invalid";
const revealing = (brand: string, n: number, from = LIST) => eml({
  id: `rev-${n}@lists.invalid`, from: `"${brand}" <${from}>`, subject: "Ihre Karte",
  headers: [`List-Post: <mailto:${from}>`, "List-Id: The Lists <lists.lists.invalid>"],
});

describe("the first claim through a list address the person wrote to, through a sync cycle", () => {
  it("R32-01: the first is held, marked and carries the list line; the second as before", async () => {
    const w = await world();
    const first = await w.deliver("rev-1@lists.invalid", revealing("PostFinance", 1));
    expect(first.desired, "the letter naming its own list address was judged as a person's").toBe("ohmail/Screener");
    expect(first.check).toBe("impersonation");
    expect(await w.listRow(LIST)).toEqual({ brands: [] });
    const dto = (await materializeMessages(w.db as never, w.accountId, [first.id])).get(first.id);
    expect(dto?.senderCheck, "the list line").toMatchObject({ reason: "impersonation", brand: "PostFinance", list: true });
    const second = await w.deliver("rev-2@lists.invalid", revealing("PostFinance", 2));
    expect(second.desired).toBe("ohmail/Screener");
  });

  it("R32-01: an open import's document view, which knows the address as a person, holds it too", async () => {
    const w = await world();
    const importHold: ImportHold = { kind: "document", rules: [], knownSenders: {
      addresses: new Set([LIST]), inferred: new Set<string>(), lists: new Map<string, ReadonlySet<string>>(),
    } };
    const first = await w.deliver("rev-3@lists.invalid", revealing("PostFinance", 3), { importHold });
    expect(first.desired, "the document's view adopted the revealing claim").toBe("ohmail/Screener");
  });

  it("CONTROL: a list address the person never wrote to is held", async () => {
    const w = await world();
    const other = await w.deliver("rev-4@lists.invalid", revealing("PostFinance", 4, OTHER_LIST));
    expect(other.desired).toBe("ohmail/Screener");
    expect(await w.listRow(OTHER_LIST)).toEqual({ brands: [] });
  });

  it("CONTROL: a person's press admits that brand for the next such letter, and another brand waits", async () => {
    const w = await world();
    const first = await w.deliver("rev-5@lists.invalid", revealing("PostFinance", 5));
    expect(first.desired).toBe("ohmail/Screener");
    await w.press({ decidedBy: "person" });
    expect(await w.listRow(LIST)).toEqual({ brands: ["PostFinance"] });
    const again = await w.deliver("rev-6@lists.invalid", revealing("PostFinance", 6));
    expect(again.desired, "the letter's own evidence forgot the press's brand").not.toBe("ohmail/Screener");
    const other = await w.deliver("rev-7@lists.invalid", revealing("Swisscom", 7));
    expect(other.desired).toBe("ohmail/Screener");
  });

  it("CONTROL: a person's claim naming another address in List-Post keeps the person's consent", async () => {
    const w = await world();
    await w.db.insert(contacts).values({ accountId: w.accountId, address: FRIEND, source: "person" });
    const relayed = await w.deliver("fr-1@corr.invalid", eml({
      id: "fr-1@corr.invalid", from: `"PostFinance" <${FRIEND}>`, to: LIST, subject: "Ihre Karte", headers: LIST_HEADERS,
    }));
    expect(relayed.desired).toBe("ohmail/News");
    expect(await w.listRow(LIST)).toEqual({ brands: [] });
  });

  it("CONTROL: the account's own letter naming its own address in List-Post keeps its place, and names no list", async () => {
    const w = await world();
    const own = await w.deliver("own-1@own.invalid", eml({
      id: "own-1@own.invalid", from: `"PostFinance" <${w.me}>`, subject: "Ihre Karte",
      headers: [`List-Post: <mailto:${w.me}>`],
    }));
    expect(own.desired).toBe("INBOX");
    expect(await w.listRow(w.me)).toBeNull();
  });
});

describe("the passes after the gate leave a list address's claim held", () => {
  it("ACCEPTANCE 1d: the hourly retro leaves the claim held, writes no admission, keeps the row", async () => {
    const w = await world();
    await w.deliver("l-5@elsewhere.invalid", listMail(5));
    const claim = await w.deliver("spoof-5@lists.invalid", spoof("PostFinance", 5));
    await w.holdAtGate(claim.id);
    await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(await w.desiredOf(claim.id), "the `wrote` arm released a claim under a list address").toBe("ohmail/Screener");
    expect((await w.audits("screener.correspondent_admitted")).filter((p) => p.messageId === claim.id)).toEqual([]);
    expect(await w.listRow(LIST)).toEqual({ brands: [] });
  });

  it("ACCEPTANCE 1d: a list author's held claim the check never reached is checked first and stays", async () => {
    const w = await world();
    await w.deliver("l-17@elsewhere.invalid", listMail(17));
    const claim = await w.deliver("spoof-17@lists.invalid", spoof("PostFinance", 17));
    await w.holdAtGate(claim.id);
    // A row older than the identity column: never checked.
    await w.db.update(messages).set({ senderCheck: null, senderCheckBrand: null }).where(eq(messages.id, claim.id));
    await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(await w.desiredOf(claim.id), "an unchecked claim under a list address was released").toBe("ohmail/Screener");
    const [after] = await w.db.select({ check: messages.senderCheck }).from(messages).where(eq(messages.id, claim.id));
    expect(after!.check).toBe("impersonation");
  });

  it("CONTROL: the retro still releases a list address's ordinary held mail, the claim staying", async () => {
    const w = await world();
    await w.deliver("l-6@elsewhere.invalid", listMail(6));
    const claim = await w.deliver("spoof-6@lists.invalid", spoof("PostFinance", 6));
    const plain = await w.deliver("l-own-6@lists.invalid", eml({ id: "l-own-6@lists.invalid", from: LIST, subject: "Agenda" }));
    await w.holdAtGate(claim.id);
    await w.holdAtGate(plain.id);
    await screenerCorrespondentRetroPass(w.db, { accountId: w.accountId });
    expect(await w.desiredOf(plain.id)).toBe("INBOX");
    expect(await w.desiredOf(claim.id)).toBe("ohmail/Screener");
  });

  for (const provenance of ["seeded-from-sent", "manual", "migrated"] as const) {
    it(`ACCEPTANCE 1e: a ${provenance} rule naming the list address places its mail and admits no claim`, async () => {
      const w = await world();
      const destination = provenance === "manual" ? "ohmail/News" : "INBOX";
      await w.db.insert(rules).values({
        accountId: w.accountId, kind: "sender", match: LIST, destination, provenance, enabled: true,
      });
      await w.deliver(`l-7-${provenance}@elsewhere.invalid`, listMail(70 + provenance.length));
      const claim = await w.deliver(`spoof-7-${provenance}@lists.invalid`, eml({
        id: `spoof-7-${provenance}@lists.invalid`, from: `"PostFinance" <${LIST}>`, subject: "Ihre Karte",
      }));
      expect(claim.desired).toBe("ohmail/Screener");
      const plain = await w.deliver(`plain-7-${provenance}@lists.invalid`, eml({
        id: `plain-7-${provenance}@lists.invalid`, from: LIST, subject: "Agenda",
      }));
      expect(plain.desired, "the rule still places the list's ordinary mail").toBe(destination);
    });
  }

  it("ACCEPTANCE 1e: a rule's retro over the held bag moves no claim", async () => {
    const w = await world();
    await w.deliver("l-8@elsewhere.invalid", listMail(8));
    const claim = await w.deliver("spoof-8@lists.invalid", spoof("PostFinance", 8));
    await w.holdAtGate(claim.id);
    await w.db.insert(rules).values({
      accountId: w.accountId, kind: "sender", match: LIST, destination: "ohmail/News", provenance: "manual",
      enabled: true, retroRequestedAt: new Date(),
    });
    await ruleRetroPass(w.db, { accountId: w.accountId, trustedAuthservIdsFor: NONE });
    expect(await w.desiredOf(claim.id)).toBe("ohmail/Screener");
  });
});

describe("only a person's press consents a brand under a list address", () => {
  it("ACCEPTANCE 1f: a press admits the claim and that brand only", async () => {
    const w = await world();
    await w.deliver("l-9@elsewhere.invalid", listMail(9));
    const claim = await w.deliver("spoof-9@lists.invalid", spoof("PostFinance", 9));
    expect(claim.desired).toBe("ohmail/Screener");
    await w.press({ decidedBy: "person" });
    expect(await w.desiredOf(claim.id)).toBe("INBOX");
    expect(await w.listRow(LIST)).toEqual({ brands: ["PostFinance"] });
    const again = await w.deliver("spoof-10@lists.invalid", spoof("PostFinance", 10));
    expect(again.desired, "the consented brand arrives").not.toBe("ohmail/Screener");
    const other = await w.deliver("spoof-11@lists.invalid", spoof("Swisscom", 11));
    expect(other.desired, "one press does not open the address to every name").toBe("ohmail/Screener");
  });

  it("ACCEPTANCE 1f: the act's yes over a held claim is refused and writes no consent", async () => {
    const w = await world();
    await w.deliver("l-12@elsewhere.invalid", listMail(12));
    await w.deliver("spoof-12@lists.invalid", spoof("PostFinance", 12));
    await expect(w.press({ decidedBy: "pass" })).rejects.toBeInstanceOf(PassMayNotAdmitError);
    expect(await w.listRow(LIST)).toEqual({ brands: [] });
  });

  it("ACCEPTANCE 1f: the held-release press moves what its offer counted and consents nothing it did not show", async () => {
    const w = await world();
    await w.deliver("l-13@elsewhere.invalid", listMail(13));
    const post = await w.deliver("post-13@lists.invalid", eml({ id: "post-13@lists.invalid", from: `"The Lists" <${LIST}>`, headers: LIST_HEADERS }));
    const claim = await w.deliver("spoof-13@lists.invalid", spoof("PostFinance", 13));
    // Both rows as the reconciler leaves held mail: in the Screener folder, the post placed there by us.
    for (const id of [post.id, claim.id]) {
      await w.db.update(folderState).set({ desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener", lastSetBy: "us" })
        .where(eq(folderState.messageId, id));
    }
    const ctx = { db: w.db as never, accountId: w.accountId, userId: null, now: () => new Date(), requestId: `l026-${randomUUID().slice(0, 8)}` };
    const r = await releaseHeld(ctx, { senders: [LIST] });
    expect([r.total, await w.desiredOf(post.id)]).toEqual([1, "INBOX"]);
    expect(await w.desiredOf(claim.id), "the offer never counted the claim").toBe("ohmail/Screener");
    expect(await w.listRow(LIST)).toEqual({ brands: [] });
    const again = await w.deliver("spoof-14@lists.invalid", spoof("PostFinance", 14));
    expect(again.desired, "the next forgery still waits").toBe("ohmail/Screener");
  });
});

describe("a delivery report citing a copy written to a list address", () => {
  it("ACCEPTANCE 1i: quoting the list post, it waits and no bounce is recorded", async () => {
    const w = await world();
    await w.deliver("l-14@elsewhere.invalid", listMail(14));
    const report = await w.deliver("dsn-1@their-host.invalid", dsn({ id: "dsn-1@their-host.invalid", cites: POST, quoted: true }));
    expect(report.desired).toBe("ohmail/Screener");
    expect(await w.audits("screener.bounce_admitted")).toEqual([]);
  });

  it("ACCEPTANCE 1i: naming the list post in its own In-Reply-To, it waits by neither arm", async () => {
    const w = await world();
    await w.deliver("l-15@elsewhere.invalid", listMail(15));
    const report = await w.deliver("dsn-2@their-host.invalid", dsn({ id: "dsn-2@their-host.invalid", cites: POST }));
    expect(report.desired).toBe("ohmail/Screener");
    expect(await w.audits("screener.correspondent_admitted")).toEqual([]);
    expect(await w.audits("screener.bounce_admitted")).toEqual([]);
  });

  it("CONTROL: a report citing a PRIVATE copy reaches the Ohbox, recorded as a bounce", async () => {
    const w = await world();
    await w.deliver("l-16@elsewhere.invalid", listMail(16));
    const report = await w.deliver("dsn-3@their-host.invalid", dsn({ id: "dsn-3@their-host.invalid", cites: "private-1@own.invalid", quoted: true }));
    expect(report.desired).toBe("INBOX");
    expect(await w.audits("screener.bounce_admitted")).toEqual([{ messageId: report.id, header: "private-1@own.invalid" }]);
  });
});
