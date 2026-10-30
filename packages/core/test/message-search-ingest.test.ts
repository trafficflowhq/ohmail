import { describe, it, expect } from "vitest";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "../src/pipeline.js";
import { searchBodyOf, searchDocumentOf, SEARCH_BODY_MAX_CHARS, SEARCH_TERMS_MAX_CHARS } from "../src/message-search.js";
import { htmlToPlainText, htmlWords } from "../src/html-text.js";
import { bodyBytesOf } from "@trafficflow/db";
import { FakeRepo } from "./fakes.js";
import { normalizeMime } from "../src/mime.js";
import type { Change } from "../src/ports.js";

/**
 * THE INGEST HALF OF THE SEARCH DOCUMENT (mail 0125): the pipeline writes it from the PARSED
 * message in the commit, whatever the storage cap decided, and the metering is untouched.
 */

function eml(o: { id: string; subject: string; text?: string; html?: string; to?: string; related?: boolean }): Buffer {
  const head = [
    `Message-ID: <${o.id}>`, "From: Anna Weber <anna@club.example>", `To: ${o.to ?? "Claims Desk <claims@axa.example>"}`,
    `Subject: ${o.subject}`,
  ];
  if (o.related) {
    return Buffer.from([...head, 'Content-Type: multipart/related; boundary="R"', "", "--R", "Content-Type: text/html; charset=utf-8", "",
      o.html ?? "", "--R", "Content-Type: image/png", "Content-ID: <pic@x>", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=",
      "--R--", ""].join("\r\n"));
  }
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

describe("a letter with pictures and no text part", () => {
  const html = '<html><head><style>.zorblatt{color:red}</style></head><body>'
    + '<div style="display:none">Preview filler</div><table><tr><td>Spring</td><td>sale</td></tr></table>'
    + '<div>Twenty percent</div><div>off <a href="https://shop.example/x">everything</a></div><img src="cid:pic@x"></body></html>';
  const raw = (): Buffer => eml({ id: "pics@x", subject: "Sale", html, related: true });

  it("stores the html's words as its text and snippet, and is found by them", async () => {
    const repo = new FakeRepo();
    const id = await ingest(repo, raw(), UNMETERED_STORAGE_CAP);
    expect(repo.bodies.get(id)?.text).toBe("Spring sale\n\nTwenty percent\noff everything");
    expect(repo.rows.get(id)?.input.snippet).toBe("Spring sale Twenty percent off everything");
    const doc = repo.searchDocs.get(id)!;
    expect(doc.bodyText).toBe("Spring sale\n\nTwenty percent\noff everything");
    expect(doc.bodyText).not.toMatch(/zorblatt|Preview|https:/);
  });

  it("a row stored before the words, under that build's key, is found again and not stored twice", async () => {
    const repo = new FakeRepo();
    // The key the code before this change computed for `raw()`.
    const before = "fp1:60b122cd2fad76849d2c5170ad4201417a6340419b13f44a57d7980cce6c7dad";
    const parsed = await normalizeMime(raw());
    await repo.insertMessage({
      accountId: "acct-1", mailboxId: "mb-1", dedupKey: before, nativeLocator: { folder: "INBOX", ref: "1:1" },
      canonical: parsed.canonical, subject: parsed.subject, fromAddress: parsed.from.address,
    } as unknown as Parameters<FakeRepo["insertMessage"]>[0]);
    const id = await ingest(repo, raw(), UNMETERED_STORAGE_CAP);
    expect(repo.rows.size).toBe(1);
    expect(repo.rows.get(id)?.stored.dedupKey).toBe(before);
  });
});

describe("the document's parts", () => {
  it("text first, then html, then nothing — and a render that throws is headers_only", () => {
    expect(searchBodyOf("words", "<p>other</p>").source).toBe("text");
    expect(searchBodyOf("   ", "<p>other</p>")).toEqual({ bodyText: "other", source: "html" });
    expect(searchBodyOf("", null)).toEqual({ bodyText: "", source: "headers_only" });
    expect(searchBodyOf("", "<style>x</style>")).toEqual({ bodyText: "", source: "headers_only" });
  });

  it("a stored html's words are what ingest stores now: no glued cells or lines, nothing hidden", () => {
    expect(searchBodyOf("", "<div>Line one</div><div>Line two</div>").bodyText).toBe("Line one\nLine two");
    expect(searchBodyOf("", "<table><tr><td>Hello</td><td>World</td></tr><tr><td>Second</td></tr></table>").bodyText)
      .toBe("Hello World\nSecond");
    expect(searchBodyOf("", '<p>shown</p><span style="color:red;display : none!important">hidden</span>').bodyText).toBe("shown");
  });

  it("bounds the body and the substring corpus, and lower-cases the corpus", () => {
    const { parts, terms } = searchDocumentOf({
      accountId: "a", subject: "MyAXA Portal", from: { name: "Anna", address: "anna@axa.example" },
      to: [], cc: [], attachmentNames: ["Policy.PDF"], bodyText: "x".repeat(SEARCH_BODY_MAX_CHARS + 10), source: "text",
    });
    expect(parts.body.length).toBe(SEARCH_BODY_MAX_CHARS);
    expect(terms).toBe("myaxa portal anna anna@axa.example policy.pdf");
    expect(parts.people).toContain("axa example");
    const long = searchDocumentOf({
      accountId: "a", subject: "s".repeat(5000), from: null, to: [], cc: [], attachmentNames: [], bodyText: "", source: "headers_only",
    });
    expect(long.terms.length).toBe(SEARCH_TERMS_MAX_CHARS);
  });

  it("is NOT metered: a body's stored bytes do not count the document", () => {
    expect(bodyBytesOf({ text: "abc", html: null })).toBe(3);
  });

  it("the moved renderer still renders the outbound grammar exactly", () => {
    expect(htmlToPlainText("<ul><li>one</li><li>two</li></ul>")).toBe("- one\n- two");
    expect(htmlToPlainText("<head><title>t</title></head><p>body</p>")).toBe("body");
  });
});

describe("htmlWords, the words of an inbound html part", () => {
  it("breaks lines at blocks, keeps pre and quotes, and gives a link its text alone", () => {
    expect(htmlWords("<h1>Title</h1><p>One</p><p>Two<br>three</p><ul><li>a</li><li>b</li></ul>")).toBe("Title\n\nOne\n\nTwo\nthree\n\na\nb");
    expect(htmlWords("<pre>  x = 1\n  y = 2</pre>")).toBe("  x = 1\n  y = 2");
    expect(htmlWords("<p>Hi</p><blockquote><p>quoted</p></blockquote>")).toBe("Hi\n\n> quoted");
    expect(htmlWords('<a href="https://x.example/long">the post</a> <img alt="Logo" src="x.png">')).toBe("the post");
  });

  it("skips what the reader never draws, but draws a hidden attribute", () => {
    expect(htmlWords("<title>T</title><svg><text>vector</text></svg><select><option>opt</option></select><script>s()</script>ok")).toBe("ok");
    expect(htmlWords('<div style="display:none">a<div>b</div></div><p hidden>drawn</p>')).toBe("drawn");
  });

  it("drops preheader filler tokens but keeps joiners inside words", () => {
    expect(htmlWords("<p>Hi \u034f\u200c \u034f\u200c \u200b there</p>")).toBe("Hi there");
    expect(htmlWords("<p>\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 \ud83d\udc68\u200d\ud83d\udcbb</p>"))
      .toBe("\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645 \ud83d\udc68\u200d\ud83d\udcbb");
    expect(htmlWords("<p>\u034f&zwnj;</p><div>\u00ad</div>")).toBe("");
  });

  it("reads a bounded head and returns a bounded text, never half a surrogate pair", () => {
    expect(htmlWords("<p>a</p>".repeat(100_000)).length).toBeLessThanOrEqual(65_536);
    const cut = htmlWords("x" + "\ud83d\ude00".repeat(40_000));
    expect(cut.length).toBe(65_535);
    expect(cut.endsWith("\ud83d\ude00")).toBe(true);
    expect(htmlWords("<p>head</p>" + " ".repeat(262_144) + "<p>tail</p>")).toBe("head");
    // A line keeps only the bound's worth of what it draws, filler included, before any work on it.
    expect(htmlWords("<p>" + "​ ".repeat(40_000) + "word</p>")).toBe("");
    // Deep quotes times many breaks would build each break's quote prefix: the output bound holds there too.
    expect(htmlWords("<blockquote>".repeat(10_000) + "<br>".repeat(30_000) + "x").length).toBeLessThanOrEqual(65_536);
  });

  it("hostile html at the read bound costs the bound, not quote depth times pre lines, at ingest and reindex", async () => {
    const hostile = "<blockquote>".repeat(5_000) + "<pre>" + "\n".repeat(200_000) + "x";
    const started = performance.now();
    expect(htmlWords(hostile).length).toBeLessThanOrEqual(65_536);
    expect(searchBodyOf("", hostile).bodyText.length).toBeLessThanOrEqual(65_536);
    const m = await normalizeMime(eml({ id: "deep@x", subject: "Deep", html: hostile, related: true }));
    expect(m.textBody.length).toBeLessThanOrEqual(65_536);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  // A trailing-space trim that backtracks cost 20-40 s per letter on one such line.
  it.each([
    ["spaces", "<pre>a" + " ".repeat(262_000) + "b</pre>", "a"],
    ["tabs", "<pre>a" + "\t".repeat(262_000) + "b</pre>", "a"],
    ["no-break space", "<pre>" + " ".repeat(262_000) + "&nbsp;</pre>", ""],
  ])("one pre line of %s at the read bound costs linear time, at ingest and reindex", async (_shape, html, words) => {
    const quick = async <T>(f: () => T | Promise<T>): Promise<T> => {
      const started = performance.now();
      const out = await f();
      expect(performance.now() - started).toBeLessThan(500);
      return out;
    };
    const raw = eml({ id: "run@x", subject: "Run", html, related: true });
    expect(await quick(() => htmlWords(html))).toBe(words);
    expect((await quick(() => searchBodyOf("", html))).bodyText).toBe(words);
    expect((await quick(() => normalizeMime(raw))).textBody.trim()).toBe(words);
    const repo = new FakeRepo();
    const id = await quick(() => ingest(repo, raw, UNMETERED_STORAGE_CAP));
    expect(repo.searchDocs.get(id)?.bodyText).toBe(words);
  });
});
