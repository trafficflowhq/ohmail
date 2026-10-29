/* THIS CORPUS IS PART OF THE AI SPEND GATE'S SURFACE: the database package's AI gate documents
 * that its sensitivity ordering rests on `classifySensitivity` actually recognising the mail,
 * and this file is the evidence. That comment used to cite this file by full path; it now says
 * "its test corpus (`sensitive.test.ts`, beside the classifier)" because the db sources are
 * prepared for publication and test directories are not yet published — the pointer lives here
 * instead. */
import { describe, it, expect } from "vitest";
import { classifySensitivity, screenOutboundText, redactForModel, foldDigits } from "../src/sensitive.js";
import { normalizeMime } from "../src/mime.js";
import type { NormalizedMessage } from "../src/types.js";
import {
  WITHHELD, normalized, type WithheldCase,
  ORDINARY_ONE_WORD_SUBJECTS, CREDENTIAL_SHAPES,
  NON_ASCII_DIGIT_CODES, FRAMED_NON_ASCII_CODES, ORDINARY_NUMERIC_TEXT,
  B24_LEAKS, B24_NEGATIVES, B24_ADVERSARIAL,
} from "./fixtures/sensitive-corpus.js";

function msg(subject: string, body: string): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject, from: { name: null, address: "no-reply@bank.example" }, to: [],
    date: null, headers: {}, textBody: body, htmlBody: null, hasAttachments: false,
    attachments: [],
  };
}

describe("classifySensitivity", () => {
  it("flags an OTP email and keeps the code out of a model payload (body is NOT redacted)", () => {
    const subject = "Your verification code";
    const body = "Your one-time code is 483920. It expires soon.";
    const r = classifySensitivity(msg(subject, body));
    expect(r.sensitive).toBe(true);
    expect(r.verdict).toBe("sensitive");
    expect(r.category).toBe("otp");
    expect(r.flags).toEqual({ no_ai: true, no_forward: true, no_kb: true, priority: true });
    // Body redaction at rest is removed — the user reads their own code in full. The surviving
    // guarantee is the MODEL gate: the code is stripped from any payload bound for a model, and
    // `no_ai` keeps this message out of automatic AI in the first place.
    const forModel = redactForModel(subject, body);
    expect(forModel.redacted).toBe(true);
    expect(forModel.snippet).not.toContain("483920");
    expect(forModel.snippet).toContain("[REDACTED]");
  });
  it("flags a password reset", () => {
    expect(classifySensitivity(msg("Reset your password", "Click to reset your password.")).category).toBe("password_reset");
  });
  it("leaves a normal email untouched", () => {
    const r = classifySensitivity(msg("Lunch?", "Hey, lunch tomorrow at 12:30?"));
    expect(r.sensitive).toBe(false);
    // CONVERTED for that change: `sensitive === false` used to be the whole statement, and that is
    // exactly the bug — it conflated "ordinary" with "no pattern matched". The claim this test
    // now makes is the stronger one: this message is positively ORDINARY, with no unknown in it.
    expect(r.verdict).toBe("ordinary");
    expect(r.reasons).toEqual([]);
    expect(r.flags.no_ai).toBe(false);
    // Ordinary mail is unchanged by the model gate too — nothing to strip.
    expect(redactForModel("Lunch?", "Hey, lunch tomorrow at 12:30?").redacted).toBe(false);
  });
});

describe("a letter of pictures with no text part is screened on its parse, its words counted once", () => {
  it("a sign-in link judged by the 40-word prose bound keeps the verdict it had before the words", async () => {
    const html = "<table><tr><td><p>Hello Mila,</p><p>We noticed you asked to sign in to your workspace from a new browser "
      + "this morning. Use the button below to continue where you left off today.</p>"
      + '<p><a href="https://app.example/login?t=Xk29fLq83PzR7mWqZ">Sign in</a></p></td></tr></table><img src="cid:logo@x">';
    const m = await normalizeMime(["Message-ID: <link@example.test>", "From: App <no-reply@app.example>", "To: mila@example.test",
      "Subject: Your workspace", "MIME-Version: 1.0", 'Content-Type: multipart/related; boundary="R"', "",
      "--R", "Content-Type: text/html; charset=utf-8", "", html,
      "--R", "Content-Type: image/png", "Content-ID: <logo@x>", "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--R--", ""].join("\r\n"));
    expect(m.textBody).toContain("asked to sign in");
    const r = classifySensitivity(m);
    expect(r).toEqual(classifySensitivity({ ...m, textBody: "" }));
    expect([r.verdict, r.reasons, r.flags.no_ai, r.flags.no_kb]).toEqual(["indeterminate", ["auth_url_token"], true, true]);
    // Read twice, the words pass the bound and the letter would go to a model as ordinary.
    expect(classifySensitivity({ ...m, ownText: undefined }).verdict).toBe("ordinary");
  });
});

/**
 * THE ADVERSARIAL CORPUS — the upstream half of the the "Sensitive mail" invariant.
 *
 * `flags.no_ai` is the only thing keeping an authentication mail away from the model, out of
 * the ledger and out of storage unredacted. Every downstream guarantee — "a sensitive message
 * produces zero `credit_ledger` rows", "the raw secret never leaves the process" — is a
 * statement about THIS function, so the coverage has to be a corpus rather than three examples.
 *
 * The first cut recognised "verification code", "one-time passcode" and "password reset", and
 * missed the wording most consumer providers actually use. `Your sign-in code`, `Your login
 * code is 991122` and a bare magic link were all ordinary mail: charged for, sent to the
 * classifier in `bodySnippet`, stored unredacted. Every case in the first block below is one
 * of those.
 *
 * The NEGATIVE list is not decoration and it is the half that keeps this honest. Fixing a
 * detector by widening it until everything matches is not fixing it — `no_ai` on ordinary mail
 * silently removes the product's entire AI layer for the messages it hits, and nobody would
 * ever see a test go red. The two lists are asserted together, in the same file, on purpose.
 * Since that change the negative list asserts `verdict === "ordinary"` and an EMPTY reason set, which is
 * a stricter claim than `no_ai === false` was: it fails if any of the new indeterminate rules
 * starts firing on real mail, not merely if the vocabulary starts matching it.
 */
describe("classifySensitivity — the adversarial corpus", () => {
  /** Subject, body, expected category. Shaped like what providers actually send. */
  const SENSITIVE: Array<[string, string, string]> = [
    // ── The false negatives that started this ────────────────────────────────────────────
    ["Your sign-in code", "Use 482913 to sign in.", "otp"],
    ["Your login code is 991122", "Enter it on the sign-in screen.", "otp"],
    ["Sign in to Acme", "Click here to sign in: https://acme.io/m?t=abc123", "verification"],
    // ── English OTP vocabulary, across providers ─────────────────────────────────────────
    ["Your verification code", "Code: 448213", "otp"],
    ["Your one-time passcode is 448213", "It expires in 10 minutes.", "otp"],
    ["Your Acme security code", "123456", "otp"],
    ["Your authentication code", "112233", "otp"],
    ["Your access code", "9931 — do not share it.", "otp"],
    ["Your confirmation code", "556677", "otp"],
    ["Your recovery code", "Keep it somewhere safe.", "otp"],
    ["Your 2FA code", "889900", "otp"],
    ["Your single-use code", "445566", "otp"],
    ["Acme", "Here is your code to sign in: 771122", "otp"],
    ["Acme", "Use 482913 to log in to your account.", "otp"],
    // The scheme NAMED with the code under it — the shape providers use when the subject is the
    // heading. `Two-factor authentication` with no code moved to SCHEME_WITHOUT_CODE below; this
    // row is the one that goes red if `schemeNameNearCode` stops reaching the digits, and it is
    // reached by no other arm (`two-factor` is not followed by `code`, and there is no copula).
    ["Acme security", "Two-factor authentication\n\n482913\n\nExpires in 10 minutes.", "otp"],
    // ── the wording the first finding named, which the four regexes did not reach ─────────
    ["Your PIN", "Keep this to yourself.", "otp"],
    ["482913 is your verification number", "Enter 482913 in the app.", "otp"],
    ["Your temporary password", "Sign in with it once and choose your own.", "otp"],
    // ── Password reset ───────────────────────────────────────────────────────────────────
    ["Password reset", "We received a request.", "password_reset"],
    ["Reset your password", "Follow the link below.", "password_reset"],
    ["Forgot your password?", "No problem — here is a link.", "password_reset"],
    ["Choose a new password", "Your old one no longer works.", "password_reset"],
    // ── Passwordless / verification links ────────────────────────────────────────────────
    ["Your magic link", "Tap to sign in.", "verification"],
    ["Your sign-in link", "Valid for 15 minutes.", "verification"],
    ["Confirm your email address", "Click the verification link below.", "verification"],
    ["Verify your account", "Follow this link to log in.", "verification"],
    ["Acme", "One-click sign in — no password needed.", "verification"],
    // ── Security alerts ──────────────────────────────────────────────────────────────────
    ["New sign-in from Chrome on macOS", "Was this you?", "security_alert"],
    ["Security alert", "Unusual activity on your account.", "security_alert"],
    ["New login attempt blocked", "From an unrecognised device.", "security_alert"],
    // ── de / fr / it / es — a Swiss mailbox receives all of these ─────────────────────────
    ["Ihr Bestätigungscode", "482913", "otp"],
    ["Einmalcode für Ihre Anmeldung", "993311", "otp"],
    ["Ihr Sicherheitscode", "112233", "otp"],
    ["Passwort zurücksetzen", "Klicken Sie hier.", "password_reset"],
    ["Neue Anmeldung erkannt", "Sicherheitswarnung für Ihr Konto.", "security_alert"],
    ["Votre code de vérification", "123 456", "otp"],
    ["Votre code de sécurité", "778899", "otp"],
    ["Réinitialiser votre mot de passe", "Cliquez sur le lien.", "password_reset"],
    ["Acme", "Voici votre lien de connexion.", "verification"],
    ["Nouvelle connexion détectée", "Alerte de sécurité.", "security_alert"],
    ["Il tuo codice di verifica", "445566", "otp"],
    ["Il tuo codice di sicurezza", "334455", "otp"],
    ["Reimposta la password", "Segui il link.", "password_reset"],
    ["Nuovo accesso rilevato", "Avviso di sicurezza.", "security_alert"],
    ["Tu código de verificación", "445566", "otp"],
    ["Tu código de seguridad", "223344", "otp"],
    ["Restablecer tu contraseña", "Haz clic aquí.", "password_reset"],
    ["Nuevo inicio de sesión", "Alerta de seguridad.", "security_alert"],
  ];

  /**
   * Ordinary mail that must stay ordinary. Several are deliberate near-misses on the widened
   * patterns — "sign in to see your order", "use code SPRING20", "area code" — because a
   * detector that matches those has not been fixed, it has been switched off. The additions
   * are near-misses on the NEW rules instead: a bare year in a subject, a total in francs, a
   * flight number shaped like an upper-alphanumeric code, a newsletter link with a token in it.
   */
  const ORDINARY: Array<[string, string]> = [
    ["Your order has shipped", "Track it here. Sign in to see the details."],
    ["20% off this weekend", "Use code SPRING20 at checkout."],
    ["Promo code inside", "Enter the discount code SAVE10 to sign in savings."],
    ["Invoice #4471 from Acme GmbH", "Payment is due in 14 days. Total CHF 1240.00"],
    ["Weekly digest", "Log in to your dashboard to see the numbers."],
    ["Re: lunch on Thursday", "Works for me — 12:30 at the usual place."],
    ["Your flight AB1234 is confirmed", "Seat 14C. Check-in opens 24h before departure."],
    ["New comment on your pull request", "Sign in to GitHub to reply."],
    ["Area code change notice", "Our area code is now 044 — please update your records."],
    ["Newsletter #82", "Read online. Unsubscribe at any time."],
    ["Your subscription renews soon", "Manage your plan in account settings."],
    ["Meeting notes 2026-07-14", "Action items: 1) ship 2) measure 3) decide"],
    ["Delivery attempted", "We will try again tomorrow between 09:00 and 12:00."],
    ["Welcome to Acme", "Here is a tour of what you can do."],
    // ── near-misses on the indeterminate rules ────────────────────────────────────────────
    ["Issue 42 — the quiet part", "Read on: https://theslowdraft.invalid/issues/42\n\nUnsubscribe: https://theslowdraft.invalid/u/1234"],
    ["Your order #48213 is confirmed", "Order #48213\n\n2 × Bench plane blade CHF 45.00\n1 × Shipping CHF 9.00\n\nTotal: CHF 54.00"],
    ["Your monthly statement", "Statement period 2026-06-01 to 2026-06-30. Closing balance CHF 8412.55. No action is needed."],
    ["Timber delivery window", "The lorry is booked for Thursday between 08:00 and 11:00. Call 044 512 8890 if that slips."],
  ];

  /**
   * THE SCHEME NAMED, AND NO CODE ANYWHERE — a topic, not a credential.
   *
   * `otp`, `2fa`, `two-factor` and `multi-factor` used to be positive on their own, so any
   * message containing the word was stored redacted and withheld. Unlike `passcode`, which names
   * the credential object, these name a METHOD, and a method is something people write to each
   * other about. Measured on a large live store: a share of the `otp` rows rested entirely on one of
   * these four words, and the class is vendor security announcements, developer newsletters,
   * "mandatory MFA is coming" notices, a password manager's own marketing, and human threads
   * about rolling 2FA out — 35 of them carrying no code-shaped token at all.
   *
   * These rows are the ones that MOVED, listed rather than deleted so the change is legible. The
   * claim is not that they are unimportant; it is that there is no credential in them for
   * redaction to protect or for a model to leak, and that {@link SENSITIVE} holds the
   * code-carrying twin of each shape. `Enter the code from your authenticator app` is here for
   * the same reason: it tells the reader to go and read a code off a device, and carries none.
   */
  const SCHEME_WITHOUT_CODE: Array<[string, string]> = [
    ["Two-factor authentication", "Enter the code from your authenticator app."],
    ["Account", "Please enable 2FA on your account before Friday."],
    ["Account", "The OTP will arrive by SMS."],
    ["Account", "We have switched your account to two-factor sign-in."],
    ["Account", "multi-factor is now required for all admins."],
    ["Re: AW: AW: Webshop", "Super, dass ihr an 2FA dran seid. Gerade bei kompromittierten "
      + "Login-Daten ist 2FA wichtig – da hilft ein Captcha nicht mehr."],
  ];

  it.each(SCHEME_WITHOUT_CODE)("reads %j / %j as a topic, not a credential", (subject, body) => {
    const r = classifySensitivity(msg(subject, body));
    expect(r.category).toBe(null);
    expect(r.verdict).toBe("ordinary");
    expect(r.reasons).toEqual([]);
    // A scheme NAME with no code is a topic, so the model gate leaves it untouched too.
    expect(redactForModel(subject, body).redacted).toBe(false);
  });

  /**
   * The SAME text with one code-shaped run inserted immediately after the scheme name — beside
   * it, not appended, because the rule is a PROXIMITY rule and a code forty characters further
   * down the message is a different claim. The insertion goes wherever the scheme name actually
   * is: `Enter the code from your authenticator app` carries none, and its subject does.
   */
  const withCodeBesideScheme = (subject: string, body: string): [string, string] => {
    const scheme = /\b(otp|2fa|two[-\s]?factor|multi[-\s]?factor)\b/i;
    if (scheme.test(body)) return [subject, body.replace(scheme, "$& 482913")];
    return [subject.replace(scheme, "$& 482913"), body];
  };

  it.each(SCHEME_WITHOUT_CODE)("but %j / %j with a code beside it is still otp", (subject, body) => {
    const [s, b] = withCodeBesideScheme(subject, body);
    expect(`${s}\n${b}`, "the twin must really differ from the original").toContain("482913");
    const r = classifySensitivity(msg(s, b));
    expect(r.category).toBe("otp");
    expect(r.sensitive).toBe(true);
    // This is the pair that makes the rule above a precision change rather than a hole: if
    // `schemeNameNearCode` ever stopped firing, this assertion — not the one above — goes red.
    // (Asserted through the model gate now, which is the surviving place a code is stripped.)
    const forModel = redactForModel(s, b);
    expect(forModel.redacted).toBe(true);
    expect(`${forModel.subject}\n${forModel.snippet}`).not.toContain("482913");
  });

  it.each(SENSITIVE)("flags %j / %j as %s — no_ai, and every flag with it", (subject, body, category) => {
    const r = classifySensitivity(msg(subject, body));
    expect(r.sensitive).toBe(true);
    expect(r.verdict).toBe("sensitive");
    expect(r.category).toBe(category);
    // `no_ai` is the flag every downstream guarantee reads; the others move with it.
    expect(r.flags).toEqual({ no_ai: true, no_forward: true, no_kb: true, priority: true });
  });

  it.each(ORDINARY)("leaves %j / %j alone — AI stays available for real mail", (subject, body) => {
    const r = classifySensitivity(msg(subject, body));
    expect(r.sensitive).toBe(false);
    // CONVERTED for that change and deliberately stricter than `no_ai === false`: an empty reason set
    // is the assertion that no indeterminate rule fired either. This is the guard that stops
    // "fail closed" from becoming "AI is off".
    expect(r.verdict).toBe("ordinary");
    expect(r.reasons).toEqual([]);
    expect(r.flags.no_ai).toBe(false);
    expect(r.flags.no_kb).toBe(false);
    // Ordinary mail is left untouched by the model gate as well.
    expect(redactForModel(subject, body).redacted).toBe(false);
  });

  it("strips every credential-shaped token from a model payload, in all its usual shapes", () => {
    const subject = "Your sign-in code";
    const body = "Code 482913, backup 123-456, device token AB12CD34. Expires in 10 minutes.";
    const r = classifySensitivity(msg(subject, body));
    expect(r.sensitive).toBe(true);
    // Not from the stored body — that stays full and the user reads it — but from the model payload.
    const forModel = redactForModel(subject, body);
    for (const secret of ["482913", "123-456", "AB12CD34"]) {
      expect(forModel.snippet, secret).not.toContain(secret);
    }
  });

  it("strips the token out of a magic link's model payload, which CODE alone never reached", () => {
    const subject = "Your magic link";
    const body = "Tap to sign in: https://accounts.example.com/session?t=SECRET-LOGIN-TOKEN";
    const r = classifySensitivity(msg(subject, body));
    expect(r.sensitive).toBe(true);
    const forModel = redactForModel(subject, body);
    expect(forModel.snippet).not.toContain("SECRET-LOGIN-TOKEN");
    expect(forModel.snippet).toContain("[REDACTED]");
  });

  it("the corpus BITES: the four ORIGINAL patterns miss most of it", () => {
    // Anti-vacuity, and a record of the size of the gap. These are verbatim the patterns that
    // shipped; if a future edit narrows back towards them, this says how much coverage that
    // costs instead of leaving the corpus quietly passing on the three cases it always did.
    const missedByOld = SENSITIVE.filter(([s, b]) => !ORIGINAL_PATTERNS.some((re) => re.test(`${s}\n${b}`)));
    expect(missedByOld.length).toBeGreaterThan(SENSITIVE.length / 2);
  });
});

/** Verbatim the four regexes that shipped before the corpus widened them. Used for anti-vacuity. */
const ORIGINAL_PATTERNS = [
  /\b(one[-\s]?time (pass)?code|verification code|security code|otp|2fa|two[-\s]?factor|authentication code|passcode)\b/i,
  /\b(reset (your )?password|password reset|reset request)\b/i,
  /\b(verify your (email|account|address)|confirm your (email|account)|verification link|magic link)\b/i,
  /\b(new sign[-\s]?in|new login|unusual (sign[-\s]?in|activity)|security alert|suspicious activity)\b/i,
];

/* ══════════════════════════════════════════════════════════════════════════════════════════
 * THE FAIL-CLOSED CORPUS
 * ════════════════════════════════════════════════════════════════════════════════════════ */

async function materialise(c: WithheldCase): Promise<NormalizedMessage> {
  if (c.raw !== undefined) return normalizeMime(Buffer.from(c.raw, "utf8"));
  return normalized(c.patch ?? {});
}

/**
 * Invariant #1 must fail CLOSED (the project's design notes..3).
 *
 * The single mandatory assertion for every case is `flags.no_ai === true`. `verdict` and
 * `category`/`reason` are pinned as well, not because the "Sensitive mail" invariant needs them, but because a case
 * silently sliding from `sensitive` to `indeterminate` is coverage being lost — the message would
 * still be withheld from the model, but it would stop being routed to the account holder and stop being
 * stored redacted, and no test would say so.
 */
describe("every withheld case sets no_ai, and none of them is 'ordinary'", () => {
  it.each(WITHHELD.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const m = await materialise(c);
    const r = classifySensitivity(m);

    // THE invariant. Everything else in this block is about not losing coverage quietly.
    expect(r.flags.no_ai, `${c.id} — ${c.why}`).toBe(true);
    expect(r.flags.no_kb, `${c.id} — no_kb moves with no_ai`).toBe(true);
    expect(r.verdict, `${c.id} — ${c.why}`).toBe(c.expect);

    if (c.expect === "sensitive") {
      expect(r.sensitive).toBe(true);
      if (c.category) expect(r.category).toBe(c.category);
      expect(r.flags.no_forward).toBe(true);
    } else {
      expect(r.sensitive).toBe(false);
      expect(r.category).toBeNull();
      if (c.reason) expect(r.reasons).toContain(c.reason);
      // Indeterminate is still NOT "sensitive with a different name": it is NEVER re-routed to the
      // account holder and NEVER prioritised.
      expect(r.flags.no_forward).toBe(false);
      expect(r.flags.priority).toBe(false);
      // BODY REDACTION AT REST IS REMOVED — the reader always sees the full body of their own
      // mail, so there is nothing here to assert about a stored redaction. The surviving disclosure
      // guarantee for a withheld message is `no_ai`/`no_kb` (asserted above): it never reaches
      // automatic AI. (`redactForModel` still strips the credential from a user-pressed AI payload;
      // that transform is unchanged and has its own tests — it is not re-asserted per corpus row.)
    }
  });

  it("the corpus BITES: the pre-B10 boundary would have sent most of it to the model", async () => {
    // The pre-B10 decision was, exactly: the four ORIGINAL patterns over `subject + "\n" +
    // textBody`, with no canonicalisation, no HTML, no attachment names, no decoding — and
    // `no_ai = (a pattern matched)`. Reconstructed here so the corpus cannot become vacuous:
    // if someone reverts the fix, this number goes UP and the assertion above goes red.
    const escaped: string[] = [];
    for (const c of WITHHELD) {
      const m = await materialise(c);
      const hay = `${m.subject}\n${m.textBody}`;
      if (!ORIGINAL_PATTERNS.some((re) => re.test(hay))) escaped.push(c.id);
    }
    expect(escaped.length).toBeGreaterThan(WITHHELD.length * 0.75);
  });

  it("covers every source of 'unknown' the design enumerates", () => {
    // A corpus that has drifted away from the design is not a guard. Each reason the
    // implementation can produce must be exercised by at least one case.
    const pinned = new Set(WITHHELD.map((c) => c.reason).filter(Boolean));
    for (const reason of [
      "unsupported_script", "unrecognised_language", "credential_shape", "auth_url_token",
      "alternatives_disagree", "obfuscated_text", "encoded_block", "nested_message",
      "no_visible_text", "scan_truncated",
    ]) {
      expect(pinned, reason).toContain(reason);
    }
  });

  it("covers the five non-Latin scripts the brief names, plus four more", () => {
    const ids = WITHHELD.map((c) => c.id).join(" ");
    for (const script of ["script/ja", "script/zh", "script/ar", "script/ru", "script/he"]) {
      expect(ids, script).toContain(script);
    }
  });
});

/**
 * the credential-shape rule fired on ORDINARY ONE-WORD SUBJECTS, at both entry points.
 *
 * `TOKEN_ONLY`'s third alternative was `[A-Za-z0-9]{6,10}`, which matches words. `subject` is a
 * representation, so a one-word subject was enough to make a message `indeterminate` ⇒ `no_ai`.
 * It failed CLOSED, so nothing ever leaked — this was precision, and the "No API cost without revenue behind it" invariant measures AI value
 * against cost.
 *
 * **Both entry points are exercised, because they read different text.** `classifySensitivity`
 * asks per REPRESENTATION; `screenOutboundText` JOINS its parts, so an empty subject with a
 * one-word body was a token-only payload and was refused at the sink independently of any subject
 * question. A shared predicate does not prove the call sites pass it the right text — only calling
 * both does.
 */
describe("ordinary one-word subjects are not credentials", () => {
  it("classifySensitivity: all 30 ordinary one-word subjects are ordinary", () => {
    const withheld = ORDINARY_ONE_WORD_SUBJECTS.filter(
      (s) => classifySensitivity(msg(s, "hello")).verdict !== "ordinary",
    );
    expect(withheld, `withheld from AI by subject alone: ${withheld.join(", ")}`).toEqual([]);
  });

  it("the sink accepts them too — it joins its parts, so the body carries the same shape", () => {
    // Empty subject + one-word body. Refused before the narrowing, and not a subject problem.
    for (const s of ORDINARY_ONE_WORD_SUBJECTS) {
      const screen = screenOutboundText("", s);
      expect(screen.safe, `the sink refused the ordinary snippet "${s}"`).toBe(true);
    }
  });

  it("every credential shape is STILL withheld — the sensitive-mail guarantee is untouched", () => {
    const leaked = CREDENTIAL_SHAPES.filter(
      (c) => classifySensitivity(msg("Atlas", c)).flags.no_ai !== true,
    );
    expect(leaked, `credential shapes that would now reach AI: ${leaked.join(", ")}`).toEqual([]);
  });

  it("and the sink still refuses every one of them", () => {
    for (const c of CREDENTIAL_SHAPES) {
      const screen = screenOutboundText("", c);
      expect(screen.safe, `the sink ACCEPTED the credential shape "${c}"`).toBe(false);
      expect(screen.reason).toBe("credential_shape");
    }
  });

  it("a genuine OTP is still sensitive, not merely withheld", () => {
    // The positive path must not have degraded into the fail-closed path.
    const r = classifySensitivity(msg("Your verification code", "482913 is your code."));
    expect(r.verdict).toBe("sensitive");
  });
});

/**
 * a code in non-ASCII digits is a code. Invariant #1, BOTH halves.
 *
 * `[0-9]` matches no digit outside ASCII, and `TOKEN_ONLY` used to read `rep.raw`, so a body that
 * was nothing but `٠١٢٣٤٥` classified `ordinary` and would have been sent to a model — while the
 * identical ASCII `123456` was withheld. Same family as that change, which was Critical.
 *
 * Pre-existing rather than introduced by that change: both the old and the new `TOKEN_ONLY` miss it.
 */
describe("non-ASCII digits", () => {
  it("withholds a bare code in every script NFKC does not fold", () => {
    const sent: string[] = [];
    for (const [script, code] of NON_ASCII_DIGIT_CODES) {
      const r = classifySensitivity(msg("", code));
      if (r.flags.no_ai !== true) sent.push(`${script} (${code})`);
    }
    expect(sent, `these would be SENT TO THE MODEL: ${sent.join(", ")}`).toEqual([]);
  });

  it("the sink refuses them too", () => {
    for (const [script, code] of NON_ASCII_DIGIT_CODES) {
      expect(screenOutboundText("", code).safe, `the sink accepted ${script}`).toBe(false);
    }
  });

  it("framed variants stay SENSITIVE — vocabulary owns those, not shape", () => {
    // If a later change collapses the union, these must not silently demote to indeterminate.
    for (const [label, subject, body] of FRAMED_NON_ASCII_CODES) {
      expect(classifySensitivity(msg(subject, body)).verdict, label).toBe("sensitive");
    }
  });

  it("strips a non-ASCII code from a model payload — the model gate folds digits too", () => {
    // A framed Arabic code classifies sensitive, and the model gate must strip it before it can
    // reach a model even though the digits are not ASCII. (The stored body keeps the code — the
    // reader sees their own mail in full — so this is asserted through `redactForModel`.)
    const body = "رمز التحقق ٠١٢٣٤٥";
    const r = classifySensitivity(msg("", body));
    expect(r.sensitive).toBe(true);
    const forModel = redactForModel("", body);
    expect(forModel.snippet).not.toContain("٠١٢٣٤٥");
    expect(forModel.snippet).toContain("[REDACTED]");
  });

  it("leaves ordinary numeric text completely alone", () => {
    // The identity half. A fold verified only on the class it repairs cannot tell "fixed the class"
    // from "rewrote every message".
    for (const s of ORDINARY_NUMERIC_TEXT) {
      const r = classifySensitivity(msg("Re: the quote", s));
      expect(r.verdict, `${s} was withheld`).toBe("ordinary");
      // The model gate leaves ordinary numeric text (prices, dates, order numbers) untouched.
      expect(redactForModel("Re: the quote", s).redacted, `${s} was altered`).toBe(false);
    }
  });

  /**
   * The mechanical guard. Not a handful of examples: three separate wrong implementations of the
   * fold each passed a hand-picked list. This enumerates every `\p{Nd}` codepoint the runtime knows,
   * groups them into contiguous runs, and asserts each decade maps to `0123456789` — which is what
   * catches the adjacent-decade bug (Mathematical Alphanumeric digits are five contiguous decades,
   * so a naive back-walk reads a neighbour's offset). It re-verifies when Node adds a script.
   */
  it("every Unicode decimal decade folds to 0123456789, and ASCII is identity", () => {
    // Tests the FOLD, directly, because the classifier's verdict cannot observe a digit's VALUE —
    // and value is what all three wrong implementations got wrong. A first attempt at this test
    // asserted a redacted body, which only ever fired for `sensitive` mail and so reported 75
    // false failures: the test was wrong, the fold was not.
    const isNd = /\p{Nd}/u;
    const cps: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) if (isNd.test(String.fromCodePoint(cp))) cps.push(cp);
    const runs: number[][] = [];
    let cur = [cps[0]!];
    for (let i = 1; i < cps.length; i++) {
      if (cps[i] === cps[i - 1]! + 1) cur.push(cps[i]!);
      else { runs.push(cur); cur = [cps[i]!]; }
    }
    runs.push(cur);

    const wrong: string[] = [];
    let decades = 0;
    for (const run of runs) {
      for (let i = 0; i + 9 < run.length; i += 10) {
        decades++;
        const decade = run.slice(i, i + 10).map((c) => String.fromCodePoint(c)).join("");
        if (foldDigits(decade) !== "0123456789") wrong.push(`U+${run[i]!.toString(16)}`);
      }
    }
    expect(decades, "the runtime must expose many decimal decades").toBeGreaterThan(50);
    expect(wrong, `decades folding to the wrong VALUE: ${wrong.slice(0, 5).join(", ")}`).toEqual([]);

    // The identity half, which versions 2 and 3 of the fold failed.
    expect(foldDigits("0123456789")).toBe("0123456789");
    for (const s of ORDINARY_NUMERIC_TEXT) expect(foldDigits(s), s).toBe(s);
  });

  it("withholds a SIX-digit code in every decade the runtime knows", () => {
    // The behavioural companion. Six, not ten: a 9-10 digit run is a phone or tracking number and
    // a later change deliberately released it, so a full decade is correctly `ordinary`.
    const isNd = /\p{Nd}/u;
    const zeros: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const ch = String.fromCodePoint(cp);
      if (isNd.test(ch) && foldDigits(ch) === "0" && !isNd.test(String.fromCodePoint(cp - 1))) zeros.push(ch);
    }
    const sent: string[] = [];
    for (const zero of zeros) {
      const base = zero.codePointAt(0)!;
      const code = [1, 2, 3, 4, 5, 6].map((d) => String.fromCodePoint(base + d)).join("");
      if (classifySensitivity(msg("", code)).flags.no_ai !== true) sent.push(code);
    }
    expect(zeros.length, "decade starts found").toBeGreaterThan(50);
    expect(sent, `six-digit codes that would reach the model: ${sent.slice(0, 5).join(", ")}`).toEqual([]);
  });

  it("a Cyrillic word cannot become a credential via confusable folding", () => {
    // The confusable table synthesises digits (з→3), so folding could in principle turn a word into
    // a mixed token. It cannot matter — enough non-Latin letters is already `unsupported_script` —
    // but that is asserted here rather than trusted as a comment.
    const r = classifySensitivity(msg("", "зззззз"));
    expect(r.flags.no_ai).toBe(true);
  });
});

/**
 * a real one-time passcode reached the model when the framing sat BEFORE the number.
 *
 * Measured before the fix: **realistic OTP mails came out `ordinary`, `no_ai: false`.** Including
 * `subject "Finish signing in"` / `"Hi Mila,\n\nYour code is 482913.\n\nThanks,\nAcme"` — an
 * entirely ordinary OTP mail. `"Your code is 482913"` is arguably the most common OTP body in
 * English and it was sent.
 *
 * The cause was that the two framing arms are order-sensitive: `CODE_CUE` wants an imperative
 * BEFORE the code, `CODE_TRAILER` wants a phrase AFTER it, and a possessive noun phrase before it
 * matched neither.
 *
 * **The nonsense-qualifier cases below are the point of this block.** Before the fix, the mails
 * that WERE held were held by vocabulary coincidence — `"Your verification code is …"` survives
 * because that exact phrase is in `OTP`, so the shape layer was never what caught it. Replacing the
 * qualifier with a nonsense word removes the vocabulary and leaves only the shape rules, which is
 * what makes "held for a reason" structural rather than accidental.
 */
describe("framing before the number is still framing", () => {
  const OTP_MAILS: ReadonlyArray<readonly [label: string, subject: string, body: string]> = [
    ["a realistic OTP mail", "Finish signing in", "Hi Mila,\n\nYour code is 482913.\n\nThanks,\nAcme"],
    ["subject names the product only", "Sign in to Acme", "Your code is 482913"],
    ["bare brand subject", "Acme", "Your code is 482913"],
  ];

  it.each(OTP_MAILS)("%s is SENSITIVE, so a model never sees the code", (_l, subject, body) => {
    // `sensitive`, not merely `indeterminate`. The stored body keeps the code (the reader sees
    // their own OTP mail in full); the surviving guarantee is that the model gate strips it.
    const r = classifySensitivity(msg(subject, body));
    expect(r.verdict).toBe("sensitive");
    expect(redactForModel(subject, body).snippet).not.toContain("482913");
  });

  it("a leading share-prohibition frames the code — the only trailer that is position-free", () => {
    // "Do not share NNNN" has no ordinary-commerce reading, which is why ONLY this subset of the
    // trailer vocabulary is allowed to match in either position.
    const r = classifySensitivity(msg("Confirm it is you", "Do not share 482913 with anyone."));
    expect(r.flags.no_ai).toBe(true);
  });

  it.each([
    ["noun-copula, nonsense qualifier", "your flurm code is 482913"],
    ["code-then-trailer, nonsense qualifier", "482913 is your flurm code"],
    ["colon form", "Code: 482913"],
    ["German copula", "Ihr Code lautet 482913"],
  ])("SHAPE holds without any vocabulary: %s", (_l, body) => {
    expect(classifySensitivity(msg("", body)).flags.no_ai, body).toBe(true);
  });

  /**
   * The precision boundary, and the reason the fully position-independent version is FORBIDDEN.
   *
   * Reversing `is\s+your` would eat "here is your invoice 22910" and the whole `here is your X
   * NNNN` commerce family; reversing `valid for` / `expires in` would eat "offer valid for 2026".
   * `BARE_CODE` is 4-8 digits, which is also every order number and booking reference in ordinary
   * mail — so these are not hypothetical, they are most of a real mailbox.
   */
  it.each([
    "your order code 4821 is ready for pickup",   // digits BEFORE the copula — arm 3's canary
    "the invoice number is 22910",                 // wrong noun
    "your booking reference is 84213",             // wrong noun
    "code 500 error on checkout",                  // below BARE_CODE's four-digit floor
    "here is your invoice 22910",                  // the forbidden reversal's victim
    "offer valid for 2026",                        // year within 24 chars
    "your code is ready",                          // no digits: arm 1 must need them
    "barcode is 48213",                            // no word boundary inside the word
    "attached is your quote 48213",
  ])("ordinary commerce mail stays ordinary: %s", (body) => {
    const r = classifySensitivity(msg("Re: your order", body));
    expect(r.verdict, `${body} → ${JSON.stringify(r.reasons ?? [])}`).toBe("ordinary");
  });

  it("the SINK refuses the joined payload too — the fix has two call sites", () => {
    // The defect was present at both `classifySensitivity` and `screenOutboundText`; a fix verified
    // through one of them ships an unverified change to the last check before serialisation.
    const screen = screenOutboundText("Finish signing in", "Your code is 482913");
    expect(screen.safe).toBe(false);
  });
});

/**
 * a live code framed in a language the vocabulary does not reach reached the model AND was
 * stored raw. `Ihre TAN lautet 481920.` (German is the product's home market), `Twój kod jednorazowy
 * to 559214` (Polish), `Uw toegangscode is 220417` (Dutch), a spaced `Ihr Code: 44 12 90`: each was
 * `verdict=ordinary`, `no_ai=false`, its code sent to `classifier.classify` via `bodySnippet` and
 * written to `message_bodies.text` unredacted. `screenOutboundText` — the last check before a model
 * payload — passed them too, because it shares the credential-shape primitive.
 *
 * The first half is a language-independent numeric backstop: a credential-noun cue within a short window of a
 * bare 4–8-digit run, landing in the fail-closed `credential_shape` bucket. The second stores the redacted
 * body for those cases, closing the "Sensitive mail" invariant's second half for the whole fail-closed bucket.
 *
 * The two lists are asserted together, on purpose: the backstop is only acceptable if the negative
 * class — order numbers, prices, dates, `order code 4821` — is provably untouched.
 */
describe("the language-independent numeric backstop", () => {
  it.each(B24_LEAKS.map((c) => [c.id, c] as const))(
    "catches %s — no_ai, sink refuses, and the code is stripped from a model payload", (_id, c) => {
      const m = msg(c.subject, c.body);
      const r = classifySensitivity(m);

      // THE invariant: it never reaches the model, from either entry point.
      expect(r.flags.no_ai, `${c.id} — reached AI`).toBe(true);
      expect(r.flags.no_kb, `${c.id}`).toBe(true);
      expect(screenOutboundText(c.subject, c.body).safe, `${c.id} — the SINK let it out`).toBe(false);
      expect(r.verdict, `${c.id}`).toBe(c.expect);

      // The stored body keeps the code (the reader reads their own mail in full); the surviving
      // guarantee is that the MODEL payload strips every 4–8-digit run the body carried.
      const digits = c.body.match(/[0-9]{3,4}[-\s][0-9]{3,4}|\b[0-9]{4,8}\b/g) ?? [];
      if (digits.length > 0) {
        const forModel = redactForModel(c.subject, c.body);
        for (const d of digits) {
          expect(forModel.snippet, `${c.id} — ${d} would reach a model`).not.toContain(d);
        }
      }
    },
  );

  it.each(B24_NEGATIVES)("leaves %s ordinary — AI stays available for real mail", (_id, subject, body) => {
    const r = classifySensitivity(msg(subject, body));
    // Deliberately stricter than `no_ai === false`: an empty reason set proves no indeterminate
    // rule fired either, and the model gate leaves the payload untouched.
    expect(r.verdict).toBe("ordinary");
    expect(r.reasons).toEqual([]);
    expect(r.flags.no_ai).toBe(false);
    expect(redactForModel(subject, body).redacted).toBe(false);
    expect(screenOutboundText(subject, body).safe).toBe(true);
  });

  it.each(B24_ADVERSARIAL)("adversarial: %s is still caught (no residual leak)", (_id, subject, body) => {
    const r = classifySensitivity(msg(subject, body));
    expect(r.flags.no_ai).toBe(true);
    expect(screenOutboundText(subject, body).safe).toBe(false);
  });

  it("a credential carried only in the HTML part is withheld from the model (body kept in full)", () => {
    // A code carried only in the HTML part, framed in a language the vocabulary misses: the visible
    // text makes it `indeterminate [credential_shape]`, so it is kept out of automatic AI. The body
    // itself is stored in full — the reader sees their own TAN mail — and the classifier is fed the
    // TEXT snippet (empty here), never the html, so no model payload ever carries this code.
    const m: NormalizedMessage = {
      canonical: { messageIdHeader: null, bodyHash: "x" },
      subject: "Bericht", from: { name: null, address: "no-reply@bank.invalid" }, to: [],
      date: null, headers: {}, textBody: "", htmlBody: "<p>Ihre TAN lautet 662311.</p>",
      hasAttachments: false, attachments: [],
    };
    const r = classifySensitivity(m);
    expect(r.flags.no_ai).toBe(true);
    expect(r.flags.no_kb).toBe(true);
    expect(r.verdict).toBe("indeterminate");
  });

  it("MUTATION-WATCH: a German TAN is ordinary again if the backstop is removed", () => {
    // Not a live mutation — a documentation of what going red means. The predicate under test is
    // `looseNumericCode`; deleting its term from `credentialShapeIn` returns this to `ordinary`,
    // and the ceiling corpus (`sensitive.corpus.test.ts`) stays green because the seeded world has
    // no such mail, which is why this explicit case exists.
    const r = classifySensitivity(msg("Freigabe", "Ihre TAN lautet 481920."));
    expect(r.verdict).toBe("indeterminate");
    expect(r.reasons).toContain("credential_shape");
  });
});
