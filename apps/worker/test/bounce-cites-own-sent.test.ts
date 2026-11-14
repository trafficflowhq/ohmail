import { describe, expect, it } from "vitest";
import { personalAt } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { providerAuthservIds } from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, accountSettings, auditLog, contacts, folderState, mailboxCredentials, mailboxFolders, mailboxes, messageBodies,
  messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A DELIVERY REPORT REACHES THE OHBOX ONLY BY CITING THE ACCOUNT'S OWN SENT COPY — through a real
 * sync cycle on the in-process store (PGlite here, the device's SQLite in the `sqlite` project). A
 * Message-ID is a string its author chose, so a report citing a stranger's held message is the
 * stranger's evidence, not the account's. Never on a failed authentication, nor under a brand's name
 * other than the mailbox's own provider's (Microsoft writes its reports as "Microsoft Outlook") or the
 * account's own organisation's, at the domain of its own address.
 */
const CONNECT = new Date("2026-09-01T08:00:00.000Z");
const WROTE = new Date("2026-09-22T15:12:00.000Z");
const OURS = "s-1@own.invalid";

/**
 * A delivery report citing `inReplyTo`: in its own In-Reply-To, or with `quoted`, only inside the
 * `message/rfc822-headers` part, as RFC 3462 and most MTAs do — the reply arm reads only the former.
 */
function dsn(o: { id: string; from?: string; inReplyTo: string; headers?: string[]; quoted?: boolean }): Buffer {
  return Buffer.from([
    `Message-ID: <${o.id}>`, `From: ${o.from ?? "MAILER-DAEMON@their-host.invalid"}`, "To: me@own.invalid",
    "Subject: Undelivered Mail Returned to Sender", ...(o.quoted ? [] : [`In-Reply-To: <${o.inReplyTo}>`]), ...(o.headers ?? []),
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"', "",
    "--b1", "Content-Type: text/plain; charset=utf-8", "", "Your message could not be delivered.", "",
    "--b1", "Content-Type: message/rfc822-headers", "", `Message-ID: <${o.inReplyTo}>`, "From: me@own.invalid", "",
    "--b1--",
  ].join("\r\n"));
}

/**
 * `address`: the mailbox's own, at `own.invalid` unless given; `trusted`: the provider's authserv-ids;
 * `servers`: its credential rows' non-secret halves, by transport (none unless given).
 */
async function world(o: {
  trusted?: ReadonlySet<string>; address?: string; servers?: Partial<Record<"imap" | "smtp", Record<string, unknown>>>;
} = {}) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `b026-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const me = o.address ?? `me-${accountId.slice(0, 8)}@own.invalid`;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: me, status: "connected", createdAt: CONNECT }).returning();
  for (const [transport, meta] of Object.entries(o.servers ?? {})) {
    await db.insert(mailboxCredentials).values({ mailboxId: mb!.id, accountId: mb!.accountId, transport, secretEnc: "enc:never-read", keyVersion: 1, meta });
  }
  await db.insert(mailboxFolders).values({ mailboxId: mb!.id, accountId: mb!.accountId, folder: "Sent", uidvalidity: 7n, uidnext: 100n });
  // The account's own Sent copy after the consent point: the one id a genuine report cites.
  const [s] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `sent:${randomUUID()}`,
    subject: "Wohnung", fromAddress: me, messageIdHeader: OURS, date: WROTE, arrivedAt: WROTE,
    toAddresses: [{ name: null, address: "landlord@corr.invalid" }], ccAddresses: [],
    nativeLocator: { folder: "Sent", ref: "7:1" },
  }).returning();
  await db.insert(messageInstances).values({
    accountId, mailboxId: mb!.id, messageId: s!.id, folder: "Sent", uidvalidity: 7n, uid: 1, isPrimary: true,
  });
  await db.insert(folderState).values({
    messageId: s!.id, accountId: s!.accountId, desiredFolder: "Sent", observedFolder: "Sent", lastSetBy: "us",
    reconcileStatus: "reconciled", conflict: false,
  });
  await db.insert(messageBodies).values({ messageId: s!.id, accountId: s!.accountId, text: "hi", headers: {} });

  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } },
  );
  const queue: Array<{ from: string; subject: string; messageId: string; raw: Buffer }> = [];
  const deliver = async (messageId: string, raw: Buffer) => {
    queue.push({ from: "-", subject: "-", messageId, raw });
    fleet.behave(mb!.id, { deliver: [...queue] });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId,
      mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP, role: "organizer",
      trustedAuthservIds: o.trusted ?? new Set<string>(),
    });
    const [row] = await db.select({
      id: messages.id, desired: folderState.desiredFolder, check: messages.senderCheck, held: messages.unconfirmedHold,
      auth: messages.authVerdict,
    }).from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(eq(messages.accountId, accountId), eq(messages.messageIdHeader, messageId)));
    return { ...row!, held: row!.held === true };
  };
  /** The admissions on record under one action — the payload is JSON text on the device store. */
  const audits = (action: string) => async () => (await db.select({ payload: auditLog.payload }).from(auditLog)
    .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, action))))
    .map((r) => (typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload) as Record<string, unknown>);
  const contactOf = async (address: string) => (await db.select({ a: contacts.address }).from(contacts)
    .where(and(eq(contacts.accountId, accountId), eq(contacts.address, address))))[0]?.a ?? null;
  return {
    deliver, admissions: audits("screener.bounce_admitted"), answers: audits("screener.correspondent_admitted"), contactOf,
  };
}

describe("a delivery report at the Screener, through a sync cycle", () => {
  it("CONTROL: a report citing the account's own Sent copy reaches the Ohbox", async () => {
    const w = await world();
    const report = await w.deliver("dsn-1@their-host.invalid", dsn({ id: "dsn-1@their-host.invalid", inReplyTo: OURS }));
    expect(report.desired).toBe("INBOX");
  });

  it("the admission is recorded with the copy it cited", async () => {
    const w = await world();
    const report = await w.deliver("dsn-2@their-host.invalid", dsn({ id: "dsn-2@their-host.invalid", inReplyTo: OURS, quoted: true }));
    expect(report.desired).toBe("INBOX");
    expect(await w.admissions()).toEqual([{ messageId: report.id, header: OURS }]);
  });

  // FLIPPED (mail 0150): a report is no answer, so the reply arm refuses it and the bounce arm, which
  // asks for a PRIVATE copy, is its only door. This one cites a private copy and is admitted there.
  it("a report naming our copy in its own In-Reply-To takes the bounce arm, never the reply arm, untaught", async () => {
    const w = await world();
    const report = await w.deliver("dsn-7@their-host.invalid", dsn({ id: "dsn-7@their-host.invalid", inReplyTo: OURS }));
    expect(report.desired).toBe("INBOX");
    expect(await w.answers()).toEqual([]);
    expect(await w.admissions()).toEqual([{ messageId: report.id, header: OURS }]);
    expect(await w.contactOf("mailer-daemon@their-host.invalid")).toBeNull();
  });

  it("a report citing a STRANGER's held message is held — the stranger chose that id", async () => {
    const w = await world();
    const first = await w.deliver("m1@evil.invalid", Buffer.from([
      "Message-ID: <m1@evil.invalid>", "From: someone@evil.invalid", "To: me@own.invalid", "Subject: hello",
      "Content-Type: text/plain; charset=utf-8", "", "hi",
    ].join("\r\n")));
    expect(first.desired).toBe("ohmail/Screener");
    const report = await w.deliver("dsn-3@evil.invalid",
      dsn({ id: "dsn-3@evil.invalid", from: "postmaster@evil.invalid", inReplyTo: "m1@evil.invalid" }));
    expect(report.desired, "a stranger's own message id carried their report past the gate").toBe("ohmail/Screener");
    expect(await w.admissions()).toEqual([]);
  });

  it("a report citing the own copy that FAILED authentication is held", async () => {
    const w = await world({ trusted: new Set(["mx.google.com"]) });
    const report = await w.deliver("dsn-4@their-host.invalid", dsn({
      id: "dsn-4@their-host.invalid", inReplyTo: OURS,
      headers: ["Authentication-Results: mx.google.com; dmarc=fail header.from=their-host.invalid"],
    }));
    expect(report.desired).toBe("ohmail/Screener");
  });

  it("a report citing the own copy under a BRAND's name is held", async () => {
    const w = await world();
    const report = await w.deliver("dsn-5@their-host.invalid", dsn({
      id: "dsn-5@their-host.invalid", inReplyTo: OURS, from: '"PostFinance" <MAILER-DAEMON@their-host.invalid>',
    }));
    expect(report.desired).toBe("ohmail/Screener");
  });

  const MICROSOFT = providerAuthservIds("outlook.office365.com");
  /** Microsoft's consumer domain: its own postmaster reports, so the domain is the property. */
  const OUTLOOK = "outlook.com";
  const EXCHANGE = '"Microsoft Outlook" <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@own.invalid>';

  it("on a Microsoft mailbox, Microsoft's own reports of the person's mail reach the Ohbox, recorded", async () => {
    const w = await world({ trusted: MICROSOFT });
    const tenant = await w.deliver("ndr-1@own.invalid", dsn({ id: "ndr-1@own.invalid", inReplyTo: OURS, from: EXCHANGE }));
    const consumer = await w.deliver("ndr-2@outlook.invalid", dsn({
      id: "ndr-2@outlook.invalid", inReplyTo: OURS, from: `"Microsoft Outlook" <postmaster@${OUTLOOK}>`,
    }));
    expect([tenant.desired, consumer.desired]).toEqual(["INBOX", "INBOX"]);
    expect(await w.admissions()).toEqual([
      { messageId: tenant.id, header: OURS }, { messageId: consumer.id, header: OURS },
    ]);
  });

  it("CONTROL: on a Microsoft mailbox, a report under ANOTHER brand's name is held", async () => {
    const w = await world({ trusted: MICROSOFT });
    const report = await w.deliver("dsn-6@their-host.invalid", dsn({
      id: "dsn-6@their-host.invalid", inReplyTo: OURS, from: '"PostFinance" <MAILER-DAEMON@their-host.invalid>',
    }));
    expect(report.desired).toBe("ohmail/Screener");
  });

  it("CONTROL: on a Gmail mailbox, a report under Microsoft's name from a stranger's domain is held", async () => {
    // At a domain that is not the account's own: the organisation's own reports are the next block.
    const w = await world({ trusted: providerAuthservIds("imap.gmail.com") });
    const report = await w.deliver("ndr-3@own.invalid", dsn({
      id: "ndr-3@own.invalid", inReplyTo: OURS, from: EXCHANGE.replace("@own.invalid", "@stranger.invalid"),
    }));
    expect(report.desired).toBe("ohmail/Screener");
    expect(await w.admissions()).toEqual([]);
  });
});

describe("the account's own organisation reports at its own domain, whatever the provider map says", () => {
  const TENANT = '"Microsoft Outlook" <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@contoso.invalid>';
  const EXCHANGE = '"Microsoft Outlook" <MicrosoftExchange329e71ec88ae4615bbc36ab6ce41109e@own.invalid>';
  const MICROSOFT = providerAuthservIds("outlook.office365.com");
  /** Microsoft's consumer domain: its own postmaster reports, so the domain is the property. */
  const OUTLOOK = "outlook.com";
  const DAVMAIL = providerAuthservIds("127.0.0.1");

  it("Exchange's report at the mailbox's own domain, with no provider named, reaches the Ohbox, recorded and unmarked", async () => {
    const w = await world();
    const ndr = await w.deliver("ndr-ms@own.invalid", dsn({ id: "ndr-ms@own.invalid", inReplyTo: OURS, from: EXCHANGE }));
    expect(ndr.desired).toBe("INBOX");
    expect(await w.admissions()).toEqual([{ messageId: ndr.id, header: OURS }]);
    expect(ndr.check, "the organisation's own name is not a claim").toBe("none");
  });

  it("a Microsoft mailbox through DavMail (127.0.0.1): the tenant's report reaches the Ohbox", async () => {
    expect(DAVMAIL.size, "the provider map names no loopback host").toBe(0);
    const w = await world({ trusted: DAVMAIL, address: "alice@contoso.invalid" });
    const ndr = await w.deliver("ndr-dm@contoso.invalid", dsn({ id: "ndr-dm@contoso.invalid", inReplyTo: OURS, from: TENANT }));
    expect(ndr.desired).toBe("INBOX");
    expect(await w.admissions()).toEqual([{ messageId: ndr.id, header: OURS }]);
  });

  it("CONTROL: on that mailbox, Microsoft's name from ANOTHER domain stays held", async () => {
    const w = await world({ trusted: DAVMAIL, address: "alice@contoso.invalid" });
    const ndr = await w.deliver("ndr-st@stranger.invalid", dsn({
      id: "ndr-st@stranger.invalid", inReplyTo: OURS, from: '"Microsoft Outlook" <postmaster@stranger.invalid>',
    }));
    expect(ndr.desired).toBe("ohmail/Screener");
    expect(ndr.check).toBe("impersonation");
    expect(await w.admissions()).toEqual([]);
  });

  // Only the mail system's own name is the organisation's: any other company's name at the own domain is a
  // claim anybody holding one of the person's Message-IDs can forge where the verdict is not "fail".
  const OTHER_BRAND: Array<[string, ReadonlySet<string>, string[]]> = [
    ["through DavMail", DAVMAIL, []],
    ["on a Google Workspace mailbox, dmarc=none", providerAuthservIds("imap.gmail.com"),
      ["Authentication-Results: mx.google.com; spf=pass smtp.mailfrom=attacker.invalid; dkim=pass header.d=attacker.invalid; dmarc=none header.from=contoso.invalid"]],
    ["on a Microsoft mailbox", MICROSOFT, []],
  ];
  for (const [where, trusted, headers] of OTHER_BRAND) {
    it(`another company's name at the own domain keeps its fact and waits, ${where}`, async () => {
      const w = await world({ trusted, address: "alice@contoso.invalid" });
      const ndr = await w.deliver("ndr-pp@contoso.invalid", dsn({
        id: "ndr-pp@contoso.invalid", inReplyTo: OURS, from: '"PayPal" <service@contoso.invalid>', headers,
      }));
      expect(ndr.desired).toBe("ohmail/Screener");
      expect(ndr.check, "the Not PayPal warning stays").toBe("impersonation");
      expect(await w.admissions()).toEqual([]);
    });
  }

  it("CONTROL: an address at a shared provider is no organisation: another brand's name there stays held", async () => {
    const w = await world({ trusted: DAVMAIL, address: personalAt("fixture.nadja", "gmail.com") });
    const ndr = await w.deliver("ndr-sh@gmail.invalid", dsn({
      id: "ndr-sh@gmail.invalid", inReplyTo: OURS, from: `"PayPal" <${personalAt("fixture.ndr", "gmail.com")}>`,
    }));
    expect(ndr.desired, "everybody at gmail.com shares the domain").toBe("ohmail/Screener");
    expect(await w.admissions()).toEqual([]);
  });

  it("CONTROL: the organisation's report that FAILED authentication stays held", async () => {
    const w = await world({ trusted: MICROSOFT, address: "alice@contoso.invalid" });
    const ndr = await w.deliver("ndr-fa@contoso.invalid", dsn({
      id: "ndr-fa@contoso.invalid", inReplyTo: OURS, from: TENANT,
      headers: ["Authentication-Results: mx.microsoft.com; dmarc=fail header.from=contoso.invalid"],
    }));
    expect(ndr.desired).toBe("ohmail/Screener");
    expect(ndr.check, "a forgery of the domain keeps its fact").toBe("impersonation");
  });
});

/**
 * THE PERSON'S OWN HOSTER'S REPORT OF THEIR LETTER, unsigned at a mailbox no provider id names (mail
 * 0176's bounce arm): a daemon at the registrable domain of the mailbox's own outgoing server reaches the
 * Ohbox, recorded, its stored verdict and fact as they were, so the reader's line (`unverified`, read
 * off the two) still says nothing confirmed it. The same report at a mailbox that submits elsewhere, and
 * a forged company report, wait, marked.
 */
describe("the person's own hoster's report of their letter, unsigned, at an unmapped mailbox", () => {
  /** The hoster's and the forged company's own domains are the property, so they come from consts. */
  const [OVH_OUT, PAYPAL] = ["mail-out.ovh.net", "paypal.com"];
  const OVH = `MAILER-DAEMON@mo1.${OVH_OUT}`;

  it("through the outgoing server the mailbox stores: lifted, recorded, the verdict the line reads kept", async () => {
    const w = await world({ servers: { imap: { host: "imap.example-host.test" }, smtp: { host: "ssl0.ovh.net" } } });
    const ndr = await w.deliver(`ovh-1@${OVH_OUT}`, dsn({ id: `ovh-1@${OVH_OUT}`, inReplyTo: OURS, from: OVH }));
    expect(ndr).toMatchObject({ desired: "INBOX", held: false, auth: "unavailable", check: "none" });
    expect(await w.admissions()).toEqual([{ messageId: ndr.id, header: OURS }]);
  });

  it("with no outgoing row, through the incoming server the send door dials then", async () => {
    const w = await world({ servers: { imap: { host: "ssl0.ovh.net" } } });
    const ndr = await w.deliver(`ovh-2@${OVH_OUT}`, dsn({ id: `ovh-2@${OVH_OUT}`, inReplyTo: OURS, from: OVH, quoted: true }));
    expect(ndr).toMatchObject({ desired: "INBOX", held: false });
  });

  it("CONTROL: at a mailbox submitting elsewhere, and from a company's address forged, the report waits marked", async () => {
    const elsewhere = await world({ servers: { smtp: { host: "mail.infomaniak.com" } } });
    const ndr = await elsewhere.deliver(`ovh-3@${OVH_OUT}`, dsn({ id: `ovh-3@${OVH_OUT}`, inReplyTo: OURS, from: OVH }));
    expect(ndr).toMatchObject({ desired: "ohmail/Screener", held: true, auth: "unavailable" });
    const forged = await world({ servers: { smtp: { host: "ssl0.ovh.net" } } });
    const pp = await forged.deliver(`pp-1@${PAYPAL}`, dsn({ id: `pp-1@${PAYPAL}`, inReplyTo: OURS, from: `postmaster@${PAYPAL}` }));
    expect(pp).toMatchObject({ desired: "ohmail/Screener", held: true });
    expect(await forged.admissions()).toEqual([]);
  });
});
