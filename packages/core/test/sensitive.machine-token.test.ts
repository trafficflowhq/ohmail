import { describe, it, expect } from "vitest";
import { classifySensitivity, screenOutboundText, redactForModel } from "../src/sensitive.js";
import type { NormalizedMessage } from "../src/types.js";
import { WITHHELD, normalized } from "./fixtures/sensitive-corpus.js";
import { normalizeMime } from "../src/mime.js";
import { opaqueRun } from "../../../test/support/fixture-credentials.js";

/**
 * AUTHENTICATION VOCABULARY IS READ FROM WORDS, NOT FROM MACHINE TOKENS.
 *
 * A bulk sender's click-tracking link carries an opaque token, and that token is percent-escaped
 * inside the URL: `/` becomes `-2F`, `+` becomes `-2B`. `-` is not a word character, so
 * JavaScript's `\b` puts a word boundary on both sides of the three characters `2Fa` — and the
 * vocabulary contains `2fa` as a standalone acronym. A newsletter whose random tracking token
 * happens to encode a slash followed by an `a` therefore classified as a one-time-code mail.
 *
 * That misclassification is not cosmetic. A message judged sensitive is stored REDACTED and its
 * sender HTML is never written to the database at all, so the reader is left with the text/plain
 * alternative: bracketed URLs and a tracking-pixel line as visible text. The damage is also
 * permanent for that copy, because the HTML that was refused was never kept anywhere.
 *
 * What makes this a defect in the boundary rather than a strict boundary doing its job is that
 * the verdict is decided by a random token. Three copies of one billing notice, from one sender,
 * two of them on the same day, were classified differently: the copies whose token happened to
 * contain the escape were withheld and stripped, and the copy whose token did not was read
 * normally. `stability of the verdict` below is that experiment.
 *
 * The fix is precision, not recall. Detection of real one-time codes is unchanged — every case in
 * the fail-closed corpus is re-asserted here with a tracking footer glued onto it, because the
 * only acceptable version of this change is one that cannot lose a credential.
 */

/** A bulk sender's click-tracking link, shaped exactly like the ones in real mail. */
function trackingLink(token: string): string {
  return `[https://url8792.mail.example.com/ls/click?upn=u001.${token}]`;
}

/* The tokens' SHAPE is the subject: each is an opaque run derived from its tag, with the escape the case
 * needs written beside it, and the cases below assert every one of them whole. */

/**
 * Three tokens from the same generator. The first two contain an escaped `/` immediately before
 * an `a`; the third does not. Nothing else about them differs, and nothing about them is content.
 */
const TOKEN_TRAILING_ESCAPE = `${opaqueRun("machine-token-trailing", 72)}-2Fa`;
const TOKEN_INNER_ESCAPE = `${opaqueRun("machine-token-inner", 38)}-2BEQG-2FA-2F${opaqueRun("machine-token-inner-tail", 29)}`;
const TOKEN_CLEAN = opaqueRun("machine-token-clean", 70);

/** A usage/billing notice: ordinary commercial mail with a tracking footer, and nothing else. */
function billingNotice(token: string): NormalizedMessage {
  return normalized({
    subject: "Your organization is approaching its usage credits spend limit",
    textBody: [
      "Your organization has used 80% of the credits on its plan.",
      "Review usage and adjust the spend limit in the console.",
      trackingLink(token),
      "",
      "Example Inc, 548 Market St, PMB 90375, San Francisco, CA 94104",
    ].join("\n"),
  });
}

describe("machine tokens are not words", () => {
  it("a billing notice whose tracking token ends in an escaped slash is ORDINARY", () => {
    const r = classifySensitivity(billingNotice(TOKEN_TRAILING_ESCAPE));
    expect(r.category).toBe(null);
    expect(r.verdict).toBe("ordinary");
    expect(r.reasons).toEqual([]);
    expect(r.flags.no_ai).toBe(false);
    // The second half of the damage: a sensitive verdict is what stops the HTML being stored.
    expect(r.sensitive).toBe(false);
  });

  it("stability of the verdict: three tokens from one generator classify identically", () => {
    const verdicts = [TOKEN_TRAILING_ESCAPE, TOKEN_INNER_ESCAPE, TOKEN_CLEAN].map((t) => {
      const r = classifySensitivity(billingNotice(t));
      return `${r.verdict}/${r.category}`;
    });
    // The point of this assertion is the SET, not the value: a boundary whose answer depends on
    // a random token is not a boundary.
    expect(new Set(verdicts).size).toBe(1);
    expect(verdicts[0]).toBe("ordinary/null");
  });

  it("the escape shape is really present — this test would pass on a vacuous fixture otherwise", () => {
    // Guard against the fixture rotting into one that no longer reproduces anything.
    expect(/\b2fa\b/i.test(trackingLink(TOKEN_TRAILING_ESCAPE))).toBe(true);
    expect(/\b2fa\b/i.test(trackingLink(TOKEN_INNER_ESCAPE))).toBe(true);
    expect(/\b2fa\b/i.test(trackingLink(TOKEN_CLEAN))).toBe(false);
    // Each is whole: one generator's alphabet and length, so the false above is not an empty token's.
    for (const t of [TOKEN_TRAILING_ESCAPE, TOKEN_INNER_ESCAPE, TOKEN_CLEAN]) expect(t).toMatch(/^[A-Za-z0-9-]{70,80}$/);
  });

  it("an uppercase PIN inside an opaque token is not a PIN", () => {
    // `PIN` is matched case-SENSITIVELY and unqualified, so it is the vocabulary entry most
    // exposed to base64: the escape separators put a word boundary on both sides of it.
    const token = `${opaqueRun("machine-token-pin", 29)}-PIN-2Fx`;
    expect(/\bPIN\b/.test(token), "the fixture must really contain a bounded PIN").toBe(true);
    const r = classifySensitivity(normalized({
      subject: "Weekly digest",
      textBody: `Three new posts this week.\n${trackingLink(token)}`,
    }));
    expect(r.category).toBe(null);
    expect(r.verdict).toBe("ordinary");
  });

  it("a tracking footer in the HTML part does not flag the message either", () => {
    const r = classifySensitivity(normalized({
      subject: "August product news",
      textBody: "Three things shipped this month. Read them on the blog.",
      htmlBody: `<p>Three things shipped this month.</p><p><a href="https://url8792.mail.example.com/ls/click?upn=u001.${TOKEN_TRAILING_ESCAPE}">Read them on the blog</a></p>`,
    }));
    expect(r.category).toBe(null);
    expect(r.sensitive).toBe(false);
  });
});

describe("precision only — every real credential is still caught", () => {
  it("a one-time code carrying the same tracking footer is still sensitive", () => {
    const r = classifySensitivity(normalized({
      subject: "Your verification code",
      textBody: `Your one-time code is 483920. It expires in 10 minutes.\n${trackingLink(TOKEN_TRAILING_ESCAPE)}`,
    }));
    expect(r.sensitive).toBe(true);
    expect(r.category).toBe("otp");
    expect(r.flags.no_ai).toBe(true);
    // The stored body keeps the code (the reader sees their own mail); the model payload strips it.
    expect(redactForModel("Your verification code",
      `Your one-time code is 483920. It expires in 10 minutes.`).snippet).not.toContain("483920");
  });

  it("the vocabulary still fires in prose, in every shape it claims", () => {
    // The two CREDENTIAL NOUNS are unconditional: they name the secret itself, so prose alone is
    // enough. The four SCHEME NAMES need a code beside them (see `schemeNameNearCode`), so they
    // are exercised here in their code-carrying form — which is still the case this file exists
    // to protect, because the mask runs before either rule and a mask that ate `2fa` would take
    // the gated rule down with it.
    const prose: Array<[string, string]> = [
      ["passcode", "Here is the passcode you asked for."],
      ["one-time password", "Use the one-time password below to continue."],
      ["2FA", "Your 2FA code is 482913."],
      ["OTP", "The OTP will arrive by SMS. It is 448213."],
      ["two-factor", "Two-factor sign-in: enter 991122 to continue."],
      ["multi-factor", "multi-factor is now required. Your code: 556677"],
    ];
    for (const [label, body] of prose) {
      const r = classifySensitivity(normalized({ subject: "Account", textBody: body }));
      expect(r.category, `${label}: ${body}`).toBe("otp");
      expect(r.flags.no_ai, label).toBe(true);
    }
  });

  it("an acronym at the end of a sentence, or in brackets, is still a word", () => {
    // Unchanged in purpose — `\b` must terminate on `.`, `)`, `!` and `?` — but each shape now
    // carries the code the scheme name needs. A regression in the terminators still fails here:
    // no acronym match means no window to search for the digits.
    const bodies = [
      "You should turn on 2FA. The code is 482913.",
      "Sign-in now needs a code (2FA). Yours is 448213.",
      "2FA! Use 991122 to continue.",
      "Enable OTP? Here it is: 556677",
    ];
    for (const body of bodies) {
      expect(classifySensitivity(normalized({ subject: "", textBody: body })).category, body).toBe("otp");
    }
  });

  it("the same acronyms with NO code are a topic, and the mask is not what decided that", () => {
    // The complement of the test above, and the reason the machine-token mask is still doing its
    // own job: these are ordinary because no code sits near the word, NOT because `proseOnly`
    // removed the word. The regex assertions at the top of this file pin that the acronym really
    // is present and bounded in the tracking-token fixtures; here it is present in plain prose.
    for (const body of ["You should turn on 2FA.", "Sign-in now needs a code (2FA).", "2FA!", "Enable OTP?"]) {
      expect(/\b(2fa|otp)\b/i.test(body), `the fixture must really contain the acronym: ${body}`).toBe(true);
      const r = classifySensitivity(normalized({ subject: "", textBody: body }));
      expect(r.category, body).toBe(null);
      expect(r.verdict, body).toBe("ordinary");
    }
  });

  it("readable URL text is still read — the screw is letters-AND-digits, not length", () => {
    // A path segment a human can read is vocabulary; an opaque token is not. Both live in a URL,
    // so "ignore URLs" would have been the wrong fix.
    const r = classifySensitivity(normalized({
      subject: "Finish setting up",
      textBody: "Open https://acme.example/verification-code/start?t=A1b2C3d4E5f6G7h8 to continue.",
    }));
    expect(r.category).toBe("otp");
  });

  it("every case in the fail-closed corpus survives a tracking footer being glued to it", async () => {
    // The footer goes on the TEXT part only, and deliberately not on the HTML part: appending the
    // same paragraph to both alternatives would raise their word overlap and stop
    // `alternatives_disagree` firing, which would make this loop quietly assert less than it
    // claims for the one case that stands for that reason. The HTML side has its own test above.
    const footer = `\n\n${trackingLink(TOKEN_TRAILING_ESCAPE)}\n${trackingLink(TOKEN_INNER_ESCAPE)}\n`;
    let checked = 0;
    for (const c of WITHHELD) {
      const base: NormalizedMessage = c.raw
        ? await normalizeMime(Buffer.from(c.raw, "utf8"))
        : normalized(c.patch ?? {});
      const withFooter: NormalizedMessage = { ...base, textBody: `${base.textBody ?? ""}${footer}` };
      const before = classifySensitivity(base);
      const after = classifySensitivity(withFooter);
      expect(after.flags.no_ai, `${c.id}: no_ai must survive the footer`).toBe(true);
      expect(after.sensitive, `${c.id}: the positive verdict must not change`).toBe(before.sensitive);
      expect(after.category, `${c.id}: the category must not change`).toBe(before.category);
      checked++;
    }
    // The corpus is loaded, not inlined; an empty import would make every assertion above vacuous.
    expect(checked).toBeGreaterThan(30);
  });

  it("masking removes text and therefore can only remove positives, never add one", () => {
    // An ordinary body cannot become sensitive by acquiring a machine token, in either direction.
    const plain = "Thanks for the update — I will take a look on Monday.";
    for (const token of [TOKEN_TRAILING_ESCAPE, TOKEN_INNER_ESCAPE, TOKEN_CLEAN]) {
      const r = classifySensitivity(normalized({ subject: "Re: Monday", textBody: `${plain}\n${trackingLink(token)}` }));
      expect(r.category, token.slice(0, 12)).toBe(null);
      expect(r.verdict, token.slice(0, 12)).toBe("ordinary");
    }
  });
});

describe("the sink screens the same way — one defect, two call sites", () => {
  it("an ordinary snippet carrying a tracking token is safe to send", () => {
    const s = screenOutboundText(
      "Your organization is approaching its usage credits spend limit",
      `Your organization has used 80% of the credits on its plan. ${trackingLink(TOKEN_TRAILING_ESCAPE)}`,
    );
    expect(s.safe).toBe(true);
    expect(s.category).toBe(null);
    expect(s.reason).toBe(null);
  });

  it("a credential snippet is still refused when the same token is present", () => {
    const s = screenOutboundText(
      "Your verification code",
      `Your one-time code is 483920. ${trackingLink(TOKEN_TRAILING_ESCAPE)}`,
    );
    expect(s.safe).toBe(false);
    expect(s.category).toBe("otp");
    expect(s.reason).toBe("vocabulary");
  });

  it("the shape rules are untouched by the mask — a bare token payload is still refused", () => {
    expect(screenOutboundText("", "A1b2C3").safe).toBe(false);
    expect(screenOutboundText("", "483920").safe).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * A TRACKING TOKEN DECODED INTO UNICODE CONFETTI — the second reading of machine text as human
 * ════════════════════════════════════════════════════════════════════════════════════════ */

describe("an opportunistic base64 decode that produced garbage is not evidence", () => {
  /**
   * A real-shaped click-tracker token: 40 characters of `[A-Za-z0-9+/]`, which is exactly what
   * `B64_RUN` matches.
   *
   * It is PINNED by its tag rather than drawn at random, because the property under test is a property
   * of these bytes: decoded as base64 they are not valid UTF-8, so `toString("utf8")` substitutes
   * U+FFFD — 14 replacement characters out of 33 code points. That is the whole mechanism, and a
   * randomly drawn token would make this test pass or fail by luck; the premise case asserts it.
   *
   * AND IT IS PINNED TOGETHER WITH ITS URL PREFIX, which is the part that is easy to get wrong.
   * `B64_RUN` is `[A-Za-z0-9+/]{16,}`, and `/` is IN that class, so the run it matches inside
   * `https://t.example.com/c/<token>` is not the token — it is `com/c/<token>`. Those are
   * different bytes with a different decode. A first version of this test pinned a token chosen
   * against the bare form; the run the classifier actually sees decoded to something that failed
   * the old rule anyway, so the test passed with the fix REMOVED. The mutation is what found
   * that, not review.
   */
  const GARBAGE_TOKEN = opaqueRun("machine-token-confetti-4", 40);

  const PROSE = "Here are the stories we picked for you this week, we hope you enjoy reading them.";
  const withToken = (t: string) => ({
    canonical: { messageIdHeader: null, bodyHash: "" },
    subject: "Your weekly digest",
    from: { name: null, address: "hello@digest.example.com" },
    to: [], cc: [], date: null, headers: {},
    textBody: `${PROSE} https://t.example.com/c/${t}`,
    htmlBody: null, hasAttachments: false, attachments: [],
  });

  it("the fixture really is confetti — the premise, asserted rather than assumed", () => {
    // If this ever stops holding, every assertion below passes for the wrong reason.
    const run = `https://t.example.com/c/${GARBAGE_TOKEN}`.match(/[A-Za-z0-9+/]{16,}={0,2}/)![0];
    expect(run).toBe(`com/c/${GARBAGE_TOKEN}`);
    const decoded = Buffer.from(run, "base64").toString("utf8");
    expect(decoded).toContain("�");
    // …and it was admissible under the OLD rule: mostly "printable" (U+FFFD is codepoint 65533,
    // which is >= 32) and carrying three consecutive letters by chance.
    const printable = [...decoded].filter((ch) => {
      const c = ch.codePointAt(0)!;
      return c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127);
    }).length;
    expect(printable / [...decoded].length).toBeGreaterThanOrEqual(0.9);
    expect(/[\p{L}]{3}/u.test(decoded)).toBe(true);
  });

  it("ordinary mail carrying such a token is ORDINARY — not `obfuscated_text`", () => {
    // THE DEFECT. The decoded confetti mixes scripts freely, `hasMixedScriptWord` read that as the
    // classic homoglyph signal, and the message became indeterminate → `no_ai`. Measured on one
    // account's Screener: most of the representatives flagged `obfuscated_text` stopped being
    // flagged once base64-shaped runs were removed from the body.
    const v = classifySensitivity(withToken(GARBAGE_TOKEN));
    expect(v.reasons).not.toContain("obfuscated_text");
    expect(v.verdict).toBe("ordinary");
    expect(v.flags.no_ai).toBe(false);
  });

  it("still decodes and scans base64 that really IS text — the arm is narrowed, not removed", () => {
    // The opportunistic arm exists to catch a credential hidden inside an encoded block, and that
    // must keep working. Genuine base64-of-text decodes with ZERO replacement characters, which is
    // precisely what separates it from the case above.
    //
    // The block sits BARE in the body, which is the shape that arm is about — a quoted raw-source
    // block or a forwarded inner part. Inside a URL PATH it is not reached at all, and that is the
    // machine-token masking doing its job rather than anything to do with this change: a long
    // opaque segment under a URL is machine text by construction. Asserted below so the difference
    // is recorded rather than discovered again.
    const hidden = Buffer.from("Your verification code is 918273").toString("base64");
    expect(Buffer.from(hidden, "base64").toString("utf8")).not.toContain("�");

    const v = classifySensitivity({ ...withToken(""), textBody: `${PROSE}\n${hidden}` });
    expect(v.sensitive).toBe(true);
    expect(v.category).toBe("otp");

    // The masked-URL case, pinned as a known and separate limitation.
    expect(classifySensitivity(withToken(hidden)).verdict).toBe("ordinary");
  });
});
