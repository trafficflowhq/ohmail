import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { accounts, mailboxCredentials, mailboxes } from "@trafficflow/db";
import { signedOutMetaOf } from "@trafficflow/services/mail";
import type { LocalDb } from "./db.js";
import { removeFileSynced, writeAtomic } from "./fs-atomic.js";
import { mirrorRowsRemain } from "./local-mirror.js";
import type { Diagnostic } from "./log.js";

/*
 * THE FIRST LOCAL DOOR, UNTIL IT IS SAVED. The window seals the password into a PENDING engine and
 * saves the door after (`doors.ts`), so a quit, a kill, a reload or a failed save in between left
 * the password, or a bare row, for the next first door to run as a second mailbox. Each pending
 * start records its attempt here; the next start keeps it only when it is the shell's save of that
 * address (`OHMAIL_DOOR_SAVE`), and undoes it otherwise (a relaunch, a door switched in Settings),
 * before any mailbox is found or connects. The record holds no secret; desktop only.
 */

export const FIRST_DOOR_ATTEMPT_FILE = "first-door-attempt.json";

export interface FirstDoorAttempt {
  v: 1;
  /** Trimmed and lower-cased. */
  address: string;
  /** No live row carried the address when the attempt began. */
  created: boolean;
  /** The row's incoming password's `updated_at` when the attempt began, or null. */
  kept: string | null;
}

export interface SettleFirstDoorInput {
  dataDir: string;
  /** This start's address. */
  address: string;
  /** This start is a first door the shell has not saved (`OHMAIL_DOOR_PENDING`). */
  pending: boolean;
  /** This start is the shell's save of its own pending first door (`OHMAIL_DOOR_SAVE`). */
  save: boolean;
  now: Date;
  log: Diagnostic;
}

/**
 * Keep or undo the last start's attempt, then record this one if it is pending. Throws when the
 * record cannot be written or the store refuses the undo: the start fails and the next one retries,
 * so nothing connects over a password nobody finished saving.
 */
export async function settleFirstDoorAttempt(db: LocalDb, input: SettleFirstDoorInput): Promise<void> {
  const file = join(input.dataDir, FIRST_DOOR_ATTEMPT_FILE);
  const address = input.address.trim().toLowerCase();
  let last = readAttempt(file);
  if (last === "unreadable") {
    await removeFileSynced(file);
    input.log("first_door_attempt_unreadable", {
      reason: "the record of an unsaved first mailbox could not be read and was removed",
    });
    last = null;
  }
  if (last !== null && input.save && !input.pending && last.address === address) {
    await removeFileSynced(file);
    input.log("first_door_attempt_saved", { reason: "the first mailbox set up here was saved" });
    return;
  }
  if (last !== null) await undoAttempt(db, last, address, input);
  if (!input.pending) {
    if (last !== null) await removeFileSynced(file);
    return;
  }
  const row = await liveRow(db, address);
  const created = row === null || (last?.address === address && last.created);
  const kept = row === null || created ? null : await incomingAt(db, row.id);
  const next: FirstDoorAttempt = { v: 1, address, created, kept };
  writeAtomic(file, JSON.stringify(next), 0o600);
}

/** The record, `null` when there is none, or `"unreadable"`. */
function readAttempt(file: string): FirstDoorAttempt | null | "unreadable" {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof FirstDoorAttempt, unknown>> | null;
    if (v?.v === 1 && typeof v.address === "string" && typeof v.created === "boolean"
      && (v.kept === null || typeof v.kept === "string")) {
      return { v: 1, address: v.address, created: v.created, kept: v.kept };
    }
  } catch { /* torn or not JSON */ }
  return "unreadable";
}

/** The live row for an address, found as `ensureLocalWorld` finds it. */
async function liveRow(db: LocalDb, address: string): Promise<{ id: string } | null> {
  const [account] = await db.select({ id: accounts.id }).from(accounts).limit(1);
  if (!account) return null;
  const rows = await db.select({ id: mailboxes.id, address: mailboxes.address }).from(mailboxes)
    .where(and(
      eq(mailboxes.accountId, account.id),
      sql`(${mailboxes.status} <> 'disabled' or ${mailboxes.disabledReason} is not null)`,
    ))
    .orderBy(sql`(${mailboxes.status} <> 'disabled') desc`, mailboxes.createdAt, mailboxes.id);
  return rows.find((r) => r.address.trim().toLowerCase() === address) ?? null;
}

async function incomingAt(db: LocalDb, mailboxId: string): Promise<string | null> {
  const [row] = await db.select({ at: mailboxCredentials.updatedAt }).from(mailboxCredentials)
    .where(and(eq(mailboxCredentials.mailboxId, mailboxId), eq(mailboxCredentials.transport, "imap")))
    .limit(1);
  return row ? row.at.toISOString() : null;
}

async function undoAttempt(
  db: LocalDb, last: FirstDoorAttempt, address: string, input: SettleFirstDoorInput,
): Promise<void> {
  const row = await liveRow(db, last.address);
  if (row === null) return;
  const undone = (verdict: string, reason: string): void => {
    input.log("first_door_attempt_undone", { mailboxId: row.id, verdict, reason });
  };
  if (!last.created) {
    if (await incomingAt(db, row.id) === last.kept) return;
    // A row the install already had: the attempt's password goes, the row and its mail stay.
    await db.transaction(async (tx) => {
      const [mb] = await tx.select({ kept: mailboxes.signedOutMeta }).from(mailboxes)
        .where(eq(mailboxes.id, row.id));
      const held = await tx.select({ transport: mailboxCredentials.transport, meta: mailboxCredentials.meta })
        .from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, row.id));
      const column = (mb?.kept ?? {}) as Record<string, unknown>;
      await tx.update(mailboxes).set({
        signedOutAt: input.now,
        signedOutMeta: signedOutMetaOf([
          ...held,
          { transport: "imap", meta: column.imap },
          { transport: "smtp", meta: column.smtp },
        ]),
      }).where(eq(mailboxes.id, row.id));
      await tx.delete(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, row.id));
    });
    undone("signed_out", "a first mailbox set up here was not saved, so the password it stored "
      + "on a mailbox this computer already had was removed; its mail stays");
    return;
  }
  if (last.address !== address && !(await mirrorRowsRemain(db, row.id))) {
    const removed = await db.transaction(async (tx) => {
      await tx.delete(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, row.id));
      await tx.delete(mailboxes).where(eq(mailboxes.id, row.id));
    }).then(() => true, () => false);
    if (removed) {
      undone("removed", "a first mailbox set up here was not saved and another was set up after "
        + "it, so the mailbox it added was removed with its password");
      return;
    }
  }
  const cleared = await db.delete(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, row.id))
    .returning({ transport: mailboxCredentials.transport });
  if (cleared.length === 0) return;
  undone("cleared", "a first mailbox set up here was not saved, so the password it stored was "
    + "removed before anything could use it");
}
