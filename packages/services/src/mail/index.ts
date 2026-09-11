/**
 * Transactional mail. The template set is CLOSED: waitlist confirmation, invite delivery,
 * new-device sign-in notice, email verification, the account-exists notice — and
 * `operator_alert`, the only non-customer one (the configured operator address, no
 * user-controlled string, the pager's second path). Adding a template is a product decision,
 * argued in `templates.ts`. `ResendMailer` is exported because a composition root must construct
 * the transport — it is NOT what callers hold: no rate limit, no URLs, no token lifecycle;
 * construct once, wrap in `MailService`, pass the service. Under a test runner it refuses to
 * construct without an injected `http` — zero external requests, structurally.
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
