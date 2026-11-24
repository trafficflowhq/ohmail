import { describe, expect, it } from "vitest";
import { renderTemplate, TEMPLATE_NAMES, type TemplateName } from "../packages/services/src/mail/templates.js";
import { classifySensitivity } from "../packages/core/src/sensitive.js";

/**
 * OUR OWN CREDENTIAL MAILS STILL READ AS SENSITIVE. Every mail ohmail sends a customer is rendered as it
 * goes out and read by ohmail's own classifier, as it reads any letter that arrives: the address
 * confirmation and the new sign-in notice are positively sensitive, and every mail that carries a
 * link or a code that opens something (the confirmation in both languages, the beta invite) is kept
 * from any model. A change of the mails' words or markup that loses that turns this red.
 */
type Lang = "en" | "de";
const SUPPORT = ["support", "ohmail.app"].join("@");
const AT = { en: "26 September 2026, 12:00 UTC", de: "26. September 2026, 12:00 UTC" };
const LIFECYCLE = (lang: Lang) => ({
  locale: lang, anchorDate: lang === "de" ? "16. September 2026, 00:00 UTC" : "16 September 2026, 00:00 UTC",
  erasureDate: lang === "de" ? "16. Oktober 2026, 00:00 UTC" : "16 October 2026, 00:00 UTC",
  accountUrl: "https://app.ohmail.app/#/settings/account", setupUrl: "https://app.ohmail.app/login?next=join", supportEmail: SUPPORT,
});
const STORAGE = (lang: Lang) => ({
  locale: lang, usedBytes: 3_600_000_000, capBytes: 4_000_000_000, limitReason: "trial", limitDropsAt: null,
  expectedBytes: 12_500_000_000, importing: true, keptFrom: "2019-03",
  fit: { plan: "plus", addonUnits: 1, roomBytes: 15_000_000_000, amount: 2_500, keepsAll: true },
  addonBytes: 10_000_000_000, currency: "usd", interval: "month",
  settingsUrl: "https://app.ohmail.app/#/settings/storage", supportEmail: SUPPORT,
});

/** Every customer mail, in every state and language it has: [id, template, data]. */
const STATES: Array<[string, TemplateName, unknown]> = [
  ...(["plus", "desktop", "solo", "pro", "undecided"] as const).map((tier): [string, TemplateName, unknown] =>
    [`waitlist.${tier}.en`, "waitlist_confirmation", { tier, siteUrl: "https://ohmail.app", supportEmail: SUPPORT }]),
  ["beta-invite.en", "invite", {
    code: "OHMAIL-7QR4-2K9F", redeemUrl: "https://app.ohmail.app/join?code=OHMAIL-7QR4-2K9F", expiresAt: "8 August 2026, 09:05 UTC", supportEmail: SUPPORT }],
  ["new-sign-in.en", "new_device_signin", {
    device: "ohmail for Mac", ip: "203.0.113.24", at: "1 August 2026, 09:05 UTC", devicesUrl: "https://app.ohmail.app/settings/devices", supportEmail: SUPPORT }],
  ["new-sign-in.unknown.en", "new_device_signin", {
    device: "Unknown device", ip: "unknown", at: "1 August 2026, 09:05 UTC", devicesUrl: "https://app.ohmail.app/settings/devices", supportEmail: SUPPORT }],
  ...(["en", "de"] as const).flatMap((lang): Array<[string, TemplateName, unknown]> => [
    [`confirm-address.${lang}`, "email_verification", {
      verifyUrl: "https://app.ohmail.app/verify-email?token=Zm9vYmFyLXRva2Vu", expiresIn: lang === "de" ? "24 Stunden" : "24 hours", supportEmail: SUPPORT, locale: lang }],
    [`password-reset.${lang}`, "password_reset", {
      resetUrl: "https://app.ohmail.app/reset-password?token=Zm9vYmFyLXRva2Vu", locale: lang }],
    [`security-notice.password_changed.${lang}`, "security_notice", {
      kind: "password_changed", at: AT[lang], resetUrl: "https://app.ohmail.app/forgot-password", locale: lang }],
    [`account-exists.${lang}`, "account_exists", { signInUrl: "https://ohmail.app/login", supportEmail: SUPPORT, locale: lang }],
    ...(["other", "gmail", "microsoft"] as const).map((provider): [string, TemplateName, unknown] =>
      [`connect-mailbox.${provider}.${lang}`, "connect_reminder", { locale: lang, provider, setupUrl: "https://app.ohmail.app/login?next=join", supportEmail: SUPPORT }]),
    ...(["sign_in_slowed", "factor_refused"] as const).map((kind): [string, TemplateName, unknown] =>
      [`security-notice.${kind}.${lang}`, "security_notice", { kind, at: AT[lang], devicesUrl: "https://ohmail.app/settings/devices", supportEmail: SUPPORT, locale: lang }]),
    ...(["trial_two_days", "closed", "erasure_week"] as const).flatMap((kind) => [false, true].map((noMailbox): [string, TemplateName, unknown] =>
      [`lifecycle.${kind}${noMailbox ? ".no-mailbox" : ""}.${lang}`, "lifecycle_notice", { ...LIFECYCLE(lang), kind, noMailbox }])),
    [`subscription-page.${lang}`, "billing_link", { locale: lang, billingUrl: "https://ohmail.app/account/manage", supportEmail: SUPPORT }],
    [`storage-near.${lang}`, "storage_near", STORAGE(lang)],
    [`storage-full.${lang}`, "storage_full", { ...STORAGE(lang), usedBytes: 4_000_000_000, importing: false }],
  ]),
];

const OPERATOR: TemplateName[] = ["operator_alert", "operator_digest"];

const classified = (template: TemplateName, data: unknown) => {
  const { subject, text, html } = renderTemplate(template, data as never);
  return classifySensitivity({ subject, textBody: text, htmlBody: html, attachments: [] } as unknown as Parameters<typeof classifySensitivity>[0]);
};

describe("ohmail's own mails, read by ohmail's own classifier", () => {
  it("every customer template is here", () => {
    expect([...new Set(STATES.map(([, t]) => t))].sort()).toEqual(TEMPLATE_NAMES.filter((t) => !OPERATOR.includes(t)).sort());
  });

  it("the address confirmation and the new sign-in read as sensitive; every confirmation and the invite stay from any model", () => {
    const verdicts = new Map(STATES.map(([id, template, data]) => [id, classified(template, data)]));
    for (const id of ["confirm-address.en", "new-sign-in.en", "new-sign-in.unknown.en"]) {
      expect(verdicts.get(id)?.verdict, id).toBe("sensitive");
    }
    for (const id of ["confirm-address.en", "confirm-address.de", "beta-invite.en"]) {
      expect(verdicts.get(id)?.flags.no_ai, id).toBe(true);
    }
  });

  it.each(STATES.filter(([, template]) => template === "password_reset" || template === "security_notice"))(
    "%s stays from any model", (_id, template, data) => {
      expect(classified(template, data)).toMatchObject({ verdict: "sensitive", flags: { no_ai: true } });
    },
  );
});
