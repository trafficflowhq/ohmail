import { describe, it, expect, vi, afterEach } from "vitest";
import {
  normalizeMime,
  countRealFiles,
  NUL_REPLACEMENT,
  MAX_RAW_MESSAGE_BYTES,
  MAX_HTML_TO_TEXT_CHARS,
  MimeTooLargeError,
  MimeParseError,
} from "../src/mime.js";
import { bodyHash, legacyDedupKey, messageFingerprint } from "../src/identity.js";
import { createLogger, type Logger } from "../src/log.js";
import { usePhoneDate } from "./_hermes-date.js";
import { mailDate } from "../src/mail-date.js";

const EML = [
  "Message-ID: <Greeting-1@Example.com>",
  "From: Anna Example <Anna@Example.com>",
  "To: mila@lichtgrat.example",
  "Subject: Lunch?",
  "List-Unsubscribe: <mailto:unsub@example.com>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hey, lunch tomorrow?",
].join("\r\n");

/**
 * A `multipart/related` message with an inline image referenced by `cid:` — the exact shape
 * that filled a production database.
 *
 * The image is 24 KB of base64 (a deliberately incompressible payload, like the real JPEGs and
 * PNGs were), so if mailparser inlines it the html grows by ~24 KB and the assertions below say
 * so in bytes rather than by a vague "contains".
 */
const INLINE_IMAGE_B64 = "R0lGODlhAQABAIAAAP".repeat(1400);   // ~25 KB, never a real image
const RELATED_EML = [
  "Message-ID: <Newsletter-9@Example.com>",
  "From: Corp <news@example.com>",
  "To: mila@lichtgrat.example",
  "Subject: Our July update",
  'Content-Type: multipart/related; boundary="B"',
  "",
  "--B",
  "Content-Type: text/html; charset=utf-8",
  "",
  '<p>Hello</p><img src="cid:logo@corp"><p>Bye</p>',
  "",
  "--B",
  "Content-Type: image/gif",
  "Content-Transfer-Encoding: base64",
  "Content-ID: <logo@corp>",
  "Content-Disposition: inline; filename=logo.gif",
  "",
  INLINE_IMAGE_B64,
  "",
  "--B--",
  "",
].join("\r\n");

/**
 * ── THE POISON-MESSAGE CORPUS ─────────────────────────────────────────────────────
 *
 * Every message below is RAW RFC 822 that anyone who knows a user's address can send. They are
 * written as wire bytes on purpose: a JS string literal holding U+0000 directly would prove
 * nothing about mailparser's DECODING, and decoding is where the bytes come from — the subject
 * arrives as the encoded word `=?utf-8?B?YQBi?=` and the body as base64.
 *
 * The bar for all of them is the same: `normalizeMime` returns a usable result, or rejects with
 * one of THIS module's typed errors. It never throws something the caller cannot classify,
 * because `apps/worker/src/sync.ts` has no per-message catch and advances the folder cursor only
 * after a whole batch commits — so an unclassifiable throw is a permanently wedged mailbox.
 */
const NUL = String.fromCharCode(0);

/** `=?utf-8?B?YQBi?=` is the base64 of `a<NUL>b` — a NUL that only exists after decoding. */
const NUL_ENCODED_WORD = "=?utf-8?B?YQBi?=";

const PROTO_EML = [
  "Message-ID: <Poison-2@Example.com>",
  "From: Attacker <mallory@example.com>",
  "To: mila@lichtgrat.example",
  "Subject: hi",
  "__proto__: attacker",
  "constructor: attacker",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "body",
].join("\r\n");

describe("normalizeMime", () => {
  it("extracts subject, lowercased from-address, CASE-PRESERVED message id, lowercased headers", async () => {
    const m = await normalizeMime(EML);
    expect(m.subject).toBe("Lunch?");
    expect(m.from.address).toBe("anna@example.com");
    // The ADDRESS is lowercased (`toAddr`) and the Message-ID is NOT. RFC 5322 §3.6.4 makes
    // `id-left` a case-significant `dot-atom-text`, so folding it collapsed two senders' ids onto
    // one row. The header source is `<Greeting-1@Example.com>`; only the legacy key
    // re-folds it, for the rows that were written that way.
    expect(m.canonical.messageIdHeader).toBe("Greeting-1@Example.com");
    expect(legacyDedupKey(m.canonical)).toBe("mid:greeting-1@example.com");
    expect(m.headers["list-unsubscribe"]).toBeDefined();
    expect(m.textBody).toContain("lunch tomorrow");
    expect(m.hasAttachments).toBe(false);
  });

  /**
   * `Cc:` IS PARSED, AND IT IS A FINGERPRINT INPUT.
   *
   * No routing rule reads it. Its consumers are {@link messageFingerprint} — asserted below — and
   * `messages.cc_addresses`, which `insertMessage` writes and `messageRowToDTO` projects onto
   * `MessageDTO.cc` (guarded in `packages/services/test/ingest-recipients.pg.test.ts`).
   * Leaving it out of the identity would be the UNSAFE direction:
   * two messages differing only in their Cc list would be ONE `messages` row, and the second would
   * be filed as a duplicate and never shown. Replace `addrList(parsed.cc)` with `[]` in `mime.ts` and
   * both halves of this test fail.
   */
  it("parses Cc, and a message differing ONLY in Cc has a different logical identity", async () => {
    const withCc = (cc: string) => [
      "Message-ID: <cc-1@example.com>",
      "From: anna@example.com",
      "To: mila@lichtgrat.example",
      `Cc: ${cc}`,
      "Subject: Lunch?",
      "Content-Type: text/plain; charset=utf-8",
      "", "lunch tomorrow",
    ].join("\r\n");

    const a = await normalizeMime(withCc("Boss@Example.com, second@example.com"));
    // Addresses are lowercased at parse (`toAddr`) and kept in HEADER ORDER.
    expect(a.cc.map((c) => c.address)).toEqual(["boss@example.com", "second@example.com"]);

    const b = await normalizeMime(withCc("second@example.com"));
    expect(messageFingerprint(a)).not.toBe(messageFingerprint(b));
    // …and the ORDER matters too, because the header order is what the sender chose.
    const reversed = await normalizeMime(withCc("second@example.com, Boss@Example.com"));
    expect(messageFingerprint(a)).not.toBe(messageFingerprint(reversed));
    // A message with no Cc header at all is a third, distinct identity.
    const none = await normalizeMime(EML);
    expect(none.cc).toEqual([]);
    expect(messageFingerprint(none)).not.toBe(messageFingerprint(a));
  });

  /**
   * THE REGRESSION TEST FOR THE 2026-08-01 STORAGE OUTAGE.
   *
   * Without `keepCidLinks: true`, mailparser rewrites `cid:logo@corp` into
   * `data:image/gif;base64,<the entire attachment>`. That is what stored megabytes of attachment
   * bytes inside `message_bodies.html` and violated the "Organize-in-place" invariant's "store no bytes".
   *
   * Remove the option in `mime.ts` and this goes red on all three assertions.
   */
  it("keeps the cid: reference and does NOT inline the attachment bytes into the html", async () => {
    const m = await normalizeMime(RELATED_EML);
    expect(m.htmlBody).toContain("cid:logo@corp");
    expect(m.htmlBody).not.toContain(";base64,");
    // The html must stay the size of the html, not the size of the image.
    expect(m.htmlBody!.length).toBeLessThan(200);
  });

  it("still records the inline part's METADATA, which is how a cid: is resolved later", async () => {
    // `keepCidLinks` returns before `updateImageLinks` and leaves the attachments array alone,
    // so the client can still resolve `cid:logo@corp` through GET /attachments/:id.
    const m = await normalizeMime(RELATED_EML);
    const inline = m.attachments.find((a) => a.contentId === "logo@corp");
    expect(inline, "the inline part must still be catalogued").toBeDefined();
    expect(inline!.contentType).toBe("image/gif");
    expect(inline!.sizeBytes).toBeGreaterThan(1000);
  });

  /**
   * ── GAP THE PAPERCLIP PROMISES A DOWNLOAD, SO IT MUST COUNT DOWNLOADABLE PARTS ────────
   *
   * `RELATED_EML` is the production case in miniature: a newsletter whose only non-text part is
   * a `multipart/related` cid: logo. A large share of a live mailbox's flagged messages were
   * exactly this, measured on the hosted service.
   *
   * Restore `hasAttachments: attachments.length > 0` in `mime.ts` and this goes red with
   * `expected true to be false`.
   */
  it("does NOT flag a message whose only part is an inline cid: image", async () => {
    const m = await normalizeMime(RELATED_EML);
    // The part is still catalogued — the test above pins that. The FLAG is the claim under test.
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]!.inline).toBe(true);
    expect(m.hasAttachments).toBe(false);
    expect(countRealFiles(m.attachments)).toBe(0);
  });

  /**
   * The other direction, and the one that stops the fix being "return false more often": one
   * real file among three embedded images must still raise the paperclip, and the count must be
   * 1 and not 4.
   *
   * Both halves matter. Weaken `some(isRealFile)` to `every(isRealFile)` and the first assertion
   * goes red; leave `attachmentCount` at `attachments.length` in `pipeline.ts` and the DTO ships
   * `hasAttachments: true, attachmentCount: 4` for one downloadable file.
   */
  it("DOES flag a message with one real file among three inline images", async () => {
    const mixed = [
      "Message-ID: <Mixed-1@Example.com>",
      "From: Corp <news@example.com>",
      "To: mila@lichtgrat.example",
      "Subject: invoice + branding",
      'Content-Type: multipart/related; boundary="B"',
      "",
      "--B",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>See attached.</p><img src="cid:a@corp"><img src="cid:b@corp"><img src="cid:c@corp">',
      "",
      ...["a", "b", "c"].flatMap((id) => [
        "--B",
        "Content-Type: image/gif",
        "Content-Transfer-Encoding: base64",
        `Content-ID: <${id}@corp>`,
        `Content-Disposition: inline; filename=${id}.gif`,
        "",
        INLINE_IMAGE_B64,
        "",
      ]),
      "--B",
      "Content-Type: application/pdf",
      'Content-Disposition: attachment; filename="invoice.pdf"',
      "",
      "%PDF-1.4 not really a pdf",
      "",
      "--B--",
      "",
    ].join("\r\n");

    const m = await normalizeMime(mixed);
    expect(m.attachments).toHaveLength(4);
    expect(m.attachments.filter((a) => a.inline)).toHaveLength(3);
    expect(m.hasAttachments).toBe(true);
    expect(countRealFiles(m.attachments)).toBe(1);
    expect(m.attachments.find((a) => !a.inline)!.filename).toBe("invoice.pdf");
  });

  /**
   * ── THE RULE `inline` ACTUALLY USES, PINNED SO A REFACTOR CANNOT QUIETLY SWAP IT ───────────
   *
   * mailparser sets `related` from **Content-ID + an ancestor `multipart/related`**, and reads
   * the disposition for nothing. So an image declaring `Content-Disposition: attachment` while
   * sitting under `multipart/related` and referenced by the body is INLINE — which is the right
   * answer, and the one a disposition-based rule would get wrong.
   *
   * Rewrite `toAttachmentMeta`'s `inline` as
   * `a.contentDisposition === "inline"` and this goes red on both assertions.
   */
  it("treats a body-referenced image as inline even when its disposition says attachment", async () => {
    const disposition = RELATED_EML.replace(
      "Content-Disposition: inline; filename=logo.gif",
      "Content-Disposition: attachment; filename=logo.gif",
    );
    expect(disposition).toContain("Content-Disposition: attachment");

    const m = await normalizeMime(disposition);
    expect(m.attachments[0]!.inline).toBe(true);
    expect(m.hasAttachments).toBe(false);
  });

  /**
   * ── THE SECOND INLINE SIGNAL: THE BODY'S OWN `cid:` REFERENCE ──────────────────────────────
   *
   * mailparser's `related` covers a cid part under `multipart/related` and nothing else. The
   * commonest counter-example is the signature logo a sender's client nests under
   * `multipart/mixed`: Content-ID present, referenced by the html, and `related: false` — so it
   * was listed as a downloadable file beside a body that paints that same picture, and its
   * message carried a paperclip with nothing behind it.
   *
   * The promotion loop in `normalizeMime` (via `referencesCid`) is what these pin. Delete the
   * loop — or weaken `referencesCid` to `false` — and every assertion in this block goes red.
   */
  describe("a cid part under multipart/mixed", () => {
    /** `multipart/mixed`: html referencing `cid:sig@corp`, one image part carrying that id. */
    const mixed = (opts: { htmlRefs: string; imageCid: string; extraParts?: string[] }) => [
      "Message-ID: <Mixed-1@Example.com>",
      "From: Anna Example <anna@example.com>",
      "To: mila@lichtgrat.example",
      "Subject: With my signature",
      'Content-Type: multipart/mixed; boundary="M"',
      "",
      "--M",
      "Content-Type: text/html; charset=utf-8",
      "",
      `<p>Hello</p>${opts.htmlRefs}<p>Anna</p>`,
      "",
      "--M",
      "Content-Type: image/png",
      "Content-Transfer-Encoding: base64",
      `Content-ID: <${opts.imageCid}>`,
      "Content-Disposition: inline; filename=signature.png",
      "",
      INLINE_IMAGE_B64,
      "",
      ...(opts.extraParts ?? []),
      "--M--",
      "",
    ].join("\r\n");

    it("is INLINE when the html references it — and the message shows no paperclip", async () => {
      const m = await normalizeMime(
        mixed({ htmlRefs: '<img src="cid:sig@corp">', imageCid: "sig@corp" }),
      );
      const sig = m.attachments.find((a) => a.contentId === "sig@corp");
      expect(sig, "the part must still be catalogued — a cid: resolves through it").toBeDefined();
      expect(sig!.inline).toBe(true);
      expect(m.hasAttachments).toBe(false);
      expect(countRealFiles(m.attachments)).toBe(0);
    });

    it("stays a FILE when nothing references it — unreferenced and standalone means downloadable", async () => {
      // Same structure, but the html names a different cid. A Content-ID alone is not embedding:
      // an unreferenced part is painted by no rendering, so dropping it from the file list would
      // make it reachable from nowhere in the product.
      const m = await normalizeMime(
        mixed({ htmlRefs: '<img src="cid:other@corp">', imageCid: "sig@corp" }),
      );
      const sig = m.attachments.find((a) => a.contentId === "sig@corp");
      expect(sig!.inline).toBe(false);
      expect(m.hasAttachments).toBe(true);
    });

    it("does not take a real PDF with it — the paperclip survives beside an inline logo", async () => {
      const m = await normalizeMime(
        mixed({
          htmlRefs: '<img src="cid:sig@corp">',
          imageCid: "sig@corp",
          extraParts: [
            "--M",
            "Content-Type: application/pdf",
            "Content-Transfer-Encoding: base64",
            "Content-Disposition: attachment; filename=invoice.pdf",
            "",
            "JVBERi0xLjQK",
            "",
          ],
        }),
      );
      expect(m.attachments.find((a) => a.contentId === "sig@corp")!.inline).toBe(true);
      const pdf = m.attachments.find((a) => a.filename === "invoice.pdf");
      expect(pdf!.inline).toBe(false);
      expect(m.hasAttachments).toBe(true);
      expect(countRealFiles(m.attachments)).toBe(1);
    });

    it("matches the Content-ID exactly — a case-folded near-miss stays a file", async () => {
      // The two error directions are asymmetric: a missed match is the cosmetic status quo,
      // a false match drops a real file from the Files list. So the comparison is exact.
      const m = await normalizeMime(
        mixed({ htmlRefs: '<img src="cid:SIG@CORP">', imageCid: "sig@corp" }),
      );
      expect(m.attachments.find((a) => a.contentId === "sig@corp")!.inline).toBe(false);
      expect(m.hasAttachments).toBe(true);
    });
  });

  /**
   * FINDING from the attacker's side.
   *
   * With `const headers: Record<string, string[]> = {}` and `(headers[name] ??= []).push(value)`
   * — the code as it shipped — this rejects with
   * `TypeError: headers[name].push is not a function`, because `headers["__proto__"]` resolves
   * to the inherited `Object.prototype` and `??=` therefore installs nothing. Verified against
   * the installed mailparser 3.9.14 for both `__proto__` and `constructor`.
   */
  it("does not throw on a `__proto__` / `constructor` header — the five-byte poison message", async () => {
    const m = await normalizeMime(PROTO_EML);
    expect(m.headers["__proto__"]).toEqual(["attacker"]);
    expect(m.headers["constructor"]).toEqual(["attacker"]);
    // …and the ordinary headers on the same message are still there.
    expect(m.subject).toBe("hi");
    expect(m.headers["from"]).toEqual(["Attacker <mallory@example.com>"]);
  });

  /**
   * The prototype itself is the assertion, so `{}` is RED here even though the `Object.hasOwn`
   * append would keep the parse working on its own.
   *
   * It has a consumer beyond the parse: `rules.ts:109` decides a `header`-kind rule with
   * `Boolean(msg.headers[r.match.toLowerCase()])`, so on an inheriting map a rule matching
   * `constructor` is truthy for EVERY message and silently files the whole mailbox.
   */
  it("returns a headers map that inherits NOTHING, so no header name can resolve to a non-array", async () => {
    const m = await normalizeMime(PROTO_EML);
    expect(Object.getPrototypeOf(m.headers)).toBeNull();
    expect(m.headers["toString"]).toBeUndefined();
    expect(m.headers["valueOf"]).toBeUndefined();
    // The routing consequence, stated as `rules.ts:109` sees it.
    expect(Boolean(m.headers["nonexistent-header"])).toBe(false);
  });

  /**
   * WHY THE PROTOTYPE IS PINNED AND NOT JUST THE ABSENCE OF A THROW.
   *
   * `Object.hasOwn` alone, on a plain `{}`, stops the TypeError and replaces it with silent
   * prototype pollution: `h["__proto__"] = []` fires the `__proto__` setter, so
   * `JSON.stringify(h)` is `{}` (the header never reaches `message_bodies.headers`),
   * `Object.keys(h)` is empty, and `h["length"]` / `h["0"]` start answering with attacker
   * values. These three assertions are what tell those two states apart.
   */
  it("persists an attacker header instead of losing it, and pollutes no unrelated lookup", async () => {
    const m = await normalizeMime(PROTO_EML);
    // The map is written to `message_bodies.headers` (jsonb) by JSON serialization.
    expect(JSON.parse(JSON.stringify(m.headers))["__proto__"]).toEqual(["attacker"]);
    expect(Object.keys(m.headers)).toContain("__proto__");
    // Nothing the attacker sent may answer a lookup they did not name.
    expect(m.headers["length"]).toBeUndefined();
    expect(m.headers["0"]).toBeUndefined();
  });

  it("still appends REPEATED header values in order (the `??=` behaviour the fix replaces)", async () => {
    const m = await normalizeMime(
      [
        "Message-ID: <Repeat-1@Example.com>",
        "From: a@example.com",
        "Received: from one",
        "Received: from two",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "body",
      ].join("\r\n"),
    );
    expect(m.headers["received"]).toEqual(["from one", "from two"]);
  });

  // ── FINDING the decoded NUL ────────────────────────────────────────────────────────
  //
  // Every case below reaches the NUL through mailparser's DECODER, which is where it comes from
  // on the wire: an RFC 2047 encoded word, or a base64 body part. No test here writes U+0000
  // into a JS string and hands it to `normalizeMime` — that would assert against our own
  // literal instead of against the parse.

  describe("a decoded U+0000", () => {
    it("is replaced in a subject that arrived as an encoded word", async () => {
      const m = await normalizeMime(
        [
          "Message-ID: <Poison-3a@Example.com>",
          "From: Attacker <mallory@example.com>",
          `Subject: ${NUL_ENCODED_WORD}`,
          "Content-Type: text/plain; charset=utf-8",
          "",
          "body",
        ].join("\r\n"),
      );
      // Proof the encoded word really decoded: three code points, not the raw `=?utf-8?…` text.
      expect(m.subject).toBe(`a${NUL_REPLACEMENT}b`);
      expect(m.subject).not.toContain(NUL);
    });

    it("is replaced in a display NAME that arrived as an encoded word", async () => {
      const m = await normalizeMime(
        [
          "Message-ID: <Poison-3b@Example.com>",
          `From: ${NUL_ENCODED_WORD} <mallory@example.com>`,
          "Subject: hi",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "body",
        ].join("\r\n"),
      );
      expect(m.from.name).toBe(`a${NUL_REPLACEMENT}b`);
      expect(m.from.address).toBe("mallory@example.com");
    });

    it("is replaced in a text body that arrived base64-encoded, and the dedup key agrees", async () => {
      const m = await normalizeMime(
        [
          "Message-ID: <Poison-3c@Example.com>",
          "From: mallory@example.com",
          "Subject: hi",
          "Content-Type: text/plain; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(`hello${NUL}world`, "utf8").toString("base64"),
          "",
        ].join("\r\n"),
      );
      expect(m.textBody).toContain(`hello${NUL_REPLACEMENT}world`);
      expect(m.textBody).not.toContain(NUL);
      // THE POINT OF NORMALISING EARLY: the canonical body hash is the hash of the string that
      // gets stored, so the message dedups against itself on the next sync. Scrub after the
      // hash and these two disagree forever.
      expect(m.canonical.bodyHash).toBe(bodyHash(m.textBody));
    });

    it("is replaced in an html body that arrived base64-encoded, and in its text conversion", async () => {
      const m = await normalizeMime(
        [
          "Message-ID: <Poison-3d@Example.com>",
          "From: mallory@example.com",
          "Subject: hi",
          "Content-Type: text/html; charset=utf-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(`<p>a${NUL}b</p>`, "utf8").toString("base64"),
          "",
        ].join("\r\n"),
      );
      expect(m.htmlBody).toBe(`<p>a${NUL_REPLACEMENT}b</p>`);
      // mailparser derives `text` from the html for an html-only message; that copy carries the
      // NUL too, and it is the copy `message_bodies.text` and the snippet come from.
      expect(m.textBody).not.toContain(NUL);
      expect(m.textBody).toContain(NUL_REPLACEMENT);
    });

    it("is replaced in a LITERAL 0x00 byte on the wire — subject, header value, and body", async () => {
      const m = await normalizeMime(
        Buffer.from(
          [
            "Message-ID: <Poison-3e@Example.com>",
            "From: mallory@example.com",
            `Subject: plain${NUL}subject`,
            `X-Raw: before${NUL}after`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            `body${NUL}text`,
          ].join("\r\n"),
          "utf8",
        ),
      );
      expect(m.subject).toBe(`plain${NUL_REPLACEMENT}subject`);
      expect(m.headers["x-raw"]).toEqual([`before${NUL_REPLACEMENT}after`]);
      expect(m.textBody).toContain(`body${NUL_REPLACEMENT}text`);
    });

    it("is replaced in a header NAME, which jsonb refuses as firmly as a value", async () => {
      const m = await normalizeMime(
        Buffer.from(
          [
            "Message-ID: <Poison-3f@Example.com>",
            "From: mallory@example.com",
            "Subject: hi",
            `X-Ra${NUL}w: value`,
            "Content-Type: text/plain; charset=utf-8",
            "",
            "body",
          ].join("\r\n"),
          "utf8",
        ),
      );
      const names = Object.keys(m.headers);
      expect(names.some((n) => n.includes(NUL))).toBe(false);
      expect(names).toContain(`x-ra${NUL_REPLACEMENT}w`);
    });

    it("is replaced in attachment filename, content type and content id", async () => {
      const m = await normalizeMime(
        [
          "Message-ID: <Poison-3g@Example.com>",
          "From: mallory@example.com",
          "Subject: att",
          'Content-Type: multipart/mixed; boundary="B"',
          "",
          "--B",
          "Content-Type: text/plain; charset=utf-8",
          "",
          "see attached",
          "",
          "--B",
          `Content-Type: application/${NUL_ENCODED_WORD}`,
          "Content-Transfer-Encoding: base64",
          `Content-ID: <${NUL_ENCODED_WORD}>`,
          `Content-Disposition: attachment; filename=${NUL_ENCODED_WORD}`,
          "",
          "AAAA",
          "",
          "--B--",
          "",
        ].join("\r\n"),
      );
      const att = m.attachments[0]!;
      expect(att.filename).toBe(`a${NUL_REPLACEMENT}b`);
      for (const v of [att.filename, att.contentType, att.contentId, att.partId]) {
        expect(v ?? "").not.toContain(NUL);
      }
    });

    /**
     * The whole-object sweep, so a field added to {@link NormalizedMessage} later is not
     * silently exempt: nothing this function returns may carry U+0000 anywhere.
     */
    it("leaves no U+0000 anywhere in the returned object", async () => {
      const m = await normalizeMime(
        Buffer.from(
          [
            "Message-ID: <Poison-3h@Example.com>",
            `From: ${NUL_ENCODED_WORD} <mallory@example.com>`,
            `To: ${NUL_ENCODED_WORD} <victim@example.com>`,
            `Subject: ${NUL_ENCODED_WORD}`,
            `X-Raw${NUL}: ${NUL_ENCODED_WORD}`,
            'Content-Type: multipart/mixed; boundary="B"',
            "",
            "--B",
            "Content-Type: text/plain; charset=utf-8",
            "Content-Transfer-Encoding: base64",
            "",
            Buffer.from(`body${NUL}text`, "utf8").toString("base64"),
            "",
            "--B",
            "Content-Type: application/octet-stream",
            "Content-Transfer-Encoding: base64",
            `Content-Disposition: attachment; filename=${NUL_ENCODED_WORD}`,
            "",
            "AAAA",
            "",
            "--B--",
            "",
          ].join("\r\n"),
          "utf8",
        ),
      );
      // A NUL survives JSON.stringify as the six-character escape \u0000 — exactly the form jsonb
      // rejects — so this is the same question the database asks.
      expect(JSON.stringify(m)).not.toContain("\\u0000");
      // …and the message is still usable, not emptied out to pass.
      expect(m.subject).toBe(`a${NUL_REPLACEMENT}b`);
      expect(m.to[0]!.address).toBe("victim@example.com");
      expect(m.attachments).toHaveLength(1);
    });
  });

  // ── FINDING bounding the parse ─────────────────────────────────────────────────────

  /**
   * A letter with no text part keeps its html's words as `textBody`, and its identity reads the
   * parse's own text (`ownText`, empty here): the fingerprint corpus pins the digests from before.
   */
  describe("a letter with html and no text part", () => {
    const PNG = ["Content-Type: image/png", "Content-ID: <pic@x>", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo="];
    const PDF = ['Content-Type: application/pdf; name="a.pdf"', 'Content-Disposition: attachment; filename="a.pdf"',
      "Content-Transfer-Encoding: base64", "", "JVBERi0xLjQK"];
    const LETTER = '<head><style>.brand{color:red}</style></head><table><tr><td>Hello</td><td>World</td></tr></table>'
      + '<div>Line one</div><div>Line two</div><img src="cid:pic@x" alt="Logo">';
    const WORDS = "Hello World\n\nLine one\nLine two";
    const head = (type: string) => ["Message-ID: <html-only@example.test>", "From: a@example.test", "To: b@example.test",
      "Subject: pictures", "MIME-Version: 1.0", `Content-Type: ${type}`, ""];
    const related = (html: string) => [...head('multipart/related; boundary="R"'), "--R", "Content-Type: text/html; charset=utf-8", "",
      html, "--R", ...PNG, "--R--", ""].join("\r\n");
    const SHAPES: Record<string, string> = {
      related: related(LETTER),
      htmlWithPdf: [...head('multipart/mixed; boundary="B"'), "--B", "Content-Type: text/html; charset=utf-8", "", LETTER,
        "--B", ...PDF, "--B--", ""].join("\r\n"),
      emptyTextAlternative: [...head('multipart/alternative; boundary="A"'), "--A", "Content-Type: text/plain", "", "",
        "--A", "Content-Type: text/html; charset=utf-8", "", LETTER, "--A--", ""].join("\r\n"),
      relatedInMixed: [...head('multipart/mixed; boundary="B"'), "--B", 'Content-Type: multipart/related; boundary="R"', "",
        "--R", "Content-Type: text/html; charset=utf-8", "", LETTER, "--R", ...PNG, "--R--", "", "--B", ...PDF, "--B--", ""].join("\r\n"),
    };

    it.each(Object.keys(SHAPES))("%s: textBody is the words, the identity reads the empty text", async (name) => {
      const m = await normalizeMime(SHAPES[name]!);
      expect(m.textBody).toBe(WORDS);
      expect(m.ownText?.trim()).toBe("");
      expect(m.canonical.bodyHash).toBe(bodyHash(""));
      expect(messageFingerprint(m)).toBe(messageFingerprint({ ...m, textBody: m.ownText!, ownText: undefined }));
    });

    it("a root html over the html-to-text bound gives its early words, and keeps hashing the html", async () => {
      const html = "<p>Early words</p>" + "<div>x</div>".repeat(90_000);
      expect(html.length).toBeGreaterThan(MAX_HTML_TO_TEXT_CHARS);
      const m = await normalizeMime([...head("text/html; charset=utf-8"), html, ""].join("\r\n"));
      expect(m.textBody.startsWith("Early words\n\nx\nx")).toBe(true);
      expect(m.textBody.length).toBeLessThanOrEqual(65_536);
      expect(m.ownText).toBe("");
      expect(m.canonical.bodyHash).toBe(bodyHash(m.htmlBody!));
    });

    it.each([
      ["a picture only", '<img src="cid:pic@x" alt="Logo">'],
      ["hidden text only", '<div style="display: none !important">Preheader</div><style>p{}</style>'],
      ["preheader filler only", "<p>\u034f\u200c \u034f\u200c&zwnj; \u00ad\u200b</p>"],
    ])("%s stays empty, with no ownText", async (_n, html) => {
      const m = await normalizeMime(related(html));
      expect(m.textBody.trim()).toBe("");
      expect(m.ownText).toBeUndefined();
    });

    it("a letter with a real text part is unchanged", async () => {
      const m = await normalizeMime([...head('multipart/alternative; boundary="A"'), "--A", "Content-Type: text/plain", "", "Own words",
        "--A", "Content-Type: text/html; charset=utf-8", "", LETTER, "--A--", ""].join("\r\n"));
      expect(m.textBody.trim()).toBe("Own words");
      expect(m.ownText).toBeUndefined();
    });
  });

  describe("the parse is bounded", () => {
    /** An html-only message: mailparser only converts html→text when there is no text/plain. */
    const htmlOnly = (html: string) =>
      [
        "Message-ID: <Poison-1@Example.com>",
        "From: mallory@example.com",
        "Subject: nested",
        "Content-Type: text/html; charset=utf-8",
        "",
        html,
        "",
      ].join("\r\n");

    it("refuses a raw source over the byte ceiling with a TYPED error, not a crash", async () => {
      const over = Buffer.alloc(MAX_RAW_MESSAGE_BYTES + 1, 0x41);
      const err = await normalizeMime(over).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MimeTooLargeError);
      expect((err as MimeTooLargeError).bytes).toBe(MAX_RAW_MESSAGE_BYTES + 1);
      expect((err as MimeTooLargeError).limit).toBe(MAX_RAW_MESSAGE_BYTES);
      expect((err as Error).name).toBe("MimeTooLargeError");
    });

    /**
     * The ceiling is measured in BYTES. This string's `.length` is comfortably under the limit
     * and its UTF-8 encoding is over it, so `raw.length` in place of `Buffer.byteLength` is red
     * here — the same char-vs-byte mistake `html-storage.ts` documents.
     */
    it("measures the ceiling in BYTES, not UTF-16 code units", async () => {
      const emoji = "😀".repeat(MAX_RAW_MESSAGE_BYTES / 4 + 1); // 4 bytes each, 2 code units each
      expect(emoji.length).toBeLessThan(MAX_RAW_MESSAGE_BYTES);
      expect(Buffer.byteLength(emoji, "utf8")).toBeGreaterThan(MAX_RAW_MESSAGE_BYTES);
      await expect(normalizeMime(emoji)).rejects.toBeInstanceOf(MimeTooLargeError);
    });

    /**
     * THE CPU POISON MESSAGE, which no byte ceiling can see.
     *
     * Hundreds of thousands of nested `<div>`s are a few MB of raw — far under {@link MAX_RAW_MESSAGE_BYTES} — and
     * measured at 98 514 ms of `htmlToText` before mailparser gave up and REJECTED with
     * `Error: Failed to parse HTML`, discarding the message. With
     * {@link MAX_HTML_TO_TEXT_CHARS} set, the conversion is refused up front instead.
     *
     * The assertions are the three things that must all hold at once: it resolves, it resolves
     * FAST, and the html the user came for is still there.
     */
    it("still returns a usable message when the html defeats html-to-text, and returns it fast", async () => {
      const depth = 400_000;
      const html = "<div>".repeat(depth) + "needle" + "</div>".repeat(depth);
      expect(html.length).toBeGreaterThan(MAX_HTML_TO_TEXT_CHARS);

      const t0 = Date.now();
      const m = await normalizeMime(htmlOnly(html));
      const ms = Date.now() - t0;

      expect(m.htmlBody).toContain("needle");
      expect(m.subject).toBe("nested");
      // Unbounded, this same input measured 98 514 ms. Two orders of magnitude of headroom so
      // the assertion is about the guard and not about the speed of the machine running it.
      expect(ms).toBeLessThan(5_000);
    });

    /**
     * …and the message that took that path must not dedup against every OTHER message that took
     * it. `skipHtmlToText` leaves `text` empty, so hashing `textBody` would give every such
     * message `body:<sha256 of "">` and the second one would be filed as a duplicate of the
     * first. Two DIFFERENT oversized-html messages, neither carrying a Message-ID.
     */
    it("does not collapse two different html-to-text refusals onto one dedup key", async () => {
      const over = (needle: string) =>
        [
          "From: mallory@example.com",
          "Subject: nested",
          "Content-Type: text/html; charset=utf-8",
          "",
          "<div>".repeat(200_000) + needle + "</div>".repeat(200_000),
          "",
        ].join("\r\n");

      const a = await normalizeMime(over("first"));
      const b = await normalizeMime(over("second"));
      expect(a.canonical.messageIdHeader).toBeNull();
      expect(b.canonical.messageIdHeader).toBeNull();
      // The identity's text; `textBody` may now hold the words of the stored head.
      expect(a.ownText ?? a.textBody).toBe("");
      expect(legacyDedupKey(a.canonical)).not.toBe(legacyDedupKey(b.canonical));
      expect(a.canonical.bodyHash).not.toBe(bodyHash(""));
      // …and the same holds for the key ingest actually writes. The fingerprint hashes the text and
      // the html SEPARATELY, so on this path the empty text is shared and the html is what
      // separates them — belt and braces over the `bodyForCanonical` fallback above.
      expect(messageFingerprint(a)).not.toBe(messageFingerprint(b));
    });

    /**
     * Under the html-to-text cap, nesting cost the parser's own stack: html-to-text's htmlparser2 kept it with
     * unshift, so a crafted letter at the cap held the shared worker 9 s (`patches/htmlparser2@10.1.0.patch`).
     */
    it("parses a deep nest just under the html-to-text cap in under 2 s, keeping the html", async () => {
      const html = "<p>" + "x<b>".repeat(Math.floor((MAX_HTML_TO_TEXT_CHARS - 3) / 4));
      expect(html.length).toBeGreaterThan(MAX_HTML_TO_TEXT_CHARS - 4);
      const t0 = performance.now();
      const m = await normalizeMime(htmlOnly(html));
      const ms = performance.now() - t0;
      expect(m.htmlBody?.trimEnd()).toBe(html);
      expect(ms).toBeLessThan(2_000);
    }, 60_000);

    /** An ordinary html-only message is untouched by any of this — text still comes back. */
    it("leaves an ordinary html-only message converting to text as before", async () => {
      const m = await normalizeMime(htmlOnly("<p>hello</p><p>world</p>"));
      expect(m.htmlBody).toContain("<p>hello</p>");
      expect(m.textBody).toContain("hello");
      expect(m.textBody).toContain("world");
    });

    /**
     * The last hole in the contract: mailparser throwing something we did not anticipate must
     * still arrive as one of this module's typed errors, or the worker cannot tell a poison
     * message from a bug in our own code. `simpleParser` throws `TypeError` synchronously here.
     */
    it("wraps anything else mailparser refuses in MimeParseError, never a bare TypeError", async () => {
      const err = await normalizeMime(null as unknown as string).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(MimeParseError);
      expect((err as Error).name).toBe("MimeParseError");
      expect((err as Error).cause).toBeInstanceOf(TypeError);
    });
  });
});

/**
 * Two behaviours mailparser 3.9.32 changed, each pinned by a fixture. A head over mailsplit's
 * 1 MiB was parsed by 3.9.18 as a message with no headers at all; it is now refused, named, so the
 * worker quarantines it deterministically (`mime_unparseable`) and the message stays on the server.
 * EUC-JP left 3.9.18's Japanese special case for iconv-lite; the recorded text reads the same.
 */
describe("the parser's behaviour changes in mailparser 3.9.32", () => {
  it("refuses a head over 1 MiB with MimeParseError, never a headerless message", async () => {
    const raw = Buffer.from([
      "From: a@example.com", `X-Filler: ${"x".repeat(1100 * 1024)}`, "To: bob@example.org", "Subject: big head",
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "hi", "",
    ].join("\r\n"));
    const err = await normalizeMime(raw).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MimeParseError);
    expect((err as Error).message).toContain("Max header size for a MIME node exceeded");
  });

  it("decodes an EUC-JP text body to the recorded string", async () => {
    const body = Buffer.from(
      "b2f1b5c4a4cfccc0c6fca4ceb8e1b8e5bbb0bbfea4c7a4b9a1a33130bbfe8fa2b73131bbfea1a2a5aba5bfa5aba5caa1a28eb68ec08eb68ec5a1a2ada1a1a3",
      "hex",
    );
    const raw = Buffer.concat([Buffer.from([
      "From: a@example.com", "To: b@example.org", "Subject: eucjp", "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=EUC-JP", "Content-Transfer-Encoding: 8bit", "", "",
    ].join("\r\n")), body, Buffer.from("\r\n")]);
    const m = await normalizeMime(raw);
    expect(m.textBody.trim()).toBe("会議は明日の午後三時です。10時～11時、カタカナ、ｶﾀｶﾅ、①。");
  });
});

/** `mime_parse_ms`: each parse's wall time and raw size reach the caller's log at debug, a slow one as a warn. */
describe("normalizeMime reports each parse's time to the caller's log", () => {
  const lines: { level: string; event: string; fields?: Record<string, unknown> }[] = [];
  const emit = (level: string) => (event: string, fields?: Record<string, unknown>) => { lines.push({ level, event, fields }); };
  const log = { level: "debug", debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") } as unknown as Logger;
  (log as unknown as { child: () => Logger }).child = () => log;
  const raw = Buffer.from(["From: a@example.com", "To: b@example.org", "Subject: t", "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8", "", "hi", ""].join("\r\n"));
  afterEach(() => { lines.length = 0; vi.restoreAllMocks(); });

  it("writes one debug line per parse, with the milliseconds and the raw bytes", async () => {
    await normalizeMime(raw, { log });
    expect(lines).toEqual([{ level: "debug", event: "mime_parse_ms", fields: { ms: expect.any(Number), bytes: raw.length } }]);
  });

  it("writes a parse over 2 s as a warn", async () => {
    let t = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (t += 2001));
    await normalizeMime(raw, { log });
    expect(lines.map((l) => [l.level, l.event])).toEqual([["warn", "mime_parse_ms"]]);
  });

  it("times a parse that is refused", async () => {
    const big = Buffer.from(["From: a@example.com", `X-Filler: ${"x".repeat(1100 * 1024)}`, "To: b@example.org",
      "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", "hi", ""].join("\r\n"));
    const err = await normalizeMime(big, { log }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(MimeParseError);
    expect(lines.map((l) => [l.event, l.fields?.bytes])).toEqual([["mime_parse_ms", big.length]]);
  });

  // The production logger at its default level, as the worker, the desktop and the phone build it:
  // an ordinary parse has nothing to say, so it writes no line; a slow one still does.
  describe("through the real logger at its default level", () => {
    const saved = process.env.TF_LOG_LEVEL;
    const real = (out: string[]) => {
      delete process.env.TF_LOG_LEVEL;
      return createLogger({ service: "worker", sink: (l) => out.push(l) });
    };
    afterEach(() => { if (saved === undefined) delete process.env.TF_LOG_LEVEL; else process.env.TF_LOG_LEVEL = saved; });

    it("writes no line for an ordinary parse", async () => {
      const out: string[] = [];
      await normalizeMime(raw, { log: real(out) });
      expect(out).toEqual([]);
    });

    it("writes a parse over 2 s as one warn", async () => {
      const out: string[] = [];
      const log = real(out);
      let t = 0;
      vi.spyOn(Date, "now").mockImplementation(() => (t += 2001));
      await normalizeMime(raw, { log });
      expect(out.map((l) => JSON.parse(l) as Record<string, unknown>).map((e) => [e.level, e.event]))
        .toEqual([["warn", "mime_parse_ms"]]);
    });
  });

  it("writes nothing and still parses with no log", async () => {
    const m = await normalizeMime(raw);
    expect(m.subject).toBe("t");
    expect(lines).toEqual([]);
  });
});

/** The Date header on the phone: forms Hermes refuses or misreads (measured, `_hermes-date.ts`) still give the sent instant. */
describe("normalizeMime reads the Date header on the phone's Date", () => {
  const at = Date.UTC(2026, 9, 24, 4, 29, 9);
  const cases: Array<[string, number]> = [
    ["24 Oct 2026 06:29:09 +0200", at], ["4 Oct 2026 06:29:09 +0200", Date.UTC(2026, 9, 4, 4, 29, 9)],
    ["24 Oct 2026 04:29:09 GMT", at], ["Sat, 24 Oct 2026 06:29 +0200", at - 9000],
    ["Sat, 24 Oct 2026 04:29:09 UT", at], ["Sat, 24 Oct 2026 04:29:09 Z", at],
    ["Sat, 24 Oct 2026 06:29:09 +02:00", at], ["Sat, 24 oct 2026 06:29:09 +0200", at],
    ["Sat, 24 Oct 26 06:29:09 +0200", at], ["24 Oct 26 06:29:09 +0200", at],
    ["Sun, 24 Oct 99 06:29:09 +0200", Date.UTC(1999, 9, 24, 4, 29, 9)],
  ];
  let restore: () => void = () => {};
  afterEach(() => restore());
  it.each(cases)("Date: %s", async (header, want) => {
    restore = usePhoneDate();
    const m = await normalizeMime(`Date: ${header}\r\nFrom: a@example.com\r\nSubject: d\r\n\r\nhi\r\n`);
    expect(m.date?.getTime()).toBe(want);
  });
});

/** The Date header on Node: read as Node and mailparser read it, so stored `fp1` keys keep matching. */
describe("mailDate reads what the runtime read, and the zone names it refuses", () => {
  const at = Date.UTC(2026, 9, 24, 4, 29, 9);
  const raw = (...dates: string[]) => `${dates.map((d) => `Date: ${d}\r\n`).join("")}From: a@example.com\r\n\r\nhi\r\n`;

  it("strips a hostile nested comment in linear time", () => {
    const n = 20_000;
    const hostile = `Sat, 24 Oct 2026 06:29:09 +0200 ${"(".repeat(n)}${")".repeat(n)}`;
    const t0 = performance.now();
    mailDate(hostile);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(mailDate("Sat, 24 Oct 2026 06:29:09 +0200 (CEST (summer \\) time))")?.getTime()).toBe(at);
    expect(mailDate("Sat, 24 Oct 2026 06:29:09 +0200 (unclosed")?.getTime()).toBe(new Date("Sat, 24 Oct 2026 06:29:09 +0200 (unclosed").getTime());
  });

  it("reads the last of two Date lines, as mailparser does", async () => {
    const m = await normalizeMime(raw("Sat, 24 Oct 2026 06:29:09 CET", "Sat, 24 Oct 2026 06:29:15 +0200"));
    expect(m.date?.getTime()).toBe(at + 6000);
  });

  it("keeps fractional seconds and reads years 0-99 of any width as two-digit years", () => {
    expect(mailDate("Sat, 24 Oct 2026 06:29:09.1239 +0200")?.getTime()).toBe(at + 123);
    expect(mailDate("Sat, 24 Oct 0026 06:29:09 +0200")?.getTime()).toBe(at);
    expect(mailDate("Mon, 01 Jan 0001 00:00:00 +0000")?.getTime()).toBe(Date.UTC(2001, 0, 1));
  });

  it("reads the common zone names at their offsets and leaves an unknown one to the runtime", async () => {
    expect(mailDate("Sat, 24 Oct 2026 06:29:09 CEST")?.getTime()).toBe(at);
    expect(mailDate("Sat, 24 Oct 2026 05:29:09 MEZ")?.getTime()).toBe(at);
    expect(mailDate("Sat, 24 Oct 2026 13:29:09 JST")?.getTime()).toBe(at);
    expect(mailDate("Fri, 23 Oct 2026 20:29:09 AKDT")?.getTime()).toBe(at);
    expect(mailDate("Sat, 24 Oct 2026 01:59:09 NDT")?.getTime()).toBe(at);
    // IST is India, Ireland or Israel: unread here, so Node stores the parse time as before.
    expect(mailDate("Sat, 24 Oct 2026 06:29:09 IST")).toBe(null);
    const before = Date.now();
    const m = await normalizeMime(raw("Sat, 24 Oct 2026 06:29:09 IST"));
    expect(m.date!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("keeps the runtime's own reading beside a deliberate correction", async () => {
    const m = await normalizeMime(raw("Sat, 24 Oct 126 06:29:09 +0200"));
    expect(m.date?.getTime()).toBe(at);
    expect(m.runtimeDate?.getTime()).toBe(new Date("Sat, 24 Oct 126 06:29:09 +0200").getTime());
    expect((await normalizeMime(raw("Sat, 24 Oct 2026 06:29:09 +0200"))).runtimeDate).toBeUndefined();
    expect((await normalizeMime(raw("Sat, 24 Oct 2026 06:29:09 CEST"))).runtimeDate).toBeUndefined();
  });
});
