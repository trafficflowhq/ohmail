import { describe, it, expect } from "vitest";
import { planChange, commitChange , UNMETERED_STORAGE_CAP} from "../src/pipeline.js";
import { dsnVerdict } from "../src/rules.js";
import { normalizeMime } from "../src/mime.js";
import { TAXONOMY_PREFIX } from "../src/classify-prompt.js";
import { FakeRepo, FakeAdapter } from "./fakes.js";
import type { Change, PipelineDeps } from "../src/ports.js";
import type { PlanDeps } from "../src/pipeline.js";
import { providerAuthservIds } from "../src/authserv-ids.js";
import { ownedSenderName } from "../src/sender-check.js";

/**
 * ═══ A BOUNCE OF YOUR OWN MAIL REACHES YOU; BACKSCATTER DOES NOT ══════════════════════════
 *
 * ── THE TWO FAILURES, WHICH ARE OPPOSITES ────────────────────────────────────────────────
 *
 * You send a message, it is refused, and the delivery report arrives from
 * `MAILER-DAEMON@their-host` — a sender you have never corresponded with. The consent gate does
 * exactly what it is for and files it in `ohmail/Screener`, so the one message that says "your
 * mail did not arrive" is the one message held back, at precisely the moment it is still
 * actionable.
 *
 * The naive fix is worse than the bug. `Content-Type: multipart/report;
 * report-type=delivery-status` is a string anybody can type, and BACKSCATTER — a spammer forging
 * your address, a real MTA rejecting it, a real bounce landing in your mailbox — satisfies every
 * property of "shape" while having nothing to do with you. Routing on shape alone is a remote,
 * unauthenticated, one-message defeat of the consent boundary, which is the exact class of
 * defect `pipeline.ts` records having already fixed once for `sensitivity.sensitive`.
 *
 * So every test below is one of those two directions, and BOTH are guarded. A file that only
 * proved bounces get through would be a file that certified the bypass.
 *
 * ── MUTATIONS WATCHED ────────────────────────────────────────────────────────────────────
 *
 *  · `ownBounce = true` (shape alone) ⇒ all three anti-backscatter cases red;
 *  · drop the `citesOwnWriting` lookup ⇒ "a report quoting our own Message-ID" red at
 *    `ohmail/Screener`;
 *  · the lookup back to `findThreadParent` (any row of the account) ⇒ "a report citing a
 *    STRANGER's held message" red: the stranger chose that id and their own mail carries it;
 *  · `admitBounce = ownBounce` (dropping the `matchedRuleId === null` half) ⇒ "a quarantined
 *    sender cannot free themselves" red;
 *  · drop `authVerdict !== "fail"` or the brand term from `liftable` ⇒ the failed-authentication
 *    or the brand-claim case red; widen the own-provider exemption to every brand ⇒ the other-brand
 *    cases red;
 *  · a `verdictOf` that drops the raw argument ⇒ the id cases red, which is why the helper
 *    passes both.
 *
 * `X-Failed-Recipients` is not read at all: it is a header the report's sender writes, and the
 * address it would be checked against is a contact for everyone who ever posted to a list.
 */

const OURS = "<sent-42@lichtgrat.example>";

/** The report itself: DSN-shaped, from a daemon nobody has consented to. */
function bounce(opts: {
  quotes?: string;
  failed?: string;
  from?: string;
  contentType?: string;
  inReplyTo?: string;
  headers?: string[];
} = {}): Buffer {
  const {
    quotes,
    failed,
    from = "MAILER-DAEMON@their-host.example",
    contentType = 'multipart/report; report-type=delivery-status; boundary="b1"',
  } = opts;
  return Buffer.from([
    "Message-ID: <dsn-1@their-host.example>",
    `From: ${from}`,
    "To: mila@lichtgrat.example",
    "Subject: Undelivered Mail Returned to Sender",
    ...(failed ? [`X-Failed-Recipients: ${failed}`] : []),
    ...(opts.inReplyTo ? [`In-Reply-To: ${opts.inReplyTo}`] : []),
    ...(opts.headers ?? []),
    `Content-Type: ${contentType}`,
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This is the mail system at their-host.example.",
    "Your message could not be delivered.",
    "",
    "--b1",
    "Content-Type: message/rfc822-headers",
    "",
    ...(quotes ? [`Message-ID: ${quotes}`] : []),
    "From: mila@lichtgrat.example",
    "Subject: the original",
    "",
    "--b1--",
  ].join("\r\n"));
}

/** The message the account actually sent, so a report can quote something we hold. */
function ourSent(): Buffer {
  return Buffer.from([
    `Message-ID: ${OURS}`,
    "From: mila@lichtgrat.example",
    "To: recipient@elsewhere.example",
    "Subject: the original",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body of the message we sent.",
  ].join("\r\n"));
}

function makeDeps(): PipelineDeps & { repo: FakeRepo; adapter: FakeAdapter } {
  return { repo: new FakeRepo(), adapter: new FakeAdapter(), accountId: "acct-1", mailboxId: "mb-1" };
}

const createChange = (folder: string, raw: Buffer, ref = "1:10"): Change =>
  ({ type: "create", locator: { folder, ref }, raw });

/** Ingest, and answer with the folder the pipeline decided on. */
async function desiredFolderOf(
  raw: Buffer, d: ReturnType<typeof makeDeps>, ref = "1:11", extra: Partial<PlanDeps> = {},
): Promise<string> {
  const plan = await planChange(createChange("INBOX", raw, ref), {
    repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, ...extra,
  });
  const res = await commitChange(plan, {
    storageCap: UNMETERED_STORAGE_CAP,
    repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId,
  });
  return (await d.repo.getFolderState(res.messageId))!.desiredFolder;
}

/**
 * Put the account's own outgoing message in the mirror, so its Message-ID is one we hold. It
 * carries the server's arrival, as every copy the Sent folder serves does: only writing after the
 * consent point is the account's own.
 */
async function seedOurSent(d: ReturnType<typeof makeDeps>): Promise<void> {
  const plan = await planChange(
    {
      type: "create", locator: { folder: "Sent", ref: "2:1" }, raw: ourSent(), ownAuthored: true,
      internalDate: new Date("2026-09-22T15:12:00.000Z"),
    },
    { repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId },
  );
  await commitChange(plan, { repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, storageCap: UNMETERED_STORAGE_CAP });
}

describe("dsnVerdict — the SHAPE half, which decides nothing on its own", () => {
  // BOTH ARGUMENTS, exactly as `planChange` calls it: the quoted original lives in a
  // `message/rfc822-headers` part, which the parser does not flatten into `textBody`, so a
  // parsed-only call finds no ids at all. A helper that dropped `raw` would have made every
  // corroboration test below pass for the wrong reason — by never corroborating anything.
  const verdictOf = async (raw: Buffer) => dsnVerdict(await normalizeMime(raw), raw);

  it("recognises the RFC 3462 content type", async () => {
    expect(await verdictOf(bounce())).not.toBeNull();
  });

  it("recognises a daemon local-part even without the content type", async () => {
    // Plenty of MTAs send a plain-text bounce. `postmaster` is RFC 5321 §4.5.1's own reserved
    // local-part, so the two names are the closed set rather than a guess at a naming habit.
    for (const who of ["MAILER-DAEMON@x.example", "postmaster@x.example", "Postmaster@x.example"]) {
      const v = await verdictOf(bounce({ from: who, contentType: "text/plain; charset=utf-8" }));
      expect(v, who).not.toBeNull();
    }
  });

  it("is NULL for ordinary mail, whatever its subject claims", async () => {
    const ordinary = Buffer.from([
      "Message-ID: <n-1@example.com>",
      "From: stranger@example.com",
      "To: mila@lichtgrat.example",
      "Subject: Undelivered Mail Returned to Sender",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "delivery-status report-type=delivery-status multipart/report",
    ].join("\r\n"));
    // The words are in the BODY, which is a place a stranger writes. Only the structured
    // header and the sender's local-part count as shape.
    expect(await verdictOf(ordinary)).toBeNull();
  });

  it("is NULL for multipart/report that is NOT a delivery status (an MDN, a feedback report)", async () => {
    const v = await verdictOf(bounce({
      from: "reports@x.example",
      contentType: 'multipart/report; report-type=disposition-notification; boundary="b1"',
    }));
    expect(v, "a read receipt was read as a bounce").toBeNull();
  });

  it("collects the quoted Message-IDs, in the form the column stores them", async () => {
    const v = await verdictOf(bounce({ quotes: OURS }));
    // BRACKET-FREE and lower-cased, because that is how `messages.message_id_header` is
    // written and these strings exist only to be compared against it. `parseMessageIds` is
    // the shared definition; a second normaliser here would agree until it did not.
    expect(v!.originalMessageIds).toContain("sent-42@lichtgrat.example");
  });

  it("does NOT offer the report's OWN id as a claim about an original", () => {
    // It sits in the raw bytes this function scans, it can never match a message we hold, and
    // it would consume one of the ten lookup slots. Worse: once the report itself is ingested,
    // a self-reference would start looking like corroboration.
    return verdictOf(bounce({ quotes: OURS })).then((v) => {
      expect(v!.originalMessageIds).not.toContain("dsn-1@their-host.example");
    });
  });

  it("does not read X-Failed-Recipients — the report's sender writes it", async () => {
    // Checked against the account's contacts it was public evidence: a list address is a contact
    // for everybody who posted to it. The quoted ids are the only claim this answers.
    const v = await verdictOf(bounce({ failed: "<Recipient@Elsewhere.example>, other@x.example" }));
    expect(Object.keys(v!)).toEqual(["originalMessageIds"]);
  });

  it("bounds what a stranger's body can contribute to a lookup", async () => {
    // The body is attacker-controlled and feeds an `IN (…)`. Ten ids, from the first 8 KB.
    const many = Array.from({ length: 60 }, (_, i) => `<flood-${i}@x.example>`).join("\r\n");
    const v = await verdictOf(bounce({ quotes: many }));
    expect(v!.originalMessageIds.length).toBeLessThanOrEqual(10);
  });
});

describe("BOUNCE — the report reaches the Ohbox only on evidence the sender cannot forge", () => {
  it("a report quoting OUR OWN Message-ID goes to INBOX, though the daemon is a stranger", async () => {
    const d = makeDeps();
    await seedOurSent(d);
    // The daemon is NOT a known sender and has no rule. Without the bounce arm this is a
    // textbook first-contact sender and the gate holds it.
    expect(await desiredFolderOf(bounce({ quotes: OURS }), d)).toBe("INBOX");
  });

  it("X-Failed-Recipients naming somebody we CORRESPOND WITH proves nothing on its own", async () => {
    // The header is a string the report's sender writes, and a list address is a contact for
    // everyone who posted to it. A report naming only a failed recipient waits at the Screener.
    const d = makeDeps();
    d.repo.senders.add("recipient@elsewhere.example");
    expect(await desiredFolderOf(bounce({ failed: "recipient@elsewhere.example" }), d)).toBe("ohmail/Screener");
  });

  it("a report citing a STRANGER's held message is held — only our own Sent copy is evidence", async () => {
    const d = makeDeps();
    // The stranger's first mail, held at the gate: its Message-ID is one THEY chose.
    const held = Buffer.from([
      "Message-ID: <m1@evil.invalid>", "From: someone@evil.invalid", "To: mila@lichtgrat.example",
      "Subject: hello", "Content-Type: text/plain; charset=utf-8", "", "hi",
    ].join("\r\n"));
    expect(await desiredFolderOf(held, d, "1:5")).toBe("ohmail/Screener");
    const folder = await desiredFolderOf(bounce({ from: "postmaster@evil.invalid", inReplyTo: "<m1@evil.invalid>" }), d);
    expect(folder, "a stranger's own message id carried their report past the gate").toBe("ohmail/Screener");
  });

  it("a report citing our own copy that FAILED authentication is held", async () => {
    const d = makeDeps();
    await seedOurSent(d);
    const trusted = { trustedAuthservIds: new Set(["mx.google.com"]) };
    const failed = bounce({
      quotes: OURS, headers: ["Authentication-Results: mx.google.com; dmarc=fail header.from=their-host.example"],
    });
    expect(await desiredFolderOf(failed, d, "1:11", trusted)).toBe("ohmail/Screener");
  });

  it("CONTROL: the same report with the provider's PASS is lifted — the reader is live, not blind", async () => {
    const d = makeDeps();
    await seedOurSent(d);
    const passed = bounce({
      quotes: OURS, headers: ["Authentication-Results: mx.google.com; dmarc=pass header.from=their-host.example"],
    });
    expect(await desiredFolderOf(passed, d, "1:12", { trustedAuthservIds: new Set(["mx.google.com"]) })).toBe("INBOX");
  });

  it("a report citing our own copy under a BRAND's name is held — a lifted bounce carries no claim", async () => {
    const d = makeDeps();
    await seedOurSent(d);
    const folder = await desiredFolderOf(bounce({ quotes: OURS, from: '"PostFinance" <MAILER-DAEMON@their-host.example>' }), d);
    expect(folder).toBe("ohmail/Screener");
  });

  /* THE MAILBOX'S OWN PROVIDER WRITES ITS REPORTS UNDER ITS OWN NAME: Microsoft's carry "Microsoft
     Outlook" at a tenant's MicrosoftExchange… address, at postmaster@outlook.com or at Hotmail. That
     is the provider's report, not a claim — for the mailbox that provider holds, and only for it. */
  const MICROSOFT = { trustedAuthservIds: providerAuthservIds("outlook.office365.com") };
  const GMAIL = { trustedAuthservIds: providerAuthservIds("imap.gmail.com") };
  const EXCHANGE = '"Microsoft Outlook" <MicrosoftExchange5e1f0c2a9b8d4e7f8a6b3c2d1e0f9a8b@lichtgrat.example>';

  it("on a Microsoft mailbox, Microsoft's own reports of the person's mail reach the Ohbox", async () => {
    for (const [i, from] of [EXCHANGE, '"Microsoft Outlook" <postmaster@outlook.com>', '"Microsoft Outlook" <postmaster@hotmail.com>'].entries()) {
      const d = makeDeps();
      await seedOurSent(d);
      expect(await desiredFolderOf(bounce({ quotes: OURS, from }), d, `1:2${i}`, MICROSOFT), from).toBe("INBOX");
    }
  });

  it("CONTROL: on a Microsoft mailbox, a report under ANOTHER brand's name is held", async () => {
    const d = makeDeps();
    await seedOurSent(d);
    const folder = await desiredFolderOf(
      bounce({ quotes: OURS, from: '"PostFinance" <MAILER-DAEMON@their-host.example>' }), d, "1:11", MICROSOFT);
    expect(folder).toBe("ohmail/Screener");
  });

  it("CONTROL: on a Gmail mailbox, a report under Microsoft's name is another brand's, and held", async () => {
    const d = makeDeps();
    await seedOurSent(d);
    expect(await desiredFolderOf(bounce({ quotes: OURS, from: EXCHANGE }), d, "1:11", GMAIL)).toBe("ohmail/Screener");
  });

  it("CONTROL: Gmail's own Mail Delivery Subsystem report reaches the Ohbox on a Gmail mailbox", async () => {
    const d = makeDeps();
    await seedOurSent(d);
    const folder = await desiredFolderOf(
      bounce({ quotes: OURS, from: '"Mail Delivery Subsystem" <mailer-daemon@googlemail.com>' }), d, "1:11", GMAIL);
    expect(folder).toBe("INBOX");
  });

  it("CONTROL: Microsoft's own report that FAILED authentication is held, provider or not", async () => {
    const d = makeDeps();
    await seedOurSent(d);
    const failed = bounce({
      quotes: OURS, from: EXCHANGE,
      headers: ["Authentication-Results: mx.microsoft.com; dmarc=fail header.from=lichtgrat.example"],
    });
    expect(await desiredFolderOf(failed, d, "1:11", MICROSOFT)).toBe("ohmail/Screener");
  });

  /* A COMPANY'S OWN ADDRESS NOTHING CONFIRMED (mail 0176) is no report this arm lifts: a forger who
     holds one of the person's Message-IDs writes a perfect report from it as easily as a letter. */
  const COMPANY = "service@paypal.com";
  const PAYPAL_PASS = "Authentication-Results: mx.google.com; dkim=pass header.d=paypal.com; dmarc=pass header.from=paypal.com";

  it("a report from a company's own address nothing confirmed is held, the act's admission or none", async () => {
    const acted = makeDeps();
    await seedOurSent(acted);
    acted.repo.rules.push({
      id: "act", kind: "sender", match: COMPANY, destination: "INBOX", effect: "allow", priority: 10,
      provenance: "promoted", enabled: true, subjectContains: null, bodyContains: null,
    });
    acted.repo.senders.add(COMPANY);
    acted.repo.inferredSenders.add(COMPANY);
    expect(await desiredFolderOf(bounce({ quotes: OURS, from: COMPANY }), acted)).toBe("ohmail/Screener");
    const stranger = makeDeps();
    await seedOurSent(stranger);
    expect(await desiredFolderOf(bounce({ quotes: OURS, from: "postmaster@paypal.com" }), stranger)).toBe("ohmail/Screener");
  });

  it("CONTROL: the company's report its provider confirmed, or from an address a person let in, is lifted", async () => {
    const mapped = makeDeps();
    await seedOurSent(mapped);
    const confirmed = bounce({ quotes: OURS, from: "postmaster@paypal.com", headers: [PAYPAL_PASS] });
    expect(await desiredFolderOf(confirmed, mapped, "1:11", GMAIL)).toBe("INBOX");
    const person = makeDeps();
    await seedOurSent(person);
    person.repo.senders.add(COMPANY);
    expect(await desiredFolderOf(bounce({ quotes: OURS, from: COMPANY }), person)).toBe("INBOX");
  });

  /* THE PERSON'S OWN HOSTER'S REPORT OF THEIR LETTER is lifted though nothing confirmed it: a daemon role
     at the registrable domain of the mailbox's own outgoing server or of its own address, or at another
     domain of the company owning that one. Its stored verdict stays, so the reader keeps the did-not-confirm
     line. Every other company address still waits. */
  const HOSTERS: ReadonlyArray<[string, string]> = [
    ["MAILER-DAEMON@mo1.mail-out.ovh.net", "ssl0.ovh.net"],
    ["MAILER-DAEMON@spool.mail.gandi.net", "mail.gandi.net"],
    // Infomaniak's preset submits at its .com and its relays report from its .ch: one company's two domains.
    ["MAILER-DAEMON@smtp-1.mail.infomaniak.ch", "mail.infomaniak.com"],
    ["MAILER-DAEMON@asmtp010.mail.hostpoint.ch", "asmtp.mail.hostpoint.ch"],
  ];
  /** A mailbox whose outgoing server and own address are stored as given. */
  const hosted = (smtpHost: string | null, address: string | null = "mila@lichtgrat.example") => {
    const d = makeDeps();
    d.repo.outgoing.set(d.mailboxId, { smtpHost, address });
    return d;
  };
  /** Ingest, and answer with the folder, the stored verdict and the hold's mark. */
  const stored = async (raw: Buffer, d: ReturnType<typeof makeDeps>) => {
    const plan = await planChange(createChange("INBOX", raw, "1:11"), { repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId });
    const res = await commitChange(plan, { storageCap: UNMETERED_STORAGE_CAP, repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId });
    const input = d.repo.rows.get(res.messageId)!.input;
    return { folder: (await d.repo.getFolderState(res.messageId))!.desiredFolder, auth: input.authVerdict, held: input.unconfirmedHold === true };
  };

  it("the person's own hoster's unsigned report of their letter reaches the Ohbox, its verdict kept for the line", async () => {
    for (const [from, smtpHost] of HOSTERS) {
      expect(ownedSenderName(from), `premise: ${from} is a company's own address`).toBeDefined();
      const d = hosted(smtpHost);
      await seedOurSent(d);
      expect(await stored(bounce({ quotes: OURS, from }), d), from).toEqual({ folder: "INBOX", auth: "unavailable", held: false });
    }
    // The organisation of the mailbox's own address reports the same way, whatever server it submits through.
    const own = hosted(null, "anna@paypal.com");
    await seedOurSent(own);
    expect(await stored(bounce({ quotes: OURS, from: "postmaster@mx1.paypal.com" }), own))
      .toEqual({ folder: "INBOX", auth: "unavailable", held: false });
  });

  it("every other company's report still waits: forged PayPal, another hoster's daemon, the hoster's other roles", async () => {
    for (const from of ["postmaster@paypal.com", "Postmaster@PayPal.com", COMPANY]) {
      const d = hosted("ssl0.ovh.net");
      await seedOurSent(d);
      expect(await stored(bounce({ quotes: OURS, from }), d), from).toEqual({ folder: "ohmail/Screener", auth: "unavailable", held: true });
    }
    // Each hoster's daemon is that hoster's: OVH's report at a mailbox that submits through Infomaniak waits.
    const other = hosted("mail.infomaniak.com");
    await seedOurSent(other);
    expect((await stored(bounce({ quotes: OURS, from: HOSTERS[0]![0] }), other)).folder).toBe("ohmail/Screener");
    // Only the daemon roles: anybody else at the hoster writes letters as any company's address does.
    const role = hosted("ssl0.ovh.net");
    await seedOurSent(role);
    expect((await stored(bounce({ quotes: OURS, from: "support@mail-out.ovh.net" }), role)).folder).toBe("ohmail/Screener");
    // Nothing stored about the mailbox: nothing is the person's hoster.
    const none = hosted(null, null);
    await seedOurSent(none);
    expect((await stored(bounce({ quotes: OURS, from: HOSTERS[0]![0] }), none)).folder).toBe("ohmail/Screener");
  });

  it("CONTROL: a daemon at a host no company owns is lifted as before, and the hoster's backscatter is held", async () => {
    const d = hosted("ssl0.ovh.net");
    await seedOurSent(d);
    expect(await stored(bounce({ quotes: OURS }), d)).toEqual({ folder: "INBOX", auth: "unavailable", held: false });
    const scatter = hosted("ssl0.ovh.net");
    await seedOurSent(scatter);
    expect((await stored(bounce({ quotes: "<spammers-own-id@spam.example>", from: HOSTERS[0]![0] }), scatter)).folder)
      .toBe("ohmail/Screener");
    // Asked only for a report the gate would hold for want of confirmation.
    expect(d.repo.outgoingCalls + scatter.repo.outgoingCalls).toBe(0);
  });

  it("BACKSCATTER — a perfectly formed report about mail we never sent is held at the gate", async () => {
    // The whole shape is right: real content type, real daemon, real quoted Message-ID. The one
    // thing it cannot have is a Message-ID this account has ever held.
    const d = makeDeps();
    await seedOurSent(d);
    const folder = await desiredFolderOf(bounce({ quotes: "<spammers-own-id@spam.example>" }), d);
    expect(folder, "shape alone carried a stranger past the consent gate").toBe("ohmail/Screener");
  });

  it("X-Failed-Recipients naming a STRANGER proves nothing — the header is a string they write", async () => {
    const d = makeDeps();
    const folder = await desiredFolderOf(bounce({ failed: "nobody@we-never-wrote-to.example" }), d);
    expect(folder, "a forged header was accepted as own-send evidence").toBe("ohmail/Screener");
  });

  it("a bare DSN with NO claim at all is held — no ids, no recipients, no evidence", async () => {
    const d = makeDeps();
    expect(await desiredFolderOf(bounce(), d)).toBe("ohmail/Screener");
  });

  it("a QUARANTINED sender cannot free themselves by sending a well-formed bounce", async () => {
    // The user's own explicit "no", which a corroborated bounce must not override. This is the
    // `deniedByConsent` guard, and it is the same one `sensitivity.sensitive` takes for the same
    // reason: sensitivity and DSN shape both refine placement and neither establishes consent.
    const d = makeDeps();
    await seedOurSent(d);
    d.repo.rules.push({
      id: "deny-1", kind: "sender", match: "mailer-daemon@their-host.example",
      destination: "ohmail/Quarantine", effect: "deny", priority: 100,
      provenance: "manual", enabled: true,
    });
    const folder = await desiredFolderOf(bounce({ quotes: OURS, from: "mailer-daemon@their-host.example" }), d);
    expect(folder, "an explicit user denial was overridden by the sender").toBe("ohmail/Quarantine");
  });

  it("ordinary mail is untouched — the arm costs nothing and changes nothing for it", async () => {
    const d = makeDeps();
    const ordinary = Buffer.from([
      "Message-ID: <ord-1@example.com>",
      "From: stranger@example.com",
      "To: mila@lichtgrat.example",
      "Subject: hello",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "hi",
    ].join("\r\n"));
    expect(await desiredFolderOf(ordinary, d)).toBe("ohmail/Screener");
  });
});

describe("the model is told the same thing, in the taxonomy's own vocabulary", () => {
  it("the classify prefix names a delivery-status report for the reader's own mail as INBOX", () => {
    // For the residue that reaches the model at all: a report the lookups could not corroborate,
    // or a human-written "could not be delivered" with no DSN structure. It is a relevance
    // instruction and not a routing override — the model's answer is still a proposal that
    // cannot carry a first-contact sender past the Screener.
    expect(TAXONOMY_PREFIX).toContain("delivery-status report");
    expect(TAXONOMY_PREFIX).toContain("own outgoing mail");
    expect(TAXONOMY_PREFIX).toContain("INBOX");
  });
});
