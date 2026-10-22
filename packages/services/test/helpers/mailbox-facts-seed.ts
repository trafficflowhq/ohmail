import { and, count, eq, isNull, ne, or } from "drizzle-orm";
import type { makeTestDb } from "@trafficflow/db/testing";
import {
  accounts, folderState, mailboxCredentials, mailboxFolders, mailboxes, messageFailures, messages,
  ourOutstandingFiling,
} from "@trafficflow/db";
import { makeMailboxService, type ServiceContext } from "@trafficflow/services";

/**
 * The seed behind `mailbox-facts-batched.golden.json`, shared by the PGlite/SQLite file and its
 * real-Postgres twin so all three stores answer against one golden file.
 */

export type Db = Awaited<ReturnType<typeof makeTestDb>>;

export const NOW = new Date("2026-10-21T10:00:00.000Z");
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
export const at = (ms: number): Date => new Date(NOW.getTime() + ms);
export const id = (tail: string): string => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;

export const A = id("a0");
export const B = id("b0");
// A's and B's mailboxes interleave by id, the order `list` reads them in.
export const organizer = id("1"), theirFirst = id("2"), inError = id("3"), theirSecond = id("4");
export const heldReader = id("5"), theirThird = id("6"), erasing = id("7"), erased = id("9"), gapReader = id("b");
export const settled = id("d");

export const svc = makeMailboxService({
  installId: "install-here",
  lastOrganizerCycleAt: async () => "2026-10-21T09:59:00.000Z",
});

export const ctxFor = (db: Db, accountId: string, now: () => Date = () => NOW): ServiceContext =>
  ({ db, accountId, userId: null, now, requestId: "r" });

let seq = 0;

/** A message, and its filing unless `row` is null. */
export async function filing(db: Db, accountId: string, mailboxId: string, row: null | {
  updatedAt: Date; attempts?: number; nextAttemptAt?: Date | null; lastErrorClass?: string | null;
  by?: "us" | "external"; desired?: string; observed?: string; status?: "pending" | "reconciled";
}): Promise<void> {
  seq += 1;
  const [m] = await db.insert(messages).values({
    accountId, mailboxId, dedupKey: `mid:<mfb-${seq}@example.test>`, messageIdHeader: `<mfb-${seq}@example.test>`,
    fromAddress: "stranger@example.test", subject: `s${seq}`, date: NOW, bodyHash: `mfb-hash-${seq}`,
  }).returning();
  if (row === null) return;
  await db.insert(folderState).values({
    messageId: m!.id, desiredFolder: row.desired ?? "ohmail/News", observedFolder: row.observed ?? "INBOX",
    reconcileStatus: row.status ?? "pending", lastSetBy: row.by ?? "us", updatedAt: row.updatedAt,
    attempts: row.attempts ?? 0, nextAttemptAt: row.nextAttemptAt ?? null, lastErrorClass: row.lastErrorClass ?? null,
  });
}

export async function failure(db: Db, accountId: string, mailboxId: string, uid: number, resolved: boolean): Promise<void> {
  await db.insert(messageFailures).values({
    accountId, mailboxId, folder: "INBOX", uidvalidity: 1n, uid, code: "mime_unparseable",
    resolvedAt: resolved ? at(-MIN) : null,
  });
}

export async function cred(db: Db, mailboxId: string, transport: "imap" | "smtp", meta: unknown): Promise<void> {
  await db.insert(mailboxCredentials).values({ mailboxId, transport, secretEnc: "sealed", keyVersion: 1, meta });
}

export async function folder(db: Db, mailboxId: string, f: {
  folder: string; updatedAt: Date; highestmodseq?: bigint; serverExists?: number; budgetStopUid?: bigint;
}): Promise<void> {
  await db.insert(mailboxFolders).values({
    mailboxId, folder: f.folder, updatedAt: f.updatedAt, highestmodseq: f.highestmodseq ?? null,
    serverExists: f.serverExists ?? null, budgetStopUid: f.budgetStopUid ?? null,
    budgetStopUidvalidity: f.budgetStopUid === undefined ? null : 9n,
  });
}

/** Account A: seven mailboxes in different states, one a finished erasure; account B beside it. */
export async function seed(db: Db): Promise<void> {
  await db.insert(accounts).values([{ id: A, name: "mfb-a" }, { id: B, name: "mfb-b" }]);

  // An organizer with every kind of filing, failures, both credentials and folders out of order.
  await db.insert(mailboxes).values({
    id: organizer, accountId: A, provider: "imap", address: "a1@example.test", displayName: "Alpha",
    createdAt: at(-3 * DAY), lastSyncAt: at(-MIN), initialImportCompletedAt: at(-DAY),
    organizeConsentedAt: at(-2 * DAY), junkFolder: "Spam", smtpMaxSizeBytes: 26_214_400,
    inboundQuietSince: at(-HOUR), inboundQuietDismissedAt: at(-30 * MIN), organizerEventAt: at(-2 * HOUR),
    organizerEventSeenAt: at(-90 * MIN), gapSince: at(-DAY), gapLetters: 7,
  });
  await cred(db, organizer, "imap", { host: "imap.gmail.com", port: 993, secure: true, smtpUnsettled: "auth" });
  await cred(db, organizer, "smtp", { host: "smtp.gmail.com", port: 465, smtpUnsettled: "tls" });
  await folder(db, organizer, { folder: "Sent", highestmodseq: 7n, serverExists: 30, updatedAt: at(-2 * MIN) });
  await folder(db, organizer, { folder: "Archive", updatedAt: at(-5 * MIN), budgetStopUid: 12n });
  await folder(db, organizer, { folder: "INBOX", highestmodseq: 100n, serverExists: 120, updatedAt: at(-MIN) });
  await filing(db, A, organizer, { updatedAt: at(-10_000) });
  await filing(db, A, organizer, { updatedAt: at(-2 * MIN), attempts: 1, nextAttemptAt: at(HOUR), lastErrorClass: "no_such_folder" });
  await filing(db, A, organizer, {
    updatedAt: at(-HOUR), attempts: 1, nextAttemptAt: at(-MIN), lastErrorClass: "read_only", desired: "Receipts",
  });
  await filing(db, A, organizer, { updatedAt: at(-HOUR), by: "external", desired: "X", observed: "Y" });
  await filing(db, A, organizer, { updatedAt: at(-HOUR), status: "reconciled" });
  await filing(db, A, organizer, { updatedAt: at(-HOUR), desired: "INBOX", observed: "INBOX" });
  await filing(db, A, organizer, null);
  await failure(db, A, organizer, 1, false);
  await failure(db, A, organizer, 2, false);
  await failure(db, A, organizer, 3, true);

  // In error, signed in with OAuth, blocked, and a credential naming no host.
  await db.insert(mailboxes).values({
    id: inError, accountId: A, provider: "imap", address: "a3@example.test", createdAt: at(-2 * DAY), status: "error",
    errorCode: "timeout", errorDetail: "ETIMEDOUT", failedAt: at(-5 * MIN), retryCount: 3, authKind: "oauth",
    syncBlockedReason: "lease_unreadable", syncBlockedSince: at(-10 * MIN),
  });
  await cred(db, inError, "imap", { host: "" });
  await failure(db, A, inError, 1, false);

  // A disabled reader whose holder is this install, with a release that was refused.
  await db.insert(mailboxes).values({
    id: heldReader, accountId: A, provider: "imap", address: "a5@example.test", createdAt: at(-DAY), status: "disabled",
    disabledReason: "organized_elsewhere:local", organizerRole: "reader", organizedByKind: "local",
    organizedByName: "Office laptop", organizedByInstallId: "install-here", organizedSince: at(-7 * DAY),
    organizerState: "held", organizedByCapabilities: "requests,profiles", releaseRequestedAt: at(-HOUR),
    releaseRefusal: "sibling_lapse", takeoverAuthorizedAt: at(-3 * HOUR), organizerParkedAt: at(-4 * HOUR),
    lastSyncAt: at(-2 * HOUR), gapSince: at(-DAY), gapLetters: 3,
  });
  await cred(db, heldReader, "imap", { host: "imap.mail.me.com" });
  await folder(db, heldReader, { folder: "INBOX", highestmodseq: 3n, serverExists: 0, updatedAt: at(-3 * MIN) });
  await filing(db, A, heldReader, { updatedAt: at(-20 * MIN), lastErrorClass: "refused" });

  // Still being erased, two letters left; and an erasure that finished, which is not listed.
  await db.insert(mailboxes).values({
    id: erasing, accountId: A, provider: "imap", address: "a7@example.test", createdAt: at(-HOUR), status: "disabled",
    erasedAt: at(-MIN),
  });
  await filing(db, A, erasing, null);
  await filing(db, A, erasing, null);
  await db.insert(mailboxes).values({
    id: erased, accountId: A, provider: "imap", address: "a9@example.test", createdAt: at(-30 * DAY), status: "disabled",
    erasedAt: at(-DAY), erasureDoneAt: at(-23 * HOUR),
  });

  // A reader with a gap and no credential at all.
  await db.insert(mailboxes).values({
    id: gapReader, accountId: A, provider: "imap", address: "ab@example.test", createdAt: at(-MIN), organizerRole: "reader",
    gapSince: at(-DAY), gapLetters: 2,
  });

  // Every filing settled or not ours: rows in `folder_state`, none of them outstanding, some with
  // refusals and attempts an outstanding row would report.
  await db.insert(mailboxes).values({
    id: settled, accountId: A, provider: "imap", address: "ad@example.test", createdAt: at(-2 * HOUR), lastSyncAt: at(-MIN),
  });
  await filing(db, A, settled, { updatedAt: at(-DAY), status: "reconciled", desired: "Archive", observed: "Archive" });
  await filing(db, A, settled, {
    updatedAt: at(-DAY), attempts: 4, nextAttemptAt: at(HOUR), lastErrorClass: "over_quota", by: "external",
    desired: "Receipts", observed: "INBOX",
  });
  await filing(db, A, settled, {
    updatedAt: at(-HOUR), attempts: 3, lastErrorClass: "read_only", desired: "INBOX", observed: "INBOX",
  });
  await filing(db, A, settled, {
    updatedAt: at(-HOUR), attempts: 2, lastErrorClass: "refused", status: "reconciled", desired: "Archive", observed: "INBOX",
  });

  // B's mailboxes carry every fact too, and a refusal with more attempts than any of A's.
  for (const [mb, address] of [[theirFirst, "b2@example.test"], [theirSecond, "b4@example.test"], [theirThird, "b6@example.test"]] as const) {
    await db.insert(mailboxes).values({
      id: mb, accountId: B, provider: "imap", address, createdAt: at(-DAY), lastSyncAt: at(-MIN),
    });
    await cred(db, mb, "imap", { host: "imap.gmail.com", smtpUnsettled: "tls" });
    await folder(db, mb, { folder: "Zzz", updatedAt: at(-MIN) });
    await folder(db, mb, { folder: "INBOX", highestmodseq: 9n, serverExists: 999, updatedAt: at(-MIN), budgetStopUid: 1n });
    await filing(db, B, mb, { updatedAt: at(-2 * HOUR), attempts: 5, nextAttemptAt: at(HOUR), lastErrorClass: "refused" });
    await filing(db, B, mb, { updatedAt: at(-MIN) });
    await failure(db, B, mb, 1, false);
    await failure(db, B, mb, 2, false);
  }
}

/** An account with `n` connected mailboxes, each with a credential, two folders, a filing and a failure. */
export async function seedPlain(db: Db, accountId: string, n: number): Promise<void> {
  await db.insert(accounts).values({ id: accountId, name: `mfb-${n}` });
  for (let i = 0; i < n; i++) {
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `p${n}-${i}@example.test`, createdAt: at(-DAY), lastSyncAt: at(-MIN),
    }).returning();
    await cred(db, mb!.id, "imap", { host: "imap.example.test" });
    await folder(db, mb!.id, { folder: "INBOX", highestmodseq: 1n, serverExists: 10, updatedAt: at(-MIN) });
    await folder(db, mb!.id, { folder: "Archive", updatedAt: at(-MIN) });
    await filing(db, accountId, mb!.id, { updatedAt: at(-MIN) });
    await failure(db, accountId, mb!.id, 1, false);
  }
}

/** The answer the golden file holds: A's list with and without counts, B's list, an empty account. */
export async function goldenAnswer(db: Db): Promise<string> {
  const answer = {
    list: await svc.list(ctxFor(db, A)),
    counts: await svc.list(ctxFor(db, A), { counts: true }),
    otherAccount: await svc.list(ctxFor(db, B)),
    empty: await svc.list(ctxFor(db, id("e0"))),
  };
  return `${JSON.stringify(answer, null, 2)}\n`;
}

export const GOLDEN = "./__snapshots__/mailbox-facts-batched.golden.json";

/** Outstanding filings whose `outstanding_account_id` is not their message's account: always 0. */
export async function outstandingDrift(db: Db): Promise<number> {
  const [r] = await db.select({ n: count() }).from(folderState)
    .innerJoin(messages, eq(messages.id, folderState.messageId))
    .where(and(ourOutstandingFiling(), or(
      isNull(folderState.outstandingAccountId), ne(folderState.outstandingAccountId, messages.accountId))));
  return Number(r!.n);
}
