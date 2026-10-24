import { describe, it, expect } from "vitest";
import { sendContentFingerprint, duplicateSendSentence } from "../src/index.js";

/**
 * WHAT MAKES TWO SENDS THE SAME MESSAGE — one member at a time.
 *
 * The digest keys the account's claim on a message's content, so it decides two things that fail in
 * opposite directions and are equally bad:
 *
 *   · a member MISSING from it means two different messages hash alike, and the second one is
 *     refused — somebody's mail silently does not go;
 *   · a member that should NOT be in it (the draft id, the minted Message-ID, the key) means the
 *     defect this guard exists to close walks straight through, because every one of those changes
 *     between the first press and the second.
 *
 * So every member gets its own case, and each is a MINIMAL PAIR: exactly one field differs. A
 * mutation that drops one member from the canonical list reddens exactly one case here and nothing
 * else, which is the property a shared "everything differs" fixture would destroy.
 */

const BASE = {
  to: [{ name: null, address: "you@example.com" }],
  cc: [],
  bcc: [],
  subject: "Re: hi",
  html: null,
  body: "Thanks!",
  inReplyToMessageId: null,
  forwardOf: null,
  sendAt: null,
  attachments: [],
} as const;

const fp = (over: Partial<Parameters<typeof sendContentFingerprint>[0]> = {}): string =>
  sendContentFingerprint({ ...BASE, ...over } as Parameters<typeof sendContentFingerprint>[0]);

describe("sendContentFingerprint — every member discriminates", () => {
  it("is a 64-character lowercase hex digest, which is what the column's CHECK admits", () => {
    expect(fp()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the same message twice is the same digest", () => {
    expect(fp()).toBe(fp());
  });

  const pairs: Array<[string, Partial<Parameters<typeof sendContentFingerprint>[0]>]> = [
    ["one more To recipient", { to: [{ name: null, address: "you@example.com" }, { name: null, address: "two@example.com" }] }],
    ["a different To recipient", { to: [{ name: null, address: "someone-else@example.com" }] }],
    ["one Cc", { cc: [{ name: null, address: "third@example.com" }] }],
    ["one Bcc", { bcc: [{ name: null, address: "blind@example.com" }] }],
    ["a changed subject", { subject: "Re: hi." }],
    ["ONE CHARACTER of body", { body: "Thanks!!" }],
    ["a reply target where there was none", { inReplyToMessageId: "11111111-1111-4111-8111-111111111111" }],
    ["a FORWARD target where there was none", { forwardOf: "22222222-2222-4222-8222-222222222222" }],
    ["a DIFFERENT forward target", { forwardOf: "33333333-3333-4333-8333-333333333333" }],
    ["a schedule where there was none", { sendAt: new Date("2026-09-09T09:00:00.000Z") }],
    ["an attachment", { attachments: [{ filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10, contentSha256: "d".repeat(64) }] }],
  ];

  for (const [what, over] of pairs) {
    it(`${what} is a DIFFERENT message`, () => {
      expect(fp(over)).not.toBe(fp());
    });
  }

  /**
   * THE FORWARD PAIR, spelled out because it is the member the first design of this digest left
   * out and the one whose absence is invisible in every other case.
   *
   * Two forwards of DIFFERENT originals, to the same person, with no note: identical recipients,
   * identical (empty) subject and body, identical everything the earlier member list contained.
   * Without `forwardOf` they hash the same and the second forward is refused as a duplicate of the
   * first — a message the user meant to send that never leaves, with the suite green.
   */
  it("forwardParts: absent keeps every stored digest; the selection discriminates, its order does not", () => {
    const fwd = { forwardOf: "22222222-2222-4222-8222-222222222222" };
    // The digest a forward had before the field existed, pinned: a stored claim stays valid.
    expect(fp(fwd)).toBe("c1911edfe050cde54ea4cf43b969c88ca66b2af7b1f3d4a65154cfabb843da2b");
    expect(fp({ ...fwd, forwardParts: undefined })).toBe(fp(fwd));
    const a = "aaaaaaaa-0000-4000-8000-000000000001";
    const b = "bbbbbbbb-0000-4000-8000-000000000002";
    expect(fp({ ...fwd, forwardParts: [a] })).not.toBe(fp({ ...fwd, forwardParts: [b] }));
    expect(fp({ ...fwd, forwardParts: [] })).not.toBe(fp(fwd));
    expect(fp({ ...fwd, forwardParts: [a, b] })).toBe(fp({ ...fwd, forwardParts: [b, a] }));
  });

  it("two forwards of DIFFERENT originals with no note are different messages", () => {
    const blank = { subject: "", text: "" };
    expect(fp({ ...blank, forwardOf: "aaaaaaaa-0000-4000-8000-000000000001" }))
      .not.toBe(fp({ ...blank, forwardOf: "aaaaaaaa-0000-4000-8000-000000000002" }));
  });

  describe("the normalizations — what is deliberately NOT a new message", () => {
    it("a display name is not part of the delivery", () => {
      expect(fp({ to: [{ name: "You", address: "you@example.com" }] })).toBe(fp());
    });

    it("case and surrounding space in an address do not matter", () => {
      expect(fp({ to: [{ name: null, address: "  YOU@Example.COM " }] })).toBe(fp());
    });

    it("the ORDER of recipients does not matter", () => {
      const two = [{ name: null, address: "a@example.com" }, { name: null, address: "b@example.com" }];
      expect(fp({ to: two })).toBe(fp({ to: [...two].reverse() }));
    });

    it("naming one recipient twice is naming them once", () => {
      expect(fp({ to: [{ name: null, address: "you@example.com" }, { name: null, address: "YOU@example.com" }] }))
        .toBe(fp());
    });

    it("the ORDER attachments were picked in does not matter", () => {
      const a = { filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10, contentSha256: "e".repeat(64) };
      const b = { filename: "b.png", contentType: "image/png", sizeBytes: 20, contentSha256: "f".repeat(64) };
      expect(fp({ attachments: [a, b] })).toBe(fp({ attachments: [b, a] }));
    });
  });

  describe("attachments fold by name, type and size — each one on its own", () => {
    // Every field spelled out: leaving `contentSha256` off type-errored and happened to behave
    // like `null` at runtime, because `JSON.stringify` renders an undefined tuple slot as null.
    // A fixture that is right by accident is the thing this file exists to rule out.
    const one = { filename: "a.pdf", contentType: "application/pdf", sizeBytes: 10, contentSha256: "1".repeat(64) };
    it("a different FILENAME is a different message", () => {
      expect(fp({ attachments: [{ ...one, filename: "b.pdf" }] })).not.toBe(fp({ attachments: [one] }));
    });
    it("a different CONTENT TYPE is a different message", () => {
      expect(fp({ attachments: [{ ...one, contentType: "text/plain" }] })).not.toBe(fp({ attachments: [one] }));
    });
    it("a different SIZE is a different message", () => {
      expect(fp({ attachments: [{ ...one, sizeBytes: 11 }] })).not.toBe(fp({ attachments: [one] }));
    });
    it("THE ACCEPTED COLLISION, stated rather than discovered later", () => {
      // Two genuinely different files that agree on name, type and exact byte length read as one
      // message. Digesting the bytes is not available here: staged bytes live in object storage and
      // reaching for them would put a network call inside the reserve transaction. The person sees
      // the first send's time and can change one character.
      expect(fp({ attachments: [one] })).toBe(fp({ attachments: [{ ...one }] }));
    });
  });

  /**
   * A CANONICAL FORM THAT CANNOT BE FOOLED BY A SEPARATOR.
   *
   * The client's own `sendFingerprint` joins its members with a delimiter, which needs a character
   * that cannot occur in the data — and the character that looks safe is a control byte, which
   * makes `file` report the source as binary and every `grep` skip it in silence. This one
   * stringifies an array instead, and the property that buys is here: moving a substring across a
   * member boundary must change the digest.
   */
  it("content moved ACROSS a member boundary is a different message", () => {
    expect(fp({ subject: "ab", body: "cd" })).not.toBe(fp({ subject: "a", body: "bcd" }));
    expect(fp({ subject: "", body: "Re: hiThanks!" })).not.toBe(fp({ subject: "Re: hi", body: "Thanks!" }));
  });

  /**
   * AND THE BOUNDARIES INSIDE ONE MEMBER, which the case above cannot reach.
   *
   * Three members are LISTS — `to`, `cc`, `bcc` — and a list has to become a string somewhere.
   * Joining its elements with a separator makes two different lists agree whenever the separator
   * can occur inside an element: two recipients `a@x.test` and `b@x.test` join to exactly the
   * string ONE recipient spelled `a@x.test,b@x.test` joins to. `JSON.stringify` keeps the brackets
   * and the quotes, so the structure carries the boundary and no character in the data can forge
   * it — which is the property the member-boundary case above asserts for scalars and this one
   * asserts for the lists.
   *
   * A single address holding a comma is not a delivery this product would make. That is not the
   * point: the digest may not DEPEND on it, because everything in it is content somebody chose,
   * and a guard that can be fooled by a chosen character suppresses a message somebody wrote.
   */
  it("two recipients are not ONE recipient whose address holds the separator", () => {
    const two = [{ name: null, address: "a@x.test" }, { name: null, address: "b@x.test" }];
    const one = [{ name: null, address: "a@x.test,b@x.test" }];
    expect(fp({ to: two })).not.toBe(fp({ to: one }));
    // Cc and Bcc are canonicalized by the same helper, so the property is asserted where a
    // list-flattening change would land rather than only on the one list.
    expect(fp({ cc: two })).not.toBe(fp({ cc: one }));
    expect(fp({ bcc: two })).not.toBe(fp({ bcc: one }));
  });

  /**
   * THE THREE THE REVIEW FOUND — each one a message that was REFUSED and should have been SENT.
   *
   * Every one is the same shape and it is the worse half of this guard's trade: refusing a
   * duplicate costs a person one edit, refusing a DIFFERENT message loses it silently while the
   * screen says it was already sent. These are the cases that ordering exists to protect.
   */
  it("PLAIN text that LOOKS like markup is not the same message as that markup", () => {
    // `html ?? body` collapsed these: a plain body of literal `<p>Approved</p>` and a rich draft
    // whose markup is `<p>Approved</p>`. One arrives as visible angle brackets, the other as a
    // formatted line — different to the recipient, which is the only test that counts.
    expect(fp({ html: null, body: "<p>Approved</p>" }))
      .not.toBe(fp({ html: "<p>Approved</p>", body: "Approved" }));
  });

  it("a rich message and a plain one with the SAME markup string still differ", () => {
    expect(fp({ html: "<b>x</b>", body: "x" })).not.toBe(fp({ html: null, body: "<b>x</b>" }));
  });

  it("an INLINE attachment whose CONTENT changed is a different message, at identical size", () => {
    // The corrected invoice: same name, same type, same byte length, different figure.
    const a = { filename: "invoice.csv", contentType: "text/csv", sizeBytes: 14, contentSha256: "a".repeat(64) };
    const b = { ...a, contentSha256: "b".repeat(64) };
    expect(fp({ attachments: [a] })).not.toBe(fp({ attachments: [b] }));
  });

  it("a STAGED file still folds by metadata — the residual, asserted so it is not a surprise", () => {
    // Staged bytes live in object storage and cannot be digested inside the reserve transaction.
    // Two different staged files agreeing on name, type and exact size DO collide, and that is the
    // stated limit of this guard rather than an oversight.
    const a = { filename: "big.bin", contentType: "application/octet-stream", sizeBytes: 99, contentSha256: null };
    expect(fp({ attachments: [a] })).toBe(fp({ attachments: [{ ...a }] }));
  });

  it("an inline file and a staged file with the same metadata are NOT interchangeable", () => {
    const meta = { filename: "f.bin", contentType: "application/octet-stream", sizeBytes: 3 };
    expect(fp({ attachments: [{ ...meta, contentSha256: "c".repeat(64) }] }))
      .not.toBe(fp({ attachments: [{ ...meta, contentSha256: null }] }));
  });
});

describe("duplicateSendSentence — three states, three different facts", () => {
  const at = new Date("2026-07-28T12:00:00.000Z");

  it("a KNOWN-SENT first attempt says it was sent, and how to send another", () => {
    const s = duplicateSendSentence("sent", at);
    expect(s).toContain("2026-07-28T12:00:00.000Z");
    expect(s).toMatch(/already sent/i);
    expect(s).toMatch(/change the message/i);
  });

  it("an UNCONFIRMED first attempt never claims a delivery", () => {
    const s = duplicateSendSentence("unverified", at);
    expect(s).toMatch(/could not be confirmed/i);
    expect(s).toMatch(/Sent folder/i);
    // The word this sentence must not contain: the product cannot prove a delivery here.
    expect(s).not.toMatch(/already sent/i);
  });

  it("a first attempt STILL RUNNING says so, carries no time, and PROMISES NO ENDING", () => {
    // The wording moved by review. The first attempt can still fail before it reaches the mail
    // server, in which case this message has NOT been sent and the retry that follows will send it.
    // So the sentence may say a send is under way and must NOT say the message is on its way, which
    // is a state the product cannot vouch for at this moment.
    const s = duplicateSendSentence("pending", at);
    expect(s).toMatch(/already being sent/i);
    expect(s).toMatch(/still waiting to hear/i);
    expect(s, "no timestamp: there is no settled instant to name").not.toContain("2026-07-28T12:00:00.000Z");
    expect(s, "must not promise delivery").not.toMatch(/on its way|will arrive|has been sent/i);
  });

  it("every sentence says that THIS request sent nothing", () => {
    for (const st of ["sent", "unverified", "pending"]) {
      expect(duplicateSendSentence(st, at), st).toMatch(/nothing was sent/i);
    }
  });
});
