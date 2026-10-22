import { describe, it, expect } from "vitest";
import { createPublicKey } from "node:crypto";
import { normalizeMime } from "../src/mime.js";
import { makeSignatureCheck, type DkimKeyLookup, type SignatureResult } from "../src/adapters/dkim.js";
import { edKey, fakeKeys, letter, nodemailerSign, rsaKey, testSign, SIGNED } from "./fixtures/dkim-signed.js";

/**
 * THE SENDER'S OWN SIGNATURE, CHECKED AT INGEST — `adapters/dkim.ts`. Every letter here is signed
 * by code the check does not share (`fixtures/dkim-signed.ts`), and every refusal names the rule
 * that refused it, so a rule switched off turns its own case red rather than hiding behind another.
 */

const NOW = new Date("2026-10-22T12:00:00Z");
const PAYPAL = rsaKey();
const PAYPAL_ED = edKey();
const ATTACKER = rsaKey();
const WEAK = rsaKey(768);

const TABLE: Record<string, string> = {
  "s1._domainkey.paypal.com": PAYPAL.record,
  "ed1._domainkey.paypal.com": PAYPAL_ED.record,
  "s1._domainkey.mail.paypal.com": PAYPAL.record,
  "s1._domainkey.attacker.example": ATTACKER.record,
  "s1._domainkey.attacker.com.de": ATTACKER.record,
  "s1._domainkey.com": ATTACKER.record,
  "weak._domainkey.paypal.com": WEAK.record,
};

async function verdictOf(raw: string, keys: DkimKeyLookup = fakeKeys(TABLE), msgRaw = raw): Promise<SignatureResult> {
  const msg = await normalizeMime(Buffer.from(msgRaw, "latin1"));
  return makeSignatureCheck({ keys, now: () => NOW }).check(Buffer.from(raw, "latin1"), msg);
}
const PASS: SignatureResult = { verdict: "pass", reason: "pass" };
const refused = (reason: SignatureResult["reason"]): SignatureResult => ({ verdict: "unavailable", reason });
const ONE_CLICK = ["List-Unsubscribe: <https://paypal.com/u/1>", "List-Unsubscribe-Post: List-Unsubscribe=One-Click"];

describe("a signature by the sender's own domain reads pass", () => {
  it("rsa-sha256, relaxed, from nodemailer's own signer", async () => {
    expect(await verdictOf(await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL))).toEqual(PASS);
  });

  it("simple canonicalisation, and both mixed forms", async () => {
    for (const c of ["simple/simple", "relaxed/simple", "simple/relaxed"] as const) {
      expect(await verdictOf(await testSign(letter(), { domain: "paypal.com", selector: "s1", key: PAYPAL, c })), c).toEqual(PASS);
    }
  });

  it("whitespace runs, folded headers and trailing empty lines canonicalise as signed", async () => {
    const shaped = letter({
      subject: "Your \t  receipt\r\n  for October ",
      body: "Thank  you \t for\r\nyour payment. \r\n\r\n\r\n",
    });
    expect(await verdictOf(await nodemailerSign(shaped, "paypal.com", "s1", PAYPAL)), "relaxed").toEqual(PASS);
    expect(await verdictOf(await testSign(shaped, { domain: "paypal.com", selector: "s1", key: PAYPAL, c: "simple/simple" })), "simple")
      .toEqual(PASS);
  });

  it("a body with no final CRLF is read with one (RFC 6376 §3.4.3, §3.4.4)", async () => {
    for (const c of ["simple/simple", "relaxed/simple"] as const) {
      const raw = await testSign(letter({ body: "Thank you." }), { domain: "paypal.com", selector: "s1", key: PAYPAL, c });
      expect(await verdictOf(raw), c).toEqual(PASS);
    }
  });

  it("ed25519-sha256 (RFC 8463)", async () => {
    expect(await verdictOf(await testSign(letter(), { domain: "paypal.com", selector: "ed1", key: PAYPAL_ED }))).toEqual(PASS);
  });

  it("a parent signer: mail.paypal.com's letter signed by paypal.com", async () => {
    const raw = await nodemailerSign(letter({ from: "PayPal <service@mail.paypal.com>" }), "paypal.com", "s1", PAYPAL);
    expect(await verdictOf(raw)).toEqual(PASS);
  });

  it("a one-click letter that signs both list headers", async () => {
    expect(await verdictOf(await nodemailerSign(letter({ extra: ONE_CLICK }), "paypal.com", "s1", PAYPAL))).toEqual(PASS);
  });

  it("a key published as a bare RSAPublicKey rather than SubjectPublicKeyInfo", async () => {
    const pkcs1 = `v=DKIM1; k=rsa; p=${createPublicKey(PAYPAL.privateKey).export({ type: "pkcs1", format: "der" }).toString("base64")}`;
    const raw = await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL);
    expect(await verdictOf(raw, fakeKeys({ "s1._domainkey.paypal.com": pkcs1 }))).toEqual(PASS);
  });

  it("a second aligned signature passes where the first is broken", async () => {
    const good = await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL);
    const broken = good.replace(/b=([A-Za-z0-9+/]{8})/, "b=AAAAAAAA");
    const both = `${broken.slice(0, broken.indexOf("From:"))}${good}`;
    expect(await verdictOf(both)).toEqual(PASS);
  });
});

describe("the header block", () => {
  const signed = () => nodemailerSign(letter(), "paypal.com", "s1", PAYPAL);

  it("a bare LF in the headers", async () => {
    const raw = (await signed()).replace("\r\nTo:", "\nTo:");
    expect(await verdictOf(raw)).toEqual(refused("header_block"));
  });

  it("a bare CR in the headers", async () => {
    const raw = (await signed()).replace("\r\nTo:", "\rTo:");
    expect(await verdictOf(raw)).toEqual(refused("header_block"));
  });

  it("a NUL in the headers", async () => {
    const raw = (await signed()).replace("To: mila", "To: m\u0000ila");
    expect(await verdictOf(raw)).toEqual(refused("header_block"));
  });

  it("whitespace before the first header", async () => {
    expect(await verdictOf(` ${await signed()}`)).toEqual(refused("header_block"));
  });

  it("a header line without a colon, or a name with a space in it", async () => {
    const raw = await signed();
    expect(await verdictOf(raw.replace("\r\nTo:", "\r\nnot a header\r\nTo:"))).toEqual(refused("header_block"));
    expect(await verdictOf(raw.replace("\r\nTo:", "\r\nX Odd: 1\r\nTo:"))).toEqual(refused("header_block"));
  });

  it("no blank line between the headers and the body", async () => {
    const raw = (await nodemailerSign(letter({ body: "Note: thanks\r\n" }), "paypal.com", "s1", PAYPAL)).replace("\r\n\r\n", "\r\n");
    expect(await verdictOf(raw)).toEqual(refused("header_block"));
  });

  it("a message over 4 MiB", async () => {
    const body = `${"x".repeat(76)}\r\n`.repeat(56_000);
    const raw = await nodemailerSign(letter({ body }), "paypal.com", "s1", PAYPAL);
    expect(raw.length).toBeGreaterThan(4 * 1024 * 1024);
    expect(await verdictOf(raw)).toEqual(refused("too_large"));
  });
});

describe("the From the check vouches for is the one ohmail shows", () => {
  it("a replay with a From added on top", async () => {
    const raw = `From: PayPal <service@paypal.com>\r\n${await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL)}`;
    expect(await verdictOf(raw)).toEqual(refused("from"));
  });

  it("a From holding two addresses", async () => {
    const raw = await nodemailerSign(letter({ from: "PayPal <service@paypal.com>, Other <o@attacker.example>" }), "paypal.com", "s1", PAYPAL);
    expect(await verdictOf(raw)).toEqual(refused("from"));
  });

  it("two angle addresses with no comma between them", async () => {
    const raw = await nodemailerSign(letter({ from: "<service@paypal.com> <o@paypal.com>" }), "paypal.com", "s1", PAYPAL);
    expect(await verdictOf(raw)).toEqual(refused("from"));
  });

  it("a From domain that is not ASCII", async () => {
    const raw = await testSign(letter({ from: "service@pÿpal.com" }), { domain: "xn--ppal-zoa.com", selector: "s1", key: PAYPAL });
    expect(await verdictOf(raw)).toEqual(refused("from"));
    // The parse agreeing with the raw block's reading, so the domain rule is the one asked.
    const msg = await normalizeMime(Buffer.from(raw, "latin1"));
    const agreed = { ...msg, from: { ...msg.from, address: "service@pÿpal.com" } };
    const check = makeSignatureCheck({ keys: fakeKeys(TABLE), now: () => NOW });
    expect(await check.check(Buffer.from(raw, "latin1"), agreed)).toEqual(refused("from"));
  });

  it("a quoted display name or a comment is no second address", async () => {
    const raw = await nodemailerSign(letter({ from: "\"service@paypal.com, x\" <service@paypal.com> (PayPal @ home)" }), "paypal.com", "s1", PAYPAL);
    expect(await verdictOf(raw)).toEqual(PASS);
  });

  it("a parse that disagrees with ohmail's own about a header ohmail reads", async () => {
    const raw = await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL);
    const other = letter({ extra: ["Subject: and another"] });
    expect(await verdictOf(raw, fakeKeys(TABLE), other)).toEqual(refused("parser_disagrees"));
  });

  it("ohmail's own parse finding a second From where the raw block holds one, and the reverse", async () => {
    const raw = await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL);
    const two = `From: PayPal <service@paypal.com>\r\n${letter()}`;
    expect(await verdictOf(raw, fakeKeys(TABLE), two)).toEqual(refused("from"));
    expect(await verdictOf(`From: PayPal <service@paypal.com>\r\n${raw}`, fakeKeys(TABLE), letter())).toEqual(refused("from"));
  });

  it("a From that is not the address ohmail shows", async () => {
    const raw = await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL);
    const shown = letter({ from: "PayPal <billing@paypal.com>" });
    expect(await verdictOf(raw, fakeKeys(TABLE), shown)).toEqual(refused("from"));
  });
});

describe("which signatures count, and alignment", () => {
  it("no signature at all, under a forged provider header", async () => {
    const raw = letter({ top: ["Authentication-Results: mx.google.com; dkim=pass header.d=paypal.com; dmarc=pass"] });
    const keys = fakeKeys(TABLE);
    expect(await verdictOf(raw, keys)).toEqual(refused("no_signature"));
    expect(keys.calls).toEqual([]);
  });

  it("a forged provider header plus a valid signature by an unaligned domain", async () => {
    const raw = await nodemailerSign(letter({
      top: ["Authentication-Results: mx.google.com; dkim=pass header.d=paypal.com; dmarc=pass"],
    }), "attacker.example", "s1", ATTACKER);
    const keys = fakeKeys(TABLE);
    expect(await verdictOf(raw, keys)).toEqual(refused("unaligned"));
    expect(keys.calls, "an unaligned signature costs no lookup").toEqual([]);
  });

  it("a child signer: mail.paypal.com signing for paypal.com", async () => {
    const raw = await nodemailerSign(letter(), "mail.paypal.com", "s1", PAYPAL);
    expect(await verdictOf(raw)).toEqual(refused("unaligned"));
  });

  it("sibling domains under one two-label suffix: attacker.com.de for victim.com.de", async () => {
    const raw = await nodemailerSign(letter({ from: "Bank <service@victim.com.de>" }), "attacker.com.de", "s1", ATTACKER);
    expect(await verdictOf(raw)).toEqual(refused("unaligned"));
  });

  it("a one-label signing domain is nobody's parent", async () => {
    const raw = await testSign(letter(), { domain: "com", selector: "s1", key: ATTACKER });
    expect(await verdictOf(raw)).toEqual(refused("unaligned"));
  });

  it("rsa-sha1 (RFC 8301)", async () => {
    const raw = await testSign(letter(), { domain: "paypal.com", selector: "s1", key: PAYPAL, a: "rsa-sha1" });
    expect(await verdictOf(raw)).toEqual(refused("algorithm"));
  });

  it("a version other than 1", async () => {
    const raw = await testSign(letter(), { domain: "paypal.com", selector: "s1", key: PAYPAL, v: "2" });
    expect(await verdictOf(raw)).toEqual(refused("algorithm"));
  });

  it("a signature that does not sign From", async () => {
    const raw = await testSign(letter(), { domain: "paypal.com", selector: "s1", key: PAYPAL, h: ["to", "subject", "date"] });
    expect(await verdictOf(raw)).toEqual(refused("coverage"));
  });

  it("an i= outside d=", async () => {
    const raw = await testSign(letter(), { domain: "paypal.com", selector: "s1", key: PAYPAL, i: "@attacker.example" });
    expect(await verdictOf(raw)).toEqual(refused("identity"));
  });

  it("an h= listing more than 256 names", async () => {
    const h = ["from", "to", "subject", "date", ...Array.from({ length: 253 }, (_, i) => `x-pad-${i}`)];
    expect(await verdictOf(await testSign(letter(), { domain: "paypal.com", selector: "s1", key: PAYPAL, h }))).toEqual(refused("malformed"));
    expect(await verdictOf(await testSign(letter(), { domain: "paypal.com", selector: "s1", key: PAYPAL, h: h.slice(0, 256) }))).toEqual(PASS);
  });

  it("long runs of whitespace cost linear time", async () => {
    const pad = " ".repeat(200_000);
    const raw = (await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL))
      .replace("From: PayPal <service@paypal.com>", `From: PayPal <service@paypal.com${pad}x>`)
      .replace("DKIM-Signature: v=1;", `DKIM-Signature: v=1${pad}x;`);
    const started = Date.now();
    expect((await verdictOf(raw)).verdict).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("51 aligned signatures cost at most two lookups", async () => {
    const good = await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL);
    const sig = good.slice(0, good.indexOf("From:")).replace(/b=([A-Za-z0-9+/]{8})/, "b=AAAAAAAA");
    const keys = fakeKeys(TABLE);
    expect(await verdictOf(sig.repeat(51) + letter(), keys)).toEqual(refused("bad_signature"));
    expect(keys.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("what the signature covers", () => {
  it("a replay with a signed header altered in place", async () => {
    const raw = (await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL)).replace("Subject: Your receipt", "Subject: Your refund");
    expect(await verdictOf(raw)).toEqual(refused("bad_signature"));
  });

  it("a replay with an altered body", async () => {
    const raw = (await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL)).replace("Thank you", "Please pay");
    expect(await verdictOf(raw)).toEqual(refused("body_hash"));
  });

  it("an l= that leaves a tail unsigned", async () => {
    const base = letter({ body: "Thank you for your payment.\r\n" });
    const signed = await testSign(base, { domain: "paypal.com", selector: "s1", key: PAYPAL, c: "simple/simple", l: 29 });
    expect(await verdictOf(signed)).toEqual(PASS);
    expect(await verdictOf(`${signed}Click here: https://attacker.example/\r\n`)).toEqual(refused("body_length"));
  });

  it("a second Subject above the signed one", async () => {
    const raw = `Subject: Urgent: verify your account\r\n${await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL)}`;
    expect(await verdictOf(raw)).toEqual(refused("coverage"));
  });

  it("a Subject the signature does not name", async () => {
    const raw = await testSign(letter(), { domain: "paypal.com", selector: "s1", key: PAYPAL, h: ["from", "to", "date"] });
    expect(await verdictOf(raw)).toEqual(refused("coverage"));
  });

  it("a List-Unsubscribe added outside h=", async () => {
    const signed = await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL);
    const end = signed.indexOf("\r\n\r\n");
    const raw = `${signed.slice(0, end)}\r\n${ONE_CLICK.join("\r\n")}${signed.slice(end)}`;
    expect(await verdictOf(raw)).toEqual(refused("coverage"));
  });

  it("a one-click letter whose h= leaves out List-Unsubscribe-Post (RFC 8058 §4)", async () => {
    const names = SIGNED.replace(":list-unsubscribe-post", "");
    const raw = await nodemailerSign(letter({ extra: ONE_CLICK }), "paypal.com", "s1", PAYPAL, names);
    expect(await verdictOf(raw)).toEqual(refused("coverage"));
  });

  it("two copies of a header, both signed, are taken bottom-up", async () => {
    const raw = await testSign(letter({ extra: ["Comments: first", "Comments: second"] }), {
      domain: "paypal.com", selector: "s1", key: PAYPAL, h: ["from", "to", "subject", "date", "comments", "comments"],
    });
    expect(await verdictOf(raw)).toEqual(PASS);
  });

  it("an oversigned header admits a message carrying fewer copies", async () => {
    const raw = await testSign(letter(), { domain: "paypal.com", selector: "s1", key: PAYPAL, h: ["from", "from", "to", "subject", "subject", "date"] });
    expect(await verdictOf(raw)).toEqual(PASS);
  });

  it("an expired signature", async () => {
    const x = Math.floor(NOW.getTime() / 1000) - 60;
    const raw = await testSign(letter(), { domain: "paypal.com", selector: "s1", key: PAYPAL, t: x - 3600, x });
    expect(await verdictOf(raw)).toEqual(refused("expired"));
    const later = await testSign(letter(), { domain: "paypal.com", selector: "s1", key: PAYPAL, t: x - 3600, x: x + 3600 });
    expect(await verdictOf(later)).toEqual(PASS);
  });
});

describe("what a letter's lookups may cost", () => {
  /** A lookup that never answers, counting what it is asked: a name server that drops every query. */
  function blackHole(): DkimKeyLookup & { calls: string[] } {
    const calls: string[] = [];
    return { calls, lookup: (name) => { calls.push(name); return new Promise(() => undefined); } };
  }

  it("a domain whose lookup failed is not asked again for the letter's other signature", async () => {
    const once = await testSign(letter(), { domain: "paypal.com", selector: "a1", key: PAYPAL });
    const twice = await testSign(once, { domain: "paypal.com", selector: "b2", key: PAYPAL });
    const keys = fakeKeys({ "a1._domainkey.paypal.com": { kind: "error" }, "b2._domainkey.paypal.com": { kind: "error" } });
    expect(await verdictOf(twice, keys)).toEqual(refused("key_error"));
    expect(keys.calls).toEqual(["b2._domainkey.paypal.com"]);
  });

  it("CONTROL: a signature by another aligned domain is still asked, and holds", async () => {
    const good = await testSign(letter({ from: "PayPal <service@mail.paypal.com>" }), { domain: "paypal.com", selector: "s1", key: PAYPAL });
    const both = await testSign(good, { domain: "mail.paypal.com", selector: "x1", key: PAYPAL });
    const keys = fakeKeys({ ...TABLE, "x1._domainkey.mail.paypal.com": { kind: "error" } });
    expect(await verdictOf(both, keys)).toEqual(PASS);
    expect(keys.calls).toEqual(["x1._domainkey.mail.paypal.com", "s1._domainkey.paypal.com"]);
  });

  it("a spent budget asks nothing and reads key_budget; a fresh one asks", async () => {
    const raw = Buffer.from(await nodemailerSign(letter(), "paypal.com", "s1", PAYPAL), "latin1");
    const msg = await normalizeMime(raw);
    const keys = fakeKeys(TABLE);
    const check = makeSignatureCheck({ keys, now: () => NOW });
    expect(await check.check(raw, msg, { remainingMs: 0 })).toEqual(refused("key_budget"));
    expect(keys.calls).toEqual([]);
    expect(await check.check(raw, msg, check.cycleBudget())).toEqual(PASS);
    expect(keys.calls).toHaveLength(1);
  });

  it("each lookup is given what is left of the budget and charged what it took", async () => {
    const keys = blackHole();
    const check = makeSignatureCheck({ keys, now: () => NOW, lookupDeadlineMs: 300, cycleLookupMs: 450 });
    const budget = check.cycleBudget();
    const letters = await Promise.all(["one.example", "two.example", "three.example", "four.example"].map(async (d) => {
      const raw = Buffer.from(await nodemailerSign(letter({ from: `News <news@${d}>` }), d, "s1", ATTACKER), "latin1");
      return { raw, msg: await normalizeMime(raw) };
    }));
    const started = performance.now();
    const reasons: string[] = [];
    for (const l of letters) reasons.push((await check.check(l.raw, l.msg, budget)).reason);
    const took = performance.now() - started;
    // The first waits out its own deadline; what is left cuts the second short; then nothing is asked.
    expect(reasons[0]).toBe("key_error");
    expect(reasons.slice(1)).toEqual(["key_budget", "key_budget", "key_budget"]);
    expect(keys.calls.length).toBeLessThanOrEqual(2);
    expect(budget.remainingMs).toBeLessThanOrEqual(0);
    expect(took, "the letters cost more than the budget").toBeLessThan(450 + 250);
  });
});

describe("the key record", () => {
  const signedWith = (selector: string, key = PAYPAL) => testSign(letter(), { domain: "paypal.com", selector, key });
  const withRecord = async (record: string) =>
    verdictOf(await signedWith("s1"), fakeKeys({ "s1._domainkey.paypal.com": record }));

  it("no key, an error, a lookup that throws or never answers", async () => {
    const raw = await signedWith("s1");
    expect(await verdictOf(raw, fakeKeys({}))).toEqual(refused("key_none"));
    expect(await verdictOf(raw, fakeKeys({ "s1._domainkey.paypal.com": { kind: "error" } }))).toEqual(refused("key_error"));
    expect(await verdictOf(raw, { lookup: async () => { throw new Error("SERVFAIL"); } })).toEqual(refused("key_error"));
    const msg = await normalizeMime(Buffer.from(raw, "latin1"));
    const hung = makeSignatureCheck({ keys: { lookup: () => new Promise(() => undefined) }, now: () => NOW, lookupDeadlineMs: 50 });
    expect(await hung.check(Buffer.from(raw, "latin1"), msg)).toEqual(refused("key_error"));
  });

  it("a revoked key (empty p=)", async () => {
    expect(await withRecord("v=DKIM1; k=rsa; p=")).toEqual(refused("key_invalid"));
  });

  it("a record of another version, or with v= not first", async () => {
    expect(await withRecord(PAYPAL.record.replace("v=DKIM1", "v=DKIM2"))).toEqual(refused("key_invalid"));
    expect(await withRecord(PAYPAL.record.replace("v=DKIM1; k=rsa;", "k=rsa; v=DKIM1;"))).toEqual(refused("key_invalid"));
    expect(await withRecord(PAYPAL.record.replace("v=DKIM1; ", ""))).toEqual(PASS);
  });

  it("a key type that is not the signature's", async () => {
    expect(await withRecord(PAYPAL.record.replace("k=rsa", "k=ed25519"))).toEqual(refused("key_invalid"));
  });

  it("a key whose h= does not allow sha256", async () => {
    expect(await withRecord(PAYPAL.record.replace("k=rsa;", "k=rsa; h=sha1;"))).toEqual(refused("key_invalid"));
    expect(await withRecord(PAYPAL.record.replace("k=rsa;", "k=rsa; h=sha1:sha256;"))).toEqual(PASS);
  });

  it("a key for another service than mail", async () => {
    expect(await withRecord(PAYPAL.record.replace("k=rsa;", "k=rsa; s=other;"))).toEqual(refused("key_invalid"));
    expect(await withRecord(PAYPAL.record.replace("k=rsa;", "k=rsa; s=email;"))).toEqual(PASS);
  });

  it("two records at one name", async () => {
    const raw = await signedWith("s1");
    expect(await verdictOf(raw, fakeKeys({ "s1._domainkey.paypal.com": { kind: "records", records: [PAYPAL.record, PAYPAL.record] } })))
      .toEqual(refused("key_invalid"));
  });

  it("a key in testing (t=y)", async () => {
    expect(await withRecord(PAYPAL.record.replace("k=rsa;", "k=rsa; t=y;"))).toEqual(refused("key_testing"));
  });

  it("t=s with an i= below d=", async () => {
    const raw = await testSign(letter(), { domain: "paypal.com", selector: "s1", key: PAYPAL, i: "@mail.paypal.com" });
    const strict = fakeKeys({ "s1._domainkey.paypal.com": PAYPAL.record.replace("k=rsa;", "k=rsa; t=s;") });
    expect(await verdictOf(raw, strict)).toEqual(refused("key_strict"));
    expect(await verdictOf(raw)).toEqual(PASS);
  });

  it("an RSA key under 1024 bits, or over 4096", async () => {
    expect(await verdictOf(await signedWith("weak", WEAK))).toEqual(refused("key_size"));
    const big = rsaKey(4104);
    const raw = await testSign(letter(), { domain: "paypal.com", selector: "big", key: big });
    expect(await verdictOf(raw, fakeKeys({ "big._domainkey.paypal.com": big.record }))).toEqual(refused("key_size"));
  });

  it("a signature the published key did not make", async () => {
    expect(await verdictOf(await signedWith("s1", ATTACKER))).toEqual(refused("bad_signature"));
  });
});
