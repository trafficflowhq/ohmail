import { describe, expect, it } from "vitest";
import { normalizeMime } from "../src/mime.js";
import { MAX_MESSAGE_ID_BYTES, messageFingerprint } from "../src/identity.js";
import {
  MAX_STORED_ADDRESS_CHARS, MAX_STORED_SUBJECT_CHARS, storedAddress, storedMessageId, storedSubject,
} from "../src/stored-values.js";
import { searchDocumentOf, SEARCH_HEAD_PART_MAX_CHARS } from "../src/message-search.js";

/**
 * Each sender-written value that reaches an index is bounded where it is STORED, at its edge: the bound
 * itself is admitted, one past it is not, and an address or a Message-ID is never cut into another one.
 * The parsed message keeps the values as sent, so its fingerprint is the one 0.25.6 computed and a
 * message stored before the bounds keeps its identity when it is seen again.
 */
const msg = (headers: string[]) => Buffer.from([...headers, "MIME-Version: 1.0", "Content-Type: text/plain", "", "hi", ""].join("\r\n"));
const local = (n: number) => "x".repeat(n - "@example.com".length);

describe("the stored value of an address", () => {
  it("keeps an address of exactly 254 characters and stores one more as none", () => {
    const ok = `${local(MAX_STORED_ADDRESS_CHARS)}@example.com`;
    const over = `${local(MAX_STORED_ADDRESS_CHARS + 1)}@example.com`;
    expect([storedAddress(ok), storedAddress(over)]).toEqual([ok, ""]);
  });
});

describe("the stored value of a Message-ID", () => {
  it("keeps an id of exactly 998 bytes and stores one byte more as none, counting bytes", () => {
    const ok = `${"i".repeat(MAX_MESSAGE_ID_BYTES - 12)}@example.com`;
    const over = `${"é".repeat(493)}a@example.com`;
    expect(Buffer.byteLength(over)).toBe(MAX_MESSAGE_ID_BYTES + 1);
    expect([storedMessageId(ok), storedMessageId(over), storedMessageId(null)]).toEqual([ok, null, null]);
  });
});

describe("the stored value of a subject", () => {
  it("keeps 4096 characters and cuts a longer one there, never inside a surrogate pair", () => {
    const s = "s".repeat(MAX_STORED_SUBJECT_CHARS);
    expect(storedSubject(s)).toBe(s);
    expect(storedSubject("s".repeat(9000)).length).toBe(MAX_STORED_SUBJECT_CHARS);
    expect(storedSubject("s".repeat(MAX_STORED_SUBJECT_CHARS - 1) + "😀" + "t".repeat(50)))
      .toBe("s".repeat(MAX_STORED_SUBJECT_CHARS - 1));
  });
});

describe("the parsed message keeps the values as sent, so its identity does not move", () => {
  const long = `${local(300)}@example.com`;
  const raw = (tail: string) => msg([
    `Message-ID: <${"m".repeat(1500)}@example.com>`, `From: Anna <${long}>`, `Cc: Bo <${long}>`,
    `Subject: ${"w ".repeat(3000)}${tail}`,
  ]);

  it("parses every over-limit value whole", async () => {
    const m = await normalizeMime(raw("end"));
    expect([m.from.address, m.cc[0]!.address, m.canonical.messageIdHeader!.length, m.subject.length > MAX_STORED_SUBJECT_CHARS])
      .toEqual([long, long, 1512, true]);
  });

  it("fingerprints the values as sent: two messages differing only past a bound stay two", async () => {
    const [a, a2, b] = await Promise.all([normalizeMime(raw("end")), normalizeMime(raw("end")), normalizeMime(raw("other"))]);
    expect(messageFingerprint(a)).toBe(messageFingerprint(a2));
    expect(messageFingerprint(a)).not.toBe(messageFingerprint(b));
    expect(storedSubject(a.subject)).toBe(storedSubject(b.subject));
  });
});

describe("the search document's header parts are bounded", () => {
  it("cuts the subject, the people and the file names at 16384 characters each", () => {
    const big = "n ".repeat(20_000);
    const { parts } = searchDocumentOf({
      accountId: "a", subject: big, from: { name: big, address: "a@example.com" }, to: [], cc: [],
      attachmentNames: [big], bodyText: "b", source: "text",
    });
    // The file names are words of the text, after the body: whole, then their parts.
    const [body, names] = parts.body.split("\n");
    expect([parts.subject.length, parts.people.length, names!.length, body])
      .toEqual([SEARCH_HEAD_PART_MAX_CHARS, SEARCH_HEAD_PART_MAX_CHARS, SEARCH_HEAD_PART_MAX_CHARS, "b"]);
  });
});
