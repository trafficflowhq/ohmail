import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes, drafts } from "@trafficflow/db";
import type { OpenSendAdapter, OutboundMessage } from "@trafficflow/core";
import { DraftsService, SendService, dbFor } from "../src/index.js";
import type { ServiceContext } from "../src/index.js";
import { DRAFT_HTML_CAP_BYTES } from "../src/outbound-html.js";

/**
 * A RICH DRAFT, FROM THE REQUEST THAT WRITES IT TO THE ENVELOPE THAT LEAVES.
 *
 * `outbound-html.test.ts` proves the sanitizer and the text renderer in isolation. This file
 * proves the two claims that only exist once they are wired into the services, and both of them
 * are claims about what CANNOT happen rather than about what does:
 *
 *  1. The two parts of the `multipart/alternative` cannot disagree. Not "do not" — cannot: the
 *     text part is derived from the sanitized html by the same call that stores it, and a
 *     request that tries to set them separately is refused rather than reconciled.
 *  2. Nothing reaches SMTP unsanitized, including from a writer that never called
 *     `DraftsService`. The workflow runner already inserts into `drafts` directly, so the
 *     send path sanitizes again — and the last test here writes a hostile row straight into the
 *     table to prove that gate is reachable rather than decorative.
 */

const draftsSvc = new DraftsService();
const sendSvc = new SendService();
const NOW = new Date("2026-07-28T12:00:00Z");

/** Captures the `OutboundMessage` the send path assembles. No network. */
function captureAdapter() {
  const seen: OutboundMessage[] = [];
  const factory: OpenSendAdapter = async () => ({
    async send(msg: OutboundMessage) {
      seen.push(msg);
      return { providerMessageId: msg.messageId! };
    },
    async messageInSent() {
      return false;
    },
    async close() {},
  });
  return { factory, seen };
}

async function setup() {
  const db = await makeTestDb();
  const A = randomUUID();
  const [mb] = await db.insert(mailboxes).values({
    accountId: A, provider: "imap", address: "mila@lichtgrat.example",
  }).returning();
  const ctx: ServiceContext = { db: dbFor(db, A), accountId: A, userId: null, now: () => NOW, requestId: "r" };
  return { db, A, mailboxId: mb!.id, ctx };
}

describe("a rich draft stores both parts, and the server owns the plain one", () => {
  it("derives the text alternative from the sanitized html", async () => {
    const { ctx, mailboxId } = await setup();
    const { draft } = await draftsSvc.create(ctx, {
      mailboxId,
      subject: "Re: the quote",
      html: '<p>Yes — see <a href="https://a.example/q">the quote</a>.</p><ul><li>one</li><li>two</li></ul>',
      to: [{ name: null, address: "you@example.com" }],
    });

    expect(draft.html).toBe(
      '<p>Yes — see <a href="https://a.example/q">the quote</a>.</p><ul><li>one</li><li>two</li></ul>',
    );
    // The link's TARGET survives into the plain part. A plaintext reader who gets the anchor
    // text and no href cannot follow the link, which is the two parts saying different things.
    expect(draft.body).toBe("Yes — see the quote (https://a.example/q).\n- one\n- two");
  });

  it("stores a PLAIN draft exactly as typed — the path that existed before is untouched", async () => {
    const { ctx, mailboxId } = await setup();
    const { draft } = await draftsSvc.create(ctx, { mailboxId, body: "  two  spaces\nand a line" });
    // Byte-exact, including the whitespace the html renderer would have collapsed. Nothing
    // about a plain compose goes near the sanitizer.
    expect(draft.body).toBe("  two  spaces\nand a line");
    expect(draft.html).toBeNull();
  });

  it("refuses a body sent ALONGSIDE html rather than quietly overwriting it", async () => {
    const { ctx, mailboxId } = await setup();
    await expect(
      draftsSvc.create(ctx, { mailboxId, html: "<p>rich</p>", body: "something else entirely" }),
    ).rejects.toMatchObject({ httpStatus: 400 });
  });

  it("refuses a rich body over the cap, with the size in the sentence", async () => {
    const { ctx, mailboxId } = await setup();
    const huge = `<p>${"a".repeat(DRAFT_HTML_CAP_BYTES)}</p>`;
    await expect(draftsSvc.create(ctx, { mailboxId, html: huge }))
      .rejects.toMatchObject({ httpStatus: 413, code: "draft_too_large" });
  });

  it("measures the cap against what will be STORED, not against what arrived", async () => {
    // A body that is mostly attributes the allowlist strips is not over the limit. Refusing it
    // on its raw length would reject a message the database would have accepted.
    const { ctx, mailboxId } = await setup();
    const padding = " ".repeat(DRAFT_HTML_CAP_BYTES);
    const { draft } = await draftsSvc.create(ctx, {
      mailboxId, html: `<p class="${padding}">short</p>`,
    });
    expect(draft.html).toBe("<p>short</p>");
  });
});

describe("editing cannot leave the two parts disagreeing", () => {
  it("re-derives the text part when the html is edited", async () => {
    const { ctx, mailboxId } = await setup();
    const { draft } = await draftsSvc.create(ctx, { mailboxId, html: "<p>first</p>" });
    const upd = await draftsSvc.update(ctx, draft.id, { html: "<p><strong>second</strong></p>" });
    expect(upd.draft.html).toBe("<p><strong>second</strong></p>");
    expect(upd.draft.body).toBe("second");
  });

  it("refuses a plain-only edit of a rich draft — the formatting is not silently dropped", async () => {
    const { ctx, mailboxId } = await setup();
    const { draft } = await draftsSvc.create(ctx, { mailboxId, html: "<p><strong>rich</strong></p>" });
    await expect(draftsSvc.update(ctx, draft.id, { body: "plain now" }))
      .rejects.toMatchObject({ httpStatus: 400 });
    // …and nothing was written: the refusal happens before the UPDATE.
    expect((await draftsSvc.get(ctx, draft.id)).html).toBe("<p><strong>rich</strong></p>");
  });

  it("allows the demotion when it is SPELT OUT — body plus an explicit html: null", async () => {
    const { ctx, mailboxId } = await setup();
    const { draft } = await draftsSvc.create(ctx, { mailboxId, html: "<p><strong>rich</strong></p>" });
    const upd = await draftsSvc.update(ctx, draft.id, { body: "plain now", html: null });
    expect(upd.draft.html).toBeNull();
    expect(upd.draft.body).toBe("plain now");
  });

  it("still allows a plain edit of a plain draft — no new refusal for the old path", async () => {
    const { ctx, mailboxId } = await setup();
    const { draft } = await draftsSvc.create(ctx, { mailboxId, body: "one" });
    expect((await draftsSvc.update(ctx, draft.id, { body: "two" })).draft.body).toBe("two");
  });
});

describe("the envelope carries both parts, and neither one carries a payload", () => {
  it("ROUND TRIP: compose rich → the OutboundMessage has html AND a text alternative", async () => {
    const { ctx, mailboxId } = await setup();
    const { draft } = await draftsSvc.create(ctx, {
      mailboxId,
      subject: "Re: the quote",
      html: '<p>Yes — see <a href="https://a.example/q">the quote</a>.</p>',
      to: [{ name: null, address: "you@example.com" }],
    });

    const { factory, seen } = captureAdapter();
    const res = await sendSvc.send(ctx, draft.id, "k-rich", { openSendAdapter: factory });
    expect(res.status).toBe("sent");

    const msg = seen[0]!;
    expect(msg.html).toBe('<p>Yes — see <a href="https://a.example/q">the quote</a>.</p>');
    expect(msg.text).toBe("Yes — see the quote (https://a.example/q).");
    // `imap.ts` forwards `msg.html` to BOTH nodemailer and the MailComposer that appends the
    // Sent copy, so this one object is why the delivered message and the stored copy agree.
  });

  it("a PLAIN draft still produces an envelope with no html part at all", async () => {
    const { ctx, mailboxId } = await setup();
    const { draft } = await draftsSvc.create(ctx, {
      mailboxId, body: "just words", to: [{ name: null, address: "you@example.com" }],
    });
    const { factory, seen } = captureAdapter();
    await sendSvc.send(ctx, draft.id, "k-plain", { openSendAdapter: factory });
    // Not an empty string — ABSENT. A `multipart/alternative` with an empty html part is a
    // message some clients render as blank.
    expect(seen[0]!.html).toBeUndefined();
    expect(seen[0]!.text).toBe("just words");
  });

  it("SANITIZES AT SEND TOO — a row written around DraftsService cannot reach SMTP dirty", async () => {
    // The workflow runner inserts into `drafts` directly (the workflows module), so
    // "DraftsService is the only writer" is a claim about today. This writes the hostile row the
    // way a future writer would and asserts the send path still cleans it.
    const { db, A, ctx, mailboxId } = await setup();
    const [row] = await db.insert(drafts).values({
      accountId: A, mailboxId,
      subject: "hi", body: "hi",
      html: '<p>hi</p><script>steal()</script><a href="javascript:alert(1)">x</a>',
      to: [{ name: null, address: "you@example.com" }],
      status: "draft",
    }).returning();

    const { factory, seen } = captureAdapter();
    await sendSvc.send(ctx, row!.id, "k-hostile", { openSendAdapter: factory });

    expect(seen[0]!.html).not.toContain("script");
    expect(seen[0]!.html).not.toContain("steal");
    expect(seen[0]!.html).not.toContain("javascript");
    // The stored row is untouched — this gate cleans the ENVELOPE, and does not rewrite history.
    const [after] = await db.select().from(drafts).where(eq(drafts.id, row!.id));
    expect(after!.html).toContain("script");
  });
});
