import { describe, it, expect } from "vitest";
import { classifySensitivity, screenOutboundText } from "../src/sensitive.js";
import type { NormalizedMessage } from "../src/types.js";
import { hex64, opaqueRun } from "../../../test/support/fixture-credentials.js";

/**
 * THE AUTHENTICATION-URL RULE, AT BOTH ENDS.
 *
 * `hasAuthUrlToken` decides two things at once: whether a message is withheld from every model
 * (`no_ai`) and stored with its body redacted, and whether an assembled payload is refused at the
 * outbound sink. Its own docblock says BOTH an authentication marker AND a token are required.
 * For a long time only the marker was, because the token search began at the `/` of `https://` and
 * so ran over the hostname — every URL "carried a token", namely its own host.
 *
 * The cost was measured on a live account: many of the senders waiting in the Screener were
 * withheld from the model, so the account owner could not buy a suggestion for them and read the
 * silence as the product skipping them. Four they named — a monitoring alert, a social network's recap, an
 * AI service's notification, a Mac app's advert — were all this rule firing on an ordinary `/sign-in`
 * or `/login` link in a footer.
 *
 * Both halves are asserted here and both are load-bearing: the ORDINARY cases prove the rule
 * stopped over-firing, and the CREDENTIAL cases prove that loosening it did not open the hole it
 * exists to close. Every case is asserted at BOTH call sites, because a fix that repaired the
 * stored flag while leaving the sink refusing would leave the Screener just as silent.
 */

function msg(subject: string, body: string, html: string | null = null): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "x" },
    subject, from: { name: null, address: "announcements@example.com" }, to: [],
    date: null, headers: {}, textBody: body, htmlBody: html, hasAttachments: false,
    attachments: [],
  };
}

/** Enough ordinary prose that the language probe and the no-visible-text rule stay quiet. */
const PROSE = "Here is what is new this month. We shipped a few things and wrote about them.";

/**
 * An authentication MARKER with no token after it. Every one of these is a page a person opens,
 * not a credential mailed to them — which is exactly the distinction the docblock claims to draw.
 */
const MARKER_WITHOUT_TOKEN: Array<[string, string]> = [
  ["a monitoring service's sign-in link", "https://app.netdata.cloud/sign-in?cloudRoute=alerts"],
  ["a social recap's login link", "https://www.instagram.com/accounts/login/?next=%2Frecap"],
  ["a bare /login", "https://example.com/login"],
  ["a discount code, which is not a credential", "https://shop.example.com/?code=SPRING20"],
  ["a one-character unsubscribe parameter", "https://n.example.com/u?t=1"],
  ["a short numeric confirm id", "https://mail.example.com/c/confirm/9"],
  ["a preferences link", "https://n.example.com/manage?key=1"],
  ["a long but WORD-shaped tail", "https://n.example.com/confirm/confirmation-page"],
  ["an invitation page", "https://x.example.com/invite"],
];

/* Every token-bearing URL in this file is the subject, so its tokens keep their shape: each is derived from its
 * tag at run time, at a reserved host, and "the assembled tokens" below asserts every one whole. */
const hexGroups = (tag: string, ...lengths: number[]): string => {
  const hex = hex64(tag);
  let at = 0;
  return lengths.map((n) => hex.slice(at, (at += n))).join("-");
};
const base64Url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const MAGIC_TOKEN = hex64("auth-url-magic-link").slice(0, 32);
const JWT_HEADER = base64Url({ alg: "HS256", typ: "JWT" });
const RESET_TAIL = opaqueRun("auth-url-reset", 20);
const LOGIN_TOKEN = opaqueRun("auth-url-login-token", 20);
const HREF_TOKEN = hex64("auth-url-href").slice(0, 24);

/** A marker AND an opaque token. These are credentials in URL form and must stay withheld. */
const MARKER_WITH_TOKEN: Array<[string, string]> = [
  ["a magic link with a 32-character token", `https://app.example.com/verify?token=${MAGIC_TOKEN}`],
  ["a JWT under /auth", `https://app.example.com/auth/${JWT_HEADER}`],
  ["a password reset with an opaque tail", `https://acct.example.com/reset/${RESET_TAIL}`],
  ["an explicit login_token parameter", `https://example.com/x?login_token=${LOGIN_TOKEN}`],
];

describe("an authentication marker WITHOUT a token is a page, not a credential", () => {
  for (const [label, url] of MARKER_WITHOUT_TOKEN) {
    it(`${label} leaves an ordinary newsletter available to the model`, () => {
      const body = `${PROSE} ${url}`;
      const v = classifySensitivity(msg("Newsletter", body));
      // The message-level flag: this is what `aiEligible` reads in the Screener, and what stood
      // between the reported four senders and any suggestion at all.
      expect(v.flags.no_ai).toBe(false);
      expect(v.reasons).not.toContain("auth_url_token");
      // The sink: a payload the Screener assembles from a stored row is screened again on the way
      // out, so a fix that only cleared the flag would still refuse to send.
      expect(screenOutboundText("Newsletter", body).safe).toBe(true);
    });
  }

  it("reaches through an href, where a marketing template hides its buttons", () => {
    // `visibleTextFromHtml` collects href values, so an invisible "Log in" button used to be
    // enough on its own. It must not be enough now, and must still not be MISSED when tokenised.
    const plain = classifySensitivity(
      msg("Newsletter", PROSE, `<p>${PROSE}</p><a href="https://mail.example.com/c/confirm/9">View</a>`),
    );
    expect(plain.flags.no_ai).toBe(false);

    const tokenised = classifySensitivity(
      msg("Newsletter", PROSE,
        `<p>${PROSE}</p><a href="https://mail.example.com/verify?token=${HREF_TOKEN}">Confirm</a>`),
    );
    expect(tokenised.flags.no_ai).toBe(true);
  });
});

describe("an authentication marker WITH a token is still refused at both ends", () => {
  for (const [label, url] of MARKER_WITH_TOKEN) {
    it(`${label} is withheld from the model and refused at the sink`, () => {
      const body = `${PROSE} ${url}`;
      const v = classifySensitivity(msg("Newsletter", body));
      expect(v.flags.no_ai).toBe(true);
      expect(v.reasons).toContain("auth_url_token");

      const screen = screenOutboundText("Newsletter", body);
      expect(screen.safe).toBe(false);
      expect(screen.reason).toBe("auth_url_token");
    });
  }
});

/**
 * ── A LINK IN A DOCUMENT IS NOT A CREDENTIAL DELIVERED ───────────────────────────────────────
 *
 * The token search over the whole body meant that any authentication-shaped URL anywhere in a
 * message routed it to the fail-closed bucket. Measured over the two live mailboxes: many messages
 * were withheld indeterminate on an auth-URL match and most of them carried no credential the reader
 * could act on — a link to a LOGIN PAGE, a UTILITY endpoint (unsubscribe / attachment / archive
 * derefer / app notification-settings / avatar), or a URL quoted from an earlier reply. The
 * classify arm now keeps only credential DELIVERIES; the SINK is unchanged, so nothing about what
 * reaches a model moves. Fixtures below are the real shapes, with the identifying tokens replaced
 * but the structure kept.
 *
 * Enough prose that a message is a DOCUMENT, not a bare link — {@link classifySensitivity}'s
 * `lowProse` gate is false here, which is the whole point: a login/utility link in a document is
 * incidental, the same link as the only content is a delivery (see the bare-bearer case).
 */
const DOC =
  "Thank you for your order. Your items are on their way and should arrive within a few business "
  + "days. Below you will find a summary of everything you purchased, the amount charged, and where "
  + "to reach us if anything is not quite right. We appreciate your business and hope to see you "
  + "again soon at our shop for more of the things you love the most this season.";

const BILLING_SESSION = opaqueRun("auth-url-billing-session", 18);
const TICKET_TRACKING = hex64("auth-url-ticket-tracking").slice(0, 19);
const PREFERENCES_TOKEN = base64Url({ action: "unsubscribe" });
const ATTACHMENT_TOKEN = opaqueRun("auth-url-attachment", 25);
const NOTIFICATION_KEY = hex64("auth-url-notification-key").slice(0, 20);
const AVATAR_KEY = hex64("auth-url-avatar-key").slice(0, 21);
const UNSUB_TOKEN = hexGroups("auth-url-unsubscribe", 8, 4, 4, 4, 4);
const DEREFER_TOKEN = hexGroups("auth-url-derefer", 8, 4, 4, 4, 6);
const QUOTED_DEREFER_TOKEN = hexGroups("auth-url-quoted-derefer", 8, 4, 4, 4, 4);
const SET_PASSWORD_TOKEN = opaqueRun("auth-url-set-password", 24);
const VERIFY_CODE = hex64("auth-url-verify-code").slice(0, 30);
const ACTIVATION_KEY = hexGroups("auth-url-activation-key", 8, 4, 4, 4, 12);
const MAGIC_LOGIN_TOKEN = hex64("auth-url-magic-login").slice(0, 26);

/** The FALSE-POSITIVE classes. Each carries a real ≥16 opaque run, and none is a credential. */
const NOT_A_CREDENTIAL: Array<[string, string]> = [
  ["a login PAGE with a session id", `https://billing.payments.example/p/login/${BILLING_SESSION}?referer=invoice_receipt`],
  ["a login PAGE with a tracking param", `https://www.tickets.example/login?t=${TICKET_TRACKING}&errordoc=globalError`],
  ["a login PAGE with a campaign param", "https://www.notes.example/login?target=plans&utm_campaign=2026-01-01+Upgrade+Campaign"],
  ["a newsletter unsubscribe token", `https://hosting.example/en/newsletter/unsubscribe/?email=x@y.invalid&token=${UNSUB_TOKEN}`],
  ["a mailing-preferences token", `https://home-service.example/de/mailing_preferences?token=${PREFERENCES_TOKEN}`],
  ["an attachment access token", `https://helpdesk.example/attachments/token/${ATTACHMENT_TOKEN}/?name=logo.jpg`],
  ["a mail-archive derefer wrapper", `https://mailstore.example.com:8462/a/outlook/derefer/?url=http%3a%2f%2fx.invalid&token=${DEREFER_TOKEN}`],
  ["an app notification-settings link", `https://app.tasks.example/-/confirm_change_notification_category_setting?domain=fixture&key=${NOTIFICATION_KEY}`],
  ["an app avatar image url", `https://app.tasks.example/-/domain_user_profile_photo?size=60x60&domain=fixture&key=${AVATAR_KEY}`],
];

describe("an auth-shaped URL that is a PAGE or UTILITY link in a document is not a credential", () => {
  for (const [label, url] of NOT_A_CREDENTIAL) {
    it(`${label} leaves the message available to the model`, () => {
      const v = classifySensitivity(msg("Your order", `${DOC} ${url}`));
      expect(v.flags.no_ai).toBe(false);
      expect(v.reasons).not.toContain("auth_url_token");
    });
  }

  it("the reported case: a token-bearing URL quoted below a reply header does not fire", () => {
    // The German WordPress-security thread ("Re: AW: AW: AW: Webshop"). The reply itself carries
    // no credential; the firing URL is pasted into the quoted history, below a reply header.
    const body = [
      "Ich finde deine Idee mit dem Rollen-Guard gut. Endkunden werden vom Login-Captcha ohnehin",
      "nicht gestört, und das Captcha erscheint erst nach fünf fehlgeschlagenen Versuchen. Passt das",
      "auch für dich? Den Rollen-Guard bespreche ich TrafficFlow-intern und melde mich dann wieder.",
      "",
      "> *Von: *Fixture Sender <fixture.sender@shop.example>",
      "> *Betreff: *WG: Webshop",
      ">",
      "> Bitte einmal hier bestätigen:",
      `> https://mailstore.shop.example:8462/a/outlook/derefer/?url=x&token=${QUOTED_DEREFER_TOKEN}`,
    ].join("\n");
    const v = classifySensitivity(msg("Re: AW: AW: AW: Webshop", body));
    expect(v.flags.no_ai).toBe(false);
    expect(v.reasons).not.toContain("auth_url_token");
  });
});

/**
 * The GENUINE twins — the same shapes, but the token IS the credential. Every one must STAY
 * withheld: this is the boundary the gate must not weaken. `DOC`-length prose is deliberate, to
 * prove they fire on delivery evidence and not on being short.
 */
const IS_A_CREDENTIAL: Array<[string, string]> = [
  ["a password reset in a long email", `https://acct.example.com/reset/${RESET_TAIL}`],
  ["an email verify path in a long email", `https://secure.example.org/de/signup/verify/code/${VERIFY_CODE}`],
  ["an account activation key in a long email", `https://members.example.org/activate.php?key=${ACTIVATION_KEY}`],
  ["a set-password token in a long email", `https://shop.example.org/customer/account/createPassword/?id=485&token=${SET_PASSWORD_TOKEN}`],
];

describe("the assembled tokens", () => {
  it("are whole, each in its own shape, so a case above cannot pass on an empty one", () => {
    for (const t of [UNSUB_TOKEN, DEREFER_TOKEN, QUOTED_DEREFER_TOKEN]) {
      expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4,6}$/);
    }
    expect(ACTIVATION_KEY).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // Each run is long enough and carries a digit or a capital, the two things a token needs to read as one.
    const runs: Array<[string, RegExp]> = [
      [MAGIC_TOKEN, /^[0-9a-f]{32}$/], [HREF_TOKEN, /^[0-9a-f]{24}$/], [TICKET_TRACKING, /^[0-9a-f]{19}$/],
      [NOTIFICATION_KEY, /^[0-9a-f]{20}$/], [AVATAR_KEY, /^[0-9a-f]{21}$/], [VERIFY_CODE, /^[0-9a-f]{30}$/],
      [MAGIC_LOGIN_TOKEN, /^[0-9a-f]{26}$/], [RESET_TAIL, /^[A-Za-z0-9]{20}$/], [LOGIN_TOKEN, /^[A-Za-z0-9]{20}$/],
      [BILLING_SESSION, /^[A-Za-z0-9]{18}$/], [ATTACHMENT_TOKEN, /^[A-Za-z0-9]{25}$/], [SET_PASSWORD_TOKEN, /^[A-Za-z0-9]{24}$/],
    ];
    for (const [run, shape] of runs) {
      expect(run).toMatch(shape);
      expect(run).toMatch(/[\dA-Z]/);
    }
    expect(JSON.parse(Buffer.from(JWT_HEADER, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(PREFERENCES_TOKEN).toMatch(/^eyJ[A-Za-z0-9_-]{29}$/);
  });
});

describe("a genuine credential-delivery URL stays withheld even inside a long document", () => {
  for (const [label, url] of IS_A_CREDENTIAL) {
    it(`${label} is withheld from the model and refused at the sink`, () => {
      const body = `${DOC} ${url}`;
      const v = classifySensitivity(msg("Your account", body));
      expect(v.flags.no_ai).toBe(true);
      expect(v.reasons).toContain("auth_url_token");
      expect(screenOutboundText("Your account", body).safe).toBe(false);
    });
  }

  it("a bare magic/bearer link IS the message, so a short body keeps it withheld", () => {
    // Mirrors the fail-closed corpus's `/session?t=SECRET-LOGIN-TOKEN` bearer case: a login-PAGE
    // marker and a tracking param, which in a DOCUMENT would be a page — but with the link as the
    // whole message it is a delivery, caught by the low-prose gate. Neutral lead prose only: any
    // authentication vocabulary here would categorise the message and shadow the arm under test.
    const body = "The link you asked for: https://accounts.example.com/session?t=SECRET-LOGIN-TOKEN99";
    const v = classifySensitivity(msg("Atlas", body));
    expect(v.flags.no_ai).toBe(true);
    expect(v.reasons).toContain("auth_url_token");
  });

  it("a magic-login link carrying a credential-NAMED token fires even in a document", () => {
    const body = `${DOC} https://app.example.com/login?token=${MAGIC_LOGIN_TOKEN}`;
    const v = classifySensitivity(msg("Sign in", body));
    expect(v.flags.no_ai).toBe(true);
    expect(v.reasons).toContain("auth_url_token");
  });
});
