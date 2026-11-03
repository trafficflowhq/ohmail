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

/** A marker AND an opaque token. These are credentials in URL form and must stay withheld. */
const MARKER_WITH_TOKEN: Array<[string, string]> = [
  ["a magic link with a 32-character token", "https://app.example.com/verify?token=8f3a9b2c1d4e5f6a7b8c9d0e1f2a3b4c"],
  ["a JWT under /auth", "https://app.example.com/auth/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"],
  ["a password reset with an opaque tail", "https://acct.example.com/reset/Ab3Kd9Xm2Pq7Rt5Vw8Zy"],
  ["an explicit login_token parameter", "https://example.com/x?login_token=QQ7h2Kd9Xm2Pq7Rt5Vw8"],
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
        `<p>${PROSE}</p><a href="https://mail.example.com/verify?token=8f3a9b2c1d4e5f6a7b8c9d0e">Confirm</a>`),
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

/* The token-bearing URLs below are the subject, so their tokens keep their shape: each is derived from its tag
 * at run time, and the case after the two tables asserts every one whole. */
const hexGroups = (tag: string, ...lengths: number[]): string => {
  const hex = hex64(tag);
  let at = 0;
  return lengths.map((n) => hex.slice(at, (at += n))).join("-");
};
const UNSUB_TOKEN = hexGroups("auth-url-unsubscribe", 8, 4, 4, 4, 4);
const DEREFER_TOKEN = hexGroups("auth-url-derefer", 8, 4, 4, 4, 6);
const QUOTED_DEREFER_TOKEN = hexGroups("auth-url-quoted-derefer", 8, 4, 4, 4, 4);
const SET_PASSWORD_TOKEN = opaqueRun("auth-url-set-password", 24);

/** The FALSE-POSITIVE classes. Each carries a real ≥16 opaque run, and none is a credential. */
const NOT_A_CREDENTIAL: Array<[string, string]> = [
  ["a login PAGE with a session id", "https://billing.stripe.com/p/login/aEUdRA5Wc8t25a03cc?referer=invoice_receipt"],
  ["a login PAGE with a tracking param", "https://www.ticketcorner.ch/login?t=94613046328576ee25c&errordoc=globalError"],
  ["a login PAGE with a campaign param", "https://www.notion.so/login?target=plans&utm_campaign=2022-06-08+Upgrade+Campaign"],
  ["a newsletter unsubscribe token", `https://contabo.com/en/newsletter/unsubscribe/?email=x@y.invalid&token=${UNSUB_TOKEN}`],
  ["a mailing-preferences token", "https://homeservice24.ch/de/mailing_preferences?token=eyJhY3Rpb24iOiJ1bnN1YnNjcmliZSJ9x"],
  ["an attachment access token", "https://digitec.zendesk.com/attachments/token/SLv7L4W1jDnK3ykv37wyAfpmL/?name=logo.jpg"],
  ["a mail-archive derefer wrapper", `https://mailstore.example.com:8462/a/outlook/derefer/?url=http%3a%2f%2fx.invalid&token=${DEREFER_TOKEN}`],
  ["an app notification-settings link", "https://app.asana.com/-/confirm_change_notification_category_setting?domain=1206300745632908&key=0fd6c555aa635b1c2d3e"],
  ["an app avatar image url", "https://app.asana.com/-/domain_user_profile_photo?size=60x60&domain=1206300745632908&key=ec155547570dfd11b7a1b"],
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
      "> *Von: *Niklaus Hari <niklaus.hari@kingnature.invalid>",
      "> *Betreff: *WG: Webshop",
      ">",
      "> Bitte einmal hier bestätigen:",
      `> https://mailstore.kingnature.invalid:8462/a/outlook/derefer/?url=x&token=${QUOTED_DEREFER_TOKEN}`,
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
  ["a password reset in a long email", "https://acct.example.com/reset/Ab3Kd9Xm2Pq7Rt5Vw8Zy"],
  ["an email verify path in a long email", "https://secure.example.org/de/signup/verify/code/a0f21a9ba125539be2d29b75572e28"],
  ["an account activation key in a long email", "https://cicero.example.org/activate.php?key=49b5ce27-9196-fabf-d2e6-479a5e41c442"],
  ["a set-password token in a long email", `https://shop.example.org/customer/account/createPassword/?id=485&token=${SET_PASSWORD_TOKEN}`],
];

describe("the assembled tokens", () => {
  it("are whole, each in its own shape, so a case above cannot pass on an empty one", () => {
    for (const t of [UNSUB_TOKEN, DEREFER_TOKEN, QUOTED_DEREFER_TOKEN]) {
      expect(t).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4,6}$/);
    }
    expect(SET_PASSWORD_TOKEN).toMatch(/^[A-Za-z0-9]{24}$/);
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
    const body = `${DOC} https://app.example.com/login?token=8f3a9b2c1d4e5f6a7b8c9d0e1f`;
    const v = classifySensitivity(msg("Sign in", body));
    expect(v.flags.no_ai).toBe(true);
    expect(v.reasons).toContain("auth_url_token");
  });
});
