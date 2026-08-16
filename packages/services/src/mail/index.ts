/**
 * Transactional mail.
 *
 * The template set is closed: waitlist confirmation, invite
 * delivery, new-device sign-in notice, email verification, the account-exists notice — and
 * `operator_alert`, which
 * is the only one that is not customer mail (it goes to the configured operator
 * address, carries no user-controlled string, and is the second delivery path for the
 * pager so a single vendor outage cannot silence it). Stripe's Dashboard sends
 * invoices, receipts and dunning; ohmail sends none of those, and adding a
 * template is a product decision, argued at its definition in `templates.ts`.
 *
 * ⚠ `ResendMailer` is exported because a composition root has to construct the
 * transport, and there is no way to inject one without naming it. It is NOT the thing
 * callers should hold: it enforces no rate limit, builds no URLs and owns no token
 * lifecycle. Construct it once, wrap it in `MailService`, pass the service. Under a
 * test runner it refuses to construct at all without an injected `http` — the suite
 * performs zero external requests, structurally.
 */
export {
  type MailerPort, type MailSendResult, type SendOptions, type SkipReason,
  type OutboundEmail, normalizeRecipient,
} from "./port.js";
export {
  renderTemplate, esc, safeUrl, TEMPLATE_NAMES,
  type RenderedEmail, type TemplateName, type TemplateDataMap, type WaitlistTier,
  type WaitlistConfirmationData, type InviteData,
  type NewDeviceSignInData, type EmailVerificationData, type OperatorAlertData,
} from "./templates.js";
export { mailAlertSink } from "./alert-sink.js";
export {
  ResendMailer, nodeHttpPost, type HttpPost, type ResendMailerConfig,
} from "./resend-mailer.js";
export { SpyMailer, disabledMailer, type SpiedSend } from "./spy-mailer.js";
export {
  MailService, makeMailService, formatUtc, EMAIL_VERIFY_PURPOSE, DEFAULT_LINK_ORIGINS,
  dbRecipientLimiter,
  type MailContext, type MailServiceConfig, type MailServiceDeps,
  // The narrow port the operator-alert sink holds instead of a runtime `Db`.
  type RecipientLimiter, type OperatorAlertContext,
} from "./mail-service.js";
