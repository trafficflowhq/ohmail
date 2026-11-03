import { describe, it, expect } from "vitest";
import { fixturePassword } from "../../../test/support/fixture-credentials.js";
import {
  MAILBOX_ERROR_DETAIL_MAX,
  MAILBOX_ERROR_DETAIL_TOKENS,
  classifyMailboxError,
  isSafeMailboxErrorDetail,
  mailboxErrorDetail,
} from "../src/mailboxes.js";

/**
 * `mailboxes.error_detail` IS A the "Account isolation is absolute, and it binds staff too" invariant SURFACE, AND THIS IS THE TEST THAT SAYS SO.
 *
 * The column is read by the account's own user (Settings → Mailboxes) AND by the admin
 * console. The "Account isolation is absolute, and it binds staff too" invariant binds staff: an account's mail — bodies, subjects, senders,
 * recipients, snippets — is reachable by that account's users and by nobody else, operators
 * included. It also states HOW that must hold: "Enforcement must be structural and asserted by
 * a test that has been shown to fail, never a projection someone remembers to keep narrow."
 *
 * `mailboxErrorDetail` is the structural half — an allowlist by SHAPE at the single write
 * site, so no reader has to remember anything. This file is the asserted half, which the slice
 * shipped without: `mailboxErrorDetail` and `classifyMailboxError` had ZERO tests.
 *
 * ── WHY MESSAGE TEXT IS THE THREAT, CONCRETELY ──────────────────────────────────────────
 *
 * A throw out of `runSyncCycle` is not an abstraction. `message_bodies_html_cap` (SQLSTATE
 * 23514) fires with the offending row in the driver's message; a parse failure quotes the
 * RFC822 header bytes it choked on — a real sender, a real subject; a rejected login echoes
 * the login argument, which is the user's own address. Persisting `err.message` would put all
 * three in a column staff read. The cases below are written from those three shapes rather
 * than from invented strings.
 *
 * The classifier is deliberately allowed to READ the message (a rejected password is the most
 * common real failure and several IMAP servers mark it no other way) — its output is a
 * seven-value enum, so nothing escapes. That split is the thing under test: classification may
 * look, storage may not.
 *
 * ── AND THE QUESTION THIS FILE FAILED TO ASK THE FIRST TIME ─────────────────────────────
 *
 * Everything above is about `err.message`, and every case was written from an error WE produce.
 * An external `max`-effort review asked the other question — **who chooses the
 * token?** — and the answer was: the server does. `imapflow` builds `err.serverResponseCode` by
 * uppercasing the first bracket atom of the reply (`tools.js:272-281`), so a hostile endpoint
 * answering `NO [SECRETPASSWORD123]` handed us a value that passed the old SHAPE test
 * (`/^[A-Z][A-Z0-9_-]{0,63}$/`) and was stored for the user and the admin console to read.
 * A guard proves only the case it was written for; the `attacker-controlled` block below is the
 * case that was missing, and the implementation is a CLOSED allowlist because membership is the
 * only property a shape test cannot fake.
 */

/** An error carrying mail content in `message`, the way the real ones do. */
function throwWith(message: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), extra);
}

describe("mailboxErrorDetail — the only value that may reach mailboxes.error_detail", () => {
  it("NEVER returns message text, for every shape that really carries mail content", () => {
    const leaky = [
      // The check violation that actually fired in production, quoting the row.
      throwWith(
        `new row for relation "message_bodies" violates check constraint ` +
          `"message_bodies_html_cap" DETAIL: Failing row contains (Re: Q3 invoice from ` +
          `anna.mueller@example.com, <html>…)`,
      ),
      // A parse failure quoting RFC822 header bytes: sender and subject, verbatim.
      throwWith('invalid header: From: "Anna Müller" <anna.mueller@example.com> Subject: Payroll'),
      // A rejected login echoing the login argument — the user's own address.
      throwWith("LOGIN failed for user mila@lichtgrat.example: invalid credentials"),
      // A stack, in case anything ever passes one through.
      throwWith("boom", { stack: "Error: boom\n  at /srv/app/secret-path/ingest.ts:42" }),
    ];

    for (const err of leaky) {
      expect(mailboxErrorDetail(err)).toBeNull();
    }
  });

  it("keeps the four allowlisted token kinds, which is what makes NULL affordable", () => {
    expect(mailboxErrorDetail({ serverResponseCode: "AUTHENTICATIONFAILED" })).toBe("AUTHENTICATIONFAILED");
    expect(mailboxErrorDetail({ code: "ECONNREFUSED" })).toBe("ECONNREFUSED");
    expect(mailboxErrorDetail({ code: "ERR_TLS_CERT_ALTNAME_INVALID" })).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
    expect(mailboxErrorDetail({ code: "53100" })).toBe("53100");
  });

  it("prefers the server response code over the errno when both are present", () => {
    expect(mailboxErrorDetail({ serverResponseCode: "OVERQUOTA", code: "ECONNRESET" })).toBe("OVERQUOTA");
  });

  it("rejects anything that is merely token-ISH — membership is the whole rule", () => {
    const notTokens = [
      { code: "anna.mueller@example.com" },        // lowercase + punctuation
      { code: "Re: Q3 invoice" },                  // spaces and a colon
      { code: "ECONNREFUSED connecting to mail.example.com" }, // a token with a tail
      { code: "a".repeat(80) },                    // over the length bound
      { code: "" },                                // empty
      { code: 53100 },                             // not a string
      { code: null },
      {},
      null,
      undefined,
    ];
    for (const err of notTokens) expect(mailboxErrorDetail(err)).toBeNull();
  });

  it("never exceeds the column bound", () => {
    // Every member is a protocol constant, so the bound is belt-and-braces rather than the
    // rule — but a member added later must not be able to blow the column.
    for (const token of MAILBOX_ERROR_DETAIL_TOKENS) {
      expect(token.length, token).toBeLessThanOrEqual(MAILBOX_ERROR_DETAIL_MAX);
    }
    expect(mailboxErrorDetail({ code: "ECONNREFUSED" })!.length)
      .toBeLessThanOrEqual(MAILBOX_ERROR_DETAIL_MAX);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE SERVER CHOOSES THE TOKEN, AND THAT IS THE WHOLE ATTACK
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe("a HOSTILE server cannot choose what lands in error_detail", () => {
  /**
   * What imapflow actually does with `* NO [<atom>] text`: `getStatusCode` reads
   * `response.attributes[0].section[0].value`, uppercases and trims it, and
   * `enhanceCommandError` assigns it to `err.serverResponseCode`. So this helper is the real
   * transformation, not an approximation of it.
   */
  const asServerResponseCode = (bracketAtom: string): { serverResponseCode: string } => ({
    serverResponseCode: bracketAtom.toUpperCase().trim(),
  });

  it("stores NULL for a credential-shaped atom a malicious endpoint replies with", () => {
    // The exact sequence from the finding: the endpoint accepts LOGIN and answers
    // `NO [SECRETPASSWORD123]`. Under the old shape test this was persisted verbatim into a
    // column the mailbox owner AND the admin console read.
    expect(mailboxErrorDetail(asServerResponseCode("SECRETPASSWORD123"))).toBeNull();
  });

  it("stores NULL for every attacker-chosen atom that PASSES the old shape test", () => {
    // Each of these matches /^[A-Z][A-Z0-9_-]{0,63}$|^[0-9A-Z]{5}$/ — that is the point. They
    // are what a server can say when it wants a string of its choosing in our database.
    const hostile = [
      "SECRETPASSWORD123",                        // the credential itself
      fixturePassword("redaction-atom").toUpperCase(),
      "ANNA-MUELLER-EXAMPLE-COM",                 // a real sender, punctuation swapped for -
      "RE-Q3-INVOICE-FROM-ACME",                  // a subject
      "MILA_TRAFFICFLOW_CH",                    // the login argument, underscored
      "TOKEN_EYJHBGCIOIJIUZI1NIJ9",               // a bearer prefix
      "A" + "1B2C",                                    // 5 chars: the SQLSTATE alternative
      "PWNED",
      "X".repeat(64),                             // the maximum the old regex allowed
      "SEE-HTTPS-EVIL-EXAMPLE-COM-STEAL",         // an exfiltration URL, dots removed
    ];
    for (const atom of hostile) {
      expect(mailboxErrorDetail(asServerResponseCode(atom)), atom).toBeNull();
      expect(isSafeMailboxErrorDetail(atom.toUpperCase()), atom).toBe(false);
    }
  });

  it("still keeps the REAL response code from the same hostile shape", () => {
    // The allowlist is not "refuse serverResponseCode" — that would throw away the field's
    // whole value. A genuine RFC 5530 code from the same untrusted channel is still stored,
    // because we already knew the word.
    expect(mailboxErrorDetail(asServerResponseCode("authenticationfailed")))
      .toBe("AUTHENTICATIONFAILED");
    expect(mailboxErrorDetail(asServerResponseCode("OverQuota"))).toBe("OVERQUOTA");
    expect(mailboxErrorDetail(asServerResponseCode("UNAVAILABLE"))).toBe("UNAVAILABLE");
  });

  it("does not let a hostile atom shadow a legitimate errno", () => {
    // `serverResponseCode` is preferred over `code`. An unrecognised one must fall THROUGH to
    // the errno rather than shadowing it with NULL — otherwise a hostile server could also
    // blind the operator by suppressing the real reason.
    expect(mailboxErrorDetail({ serverResponseCode: "SECRETPASSWORD123", code: "ECONNRESET" }))
      .toBe("ECONNRESET");
  });

  it("every allowlist member is a bare constant — no whitespace, no punctuation, no sentence", () => {
    // The set is what a reader of Settings → Mailboxes and the admin console can ever be
    // shown. A member carrying a space, a colon, an `@` or a `/` would mean somebody had
    // added a phrase, a subject, an address or a URL to it.
    for (const token of MAILBOX_ERROR_DETAIL_TOKENS) {
      expect(/^[A-Za-z0-9_-]+$/.test(token), token).toBe(true);
    }
  });
});

describe("classifyMailboxError — may READ the message, and returns only an enum", () => {
  const CODES = new Set(["auth", "connect", "tls", "timeout", "storage", "sync", "unknown"]);

  it("classifies a password rejection from message text alone, and leaks nothing doing it", () => {
    const err = throwWith("LOGIN failed for user mila@lichtgrat.example: invalid credentials");
    expect(classifyMailboxError(err, "attach")).toBe("auth");
    // The same error, through the storage path, must still yield nothing.
    expect(mailboxErrorDetail(err)).toBeNull();
  });

  it("names the storage failure that caused the incident, not the customer's mailbox", () => {
    expect(classifyMailboxError({ code: "53100" }, "sync")).toBe("storage");
    expect(classifyMailboxError({ serverResponseCode: "OVERQUOTA" }, "sync")).toBe("storage");
  });

  it("uses the phase only as a FALLBACK, never to override a positive classification", () => {
    expect(classifyMailboxError({ code: "ECONNREFUSED" }, "sync")).toBe("connect");
    expect(classifyMailboxError(throwWith("something we cannot name"), "sync")).toBe("sync");
    expect(classifyMailboxError(throwWith("something we cannot name"), "attach")).toBe("unknown");
  });

  it("returns a member of the enum for every input, including hostile ones", () => {
    const inputs: unknown[] = [
      null, undefined, "a string", 42, {}, [],
      throwWith("Subject: Payroll <anna@example.com>"),
      { code: { toString: () => "ECONNREFUSED" } },   // not a string: must not be trusted
      { message: { toString: () => "authentication failed" } },
    ];
    for (const err of inputs) {
      for (const phase of ["attach", "sync"] as const) {
        expect(CODES.has(classifyMailboxError(err, phase))).toBe(true);
      }
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   "AUTHENTICATION FAILED" IS THE IMAP CLIENT'S WORD FOR *ANY* LOGIN FAILURE
   ══════════════════════════════════════════════════════════════════════════════════════════

   The installed client sets `err.authenticationFailed = true` in the `catch` around the LOGIN
   command, UNCONDITIONALLY and after the `serverResponseCode` assignment — `imapflow@1.5.0`,
   `lib/commands/login.js:33-41`, and identically in `lib/commands/authenticate.js:12-23` for the
   SASL/OAuth path. The flag therefore says "the LOGIN command did not succeed", which is a much
   weaker statement than the one the product makes about it: `en.json`'s `err_auth` is
   *"Sync failed — the mailbox rejected the password."*

   Every shape below is a failure of a mailbox whose password is CORRECT. They are read out of
   the installed package rather than imagined:

    · a tagged `NO` carrying an RFC 5530 bracket atom. `tools.js:272-281` (`getStatusCode`)
      uppercases the first bracket atom of the reply into `err.serverResponseCode`, so
      `NO [UNAVAILABLE]` / `NO [LIMIT]` arrive as a structured token — ALONGSIDE the flag;
    · an untagged `BYE` and a close, which is what a connection cap looks like on the wire from
      the server most providers run. `serverBye` (`imap-flow.js:1553-1566`) keeps only the TEXT
      parts as `byeReason` — the bracket atom is NOT one of them — and the pending LOGIN is then
      rejected by `createNoConnectionError` (`:1987-1994`) with `code: "NoConnection"` and NO
      `serverResponseCode` at all. `login.js` catches that rejection like any other and stamps
      the flag on it;
    · the same close landing while the connect promise is still pending, which rejects at
      `imap-flow.js:2032` with `ClosedAfterConnectText` / `ClosedAfterConnectTLS` and never
      reaches `login.js` — so it carries no flag and, until this slice, no classification either.

   THE CONSEQUENCE THIS GUARDS. `classifyMailboxError` read the flag FIRST, so all of these
   answered `"auth"`; `apps/worker/src/index.ts` quarantines an attach failure on its FIRST
   occurrence, writing `status='error'` and `error_code='auth'` on the row. A provider that is
   merely busy told the user their password was wrong.

   The reported mailbox is on a provider with a low per-account connection cap, and the same
   repository opens IMAP connections from the API for attachment fetches — so this is not a
   hypothetical race with a hostile server. It is the ordinary Tuesday of a capped account. */

describe("a provider refusing to serve is not a rejected password", () => {
  /**
   * `NO [<atom>] <text>`: the flag AND the structured token, exactly as `login.js:34-38`
   * assembles them. Both are present, which is the entire point — the structured token was
   * unreachable because the flag was read first.
   */
  const taggedNo = (atom: string): Record<string, unknown> => ({
    serverResponseCode: atom.toUpperCase().trim(),
    authenticationFailed: true,
  });

  /**
   * `* BYE [UNAVAILABLE] Maximum number of connections from user+IP exceeded`, then a close.
   *
   * NO `serverResponseCode`: `serverBye` keeps the TEXT parts only, and the rejection is built
   * by `createNoConnectionError`, which sets `code` and `reason` and nothing else. This is the
   * shape that makes "move the serverResponseCode probe above the flag" insufficient on its own —
   * there is no response code to find, and it is the shape a real connection cap produces.
   */
  const byeAndClose = (code: string): Record<string, unknown> => ({
    code,
    reason: "Maximum number of connections from user+IP exceeded",
    authenticationFailed: true,
  });

  it("classifies a bracket-atom refusal by what the SERVER said, not by the client's flag", () => {
    // RFC 5530: UNAVAILABLE is "a subsystem is temporarily down", LIMIT is "an implementation
    // limit was reached". Neither is a statement about credentials, and a server that answers
    // either one has demonstrably received and parsed our LOGIN.
    expect(classifyMailboxError(taggedNo("UNAVAILABLE"), "attach")).toBe("connect");
    expect(classifyMailboxError(taggedNo("LIMIT"), "attach")).toBe("connect");
  });

  it("classifies a socket the server hung up DURING login as a connection failure", () => {
    // The three ways the installed client reports a connection that died under a pending
    // command. All three are in its own constant list; none of them was classified.
    expect(classifyMailboxError(byeAndClose("NoConnection"), "attach")).toBe("connect");
    expect(classifyMailboxError(byeAndClose("EConnectionClosed"), "attach")).toBe("connect");
    // …and the variant that never reaches the LOGIN catch, so it carries no flag: rejected
    // straight out of the connect promise at `imap-flow.js:2032`. It used to fall all the way
    // through to the phase fallback and report `unknown` — "we could not tell why" about a
    // failure the client named precisely.
    expect(classifyMailboxError(
      { code: "ClosedAfterConnectText", reason: "Too many connections" }, "attach",
    )).toBe("connect");
    expect(classifyMailboxError(
      { code: "ClosedAfterConnectTLS", reason: "Too many connections" }, "attach",
    )).toBe("connect");
  });

  it("classifies a provider THROTTLE — the same sentence, one provider over", () => {
    // `imap-flow.js:850-863` sets `ETHROTTLE` when a server answers a tagged failure with
    // "Request is throttled. Suggested Backoff Time: N" — Office 365's rate limit. That handler
    // is the GENERIC tagged-response path, so it fires for LOGIN like any other command and
    // `login.js` stamps the flag on it too. Excluding it would have shipped the identical defect
    // for a different provider.
    expect(classifyMailboxError(
      { code: "ETHROTTLE", throttleReset: 92_415, authenticationFailed: true }, "attach",
    )).toBe("connect");
  });

  it("records WHICH refusal it was in error_detail — as far as the wire allows", () => {
    // Part of why `connect` is reused rather than given a sibling: `error_code` carries the part
    // a human acts on and `error_detail` carries the diagnostic, and every token below was
    // already an allowlist member before this slice.
    expect(mailboxErrorDetail(taggedNo("UNAVAILABLE"))).toBe("UNAVAILABLE");
    expect(mailboxErrorDetail(taggedNo("LIMIT"))).toBe("LIMIT");
    expect(mailboxErrorDetail(byeAndClose("NoConnection"))).toBe("NoConnection");
    expect(mailboxErrorDetail({ code: "ClosedAfterConnectText" })).toBe("ClosedAfterConnectText");
    expect(mailboxErrorDetail({ code: "ETHROTTLE" })).toBe("ETHROTTLE");

    // AND THE LIMIT OF THAT CLAIM, STATED RATHER THAN GLOSSED. On the BYE shape the detail is
    // `NoConnection`, which says the socket went away and NOT that a cap was hit — the bracket
    // atom was discarded by `serverBye` before we ever saw it. So the detail is not a reliable
    // route to the sub-case, and the argument that actually decides the taxonomy is the one this
    // asymmetry demonstrates: ONE real condition (a per-account connection cap) reaches us as
    // `LIMIT` on one attempt and as `NoConnection` on the next. A taxonomy member reachable only
    // sometimes would render two different sentences for one outage on two consecutive retries.
    // `connect` is the granularity the wire actually supports.
    expect(mailboxErrorDetail(byeAndClose("NoConnection"))).not.toBe("LIMIT");

    // …and the server's free text is NOT stored, on any of them. `reason` is chosen by the mail
    // server exactly as the bracket atom is, and the rule applies to it unchanged — which is
    // tempting to forget here, because `reason` is the only field that says "too many
    // connections" in words.
    expect(mailboxErrorDetail({ reason: "Maximum number of connections from user+IP exceeded" }))
      .toBeNull();
  });

  /* ── AND THE HALF THAT MUST NOT MOVE ────────────────────────────────────────────────────
     A rejected password is still the single most common real failure of a mailbox, and this
     slice reorders the exact branch that detects it. Each case below is a way the flag used to
     be the ONLY thing that answered, so each is a way this fix could silently stop telling a
     user their password is wrong. */

  it("still says `auth` when the server actually rejected the credentials", () => {
    expect(classifyMailboxError(taggedNo("AUTHENTICATIONFAILED"), "attach")).toBe("auth");
    expect(classifyMailboxError(taggedNo("AUTHORIZATIONFAILED"), "attach")).toBe("auth");
  });

  it("still says `auth` for a bare `NO` with no bracket atom — the flag's real job", () => {
    // Several servers answer `<tag> NO Login failed.` and nothing else. `getStatusCode` returns
    // false, so `serverResponseCode` is never assigned and the flag is the only evidence there
    // is. It must keep deciding this case, which is why it is retained rather than deleted.
    expect(classifyMailboxError({ authenticationFailed: true }, "attach")).toBe("auth");
    expect(classifyMailboxError(
      Object.assign(new Error("Invalid credentials"), { authenticationFailed: true }), "attach",
    )).toBe("auth");
  });

  it("still says `auth` for an atom that is neither a credential verdict nor a refusal", () => {
    // An RFC 5530 code this slice does not name — `EXPIRED`, `PRIVACYREQUIRED`, `CONTACTADMIN` —
    // must fall THROUGH the refusal set to the flag rather than be swallowed by it. These are
    // login verdicts, and `auth` is the honest answer until somebody has a better one.
    expect(classifyMailboxError(taggedNo("EXPIRED"), "attach")).toBe("auth");
    expect(classifyMailboxError(taggedNo("PRIVACYREQUIRED"), "attach")).toBe("auth");
    expect(classifyMailboxError(taggedNo("CONTACTADMIN"), "attach")).toBe("auth");
  });

  it("does NOT let a login `NO [OVERQUOTA]` become a storage failure — that copy blames US", () => {
    // The fourth member of the list above, and the reason the reorder is two named sets rather
    // than a blanket move of the whole response-code probe. `err_storage` reads "ohmail could
    // not store this mail. This one is on us." — so routing a provider's quota refusal there
    // would have this worker apologise for a full mailbox on somebody else's server. A false
    // claim shipped by the deploy that fixes a false claim is exactly what is not allowed here.
    //
    // `auth` is not right for this case either; it is UNCHANGED, which is the point. Whatever is
    // owed to `NO [OVERQUOTA]` on login is owed by a slice that decides what to say about it.
    expect(classifyMailboxError(taggedNo("OVERQUOTA"), "attach")).toBe("auth");
    // …while the same atom from a command that is NOT login carries no flag, and keeps reaching
    // `storage` exactly as it did before. This is the branch the reorder had to leave standing.
    expect(classifyMailboxError({ serverResponseCode: "OVERQUOTA" }, "sync")).toBe("storage");
  });

  it("still lets a HOSTILE atom fall through to the flag instead of blinding the classifier", () => {
    // the server-chooses-the-token attack, asked of the classifier rather than of storage.
    // A server answering `NO [SECRETPASSWORD123]` must not be able to suppress the auth verdict
    // by supplying an atom we do not recognise.
    expect(classifyMailboxError(taggedNo("SECRETPASSWORD123"), "attach")).toBe("auth");
    expect(classifyMailboxError(taggedNo("CONNECT"), "attach")).toBe("auth");
  });
});

/**
 * `error_code` IS ALSO A STAFF CHANNEL, and it had only the compiler behind it.
 *
 * `markMailboxFailed` takes `MailboxErrorCode`, which is a claim about the call sites and not
 * about the column — the column is TEXT with no CHECK. A cast ends the claim. The write door
 * is a runtime membership test, so a code nobody chose is refused rather than stored.
 */
describe("mailboxes.error_code passes a write door, not only a type", () => {
  it("admits every member of the taxonomy", async () => {
    const { staffChannelValue, MAILBOX_ERROR_CODES } = await import("@trafficflow/db");
    for (const code of MAILBOX_ERROR_CODES) {
      expect(staffChannelValue("mailboxes.error_code", code)).toBe(code);
    }
  });

  it("refuses a code a cast could otherwise put in the column", async () => {
    const { staffChannelValue } = await import("@trafficflow/db");
    // The shape a `as MailboxErrorCode` produces from a classifier that was handed a message.
    expect(() => staffChannelValue("mailboxes.error_code", "auth: Re: Q3 board pack"))
      .toThrow(/not a member/);
  });
});
