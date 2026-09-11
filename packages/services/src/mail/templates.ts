/**
 * The transactional templates. Plain TypeScript returning `{ subject, text, html }` — no template
 * engine: a handful of emails does not justify a dependency on the one path whose output lands in
 * other people's inboxes. Rules every template obeys, enforced by `mail-templates.test.ts`: (1)
 * NO REMOTE RESOURCE, ever — ohmail blocks tracking pixels as a product feature, and the wordmark
 * is TEXT. (2) Text AND html for every one — the text part is the real message, not a stub. (3)
 * Every interpolation is escaped (`esc`) and every URL validated (`safeUrl`), because template
 * data carries user-controlled strings. (4) Factual microcopy — receipts and security signals, no
 * slogans. English only for beta.
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
}

interface ShellInput {
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
<html lang="en">
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
}

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
  const subject = "Verify your email for ohmail";
  const ifNotYou =
    "If you did not start this, ignore this message. Without this link the account cannot " +
    "connect a mailbox and cannot be subscribed to anything.";
  return {
    subject,
    text: textShell(
      subject,
      [
        "Confirm this address to finish setting up your ohmail account.",
        `Open this link: ${url}`,
        `The link works once and expires in ${d.expiresIn}. You will be asked for the password you chose.`,
        ifNotYou,
      ],
      [
        `Reach a human: ${d.supportEmail}`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    ),
    html: shell({
      title: subject,
      blocks: [
        "Confirm this address to finish setting up your ohmail account.",
        `The link works once and expires in ${esc(d.expiresIn)}. You will be asked for the password you chose.`,
        ifNotYou,
      ],
      action: { label: "Verify this address", url },
      footer: [
        `If the button does not work, open <a href="${esc(url)}" style="color:${ACCENT};">${esc(url)}</a>`,
        `Reach a human: <a href="mailto:${esc(d.supportEmail)}" style="color:${ACCENT};">${esc(d.supportEmail)}</a>`,
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
  const url = safeUrl(d.consoleUrl);
  const n = d.alerts.length;
  const subject = `[${d.environment}] ohmail: ${n} alert${n === 1 ? "" : "s"} firing`;
  return {
    subject,
    text: textShell(
      subject,
      [
        `Observed by the ${d.source} alert pass.`,
        ...d.alerts.map((a) => `[${a.severity}] ${a.title}\n  ${a.detail}`),
        `Admin console: ${url}`,
      ],
      [
        "This is an automated operator alert. It repeats at most once an hour while the condition lasts.",
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    ),
    html: shell({
      title: subject,
      blocks: [
        `Observed by the ${esc(d.source)} alert pass.`,
        // `<strong>`, not `<b>`: the template allow-list in `mail-templates.test.ts`
        // enumerates every element these files may emit, and `<b>` is not on it.
        ...d.alerts.map(
          (a) =>
            `<strong>[${esc(a.severity)}] ${esc(a.title)}</strong><br>` +
            `<span style="color:${INK2};">${esc(a.detail)}</span>`,
        ),
      ],
      action: { label: "Open the admin console", url },
      footer: [
        "This is an automated operator alert. It repeats at most once an hour while the condition lasts.",
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    }),
  };
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
}

function accountExists(d: AccountExistsData): RenderedEmail {
  const url = safeUrl(d.signInUrl);
  const subject = "You already have an ohmail account";
  const lines = [
    "Someone just tried to create an ohmail account with this address. There is already one, " +
    "so nothing was created and nothing changed.",
    "If that was you: sign in instead — your existing account is untouched.",
    "If it was not you: you can ignore this. Whoever tried was not told whether this address " +
    "has an account, and they have no way in without your password or your passkey.",
  ];
  return {
    subject,
    text: textShell(
      subject,
      [...lines, `Sign in: ${url}`],
      [
        `Reach a human: ${d.supportEmail}`,
        "TrafficFlow GmbH, Zürich, Switzerland",
      ],
    ),
    html: shell({
      title: subject,
      blocks: lines,
      action: { label: "Sign in to ohmail", url },
      footer: [
        `If the button does not work, open <a href="${esc(url)}" style="color:${ACCENT};">${esc(url)}</a>`,
        `Reach a human: <a href="mailto:${esc(d.supportEmail)}" style="color:${ACCENT};">${esc(d.supportEmail)}</a>`,
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
 * entry is a product decision. Five are customer mail; `operator_alert` is not. "Closed" has
 * always meant the typed map and the absence of a free-form body, never a frozen cardinality: two
 * entries have been added since the original four, each argued at its own definition. What may
 * never happen: an entry whose data shape can carry arbitrary text into an outbound message from
 * our domain, or a `send` overload that skips this map.
 */
export interface TemplateDataMap {
  waitlist_confirmation: WaitlistConfirmationData;
  invite: InviteData;
  new_device_signin: NewDeviceSignInData;
  email_verification: EmailVerificationData;
  operator_alert: OperatorAlertData;
  account_exists: AccountExistsData;
}

export type TemplateName = keyof TemplateDataMap;

const RENDERERS: { [K in TemplateName]: (data: TemplateDataMap[K]) => RenderedEmail } = {
  waitlist_confirmation: waitlistConfirmation,
  invite,
  new_device_signin: newDeviceSignIn,
  email_verification: emailVerification,
  operator_alert: operatorAlert,
  account_exists: accountExists,
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
