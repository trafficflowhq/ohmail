import type { NormalizedMessage } from "@trafficflow/core";

/**
 * THE PERSISTED ROW IN THE SHAPE THE RULES LAYER READS — one projection for every pass that
 * evaluates rules against stored mail.
 *
 * The rules layer looks at four things: sender, subject, headers and — since `body_contains`
 * (mail 0052) — the plain text, all already on disk, so this opens no IMAP and re-parses no MIME.
 * `htmlBody` stays empty because no rule reads it; if one ever does, this is where that becomes a
 * visible lie.
 *
 * `textBody` IS AN ARGUMENT, because the one pass that differs differs only here: the Screener
 * auto-apply feeds `migrationBulkPlacement`, which reads headers and the subject and never runs
 * `evaluateRules`, so it passes `""` deliberately. As a third copy that was an invisible
 * difference; as an argument it is stated where it is chosen.
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
