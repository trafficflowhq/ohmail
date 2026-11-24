import { describe, it, expect } from "vitest";
import { managedAddress } from "../../../test/support/fixture-credentials.js";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, messages, drafts } from "@trafficflow/db";
import { plainTextToOutboundBody } from "@trafficflow/core/mail";
import type { DraftInput, DraftPort, OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { DraftingService, DraftsService, SendService, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";
import { htmlToPlainText, sanitizeOutboundHtml } from "../src/outbound-html.js";

/**
 * A GENERATED REPLY HAS TO LEAVE AS BOTH HALVES.
 *
 * The drafter answers in prose and the outbound path only builds a `multipart/alternative` when
 * `drafts.html` is present, so an AI draft used to go out as `text/plain` while the person who
 * sent it had been editing it in a rich editor. The promotion closes that; this file is the
 * evidence, and it is deliberately end-to-end — a non-null column proves nothing about what a
 * recipient receives.
 *
 * Three properties, and each one is a different failure if it breaks:
 *
 *  1. THE HALVES AGREE. `htmlToPlainText(promoted.html) === promoted.text`, over inputs chosen to
 *     break it rather than to pass. Break this and two people reading the same message on two
 *     devices read different things — the only failure `multipart/alternative` exists to prevent.
 *  2. THE MARKUP IS A FIXED POINT OF THE SANITIZER. `sanitizeOutboundHtml(html) === html`. Break
 *     this and the promotion is producing markup outside the outbound grammar; the send-time gate
 *     would still catch it, but the stored draft and the sent bytes would then differ.
 *  3. THE MODEL'S OUTPUT IS TEXT, NOT MARKUP. A reply containing `<script>` is a reply containing
 *     the characters `<script>`. This is the one property with a security consequence: the html
 *     half is stored, re-rendered in our own reader when the Sent copy comes back, and read by
 *     whatever the recipient uses.
 */

const NOW = new Date("2026-08-05T09:00:00.000Z");

/** Bodies chosen to break the round trip, not to pass it. */
const ADVERSARIAL: Array<[name: string, body: string]> = [
  ["one line", "Thanks — sending it over today."],
  ["two paragraphs", "Hi Alice\n\nThanks for the note. I will send it Monday.\n\nBest,\nBob"],
  ["soft line breaks inside a paragraph", "Line one\nLine two\nLine three"],
  ["collapsing double spaces", "Sentence one.  Sentence two.   Sentence three."],
  ["leading and trailing spaces on a line", "   indented   \n  also indented  "],
  ["tabs", "column\tone\tvalue"],
  ["carriage returns", "first\r\nsecond\rthird"],
  ["a run of blank lines", "top\n\n\n\n\nbottom"],
  ["leading blank lines", "\n\n\nthe first words"],
  ["trailing blank lines", "the last words\n\n\n"],
  ["markup characters", "5 < 6 && 7 > 6, so a<b is true"],
  ["a quoted line", "> they wrote this\nand I answer that"],
  ["an html-looking reply", "<script>alert(1)</script> and <b>bold</b>"],
  ["an entity that is really text", "the string &amp; is four characters plus a semicolon"],
  ["a non-breaking space", "price:  12 CHF"],
  ["quotes and apostrophes", `she said "it's fine" — twice`],
  ["only whitespace", "   \n\t\n  "],
  ["empty", ""],
];

describe("plainTextToOutboundBody — the two halves of a promoted reply", () => {
  it.each(ADVERSARIAL)("the halves say the same thing: %s", (_name, body) => {
    const promoted = plainTextToOutboundBody(body);
    // The html half rendered back to text IS the text half. Not "close to", not "contains".
    expect(htmlToPlainText(promoted.html)).toBe(promoted.text);
  });

  it.each(ADVERSARIAL)("the markup is a fixed point of the outbound sanitizer: %s", (_name, body) => {
    const { html } = plainTextToOutboundBody(body);
    expect(sanitizeOutboundHtml(html)).toBe(html);
  });

  it("a body with no words in it promotes to nothing, not to an empty paragraph", () => {
    expect(plainTextToOutboundBody("")).toEqual({ html: "", text: "" });
    expect(plainTextToOutboundBody("  \n\t\n ")).toEqual({ html: "", text: "" });
  });

  it("paragraphs, soft breaks and the blank line between them are all distinct", () => {
    const { html, text } = plainTextToOutboundBody("Hi Alice\n\nThanks.\nMonday.\n\nBest,\nBob");
    expect(html).toBe(
      "<p>Hi Alice</p><p></p><p>Thanks.<br />Monday.</p><p></p><p>Best,<br />Bob</p>",
    );
    expect(text).toBe("Hi Alice\n\nThanks.\nMonday.\n\nBest,\nBob");
  });

  it("markup in the model's answer stays punctuation — it is never parsed as markup", () => {
    const { html, text } = plainTextToOutboundBody("<script>alert(1)</script> and a < b");
    expect(html).not.toContain("<script");
    expect(html).toBe("<p>&lt;script&gt;alert(1)&lt;/script&gt; and a &lt; b</p>");
    // And the words survive: escaping is not deletion.
    expect(text).toBe("<script>alert(1)</script> and a < b");
    expect(htmlToPlainText(html)).toBe(text);
  });

  it("an ordinary reply's text half is byte-identical to what the model wrote", () => {
    // The normalization only bites on whitespace the html half could not have shown anyway, so
    // for prose it is the identity — which is what keeps the promotion invisible to the user.
    for (const body of [
      "Thanks — sending it over today.",
      "Hi Alice\n\nThanks for the note. I will send it Monday.\n\nBest,\nBob",
      "Line one\nLine two",
    ]) {
      expect(plainTextToOutboundBody(body).text).toBe(body);
    }
  });
});

/* ── the request path: POST /messages/:id/draft, stored and then sent ─────────────────── */

function mockDrafter(body: string): DraftPort & { calls: number } {
  const m = {
    calls: 0,
    async draft(_input: DraftInput) {
      m.calls += 1;
      return { subject: "Re: your message", body, rationale: "grounded" };
    },
  };
  return m;
}

/** Captures the `OutboundMessage` the send path assembles. No network. */
function capturingAdapter() {
  const sent: OutboundMessage[] = [];
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      sent.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() {
      return false;
    },
    async close() {
      /* nothing to tear down */
    },
  });
  return { factory, sent };
}

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: managedAddress("fixture.desk"),
  }).returning();
  const ctx: ServiceContext = { db: dbFor(db, accountId), accountId, userId: null, now: () => NOW, requestId: "r" };
  const [msg] = await db.insert(messages).values({
    accountId,
    mailboxId: mb!.id,
    bodyHash: "h",
    dedupKey: `seed:${randomUUID()}`,
    subject: "Can you confirm Monday?",
    fromAddress: "client@example.com",
    snippet: "checking on Monday",
    date: NOW,
  }).returning();
  return { db, accountId, ctx, mailboxId: mb!.id, messageId: msg!.id };
}

const drafting = new DraftingService();
const draftsSvc = new DraftsService();
const sendSvc = new SendService();

const MODEL_BODY = "Hi Alice\n\nMonday works. I will send the file first thing.\n\nBest,\nBob";

describe("an AI draft is stored with both halves, and sends as multipart/alternative", () => {
  it("POST /messages/:id/draft stores html, and the stored body is the html's own plain rendering", async () => {
    const { ctx, messageId } = await setup();
    const { draftId } = await drafting.draftFromMessage(ctx, messageId, {
      drafter: mockDrafter(MODEL_BODY),
    });

    const stored = await draftsSvc.get(ctx, draftId);
    expect(stored.html).not.toBeNull();
    expect(stored.html).toContain("<p>");
    // The two halves of the row agree, and the plain one is still exactly the model's words.
    expect(htmlToPlainText(stored.html!)).toBe(stored.body);
    expect(stored.body).toBe(MODEL_BODY);
  });

  it("sending that draft UNTOUCHED puts both parts on the wire", async () => {
    const { db, ctx, messageId } = await setup();
    const { draftId } = await drafting.draftFromMessage(ctx, messageId, {
      drafter: mockDrafter(MODEL_BODY),
    });
    // A recipient, which the drafter does not set.
    await draftsSvc.update(ctx, draftId, { to: [{ name: null, address: "alice@example.com" }] });

    const { factory, sent } = capturingAdapter();
    const res = await sendSvc.send(ctx, draftId, `key-${randomUUID()}`, { openSendAdapter: factory });
    expect(res.status).toBe("sent");

    expect(sent).toHaveLength(1);
    const msg = sent[0]!;
    // BOTH parts. `html` absent here is the defect this whole file exists for.
    expect(msg.html).toBeTruthy();
    expect(msg.text).toBe(MODEL_BODY);
    expect(htmlToPlainText(msg.html!)).toBe(msg.text);
    expect(msg.html).toContain("<p>Hi Alice</p>");

    // And what went on the wire is what was stored — the send-time sanitizer pass is a no-op
    // on promoted markup rather than a second, differently-rendered copy.
    const [row] = await db.select().from(drafts).limit(1);
    expect(msg.html).toBe(row!.html);
  });

  it("a model answer full of markup is sent as text, never as tags", async () => {
    const { ctx, messageId } = await setup();
    const { draftId } = await drafting.draftFromMessage(ctx, messageId, {
      drafter: mockDrafter("<script>alert(1)</script>\n\nsee <b>attached</b>"),
    });
    await draftsSvc.update(ctx, draftId, { to: [{ name: null, address: "alice@example.com" }] });

    const { factory, sent } = capturingAdapter();
    await sendSvc.send(ctx, draftId, `key-${randomUUID()}`, { openSendAdapter: factory });

    const msg = sent[0]!;
    expect(msg.html).not.toContain("<script");
    expect(msg.html).not.toContain("<b>");
    expect(msg.html).toContain("&lt;script&gt;");
    expect(msg.text).toContain("<script>alert(1)</script>");
  });

  it("an empty model answer stores a plain draft — no empty-paragraph shell", async () => {
    const { ctx, messageId } = await setup();
    const { draftId } = await drafting.draftFromMessage(ctx, messageId, { drafter: mockDrafter("   ") });
    const stored = await draftsSvc.get(ctx, draftId);
    expect(stored.html).toBeNull();
    expect(stored.body).toBe("   ");
  });

  it("a hand-written plain draft is untouched — promotion is for generated replies only", async () => {
    const { ctx, mailboxId } = await setup();
    const { draft } = await draftsSvc.create(ctx, { mailboxId, subject: "Hi", body: "Just text." });
    expect(draft.html).toBeNull();
    expect(draft.body).toBe("Just text.");
  });
});
