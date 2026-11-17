import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { redactForModel, screenOutboundText } from "../src/sensitive.js";

/**
 * **SEC3-PRIV-3 — THE SHORT ONE-TIME CODE, which survived `redactForModel` in ten shapes.**
 *
 * An earlier change was believed to close a finding by blanking base64 runs of sixteen characters or more.
 * A six-digit code base64-encoded is EIGHT characters, and its docblock's safety argument —
 * *"nothing the screen can see is left unredacted"* — assumed the screen had fired BECAUSE of the
 * encoded run. It fires on the subject's vocabulary, and then the redactor is handed a snippet
 * carrying the value in a form no pass reaches.
 *
 * ── HOW THIS FILE IS BUILT, AND WHY IT IS BUILT THAT WAY ─────────────────────────────────────
 *
 * TWO corpora, and the second is not decoration. A detector that catches every OTP is trivially
 * satisfiable — blank everything — and the resulting product would be one that hands a model a
 * page of `[REDACTED]` and asks it to route the sender. So every catch here is paired with a
 * false-positive corpus, and that corpus has two halves:
 *
 *  · **UNFLAGGED commerce mail** — order numbers, tracking numbers, invoice references, flight
 *    records, promo codes. These must be BYTE-IDENTICAL, which pins the outer condition: the
 *    redactor does not run at all unless {@link screenOutboundText} flagged the payload.
 *  · **FLAGGED authentication mail whose PROSE must survive** — and this is the half that
 *    actually exercises the new passes, because it is the only place they run. `Your code is
 *    ready`, `Ihr Code ist nicht mehr gültig`, `New sign-in from Chrome on macOS in Zurich`. Each
 *    of those puts a short word in exactly the position a code occupies, and each of them is a
 *    word this product is being paid to let the model read.
 *
 * Every case in both corpora asserts the SCREEN's verdict first. Without that, a false-positive
 * case passes by not being flagged and a catch case is unreachable — the two most likely ways for
 * this file to become decorative.
 */

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * The corpora
 * ════════════════════════════════════════════════════════════════════════════════════════ */

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");
const pct = (s: string): string =>
  [...s].map((c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`).join("");
const entities = (s: string): string => [...s].map((c) => `&#${c.charCodeAt(0)};`).join("");
const hexEntities = (s: string): string =>
  [...s].map((c) => `&#x${c.charCodeAt(0).toString(16)};`).join("");

interface OtpCase {
  /** The provider or shape this stands for — read as the corpus's table of contents. */
  id: string;
  subject: string;
  snippet: string;
  /** Every string that must NOT survive: the value, and the encoded form that carries it. */
  gone: string[];
  /** Words that MUST survive — the subject matter the ruling of 2026-08-08 keeps. */
  kept: string[];
}

/**
 * THE OTP CORPUS — the shapes providers actually send, plus the encodings a body actually
 * carries them in. Ten of the twelve were measured leaving `redactForModel` intact.
 */
const OTP_CORPUS: OtpCase[] = [
  // ── plain, and already closed before this slice: the regression half of the corpus ─────────
  {
    id: "github/digits",
    subject: "Your GitHub launch code",
    snippet: "Continue by entering the code below.\n\n482913\n\nThis code expires in 15 minutes.",
    gone: ["482913"],
    kept: ["expires in 15 minutes", "Continue by entering"],
  },
  {
    id: "apple/upper-alnum",
    subject: "Your Apple Account verification code",
    snippet: "Your verification code is: A" + "3F9KQ. Do not share it with anyone.",
    gone: ["A" + "3F9KQ"],
    kept: ["Do not share it", "verification code"],
  },
  // ── plain, and NOT closed before this slice ────────────────────────────────────────────────
  {
    id: "notion/lower-mixed",   // a lower-case alphanumeric login code
    subject: "Your temporary Notion login code",
    snippet: "Enter q3wvsxca to sign in. The code expires in 10 minutes.",
    gone: ["q3wvsxca"],
    kept: ["to sign in", "expires in 10 minutes"],
  },
  {
    id: "generic/mixed-case",
    subject: "Your verification code",
    snippet: "Your code is a3F9kQ — it expires in 10 minutes.",
    gone: ["a3F9kQ"],
    kept: ["expires in 10 minutes"],
  },
  {
    id: "generic/lower-hex",
    subject: "Your verification code",
    snippet: "Your code is a3f9c1 — it expires in 10 minutes.",
    gone: ["a3f9c1"],
    kept: ["expires in 10 minutes"],
  },
  {
    id: "slack/grouped-letters",
    subject: "Confirm your email address",
    snippet: "Your confirmation code is bcpq-tsrn-mxvl",
    gone: ["bcpq", "tsrn", "mxvl", "bcpq-tsrn-mxvl"],
    kept: ["confirmation code"],
  },
  {
    id: "steam/standalone-upper",   // presented alone on its own line, five characters
    subject: "Your Steam access code",
    snippet: "Here is the code you need:\n\nKMXQR\n\nIt is valid for 30 minutes.",
    gone: ["KMXQR"],
    kept: ["valid for 30 minutes"],
  },
  // ── the ENCODED forms: SEC3-PRIV-3's own reproduction ─────────────────────────────────────
  {
    id: "encoded/base64-6-digit",   // `NDgyOTEz` — eight characters, half of B64_RUN's floor
    subject: "Your login code",
    snippet: `Your code: ${b64("482913")}`,
    gone: [b64("482913"), "482913"],
    kept: ["Your code:"],
  },
  {
    id: "encoded/base64-8-digit",
    subject: "Your login code",
    snippet: `Your code: ${b64("48291337")}`,
    gone: [b64("48291337"), "48291337"],
    kept: ["Your code:"],
  },
  {
    id: "encoded/base64-alnum",
    subject: "Your verification code",
    snippet: `Your code: ${b64("A" + "3F9KQ")}`,
    gone: [b64("A" + "3F9KQ"), "A" + "3F9KQ"],
    kept: ["Your code:"],
  },
  {
    id: "encoded/percent-escapes",   // matched by NO pass at all, at any length, before this
    subject: "Your login code",
    snippet: `Your code: ${pct("482913")}`,
    gone: [pct("482913"), "%34", "482913"],
    kept: ["Your code:"],
  },
  {
    id: "encoded/decimal-entities",
    subject: "Your login code",
    snippet: `Your code: ${entities("482913")}`,
    gone: [entities("482913"), "&#52;", "482913"],
    kept: ["Your code:"],
  },
  {
    id: "encoded/hex-entities",
    subject: "Your login code",
    snippet: `Your code: ${hexEntities("482913")}`,
    gone: [hexEntities("482913"), "&#x34;", "482913"],
    kept: ["Your code:"],
  },
  // ── GERMAN, both the plain and the encoded form. The lexicon is one lexicon or it is two. ──
  {
    id: "de/bestaetigungscode-mixed",
    subject: "Ihr Bestätigungscode",
    snippet: "Ihr Code lautet a3F9kQ. Bitte teilen Sie ihn niemandem mit.",
    gone: ["a3F9kQ"],
    kept: ["Bitte teilen Sie ihn niemandem mit", "Ihr Code lautet"],
  },
  {
    id: "de/anmeldecode-standalone",
    subject: "Ihr Anmeldecode",
    snippet: "Ihr Code lautet:\n\n482913\n\nEr ist 10 Minuten gültig.",
    gone: ["482913"],
    kept: ["10 Minuten gültig"],
  },
  {
    id: "de/bestaetigungscode-base64",
    subject: "Ihr Bestätigungscode",
    snippet: `Ihr Code: ${b64("482913")}`,
    gone: [b64("482913"), "482913"],
    kept: ["Ihr Code:"],
  },
  {
    id: "de/tan-banking",
    subject: "Ihre TAN für die Überweisung",
    snippet: "Ihre TAN lautet 482913. Sie ist fünf Minuten gültig.",
    gone: ["482913"],
    kept: ["fünf Minuten gültig"],
  },
];

interface CleanCase { id: string; subject: string; snippet: string; }

/**
 * FALSE POSITIVES, HALF ONE — mail the screen must not flag, which must therefore come out
 * byte-identical. This is the half that protects the rest of the Screener, and the mutation
 * that breaks it is "make `redactForModel` redact unconditionally".
 */
const COMMERCE_CORPUS: CleanCase[] = [
  { id: "order/en", subject: "Order 4429117 shipped", snippet: "Your parcel left the depot on Tuesday." },
  {
    id: "tracking/en", subject: "Your parcel is on its way",
    snippet: "Tracking number TN4829105573824617 — delivery Tuesday between 09:00 and 12:00.",
  },
  {
    id: "invoice/en", subject: "Invoice 2026-0814",
    snippet: "Total CHF 1290.00, reference 88213, due in 30 days.",
  },
  {
    id: "flight/en", subject: "Your booking LH1234",
    snippet: "Booking reference AB1234, seat 12A, record locator XKD9QW. Check in from 24h before.",
  },
  {
    id: "promo/en", subject: "SPRING20 — 20% off everything",
    snippet: "Use discount code SPRING20 at checkout. Ends Sunday.",
  },
  {
    id: "order/de", subject: "Ihre Bestellung 4429117",
    snippet: "Ihre Sendungsnummer lautet 00340434161094012221. Zustellung am Dienstag.",
  },
  {
    id: "newsletter/en", subject: "NEWSLETTER — issue 42",
    snippet: "Read on: https://example.invalid/issues/42",
  },
  {
    id: "thread/2fa-discussion", subject: "Re: rolling out 2FA",
    snippet: "We should enable two-factor for everyone by 2026. Thoughts?",
  },
];

/**
 * FALSE POSITIVES, HALF TWO — mail the screen DOES flag, where the new passes really run.
 *
 * Every `kept` here is a short word sitting in the position a code occupies. `ready` follows the
 * credential noun and a copula; `nicht` follows one in German and is one vowel in five, which is
 * under {@link looksUnpronounceable}'s threshold; `Schmidt` stands alone on a signature line and
 * is one vowel in seven; `Chrome`, `macOS` and `Zurich` are the entire content of a security
 * alert. Each was found by running the corpus, not by reading the regex.
 */
const FLAGGED_PROSE_CORPUS: Array<CleanCase & { kept: string[] }> = [
  {
    id: "prose/code-is-ready", subject: "Your verification code",
    snippet: "Your code is ready. Open the app to continue.",
    kept: ["ready", "Open the app to continue"],
  },
  {
    id: "prose/code-expired", subject: "Your sign-in code",
    snippet: "Your code has expired. Request a new one below.",
    kept: ["expired", "Request a new one below"],
  },
  {
    id: "prose/de-nicht-gueltig", subject: "Ihr Bestätigungscode",
    snippet: "Ihr Code ist nicht mehr gültig. Fordern Sie einen neuen an.",
    kept: ["nicht mehr gültig", "Fordern Sie einen neuen an"],
  },
  {
    id: "prose/de-angefordert", subject: "Ihr Anmeldecode",
    snippet: "Ihr Code wurde soeben angefordert. Sie haben zehn Minuten Zeit.",
    kept: ["soeben angefordert", "zehn Minuten Zeit"],
  },
  {
    id: "prose/reset-no-code", subject: "Reset your password",
    snippet: "We received a request to reset your password. If this wasn't you, ignore this email.",
    kept: ["received a request", "ignore this email"],
  },
  {
    id: "prose/verify-no-code", subject: "Verify your email address",
    snippet: "Click the button below to confirm your address and finish signing up.",
    kept: ["Click the button below", "finish signing up"],
  },
  {
    id: "prose/security-alert", subject: "New sign-in from Chrome",
    snippet: "New sign-in from Chrome on macOS in Zurich, Switzerland. Was this you?",
    kept: ["Chrome", "macOS", "Zurich", "Switzerland"],
  },
  {
    id: "prose/security-alert-device", subject: "Security alert",
    snippet: "A new device signed in: iPhone 15 Pro, iOS 26, Zurich.",
    kept: ["iPhone", "Zurich"],
  },
  {
    id: "prose/signature-name", subject: "Verify your email",
    snippet: "Please confirm your address.\n\nRegards\nSchmidt\nSupport",
    kept: ["Regards", "Schmidt", "Support"],
  },
];

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * The guards
 * ════════════════════════════════════════════════════════════════════════════════════════ */

describe("SEC3-PRIV-3 — every OTP shape leaves without its value", () => {
  it("PREMISE: every case in the OTP corpus is flagged by the screen", () => {
    // Without this the corpus below is vacuous: `redactForModel` rewrites nothing on a payload the
    // screen calls safe, so a case that stopped being flagged would pass by not being touched.
    for (const c of OTP_CORPUS) {
      expect(screenOutboundText(c.subject, c.snippet).safe, `${c.id} is no longer flagged`).toBe(false);
    }
    expect(OTP_CORPUS.length).toBeGreaterThanOrEqual(17);
  });

  for (const c of OTP_CORPUS) {
    it(`${c.id}: the value is gone and the words stay`, () => {
      const out = redactForModel(c.subject, c.snippet);
      expect(out.redacted).toBe(true);
      const sent = `${out.subject}\n${out.snippet}`;
      for (const secret of c.gone) {
        expect(sent, `${c.id} still carries ${JSON.stringify(secret)}`).not.toContain(secret);
      }
      for (const word of c.kept) {
        expect(sent, `${c.id} lost ${JSON.stringify(word)}`).toContain(word);
      }
    });
  }

  it("…and still does after the TRANSPORT collapses the layout", () => {
    /**
     * The corpus above writes bodies the way a provider writes them, with the code on its own
     * line. **That is not what `redactForModel` receives.** `bodySnippet` (`packages/core/src/
     * pipeline.ts`) is `textBody.replace(/\s+/g, " ").trim().slice(0, 200)`, so every newline is
     * gone before any model payload is built, and a rule that leaned on line layout would be
     * correct against the corpus and dead in production.
     *
     * This runs the identical corpus through the identical collapse. It is the reason the colon
     * rule exists at all: `Here is the code you need:\n\nKMXQR` is a standalone line before the
     * collapse and `Here is the code you need: KMXQR` after it, and only the second shape is ever
     * seen by the code under test.
     *
     * MUTATION: drop `COLON_FRAMED_VALUE` ⇒ red on `steam/standalone-upper` here while the
     * uncollapsed case above stays green. That asymmetry is the whole point of this test.
     */
    const collapse = (t: string): string => t.replace(/\s+/g, " ").trim().slice(0, 200);
    for (const c of OTP_CORPUS) {
      const subject = collapse(c.subject);
      const snippet = collapse(c.snippet);
      expect(screenOutboundText(subject, snippet).safe, `${c.id} unflagged once collapsed`).toBe(false);
      const out = redactForModel(subject, snippet);
      const sent = `${out.subject}\n${out.snippet}`;
      for (const secret of c.gone) {
        expect(sent, `${c.id} carries ${JSON.stringify(secret)} through the transport`)
          .not.toContain(secret);
      }
    }
  });

  it("MUTATION WATCH: the floor-only detector fails this corpus", () => {
    // The pre-fix behaviour, restated as a predicate rather than reinstated as code: a rule that
    // only blanks runs of sixteen or more leaves every encoded case here untouched. If this ever
    // goes green the corpus has stopped containing short encoded credentials, which is the one way
    // the tests above could become decorative without any of them turning red.
    const floorOnly = (t: string): string => t.replace(/[A-Za-z0-9+/]{16,}={0,2}/g, "[REDACTED]");
    const survivors = OTP_CORPUS.filter((c) =>
      c.gone.some((secret) => `${floorOnly(c.subject)}\n${floorOnly(c.snippet)}`.includes(secret)));
    expect(survivors.length, "the old detector must fail on most of this corpus").toBeGreaterThanOrEqual(10);
  });
});

describe("SEC3-PRIV-3 — and ordinary mail is untouched", () => {
  it("commerce mail is not flagged, so it comes out BYTE-IDENTICAL", () => {
    // MUTATION: make `redactForModel` redact unconditionally ⇒ red here while the OTP corpus stays
    // green. That asymmetry is the whole reason this half exists.
    for (const c of COMMERCE_CORPUS) {
      expect(screenOutboundText(c.subject, c.snippet).safe, `${c.id} became flagged`).toBe(true);
      const out = redactForModel(c.subject, c.snippet);
      expect(out.redacted, `${c.id} was needlessly redacted`).toBe(false);
      expect(out.subject).toBe(c.subject);
      expect(out.snippet).toBe(c.snippet);
    }
  });

  it("MUTATION WATCH: a naive six-character floor eats the commerce corpus", () => {
    // The rejected design, as a predicate. `Tracking`, `delivery`, `reference`, `Booking`,
    // `checkout` and `Sendungsnummer` are all six or more alphanumerics. This is why the fix is a
    // decode-and-look rather than a lower number.
    const naive = (t: string): string => t.replace(/[A-Za-z0-9]{6,}/g, "[REDACTED]");
    const damaged = COMMERCE_CORPUS.filter((c) => naive(c.snippet) !== c.snippet);
    expect(damaged.length, "a 6-char floor must visibly damage ordinary mail")
      .toBe(COMMERCE_CORPUS.length);
  });

  it("FLAGGED authentication mail keeps its prose — the half the new passes actually run on", () => {
    // MUTATION: drop the `looksLikeCredentialValue` digit/pronounceability arm and blank on shape
    // alone ⇒ red on `ready`, `nicht`, `Schmidt` and the security-alert device names.
    for (const c of FLAGGED_PROSE_CORPUS) {
      expect(screenOutboundText(c.subject, c.snippet).safe, `${c.id} is no longer flagged`).toBe(false);
      const out = redactForModel(c.subject, c.snippet);
      const sent = `${out.subject}\n${out.snippet}`;
      for (const word of c.kept) {
        expect(sent, `${c.id} lost ${JSON.stringify(word)}`).toContain(word);
      }
    }
  });

  it("a security alert carries no code, so the short-code passes do not run on it", () => {
    // The gate is `codeFramed`, read off the screen's own category. A `security_alert` payload is
    // the one flagged class where the useful content — the device, the browser, the city — wears
    // the shape of a code.
    // MUTATION: make `codeFramed` return true unconditionally ⇒ red on `iPhone15`.
    const out = redactForModel("Security alert", "Signed in on iPhone15 in Zurich. Was this you?");
    expect(screenOutboundText("Security alert", "Signed in on iPhone15 in Zurich. Was this you?").category)
      .toBe("security_alert");
    expect(out.snippet).toContain("iPhone15");
    expect(out.snippet).toContain("Zurich");
  });

  it("the sixteen-character base64 rule keeps its floor and its original job", () => {
    // SEC3-PRIV-3 is not a reason to touch this rule: it exists because a run that long is machine
    // text whatever it decodes to, and it is the reach of `decodeEmbedded` rather than a guess.
    // MUTATION: delete `B64_RUN` from `redactEncodedRuns` ⇒ red.
    const blob = b64("Your one-time passcode is 482913. Do not share it.");
    const out = redactForModel("Fwd: see below", `Content-Transfer-Encoding: base64\n\n${blob}`);
    expect(out.snippet).not.toContain(blob);
    expect(out.snippet).not.toMatch(/[A-Za-z0-9+/]{16,}/);
  });

  it("a colon alone does not frame a code — the CUE has to be there too", () => {
    /**
     * Found by mutation, not by design: removing the `hasCredentialCue` gate from the colon rule
     * left the whole corpus GREEN, which means nothing in it was holding that gate. A rule with an
     * unwatched condition is a rule whose condition can be deleted in a refactor.
     *
     * `Username: mkbhd` is the shape that pays for it. A handle is exactly what an authentication
     * mail puts after a colon, it is five letters with no vowel — so
     * `looksUnpronounceable` says "code" about it — and it is precisely the token the model needs
     * in order to say anything useful about the sender.
     *
     * MUTATION: drop the `hasCredentialCue(window, window)` condition ⇒ red here, and green
     * everywhere else in this file.
     */
    const subject = "Verify your email address";
    const snippet = "Confirming the account. Username: mkbhd";
    expect(screenOutboundText(subject, snippet).category).toBe("verification");
    expect(redactForModel(subject, snippet).snippet).toContain("mkbhd");

    // ANTI-VACUITY: the same colon, the same token shape, WITH the cue in front of it.
    const framed = redactForModel("Your verification code", "Here is the code you need: mkbhd");
    expect(framed.snippet).not.toContain("mkbhd");
    expect(framed.snippet).toContain("Here is the code you need");
  });

  it("a base64 run that decodes to WORDS is left alone; one that decodes to a code is not", () => {
    // `Q29uZmlybQ` decodes to `Confirm` and `aGVsbG8gd29ybGQ` to `hello world`. Both were admitted
    // by a shape-only version of `looksLikeCredentialValue`, and both are rejected now by its
    // digit / pronounceability arm. They are in this file because a word list found them, not
    // because anybody predicted them.
    //
    // The framing is a `security_alert` DELIBERATELY, and it is what makes this test about the
    // decoder. Under a code-framed payload the plain mixed-alphanumeric pass reaches `Q29uZmlybQ`
    // first — it is a letter-and-digit run — and the assertion would be measuring that instead.
    // With `codeFramed` false the only pass still running is `redactShortEncodedRuns`, so both
    // halves below are statements about the decode predicate and nothing else.
    const words = redactForModel("Security alert", "See Q29uZmlybQ and aGVsbG8gd29ybGQ below.");
    expect(screenOutboundText("Security alert", "x").category).toBe("security_alert");
    expect(words.redacted).toBe(true);
    expect(words.snippet).toContain("Q29uZmlybQ");
    expect(words.snippet).toContain("aGVsbG8gd29ybGQ");

    // ANTI-VACUITY: the same pass, the same framing, a run that really is a credential.
    const code = redactForModel("Security alert", `See ${b64("482913")} below.`);
    expect(code.snippet).not.toContain(b64("482913"));
    expect(code.snippet).not.toContain("482913");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * The sink, structurally
 * ════════════════════════════════════════════════════════════════════════════════════════ */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
    }
  };
  for (const group of ["packages", "apps"]) {
    let members: string[];
    try { members = readdirSync(join(ROOT, group)); } catch { continue; }
    for (const m of members) walk(join(ROOT, group, m, "src"));
  }
  return out;
}

/** Source with block comments and line comments removed, so a docblock mention is not a call site. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

describe("SEC3-PRIV-3 — the redaction sits AT the sink, so no caller can skip it", () => {
  /**
   * The sink is `if (!screen.safe && input.outbound !== "prescreened") throw`. It is bypassed by
   * design on the Suggest path, on the stated assumption that redaction already ran. That
   * assumption is only true if the bypass token and the redaction are produced in the SAME place —
   * otherwise a second caller can mint the token without the transform, which is exactly the shape
   * SEC3-PRIV-4 and SEC3-PRIV-6 found one layer up.
   *
   * So this is a structural guard rather than a behavioural one: it reads the repository.
   */
  it("`outbound: \"prescreened\"` is produced in exactly one function, and that function redacts", () => {
    const producers = sourceFiles().filter((p) => /outbound:\s*"prescreened"/.test(codeOnly(readFileSync(p, "utf8"))));
    expect(producers.map((p) => p.slice(ROOT.length))).toEqual(["packages/core/src/classify-prompt.ts"]);

    const src = readFileSync(join(ROOT, "packages/core/src/classify-prompt.ts"), "utf8");
    const from = src.indexOf("export async function askScreeningQuestion");
    expect(from, "askScreeningQuestion moved").toBeGreaterThan(0);
    const body = src.slice(from, src.indexOf("\nexport ", from + 1));
    expect(body).toContain("redactForModel(ask.subject, ask.snippet)");
    expect(body).toContain('outbound: "prescreened"');
    // …and the redaction is what feeds the request, not a value computed and dropped.
    expect(body).toMatch(/subject:\s*safe\.subject/);
    expect(body).toMatch(/snippet:\s*safe\.snippet/);
  });

  it("every automatic and pressed model buyer reaches the port THROUGH that function", () => {
    // The two callers SEC3-PRIV-6 enumerated. Neither may build a classifier request of its own;
    // if either did, its payload would carry no `prescreened` token and the sink would refuse it —
    // which is the property that makes this list safe to be short.
    for (const caller of [
      "packages/services/src/screener-service.ts",
      "packages/organizer/src/screener-auto-suggest.ts",
    ]) {
      const src = codeOnly(readFileSync(join(ROOT, caller), "utf8"));
      expect(src, `${caller} no longer routes through askScreeningQuestion`)
        .toContain("askScreeningQuestion(classifier");
    }
  });

  it("the sink still refuses a payload that carries a short encoded code and no token", () => {
    // The behavioural companion: the automatic routing path sets no `outbound`, and this class of
    // payload must stay refused there whatever the redactor can now do about it.
    const screen = screenOutboundText("Your login code", `Your code: ${b64("482913")}`);
    expect(screen.safe).toBe(false);
  });
});
