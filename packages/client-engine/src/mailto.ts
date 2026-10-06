/**
 * The one mailto parser, re-exported for the phone: it compiles this package and not core's leaves
 * directly. See `@trafficflow/core/mailto`.
 */
export { emptyDraft, isMailto, parseMailto, type MailtoDraft } from "@trafficflow/core/mailto";
