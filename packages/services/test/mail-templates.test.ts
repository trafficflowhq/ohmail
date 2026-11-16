import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import {
  renderTemplate, safeUrl, esc, TEMPLATE_NAMES, providerClassOf,
  type TemplateDataMap, type TemplateName, type WaitlistTier,
} from "../src/index.js";
import { DARK_BLOCK } from "../src/mail/frame.js";

/**
 * The template gate.
 *
 * What it holds, each a rule the product cannot break:
 *  1. Every template, in every state and language it has, renders to its golden files
 *     (`fixtures/mail/<mail>[.<state>].<lang>.{txt,html}`). Words that reach a stranger's inbox do
 *     not change by accident.
 *  2. The HTML loads NOTHING remote. ohmail strips tracking pixels out of other people's mail; a
 *     remote image, webfont or stylesheet in our own would be the same beacon with our name on it.
 *     The one style element is the frame's dark block, and the one conditional comment is the
 *     capsule's Outlook fallback, which is parsed and held to its own allow-list.
 *  3. Every value is text: a hostile value in any field renders as its own characters.
 *  4. The html says what the text part says.
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
  // The "you already have an account" news `POST /auth/register` no longer puts in its response.
  // The only template with NO credential at all: no token, no code, no query string to get wrong.
  account_exists: {
    signInUrl: "https://ohmail.app/login",
    supportEmail: "support@ohmail.app",
  },
  // The sign-in throttle's notices (`drainSecurityNotices`): a closed kind, a time and config.
  security_notice: {
    kind: "factor_refused",
    at: "26 September 2026, 12:00 UTC",
    devicesUrl: "https://ohmail.app/settings/devices",
    supportEmail: "support@ohmail.app",
  },
  // The wall's notice family (cloud 0040); every kind and language is in STATES below.
  lifecycle_notice: {
    kind: "closed",
    locale: "en",
    anchorDate: "16 September 2026, 00:00 UTC",
    erasureDate: "16 October 2026, 00:00 UTC",
    accountUrl: "https://app.ohmail.app/#/settings/account",
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
  // The connect reminder: a language, the advice's class (from the login domain, never the address),
  // the sign-in door to the mailbox step and the support address.
  connect_reminder: {
    locale: "en",
    provider: "other",
    setupUrl: "https://app.ohmail.app/login?next=join",
    supportEmail: "support@ohmail.app",
  },
  // The storage mails (cloud 0057): numbers, closed words, the program's fitted choice and its price,
  // the app's own Settings › Storage door and the support address. No token, no address, no mailbox.
  storage_near: {
    locale: "en", usedBytes: 3_600_000_000, capBytes: 4_000_000_000, limitReason: "trial", limitDropsAt: null,
    expectedBytes: 12_500_000_000, importing: true, keptFrom: null,
    fit: { plan: "plus", addonUnits: 1, roomBytes: 15_000_000_000, amount: 2_500, keepsAll: true },
    addonBytes: 10_000_000_000, currency: "usd", interval: "month",
    settingsUrl: "https://app.ohmail.app/#/settings/storage", supportEmail: "support@ohmail.app",
  },
  storage_full: {
    locale: "en", usedBytes: 4_000_000_000, capBytes: 4_000_000_000, limitReason: "trial", limitDropsAt: null,
    expectedBytes: 12_500_000_000, importing: false, keptFrom: "2019-03",
    fit: { plan: "plus", addonUnits: 1, roomBytes: 15_000_000_000, amount: 2_500, keepsAll: true },
    addonBytes: 10_000_000_000, currency: "usd", interval: "month",
    settingsUrl: "https://app.ohmail.app/#/settings/storage", supportEmail: "support@ohmail.app",
  },
};

const ALL = TEMPLATE_NAMES;

/** Hosts a rendered mail is allowed to LINK to. `admin.ohmail.app` is the staff console — reachable
 *  ONLY from `operator_alert` and `operator_digest`, which no customer ever receives. */
const ALLOWED_HOSTS = new Set(["ohmail.app", "app.ohmail.app", "admin.ohmail.app", "localhost"]);

// ── Every state, in every language, as the brand kit lists them ─────────────

interface State { id: string; template: TemplateName; lang: "en" | "de"; data: unknown }

const GB = 1_000_000_000;
const date = (lang: "en" | "de", en: string, de: string): string => (lang === "de" ? de : en);
const storage = (over: Partial<TemplateDataMap["storage_near"]>) => (lang: "en" | "de") =>
  ({ ...FIXTURES.storage_near, locale: lang, ...over });
const lifecycle = (over: Partial<TemplateDataMap["lifecycle_notice"]>) => (lang: "en" | "de") => ({
  ...FIXTURES.lifecycle_notice, locale: lang,
  anchorDate: date(lang, "16 September 2026, 00:00 UTC", "16. September 2026, 00:00 UTC"),
  erasureDate: date(lang, "16 October 2026, 00:00 UTC", "16. Oktober 2026, 00:00 UTC"),
  ...over,
});

const MAILS: Array<{ id: string; template: TemplateName; langs: Array<"en" | "de">; states: Array<[string, (lang: "en" | "de") => unknown]> }> = [
  { id: "waitlist", template: "waitlist_confirmation", langs: ["en"],
    states: (["plus", "desktop", "solo", "pro", "undecided"] as const).map((tier) => [tier, () => ({ ...FIXTURES.waitlist_confirmation, tier })]) },
  { id: "beta-invite", template: "invite", langs: ["en"], states: [["default", () => FIXTURES.invite]] },
  { id: "confirm-address", template: "email_verification", langs: ["en", "de"],
    states: [["default", (lang) => ({ ...FIXTURES.email_verification, locale: lang, expiresIn: date(lang, "24 hours", "24 Stunden") })]] },
  { id: "account-exists", template: "account_exists", langs: ["en", "de"], states: [["default", (lang) => ({ ...FIXTURES.account_exists, locale: lang })]] },
  { id: "connect-mailbox", template: "connect_reminder", langs: ["en", "de"],
    states: (["other", "gmail", "microsoft"] as const).map((provider) => [provider, (lang) => ({ ...FIXTURES.connect_reminder, locale: lang, provider })]) },
  { id: "new-sign-in", template: "new_device_signin", langs: ["en"], states: [
    ["default", () => ({ ...FIXTURES.new_device_signin, device: "ohmail for Mac" })],
    ["unknown", () => ({ ...FIXTURES.new_device_signin, device: "Unknown device", ip: "unknown" })],
  ] },
  { id: "sign-in-slowed", template: "security_notice", langs: ["en", "de"], states: [["default", (lang) => ({
    ...FIXTURES.security_notice, kind: "sign_in_slowed", locale: lang, at: date(lang, "26 September 2026, 12:00 UTC", "26. September 2026, 12:00 UTC") })]] },
  { id: "second-step-failed", template: "security_notice", langs: ["en", "de"], states: [["default", (lang) => ({
    ...FIXTURES.security_notice, locale: lang, at: date(lang, "26 September 2026, 12:00 UTC", "26. September 2026, 12:00 UTC") })]] },
  { id: "trial-ends", template: "lifecycle_notice", langs: ["en", "de"], states: [
    ["default", lifecycle({ kind: "trial_two_days" })],
    ["no-mailbox", lifecycle({ kind: "trial_two_days", noMailbox: true })],
  ] },
  { id: "subscription-ended", template: "lifecycle_notice", langs: ["en", "de"], states: [
    ["default", lifecycle({ kind: "closed" })],
    ["no-date", lifecycle({ kind: "closed", erasureDate: null })],
  ] },
  { id: "account-closed", template: "lifecycle_notice", langs: ["en", "de"], states: [
    ["default", lifecycle({ kind: "closed", noMailbox: true })],
    ["no-date", lifecycle({ kind: "closed", noMailbox: true, erasureDate: null })],
  ] },
  { id: "erasure-week", template: "lifecycle_notice", langs: ["en", "de"], states: [["default", lifecycle({ kind: "erasure_week" })]] },
  { id: "subscription-page", template: "billing_link", langs: ["en", "de"], states: [["default", (lang) => ({ ...FIXTURES.billing_link, locale: lang })]] },
  { id: "storage-near", template: "storage_near", langs: ["en", "de"], states: [
    ["default", storage({ usedBytes: 1.8 * GB, capBytes: 2 * GB, limitReason: "plan", expectedBytes: 3.6 * GB, importing: false,
      fit: { plan: "plus", addonUnits: 0, roomBytes: 5 * GB, amount: 1_500, keepsAll: true }, addonBytes: 0 })],
    ["trial-import", storage({})],
    ["held", storage({ usedBytes: 4.6 * GB, capBytes: 5 * GB, limitReason: "held", limitDropsAt: "2026-11-21T00:00:00.000Z",
      expectedBytes: 4.8 * GB, importing: false, fit: { plan: "plus", addonUnits: 0, roomBytes: 5 * GB, amount: 1_500, keepsAll: true }, addonBytes: 0 })],
    ["most", storage({ usedBytes: 9.1 * GB, capBytes: 10 * GB, limitReason: "plan", expectedBytes: 140 * GB, importing: false,
      fit: { plan: "pro", addonUnits: 10, roomBytes: 110 * GB, amount: 12_900, keepsAll: false }, addonBytes: 100 * GB })],
  ] },
  { id: "storage-full", template: "storage_full", langs: ["en", "de"], states: [
    ["default", (lang) => ({ ...FIXTURES.storage_full, locale: lang })],
    ["no-month", (lang) => ({ ...FIXTURES.storage_full, locale: lang, keptFrom: null })],
    ["trial", (lang) => ({ ...FIXTURES.storage_full, locale: lang, limitReason: "trial", keptFrom: "2021-06" })],
  ] },
  { id: "operator-alert", template: "operator_alert", langs: ["en"], states: [["default", () => FIXTURES.operator_alert]] },
  { id: "operator-digest", template: "operator_digest", langs: ["en"], states: [["default", () => FIXTURES.operator_digest]] },
];

const STATES: State[] = MAILS.flatMap((m) => m.states.flatMap(([state, data], i) => m.langs.map((lang) => ({
  id: `${m.id}${i === 0 ? "" : `.${state}`}.${lang}`, template: m.template, lang, data: data(lang),
}))));
const CUSTOMER = STATES.filter((s) => s.template !== "operator_alert" && s.template !== "operator_digest");
const render = (s: State) => renderTemplate(s.template, s.data as never);

// ── The self-contained check, shared by every state and by the planted documents ──

/**
 * Tags and attributes a mail client fetches WITHOUT the reader doing anything. A denylist is only as
 * good as its author's imagination, so the PARSED allow-list below is the real rule; the regexes stay
 * because they read as documentation and the planted documents keep them honest.
 */
const AUTOLOAD = [
  /<img\b/i, /<script\b/i, /<iframe\b/i, /<link\b/i, /<video\b/i, /<audio\b/i,
  /<object\b/i, /<embed\b/i, /<svg\b/i, /<image\b/i, /<use\b/i, /<input\b/i, /<base\b/i,
  /\bsrc\s*=/i, /\bsrcset\s*=/i, /\bbackground\s*=/i, /\bposter\s*=/i,
  /\bxlink:href/i, /\bformaction\s*=/i, /\bhttp-equiv/i,
  /\burl\s*\(/i, /@import/i, /@font-face/i, /image-set/i, /expression\s*\(/i, /\\[0-9a-f]/i,
];

/** Every element a customer mail may emit. Anything else fails. */
const ALLOWED_ELEMENTS = new Set([
  "html", "head", "meta", "title", "style", "body",
  "table", "tbody", "tr", "td", "a", "p", "h1", "span", "strong",
]);

/** Every attribute those elements may carry. `src` is deliberately absent. */
const ALLOWED_ATTRS = new Set([
  "lang", "charset", "name", "content", "style", "href", "class", "xmlns:v", "xmlns:o",
  "role", "width", "cellpadding", "cellspacing", "border", "align",
]);

/** The capsule's Outlook fallback, parsed on its own, may hold only these. */
const MSO_ELEMENTS = new Set(["v:roundrect", "w:anchorlock", "center"]);
const MSO_ATTRS = new Set(["xmlns:v", "xmlns:w", "href", "style", "arcsize", "stroke", "fillcolor"]);
const URNS: Record<string, string> = {
  "xmlns:v": "urn:schemas-microsoft-com:vml",
  "xmlns:o": "urn:schemas-microsoft-com:office:office",
  "xmlns:w": "urn:schemas-microsoft-com:office:word",
};
const DARK_CLASSES = new Set([...DARK_BLOCK.matchAll(/^\.([a-z])\{/gm)].map((m) => m[1]!));

function hrefProblem(href: string): string | null {
  if (href.startsWith("mailto:")) return /^mailto:[^\s<>"?&#%,;@]+@[^\s<>"?&#%,;@]+$/.test(href) ? null : `mailto ${href}`;
  try {
    const u = new URL(href);
    return (u.protocol === "https:" || (u.protocol === "http:" && u.hostname === "localhost")) && ALLOWED_HOSTS.has(u.hostname)
      ? null : `href ${href}`;
  } catch { return `href ${href}`; }
}

function commentsOf(doc: Document): string[] {
  const out: string[] = [];
  const walk = doc.createTreeWalker(doc, 128 /* NodeFilter.SHOW_COMMENT */);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) out.push((n as Comment).data);
  return out;
}

/** Every reason this document is not a self-contained mail; empty when it is. */
function problems(html: string): string[] {
  const found: string[] = [];
  for (const re of AUTOLOAD) if (re.test(html)) found.push(`matched ${re}`);
  const doc = new JSDOM(html).window.document;
  for (const el of doc.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    if (!ALLOWED_ELEMENTS.has(tag)) found.push(`element ${tag}`);
    for (const a of el.getAttributeNames()) {
      if (!ALLOWED_ATTRS.has(a)) found.push(`attribute ${a} on ${tag}`);
      if (a in URNS && el.getAttribute(a) !== URNS[a]) found.push(`${a} value`);
    }
    const style = el.getAttribute("style");
    if (style !== null && /[(\\@{}<]|\/\*/.test(style)) found.push(`style attribute on ${tag}: ${style}`);
    const cls = el.getAttribute("class");
    if (cls !== null) for (const c of cls.split(" ")) if (!DARK_CLASSES.has(c)) found.push(`class ${c}`);
  }
  for (const a of doc.querySelectorAll("a")) {
    const p = hrefProblem(a.getAttribute("href") ?? "");
    if (p) found.push(p);
  }
  const styles = [...doc.querySelectorAll("style")];
  if (styles.length !== 1) found.push(`${styles.length} style elements`);
  for (const s of styles) {
    if (s.parentElement?.tagName.toLowerCase() !== "head") found.push("style outside head");
    if (s.getAttributeNames().length > 0) found.push("style with attributes");
    if (s.textContent !== `\n${DARK_BLOCK}\n`) found.push("style is not the dark block");
  }
  const capsule = doc.querySelector("a.k")?.getAttribute("href") ?? null;
  for (const c of commentsOf(doc)) {
    if (c === "[if !mso]><!" || c === "<![endif]") continue;
    const mso = /^\[if mso\]>([\s\S]*)<!\[endif\]$/.exec(c);
    if (!mso) { found.push(`comment ${c.slice(0, 40)}`); continue; }
    for (const re of AUTOLOAD) if (re.test(mso[1]!)) found.push(`mso matched ${re}`);
    const frag = new JSDOM(`<body>${mso[1]}</body>`).window.document.body;
    for (const el of frag.querySelectorAll("*")) {
      const tag = el.tagName.toLowerCase();
      if (!MSO_ELEMENTS.has(tag)) found.push(`mso element ${tag}`);
      for (const a of el.getAttributeNames()) if (!MSO_ATTRS.has(a)) found.push(`mso attribute ${a}`);
      if (el.hasAttribute("href") && el.getAttribute("href") !== capsule) found.push("mso href is not the capsule's");
    }
  }
  return found;
}

describe("the dark block holds nothing a client could fetch", () => {
  it("is the media query and one-class colour rules, nothing else", () => {
    const lines = DARK_BLOCK.split("\n");
    expect(lines[0]).toBe(":root{color-scheme:light dark;supported-color-schemes:light dark}");
    expect(lines[1]).toBe("@media (prefers-color-scheme:dark){");
    expect(lines.at(-1)).toBe("}");
    for (const l of lines.slice(2, -1)) {
      expect(l).toMatch(/^\.[a-z]\{(?:(?:color|background):#[0-9A-F]{6} !important;?)+\}$/);
    }
    for (const bad of ["url(", "@import", "@font-face", "http", "//", "\\", "expression", "'", "\"", ","]) {
      expect(DARK_BLOCK, bad).not.toContain(bad);
    }
  });
});

describe("templates — the set is closed and complete", () => {
  it("is exactly the thirteen templates — eleven customer mails and two operator mails", () => {
    expect(ALL).toEqual([
      "waitlist_confirmation", "invite", "new_device_signin",
      // The sign-in throttle's notices, argued at the definition: a closed kind, a time and the
      // support address — no caller prose, no capsule (there is no password rotation to point at).
      "security_notice",
      "email_verification",
      // The pager needs a second delivery path that shares no infrastructure with the webhook,
      // and the closed-set guarantee (no free-form body can become outbound mail) is untouched by it.
      "operator_alert",
      // The pager's daily summary: the operator address only, keys, kinds, titles, timestamps.
      "operator_digest",
      // LOAD-BEARING for a security property: `POST /auth/register`'s public path answers a constant
      // 202 for every address, so "you already have an account" can only be said in the inbox.
      "account_exists",
      // Cloud 0040, the wall: dates, closed words and configuration, in the account's language.
      "lifecycle_notice",
      // The one mail staff send by hand: a language, the app's billing door and the support address.
      "billing_link",
      // Once per trial, to a trial that connected no mailbox.
      "connect_reminder",
      // Cloud 0057, the storage mails at 90% and when full.
      "storage_near",
      "storage_full",
    ]);
  });

  it("the state table covers every template, and every state the brand kit draws", () => {
    expect([...new Set(STATES.map((s) => s.template))].sort()).toEqual([...ALL].sort());
    expect(CUSTOMER).toHaveLength(52);
  });

  it("the closed-set guarantee still holds: no template can carry a free-form body", () => {
    // Every field of every fixture is a first-party URL, a deployment-config string, a credential we
    // minted, or an enum; none is a caller's prose. `operator_alert.alerts[].detail` comes from
    // `packages/db/src/alerts.ts` and goes only to the configured operator address.
    const FORBIDDEN = /^(body|message|text|html|content|note|comment|subject)$/i;
    for (const name of ALL) {
      const fixture = FIXTURES[name] as unknown as Record<string, unknown>;
      for (const key of Object.keys(fixture)) {
        expect(FORBIDDEN.test(key), `${name}.${key} looks like a free-form body field`).toBe(false);
      }
    }
  });

  it("ONLY the operator mails may name the staff console — no customer mail links there", () => {
    for (const s of STATES) {
      const { html, text } = render(s);
      expect(html.includes("admin.ohmail.app") || text.includes("admin.ohmail.app"), s.id)
        .toBe(s.template === "operator_alert" || s.template === "operator_digest");
    }
  });

  it("every state renders a subject naming ohmail, and a text and an html part", () => {
    for (const s of STATES) {
      const out = render(s);
      expect(out.subject, s.id).toMatch(/ohmail/);
      expect(out.text.length, s.id).toBeGreaterThan(120);
      expect(out.html.length, s.id).toBeGreaterThan(400);
      for (const part of [out.subject, out.text, out.html]) expect(part, s.id).not.toMatch(/OhMail|Ohmail/);
    }
  });
});

describe("templates — every state as its golden files", () => {
  for (const s of STATES) {
    it(`${s.id}`, async () => {
      const out = render(s);
      await expect(`Subject: ${out.subject}\n\n${out.text}`).toMatchFileSnapshot(`fixtures/mail/${s.id}.txt`);
      await expect(out.html).toMatchFileSnapshot(`fixtures/mail/${s.id}.html`);
    });
  }

  it("the waitlist confirmation is the only one carrying List-Unsubscribe", () => {
    const withHeaders = [...new Set(STATES.filter((s) => render(s).headers != null).map((s) => s.template))];
    expect(withHeaders).toEqual(["waitlist_confirmation"]);
    const h = renderTemplate("waitlist_confirmation", FIXTURES.waitlist_confirmation).headers!;
    expect(h["List-Unsubscribe"]).toBe(
      "<mailto:support@ohmail.app?subject=Remove%20me%20from%20the%20ohmail%20waitlist>",
    );
  });

  it("every waitlist tier renders its own line, and a tier outside the set drops it", () => {
    const tiers: WaitlistTier[] = ["desktop", "solo", "plus", "pro", "undecided"];
    const lines = tiers.map((tier) => renderTemplate("waitlist_confirmation", { ...FIXTURES.waitlist_confirmation, tier }).text
      .split("\n").find((l) => /^You (leaned|are still)/.test(l)));
    expect(new Set(lines).size).toBe(tiers.length);
    const odd = renderTemplate("waitlist_confirmation", { ...FIXTURES.waitlist_confirmation, tier: "x" as never }).text;
    expect(odd).not.toMatch(/undefined|You leaned/);
  });
});

describe("templates — no remote resource, in any state", () => {
  it("every state is self-contained: allow-listed markup, the dark block, the capsule's fallback, first-party links", () => {
    const elements = new Set<string>();
    const attrs = new Set<string>();
    for (const s of CUSTOMER) {
      const { html } = render(s);
      expect(problems(html), s.id).toEqual([]);
      const doc = new JSDOM(html).window.document;
      for (const el of doc.querySelectorAll("*")) {
        elements.add(el.tagName.toLowerCase());
        for (const a of el.getAttributeNames()) attrs.add(a);
      }
    }
    // The lists are no wider than what the mails use.
    expect([...elements].sort()).toEqual([...ALLOWED_ELEMENTS].sort());
    expect([...attrs].sort()).toEqual([...ALLOWED_ATTRS].sort());
  });

  it("every capsule has its Outlook fallback with the same address, and the same address in words in the footer", () => {
    for (const s of CUSTOMER) {
      const doc = new JSDOM(render(s).html).window.document;
      const capsule = doc.querySelector("a.k");
      const mso = commentsOf(doc).filter((c) => c.startsWith("[if mso]"));
      if (!capsule) { expect(mso, s.id).toEqual([]); continue; }
      expect(mso, s.id).toHaveLength(1);
      expect(mso[0], s.id).toContain(`href="${esc(capsule.getAttribute("href")!)}"`);
      const footerLinks = [...doc.querySelectorAll("td.j a")].map((a) => a.getAttribute("href"));
      expect(footerLinks, s.id).toContain(capsule.getAttribute("href"));
    }
  });

  it("the text part is plain, and its links are first-party", () => {
    for (const s of STATES) {
      const { text } = render(s);
      expect(text, s.id).not.toMatch(/<[a-z!/]/i);
      for (const raw of text.match(/https?:\/\/[^\s)]+/g) ?? []) {
        expect(ALLOWED_HOSTS.has(new URL(raw).hostname), `${s.id}: foreign host ${raw}`).toBe(true);
      }
    }
  });

  it("the guards bite: each planted document is refused", () => {
    const base = render(CUSTOMER.find((s) => s.id === "confirm-address.en")!).html;
    expect(problems(base)).toEqual([]);
    const plants: Array<[string, string]> = [
      ["an image", base.replace("<h1 ", `<img src="https://tracker.example.com/o.gif" width="1"><h1 `)],
      ["a data picture", base.replace("<h1 ", `<img src="data:image/png;base64,AAAA"><h1 `)],
      ["a cid picture", base.replace("<h1 ", `<img src="cid:mark"><h1 `)],
      ["an svg image", base.replace("<h1 ", `<svg><image href="https://tracker.example.com/o.gif"/></svg><h1 `)],
      ["a refresh", base.replace("<title>", `<meta http-equiv="refresh" content="0;url=https://tracker.example.com/"><title>`)],
      ["a cell background", base.replace(`<td class="s"`, `<td background="https://tracker.example.com/bg.png" class="s"`)],
      ["a link element", base.replace("</head>", `<link rel="stylesheet" href="https://tracker.example.com/a.css"></head>`)],
      ["a base element", base.replace("</head>", `<base href="https://tracker.example.com/"></head>`)],
      ["@import with url()", base.replace("@media", "@import url(https://tracker.example.com/a.css);\n@media")],
      ["@import with a string", base.replace("@media", `@import "https://tracker.example.com/a.css";\n@media`)],
      ["@font-face", base.replace("@media", "@font-face{font-family:x}\n@media")],
      ["url( in the block", base.replace(".g{background:#0E0D0C !important}", ".g{background:url(https://tracker.example.com/x)}")],
      ["url( in an attribute", base.replace(`style="margin:0;padding:0;`, `style="background:url(https://tracker.example.com/x);margin:0;padding:0;`)],
      ["an escaped url(", base.replace(".g{background:#0E0D0C !important}", ".g{background:\\75rl(https://tracker.example.com/x)}")],
      ["image-set", base.replace(".g{background:#0E0D0C !important}", `.g{background:image-set("https://tracker.example.com/x" 1x)}`)],
      ["a second style element", base.replace("</head>", "<style>.x{color:#000000}</style></head>")],
      ["a style with an attribute", base.replace("<style>", `<style media="all">`)],
      ["an image inside the mso comment", base.replace("<w:anchorlock", `<v:imagedata src="https://tracker.example.com/o.gif"/><w:anchorlock`)],
      ["a fill inside the mso comment", base.replace("<w:anchorlock", `<v:fill type="tile" color="#000000"/><w:anchorlock`)],
      ["another mso href", base.replace(/(<v:roundrect[^>]*href=")[^"]*/, "$1https://app.ohmail.app/elsewhere")],
      ["another comment", base.replace("<h1 ", "<!-- a note --><h1 ")],
      ["a foreign href", base.replace(/(<a class="k" href=")[^"]*/, "$1https://evil.example/")],
      ["a protocol-relative href", base.replace(/(<a class="k" href=")[^"]*/, "$1//evil.example/")],
      ["a javascript href", base.replace(/(<a class="k" href=")[^"]*/, "$1javascript:alert(1)")],
      ["an unknown class", base.replace(`<h1 class="i"`, `<h1 class="zz"`)],
    ];
    for (const [what, html] of plants) {
      expect(html, `${what}: the plant did not take`).not.toBe(base);
      expect(problems(html), what).not.toEqual([]);
    }
  });
});

describe("templates — every value is text", () => {
  /** Marks, tags, a comment's end and a style's end: none may become markup. */
  const SENTINEL = `"'<i>&</i>--></style>[[x|https://evil.example/]]**b**url(https://evil.example/x)`;
  const HOSTILE_URL = `https://app.ohmail.app/x?a=1&b=|"<'`;
  const CLOSED = new Set(["kind", "locale", "tier", "provider", "currency", "interval", "limitReason", "keptFrom", "limitDropsAt"]);

  for (const s of CUSTOMER) {
    it(`${s.id}: a hostile value in any field renders as its own characters, or the mail is refused without it`, () => {
      const base = render(s);
      const baseDoc = new JSDOM(base.html).window.document;
      const strongs = baseDoc.querySelectorAll("strong").length;
      const comments = commentsOf(baseDoc);
      const data = s.data as Record<string, unknown>;
      for (const key of Object.keys(data)) {
        if (typeof data[key] !== "string") continue;
        const url = /Url$/.test(key);
        let out;
        try {
          out = renderTemplate(s.template, { ...data, [key]: url ? HOSTILE_URL : SENTINEL } as never);
        } catch (e) {
          expect((e as Error).message, `${s.id}.${key}`).not.toContain("evil");
          continue;
        }
        const doc = new JSDOM(out.html).window.document;
        const hostProblems = problems(out.html).filter((p) => !p.startsWith("matched"));
        expect(hostProblems, `${s.id}.${key}`).toEqual([]);
        expect(doc.querySelectorAll("i").length, `${s.id}.${key}`).toBe(0);
        // A closed word outside its set changes the mail (a line drops, the language is English); the rest may not.
        if (CLOSED.has(key)) continue;
        expect(doc.querySelectorAll("strong").length, `${s.id}.${key}`).toBe(strongs);
        expect(commentsOf(doc).length, `${s.id}.${key}`).toBe(comments.length);
        if (!url) {
          expect(commentsOf(doc), `${s.id}.${key}`).toEqual(comments);
          if (base.text.includes(String(data[key]))) {
            expect(doc.documentElement.textContent, `${s.id}.${key}`).toContain(SENTINEL);
          }
        }
      }
    });
  }

  it("a line break inside a value is a space in the text part, never a line of its own", () => {
    for (const nl of ["\n", "\r\n", "\r"]) {
      const out = renderTemplate("new_device_signin", { ...FIXTURES.new_device_signin, ip: `203.0.113.24${nl}Time: 1 January 2020`, device: `Web${nl}IP address: 198.51.100.1` });
      const lines = out.text.split("\n");
      expect(lines.filter((l) => l.startsWith("Time:")), JSON.stringify(nl)).toEqual(["Time: 1 August 2026, 09:05 UTC"]);
      expect(lines.filter((l) => l.startsWith("IP address:")), JSON.stringify(nl)).toEqual(["IP address: 203.0.113.24 Time: 1 January 2020"]);
      expect(lines.filter((l) => l.startsWith("Device:")), JSON.stringify(nl)).toEqual(["Device: Web IP address: 198.51.100.1"]);
      expect(out.text, JSON.stringify(nl)).not.toContain("\r");
    }
  });

  it("an unknown locale is English in every customer template", () => {
    for (const s of CUSTOMER.filter((x) => x.lang === "en")) {
      if (!("locale" in (s.data as object))) continue;
      const odd = renderTemplate(s.template, { ...(s.data as object), locale: "fr" } as never);
      expect(odd.subject, s.id).toBe(render(s).subject);
      expect(odd.html, s.id).toContain(`<html lang="en"`);
    }
  });
});

describe("templates — the html says what the text part says", () => {
  /** The words of a part, with addresses and links left out (the text part writes a link's URL beside its label). */
  const words = (s: string): string[] =>
    s.replace(/\S*[\w-]+\.[a-z]{2,}\S*/gi, " ").match(/[\p{L}\p{N}]+/gu) ?? [];

  for (const s of CUSTOMER) {
    it(`${s.id}`, () => {
      const out = render(s);
      const doc = new JSDOM(out.html).window.document;
      doc.querySelector("body > span")!.remove();            // the hidden preview line repeats the first sentence
      const footer = [...doc.querySelectorAll("td.j > p")];
      const capsule = doc.querySelector("a.k");
      if (capsule) footer[0]!.remove();                       // the html-only line: the capsule's address in words
      const nodes: string[] = [];
      const walk = doc.createTreeWalker(doc.body, 4 /* NodeFilter.SHOW_TEXT */);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) nodes.push(n.textContent ?? "");
      const html = words(nodes.join(" "));
      const lines = out.text.split("\n");
      const text = words(lines.filter((l) => !/^https?:\/\//.test(l) && l !== "--").join("\n"));
      expect(html).toEqual(text);
    });
  }
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
    // A render failure's message is log-destined, and two of these URLs carry a live credential.
    const secret = "SUPER-SECRET-RAW-VERIFICATION-TOKEN-abcdefgh";
    const rejected = [
      `app.ohmail.app/verify-email?token=${secret}`,
      `/verify-email?token=${secret}`,
      `javascript:alert("${secret}")`,
      `http://app.ohmail.app/join?code=${secret}`,
      `${secret}:payload`,
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
    expect(() => safeUrl("SECRET-TOKEN-VALUE:x")).toThrow(/non-https URL scheme "other"/);
  });

  it("an address that is not one plain address is written as words, never as a mailto", () => {
    const out = renderTemplate("billing_link", { ...FIXTURES.billing_link, supportEmail: "a@b.example?cc=c@d.example" });
    const hrefs = [...new JSDOM(out.html).window.document.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs.some((h) => h?.startsWith("mailto:"))).toBe(false);
    expect(out.text).toContain("a@b.example?cc=c@d.example");
  });

  it("the invite makes no claim the invite mechanism cannot keep", () => {
    // `AuthService.register` may check a reusable in-memory `Set`: codes can be global, non-expiring
    // and bound to nobody. "Single-use and tied to this address" is exactly what somebody would rely
    // on when deciding whether forwarding the mail is harmless.
    const { text, html } = renderTemplate("invite", FIXTURES.invite);
    for (const body of [text, html]) {
      expect(body).not.toMatch(/single-use/i);
      expect(body).not.toMatch(/tied to this address/i);
      expect(body).not.toMatch(/only you can/i);
      expect(body).not.toMatch(/reserved for your address/i);
    }
    expect(text).toMatch(/Keep it to yourself/);
  });

  it("never invites the reader to send a secret back, and the credential mails say we never ask", () => {
    for (const s of STATES.filter((x) => ["new_device_signin", "security_notice", "billing_link"].includes(x.template))) {
      expect(render(s).text, s.id).toContain(s.lang === "de"
        ? "Wir fragen dich nie per Mail nach einem Code, einem Passwort oder einem Wiederherstellungscode."
        : "We never ask you for a code, a password or a recovery code by mail.");
    }
    for (const s of STATES) {
      const { text } = render(s);
      expect(text, s.id).not.toMatch(/recovery code:/i);
      expect(text, s.id).not.toMatch(/your password is/i);
    }
  });

  it("the security notices carry no capsule: no link in them changes anything", () => {
    for (const s of STATES.filter((x) => ["new_device_signin", "security_notice"].includes(x.template))) {
      const doc = new JSDOM(render(s).html).window.document;
      expect(doc.querySelector("a.k"), s.id).toBeNull();
      for (const a of doc.querySelectorAll("a")) expect(a.getAttribute("href"), s.id).toMatch(/\/settings\/devices$|^mailto:/);
    }
  });
});

describe("German says Mail and Konto, never E-Mail, Account or Nachricht", () => {
  const de = STATES.filter((s) => s.lang === "de");

  it("in every German mail", () => {
    expect(de).toHaveLength(22);
    for (const s of de) {
      const { subject, text } = render(s);
      for (const part of [subject, text]) {
        expect(part, s.id).not.toMatch(/E-Mail|Account|Nachricht/);
        // Post: every word that holds it is a Postfach word, the German census's own rule (german-says-mail.test.ts).
        for (const w of part.match(/[\p{L}\p{N}-]*post[\p{L}\p{N}-]*/giu) ?? []) expect(/postf(a|ä)ch/i.test(w), `${s.id}: ${w}`).toBe(true);
      }
    }
    expect(de.some((s) => /Konto/.test(render(s).text))).toBe(true);
    expect(de.every((s) => render(s).html.includes(`<html lang="de"`))).toBe(true);
  });
});

describe("the lifecycle notices — every kind, both locales, and no price anywhere", () => {
  const kinds = ["trial_two_days", "closed", "erasure_week"] as const;
  const locales = ["en", "de"] as const;

  it("renders every (kind, locale) pair with the mailbox-untouched promise and no price token", () => {
    for (const kind of kinds) {
      for (const locale of locales) {
        const rendered = renderTemplate("lifecycle_notice", { ...FIXTURES.lifecycle_notice, kind, locale });
        // The one promise every notice carries: the mailbox is not ours to touch.
        expect(rendered.text, `${kind}/${locale} must say the mailbox is untouched`)
          .toMatch(locale === "de" ? /ohmail nichts an|fasst darin nichts an/ : /ohmail touches nothing in/);
        // Nothing about price, plan or currency reaches a published string.
        for (const needle of [/\$\s?\d/, /€/, /CHF/, /price/i, /Preis/i, /\bplan\b/i, /\/month/i, /a month/i]) {
          expect(rendered.text, `${kind}/${locale} text names a price`).not.toMatch(needle);
          expect(rendered.html, `${kind}/${locale} html names a price`).not.toMatch(needle);
        }
      }
    }
  });

  it("the closure without an erasure forecast drops the erasure sentence instead of a blank date", () => {
    for (const locale of locales) {
      const rendered = renderTemplate("lifecycle_notice", { ...FIXTURES.lifecycle_notice, kind: "closed", locale, erasureDate: null });
      expect(rendered.text).not.toMatch(/we erase|löschen wir|null/);
    }
  });

  it("an unknown kind is refused with a message that names no value", () => {
    expect(() => renderTemplate("lifecycle_notice", { ...FIXTURES.lifecycle_notice, kind: "<b>" as never }))
      .toThrow(/^mail template: unknown lifecycle kind$/);
  });

  it("an account with no mailbox is never told ohmail organizes one; it is pointed at the mailbox step and replies reach support", () => {
    const { setupUrl, accountUrl } = FIXTURES.lifecycle_notice;
    for (const locale of locales) {
      for (const kind of ["trial_two_days", "closed"] as const) {
        const out = renderTemplate("lifecycle_notice", { ...FIXTURES.lifecycle_notice, kind, locale, noMailbox: true });
        const said = `${kind}/${locale}`;
        expect(out.text, said).not.toMatch(/organizing your mailbox|stopped organizing|weiter organisiert|organisiert und synchronisiert nicht mehr/);
        expect(out.text, said).toMatch(locale === "de" ? /kein Postfach verbunden/ : /no mailbox connected/);
        expect(out.text, said).toMatch(locale === "de" ? /antworte auf diese Mail/ : /reply to this mail/);
        expect(out.replyTo, said).toBe("support@ohmail.app");
        expect(out.html, said).toContain(`href="${kind === "closed" ? accountUrl : setupUrl}"`);
      }
      const trial = renderTemplate("lifecycle_notice", { ...FIXTURES.lifecycle_notice, kind: "trial_two_days", locale, noMailbox: true });
      expect(trial.text).toContain(setupUrl);
    }
  });

  it("offers the Microsoft sign-in for Microsoft 365 work or school mail only, and no notice names a personal Microsoft mailbox", () => {
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
        ? /Microsoft-365-Postfach deiner Arbeit oder Schule, verbinde es stattdessen unter Einstellungen › Postfächer mit „Outlook verbinden“/
        : /Microsoft 365 work or school account, connect it in Settings › Mailboxes with Connect Outlook instead/);
    }
  });

  it("an account with a mailbox keeps the trial mail, its account link and the deployment's reply address", () => {
    for (const locale of locales) {
      const out = renderTemplate("lifecycle_notice", { ...FIXTURES.lifecycle_notice, kind: "trial_two_days", locale });
      expect(out.text).toMatch(locale === "de" ? /Damit ohmail dein Postfach weiter organisiert/ : /To keep ohmail organizing your mailbox/);
      expect(out.text).toContain(FIXTURES.lifecycle_notice.accountUrl);
      expect(out.text).not.toContain(FIXTURES.lifecycle_notice.setupUrl);
      expect(out.replyTo).toBeUndefined();
    }
  });

  it("the erasure week names the date the erasure keeps, not a plane's date already past", () => {
    for (const locale of locales) {
      const { text, html } = renderTemplate("lifecycle_notice", { ...FIXTURES.lifecycle_notice, kind: "erasure_week", locale });
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
        for (const word of [/stripe/i, /\bplane\b/i, /credit/i, /payment|zahlung/i, /\bprice|preis/i,
          /invoice|\bRechnung/i, /\bcard\b|karte/i, /\$\s?\d|€|CHF/]) {
          expect(part, `${locale} names ${word}`).not.toMatch(word);
        }
      }
    });
  }

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

describe("the connect reminder — once per trial, both languages, advice by login domain, no tracking", () => {
  const SETUP = FIXTURES.connect_reminder.setupUrl;
  const URL_RE = /https?:\/\/[^\s"'<>]+/g;
  const ADDRESS_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const providers = ["gmail", "microsoft", "other"] as const;
  const renderAs = (locale: "en" | "de", provider: (typeof providers)[number]) =>
    renderTemplate("connect_reminder", { ...FIXTURES.connect_reminder, locale, provider });

  it("the provider class comes from the login domain and from nothing else", () => {
    // Joined at run time: the domain is what the class reads.
    const classOf = (domain: string) => providerClassOf(["someone", domain].join("@"));
    expect(["gmail.com", "GoogleMail.com"].map(classOf)).toEqual(["gmail", "gmail"]);
    expect(providerClassOf(` ${["someone", "gmail.com"].join("@")} `)).toBe("gmail");
    expect(["outlook.com", "hotmail.de", "live.co.uk", "msn.com", "outlook.com.au"].map(classOf))
      .toEqual(Array(5).fill("microsoft"));
    expect(["example.com", "mail.gmail.com", "gmail.com.evil.test", "outlookmail.com"].map(classOf))
      .toEqual(Array(4).fill("other"));
    expect(["gmail.com", ""].map(providerClassOf)).toEqual(["other", "other"]);
  });

  for (const locale of ["en", "de"] as const) {
    it(`${locale}: links only to the mailbox step's sign-in door, names no address but support's, no host and no tracking`, () => {
      for (const provider of providers) {
        const out = renderAs(locale, provider);
        const said = `${locale}/${provider}`;
        expect(out.text, said).toContain(SETUP);
        expect(out.html, said).toContain(`href="${SETUP}"`);
        expect(out.html, said).toContain(`lang="${locale}"`);
        expect(out.replyTo, `${said}: replies reach a person`).toBe("support@ohmail.app");
        expect(out.headers, `${said}: a service mail, no unsubscribe header`).toBeUndefined();
        for (const part of [out.subject, out.text, out.html]) {
          for (const url of part.match(URL_RE) ?? []) expect(url, `${said}: another link`).toBe(SETUP);
          for (const a of part.match(ADDRESS_RE) ?? []) expect(a, `${said}: another address`).toBe("support@ohmail.app");
          expect(part, said).not.toMatch(/utm_|imap|smtp|\bport\b|\bhost\b|server/i);
          for (const word of [/\$\s?\d|€|CHF/, /\bplan\b/i, /price|preis/i]) expect(part, said).not.toMatch(word);
        }
      }
    });
  }

  it("says it is sent once and that a person answers, in both languages", () => {
    expect(renderAs("en", "other").text).toMatch(/We send this reminder once\.[^\n]*a person answers/);
    expect(renderAs("de", "other").text).toMatch(/Wir schicken diese Erinnerung nur einmal\.[^\n]*ein Mensch antwortet dir/);
  });

  it("Gmail gets the app password route; every class keeps the Microsoft 365 sign-in; only Microsoft's own domains are told to reply for help", () => {
    for (const locale of ["en", "de"] as const) {
      const gmail = renderAs(locale, "gmail").text;
      expect(gmail).toMatch(locale === "de" ? /App-Passwort[^\n]*Bestätigung in zwei Schritten/ : /app password[^\n]*2-Step Verification/);
      const microsoft = renderAs(locale, "microsoft").text;
      expect(microsoft).toMatch(locale === "de"
        ? /Outlook\.com- oder Hotmail-Adresse[^\n]*antworte auf diese Mail/
        : /Outlook\.com or Hotmail address, reply to this mail/);
      for (const provider of ["microsoft", "other"] as const) {
        expect(renderAs(locale, provider).text, provider).toMatch(locale === "de"
          ? /Microsoft-365-Postfach deiner Arbeit oder Schule[^\n]*„Outlook verbinden“/
          : /Microsoft 365 work or school account[^\n]*Connect Outlook/);
      }
      // A personal Microsoft mailbox is never promised a sign-in it may not have yet.
      for (const provider of providers) {
        expect(renderAs(locale, provider).text, provider).not.toMatch(/(Outlook\.com|Hotmail)[^.\n]*(sign in with Microsoft|bei Microsoft an)/);
      }
      for (const provider of ["gmail", "other"] as const) {
        expect(renderAs(locale, provider).text, provider).not.toMatch(/Hotmail|Outlook\.com/);
      }
    }
  });

  it("an unknown locale is English, and the data carries nothing but the four fields", () => {
    expect(renderTemplate("connect_reminder", { ...FIXTURES.connect_reminder, locale: "fr" as never }).subject)
      .toBe(renderAs("en", "other").subject);
    expect(Object.keys(FIXTURES.connect_reminder).sort()).toEqual(["locale", "provider", "setupUrl", "supportEmail"]);
  });
});

describe("the storage mails — the numbers, the fitted choice, Settings › Storage, and how to stop them", () => {
  const SETTINGS = FIXTURES.storage_near.settingsUrl;
  const URL_RE = /https?:\/\/[^\s"'<>]+/g;
  const ADDRESS_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  for (const name of ["storage_near", "storage_full"] as const) {
    for (const locale of ["en", "de"] as const) {
      it(`${name}/${locale}: links only to Settings › Storage, names no address but support's, carries no token`, () => {
        const out = renderTemplate(name, { ...FIXTURES[name], locale });
        expect(out.html).toContain(`href="${SETTINGS}"`);
        expect(out.html).toContain(`lang="${locale}"`);
        expect(out.replyTo).toBe("support@ohmail.app");
        for (const part of [out.subject, out.text, out.html]) {
          for (const url of part.match(URL_RE) ?? []) expect(url, name).toBe(SETTINGS);
          for (const a of part.match(ADDRESS_RE) ?? []) expect(a, name).toBe("support@ohmail.app");
          expect(part, name).not.toMatch(/token=|manage\?|utm_/);
        }
        // Where to turn them off is said in every one.
        expect(out.text).toMatch(locale === "de" ? /Abschalten kannst du Speicher-Mails unter Einstellungen › Speicher\./
          : /To stop storage mails, turn them off in Settings › Storage\./);
      });
    }
  }

  it("says whose room it is: the trial's, the plan's, or the room kept until a date", () => {
    const first = (reason: "plan" | "trial" | "held", locale: "en" | "de") => renderTemplate("storage_near", {
      ...FIXTURES.storage_near, locale, limitReason: reason, limitDropsAt: reason === "held" ? "2026-11-21T00:00:00.000Z" : null,
    }).text.split("\n").find((l) => /GB (of|von) /.test(l));
    expect(first("trial", "en")).toMatch(/^3\.6 GB of 4 GB used, your trial room\./);
    expect(first("plan", "en")).toMatch(/^3\.6 GB of 4 GB used, your plan's storage\./);
    expect(first("held", "en")).toMatch(/^3\.6 GB of 4 GB used, the room you keep until 21 November 2026\./);
    expect(first("trial", "de")).toMatch(/^3,6 GB von 4 GB belegt, der Speicher deiner Testphase\./);
    expect(first("held", "de")).toMatch(/^3,6 GB von 4 GB belegt, der Platz, den du bis zum 21\. November 2026 behältst\./);
  });

  it("the fitted choice and its price come from the data, in its currency and interval; the largest choice says so", () => {
    const fit = (over: Partial<TemplateDataMap["storage_near"]>) => renderTemplate("storage_near", { ...FIXTURES.storage_near, ...over }).text;
    expect(fit({})).toContain("Plus + 10 GB storage keeps all your mail: 15 GB for $25 a month.");
    expect(fit({ fit: { plan: "pro", addonUnits: 0, roomBytes: 10_000_000_000, amount: 29_000, keepsAll: true }, addonBytes: 0, interval: "year" }))
      .toContain("Pro keeps all your mail: 10 GB for $290 a year.");
    expect(fit({ currency: "chf", fit: { ...FIXTURES.storage_near.fit, amount: 2_450 } }))
      .toContain("15 GB for CHF 24.50 a month.");
    expect(fit({ fit: { plan: "pro", addonUnits: 10, roomBytes: 110_000_000_000, amount: 12_900, keepsAll: false }, addonBytes: 100_000_000_000 }))
      .toContain("Pro + 100 GB storage keeps the most: 110 GB for $129 a month.");
    expect(renderTemplate("storage_near", { ...FIXTURES.storage_near, locale: "de" }).text)
      .toContain("Plus + 10 GB Speicher behält alle deine Mails: 15 GB für 25 $ im Monat.");
  });

  it("full says from when text is kept, and that more room brings the older text back", () => {
    const en = renderTemplate("storage_full", FIXTURES.storage_full).text;
    expect(en).toContain("ohmail Cloud now keeps the text of your newest 4 GB, mail from March 2019 on.");
    expect(en).toContain("ohmail then fetches the older text back from your mail server.");
    const de = renderTemplate("storage_full", { ...FIXTURES.storage_full, locale: "de" }).text;
    expect(de).toContain("alles ab März 2019.");
    expect(renderTemplate("storage_full", { ...FIXTURES.storage_full, keptFrom: null }).text)
      .toContain("ohmail Cloud now keeps the text of your newest 4 GB. Your mail server keeps the older mail");
  });
});
