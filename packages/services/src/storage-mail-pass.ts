import { and, desc, eq, gt, gte, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  accountSettings, accountStorage, fencedAccountWrite, inPlaneRounds, storageEmptyingNow, users,
  type AccessVerdict, type EntitlementsPort, type StorageOffer, type Tx,
} from "@trafficflow/db";
import {
  AT_CAP_READ_BOUND, AT_CAP_READ_LIMIT, storageHoldsOf, storageLimitFrom, storageLimitReason, storagePrefsOf,
  storageReadingOf, storageMailSent,
} from "@trafficflow/db/cloud";
import { dialect } from "@trafficflow/db/dialect";
import { silentLogger, type Logger } from "@trafficflow/core";
import { bridgeDb, bridgeTx, type Db } from "./context.js";
import type { MailContext } from "./mail/index.js";

/**
 * THE STORAGE MAILS (cloud 0057) — one at 90% of the cap the account's storage is held to, and one when
 * it is full (at the cap, or while the cap is what empties text now), hourly from the API host, which
 * holds the transactional mail. The plane sends no mail. Candidates are the accounts storing the most,
 * read as the at-cap alert reads them (`AT_CAP_READ_LIMIT` accounts, under `AT_CAP_READ_BOUND`), whose
 * lifecycle is `trialing` or `active`. A mail is owed only when the program answered a storage offer it
 * may change (`canChange`), so its fitted choice is one the person can take; the button opens Settings ›
 * Storage, signed in, and no mail carries a manage token. Once per (account, level, cap) by
 * `storage_mail_sent`'s key, never two within {@link STORAGE_MAIL_GAP_MS} (an advisory lock and a read in
 * the claim's transaction), none while the person turned them off.
 */

/** The share of the cap the first mail is owed at. */
export const STORAGE_MAIL_NEAR_RATIO = 0.9;
/** The least time between two storage mails to one account. */
export const STORAGE_MAIL_GAP_MS = 7 * 24 * 60 * 60 * 1000;
/** How old an undelivered claim is before a pass may claim it again. */
export const STORAGE_MAIL_CLAIM_STALE_MS = 60 * 60 * 1000;
/** Mails one run sends at most; the rest wait an hour. */
export const STORAGE_MAILS_PER_RUN = 25;
/** One run's wall clock, under the platform's 60 s ceiling; checked before each account. */
export const STORAGE_MAILS_BUDGET_MS = 45_000;
/** The `classid` of the claim's `pg_advisory_xact_lock`, one account at a time. */
export const STORAGE_MAIL_LOCK_CLASS = 420_727_021;

export type StorageMailLevel = "near" | "full";

/** What one storage mail says; the mail service renders it in the account's language. */
export interface StorageNoticeMail {
  to: string;
  locale: "en" | "de";
  level: StorageMailLevel;
  usedBytes: number;
  capBytes: number;
  limitReason: "plan" | "trial" | "held";
  limitDropsAt: string | null;
  expectedBytes: number;
  importing: boolean;
  keptFrom: string | null;
  fit: StorageOffer["fit"];
  /** The storage the fitted choice adds on top of its plan's own room. */
  addonBytes: number;
  currency: string;
  interval: StorageOffer["interval"];
}

/** The one method this pass needs of `MailService`, structural for the lifecycle pass's reason. */
export interface StorageNoticeMailer {
  sendStorageNotice?(ctx: MailContext, input: StorageNoticeMail): Promise<{ status: "sent" | "skipped" | "failed" }>;
}

export interface StorageMailPassDeps {
  port: EntitlementsPort;
  mail: StorageNoticeMailer | null;
  now: () => Date;
  log?: Logger;
  /** Test seams: the wall clock and its budget. */
  clock?: () => number;
  budgetMs?: number;
}

export interface StorageMailPassResult {
  /** Accounts the program answered about, of the candidates read. */
  read: number;
  total: number;
  /** Accounts at 90% or full, trialing or active. */
  due: number;
  sent: { near: number; full: number };
  /** Mailed already at this level and cap, or within the week. */
  already: number;
  /** Turned off by the person. */
  off: number;
  /** No offer the person can take: no mail. */
  noOffer: number;
  /** Claimed, and no recipient was sent it. */
  skipped: number;
  /** Owed, and no mailer is configured: nothing claimed. */
  unmailable: number;
  faults: number;
  /** The run stopped at its mail count or its budget. */
  capped: boolean;
}

/** The level a counter owes against the cap held, or null. */
export function storageMailLevelOf(
  counter: { usedBytes: number; lastEmptiedAt: string | null }, capBytes: number, now: Date,
): StorageMailLevel | null {
  if (capBytes <= 0) return null;
  if (storageEmptyingNow(counter, capBytes, now)) return "full";
  return counter.usedBytes >= capBytes * STORAGE_MAIL_NEAR_RATIO ? "near" : null;
}

const asDate = (v: Date | string | null): Date | null => (v === null ? null : new Date(v));

/** The room the fitted choice's storage units add: its room past its plan's own. */
export function addonBytesOf(offer: StorageOffer): number {
  const plan = offer.plans.find((p) => p.plan === offer.fit.plan);
  return plan === undefined ? 0 : Math.max(0, offer.fit.roomBytes - plan.roomBytes);
}

export async function runStorageMailPass(db: Db, deps: StorageMailPassDeps): Promise<StorageMailPassResult> {
  const log = deps.log ?? silentLogger;
  const clock = deps.clock ?? Date.now;
  const started = clock();
  const budget = deps.budgetMs ?? STORAGE_MAILS_BUDGET_MS;
  const tx = bridgeTx(db);
  const result: StorageMailPassResult = {
    read: 0, total: 0, due: 0, sent: { near: 0, full: 0 }, already: 0, off: 0, noOffer: 0, skipped: 0,
    unmailable: 0, faults: 0, capped: false,
  };
  const rows = await tx.select({
    accountId: accountStorage.accountId, bytes: accountStorage.bytes, last: accountStorage.lastHuskedAt,
    keptFrom: accountStorage.keptFrom,
  }).from(accountStorage).where(gt(accountStorage.bytes, 0))
    .orderBy(desc(accountStorage.bytes)).limit(AT_CAP_READ_LIMIT);
  result.total = rows.length;
  // The cached verdicts, bounded as the at-cap alert bounds them; the offer is asked per mail below.
  const { answered } = await inPlaneRounds(deps.port, rows, (r) => deps.port.access(r.accountId), AT_CAP_READ_BOUND);
  result.read = answered.length;
  const holds = await storageHoldsOf(tx, answered.filter(([, v]) => v.ok).map(([r]) => r.accountId));
  const now = deps.now();
  for (const [row, verdict] of answered) {
    if (!verdict.ok || typeof verdict.limits.storageBytes !== "number") continue;
    const state = verdict.lifecycle?.state;
    if (state !== "trialing" && state !== "active") continue;
    const limit = storageLimitFrom(verdict.limits.storageBytes, verdict.trialStorage ?? null,
      holds.get(row.accountId) ?? null, now);
    const last = asDate(row.last);
    const level = storageMailLevelOf(
      { usedBytes: Number(row.bytes), lastEmptiedAt: last === null ? null : last.toISOString() }, limit.capBytes, now);
    if (level === null) continue;
    result.due += 1;
    if (result.sent.near + result.sent.full >= STORAGE_MAILS_PER_RUN || clock() - started >= budget) {
      result.capped = true;
      break;
    }
    try {
      await oneAccount(tx, deps, result, log, {
        accountId: row.accountId, level, verdict, capBytes: limit.capBytes,
        limitReason: storageLimitReason(verdict.limits.storageBytes, limit), limitDropsAt: limit.dropsAt,
        usedBytes: Number(row.bytes), keptFrom: row.keptFrom === null ? null : String(row.keptFrom).slice(0, 7), now,
      });
    } catch (err) {
      result.faults += 1;
      log.error("storage_mail_account_failed", {
        accountId: row.accountId, err,
        reason: "this account's storage mail was not sent and is asked about again on the next run",
      });
    }
  }
  return result;
}

interface Owed {
  accountId: string;
  level: StorageMailLevel;
  verdict: AccessVerdict;
  capBytes: number;
  limitReason: StorageNoticeMail["limitReason"];
  limitDropsAt: string | null;
  usedBytes: number;
  keptFrom: string | null;
  now: Date;
}

/** A row that holds the week: delivered, or a claim still in flight. */
const holdsTheWeek = (now: Date) => or(
  isNotNull(storageMailSent.deliveredAt),
  gte(storageMailSent.sentAt, new Date(now.getTime() - STORAGE_MAIL_CLAIM_STALE_MS)),
);

async function oneAccount(
  tx: Tx, deps: StorageMailPassDeps, result: StorageMailPassResult, log: Logger, o: Owed,
): Promise<void> {
  const prefs = await storagePrefsOf(tx, o.accountId);
  if (prefs.mailOffAt !== null) { result.off += 1; return; }
  const weekAgo = new Date(o.now.getTime() - STORAGE_MAIL_GAP_MS);
  const [held] = await tx.select({ one: sql`1` }).from(storageMailSent).where(and(
    eq(storageMailSent.accountId, o.accountId),
    or(
      and(eq(storageMailSent.level, o.level), eq(storageMailSent.capBytes, o.capBytes), isNotNull(storageMailSent.deliveredAt)),
      and(gte(storageMailSent.sentAt, weekAgo), holdsTheWeek(o.now)),
    ),
  )).limit(1);
  if (held) { result.already += 1; return; }
  const send = deps.mail?.sendStorageNotice?.bind(deps.mail);
  if (!send) { result.unmailable += 1; return; }
  // The offer, sized to the mail's need: one call of its own, so its answer carries the offer.
  const reading = await storageReadingOf(tx, o.accountId);
  const asked = await deps.port.access(o.accountId, { fresh: true, storageNeed: reading.need });
  const offer = asked.ok ? asked.storageOffer : undefined;
  if (!offer || !offer.canChange) { result.noOffer += 1; return; }
  if (!(await claim(tx, o))) { result.already += 1; return; }
  const recipients = await tx.select({ email: users.email }).from(users).where(eq(users.accountId, o.accountId));
  const [settings] = await tx.select({ locale: accountSettings.locale }).from(accountSettings)
    .where(eq(accountSettings.accountId, o.accountId)).limit(1);
  const locale: "en" | "de" = settings?.locale === "de" ? "de" : "en";
  let anySent = false;
  let anyFailed = false;
  for (const r of recipients) {
    const sent = await send({ db: bridgeDb(tx), now: deps.now }, {
      to: r.email, locale, level: o.level, usedBytes: o.usedBytes, capBytes: o.capBytes,
      limitReason: o.limitReason, limitDropsAt: o.limitDropsAt, expectedBytes: reading.need.expectedBytes,
      importing: reading.need.importing, keptFrom: o.keptFrom, fit: offer.fit, currency: offer.currency,
      interval: offer.interval, addonBytes: addonBytesOf(offer),
    });
    if (sent.status === "sent") anySent = true;
    if (sent.status === "failed") anyFailed = true;
  }
  const mine = and(
    eq(storageMailSent.accountId, o.accountId), eq(storageMailSent.level, o.level),
    eq(storageMailSent.capBytes, o.capBytes), isNull(storageMailSent.deliveredAt),
  );
  if (anyFailed) {
    // Handed back for the next run; the mailer's own key keeps a half-sent account from a second copy.
    // scoped-by: `mine` names the account, the level and the cap
    await tx.delete(storageMailSent).where(mine);
    result.faults += 1;
    log.error("storage_mail_send_failed", {
      accountId: o.accountId, kind: o.level, reason: "the claim was handed back; the next run sends it again",
    });
    return;
  }
  if (!anySent) {
    result.skipped += 1;
    log.warn("storage_mail_skipped", {
      accountId: o.accountId, kind: o.level,
      reason: "no recipient was sent the mail; it stays undelivered and an hour on it may be claimed again",
    });
    return;
  }
  // scoped-by: `mine` names the account, the level and the cap
  await tx.update(storageMailSent).set({ deliveredAt: deps.now() }).where(mine);
  result.sent[o.level] += 1;
}

/**
 * Claim (account, level, cap) in one fenced transaction under the account's advisory lock: refused
 * while a mail of the week holds, a new row or an undelivered claim gone stale otherwise.
 */
async function claim(tx: Tx, o: Owed): Promise<boolean> {
  return fencedAccountWrite(tx, { accountId: o.accountId }, async (t) => {
    await dialect(tx).advisoryLock(t, STORAGE_MAIL_LOCK_CLASS, o.accountId);
    const [recent] = await t.select({ one: sql`1` }).from(storageMailSent).where(and(
      eq(storageMailSent.accountId, o.accountId),
      gte(storageMailSent.sentAt, new Date(o.now.getTime() - STORAGE_MAIL_GAP_MS)),
      holdsTheWeek(o.now),
    )).limit(1);
    if (recent) return false;
    const claimed = await t.insert(storageMailSent)
      .values({ accountId: o.accountId, level: o.level, capBytes: o.capBytes, sentAt: o.now })
      .onConflictDoUpdate({
        target: [storageMailSent.accountId, storageMailSent.level, storageMailSent.capBytes],
        set: { sentAt: o.now },
        setWhere: and(isNull(storageMailSent.deliveredAt),
          lt(storageMailSent.sentAt, new Date(o.now.getTime() - STORAGE_MAIL_CLAIM_STALE_MS))),
      })
      .returning({ accountId: storageMailSent.accountId });
    return claimed.length > 0;
  });
}
