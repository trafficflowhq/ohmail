/**
 * EACH MAILBOX'S RECORDED SENT FOLDER (`mailboxes.sent_folder`, as `GET /mailboxes` reports it):
 * the server's own name for Sent when no Sent-shaped name says so ('Envoyés', 'INBOX.Verzonden').
 * A leaf, so `isOwnSent` reads it without a caller passing a map. Written only by
 * `OhmailEngine.setSentFolders`, and at hydration from the copy kept with the mirror
 * (`SENT_FOLDERS_META`), so a start knows them before the first read lands.
 */
const recorded = new Map<string, string>();

export function recordedSentFolderOf(mailboxId: string | null | undefined): string | null {
  return mailboxId == null ? null : recorded.get(mailboxId) ?? null;
}

/** Replaces the whole statement. The engine's writer; not exported from the package. */
export function replaceRecordedSentFolders(next: ReadonlyMap<string, string>): void {
  recorded.clear();
  for (const [id, path] of next) recorded.set(id, path);
}
