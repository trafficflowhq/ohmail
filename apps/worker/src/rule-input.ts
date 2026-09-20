import type { NormalizedMessage } from "@trafficflow/core";

/**
 * THE PERSISTED ROW IN THE SHAPE THE RULES LAYER READS — one projection per pass that evaluates
 * rules against stored mail. Sender, subject, headers and (since `body_contains`, mail 0052) the
 * plain text, all already on disk: no IMAP, no MIME re-parse. `htmlBody` stays empty because no
 * rule reads it.
 *
 * `textBody` IS AN ARGUMENT, because the one pass that differs differs only here — the Screener
 * auto-apply feeds the bulk router, never `evaluateRules`, and passes `""`. As a third copy that
 * was invisible; as an argument it is stated where it is chosen.
 */
export function asRuleInput(
  row: { subject: string; fromAddress: string; headers: Record<string, string[]> },
  textBody: string,
): NormalizedMessage {
  return {
    canonical: { messageIdHeader: null, bodyHash: "" },
    subject: row.subject,
    from: { name: null, address: row.fromAddress.toLowerCase() },
    to: [],
    cc: [],
    date: null,
    headers: row.headers,
    textBody,
    htmlBody: null,
    hasAttachments: false,
    attachments: [],
  };
}
