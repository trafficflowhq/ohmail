import { describe, expect, it } from "vitest";
import { planChange, commitChange, UNMETERED_STORAGE_CAP, type PlanDeps } from "../src/pipeline.js";
import { evaluateRules, type KnownSenders, type Rule } from "../src/rules.js";
import { claimedIdentity } from "../src/sender-check.js";
import { normalizeMime } from "../src/mime.js";
import { FakeRepo, FakeRouting } from "./fakes.js";
import type { Change } from "../src/ports.js";

/**
 * A LIST ADDRESS THE PERSON POSTED TO IS NOT A PERSON (mail 0150). Anyone on a mailing list writes
 * as its address, so writing to it once must not consent every company name a member puts on it.
 * `List-Post` names the address on every stored inbound message that did not fail authentication;
 * from then on only a brand a person's own press admitted there yields the identity hold, never a
 * contact or a rule. And a Sent copy written to a list address is public, so a delivery report
 * citing it is no bounce of the account's own mail. Every address here is `.invalid`.
 */

const ME = "me@own.invalid";
const LIST = "list@lists.invalid";
const MEMBER = "member@elsewhere.invalid";
const FRIEND = "friend@corr.invalid";
const CUT = new Date("2026-09-01T00:00:00.000Z");
const AFTER = new Date("2026-09-22T15:12:00.000Z");
const LIST_POST = `List-Post: <mailto:${LIST}>`;
const LIST_ID = "List-Id: The Lists <lists.lists.invalid>";

function eml(o: { from: string; to: string; messageId: string; subject?: string; extra?: string[] }): Buffer {
  return Buffer.from([
    `Message-ID: <${o.messageId}>`, `From: ${o.from}`, `To: ${o.to}`,
    `Subject: ${o.subject ?? "Spring meeting"}`, ...(o.extra ?? []),
    "Content-Type: text/plain; charset=utf-8", "", "See you there.",
  ].join("\r\n"));
}

const sent = (raw: Buffer, ref = "1:10"): Change =>
  ({ type: "create", locator: { folder: "Sent", ref }, raw, seen: true, ownAuthored: true, internalDate: AFTER });
let uid = 100;
const inbox = (raw: Buffer, more: Partial<Change> = {}): Change =>
  ({ type: "create", locator: { folder: "INBOX", ref: `1:${uid++}` }, raw, seen: false, internalDate: AFTER, ...more });

function setup() {
  const repo = new FakeRepo();
  repo.correspondenceSince = CUT;
  return { repo, routing: new FakeRouting() };
}

async function ingest(s: ReturnType<typeof setup>, change: Change, extra: Partial<PlanDeps> = {}) {
  const plan = await planChange(change, {
    repo: s.repo, accountId: "acct-1", mailboxId: "mb-1", readerMode: false, routing: s.routing,
    correspondenceSince: CUT, ...extra,
  });
  const res = await commitChange(plan, {
    repo: s.repo, routing: s.routing, accountId: "acct-1", mailboxId: "mb-1", storageCap: UNMETERED_STORAGE_CAP,
  });
  return { plan, res };
}

/** The person's post to the list, the list's own mail carrying `List-Post`, and the spoof. */
const post = () => sent(eml({ from: ME, to: LIST, messageId: "post-1@own.invalid" }));
const listMail = (n = 1) => inbox(eml({ from: MEMBER, to: LIST, messageId: `l-${n}@elsewhere.invalid`, extra: [LIST_POST, LIST_ID] }));
const spoof = (brand: string, n = 1) => inbox(eml({
  from: `"${brand}" <${LIST}>`, to: ME, messageId: `spoof-${n}@lists.invalid`, subject: "Ihre Karte",
}));

describe("a list address is not a person — through the pipeline (FakeRepo)", () => {
  it("ACCEPTANCE 1a: post, then the list's mail, then a company claim under the list address — held", async () => {
    const s = setup();
    await ingest(s, post());
    expect(s.repo.senders.has(LIST), "the post taught the list address, as any recipient").toBe(true);
    const thread = await ingest(s, listMail());
    expect(thread.plan.new!.desired, "a member's new thread is a stranger's, held").toBe("ohmail/Screener");
    const { plan } = await ingest(s, spoof("PostFinance"));
    expect(plan.new!.desired).toBe("ohmail/Screener");
    expect(plan.new!.senderCheck?.brand).toBe("PostFinance");
    expect([...s.repo.lists.keys()]).toEqual([LIST]);
  });

  it("ACCEPTANCE 1a: an open import's document view asks this store's list addresses too", async () => {
    const s = setup();
    await ingest(s, post());
    await ingest(s, listMail());
    // The travelling document knows the list address as a person and states no list facts.
    const importHold = { kind: "document" as const, rules: [], knownSenders: {
      addresses: new Set([LIST]), inferred: new Set<string>(), lists: new Map<string, ReadonlySet<string>>(),
    } };
    const { plan } = await ingest(s, spoof("PostFinance", 7), { importHold });
    expect(plan.new!.desired, "the document's view kept a claim under a list address in place").toBe("ohmail/Screener");
    expect(plan.new!.passive).toBeUndefined();
  });

  it("ACCEPTANCE 1b: the list's mail first, the post second — still held", async () => {
    const s = setup();
    await ingest(s, listMail());
    await ingest(s, post());
    const { plan } = await ingest(s, spoof("PostFinance"));
    expect(plan.new!.desired).toBe("ohmail/Screener");
  });

  it("CONTROL: the same address with no list mail stored is a person this account wrote to — admitted", async () => {
    const s = setup();
    await ingest(s, post());
    const { plan } = await ingest(s, spoof("PostFinance"));
    expect(plan.new!.desired, "nothing names it a list yet: the person's consent stands").not.toBe("ohmail/Screener");
  });

  it("CONTROL: the list address's own mail with no claim is placed by its headers, untouched by the fact", async () => {
    const s = setup();
    await ingest(s, post());
    await ingest(s, listMail());
    const { plan } = await ingest(s, inbox(eml({ from: LIST, to: ME, messageId: "l-own@lists.invalid", extra: [LIST_POST, LIST_ID] })));
    expect(plan.new!.desired).toBe("ohmail/News");
  });

  it("ACCEPTANCE 1c: the reader arm carries and records the list addresses", async () => {
    const s = setup();
    const { plan } = await ingest(s, listMail(), { readerMode: true });
    expect(plan.new!.passive).toBe(true);
    expect(plan.new!.listAddresses).toEqual([LIST]);
    expect(s.repo.lists.has(LIST)).toBe(true);
  });

  it("ACCEPTANCE 1c: the passive arm (a folder the person filed into) carries and records them", async () => {
    const s = setup();
    const { plan } = await ingest(s, { ...listMail(), locator: { folder: "Clubs", ref: "9:1" }, passive: true });
    expect(plan.new!.passive).toBe(true);
    expect(plan.new!.listAddresses).toEqual([LIST]);
    expect(s.repo.lists.has(LIST)).toBe(true);
  });

  it("ACCEPTANCE 1c: the list relaying the person's own letter unchanged (received_copy) records the address", async () => {
    const s = setup();
    const letter = eml({ from: ME, to: LIST, messageId: "post-2@own.invalid" });
    await ingest(s, sent(letter));
    const echo = Buffer.concat([Buffer.from(`${LIST_POST}\r\n`), letter]);
    const { plan } = await ingest(s, inbox(echo));
    expect(plan.outcome).toBe("received_copy");
    expect(plan.receivedCopy!.listAddresses).toEqual([LIST]);
    expect(s.repo.lists.has(LIST)).toBe(true);
  });

  it("CONTROL: the person's own Sent copy names no list address, whatever it carries", async () => {
    const s = setup();
    const { plan } = await ingest(s, sent(eml({ from: ME, to: LIST, messageId: "post-3@own.invalid", extra: [LIST_POST] })));
    expect(plan.new!.listAddresses).toEqual([]);
    expect(s.repo.lists.size).toBe(0);
  });

  it("ACCEPTANCE 1g: a stranger's HELD mail naming an address in List-Post records it, and no contact", async () => {
    const s = setup();
    const { plan } = await ingest(s, inbox(eml({
      from: "someone@stranger.invalid", to: ME, messageId: "x-1@stranger.invalid", extra: [`List-Post: <mailto:${FRIEND}>`],
    })));
    expect(plan.new!.desired).toBe("ohmail/Screener");
    expect(s.repo.lists.has(FRIEND)).toBe(true);
    expect(s.repo.senders.has(FRIEND), "a header is never a contact").toBe(false);
  });

  it("LOW-4: a List-Post naming the account's own address records nothing, in the plan and in the store", async () => {
    const s = setup();
    s.repo.own.add(ME);
    const { plan } = await ingest(s, inbox(eml({
      from: "someone@stranger.invalid", to: ME, messageId: "x-own@stranger.invalid",
      extra: [`List-Post: <mailto:${ME}>`, `List-Post: <mailto:${FRIEND}>`],
    })), { ownAddresses: new Set([ME]) });
    expect(plan.new!.listAddresses, "the plan").toEqual([FRIEND]);
    expect([s.repo.lists.has(ME), s.repo.lists.has(FRIEND)], "the store").toEqual([false, true]);
    // A page the sync reads no own addresses for (a reader's, a passive folder's): the store's door alone.
    const t = setup();
    t.repo.own.add(ME);
    await ingest(t, inbox(eml({
      from: "someone@stranger.invalid", to: ME, messageId: "x-own-2@stranger.invalid", extra: [`List-Post: <mailto:${ME}>`],
    })));
    expect(t.repo.lists.has(ME), "the store's own door, with the plan not knowing").toBe(false);
  });

  it("ACCEPTANCE 1g: the same mail FAILING authentication records nothing", async () => {
    const s = setup();
    const { plan } = await ingest(s, inbox(eml({
      from: "someone@stranger.invalid", to: ME, messageId: "x-2@stranger.invalid", extra: [
        `List-Post: <mailto:${FRIEND}>`,
        "Authentication-Results: mx.google.com; dmarc=fail header.from=stranger.invalid",
      ],
    })), { trustedAuthservIds: new Set(["mx.google.com"]) });
    expect(plan.new!.authVerdict).toBe("fail");
    expect(plan.new!.listAddresses).toEqual([]);
    expect(s.repo.lists.size).toBe(0);
  });
});

/**
 * THE LETTER THAT REVEALS A LIST ADDRESS IS JUDGED AS A LIST LETTER (R32-01). The person wrote to
 * `list@` and nothing has named it a list yet; its first company claim carries `List-Post` naming
 * itself. Ingest records that row at commit, after the gate, so the letter read as a person's.
 */
const revealing = (brand: string, n: number) => inbox(eml({
  from: `"${brand}" <${LIST}>`, to: ME, messageId: `rev-${n}@lists.invalid`, subject: "Ihre Karte", extra: [LIST_POST, LIST_ID],
}));

describe("the first claim through a list address the person wrote to (FakeRepo)", () => {
  it("R32-01: the letter naming its own address in List-Post is held at its own plan, and recorded", async () => {
    const s = setup();
    await ingest(s, post());
    const { plan } = await ingest(s, revealing("PostFinance", 1));
    expect(plan.new!.desired, "judged as a person's before its own commit named the list").toBe("ohmail/Screener");
    expect(plan.new!.senderCheck?.brand).toBe("PostFinance");
    expect(plan.new!.listAddresses).toEqual([LIST]);
    expect([...s.repo.lists.keys()]).toEqual([LIST]);
  });

  it("R32-01: an open import's document view judges it as a list letter too", async () => {
    const s = setup();
    await ingest(s, post());
    const importHold = { kind: "document" as const, rules: [], knownSenders: {
      addresses: new Set([LIST]), inferred: new Set<string>(), lists: new Map<string, ReadonlySet<string>>(),
    } };
    const { plan } = await ingest(s, revealing("PostFinance", 2), { importHold });
    expect(plan.new!.desired, "the document's view kept the revealing claim in place").toBe("ohmail/Screener");
    expect(plan.new!.passive).toBeUndefined();
  });

  it("CONTROL: a brand a press consented there stands for a letter naming the address itself", async () => {
    const s = setup();
    await ingest(s, post());
    s.repo.lists.set(LIST, new Set(["PostFinance"]));
    expect((await ingest(s, revealing("PostFinance", 3))).plan.new!.desired).not.toBe("ohmail/Screener");
    expect((await ingest(s, revealing("Swisscom", 4))).plan.new!.desired).toBe("ohmail/Screener");
  });

  it("CONTROL: a person's claim naming another address in List-Post keeps the person's consent", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: FRIEND, messageId: "private-3@own.invalid" }), "1:11"));
    const { plan } = await ingest(s, inbox(eml({
      from: `"PostFinance" <${FRIEND}>`, to: LIST, messageId: "fr-1@corr.invalid", extra: [LIST_POST, LIST_ID],
    })));
    expect(plan.new!.desired).not.toBe("ohmail/Screener");
    expect(plan.new!.listAddresses).toEqual([LIST]);
  });
});

/** A list address in punycode: the parser hands the gate its From in Unicode, and so is the list read. */
const IDN_LIST = "list@xn--bcher-kva.invalid";
const IDN_POST = `List-Post: <mailto:${IDN_LIST}>`;
const idnClaim = (n: number, extra: string[] = []) => inbox(eml({
  from: `"PostFinance" <${IDN_LIST}>`, to: ME, messageId: `idn-${n}@lists.invalid`, subject: "Ihre Karte", extra,
}));

describe("an internationalised list address is one list (FakeRepo)", () => {
  it("a post to the list, its mail, then a company claim under it — held", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: IDN_LIST, messageId: "idn-post-1@own.invalid" })));
    await ingest(s, inbox(eml({ from: MEMBER, to: IDN_LIST, messageId: "idn-l-1@elsewhere.invalid", extra: [IDN_POST, LIST_ID] })));
    const { plan } = await ingest(s, idnClaim(1));
    expect(plan.new!.desired, "a punycode List-Post never matched the Unicode From").toBe("ohmail/Screener");
    expect(plan.new!.senderCheck?.brand).toBe("PostFinance");
  });

  it("the claim naming the list in its own List-Post is held at its own plan", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: IDN_LIST, messageId: "idn-post-2@own.invalid" })));
    const { plan } = await ingest(s, idnClaim(2, [IDN_POST, LIST_ID]));
    expect(plan.new!.desired, "a punycode List-Post never matched the Unicode From").toBe("ohmail/Screener");
    expect(plan.new!.listAddresses).toEqual(["list@bücher.invalid"]);
  });
});

/** A delivery report citing `id` in its own In-Reply-To. */
const dsn = (id: string, n: number) => inbox(Buffer.from([
  `Message-ID: <dsn-${n}@their-host.invalid>`, "From: MAILER-DAEMON@their-host.invalid", `To: ${ME}`,
  "Subject: Undelivered Mail Returned to Sender", `In-Reply-To: <${id}>`,
  'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"', "",
  "--b1", "Content-Type: text/plain; charset=utf-8", "", "Your message could not be delivered.", "",
  "--b1", "Content-Type: message/rfc822-headers", "", `Message-ID: <${id}>`, `From: ${ME}`, "", "--b1--",
].join("\r\n")));

describe("a copy written to a list address is public — the bounce arm (FakeRepo)", () => {
  it("ACCEPTANCE 1i: a report citing a copy written to a list address waits, by neither arm", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: LIST, messageId: "post-9@own.invalid" })));
    await ingest(s, listMail());
    const { plan } = await ingest(s, dsn("post-9@own.invalid", 1));
    expect(plan.new!.desired).toBe("ohmail/Screener");
    expect(plan.new!.bounceAdmission).toBeUndefined();
    expect(plan.new!.correspondentAdmission, "a report is never an answer").toBeUndefined();
  });

  it("CONTROL: a report citing a PRIVATE copy is the bounce arm's and reaches the Ohbox", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: FRIEND, messageId: "private-1@own.invalid" })));
    await ingest(s, listMail());
    const { plan } = await ingest(s, dsn("private-1@own.invalid", 2));
    expect(plan.new!.desired).toBe("INBOX");
    expect(plan.new!.bounceAdmission).toEqual({ header: "private-1@own.invalid" });
    expect(plan.new!.correspondentAdmission).toBeUndefined();
  });

  it("CONTROL: an answer citing the list post from a member is admitted untaught, as before", async () => {
    const s = setup();
    await ingest(s, sent(eml({ from: ME, to: LIST, messageId: "post-8@own.invalid" })));
    await ingest(s, listMail());
    const { plan } = await ingest(s, inbox(eml({
      from: "other-member@elsewhere.invalid", to: LIST, messageId: "re-1@elsewhere.invalid",
      extra: ["In-Reply-To: <post-8@own.invalid>"],
    })));
    expect(plan.new!.desired).not.toBe("ohmail/Screener");
    expect(plan.new!.correspondentAdmission).toMatchObject({ via: "replied", named: false });
    expect(s.repo.senders.has("other-member@elsewhere.invalid")).toBe(false);
  });
});

/** The gate itself, over a hand-built `KnownSenders`: which consent a list address keeps. */
async function gate(o: { from: string; rules?: Rule[]; person?: string[]; lists?: Record<string, string[]> }) {
  const msg = await normalizeMime(eml({ from: o.from, to: ME, messageId: `g-${uid++}@lists.invalid`, extra: [LIST_ID] }));
  const known: KnownSenders = {
    addresses: new Set(o.person ?? []), inferred: new Set(),
    lists: new Map(Object.entries(o.lists ?? {}).map(([a, b]) => [a, new Set(b)])),
  };
  return evaluateRules({
    msg, rules: o.rules ?? [], knownSenders: known, auth: "unauthenticated", ohboxPolicy: "people_and_replied",
    ownAddresses: new Set([ME]),
    identity: claimedIdentity({ fromName: msg.from.name, fromAddress: msg.from.address, subject: msg.subject }) ?? null,
  });
}
const allow = (provenance: Rule["provenance"], destination: Rule["destination"] = "INBOX"): Rule => ({
  id: `r-${provenance}`, kind: "sender", match: LIST, destination, effect: "allow", priority: 0, provenance, enabled: true,
  subjectContains: null, bodyContains: null,
});

describe("the gate: only a brand a person's press consented under a list address yields", () => {
  for (const provenance of ["seeded-from-sent", "manual", "migrated", "promoted"] as const) {
    it(`ACCEPTANCE 1e: a ${provenance} rule naming the list address consents no claim under it`, async () => {
      const d = await gate({ from: `"PostFinance" <${LIST}>`, rules: [allow(provenance)], person: [LIST], lists: { [LIST]: [] } });
      expect(d.destination).toBe("ohmail/Screener");
      expect(d.identity?.brand).toBe("PostFinance");
    });
  }

  it("ACCEPTANCE 1e: a manual rule filing the list to News still places its ordinary mail", async () => {
    const d = await gate({ from: LIST, rules: [allow("manual", "ohmail/News")], person: [LIST], lists: { [LIST]: [] } });
    expect(d).toMatchObject({ destination: "ohmail/News", source: "rule" });
  });

  it("ACCEPTANCE 1f: a consented brand is admitted, another brand under the same address waits", async () => {
    const lists = { [LIST]: ["PostFinance"] };
    expect((await gate({ from: `"PostFinance" <${LIST}>`, person: [LIST], lists })).destination).not.toBe("ohmail/Screener");
    // Swisscom, not UBS: a bare "UBS" display name reads no claim at all (`gateShort`), so it proves nothing here.
    expect((await gate({ from: `"Swisscom" <${LIST}>`, person: [LIST], lists })).destination).toBe("ohmail/Screener");
  });

  it("CONTROL: a person this account wrote to, not a list address, keeps consent for a claim", async () => {
    const d = await gate({ from: `"PostFinance" <${FRIEND}>`, person: [FRIEND] });
    expect(d.destination).not.toBe("ohmail/Screener");
  });
});
