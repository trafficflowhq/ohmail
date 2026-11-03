import { describe, it, expect } from "vitest";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "../src/pipeline.js";
import { mintMessageId, foldMessageIdDomain } from "../src/mail.js";
import { parseMessageIds } from "../src/threading.js";
import { FakeRepo, FakeAdapter } from "./fakes.js";
import type { Change, PipelineDeps } from "../src/ports.js";

/**
 * ═══ THE REPORT THAT CLASSIFIES IS THE REPORT THAT STAMPS ══════════════════════════════════
 *
 * ── THE COLUMN THAT EXISTED WITH NOTHING IN IT ─────────────────────────────────────────────
 *
 * `away_sender_state.undeliverable_at` is what stops the bounce loop: a correspondent whose
 * address refuses mail is answered once and never again. In managed production it held many rows
 * and ZERO stamps. Its only producer was a periodic scan in the away pass that matched the
 * minted id against the report's `In-Reply-To` and `References` — and RFC 3462 puts the failed
 * message's headers in a `message/rfc822-headers` PART, which reaches neither of those columns.
 * The scan looked in the one place the evidence is not.
 *
 * The ingest path had already read the raw bytes by then (`dsnVerdict`) and already knew the
 * report was ours (`isOwnAwayReply`) — it filed it to `ohmail/Receipts` on the strength of it.
 * So the producer is that classification, and this file is the wiring between them: the SAME
 * predicate decides where the report is filed and that the address is dead, because they are one
 * fact and two readings of one condition is how they could ever disagree.
 *
 * ── THE CASE ARM ───────────────────────────────────────────────────────────────────────────
 *
 * `mintMessageId` did not fold the domain it was handed, which comes straight off
 * `mailboxes.address`. A mailbox stored `you@Example.COM` minted `<uuid@Example.COM>`, the report
 * quoted it back verbatim, `parseMessageIds` kept the case (it does — `normalizeMessageId` keeps
 * `id-left` on purpose), and the lookup compared it against a lower-cased column and missed. The
 * whole feature was silently off for those mailboxes: the bounce read as a stranger's mail and
 * nobody was ever stamped. Both halves now go through `foldMessageIdDomain`.
 */

const CORRESPONDENT = "correspondent@elsewhere.example";

function bounce(opts: { quotes: string; id?: string; from?: string }): Buffer {
  return Buffer.from([
    `Message-ID: <${opts.id ?? "dsn-1"}@their-host.example>`,
    `From: ${opts.from ?? "MAILER-DAEMON@their-host.example"}`,
    "To: reader@lichtgrat.example",
    "Subject: Undelivered Mail Returned to Sender",
    `X-Failed-Recipients: ${CORRESPONDENT}`,
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Your message could not be delivered.",
    "",
    "--b1",
    "Content-Type: message/delivery-status",
    "",
    `Final-Recipient: rfc822; ${CORRESPONDENT}`,
    "Action: failed",
    "Status: 5.1.1",
    "",
    "--b1",
    "Content-Type: message/rfc822-headers",
    "",
    // THE ONLY PLACE THE MINTED ID EXISTS in a report of this shape — not `In-Reply-To`.
    `Message-ID: ${opts.quotes}`,
    "From: reader@lichtgrat.example",
    "Auto-Submitted: auto-replied",
    "Subject: Away from mail",
    "",
    "--b1--",
  ].join("\r\n"));
}

/** An ordinary message from the same person. Same sender, no report shape, no minted id. */
function ordinary(id: string): Buffer {
  return Buffer.from([
    `Message-ID: <${id}@elsewhere.example>`,
    `From: ${CORRESPONDENT}`,
    "To: reader@lichtgrat.example",
    "Subject: are you back yet",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Just checking in.",
  ].join("\r\n"));
}

/** An away reply already sent to {@link CORRESPONDENT}, with a state row to stamp. */
function world(minted: string): PipelineDeps & { repo: FakeRepo } {
  const repo = new FakeRepo();
  repo.senders.add(CORRESPONDENT);
  const key = foldMessageIdDomain(minted.slice(1, -1));
  repo.awayReplyMintedIds.add(key);
  repo.awayReplySenderOf.set(key, CORRESPONDENT);
  repo.awaySenders.add(CORRESPONDENT);
  return { repo, adapter: new FakeAdapter(), accountId: "acct-1", mailboxId: "mb-1" };
}

async function ingest(
  d: PipelineDeps & { repo: FakeRepo }, raw: Buffer, ref: string,
): Promise<string> {
  const change: Change = { type: "create", locator: { folder: "INBOX", ref }, raw };
  const plan = await planChange(change, {
    repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId, readerMode: false,
  });
  const res = await commitChange(plan, {
    repo: d.repo, accountId: d.accountId, mailboxId: d.mailboxId,
    storageCap: UNMETERED_STORAGE_CAP,
  });
  return (await d.repo.getFolderState(res.messageId))!.desiredFolder;
}

describe("the DSN that files as a receipt is the DSN that stamps the sender", () => {
  it("stamps exactly one correspondent, and files the report out of the Ohbox", async () => {
    const minted = mintMessageId("lichtgrat.example");
    const d = world(minted);

    expect(await ingest(d, bounce({ quotes: minted }), "1:1")).toBe("ohmail/Receipts");
    expect([...d.repo.awayUndeliverable.keys()]).toEqual([CORRESPONDENT]);
  });

  it("a SECOND report for the same correspondent does not move the instant", async () => {
    const minted = mintMessageId("lichtgrat.example");
    const d = world(minted);

    await ingest(d, bounce({ quotes: minted, id: "dsn-1" }), "1:1");
    const first = d.repo.awayUndeliverable.get(CORRESPONDENT)!;
    expect(first).toBeInstanceOf(Date);

    // A different report, same failed reply. "When did we learn this" must stay true.
    await ingest(d, bounce({ quotes: minted, id: "dsn-2" }), "1:2");
    expect(d.repo.awayUndeliverable.get(CORRESPONDENT)!.getTime()).toBe(first.getTime());
    expect(d.repo.awayUndeliverable.size).toBe(1);
  });

  it("ORDINARY mail from the same person stamps nobody", async () => {
    const minted = mintMessageId("lichtgrat.example");
    const d = world(minted);

    expect(await ingest(d, ordinary("hello-1"), "1:1")).not.toBe("ohmail/Receipts");
    expect(d.repo.awayUndeliverable.size).toBe(0);
  });

  it("a report quoting an id this account never minted stamps nobody", async () => {
    const d = world(mintMessageId("lichtgrat.example"));

    await ingest(d, bounce({ quotes: "<not-ours-1@elsewhere.example>" }), "1:1");
    expect(d.repo.awayUndeliverable.size).toBe(0);
  });

  it("the person's own hoster's unsigned report files and stamps; another company's report does neither", async () => {
    // Nothing confirms either sender at a mailbox no provider id names; only the first is the hoster's daemon.
    const minted = mintMessageId("lichtgrat.example");
    const hoster = world(minted);
    hoster.repo.outgoing.set(hoster.mailboxId, { smtpHost: "ssl0.ovh.net", address: "reader@lichtgrat.example" });
    expect(await ingest(hoster, bounce({ quotes: minted, from: "MAILER-DAEMON@mo1.mail-out.ovh.net" }), "1:1"))
      .toBe("ohmail/Receipts");
    expect([...hoster.repo.awayUndeliverable.keys()]).toEqual([CORRESPONDENT]);

    const forged = world(minted);
    forged.repo.outgoing.set(forged.mailboxId, { smtpHost: "ssl0.ovh.net", address: "reader@lichtgrat.example" });
    expect(await ingest(forged, bounce({ quotes: minted, from: "postmaster@paypal.com" }), "1:1")).toBe("ohmail/Screener");
    expect(forged.repo.awayUndeliverable.size).toBe(0);
  });
});

describe("the minted id's domain is folded, so a mixed-case mailbox is not silently exempt", () => {
  it("the mint lower-cases the domain and leaves id-left alone", () => {
    const minted = mintMessageId("Example.COM");
    expect(minted.endsWith("@example.com>")).toBe(true);
    // `id-left` is a `randomUUID()`, and RFC 5322 makes it case-SENSITIVE — never folded.
    expect(foldMessageIdDomain("AbC@Example.COM")).toBe("AbC@example.com");
  });

  it("a report quoting a capitalised domain still stamps, through parseMessageIds", async () => {
    // A LEGACY reply, minted before the fold, quoted back in its own case — which is what a
    // report carries and what `parseMessageIds` hands the reader, unfolded.
    const minted = "<9f3b2c1d-0000-4000-8000-000000000001@Example.COM>";
    const d = world(minted);

    const quoted = parseMessageIds([`Message-ID: ${minted}`]);
    expect(quoted, "parseMessageIds folds case — it does not, and the reader must not assume it")
      .toEqual(["9f3b2c1d-0000-4000-8000-000000000001@Example.COM"]);

    expect(await ingest(d, bounce({ quotes: minted }), "1:1")).toBe("ohmail/Receipts");
    expect([...d.repo.awayUndeliverable.keys()]).toEqual([CORRESPONDENT]);
  });
});
