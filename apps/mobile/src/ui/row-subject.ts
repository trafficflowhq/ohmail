/**
 * Whether a mail row draws its subject line. A message with no subject drew an empty line between
 * the sender and the preview; the line stands only when it carries the subject or an amount. The
 * row's spoken name skips an empty subject the same way (`Copy.mailRowAria`).
 */
export function rowSubjectLine(subject: string | null | undefined, amount: string | null | undefined): boolean {
  return (subject ?? "").trim() !== "" || (amount ?? "") !== "";
}
