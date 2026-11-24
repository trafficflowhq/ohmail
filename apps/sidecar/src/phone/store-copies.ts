/**
 * THE DESKTOP'S STORE COPIES, ABSENT — substituted for `../store-copies.js`.
 *
 * A desktop's update keeps copies of its store in its data folder, and its engine removes them
 * when a person signs out or removes a mailbox. A phone's store keeps none in a folder this
 * engine can reach (its own update's copy is the platform store's, `phone/db.ts`), so there is
 * nothing to remove and each call answers at once. Called on a sign-out and a mailbox's removal,
 * so these answer rather than refuse.
 */
export type CopyWhy = "signed_out" | "mailbox_removed" | "taken_back" | "start_cleanup"
  | "owner_changed" | "started_over" | "session_revoked" | "account_erased" | "mailbox_erased";

/** Nothing to remove on a phone. */
export function forgetStoreCopies(_dataDir: string, _why: CopyWhy, _log?: unknown): void {}
