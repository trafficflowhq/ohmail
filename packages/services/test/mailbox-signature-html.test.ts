import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxes } from "@trafficflow/db";
import {
  MAILBOX_SIGNATURE_MAX_CHARS, dbFor, mailboxSignatureHtmls, mailboxSignatures,
  setMailboxSignature, type ServiceContext,
} from "../src/index.js";

/**
 * ═══ THE SIGNATURE'S MARKUP HALF — mail 0098 (0.16, item 11) ═════════════════════════════════
 *
 * Settings → Signatures now mounts the compose editor, so the value it saves is markup. This
 * file pins the write path's whole contract, and the contract is one sentence: `signature_html`
 * is what the reader approved and `signature` is DERIVED FROM IT HERE, by `prepareOutboundBody`
 * — the same converter that renders the `text/plain` half of every composed message.
 *
 * ── WHY THE DERIVATION IS THE SERVER'S JOB AND NOT THE EDITOR'S ──────────────────────────────
 *
 * The client could send both halves. It must not be believed if it does: `PATCH /consent/settings`
 * accepts strings and nothing about the request proves an editor was involved, so a client that
 * sent `html: "<b>Anna</b>"` beside `text: "Bob"` would store a signature whose two halves say
 * different things to different recipients — and a `multipart/alternative` is a promise that they
 * do not. Deriving here is what makes that unrepresentable rather than merely discouraged. The
 * write refuses a call that carries both; this file pins the refusal.
 *
 * ── AND WHY THE SANITIZER IS THE COMPOSE ONE ─────────────────────────────────────────────────
 *
 * `sanitizeOutboundHtml` is the grammar the compose editor speaks and the grammar the send path
 * enforces on the way out. Reducing a signature through the SAME function is what stops the pane
 * from being a second door into the message body with a wider allow-list behind it.
 */

async function setup() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [a] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "one@example.com" }).returning();
  let tick = 0;
  const ctx: ServiceContext = {
    db: dbFor(db, accountId), accountId, userId: null,
    now: () => new Date(Date.parse("2026-09-08T00:00:00.000Z") + ++tick * 1_000),
    requestId: "r",
  };
  return { db, accountId, mb: a!.id, ctx };
}

const columns = async (db: Awaited<ReturnType<typeof makeTestDb>>, id: string) => {
  const [row] = await db
    .select({ signature: mailboxes.signature, signatureHtml: mailboxes.signatureHtml })
    .from(mailboxes).where(eq(mailboxes.id, id));
  return row!;
};

describe("setMailboxSignature — markup stores both halves, and derives the text", () => {
  it("stores the sanitized markup and the text rendered FROM it", async () => {
    const { db, ctx, mb } = await setup();
    const out = await setMailboxSignature(ctx, mb, null, "<p><strong>Anna</strong><br>ohmail</p>");
    // `<br />` and not `<br>`: `sanitize-html` re-serializes void elements self-closed. MEASURED
    // rather than assumed — the value the pane renders is the server's echo, so the exact bytes
    // stored are what the Settings preview and the composer block will show.
    expect(out.signatureHtml).toBe("<p><strong>Anna</strong><br />ohmail</p>");
    // The derived half is words, never tags — this is what a plaintext client reads.
    expect(out.signature).toBe("Anna\nohmail");
    const row = await columns(db, mb);
    expect(row.signatureHtml).toBe("<p><strong>Anna</strong><br />ohmail</p>");
    expect(row.signature).toBe("Anna\nohmail");
  });

  it("strips what the compose grammar refuses, and derives the text from what SURVIVED", async () => {
    const { db, ctx, mb } = await setup();
    await setMailboxSignature(
      ctx, mb, null,
      '<p>Anna<script>alert(1)</script><img src=x onerror="y"><a href="javascript:x">go</a></p>',
    );
    const row = await columns(db, mb);
    // `script` is a `nonTextTags` entry — the tag AND its text go. `img` has no allow-list entry.
    // The `javascript:` href is dropped and the anchor's own text stays, which is the sanitizer's
    // documented shape rather than this file's invention.
    expect(row.signatureHtml).not.toContain("script");
    expect(row.signatureHtml).not.toContain("alert");
    expect(row.signatureHtml).not.toContain("javascript:");
    expect(row.signatureHtml).not.toContain("<img");
    // Derived from the SANITIZED markup, so nothing the sanitizer removed can reach the text half.
    expect(row.signature).not.toContain("alert");
    expect(row.signature).toContain("Anna");
  });

  it("markup that renders to nothing CLEARS the signature, both halves", async () => {
    const { db, ctx, mb } = await setup();
    await setMailboxSignature(ctx, mb, "keep me");
    const out = await setMailboxSignature(ctx, mb, null, "<p></p>");
    expect(out.signature).toBeNull();
    expect(out.signatureHtml).toBeNull();
    const row = await columns(db, mb);
    expect(row.signature).toBeNull();
    expect(row.signatureHtml).toBeNull();
  });

  it("a PLAIN write clears the markup — saving text is saving the whole value", async () => {
    const { db, ctx, mb } = await setup();
    await setMailboxSignature(ctx, mb, null, "<p><strong>Anna</strong></p>");
    expect((await columns(db, mb)).signatureHtml).toBe("<p><strong>Anna</strong></p>");
    // A client with no editor (the phone) saving plain text must not leave stale markup behind
    // that the composer would then ship instead of the words that were just saved.
    await setMailboxSignature(ctx, mb, "just words");
    const row = await columns(db, mb);
    expect(row.signature).toBe("just words");
    expect(row.signatureHtml).toBeNull();
  });

  it("refuses a write that carries BOTH halves — one value, one door", async () => {
    const { ctx, mb } = await setup();
    await expect(setMailboxSignature(ctx, mb, "Bob", "<p><strong>Anna</strong></p>"))
      .rejects.toMatchObject({ httpStatus: 400 });
  });

  it("refuses markup over the character bound, and accepts it exactly at the bound", async () => {
    const { ctx, mb } = await setup();
    const over = `<p>${"x".repeat(MAILBOX_SIGNATURE_MAX_CHARS)}</p>`;
    await expect(setMailboxSignature(ctx, mb, null, over)).rejects.toMatchObject({
      httpStatus: 400, message: expect.stringContaining(String(MAILBOX_SIGNATURE_MAX_CHARS)),
    });
    const exact = `<p>${"y".repeat(MAILBOX_SIGNATURE_MAX_CHARS - 7)}</p>`;
    expect(exact.length).toBe(MAILBOX_SIGNATURE_MAX_CHARS);
    expect((await setMailboxSignature(ctx, mb, null, exact)).signatureHtml).toBe(exact);
  });

  it("refuses a NUL in the markup, like the text half does", async () => {
    const { ctx, mb } = await setup();
    // The NUL is an ESCAPE in this source, never a raw byte: a file carrying one reads as `data`
    // to `file`, after which every `grep` skips the whole file in silence.
    await expect(setMailboxSignature(ctx, mb, null, "<p>a\u0000b</p>")).rejects.toMatchObject({
      httpStatus: 400,
    });
  });

  it("a plain write is UNCHANGED — the two-argument call still stores text and nothing else", async () => {
    const { db, ctx, mb } = await setup();
    const out = await setMailboxSignature(ctx, mb, "Best regards\nAnna");
    expect(out.signature).toBe("Best regards\nAnna");
    const row = await columns(db, mb);
    expect(row.signature).toBe("Best regards\nAnna");
    expect(row.signatureHtml).toBeNull();
  });
});

describe("mailboxSignatureHtmls — only the mailboxes that carry markup", () => {
  it("omits a mailbox whose signature is plain, and both maps agree on which mailbox", async () => {
    const { db, accountId, ctx, mb } = await setup();
    const [second] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: "two@example.com" }).returning();
    await setMailboxSignature(ctx, mb, null, "<p><em>Anna</em></p>");
    await setMailboxSignature(ctx, second!.id, "plain words");

    const html = await mailboxSignatureHtmls(dbFor(db, accountId), accountId);
    const text = await mailboxSignatures(dbFor(db, accountId), accountId);
    expect(html).toEqual({ [mb]: "<p><em>Anna</em></p>" });
    // BOTH mailboxes have a signature; only one of them has markup. An absent key in the markup
    // map is "no formatting", never "no signature" — the text map is the one that answers that.
    expect(Object.keys(text).sort()).toEqual([mb, second!.id].sort());
    expect(text[mb]).toBe("Anna");
  });
});
