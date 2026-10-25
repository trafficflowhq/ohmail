import { renderAlertMail, renderDigestMail, type AlertDigest } from "@trafficflow/db/cloud";

/**
 * The transactional templates. Plain TypeScript returning `{ subject, text, html }` — no template
 * engine: a handful of emails does not justify a dependency on the one path whose output lands in
 * other people's inboxes. Rules every template obeys, enforced by `mail-templates.test.ts`: (1)
 * NO REMOTE RESOURCE, ever — ohmail blocks tracking pixels as a product feature, and the wordmark
 * is TEXT. (2) Text AND html for every one — the text part is the real message, not a stub. (3)
 * Every interpolation is escaped (`esc`) and every URL validated (`safeUrl`), because template
 * data carries user-controlled strings. (4) Factual microcopy — receipts and security signals, no
 * slogans. English for beta, except the lifecycle notices and the billing link, which follow the
 * account's locale.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Escaping and URL validation — the two guards every template routes through.
// ─────────────────────────────────────────────────────────────────────────────

/** HTML-escape an interpolated value. Applied to EVERY `${}` inside an html string. */
export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Validate a URL destined for an `href`. Only `https:` passes (`http:` for `localhost`): a
 * `javascript:`/`data:` URL is stored XSS in the webmail clients that render our HTML. It throws
 * rather than falling back — a silently wrong link is worse than a mail never rendered, and
 * `MailerPort.send` catches the throw. THE THROWN MESSAGE MUST NOT CONTAIN THE URL: two of these
 * URLs carry a live credential in their query string, and the render failure's message goes to
 * logs — one malformed `MAIL_APP_URL` was enough to write a live verification token into
 * application logs. The message carries only non-secret SHAPE: the allow-list-matched scheme and
 * the length. `MailService`'s constructor validates `appUrl`/`siteUrl` at BOOT.
 */
export function safeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`mail template: not an absolute URL (${shapeOf(url)})`);
  }
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) {
    throw new Error(`mail template: refusing non-https URL scheme ${JSON.stringify(schemeOf(parsed))}`);
  }
  return parsed.toString();
}

/**
 * A description of a rejected URL that cannot carry a secret: its length, and nothing
 * else. `String(value.length)` is bounded, numeric, and useless to an attacker reading
 * a log; the value itself is not.
 */
function shapeOf(url: unknown): string {
  return `${typeof url === "string" ? url.length : 0} chars`;
}

/**
 * The scheme, but only if it is one we can name. `new URL("SECRET-TOKEN:x")` parses,
 * and its `protocol` would then be the secret — so anything outside the allow-list is
 * reported as `other`.
 */
const NAMEABLE_SCHEMES = new Set([
  "http:", "https:", "javascript:", "data:", "vbscript:", "file:", "ftp:",
  "mailto:", "tel:", "blob:", "about:", "ws:", "wss:",
]);

function schemeOf(parsed: URL): string {
  return NAMEABLE_SCHEMES.has(parsed.protocol) ? parsed.protocol : "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// The shared shell.
// ─────────────────────────────────────────────────────────────────────────────

/** The Blanc accent, resolved from `--accent: oklch(0.51 0.135 42)` — email clients have no oklch. */
const ACCENT = "#a3461c";
const INK = "#1e1a16";
const INK2 = "#5c534b";
const PAPER = "#ffffff";
const CANVAS = "#f7f5f3";
const LINE = "#e9e4de";

/**
 * A system font stack. Deliberately NOT the product's webfont: a webfont in mail is a
 * remote resource, which is rule 1. Every client falls back to something sane.
 */
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
  /**
   * Extra RFC5322 headers this template needs (currently only `List-Unsubscribe`
   * on the waitlist confirmation). The transport passes them through verbatim.
   */
  headers?: Record<string, string>;
  /** Where a reply goes when this mail asks for one; the transport's configured address otherwise. */
  replyTo?: string;
}

/**
 * The languages a mail can be written in. The signup's two mails take the signup screen's language
 * (`POST /auth/register`'s optional `locale`, a member of this set or English); the lifecycle notices
 * take the account's.
 */
export type MailLocale = "en" | "de";

export function mailLocaleOf(value: unknown): MailLocale | undefined {
  return value === "de" || value === "en" ? value : undefined;
}

interface ShellInput {
  /** The document's language; English when unset. */
  lang?: MailLocale;
  title: string;
  /** Paragraphs, already-escaped HTML fragments. */
  blocks: string[];
  /** The single primary action, if any. */
  action?: { label: string; url: string };
  /** Footer lines, already-escaped HTML fragments. */
  footer: string[];
}

function shell(input: ShellInput): string {
  const action = input.action
    ? `
          <tr><td style="padding:8px 28px 4px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${ACCENT};border-radius:10px;">
              <a href="${esc(safeUrl(input.action.url))}" style="display:inline-block;padding:12px 22px;font:600 15px/1 ${FONT};color:#ffffff;text-decoration:none;">${esc(input.action.label)}</a>
            </td></tr></table>
          </td></tr>`
    : "";

  return `<!doctype html>
<html lang="${input.lang === "de" ? "de" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:${CANVAS};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${CANVAS};">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:${PAPER};border:1px solid ${LINE};border-radius:14px;">
      <tr><td style="padding:26px 28px 0;">
        <span style="font:600 22px/1 ${FONT};color:${INK};letter-spacing:-0.03em;">oh<span style="color:${ACCENT};">.</span></span>
      </td></tr>
      <tr><td style="padding:18px 28px 0;">
        <h1 style="margin:0;font:600 20px/1.35 ${FONT};color:${INK};letter-spacing:-0.01em;">${esc(input.title)}</h1>
      </td></tr>
      <tr><td style="padding:12px 28px 4px;font:400 15px/1.6 ${FONT};color:${INK2};">
${input.blocks.map((b) => `        <p style="margin:0 0 12px;">${b}</p>`).join("\n")}
      </td></tr>${action}
      <tr><td style="padding:20px 28px 26px;border-top:1px solid ${LINE};font:400 13px/1.6 ${FONT};color:${INK2};">
${input.footer.map((f) => `        <p style="margin:0 0 6px;">${f}</p>`).join("\n")}
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/** The plain-text counterpart of `shell` — same order, links on their own lines. */
function textShell(title: string, paragraphs: string[], footer: string[]): string {
  return [`oh. — ohmail`, "", title, "", ...paragraphs, "", "—", ...footer, ""].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Template 1 — waitlist confirmation.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors `SignupTier` in `apps/webapp/app/(marketing)/components/Signup.tsx`. The `waitlist` table owns the CHECK. */
export type WaitlistTier = "desktop" | "solo" | "plus" | "pro" | "undecided";

const TIER_LABEL: Record<WaitlistTier, string> = {
  desktop: "Desktop — free, and it stays free",
  solo: "Cloud Solo — $9/month",
  plus: "Cloud Plus — $15/month",
  pro: "Cloud Pro — $29/month",
  undecided: "Still deciding — that is fine, nothing is binding",
};

export interface WaitlistConfirmationData {
  /** What the signer picked on the landing form. */
  tier: WaitlistTier;
  /** The landing site, for the "while you wait" link. */
  siteUrl: string;
  /** A real mailbox a human reads — also the `List-Unsubscribe` target. */
  supportEmail: string;
}

function waitlistConfirmation(d: WaitlistConfirmationData): RenderedEmail {
  const site = safeUrl(d.siteUrl);
  const tier = TIER_LABEL[d.tier];
  const subject = "You're on the ohmail waitlist";
  return {
    subject,
    headers: {
      // RFC 8058 one-click needs a POST endpoint we do not have yet; the mailto form
      // is RFC 2369 and works in every client that shows an unsubscribe affordance.
      "List-Unsubscribe": `<mailto:${d.supportEmail}?subject=Remove%20me%20from%20the%20ohmail%20waitlist>`,
    },
    text: textShell(
      subject,
      [
        "We received your waitlist signup. This message confirms the address — nothing else is needed from you.",
        `You leaned toward: ${tier}.`,
        "When beta accounts open we send one more mail, with an invite code. That is the only other message you get from this list.",
        `What ohmail is, in the meantime: ${site}`,
      ],
      [
        `Not you, or changed your mind? Reply to ${d.supportEmail} and we delete the entry.`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    ),
    html: shell({
      title: subject,
      blocks: [
        "We received your waitlist signup. This message confirms the address — nothing else is needed from you.",
        `You leaned toward: <strong style="color:${INK};font-weight:600;">${esc(tier)}</strong>.`,
        "When beta accounts open we send one more mail, with an invite code. That is the only other message you get from this list.",
        `What ohmail is, in the meantime: <a href="${esc(site)}" style="color:${ACCENT};">${esc(site)}</a>`,
      ],
      footer: [
        `Not you, or changed your mind? Reply to <a href="mailto:${esc(d.supportEmail)}" style="color:${ACCENT};">${esc(d.supportEmail)}</a> and we delete the entry.`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template 2 — invite delivery (the code that opens the gate).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The copy here deliberately claims LESS than a well-built invite system would. This template
 * once asserted three properties the mechanism did not have: `register` checked codes against an
 * in-memory `Set`, so a code was reusable, global, non-expiring and bound to nobody — telling a
 * recipient it is "single-use and tied to this address" would have been a security claim the
 * system could not keep, exactly what they would rely on when deciding whether forwarding the
 * mail is safe. The line the template carries is true under BOTH mechanisms — the bootstrap `Set`
 * and the consumable, email-bound invite rows. Do not strengthen it; `mail-templates.test.ts`
 * asserts the absence of the claims mechanically.
 */
export interface InviteData {
  /** The beta code. Shown in full — it is not a secret to the holder of this inbox. */
  code: string;
  /** Where to redeem it (`https://app.ohmail.app/join?code=…` in production). */
  redeemUrl: string;
  /** Human-readable deadline, already formatted by the caller (UTC, no locale guessing). */
  expiresAt: string;
  supportEmail: string;
}

function invite(d: InviteData): RenderedEmail {
  const url = safeUrl(d.redeemUrl);
  const subject = "Your ohmail beta invite";
  return {
    subject,
    text: textShell(
      subject,
      [
        "Beta accounts are open and one is reserved for you.",
        `Your invite code: ${d.code}`,
        `Redeem it here: ${url}`,
        `The code stops working on ${d.expiresAt}. Keep it to yourself — anyone holding it can open an ohmail account.`,
        "You will be asked to set up a passkey (or an authenticator app) and to connect a mailbox you already own, which ohmail then organizes in place; nothing is copied into a new address.",
      ],
      [
        `Questions, or it will not work: ${d.supportEmail}`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    ),
    html: shell({
      title: subject,
      blocks: [
        "Beta accounts are open and one is reserved for you.",
        `Your invite code: <strong style="display:inline-block;padding:6px 10px;background:${CANVAS};border:1px solid ${LINE};border-radius:8px;font:600 16px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:${INK};letter-spacing:0.04em;">${esc(d.code)}</strong>`,
        `The code stops working on ${esc(d.expiresAt)}. Keep it to yourself — anyone holding it can open an ohmail account.`,
        "You will be asked to set up a passkey (or an authenticator app) and to connect a mailbox you already own, which ohmail then organizes in place; nothing is copied into a new address.",
      ],
      action: { label: "Redeem the invite", url },
      footer: [
        `If the button does not work, open <a href="${esc(url)}" style="color:${ACCENT};">${esc(url)}</a>`,
        `Questions, or it will not work: <a href="mailto:${esc(d.supportEmail)}" style="color:${ACCENT};">${esc(d.supportEmail)}</a>`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template 3 — new-device sign-in notice (the security signal).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Passkeys make a password-reset mail unnecessary, so this is the ONLY security
 * mail ohmail sends. It exists to make an unrecognised sign-in visible; it asks
 * for no action when the sign-in was the user's own.
 *
 * It deliberately contains **no link that changes state**. A "this was not me"
 * button in a mail is a phishing template with our branding on it; the recipient is
 * pointed at the app's own device list instead, which they reach the way they
 * always do.
 */
/**
 * A security notice (`AuthService.drainSecurityNotices`). The data carries a closed KIND and
 * nothing a caller wrote. It links to Settings → Devices and never to a password page: there is
 * no password rotation to send anybody to.
 */
export interface SecurityNoticeData {
  kind: "sign_in_slowed" | "factor_refused";
  at: string;
  devicesUrl: string;
  supportEmail: string;
}

function securityNotice(d: SecurityNoticeData): RenderedEmail {
  const url = safeUrl(d.devicesUrl);
  const slowed = d.kind === "sign_in_slowed";
  const subject = slowed
    ? "Failed sign-in attempts on your ohmail account"
    : "Your ohmail password was used and the second step failed";
  const lines = slowed
    ? [
        "Many attempts to sign in to your ohmail account failed in the last few minutes, from devices that had not signed in before. None of them had your password.",
        "Sign-in from new devices is slowed for a while. The devices you already use are not affected.",
        "If you are signing in from a new device, wait a few minutes and try again.",
        `The devices signed in to your account are listed in Settings → Devices (${url}).`,
      ]
    : [
        "Somebody signed in to your ohmail account with your password and then failed the second step several times.",
        "If that was you, there is nothing to do.",
        `If it was not, somebody knows your password and your second factor stopped them. Open ohmail yourself, check Settings → Devices (${url}), and write to ${d.supportEmail} so we can help you secure the account.`,
      ];
  const never = "We will never ask you for a code, a password, or a recovery code by email.";
  return {
    subject,
    text: textShell(subject, [...lines, `Time: ${d.at}`, never], [
      `Reach a human: ${d.supportEmail}`,
      "TrafficFlow GmbH, Zürich, Switzerland",
    ]),
    html: shell({
      title: subject,
      blocks: [
        ...lines.map((l) => esc(l).split(esc(url)).join(`<a href="${esc(url)}" style="color:${ACCENT};">${esc(url)}</a>`)),
        `<span style="color:${INK2};">Time</span> &nbsp;<strong style="color:${INK};font-weight:600;">${esc(d.at)}</strong>`,
        `<strong style="color:${INK};font-weight:600;">${never}</strong>`,
      ],
      footer: [
        `Reach a human: <a href="mailto:${esc(d.supportEmail)}" style="color:${ACCENT};">${esc(d.supportEmail)}</a>`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    }),
  };
}

export interface NewDeviceSignInData {
  /** `devices.label` — "Web", "ohmail for Mac", … Never trusted; escaped. */
  device: string;
  /** The client IP recorded on the device row, or "unknown". */
  ip: string;
  /** When, formatted by the caller as UTC. */
  at: string;
  /** Deep link to the app's device list — informational, changes nothing by itself. */
  devicesUrl: string;
  supportEmail: string;
}

function newDeviceSignIn(d: NewDeviceSignInData): RenderedEmail {
  const url = safeUrl(d.devicesUrl);
  const subject = "New sign-in to your ohmail account";
  return {
    subject,
    text: textShell(
      subject,
      [
        "A device that had not signed in before just signed in to your ohmail account.",
        `Device: ${d.device}`,
        `IP address: ${d.ip}`,
        `Time: ${d.at}`,
        "If that was you, there is nothing to do.",
        `If it was not, open ohmail, go to Settings → Devices (${url}), revoke that session, and replace your second factor. We will never ask you for a code, a password, or a recovery code by email.`,
      ],
      [
        `Reach a human: ${d.supportEmail}`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    ),
    html: shell({
      title: subject,
      blocks: [
        "A device that had not signed in before just signed in to your ohmail account.",
        [
          `<span style="color:${INK2};">Device</span> &nbsp;<strong style="color:${INK};font-weight:600;">${esc(d.device)}</strong><br>`,
          `<span style="color:${INK2};">IP address</span> &nbsp;<strong style="color:${INK};font-weight:600;">${esc(d.ip)}</strong><br>`,
          `<span style="color:${INK2};">Time</span> &nbsp;<strong style="color:${INK};font-weight:600;">${esc(d.at)}</strong>`,
        ].join(""),
        "If that was you, there is nothing to do.",
        `If it was not, open ohmail yourself and go to Settings → Devices (<a href="${esc(url)}" style="color:${ACCENT};">${esc(url)}</a>), revoke that session, and replace your second factor.`,
        `<strong style="color:${INK};font-weight:600;">We will never ask you for a code, a password, or a recovery code by email.</strong>`,
      ],
      footer: [
        `Reach a human: <a href="mailto:${esc(d.supportEmail)}" style="color:${ACCENT};">${esc(d.supportEmail)}</a>`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template 4 — email verification. BUILT, NOT WIRED (see mail-service.ts).
// ─────────────────────────────────────────────────────────────────────────────

export interface EmailVerificationData {
  /** `https://ohmail.app/verify-email?token=…` — the raw token; only its hash is stored. */
  verifyUrl: string;
  /** How long the link lives, in whole minutes, rendered as the caller wants it read. */
  expiresIn: string;
  supportEmail: string;
  /** The signup screen's language; English when unset. */
  locale?: MailLocale;
}

const VERIFY_COPY: Record<MailLocale, {
  subject: string; confirm: string; open: (url: string) => string; once: (expiresIn: string) => string;
  ifNotYou: string; action: string; noButton: string; human: string;
}> = {
  en: {
    subject: "Verify your email for ohmail",
    confirm: "Confirm this address to finish setting up your ohmail account.",
    open: (url) => `Open this link: ${url}`,
    once: (expiresIn) => `The link works once and expires in ${expiresIn}. You will be asked for the password you chose.`,
    ifNotYou: "If you did not start this, ignore this message. Without this link the account cannot " +
      "connect a mailbox and cannot be subscribed to anything.",
    action: "Verify this address",
    noButton: "If the button does not work, open",
    human: "Reach a human:",
  },
  de: {
    subject: "Bestätige deine E-Mail-Adresse für ohmail",
    confirm: "Bestätige diese Adresse, um die Einrichtung deines ohmail-Accounts abzuschließen.",
    open: (url) => `Öffne diesen Link: ${url}`,
    once: (expiresIn) => `Der Link funktioniert einmal und läuft in ${expiresIn} ab. Wir fragen dich nach dem Passwort, das du gewählt hast.`,
    ifNotYou: "Wenn du das nicht warst, ignoriere diese Nachricht. Ohne diesen Link kann der Account kein " +
      "Postfach verbinden und nichts abonnieren.",
    action: "Adresse bestätigen",
    noButton: "Falls der Button nicht funktioniert, öffne",
    human: "Einen Menschen erreichen:",
  },
};

/**
 * The "if this was not you" line changed, because it had become false. It read "no account is
 * created until the link is opened" — NOT true of the path that now sends it: `register` on the
 * open path creates the account rows and THEN mails this, because a constant response means the
 * mail is the only continuation. The replacement says what is enforced — by `withVerifiedEmail`,
 * not by this sentence: an unverified account cannot reach Checkout and cannot connect a mailbox.
 * It deliberately does NOT promise the row is deleted — nothing reaps unverified accounts today,
 * and a mail that invents a retention policy is how copy becomes a liability.
 */
function emailVerification(d: EmailVerificationData): RenderedEmail {
  const url = safeUrl(d.verifyUrl);
  const locale = mailLocaleOf(d.locale) ?? "en";
  const c = VERIFY_COPY[locale];
  const subject = c.subject;
  return {
    subject,
    text: textShell(
      subject,
      [c.confirm, c.open(url), c.once(d.expiresIn), c.ifNotYou],
      [
        `${c.human} ${d.supportEmail}`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    ),
    html: shell({
      lang: locale,
      title: subject,
      blocks: [esc(c.confirm), esc(c.once(d.expiresIn)), esc(c.ifNotYou)],
      action: { label: c.action, url },
      footer: [
        `${esc(c.noButton)} <a href="${esc(url)}" style="color:${ACCENT};">${esc(url)}</a>`,
        `${esc(c.human)} <a href="mailto:${esc(d.supportEmail)}" style="color:${ACCENT};">${esc(d.supportEmail)}</a>`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    }),
  };
}


/**
 * Template 5 — OPERATOR ALERT. Not a customer mail, and the closed set says adding one must be
 * defended, so: this template never goes to a customer — its recipient is a single configured
 * operator address (`sendOperatorAlert` refuses any other), it carries no user-controlled string,
 * and its content is counts and ages produced by `packages/db/src/alerts.ts`. It exists because a
 * pager built on a chat webhook alone has exactly one delivery path, and the one thing an
 * alerting system must not have is a single point of failure that is also the thing it watches —
 * mail is the second path, on infrastructure that shares nothing with the first. The closed-set
 * ARGUMENT is untouched: no free-form body, and this template's data shape cannot express one.
 */

export interface OperatorAlertData {
  /** `production` / `staging` — first word of the subject so nobody pages on staging. */
  environment: string;
  /** Which driver observed this: `worker` or `api`. */
  source: string;
  /** The firing conditions, already rendered to prose by `alerts.ts`. */
  alerts: Array<{ title: string; detail: string; severity: string }>;
  /** Where the operator goes next. First-party origin; `safeUrl` enforces https. */
  consoleUrl: string;
}

function operatorAlert(d: OperatorAlertData): RenderedEmail {
  // THE WORKER'S MAIL ARM SENDS THESE BYTES TOO: both drivers page from one `alert_state`, so
  // one renderer (`packages/db`) makes the mail, whichever driver won the claim.
  return renderAlertMail({
    alerts: d.alerts, environment: d.environment, source: d.source, consoleUrl: safeUrl(d.consoleUrl),
  });
}

/**
 * The operator's DAILY ALERT SUMMARY — `operator_alert`'s sibling, not customer mail: the configured
 * operator address, a digest of incident keys, kinds, titles and timestamps. Rendered by
 * `packages/db`, so the worker's mail arm and this one send the same bytes.
 */
export interface OperatorDigestData {
  environment: string;
  digest: AlertDigest;
  consoleUrl: string;
}

function operatorDigest(d: OperatorDigestData): RenderedEmail {
  return renderDigestMail(d.digest, d.environment, safeUrl(d.consoleUrl));
}

/**
 * Template 6 — ACCOUNT ALREADY EXISTS, the one that closes the oracle. `POST /auth/register`
 * answers a CONSTANT 202 on the public path either way, so the "sign in instead" news has nowhere
 * to go except here — the inbox only the address owner can read. The prober learns nothing; the
 * address owner learns everything, including that somebody tried. It carries NO CREDENTIAL — nothing was
 * created and nothing proven: the only link is the sign-in page, and an attacker who caused this
 * mail gains no token and no query string. It interpolates no user-controlled string: `signInUrl`
 * and `supportEmail` are deployment config, and the recipient's address is the envelope, not the
 * body.
 */

export interface AccountExistsData {
  /** `https://ohmail.app/login` — built from config by `MailService`, never by a caller. */
  signInUrl: string;
  supportEmail: string;
  /** The signup screen's language, as the verification mail's: the two branches stay alike. */
  locale?: MailLocale;
}

const EXISTS_COPY: Record<MailLocale, { subject: string; lines: string[]; signIn: string; action: string }> = {
  en: {
    subject: "You already have an ohmail account",
    lines: [
      "Someone just tried to create an ohmail account with this address. There is already one, " +
      "so nothing was created and nothing changed.",
      "If that was you: sign in instead — your existing account is untouched.",
      "If it was not you: you can ignore this. Whoever tried was not told whether this address " +
      "has an account, and they have no way in without your password or your passkey.",
    ],
    signIn: "Sign in:",
    action: "Sign in to ohmail",
  },
  de: {
    subject: "Du hast schon einen ohmail-Account",
    lines: [
      "Jemand hat gerade versucht, mit dieser Adresse einen ohmail-Account anzulegen. Es gibt schon einen, " +
      "also wurde nichts angelegt und nichts geändert.",
      "Wenn du das warst: Melde dich stattdessen an. Dein bestehender Account ist unverändert.",
      "Wenn nicht, kannst du diese Mail ignorieren. Wer es versucht hat, hat nicht erfahren, ob es zu " +
      "dieser Adresse einen Account gibt, und kommt ohne dein Passwort oder deinen Passkey nicht hinein.",
    ],
    signIn: "Anmelden:",
    action: "Bei ohmail anmelden",
  },
};

function accountExists(d: AccountExistsData): RenderedEmail {
  const url = safeUrl(d.signInUrl);
  const locale = mailLocaleOf(d.locale) ?? "en";
  const c = EXISTS_COPY[locale];
  const v = VERIFY_COPY[locale];
  const subject = c.subject;
  return {
    subject,
    text: textShell(
      subject,
      [...c.lines, `${c.signIn} ${url}`],
      [
        `${v.human} ${d.supportEmail}`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    ),
    html: shell({
      lang: locale,
      title: subject,
      blocks: c.lines.map(esc),
      action: { label: c.action, url },
      footer: [
        `${esc(v.noButton)} <a href="${esc(url)}" style="color:${ACCENT};">${esc(url)}</a>`,
        `${esc(v.human)} <a href="mailto:${esc(d.supportEmail)}" style="color:${ACCENT};">${esc(d.supportEmail)}</a>`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template 7 — the account lifecycle notices (cloud 0040, the wall).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ONE template, three notices: the trial ending, the closure, the erasure week. The data is
 * dates, closed words and configuration — nothing a sender or a caller chose can enter the body.
 * `locale` is the account's own (`account_settings.locale`, en when unset); the mailbox is the
 * master and the copy says so every time, and no notice names a price or a plan.
 */
interface LifecycleNoticeData {
  kind: "trial_two_days" | "closed" | "erasure_week";
  locale: "en" | "de";
  /** The anchor's own date (trial end / closure / erasure), formatted by the caller as UTC. */
  anchorDate: string;
  /** The erasure forecast's date, or null while none exists (an operator hold, say). A late erasure
   *  warning's is a week after it was sent, its anchor's date having passed. */
  erasureDate: string | null;
  /** Deep link to the app's account page — informational, changes nothing by itself. */
  accountUrl: string;
  /** The signup wizard's mailbox step, through sign-in (`<app>/login?next=join`). */
  setupUrl: string;
  /** The account has never had a mailbox: the trial and closure notices must not say ohmail organizes one. */
  noMailbox?: boolean;
  supportEmail: string;
}

const LIFECYCLE_COPY: Record<LifecycleNoticeData["kind"], Record<"en" | "de", {
  subject: string;
  /** The button under the body — the one link, rendered as the shell's action. */
  action: string;
  body: (d: LifecycleNoticeData) => string[];
}>> = {
  trial_two_days: {
    en: {
      subject: "Your ohmail trial ends in two days",
      action: "Open your ohmail account",
      body: (d) => [
        `Your trial ends on ${d.anchorDate}. To keep ohmail organizing your mailbox, choose a subscription on your account page.`,
        "If you do nothing, organizing stops when the trial ends. Your mailbox is untouched and stays yours — everything ohmail filed stays where it is.",
      ],
    },
    de: {
      subject: "Deine ohmail-Testphase endet in zwei Tagen",
      action: "Dein ohmail-Account öffnen",
      body: (d) => [
        `Die Testphase endet am ${d.anchorDate}. Damit ohmail dein Postfach weiter organisiert, wähl auf deiner Account-Seite ein Abo.`,
        "Tust du nichts, stoppt das Organisieren am Ende der Testphase. Dein Postfach bleibt unangetastet und gehört dir. Alles Einsortierte bleibt, wo es ist.",
      ],
    },
  },
  closed: {
    en: {
      subject: "Your ohmail subscription has ended",
      action: "Open your ohmail account",
      body: (d) => [
        `Your subscription ended on ${d.anchorDate}, so ohmail has stopped organizing and syncing. Your mailbox is untouched and stays yours — the mail lives on your own mail server.`,
        "Sign in to subscribe again, export your settings, or delete your account.",
        ...(d.erasureDate
          ? [`If you do nothing, your ohmail account data — rules, Screener decisions and settings — is erased on ${d.erasureDate}.`]
          : []),
      ],
    },
    de: {
      subject: "Dein ohmail-Abo ist beendet",
      action: "Dein ohmail-Account öffnen",
      body: (d) => [
        `Dein Abo ist am ${d.anchorDate} beendet worden; ohmail organisiert und synchronisiert nicht mehr. Dein Postfach bleibt unangetastet und gehört dir. Deine Mails liegen auf deinem eigenen Mailserver.`,
        "Melde dich an, um wieder zu abonnieren, deine Einstellungen zu exportieren oder deinen Account zu löschen.",
        ...(d.erasureDate
          ? [`Tust du nichts, werden deine ohmail-Account-Daten (Regeln, Screener-Entscheidungen und Einstellungen) am ${d.erasureDate} gelöscht.`]
          : []),
      ],
    },
  },
  erasure_week: {
    en: {
      subject: "Your ohmail account data is erased in a week",
      action: "Open your ohmail account",
      body: (d) => [
        `On ${d.erasureDate ?? d.anchorDate} your ohmail account data is erased: rules, Screener decisions and settings. Your mailbox is untouched — the mail was never ours to hold.`,
        "Sign in before then to keep the account, or export your settings first.",
      ],
    },
    de: {
      subject: "Deine ohmail-Account-Daten werden in einer Woche gelöscht",
      action: "Dein ohmail-Account öffnen",
      body: (d) => [
        `Am ${d.erasureDate ?? d.anchorDate} werden deine ohmail-Account-Daten gelöscht: Regeln, Screener-Entscheidungen und Einstellungen. Dein Postfach bleibt unangetastet, deine Mails waren nie bei uns.`,
        "Melde dich vorher an, um den Account zu behalten, oder exportiere zuerst deine Einstellungen.",
      ],
    },
  },
};

/**
 * The trial and closure notices for an account that never connected a mailbox; replies go to support. The
 * Microsoft sign-in is named for work or school accounts only: a personal account's is not proven yet.
 */
const NO_MAILBOX_COPY: Record<"trial_two_days" | "closed", Record<"en" | "de", {
  subject: string;
  action: string;
  body: (d: LifecycleNoticeData) => string[];
}>> = {
  trial_two_days: {
    en: {
      subject: "Your ohmail trial ends in two days",
      action: "Connect your mailbox",
      body: (d) => [
        `Your trial ends on ${d.anchorDate}, and your ohmail account has no mailbox connected yet, so ohmail has not organized any mail for you.`,
        "Connecting takes a few minutes: the button below takes you to the mailbox step, through sign-in if needed. If your mail is in a Microsoft 365 work or school account, connect it in Settings → Mailboxes with Connect Outlook instead: you sign in with Microsoft and need no app password.",
        "Stuck, or not sure ohmail fits? Just reply to this mail and a person answers.",
      ],
    },
    de: {
      subject: "Deine ohmail-Testphase endet in zwei Tagen",
      action: "Postfach verbinden",
      body: (d) => [
        `Die Testphase endet am ${d.anchorDate}, und mit deinem ohmail-Account ist noch kein Postfach verbunden. ohmail hat also noch keine Mail für dich organisiert.`,
        "Das Verbinden dauert ein paar Minuten: Der Button unten führt dich zum Postfach-Schritt, falls nötig über die Anmeldung. Liegt deine Mail in einem Microsoft-365-Postfach deiner Arbeit oder Schule, verbinde sie stattdessen unter Einstellungen → Postfächer mit „Outlook verbinden“: Du meldest dich bei Microsoft an und brauchst kein App-Passwort.",
        "Hängst du fest oder bist unsicher, ob ohmail passt? Antworte einfach auf diese Mail, ein Mensch antwortet dir.",
      ],
    },
  },
  closed: {
    en: {
      subject: "Your ohmail account has closed",
      action: "Open your ohmail account",
      body: (d) => [
        `Your ohmail account closed on ${d.anchorDate}. It had no mailbox connected, so ohmail never read or moved any of your mail.`,
        "Sign in to subscribe and connect a mailbox after all, or to delete your account.",
        ...(d.erasureDate
          ? [`If you do nothing, your ohmail account data — rules, Screener decisions and settings — is erased on ${d.erasureDate}.`]
          : []),
        "Questions, or stuck connecting? Just reply to this mail and a person answers.",
      ],
    },
    de: {
      subject: "Dein ohmail-Account ist geschlossen",
      action: "Dein ohmail-Account öffnen",
      body: (d) => [
        `Dein ohmail-Account ist seit dem ${d.anchorDate} geschlossen. Mit ihm war kein Postfach verbunden, ohmail hat also nie eine deiner Mails gelesen oder verschoben.`,
        "Melde dich an, um doch noch zu abonnieren und ein Postfach zu verbinden, oder um deinen Account zu löschen.",
        ...(d.erasureDate
          ? [`Tust du nichts, werden deine ohmail-Account-Daten (Regeln, Screener-Entscheidungen und Einstellungen) am ${d.erasureDate} gelöscht.`]
          : []),
        "Fragen, oder hängst du beim Verbinden fest? Antworte einfach auf diese Mail, ein Mensch antwortet dir.",
      ],
    },
  },
};

function lifecycleNotice(d: LifecycleNoticeData): RenderedEmail {
  const bare = d.noMailbox === true && d.kind !== "erasure_week" ? d.kind : null;
  const url = safeUrl(bare === "trial_two_days" ? d.setupUrl : d.accountUrl);
  const copy = bare ? NO_MAILBOX_COPY[bare][d.locale] : LIFECYCLE_COPY[d.kind][d.locale];
  const blocks = copy.body(d);
  const footer = [
    d.locale === "de" ? `Einen Menschen erreichen: ${d.supportEmail}` : `Reach a human: ${d.supportEmail}`,
    "TrafficFlow GmbH, Zürich, Switzerland",
  ];
  return {
    subject: copy.subject,
    // The text part carries the URL on its own line, the plain-text counterpart of the button.
    text: textShell(copy.subject, [...blocks, url], footer),
    html: shell({
      title: copy.subject,
      blocks: blocks.map(esc),
      action: { label: copy.action, url },
      footer,
    }),
    ...(bare ? { replyTo: d.supportEmail } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Template 8 — the billing link, the one customer mail staff send by hand.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent from the staff console (`POST /admin/accounts/:id/billing-link`, three per account a day)
 * to the account's owner. The data is a language, the app's own billing door and the support
 * address: no recipient (the envelope), no id, no token. The door asks for sign-in and only then
 * mints the billing page's link, so a forwarded mail opens nothing.
 */
export interface BillingLinkData {
  /** The account's own (`account_settings.locale`), English when unset. */
  locale: MailLocale;
  /** `<app>/account/manage` — built from config by `MailService`, never by a caller. */
  billingUrl: string;
  supportEmail: string;
}

/** The page is named as the app names it (Settings → Subscription, Einstellungen → Abo). */
const BILLING_LINK_COPY: Record<MailLocale, {
  subject: string; lines: string[]; never: string; action: string; human: string;
}> = {
  en: {
    subject: "Your ohmail subscription page",
    lines: [
      "ohmail support sent you this link to the subscription page of your ohmail account.",
      "The page opens once you are signed in to ohmail. The link alone signs nobody in.",
      "You can also open it yourself: in ohmail, Settings → Subscription.",
      "If you did not expect this mail, you can ignore it; nothing changes by itself.",
    ],
    never: "We will never ask you for a code, a password, or a recovery code by email.",
    action: "Open the subscription page",
    human: VERIFY_COPY.en.human,
  },
  de: {
    subject: "Deine ohmail-Abo-Seite",
    lines: [
      "Der ohmail-Support hat dir diesen Link zur Abo-Seite deines ohmail-Accounts geschickt.",
      "Die Seite öffnet sich, sobald du bei ohmail angemeldet bist. Der Link allein meldet niemanden an.",
      "Du kannst sie auch selbst öffnen: in ohmail unter Einstellungen → Abo.",
      "Wenn du diese Mail nicht erwartet hast, kannst du sie ignorieren; von selbst ändert sich nichts.",
    ],
    never: "Wir fragen dich nie per Mail nach einem Code, einem Passwort oder einem Wiederherstellungscode.",
    action: "Abo-Seite öffnen",
    human: VERIFY_COPY.de.human,
  },
};

function billingLink(d: BillingLinkData): RenderedEmail {
  const url = safeUrl(d.billingUrl);
  const locale = mailLocaleOf(d.locale) ?? "en";
  const c = BILLING_LINK_COPY[locale];
  return {
    subject: c.subject,
    text: textShell(c.subject, [...c.lines, c.never, url], [
      `${c.human} ${d.supportEmail}`,
      "TrafficFlow GmbH, Zürich, Switzerland",
    ]),
    html: shell({
      lang: locale,
      title: c.subject,
      blocks: [...c.lines.map(esc), `<strong style="color:${INK};font-weight:600;">${esc(c.never)}</strong>`],
      action: { label: c.action, url },
      footer: [
        `${esc(c.human)} <a href="mailto:${esc(d.supportEmail)}" style="color:${ACCENT};">${esc(d.supportEmail)}</a>`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry — the single place the set is enumerated.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Template name → its data shape — the contract `MailerPort.send` is generic over, so a caller
 * cannot pass invite data to the verification template. The set is closed on purpose: adding an
 * entry is a product decision. `operator_alert` and `operator_digest` are not customer mail.
 * "Closed" has always meant the typed map and the absence of a free-form body, never a frozen
 * cardinality: entries have been added since the original four, each argued at its own definition. What may
 * never happen: an entry whose data shape can carry arbitrary text into an outbound message from
 * our domain, or a `send` overload that skips this map.
 */
export interface TemplateDataMap {
  waitlist_confirmation: WaitlistConfirmationData;
  invite: InviteData;
  new_device_signin: NewDeviceSignInData;
  security_notice: SecurityNoticeData;
  email_verification: EmailVerificationData;
  operator_alert: OperatorAlertData;
  operator_digest: OperatorDigestData;
  account_exists: AccountExistsData;
  lifecycle_notice: LifecycleNoticeData;
  billing_link: BillingLinkData;
}

export type TemplateName = keyof TemplateDataMap;

const RENDERERS: { [K in TemplateName]: (data: TemplateDataMap[K]) => RenderedEmail } = {
  waitlist_confirmation: waitlistConfirmation,
  invite,
  new_device_signin: newDeviceSignIn,
  security_notice: securityNotice,
  email_verification: emailVerification,
  operator_alert: operatorAlert,
  operator_digest: operatorDigest,
  account_exists: accountExists,
  lifecycle_notice: lifecycleNotice,
  billing_link: billingLink,
};

export const TEMPLATE_NAMES = Object.keys(RENDERERS) as TemplateName[];

/** Render one template. Throws only on invalid data (a bad URL); `MailerPort.send` catches. */
export function renderTemplate<K extends TemplateName>(
  template: K, data: TemplateDataMap[K],
): RenderedEmail {
  const render = RENDERERS[template] as ((d: TemplateDataMap[K]) => RenderedEmail) | undefined;
  if (!render) throw new Error(`mail: unknown template ${JSON.stringify(template)}`);
  return render(data);
}
