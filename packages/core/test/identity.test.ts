import { describe, it, expect } from "vitest";
import {
  normalizeMessageId, bodyHash, canonicalId, legacyDedupKey,
  messageFingerprint, fingerprintDedupKey, isFingerprintDedupKey, verifiesLegacyIdentity,
  type FingerprintInput,
} from "../src/identity.js";
import type { AttachmentMeta, EmailAddress } from "../src/types.js";
import { normalizeMime } from "../src/mime.js";
import { isHuskSameMessage } from "../src/husk-restore.js";

/** A complete fingerprint input with everything empty — the base every case perturbs by ONE field. */
function input(over: Partial<FingerprintInput> = {}): FingerprintInput {
  return {
    canonical: { messageIdHeader: null, bodyHash: bodyHash("") },
    subject: "",
    from: { name: null, address: "" },
    to: [],
    cc: [],
    date: null,
    textBody: "",
    htmlBody: null,
    attachments: [],
    ...over,
  };
}

/** `canonical` derived the way `mime.ts` derives it, so a case's body and its hash cannot disagree. */
function body(text: string, messageId: string | null = null): Partial<FingerprintInput> {
  return { canonical: canonicalId(messageId, text), textBody: text };
}

const addr = (address: string): EmailAddress => ({ name: null, address });

const attachment = (over: Partial<AttachmentMeta> = {}): AttachmentMeta => ({
  filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10,
  partId: "2", contentId: null, inline: false, contentSha256: "aa".repeat(32),
  ...over,
});

describe("identity", () => {
  it("strips angle brackets and PRESERVES the Message-ID's case", () => {
    // It used to lowercase. RFC 5322 §3.6.4 makes `id-left` a `dot-atom-text` — case-SIGNIFICANT —
    // so `<AbC@x>` and `<abc@x>` are two different identifiers, and folding them meant two
    // messages collapsed onto one row and one of them was never shown. Restore the
    // `.toLowerCase()` in `normalizeMessageId` and this line reports 'abc@example.com'.
    expect(normalizeMessageId("<ABC@Example.com>")).toBe("ABC@Example.com");
  });
  it("returns null for a missing Message-ID", () => {
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId("   ")).toBeNull();
  });
  it("hashes the body insensitive to CRLF/whitespace", () => {
    expect(bodyHash("hello\r\nworld")).toBe(bodyHash("hello\nworld  "));
  });
  it("the LEGACY key still lowercases — those rows were written that way", () => {
    // The fold is deliberate here and nowhere else. A key computed without it would miss every
    // stored row whose Message-ID had an upper-case character, and the message would be re-inserted
    // as new — a second `messages` row for one logical message, which no delta removes.
    expect(legacyDedupKey(canonicalId("<AbC@y>", "b"))).toBe("mid:abc@y");
    expect(legacyDedupKey(canonicalId(null, "b"))).toBe(`body:${bodyHash("b")}`);
  });
});

describe("messageFingerprint — the logical identity", () => {
  it("is stable: the same input twice is the same digest", () => {
    const m = input({ ...body("hello", "a@b"), subject: "Hi", from: addr("s@x.example") });
    expect(messageFingerprint(m)).toBe(messageFingerprint(m));
  });

  it("is a 64-hex sha256, and the key carries the version prefix", () => {
    const fp = messageFingerprint(input());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintDedupKey(fp)).toBe(`fp1:${fp}`);
    expect(isFingerprintDedupKey(fingerprintDedupKey(fp))).toBe(true);
    expect(isFingerprintDedupKey("mid:a@b")).toBe(false);
    expect(isFingerprintDedupKey(`body:${bodyHash("x")}`)).toBe(false);
  });

  /**
   * DOMAIN SEPARATION — the label is what stops bytes moving between two DIFFERENT fields.
   *
   * `sha256(subject + from)` cannot tell `subject="a", from="b"` from `subject="ab", from=""` —
   * both hash the bytes `ab`. An attacker chooses both halves, so they can manufacture a message
   * whose logical identity equals one the user already consented to, which is where the consent-boundary finding starts.
   */
  it("cannot be collided by moving bytes between two DIFFERENT fields", () => {
    const a = messageFingerprint(input({ subject: "a", from: addr("b") }));
    const b = messageFingerprint(input({ subject: "ab", from: addr("") }));
    expect(a).not.toBe(b);
  });

  /**
   * THE LENGTH PREFIX — what stops bytes moving between two fields with the SAME label.
   *
   * The label above cannot help here: `to` is a REPEATED field, so two adjacent records carry the
   * identical label and the only thing separating them is where each payload ends. With a length
   * prefix the payload is never scanned, so it may contain any byte at all. Without one, the
   * encoding is `label SEP payload END` and a value that contains those separator bytes can
   * impersonate the boundary between two records:
   *
   *   ONE recipient whose address is  `a` END `to` SEP PRESENT `b`
   *   TWO recipients                  `a`  and  `b`
   *
   * serialise to the identical byte string. And both halves are attacker-chosen: a `To:` header is
   * written by whoever sent the mail. So a stranger could give their message the logical identity of
   * one the user already accepted, which is the premise handed over for free.
   *
   * Delete the length prefix from `field()` and this test reports two equal digests. (It is also why
   * the encoding is byte-oriented rather than string-oriented — `Buffer.byteLength`, not `.length`.)
   */
  it("cannot be collided by a field value that impersonates a record boundary", () => {
    const SEP = "\u001f";
    const END = "\u001e";
    const PRESENT = "\u0001";
    const one = messageFingerprint(input({ to: [addr(`a${END}to${SEP}${PRESENT}b`)] }));
    const two = messageFingerprint(input({ to: [addr("a"), addr("b")] }));
    expect(one).not.toBe(two);
  });

  it("distinguishes an ABSENT field from an empty one", () => {
    // `null` and `""` are different claims: "this message has no Message-ID" and "its Message-ID is
    // the empty string" (which `normalizeMessageId` cannot produce, but `htmlBody` and
    // `contentSha256` can both be either). One byte of payload keeps them apart; drop the
    // ABSENT/PRESENT marker and these collapse.
    expect(messageFingerprint(input({ htmlBody: null })))
      .not.toBe(messageFingerprint(input({ htmlBody: "" })));
    expect(messageFingerprint(input({ attachments: [attachment({ contentSha256: null })] })))
      .not.toBe(messageFingerprint(input({ attachments: [attachment({ contentSha256: "" })] })));
  });

  /**
   * EVERY INPUT IS LOAD-BEARING. One field at a time, each perturbed away from the same base.
   *
   * Stated as a table because the failure mode is a field being dropped as "not needed" — and the
   * consequence of a dropped field is not a wrong answer, it is MAIL SILENTLY LOST: two messages
   * that differ only in that field become one `messages` row and the second is never shown.
   */
  it.each<[string, Partial<FingerprintInput>]>([
    ["the Message-ID", body("same", "other@x")],
    ["the Message-ID's CASE", body("same", "OTHER@x")],
    ["the from address", { from: addr("someone@else.example") }],
    ["a To recipient", { to: [addr("a@x.example")] }],
    ["the ORDER of To recipients", { to: [addr("b@x.example"), addr("a@x.example")] }],
    ["a Cc recipient", { cc: [addr("c@x.example")] }],
    ["the subject", { subject: "different" }],
    ["the Date", { date: new Date("2026-01-01T00:00:00Z") }],
    ["the text body", body("different")],
    ["the html body", { htmlBody: "<p>different</p>" }],
    ["an attachment's filename", { attachments: [attachment({ filename: "b.pdf" })] }],
    ["an attachment's content type", { attachments: [attachment({ contentType: "text/plain" })] }],
    ["an attachment's size", { attachments: [attachment({ sizeBytes: 11 })] }],
    ["an attachment's CONTENT digest", { attachments: [attachment({ contentSha256: "bb".repeat(32) })] }],
    ["the NUMBER of attachments", { attachments: [attachment(), attachment({ filename: "b.pdf" })] }],
  ])("changes when %s changes", (_label, over) => {
    const base = input({
      ...body("same", "m@x"), subject: "Subject", from: addr("s@x.example"),
      to: [addr("a@x.example"), addr("b@x.example")], cc: [], htmlBody: "<p>same</p>",
      attachments: [attachment()],
    });
    expect(messageFingerprint({ ...base, ...over })).not.toBe(messageFingerprint(base));
  });

  it("hashes text and html SEPARATELY, so an added html part is a different message", () => {
    // The pre-existing single `bodyHash` prefers text and only falls back to html on the
    // `skipHtmlToText` path, so it structurally cannot express "same text, html appeared".
    const textOnly = input({ ...body("hello"), htmlBody: null });
    const withHtml = input({ ...body("hello"), htmlBody: "<p>hello</p>" });
    expect(messageFingerprint(textOnly)).not.toBe(messageFingerprint(withHtml));
  });

  it("two anchorless messages with the same body but different subjects are DIFFERENT", () => {
    // Under the legacy `body:` key these were ONE row: no Message-ID, identical body text (an empty
    // auto-reply, a bare "thanks"), so the second was filed as a duplicate of the first and the
    // user never saw it.
    const a = input({ ...body("thanks"), subject: "Re: invoice", from: addr("s@x.example") });
    const b = input({ ...body("thanks"), subject: "Re: contract", from: addr("s@x.example") });
    expect(legacyDedupKey(a.canonical)).toBe(legacyDedupKey(b.canonical));
    expect(messageFingerprint(a)).not.toBe(messageFingerprint(b));
  });

  it("a stranger naming somebody else's Message-ID gets a DIFFERENT identity", () => {
    // The Message-ID is chosen by whoever sent the mail. Under `mid:` alone, an attacker who names
    // the id of a message the user already holds IS that message as far as the pipeline can tell.
    const genuine = input({ ...body("the real body", "shared@id"), subject: "Invoice", from: addr("bank@real.example") });
    const forged = input({ ...body("the attacker's body", "shared@id"), subject: "Invoice", from: addr("bank@real.example") });
    expect(legacyDedupKey(genuine.canonical)).toBe(legacyDedupKey(forged.canonical));
    expect(messageFingerprint(genuine)).not.toBe(messageFingerprint(forged));
  });
});

describe("verifiesLegacyIdentity — step 2 of the dual-key lookup", () => {
  const observed = input({
    ...body("the body", "AbC@x"), subject: "Subject", from: addr("s@x.example"),
  });
  /** The legacy row as it would have been stored: the Message-ID folded to lower case. */
  const stored = {
    messageIdHeader: "abc@x",
    bodyHash: observed.canonical.bodyHash,
    subject: "Subject",
    fromAddress: "s@x.example",
  };

  it("accepts a genuine legacy row, matching the Message-ID CASE-INSENSITIVELY", () => {
    // The stored value was folded by the pre-slice `normalizeMessageId`; the observed one is not.
    // Compare them raw and every mixed-case legacy row is refused and re-inserted as new — a
    // second `messages` row per message, which is the highest-damage outcome on this path.
    expect(verifiesLegacyIdentity(stored, observed)).toBe(true);
  });

  it.each<[string, Partial<typeof stored>]>([
    ["the Message-ID differs", { messageIdHeader: "other@x" }],
    ["the body hash differs", { bodyHash: bodyHash("something else") }],
    ["the subject differs", { subject: "Another subject" }],
    ["the from address differs", { fromAddress: "attacker@evil.example" }],
  ])("REFUSES when %s — any mismatch means a NEW message, never a partial collapse", (_l, over) => {
    expect(verifiesLegacyIdentity({ ...stored, ...over }, observed)).toBe(false);
  });

  it("treats a NULL Message-ID on one side only as a mismatch", () => {
    expect(verifiesLegacyIdentity({ ...stored, messageIdHeader: null }, observed)).toBe(false);
    const anchorless = input({ ...body("the body"), subject: "Subject", from: addr("s@x.example") });
    expect(verifiesLegacyIdentity(stored, anchorless)).toBe(false);
    // …and null on BOTH sides is the `body:` key's legitimate shape.
    expect(verifiesLegacyIdentity(
      { ...stored, messageIdHeader: null, bodyHash: anchorless.canonical.bodyHash }, anchorless,
    )).toBe(true);
  });

  it("does NOT compare `date` — the trap the ruling names by name", () => {
    // `messages.date` is `timestamptz` and has been through Postgres; `parsed.date` has not. A
    // sub-millisecond or zone difference would refuse a genuine re-observation, and a refusal here
    // means a SECOND `messages` row plus a second `threads` row. So the tuple is four columns, and
    // a message whose Date changed but whose four columns agree still verifies.
    expect(verifiesLegacyIdentity(stored, { ...observed, date: new Date("1999-01-01T00:00:00Z") }))
      .toBe(true);
  });
});

describe("a husk stored under the runtime's own Date reading", () => {
  it("is the same message when only that reading differs, with no Message-ID to vouch", async () => {
    const header = "Sat, 24 Oct 126 06:29:09 +0200";
    const fresh = await normalizeMime(`Date: ${header}\r\nFrom: a@example.com\r\nSubject: s\r\n\r\nhi\r\n`);
    const before = fingerprintDedupKey(messageFingerprint({ ...fresh, date: new Date(header) }));
    expect(before).not.toBe(fingerprintDedupKey(messageFingerprint(fresh)));
    expect(isHuskSameMessage({ id: "m", dedupKey: before, messageIdHeader: null }, fresh)).toBe(true);
    expect(isHuskSameMessage({ id: "m", dedupKey: "fp1:other", messageIdHeader: null }, fresh)).toBe(false);
  });
});
