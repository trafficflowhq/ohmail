import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  renderTemplate, safeUrl, esc, TEMPLATE_NAMES,
  type TemplateDataMap, type TemplateName, type WaitlistTier,
} from "../src/index.js";

/**
 * The template gate.
 *
 * Three things are asserted here and each one is a rule the product cannot break:
 *  1. Snapshots of subject + text + html for all FIVE templates. Copy that reaches a
 *     stranger's inbox does not change by accident.
 *  2. The HTML loads NOTHING remote. ohmail strips tracking pixels out of other
 *     people's mail (`privacy-service.ts`); a remote image, webfont or stylesheet in
 *     our own would be the same beacon with our name on it.
 *  3. Every interpolation is escaped and every URL is scheme-checked.
 */

const FIXTURES: { [K in TemplateName]: TemplateDataMap[K] } = {
  waitlist_confirmation: {
    tier: "plus",
    siteUrl: "https://ohmail.app",
    supportEmail: "support@ohmail.app",
  },
  invite: {
    code: "OHMAIL-7QR4-2K9F",
    redeemUrl: "https://app.ohmail.app/join?code=OHMAIL-7QR4-2K9F",
    expiresAt: "8 August 2026, 09:05 UTC",
    supportEmail: "support@ohmail.app",
  },
  new_device_signin: {
    device: "Web",
    ip: "203.0.113.24",
    at: "1 August 2026, 09:05 UTC",
    devicesUrl: "https://app.ohmail.app/settings/devices",
    supportEmail: "support@ohmail.app",
  },
  email_verification: {
    verifyUrl: "https://app.ohmail.app/verify-email?token=Zm9vYmFyLXRva2Vu",
    expiresIn: "24 hours",
    supportEmail: "support@ohmail.app",
  },
  // The ONE template here that is not customer mail: it goes to the configured
  // operator address and carries counts and ages produced by the alert evaluator.
  operator_alert: {
    environment: "production",
    source: "api",
    alerts: [
      {
        title: "Sync worker (shard 0) is not running",
        detail: "Last leader heartbeat from wkr-7c41 was 6m ago (threshold 2m). No mailbox is syncing.",
        severity: "critical",
      },
      {
        title: "2 Stripe webhook events failed to apply",
        detail: "the oldest arrived 19h ago; a paid invoice whose apply failed grants no credits",
        severity: "critical",
      },
    ],
    consoleUrl: "https://admin.ohmail.app",
  },
  // The operator's daily summary: incident keys, kinds, titles and timestamps, no detail.
  operator_digest: {
    environment: "production",
    digest: {
      since: "2026-08-20T09:05:00.000Z",
      more: 2,
      lines: [
        {
          key: "sends_stuck", kind: "sends_stuck", severity: "critical", title: "1 send stuck",
          openedAt: "2026-08-21T07:40:00.000Z", resolvedAt: null,
        },
        {
          key: "imap_admission_refused", kind: "imap_admission_refused", severity: "warning", title: null,
          openedAt: "2026-08-20T22:10:00.000Z", resolvedAt: "2026-08-20T23:30:00.000Z",
        },
      ],
    },
    consoleUrl: "https://admin.ohmail.app",
  },
  // The mail that carries the "you already have an account" news that `POST /auth/register`
  // stopped putting in its response. It is the only template with NO credential in it at all —
  // nothing was created and nothing was proven, so there is nothing to mint — which is why the
  // fixture has no token, no code and no query string to get wrong.
  account_exists: {
    signInUrl: "https://ohmail.app/login",
    supportEmail: "support@ohmail.app",
  },
  // The wall's notice family (cloud 0040). One fixture drives the closed-set and remote-resource
  // sweeps like every sibling; the per-kind and per-locale copy is rendered in its own describe
  // below, because a fixture can only pin one member of a closed union at a time.
  // The sign-in throttle's notices (`drainSecurityNotices`): a closed kind, a time and config.
  security_notice: {
    kind: "factor_refused",
    at: "26 September 2026, 12:00 UTC",
    devicesUrl: "https://ohmail.app/settings/devices",
    supportEmail: "support@ohmail.app",
  },
  lifecycle_notice: {
    kind: "closed",
    locale: "en",
    anchorDate: "16 September 2026, 00:00 UTC",
    erasureDate: "16 October 2026, 00:00 UTC",
    accountUrl: "https://app.ohmail.app/settings/account",
    setupUrl: "https://app.ohmail.app/login?next=join",
    noMailbox: false,
    supportEmail: "support@ohmail.app",
  },
  // The billing link a staff member sends: a language, the app's own billing door, the support
  // address. No recipient (that is the envelope), no account id, no token.
  billing_link: {
    locale: "en",
    billingUrl: "https://ohmail.app/account/manage",
    supportEmail: "support@ohmail.app",
  },
};

const ALL = TEMPLATE_NAMES;

/** Hosts a rendered mail is allowed to LINK to. Anything else is a leak or a typo.
 *  `admin.ohmail.app` is the staff console — reachable ONLY from `operator_alert` and
 *  `operator_digest`, which no customer ever receives. */
const ALLOWED_HOSTS = new Set(["ohmail.app", "app.ohmail.app", "admin.ohmail.app", "localhost"]);

describe("templates — the set is closed and complete", () => {
  it("is exactly the ten templates — eight customer mails and two operator mails", () => {
    expect(ALL).toEqual([
      "waitlist_confirmation", "invite", "new_device_signin",
      // The sign-in throttle's notices, argued at the definition: a closed kind, a time and the
      // support address — no caller prose, no link (there is no password rotation to point at).
      "security_notice",
      "email_verification",
      // Added deliberately and argued for in `templates.ts`: the pager needs a second
      // delivery path that shares no infrastructure with the webhook, and the closed-set
      // guarantee (no free-form body can become outbound mail) is untouched by it.
      "operator_alert",
      // The pager's daily summary, argued at its definition: the operator address only, and
      // what a resolve mail already printed (keys, kinds, titles, timestamps).
      "operator_digest",
      // Also argued at its definition. This one is LOAD-BEARING for a security property
      // rather than a convenience: `POST /auth/register`'s public path answers a constant 202
      // for every address, so "you already have an account, sign in instead" has nowhere to be
      // said except in the inbox of the person it is about.
      "account_exists",
      // Cloud 0040, the wall. Three notices in one entry (a closed `kind` union), argued at its
      // definition: the data is dates, closed words and configuration — no caller prose — and
      // the copy follows the account's locale because these reach people who stopped paying
      // attention. No price and no plan name; a census below pins that.
      "lifecycle_notice",
      // The one mail staff send by hand (`POST /admin/accounts/:id/billing-link`): a language,
      // the app's billing door and the support address; capped per account by the route.
      "billing_link",
    ]);
  });

  it("the closed-set guarantee still holds: no template can carry a free-form body", () => {
    // The reason "closed" survives two additions. What was ever promised is that no data shape in
    // this registry can express arbitrary text destined for a stranger's inbox — not that the
    // count never changes. Every field of every fixture is either a first-party URL, a
    // deployment-config string, a credential we minted, or an enum; none is a caller's prose.
    //
    // `operator_alert.alerts[].detail` is the closest thing to free text in the set and it is not
    // an exception: it is produced by `packages/db/src/alerts.ts` from counts and ages, it goes
    // ONLY to the configured operator address (`sendOperatorAlert` refuses any other recipient),
    // and it reaches no customer. Asserted rather than trusted, so a template added later that
    // takes a `message` or `body` field has to break this line to ship.
    const FORBIDDEN = /^(body|message|text|html|content|note|comment|subject)$/i;
    for (const name of ALL) {
      const fixture = FIXTURES[name] as Record<string, unknown>;
      for (const key of Object.keys(fixture)) {
        expect(FORBIDDEN.test(key), `${name}.${key} looks like a free-form body field`).toBe(false);
      }
    }
  });

  it("ONLY the operator mails may name the staff console — no customer mail links there", () => {
    for (const name of ALL) {
      const { html, text } = renderTemplate(name, FIXTURES[name] as never);
      const linksToAdmin = html.includes("admin.ohmail.app") || text.includes("admin.ohmail.app");
      expect(linksToAdmin, `${name} must not link to the staff console`)
        .toBe(name === "operator_alert" || name === "operator_digest");
    }
  });

  it("every template renders a non-empty subject, text and html", () => {
    for (const name of ALL) {
      const out = renderTemplate(name, FIXTURES[name] as never);
      expect(out.subject.length, name).toBeGreaterThan(8);
      expect(out.text.length, name).toBeGreaterThan(120);
      expect(out.html.length, name).toBeGreaterThan(400);
      // The subject line must name the product — it is what the recipient sees first.
      expect(out.subject, name).toMatch(/ohmail/);
      // And it must name it the way the brand is written. The product is
      // "ohmail", lower-case, everywhere a human reads it; a subject line is
      // the most-read surface there is, so the old casing is pinned out of
      // the subject, the body and the HTML rather than merely snapshotted.
      for (const part of [out.subject, out.text, out.html])
        expect(part, name).not.toMatch(/OhMail|Ohmail/);
    }
  });
});

describe("templates — snapshots", () => {
  for (const name of ALL) {
    it(`${name} subject/text/html is unchanged`, () => {
      const out = renderTemplate(name, FIXTURES[name] as never);
      expect(out.subject).toMatchSnapshot(`${name}.subject`);
      expect(out.text).toMatchSnapshot(`${name}.text`);
      expect(out.html).toMatchSnapshot(`${name}.html`);
      expect(out.headers ?? null).toMatchSnapshot(`${name}.headers`);
    });
  }

  it("the waitlist confirmation is the only one carrying List-Unsubscribe", () => {
    const withHeaders = ALL.filter((n) => renderTemplate(n, FIXTURES[n] as never).headers != null);
    expect(withHeaders).toEqual(["waitlist_confirmation"]);
    const h = renderTemplate("waitlist_confirmation", FIXTURES.waitlist_confirmation).headers!;
    expect(h["List-Unsubscribe"]).toBe(
      "<mailto:support@ohmail.app?subject=Remove%20me%20from%20the%20ohmail%20waitlist>",
    );
  });

  it("every waitlist tier renders its own label", () => {
    const tiers: WaitlistTier[] = ["desktop", "solo", "plus", "pro", "undecided"];
    const labels = tiers.map((tier) =>
      renderTemplate("waitlist_confirmation", { ...FIXTURES.waitlist_confirmation, tier }).text
        .split("\n").find((l) => l.startsWith("You leaned toward")));
    expect(labels).toMatchSnapshot("waitlist tier labels");
    expect(new Set(labels).size).toBe(tiers.length);
  });
});

describe("templates — no remote resource, in any template", () => {
  /**
   * Tags/attributes a mail client fetches WITHOUT the reader doing anything.
   *
   * A regex list is a denylist, and a denylist is only ever as good as its author's
   * imagination — an independent review pointed out this one missed SVG `<image href>`
   * and `<meta http-equiv="refresh">`. Both are added, but the real answer is the
   * PARSED allow-list below: a denylist says "not these", an allow-list says "only
   * these", and only the second one is still correct against a tag nobody has thought
   * of yet. The regexes stay because they are fast, they read as documentation, and the
   * adversarial control at the end of this block keeps them honest.
   */
  const AUTOLOAD = [
    /<img\b/i, /<script\b/i, /<iframe\b/i, /<link\b/i, /<video\b/i, /<audio\b/i,
    /<object\b/i, /<embed\b/i, /<svg\b/i, /<image\b/i, /<use\b/i, /<input\b/i,
    /\bsrc\s*=/i, /\bsrcset\s*=/i, /\bbackground\s*=/i, /\bposter\s*=/i,
    /\bxlink:href/i, /\bformaction\s*=/i, /\bhttp-equiv/i,
    /\burl\s*\(/i, /@import/i, /<style\b/i,
  ];

  /** Every element an ohmail template is allowed to emit. Anything else fails. */
  const ALLOWED_ELEMENTS = new Set([
    "html", "head", "meta", "title", "body",
    "table", "tbody", "tr", "td", "a", "p", "h1", "span", "strong", "br",
  ]);

  /** Every attribute those elements are allowed to carry. `src` is deliberately absent. */
  const ALLOWED_ATTRS = new Set([
    "lang", "charset", "name", "content", "style", "href",
    "role", "width", "cellpadding", "cellspacing", "border", "align",
  ]);

  for (const name of ALL) {
    it(`${name} html auto-loads nothing`, () => {
      const { html } = renderTemplate(name, FIXTURES[name] as never);
      for (const pattern of AUTOLOAD) {
        expect(pattern.test(html), `${name} html matched ${pattern}`).toBe(false);
      }
    });

    it(`${name} html links only to first-party hosts, and only from href`, () => {
      const { html } = renderTemplate(name, FIXTURES[name] as never);
      // Every http(s) URL anywhere in the document — href, visible link text, anything.
      const all = html.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
      expect(all.length, `${name}: rendered no link at all`).toBeGreaterThan(0);
      for (const raw of all) {
        expect(ALLOWED_HOSTS.has(new URL(raw).hostname), `${name}: foreign host ${raw}`).toBe(true);
      }
      // …and the ONLY attribute a URL is ever the value of is `href`. `src`,
      // `background`, `poster`, `data-*` — any of those would be a fetch on render.
      const attrs = [...html.matchAll(/([a-zA-Z][\w-]*)\s*=\s*"[^"]*https?:\/\//g)]
        .map((m) => m[1]!.toLowerCase());
      expect(new Set(attrs), `${name}: URL in a non-href attribute`).toEqual(new Set(["href"]));
    });

    it(`${name} text part is plain — no markup, and its links are first-party`, () => {
      const { text } = renderTemplate(name, FIXTURES[name] as never);
      expect(text).not.toMatch(/<[a-z!/]/i);
      for (const raw of text.match(/https?:\/\/[^\s]+/g) ?? []) {
        expect(ALLOWED_HOSTS.has(new URL(raw).hostname), `${name}: foreign host ${raw}`).toBe(true);
      }
    });
  }

  for (const name of ALL) {
    it(`${name} html contains ONLY allow-listed elements and attributes`, () => {
      const { html } = renderTemplate(name, FIXTURES[name] as never);
      const doc = new JSDOM(html).window.document;
      const elements = new Set<string>();
      const attrs = new Set<string>();
      for (const el of doc.querySelectorAll("*")) {
        elements.add(el.tagName.toLowerCase());
        for (const a of el.getAttributeNames()) attrs.add(a.toLowerCase());
      }
      const badElements = [...elements].filter((e) => !ALLOWED_ELEMENTS.has(e));
      const badAttrs = [...attrs].filter((a) => !ALLOWED_ATTRS.has(a));
      expect(badElements, `${name}: element outside the allow-list`).toEqual([]);
      expect(badAttrs, `${name}: attribute outside the allow-list`).toEqual([]);
      // The parsed form of the same rule as the regexes: no element in the DOM has a
      // property the client would dereference before the reader clicks anything.
      for (const el of doc.querySelectorAll("*")) {
        for (const a of el.getAttributeNames()) {
          expect(["src", "srcset", "poster", "background", "data", "formaction", "xlink:href"])
            .not.toContain(a.toLowerCase());
        }
      }
      // Every href goes to a first-party origin or to a mailbox — nothing else.
      for (const a of doc.querySelectorAll("a")) {
        const href = a.getAttribute("href")!;
        if (href.startsWith("mailto:")) continue;
        expect(ALLOWED_HOSTS.has(new URL(href).hostname), `${name}: href ${href}`).toBe(true);
      }
    });
  }

  it("the guards bite: a template that embedded an image or an SVG would fail them", () => {
    // The adversarial control for the assertions above — if the matcher list and the
    // allow-list were wrong, these strings would pass and everything above is vacuous.
    // Each fragment is given the parse context it needs: a bare `<td>` outside a table
    // is discarded by the HTML parser, and a control the parser deletes proves nothing.
    for (const [hostile, doc0] of [
      [`<p><img src="https://tracker.example.com/o.gif" width="1"></p>`, "<body>%s</body>"],
      [`<p><svg><image href="https://tracker.example.com/o.gif"/></svg></p>`, "<body>%s</body>"],
      [`<meta http-equiv="refresh" content="0;url=https://tracker.example.com/">`, "<head>%s</head>"],
      [`<td background="https://tracker.example.com/bg.png"></td>`, "<body><table><tbody><tr>%s</tr></tbody></table></body>"],
    ] as const) {
      expect(AUTOLOAD.some((p) => p.test(hostile)), `regex list missed: ${hostile}`).toBe(true);

      const doc = new JSDOM(`<html>${doc0.replace("%s", hostile)}</html>`).window.document;
      const offending = [...doc.querySelectorAll("*")].some((el) =>
        !ALLOWED_ELEMENTS.has(el.tagName.toLowerCase()) ||
        el.getAttributeNames().some((a) => !ALLOWED_ATTRS.has(a.toLowerCase())));
      expect(offending, `allow-list missed: ${hostile}`).toBe(true);
    }
  });
});

describe("templates — escaping and URL validation", () => {
  it("escapes a hostile device label instead of rendering it", () => {
    const out = renderTemplate("new_device_signin", {
      ...FIXTURES.new_device_signin,
      device: `"><script>alert(1)</script>`,
      ip: `<b>1.2.3.4</b>`,
    });
    expect(out.html).not.toMatch(/<script>/);
    expect(out.html).toContain("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out.html).toContain("&lt;b&gt;1.2.3.4&lt;/b&gt;");
  });

  it("esc covers the five characters that matter", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  it("safeUrl refuses every scheme that is not https (localhost http excepted)", () => {
    expect(safeUrl("https://app.ohmail.app/join")).toBe("https://app.ohmail.app/join");
    expect(safeUrl("http://localhost:3000/join")).toBe("http://localhost:3000/join");
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "http://app.ohmail.app/join",
      "/relative/path",
      "not a url",
    ]) {
      expect(() => safeUrl(bad), bad).toThrow();
    }
  });

  it("a template handed a javascript: url throws rather than rendering it", () => {
    expect(() => renderTemplate("invite", {
      ...FIXTURES.invite, redeemUrl: "javascript:alert(1)",
    })).toThrow(/non-https/);
  });

  it("safeUrl NEVER puts the rejected URL in the message it throws", () => {
    // The defect: `safeUrl` embedded the whole URL, `MailerPort.send` wrapped that as
    // `render_failed: …`, and `resend-mailer.ts` documents that value as log-destined.
    // Two of these URLs carry a live credential in their query string, and the token row
    // is inserted BEFORE rendering — so a single malformed MAIL_APP_URL wrote a working
    // 24-hour verification token into application logs.
    const secret = "SUPER-SECRET-RAW-VERIFICATION-TOKEN-abcdefgh";
    const rejected = [
      `app.ohmail.app/verify-email?token=${secret}`,          // not absolute
      `/verify-email?token=${secret}`,                    // not absolute
      `javascript:alert("${secret}")`,                    // bad scheme
      `http://app.ohmail.app/join?code=${secret}`,            // bad scheme
      `${secret}:payload`,                                // the SCHEME is the secret
    ];
    for (const url of rejected) {
      let message = "";
      try { safeUrl(url); } catch (e) { message = (e as Error).message; }
      expect(message, `did not throw for ${url}`).not.toBe("");
      expect(message, `leaked the URL: ${message}`).not.toContain(secret);
      expect(message).not.toContain("verify-email");
      expect(message).not.toContain("token=");
    }
  });

  it("safeUrl's message is still useful — shape, not silence", () => {
    expect(() => safeUrl("not a url")).toThrow(/not an absolute URL \(9 chars\)/);
    expect(() => safeUrl("javascript:alert(1)")).toThrow(/non-https URL scheme "javascript:"/);
    // …but an unrecognised scheme is reported as `other`, never echoed.
    expect(() => safeUrl("SECRET-TOKEN-VALUE:x")).toThrow(/non-https URL scheme "other"/);
  });

  it("the invite makes no claim the invite mechanism cannot keep", () => {
    // `AuthService.register` checks a reusable in-memory `Set` — beta codes are global,
    // non-expiring and bound to nobody. The template must not tell a recipient otherwise:
    // "single-use and tied to this address" is exactly what somebody would rely on when
    // deciding whether forwarding the mail is harmless. Re-strengthen this copy only
    // together with the consumable invite rows (a recorded design decision).
    const { text, html } = renderTemplate("invite", FIXTURES.invite);
    for (const body of [text, html]) {
      expect(body).not.toMatch(/single-use/i);
      expect(body).not.toMatch(/tied to this address/i);
      expect(body).not.toMatch(/only you can/i);
      expect(body).not.toMatch(/reserved for your address/i);
    }
    // And it does give the advice that IS true under both mechanisms.
    expect(text).toMatch(/Keep it to yourself/);
  });

  it("never invites the reader to send a secret back", () => {
    // The sign-in notice is the one mail an attacker would want to imitate; it must
    // say so, and no template may ever ask for a code by mail (the "Sensitive mail" invariant).
    const notice = renderTemplate("new_device_signin", FIXTURES.new_device_signin);
    expect(notice.text).toContain("We will never ask you for a code, a password, or a recovery code by email.");
    for (const name of ALL) {
      const { text } = renderTemplate(name, FIXTURES[name] as never);
      expect(text, name).not.toMatch(/recovery code:/i);
      expect(text, name).not.toMatch(/your password is/i);
    }
  });
});

describe("the lifecycle notices — every kind, both locales, and no price anywhere", () => {
  const kinds = ["trial_two_days", "closed", "erasure_week"] as const;
  const locales = ["en", "de"] as const;

  it("renders every (kind, locale) pair with the mailbox-untouched promise and no price token", () => {
    for (const kind of kinds) {
      for (const locale of locales) {
        const rendered = renderTemplate("lifecycle_notice",
          { ...FIXTURES.lifecycle_notice, kind, locale });
        expect(rendered.subject.length, `${kind}/${locale} subject`).toBeGreaterThan(0);
        // The one promise every notice carries: the mailbox is not ours to touch.
        expect(rendered.text, `${kind}/${locale} must say the mailbox is untouched`)
          .toMatch(locale === "de" ? /Postfach bleibt unangetastet/ : /mailbox is untouched/i);
        // Nothing about price, plan or currency reaches a published string (owner rule).
        for (const needle of [/\$\s?\d/, /€/, /CHF/, /price/i, /Preis/i, /\bplan\b/i, /\/month/i]) {
          expect(rendered.text, `${kind}/${locale} text names a price`).not.toMatch(needle);
          expect(rendered.html, `${kind}/${locale} html names a price`).not.toMatch(needle);
        }
      }
    }
  });

  it("the closure without an erasure forecast drops the erasure sentence instead of a blank date", () => {
    const rendered = renderTemplate("lifecycle_notice", {
      ...FIXTURES.lifecycle_notice, kind: "closed", erasureDate: null,
    });
    expect(rendered.text).not.toMatch(/erased on|gelöscht/);
  });

  it("an account with no mailbox is never told ohmail organizes one; it is pointed at the mailbox step and replies reach support", () => {
    const { setupUrl, accountUrl } = FIXTURES.lifecycle_notice;
    for (const locale of locales) {
      for (const kind of ["trial_two_days", "closed"] as const) {
        const out = renderTemplate("lifecycle_notice", { ...FIXTURES.lifecycle_notice, kind, locale, noMailbox: true });
        const said = `${kind}/${locale}`;
        expect(out.text, said).not.toMatch(/organizing your mailbox|stopped organizing|weiter organisiert|organisiert und synchronisiert nicht mehr/);
        expect(out.text, said).toMatch(locale === "de" ? /kein Postfach verbunden/ : /no mailbox connected/);
        expect(out.text, said).toMatch(locale === "de" ? /Antworte einfach auf diese Mail/ : /reply to this mail/);
        expect(out.replyTo, said).toBe("support@ohmail.app");
        expect(out.html, said).toContain(`href="${kind === "closed" ? accountUrl : setupUrl}"`);
      }
      const trial = renderTemplate("lifecycle_notice", { ...FIXTURES.lifecycle_notice, kind: "trial_two_days", locale, noMailbox: true });
      expect(trial.text).toContain(setupUrl);
    }
  });

  it("offers the Microsoft sign-in for Microsoft 365 work or school mail only, and no notice names a personal Microsoft mailbox", () => {
    // Whether a personal Microsoft account (Outlook.com, Hotmail, Live) can sign in is not proven yet.
    const personal = /hotmail|outlook\.com|live\.com|\bmsn\b|(?<!connect )outlook(?! verbinden)/i;
    for (const locale of locales) {
      for (const kind of kinds) {
        for (const noMailbox of [true, false]) {
          const out = renderTemplate("lifecycle_notice", { ...FIXTURES.lifecycle_notice, kind, locale, noMailbox });
          expect(`${out.text}\n${out.html}`, `${kind}/${locale}/${noMailbox}`).not.toMatch(personal);
        }
      }
      const trial = renderTemplate("lifecycle_notice", { ...FIXTURES.lifecycle_notice, kind: "trial_two_days", locale, noMailbox: true });
      expect(trial.text).toMatch(locale === "de"
        ? /Microsoft-365-Postfach deiner Arbeit oder Schule, verbinde sie stattdessen unter Einstellungen → Postfächer mit „Outlook verbinden“/
        : /Microsoft 365 work or school account, connect it in Settings → Mailboxes with Connect Outlook instead/);
    }
  });

  it("an account with a mailbox keeps today's trial mail, its account link and the deployment's reply address", () => {
    for (const locale of locales) {
      const out = renderTemplate("lifecycle_notice", { ...FIXTURES.lifecycle_notice, kind: "trial_two_days", locale });
      expect(out.text).toMatch(locale === "de" ? /Damit ohmail dein Postfach weiter organisiert/ : /To keep ohmail organizing your mailbox/);
      expect(out.text).toContain(FIXTURES.lifecycle_notice.accountUrl);
      expect(out.text).not.toContain(FIXTURES.lifecycle_notice.setupUrl);
      expect(out.replyTo).toBeUndefined();
    }
  });

  it("the erasure week names the date the erasure keeps, not a plane's date already past", () => {
    for (const locale of ["en", "de"] as const) {
      const { text, html } = renderTemplate("lifecycle_notice", {
        ...FIXTURES.lifecycle_notice, kind: "erasure_week", locale,
      });
      for (const part of [text, html]) {
        expect(part, locale).toContain(FIXTURES.lifecycle_notice.erasureDate);
        expect(part, locale).not.toContain(FIXTURES.lifecycle_notice.anchorDate);
      }
    }
  });
});

describe("the billing link — the app's billing door, support's address, and nothing else", () => {
  const DOOR = FIXTURES.billing_link.billingUrl;
  const URL_RE = /https?:\/\/[^\s"'<>]+/g;
  const ADDRESS_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  for (const locale of ["en", "de"] as const) {
    it(`${locale}: links only to the billing door and names no address but support's, no id and no money word`, () => {
      const out = renderTemplate("billing_link", { ...FIXTURES.billing_link, locale });
      expect(out.text, `${locale}: the text part carries the door`).toContain(DOOR);
      expect(out.html).toContain(`lang="${locale}"`);
      for (const part of [out.subject, out.text, out.html]) {
        for (const url of part.match(URL_RE) ?? []) expect(url, `${locale}: another link`).toBe(DOOR);
        for (const a of part.match(ADDRESS_RE) ?? []) expect(a, `${locale}: another address`).toBe("support@ohmail.app");
        expect(part).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        expect(part).not.toMatch(/\b(cus|sub|in|ch|pi|price|prod|cs)_[A-Za-z0-9]{6,}/);
        // Nothing of payments, credits or the billing service: the copy says "billing page".
        for (const word of [/stripe/i, /\bplane\b/i, /credit/i, /payment|zahlung/i, /\bprice|preis/i,
          /invoice|\bRechnung/i, /\bcard\b|karte/i, /\$\s?\d|€|CHF/]) {
          expect(part, `${locale} names ${word}`).not.toMatch(word);
        }
      }
    });
  }

  it("German says Mail and Account, as the app does", () => {
    const { subject, text } = renderTemplate("billing_link", { ...FIXTURES.billing_link, locale: "de" });
    expect(text).toMatch(/\bMail\b/);
    for (const part of [subject, text]) expect(part).not.toMatch(/E-Mail|Konto|\bPost\b/);
    expect(subject).not.toBe(renderTemplate("billing_link", FIXTURES.billing_link).subject);
  });

  it("an unknown locale is English, and the data carries no recipient, id or free text", () => {
    const odd = renderTemplate("billing_link", { ...FIXTURES.billing_link, locale: "fr" as never });
    expect(odd.subject).toBe(renderTemplate("billing_link", FIXTURES.billing_link).subject);
    expect(Object.keys(FIXTURES.billing_link).sort()).toEqual(["billingUrl", "locale", "supportEmail"]);
  });

  it("refuses a door that is not https before anything renders", () => {
    expect(() => renderTemplate("billing_link", { ...FIXTURES.billing_link, billingUrl: "javascript:alert(1)" }))
      .toThrow(/non-https/);
  });
});
