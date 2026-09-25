import { eq } from "drizzle-orm";
import { mailboxes, type SignedOutMeta, type SignedOutTransportMeta, type Tx } from "@trafficflow/db";
import type { Dialect, LockMode } from "@trafficflow/db/dialect";
import { ServiceError } from "./errors.js";

/**
 * THE SIGN-OUT FENCE, DURABLE HALF. A credential write dials first and commits seconds later, so a
 * sign-out can run to completion inside that window: prove the row gone, answer, and then watch the
 * writer commit. `FOR UPDATE` in the clear serializes such a writer, not its committing right after,
 * and the engine's epoch (`apps/sidecar/src/signout-fence.ts`) is in MEMORY — blind to the shared
 * `PATCH /mailboxes/:id`, which is what a paired phone sends. So the clear stamps the column.
 *
 * COMPARE-AND-SET, not a clock comparison: the writer records the stamp as it stood when it began,
 * the fence re-reads it under the row lock, and a value that differs IS a sign-out in between.
 */

/**
 * Where the credential a write is about to seal stands relative to the mailbox row.
 *
 * Two states, named rather than an optional date, because they are genuinely different questions
 * and a `null` would collapse them: a write that MINTS the row cannot be overtaken by a sign-out
 * of a mailbox that did not exist, while a write onto a row that was already there must say what
 * the stamp read when it started.
 */
export type CredentialOrigin =
  /** This transaction creates the mailbox row — there is no earlier sign-out of it to overtake. */
  | { row: "minted-here" }
  /** `mailboxes.signed_out_at` as this write read it BEFORE it dialled anything. */
  | { row: "already-there"; signedOutAt: Date | null };

/**
 * `mailboxes.signed_out_at`, read under a lock. `undefined` when no such row exists — the caller's
 * own 404 is what says so, and this function has nothing to add to it.
 */
export async function readMailboxSignedOutAt(
  tx: Tx, d: Dialect, mailboxId: string, mode: LockMode = "update",
): Promise<Date | null | undefined> {
  const [row] = await d.forUpdate(
    tx.select({ signedOutAt: mailboxes.signedOutAt })
      .from(mailboxes)
      .where(eq(mailboxes.id, mailboxId))
      .limit(1),
    { mode });
  if (row === undefined) return undefined;
  return row.signedOutAt;
}

/**
 * The refusal every credential writer answers when a sign-out overtook it — one sentence, both
 * doors. 409: the request was well formed and the state moved under it, and pressing again a
 * moment later is exactly the recovery the message names.
 */
export function signedOutMidWrite(): ServiceError {
  return new ServiceError(
    "signed_out", 409,
    "you signed out while this password was being checked, so it was not kept. " +
      "Sign in again to store it.",
  );
}

/**
 * Refuse a credential write that a sign-out overtook. MUST run inside the writing transaction and
 * after it holds the mailbox row, so the value read here is the one the write commits against.
 *
 * A row that vanished is left to the caller's own 404: an absent mailbox is not a sign-out, and
 * refusing here would turn the fence into an existence check nobody asked for.
 */
export async function fenceSignedOutMailbox(
  tx: Tx, d: Dialect, mailboxId: string, origin: CredentialOrigin,
): Promise<void> {
  if (origin.row === "minted-here") return;
  const now = await readMailboxSignedOutAt(tx, d, mailboxId);
  if (now === undefined) return;
  const then = origin.signedOutAt;
  const same = now === null ? then === null : then !== null && now.getTime() === then.getTime();
  if (!same) throw signedOutMidWrite();
}

/** The transports a sign-out keeps coordinates for: the two a password mailbox dials. */
const KEPT_TRANSPORTS = ["imap", "smtp"] as const;

/**
 * One transport's coordinates out of a credential row's `meta` (or out of the column itself), by
 * ALLOW-LIST: `host`, `port`, `secure` and `user`, each only in its own type. Anything else a
 * `meta` carries — a consent marker, a witness, an OAuth block, a key somebody adds tomorrow — is
 * dropped, so no reader of the column can be handed more than where the server is.
 */
export function keptTransportMeta(value: unknown): SignedOutTransportMeta | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const kept: SignedOutTransportMeta = {};
  if (typeof v.host === "string" && v.host.trim() !== "") kept.host = v.host;
  if (typeof v.port === "number" && Number.isInteger(v.port)) kept.port = v.port;
  if (typeof v.secure === "boolean") kept.secure = v.secure;
  if (typeof v.user === "string" && v.user !== "") kept.user = v.user;
  return kept.host === undefined ? null : kept;
}

/**
 * THE ONLY VALUE WRITTEN INTO `mailboxes.signed_out_meta` — built from the credential rows a
 * sign-out is about to delete. `null` when none of them names a server. A census
 * (`test/signed-out-meta-census.test.ts`) refuses any other expression written to the column.
 */
export function signedOutMetaOf(
  rows: readonly { transport: string; meta: unknown }[],
): SignedOutMeta | null {
  const out: SignedOutMeta = {};
  for (const t of KEPT_TRANSPORTS) {
    const kept = keptTransportMeta(rows.find((r) => r.transport === t)?.meta);
    if (kept) out[t] = kept;
  }
  return out.imap || out.smtp ? out : null;
}

/** What the column kept for one transport, re-read through the same allow-list. */
export function signedOutTransportMeta(
  column: unknown, transport: "imap" | "smtp",
): SignedOutTransportMeta | null {
  if (typeof column !== "object" || column === null) return null;
  return keptTransportMeta((column as Record<string, unknown>)[transport]);
}
