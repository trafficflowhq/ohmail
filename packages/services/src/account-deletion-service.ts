import { and, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import {
  accountSettings,
  accountStorage,
  accountSyncState,
  accounts,
  approvals,
  attachments,
  auditLog,
  awayResponderSent,
  awayResponders,
  changeLog,
  contactNotes,
  contacts,
  devices,
  drafts,
  flagState,
  folderState,
  graduations,
  idempotencyKeys,
  kbEntries,
  learningSignals,
  mailboxCredentials,
  folderOps,
  mailboxFolders,
  mailboxes,
  messageBodies,
  messageFailures,
  messageInstances,
  messageStates,
  messages,
  notifyRules,
  outboundSends,
  pairingTokens,
  refreshTokens,
  routingDecisions,
  rules,
  sessions,
  snippets,
  tags,
  messageTags,
  threadNotes,
  threads,
  trackerEvents,
  unsubscribeRecords,
  users,
  workflowProposals,
  workflowRuns,
  workflows,
  type LedgerTx,
} from "@trafficflow/db";
import {
  accountSuspensions,
  aiAttemptClaims,
  setupGrants,
  setupGrantSpends,
  attachmentStaging,
  authEvents,
  authThrottle,
  billingCustomers,
  credentials,
  loginTokens,
  mailboxOauthCeremonies,
  oauthAuthCodes,
  pushSubscriptions,
  recoveryCodes,
  totpSecrets,
  webauthnChallenges,
  webauthnCredentials,
} from "@trafficflow/db/cloud";
import type { ServiceContext } from "./context.js";

/**
 * Account deletion — Art. 17 erasure, implemented as ANONYMISATION.
 *
 * The decision is pinned by
 * `migration-0018.roundtrip.test.ts` › "an account with ledger history CANNOT be
 * deleted": the `credit_ledger` FK is `ON DELETE no action` and the ledger is
 * append-only, so a paying account cannot be `DELETE`d — and should not be.
 * Financial records carry a statutory retention obligation that GDPR Art. 17(3)(b)
 * explicitly preserves, and a money trail that can be erased on request is not a
 * money trail.
 *
 * So erasure means: **every user, mailbox, message, body, credential and note row
 * is deleted, and `accounts` survives as a pseudonymous billing subject** — a
 * random uuid and a blank name, which is not personal data. The one piece of
 * personal data inside the billing tables, `billing_customers.email`, is redacted
 * in place because the row itself is the link to the Stripe customer and has to
 * live as long as the invoices do.
 *
 * WHAT THIS DOES NOT TOUCH. The customer's mail. It is on their own IMAP server,
 * in the `ohmail/…` folders ohmail created there, and deleting our copy of the
 * mirror leaves their mailbox exactly as organised as it was. That is the whole
 * "leave anytime" promise, and it is why this function can be this blunt.
 *
 * ORDER MATTERS. Every statement below is a hard `DELETE` against real foreign
 * keys, so the sequence is children-before-parents and is asserted by
 * `account-deletion.pg.test.ts` against a fully populated account.
 *
 * ── HOW THIS FUNCTION WAS WRONG, AND WHAT NOW STOPS IT RECURRING ─────────────
 *
 * The paragraph above used to end "…a new table with an `account_id` will fail
 * that test rather than silently survive erasure", and BOTH halves of that were
 * false. `account-deletion.pg.test.ts` did not exist — it had never been added on
 * any branch — and the PGlite catalog sweep that did exist can only report a table
 * it finds ROWS in, so a table `seedFullAccount` never populated passed it
 * vacuously, for ever.
 *
 * That is not a documentation slip, because the sweep's blind spot is exactly the
 * shape of the bug it was meant to catch. Eight tables had accumulated behind it:
 *
 *   message_instances  FK → mailboxes AND messages, `ON DELETE no action`
 *   message_failures   FK → mailboxes,              `ON DELETE no action`
 *   flag_state         FK → messages,               `ON DELETE no action`
 *
 * — and those three are written by ORDINARY SYNC, so erasing any account that had
 * ever fetched mail raised `23503` and the whole transaction rolled back. Erasure
 * did not retain data quietly; it FAILED, on every real account, and the three
 * remaining self-serve callers got a 500. The other five (`account_settings`,
 * `account_suspensions`, `mailbox_oauth_ceremonies`, `ai_attempt_claims`,
 * `attachment_staging`) do not break the transaction — `accounts` survives
 * erasure, so an FK pointed at it is never violated — and so they were the silent
 * half: personal data that outlived an Art. 17 request with nothing failing.
 *
 * The guard is now structural rather than by-example. `account-deletion.pg.test.ts`
 * walks `information_schema` for every table FK-reachable from `accounts` plus
 * every table carrying an `account_id`, and requires each one to be either NAMED
 * IN {@link DeleteAccountResult.deleted} (which this function reports at runtime,
 * so the oracle cannot drift from the code) or on that file's written exemption
 * list. A table added next month fails the suite until somebody rules on it, which
 * is what the old comment claimed and did not do.
 *
 * ── ONE TABLE IS EXPIRED RATHER THAN DELETED, AND IT IS NOT AN OVERSIGHT ─────
 *
 * `attachment_staging` rows are the only rows here that name bytes living OUTSIDE
 * this database — an object in the staging bucket. The row is the delete key: the
 * worker's sweep removes the row and its object as a pair, and it finds rows by
 * `expires_at <= now()`. So a `DELETE` here would remove the only record of where
 * the attachment content is and ORPHAN THOSE BYTES IN THE BUCKET PERMANENTLY —
 * an Art. 17 erasure that leaves the actual attachment behind and unreachable.
 * Setting `expires_at` to the erasure instant instead makes every ticket due on
 * the next maintenance pass, and the bytes go with the row, which is the outcome
 * the request is actually about. The residue in the meantime is a filename and an
 * object path for one sweep interval, against permanent retention of the file.
 */
export interface DeleteAccountResult {
  accountId: string;
  /** Rows removed, per table, for the audit trail the operator keeps. */
  deleted: Record<string, number>;
  /**
   * Staging tickets brought forward to expire NOW — not deleted. See the header:
   * these rows are the only key to bytes in the object store, so they are reaped
   * WITH their objects by the worker sweep rather than dropped here.
   */
  stagingTicketsExpired: number;
  /** Users whose personal data was erased (count only — the addresses are gone). */
  usersErased: number;
}

/**
 * Rows affected, across both drivers: postgres-js returns an array with `.count`,
 * PGlite returns `{ affectedRows }`, node-postgres returns `{ rowCount }`. Only the
 * audit line depends on this, never the deletion itself.
 */
function n(r: unknown): number {
  if (r == null) return 0;
  const o = r as { rowCount?: unknown; affectedRows?: unknown; count?: unknown };
  if (typeof o.rowCount === "number") return o.rowCount;
  if (typeof o.affectedRows === "number") return o.affectedRows;
  if (typeof o.count === "number") return o.count;
  return Array.isArray(r) ? r.length : 0;
}

/**
 * Erase one account. Runs in ONE transaction: a half-deleted account is worse
 * than an undeleted one, because the user has been told their data is gone.
 *
 * Idempotent — running it twice is a no-op the second time, which matters because
 * the caller may retry after a network failure.
 */
export async function deleteAccount(ctx: ServiceContext): Promise<DeleteAccountResult> {
  const accountId = ctx.accountId;
  const db = ctx.db as unknown as { transaction: <T>(fn: (tx: LedgerTx) => Promise<T>) => Promise<T> };

  return db.transaction(async (tx) => {
    const deleted: Record<string, number> = {};
    const drop = async (table: string, run: Promise<unknown>) => {
      deleted[table] = n(await run);
    };

    /**
     * THE GLOBAL LOCK ORDER — `account_settings` FIRST, the change-log sequence row second
     * (`recordSettingsChange`, consent-seed.ts, states the rule and its two reproduced 40P01s).
     * This transaction used to delete `change_log` and `account_sync_state` in section 6 and
     * only then delete `account_settings` — the reverse order, which deadlocks against any
     * consent settings PATCH racing the erasure: the PATCH holds the settings row and waits on
     * the sequence row this transaction already holds, Postgres kills one, and the killed one
     * can be the Art. 17 erasure itself. So the settings delete RUNS FIRST — a delete takes the
     * row lock exactly as an update would, creates nothing (a retried erasure stays a zero-row
     * no-op, which the idempotency pin counts), and a knob write inserting the row afresh
     * queues on this delete while holding nothing, so no cycle can form from either side. The
     * row's own reasoning (why consent is erased at all) stays with its old neighbours in
     * section 6.
     */
    await drop("account_settings", tx.delete(accountSettings).where(eq(accountSettings.accountId, accountId)));

    // The account's users and mailboxes, resolved once — several tables below key
    // off the USER, not the account, and after the users are gone we cannot ask.
    const userRows = await tx.select({ id: users.id, email: users.email })
      .from(users).where(eq(users.accountId, accountId));
    const userIds = userRows.map((u) => u.id);
    const emails = userRows.map((u) => u.email);

    const mailboxRows = await tx.select({ id: mailboxes.id })
      .from(mailboxes).where(eq(mailboxes.accountId, accountId));
    const mailboxIds = mailboxRows.map((m) => m.id);

    // ── 1. Sends and drafts (drafts reference mailboxes, threads AND messages) ──
    await drop("outbound_sends", tx.delete(outboundSends).where(eq(outboundSends.accountId, accountId)));
    await drop("drafts", tx.delete(drafts).where(eq(drafts.accountId, accountId)));

    // ── 2. Everything hanging off a message ─────────────────────────────────────
    // TAGS FIRST, AND BEFORE `messages`. `message_tags` FKs BOTH `messages` and `tags` with
    // `ON DELETE no action`, so deleting either parent while an assignment row survives aborts
    // the whole erasure transaction — an Art. 17 request that fails on a foreign key. The child
    // goes before both its parents, and `tags` before `messages` only because it must go
    // somewhere; the ordering that is load-bearing is child-before-parent.
    //
    // This is also the moment the product's claim about tags becomes true. Tags are OURS, not
    // IMAP: a disconnect keeps them (it is a reversible soft delete), but erasing the account
    // takes them, and these two lines are the whole of "takes them". The folders survive because
    // they are real folders in someone else's mailbox; the tags do not, because they were only
    // ever rows here.
    // BEFORE `messages` and `mailboxes`: this table carries FKs to both, so a missed
    // line here fails erasure LOUDLY rather than retaining a list of what somebody
    // unsubscribed from. That profile is exactly the kind of residue Art. 17 is about, and
    // the catalog sweep in account-deletion.test.ts would NOT have caught it — that check
    // only visits tables `seedFullAccount` populates.
    await drop("unsubscribe_records", tx.delete(unsubscribeRecords).where(eq(unsubscribeRecords.accountId, accountId)));
    await drop("message_tags", tx.delete(messageTags).where(eq(messageTags.accountId, accountId)));
    await drop("tags", tx.delete(tags).where(eq(tags.accountId, accountId)));
    await drop("attachments", tx.delete(attachments).where(eq(attachments.accountId, accountId)));
    await drop("tracker_events", tx.delete(trackerEvents).where(eq(trackerEvents.accountId, accountId)));
    await drop("message_states", tx.delete(messageStates).where(eq(messageStates.accountId, accountId)));
    // `routing_decisions` is also where a BOUGHT SCREENER SUGGESTION lives — same table, told
    // apart by `input_provenance` (see `screener-suggestion.ts`). One delete covers both.
    await drop("routing_decisions", tx.delete(routingDecisions).where(eq(routingDecisions.accountId, accountId)));
    await drop("approvals", tx.delete(approvals).where(eq(approvals.accountId, accountId)));
    // BEFORE `messages` AND before `mailboxes` — this table FKs BOTH, `ON DELETE no action`, and
    // every sync writes it. It is the row that says WHERE a message physically is on the server
    // (folder, uidvalidity, uid), one per copy, so it is mail-locator data and it goes.
    await drop("message_instances", tx.delete(messageInstances).where(eq(messageInstances.accountId, accountId)));
    // BEFORE `mailboxes`, which it FKs `ON DELETE no action`. Content-free by design — a
    // coordinate and a code — but a coordinate into somebody's mailbox is still theirs.
    await drop("message_failures", tx.delete(messageFailures).where(eq(messageFailures.accountId, accountId)));
    // message_bodies, folder_state and flag_state key off the MESSAGE, so they need the ids.
    const messageIds = (await tx.select({ id: messages.id })
      .from(messages).where(eq(messages.accountId, accountId))).map((m) => m.id);
    if (messageIds.length) {
      await drop("message_bodies", tx.delete(messageBodies).where(inArray(messageBodies.messageId, messageIds)));
      await drop("folder_state", tx.delete(folderState).where(inArray(folderState.messageId, messageIds)));
      // `folder_state`'s twin for the `\Seen` flag, and it has no `account_id` either — which is
      // why the catalog sweep could never have seen it. Read state is user data.
      await drop("flag_state", tx.delete(flagState).where(inArray(flagState.messageId, messageIds)));
    } else {
      deleted.message_bodies = 0;
      deleted.folder_state = 0;
      deleted.flag_state = 0;
    }

    // ── 3. Notes, then their parents ────────────────────────────────────────────
    await drop("thread_notes", tx.delete(threadNotes).where(eq(threadNotes.accountId, accountId)));
    await drop("contact_notes", tx.delete(contactNotes).where(eq(contactNotes.accountId, accountId)));
    await drop("messages", tx.delete(messages).where(eq(messages.accountId, accountId)));
    await drop("threads", tx.delete(threads).where(eq(threads.accountId, accountId)));
    await drop("contacts", tx.delete(contacts).where(eq(contacts.accountId, accountId)));
    // The stored-body byte counter (mail 0062). AFTER `message_bodies`, whose bytes it counts:
    // a number derived from mail somebody erased is itself residue, and the catalog sweep
    // enumerates this table by its `account_id` column, so forgetting this line is a red test.
    await drop("account_storage", tx.delete(accountStorage).where(eq(accountStorage.accountId, accountId)));

    // ── 4. Mailboxes — the credentials go with them ─────────────────────────────
    if (mailboxIds.length) {
      await drop("mailbox_credentials", tx.delete(mailboxCredentials).where(inArray(mailboxCredentials.mailboxId, mailboxIds)));
      // The folder COMMANDS before the folder inventory they reference (mail 0074). The FK
      // would CASCADE these with the inventory rows anyway; the delete is explicit so the
      // erasure receipt counts them and the ruling is written where the census looks — a
      // rename target is the user's own words, not residue to leave to a side effect.
      await drop("folder_ops", tx.delete(folderOps).where(inArray(folderOps.mailboxId, mailboxIds)));
      await drop("mailbox_folders", tx.delete(mailboxFolders).where(inArray(mailboxFolders.mailboxId, mailboxIds)));
    } else {
      deleted.mailbox_credentials = 0;
      deleted.folder_ops = 0;
      deleted.mailbox_folders = 0;
    }
    await drop("mailboxes", tx.delete(mailboxes).where(eq(mailboxes.accountId, accountId)));

    // ── 5. Automation, knowledge, preferences ───────────────────────────────────
    await drop("workflow_runs", tx.delete(workflowRuns).where(eq(workflowRuns.accountId, accountId)));
    await drop("workflows", tx.delete(workflows).where(eq(workflows.accountId, accountId)));
    await drop("workflow_proposals", tx.delete(workflowProposals).where(eq(workflowProposals.accountId, accountId)));
    await drop("kb_entries", tx.delete(kbEntries).where(eq(kbEntries.accountId, accountId)));
    await drop("snippets", tx.delete(snippets).where(eq(snippets.accountId, accountId)));
    await drop("notify_rules", tx.delete(notifyRules).where(eq(notifyRules.accountId, accountId)));
    // BEFORE the responder itself, and both go. `away_responder_sent.sender` is a correspondent's
    // email address — somebody else's personal data, held because we sent them mail — so it is not
    // optional here. The catalog sweep in `account-deletion.test.ts` enumerates every table with an
    // `account_id` column and fails on any surviving row, which is what makes this a red test rather
    // than a quiet retention if a future table is added and forgotten.
    await drop("away_responder_sent", tx.delete(awayResponderSent).where(eq(awayResponderSent.accountId, accountId)));
    await drop("away_responders", tx.delete(awayResponders).where(eq(awayResponders.accountId, accountId)));
    await drop("rules", tx.delete(rules).where(eq(rules.accountId, accountId)));
    await drop("graduations", tx.delete(graduations).where(eq(graduations.accountId, accountId)));
    await drop("learning_signals", tx.delete(learningSignals).where(eq(learningSignals.accountId, accountId)));

    // ── 6. Sync plumbing and the operational trail ──────────────────────────────
    await drop("change_log", tx.delete(changeLog).where(eq(changeLog.accountId, accountId)));
    await drop("account_sync_state", tx.delete(accountSyncState).where(eq(accountSyncState.accountId, accountId)));
    await drop("audit_log", tx.delete(auditLog).where(eq(auditLog.accountId, accountId)));
    await drop("idempotency_keys", tx.delete(idempotencyKeys).where(eq(idempotencyKeys.accountId, accountId)));
    await drop("push_subscriptions", tx.delete(pushSubscriptions).where(eq(pushSubscriptions.accountId, accountId)));
    // The account's own preferences — the dormancy dial, the Ohbox posture, and
    // `seed_confirmed_at`, which is the CONSENT EVENT of onboarding — were deleted FIRST, at
    // the top of this transaction: consent to something is a record about a person and there
    // is nobody left to have consented, and the settings row is also the first lock in the
    // global order every settings writer takes (see the note at the top).

    // ── 6b. The HOSTED-ONLY account-scoped rows ─────────────────────────────────
    // Five Cloud tables key off `accounts`, which erasure does NOT delete — so none of these
    // raises a foreign-key error and none of them was ever visible as a failure. They are the
    // quiet half of this fix and they are all personal data.
    //
    // A ceremony holds the KEK-wrapped PKCE verifier for a mailbox connect that was in flight,
    // plus `return_to`. Unconsumed, it is a live half of a consent flow for an account with no
    // users left to finish it.
    await drop("mailbox_oauth_ceremonies",
      tx.delete(mailboxOauthCeremonies).where(eq(mailboxOauthCeremonies.accountId, accountId)));
    // `source` is `classify:screener:<message_id>` — a message id of the account being erased.
    // The FK is `ON DELETE cascade`, which would have taken these with `accounts`; `accounts`
    // survives, so the cascade never fires and the claims outlive the mail they name.
    await drop("ai_attempt_claims", tx.delete(aiAttemptClaims).where(eq(aiAttemptClaims.accountId, accountId)));
    // The screening-only setup pools (cloud 0021): per-account state, not the money audit — the
    // audit is `credit_ledger`, which a setup-funded suggestion never touches. `mailbox_id` and
    // the spends' `source` (`classify:screener:<message_id>`) both name objects of the account
    // being erased, the same argument as the claims row above. Spends first (FK to grants).
    await drop("setup_grant_spends",
      tx.delete(setupGrantSpends).where(eq(setupGrantSpends.accountId, accountId)));
    await drop("setup_grants",
      tx.delete(setupGrants).where(eq(setupGrants.accountId, accountId)));
    // Presence IS the state, and there is nothing left to suspend: no users, no mailboxes, no
    // session that could ever authenticate. What remains in the row is `note` — an operator's
    // free text ABOUT THIS PERSON — so leaving it would retain the one field here that is
    // unambiguously theirs. The suspend/resume history stays in `audit_log`'s posture, i.e. it
    // goes with the account, exactly as the line above deletes it.
    await drop("account_suspensions",
      tx.delete(accountSuspensions).where(eq(accountSuspensions.accountId, accountId)));
    // NOT a delete — see the header. The row is the only key to bytes in the staging bucket, and
    // the sweep removes row and object together, keyed on `expires_at <= now()`. Bringing the
    // expiry forward hands both to the next maintenance pass; deleting the row would strand the
    // attachment in object storage for the life of the deployment.
    //
    // `gt(expires_at, now)` is what keeps this IDEMPOTENT: a second erasure finds the tickets
    // already expired, matches nothing, and reports zero.
    const stagingTicketsExpired = n(await tx.update(attachmentStaging)
      .set({ expiresAt: ctx.now() })
      .where(and(eq(attachmentStaging.accountId, accountId), gt(attachmentStaging.expiresAt, ctx.now()))));

    // ── 7. Sessions, devices, and every credential the user holds ───────────────
    await drop("refresh_tokens", tx.delete(refreshTokens).where(eq(refreshTokens.accountId, accountId)));
    await drop("sessions", tx.delete(sessions).where(eq(sessions.accountId, accountId)));
    await drop("devices", tx.delete(devices).where(eq(devices.accountId, accountId)));
    if (userIds.length) {
      // Pairing tokens are CREDENTIALS THE USER MINTED (mail 0059): a live device-pair token
      // still opens this account, a live invite token still opens this server, and the label is
      // the user's own words. All of it goes — and it must go BEFORE the `users` delete below,
      // whose FK (`created_by_user_id`) would otherwise refuse the erasure outright. First-boot
      // tokens (creator NULL) belong to no user and are untouched.
      await drop("pairing_tokens", tx.delete(pairingTokens).where(inArray(pairingTokens.createdByUserId, userIds)));
      await drop("login_tokens", tx.delete(loginTokens).where(inArray(loginTokens.userId, userIds)));
      await drop("oauth_auth_codes", tx.delete(oauthAuthCodes).where(inArray(oauthAuthCodes.userId, userIds)));
      await drop("recovery_codes", tx.delete(recoveryCodes).where(inArray(recoveryCodes.userId, userIds)));
      await drop("totp_secrets", tx.delete(totpSecrets).where(inArray(totpSecrets.userId, userIds)));
      await drop("webauthn_credentials", tx.delete(webauthnCredentials).where(inArray(webauthnCredentials.userId, userIds)));
      // Nullable userId and no FK — an unconsumed ceremony would otherwise outlive
      // the user it was started for.
      await drop("webauthn_challenges", tx.delete(webauthnChallenges)
        .where(and(isNotNull(webauthnChallenges.userId), inArray(webauthnChallenges.userId, userIds))));
      await drop("credentials", tx.delete(credentials).where(inArray(credentials.userId, userIds)));
      // `auth_throttle.key` is "user:<id>" or "email:<addr>" — both are personal data.
      await drop("auth_throttle", tx.delete(authThrottle).where(inArray(
        authThrottle.key,
        [...userIds.map((id) => `user:${id}`), ...emails.map((e) => `email:${e}`)],
      )));
    } else {
      for (const t of ["pairing_tokens", "login_tokens", "oauth_auth_codes", "recovery_codes",
        "totp_secrets", "webauthn_credentials", "webauthn_challenges", "credentials",
        "auth_throttle"]) deleted[t] = 0;
    }
    // auth_events carries ip + device per login. Account-scoped rows go with the
    // account; user-scoped rows that predate the account (unknown-email attempts)
    // are already anonymous, and there is no key to find them by.
    await drop("auth_events", tx.delete(authEvents).where(eq(authEvents.accountId, accountId)));

    // ── 8. The users themselves ─────────────────────────────────────────────────
    await drop("users", tx.delete(users).where(eq(users.accountId, accountId)));

    // ── 9. The account survives, pseudonymously ─────────────────────────────────
    // Not a soft delete: there is nothing personal left to protect. The row is the
    // billing subject the ledger points at, and a uuid is not personal data.
    await tx.update(accounts).set({ name: "" }).where(eq(accounts.id, accountId));
    // The one personal field inside the billing tables. The Stripe customer id is
    // the link the invoices need; the email is not.
    await tx.update(billingCustomers)
      .set({ email: sql`'deleted@invalid'`, updatedAt: ctx.now() })
      .where(eq(billingCustomers.accountId, accountId));

    return { accountId, deleted, stagingTicketsExpired, usersErased: userRows.length };
  });
}
