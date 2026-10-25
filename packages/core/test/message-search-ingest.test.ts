import { describe, it, expect } from "vitest";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "../src/pipeline.js";
import { searchBodyOf, searchDocumentOf, SEARCH_BODY_MAX_CHARS, SEARCH_HEAD_PART_MAX_CHARS, SEARCH_TERMS_MAX_CHARS } from "../src/message-search.js";
import { htmlToPlainText } from "../src/html-text.js";
import { bodyBytesOf } from "@trafficflow/db";
import { FakeRepo } from "./fakes.js";
import type { Change } from "../src/ports.js";

/**
 * THE INGEST HALF OF THE SEARCH DOCUMENT (mail 0125): the pipeline writes it from the PARSED
 * message in the commit, whatever the storage cap decided, and the metering is untouched.
 */

function eml(o: { id: string; subject: string; text?: string; html?: string; to?: string }): Buffer {
  const head = [
    `Message-ID: <${o.id}>`, "From: Anna Weber <anna@club.example>", `To: ${o.to ?? "Claims Desk <claims@axa.example>"}`,
    `Subject: ${o.subject}`,
  ];
  if (o.html !== undefined && o.text === undefined) {
    return Buffer.from([...head, "Content-Type: text/html; charset=utf-8", "", o.html].join("\r\n"));
  }
  return Buffer.from([...head, "Content-Type: text/plain; charset=utf-8", "", o.text ?? ""].join("\r\n"));
}

async function ingest(repo: FakeRepo, raw: Buffer, storageCap: number | typeof UNMETERED_STORAGE_CAP): Promise<string> {
  const change: Change = { type: "create", locator: { folder: "INBOX", ref: "1:1" }, raw, seen: true };
  const plan = await planChange(change, { repo, accountId: "acct-1", mailboxId: "mb-1", readerMode: false });
  const res = await commitChange(plan, { repo, accountId: "acct-1", mailboxId: "mb-1", storageCap });
  return (res as { messageId: string }).messageId;
}

describe("the pipeline writes the search document", () => {
  it("from the parsed message: subject, sender, recipients and the body words", async () => {
    const repo = new FakeRepo();
    const id = await ingest(repo, eml({ id: "a@x", subject: "Quarterly letter", text: "Please find the letter." }), UNMETERED_STORAGE_CAP);
    const doc = repo.searchDocs.get(id)!;
    expect(doc.subject).toBe("Quarterly letter");
    expect(doc.from?.address).toBe("anna@club.example");
    expect(doc.to.map((a) => a.address)).toEqual(["claims@axa.example"]);
    expect(doc.source).toBe("text");
    expect(doc.bodyText).toContain("Please find the letter.");
  });

  it("AT THE CAP: the body is withheld, the document still carries its words", async () => {
    const repo = new FakeRepo();
    repo.storedBytes.set("acct-1", 10);
    const id = await ingest(repo, eml({ id: "b@x", subject: "Over the cap", text: "the withheld words are findable" }), 1);
    expect(repo.withheld.has(id)).toBe(true);
    expect(repo.searchDocs.get(id)?.bodyText).toContain("the withheld words are findable");
  });

  it("an HTML-only message is indexed by its words, with no stylesheet among them", async () => {
    // The parser renders a text part from the html at ingest; a row stored before that (text
    // empty, html present) is the backfill's `html` source — `search-index-backfill.pg.test.ts`.
    const repo = new FakeRepo();
    const id = await ingest(repo, eml({ id: "c@x", subject: "Sale", html: "<html><head><style>.zorblatt{color:red}</style></head><body><p>quintessence sale</p></body></html>" }), UNMETERED_STORAGE_CAP);
    const doc = repo.searchDocs.get(id)!;
    expect(["text", "html"]).toContain(doc.source);
    expect(doc.bodyText).toContain("quintessence sale");
    expect(doc.bodyText).not.toContain("zorblatt");
  });
});

describe("the document's parts", () => {
  it("text first, then html, then nothing — and a render that throws is headers_only", () => {
    expect(searchBodyOf("words", "<p>other</p>").source).toBe("text");
    expect(searchBodyOf("   ", "<p>other</p>")).toEqual({ bodyText: "other", source: "html" });
    expect(searchBodyOf("", null)).toEqual({ bodyText: "", source: "headers_only" });
    expect(searchBodyOf("", "<style>x</style>")).toEqual({ bodyText: "", source: "headers_only" });
  });

  it("bounds the body and the substring corpus, and lower-cases the corpus", () => {
    const { parts, terms } = searchDocumentOf({
      accountId: "a", subject: "MyAXA Portal", from: { name: "Anna", address: "anna@axa.example" },
      to: [], cc: [], attachmentNames: ["Policy.PDF"], bodyText: "x".repeat(SEARCH_BODY_MAX_CHARS + 10), source: "text",
    });
    expect(parts.body).toBe(`${"x".repeat(SEARCH_BODY_MAX_CHARS)}\nPolicy PDF`);
    expect(terms).toBe("myaxa portal anna anna@axa.example policy.pdf");
    expect(parts.people).toContain("axa example");
    const long = searchDocumentOf({
      accountId: "a", subject: "s".repeat(5000), from: null, to: [], cc: [], attachmentNames: [], bodyText: "", source: "headers_only",
    });
    expect(long.terms.length).toBe(SEARCH_TERMS_MAX_CHARS);
  });

  it("writes each file name's parts as words of the text, after the body; the head and the substring corpus keep the names whole", () => {
    const { parts, terms } = searchDocumentOf({
      accountId: "a", subject: "Papers", from: null, to: [], cc: [], bodyText: "See attached.", source: "text",
      attachmentNames: ["harbour-ledger-7731.pdf", "PDFReport_v2.docx", "scan0042.PDF", "README", "x7k2q9w4.bin"],
    });
    expect(parts.attachments).toBe("harbour-ledger-7731.pdf PDFReport_v2.docx scan0042.PDF README x7k2q9w4.bin");
    expect(parts.body).toBe("See attached.\nharbour ledger 7731 pdf PDFReport Report v2 docx scan0042 scan 0042 README x7k2q9w4 bin");
    expect(terms).toBe("papers harbour-ledger-7731.pdf pdfreport_v2.docx scan0042.pdf readme x7k2q9w4.bin");
  });

  it("splits only what fits in a head part's ceiling, however many or long the names", () => {
    const many = Array.from({ length: 5000 }, (_, i) => `ledger-${i}.pdf`);
    const { parts } = searchDocumentOf({
      accountId: "a", subject: "", from: null, to: [], cc: [], bodyText: "", source: "headers_only",
      attachmentNames: [...many, `${"q".repeat(SEARCH_HEAD_PART_MAX_CHARS)}-tailword.pdf`],
    });
    const words = parts.body.slice(1).split(" ");
    expect(parts.body.length).toBeLessThanOrEqual(SEARCH_HEAD_PART_MAX_CHARS + 1);
    expect(words.slice(0, 4)).toEqual(["ledger", "0", "pdf", "1"]);
    // Whole words only, in order, and only from the names the head part holds: about the first 1,100.
    expect(new Set(words).size).toBe(words.length);
    expect(Number(words.at(-1))).toBeGreaterThan(1000);
    expect(Number(words.at(-1))).toBeLessThan(1100);
    expect(words).not.toContain("tailword");
    // The same name over and over: its parts written once, the head part at its ceiling.
    const same = searchDocumentOf({
      accountId: "a", subject: "", from: null, to: [], cc: [], bodyText: "", source: "headers_only",
      attachmentNames: Array.from({ length: 10_000 }, () => "scan0042.PDF"),
    });
    expect(same.parts.body).toBe("\nscan0042 scan 0042 PDF");
    expect(same.parts.attachments.length).toBe(SEARCH_HEAD_PART_MAX_CHARS);
  });

  it("is NOT metered: a body's stored bytes do not count the document", () => {
    expect(bodyBytesOf({ text: "abc", html: null })).toBe(3);
  });

  it("the moved renderer still renders the outbound grammar exactly", () => {
    expect(htmlToPlainText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
    expect(htmlToPlainText("<head><title>t</title></head><p>body</p>")).toBe("body");
  });
});
