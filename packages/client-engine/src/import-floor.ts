/**
 * THE FIRST-IMPORT FLOOR'S WINDOW, shared by the web strip and the phone's Screener. The server
 * stamps `initialImportCompletedAt` only on a no-backlog cycle nothing guarantees, so an unwritten
 * stamp is trusted on its own for a bounded time after the mailbox was connected, never for good.
 */

/** A day: an order of magnitude past any measured first import. */
export const IMPORT_FLOOR_MAX_MS = 86_400_000;

/**
 * Stamp unwritten AND connected less than {@link IMPORT_FLOOR_MAX_MS} ago. An absent stamp (a
 * server older than the field) and an unreadable `createdAt` both say no: past the window only a
 * client's own corroboration may keep an import open.
 */
export function importFloorInWindow(
  mailbox: { initialImportCompletedAt?: string | null; createdAt?: string | null },
  now: number,
): boolean {
  if (mailbox.initialImportCompletedAt !== null) return false;
  const connectedAt = new Date(mailbox.createdAt ?? "").getTime();
  return Number.isFinite(connectedAt) && now - connectedAt < IMPORT_FLOOR_MAX_MS;
}
