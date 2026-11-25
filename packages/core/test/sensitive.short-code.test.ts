import { expect, it } from "vitest";
import { classifyUserPayload } from "../src/classify-prompt.js";

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
    id: "order/title-case-label", subject: "Shipping update",
    snippet: "Your Order code is 736284. Keep it for returns.",
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
    id: "thread/second-factor-discussion", subject: "Re: rolling out " + "2" + "FA",
    snippet: "We should enable two-factor for everyone by 2026. Thoughts?",
  },
  {
    id: "prose/order-before-security-footer", subject: "Shipping update",
    snippet: ["Order reference:", "736284", "", "Never share your verification code."].join("\n"),
  },
  {
    id: "prose/de-order-before-security-footer", subject: "Versand",
    snippet: ["Bestellnummer:", "736284", "", "Teilen Sie Ihren Bestätigungscode niemals."].join("\n"),
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
    id: "prose/pin-verb", subject: "Board notes",
    snippet: "Pin IMPORTANT.",
    kept: ["IMPORTANT"],
  },
  {
    id: "prose/de-pin-verb", subject: "Pinnwand",
    snippet: "Pin WICHTIG an die Pinnwand.",
    kept: ["WICHTIG"],
  },
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

it.each(OTP_CORPUS)("strips credential material but keeps the preview for $id", ({ subject, snippet, gone, kept }) => {
  const input = { from: { name: null, address: "sender@example.test" }, subject, snippet, headersDigest: "" };
  const payload = classifyUserPayload(input);
  const originalValue = gone.reduce((longest, value) => value.length > longest.length ? value : longest);
  expect(payload).toMatchObject({ subject, snippet: snippet.replace(originalValue, "[code]") });
  for (const value of gone) expect(payload.snippet).not.toContain(value);
  for (const prose of kept) expect(payload.snippet).toContain(prose);
  expect(input).toMatchObject({ subject, snippet });
});

it.each([...COMMERCE_CORPUS, ...FLAGGED_PROSE_CORPUS])(
  "keeps ordinary subject and preview fields byte-identical for $id",
  ({ subject, snippet }) => {
    const payload = classifyUserPayload({ from: { name: null, address: "sender@example.test" }, subject, snippet, headersDigest: "" });
    expect(payload).toMatchObject({ subject, snippet });
  },
);

it.each([
  ["638194 Example Desk", "Enter this verification code to continue.", "[code] Example Desk", "Enter this verification code to continue."],
  ["Account access", "Your Example Desk code is 638194.", "Account access", "Your Example Desk code is [code]."],
  ["Konto", "Die einmalige Zahlenfolge lautet 638194.", "Konto", "Die einmalige Zahlenfolge lautet [code]."],
  ["Earlier mail", "Thanks.\n> Enter the code below.\n>> 638194\n> It expires soon.", "Earlier mail", "Thanks.\n> Enter the code below.\n>> [code]\n> It expires soon."],
  ["Earlier mail", "Thanks.\n> Your sign-in code:\n>> 638194", "Earlier mail", "Thanks.\n> Your sign-in code:\n>> [code]"],
  ["Sign in", "Enter the code below. 638194 It expires soon.", "Sign in", "Enter the code below. [code] It expires soon."],
])("redacts credential text with its local context in %s", (subject, snippet, cleanSubject, cleanSnippet) => {
  const input = { from: { name: null, address: "" }, subject, snippet, headersDigest: "" };
  expect(classifyUserPayload(input)).toMatchObject({ subject: cleanSubject, snippet: cleanSnippet });
});
