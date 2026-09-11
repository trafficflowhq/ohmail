import { and, asc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import {
  accountSettings,
  accountStorage,
  accountSyncState,
  accounts,
  approvals,
  attachments,
  auditLog,
  awayReplies,
  awayResponderSent,
  awayResponders,
  awaySenderState,
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
  mailboxProfileMirror,
  folderOps,
  mailboxFolders,
  mailboxes,
  messageBodies,
  messageFailures,
  messageInstances,
  messageStates,
  messages,
  notifyRules,
  organizerRequests,
  outboundSendFingerprints,
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
  ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS,
  trackerEvents,
  unsubscribeRecords,
  users,
  workflowProposals,
  workflowRuns,
  workflows,
  type LedgerTx,
} from "@trafficflow/db";
import {
  attachmentStaging,
  authEvents,
  authThrottle,
  credentials,
  loginTokens,
  mailboxOauthCeremonies,
  mailboxOauthDeviceCeremonies,
  oauthAuthCodes,
  pushSubscriptions,
  recoveryCodes,
  totpSecrets,
  webauthnChallenges,
  webauthnCredentials,
} from "@trafficflow/db/cloud";
import type { ServiceContext } from "./context.js";
import { rowsAffected } from "./rows-affected.js";

/**
 * Account deletion — Art. 17 erasure, as ANONYMISATION. A ledger-carrying account cannot be
 * `DELETE`d (`migration-0018.roundtrip.test.ts`; Art. 17(3)(b) preserves statutory retention).
 * Every user, mailbox, message, body, credential and note row is deleted; `accounts` survives as
 * a pseudonymous billing subject, `billing_customers.email` redacted in place. Mail on the
 * customer's own IMAP server is untouched. `account-deletion.pg.test.ts` walks
 * `information_schema` for every table FK-reachable from `accounts` or carrying `account_id`:
 * each must be NAMED in {@link DeleteAccountResult.deleted} or exempted. `attachment_staging` is
 * EXPIRED, not deleted — its row is the delete key for bucket bytes.
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

/** Rows affected across the three drivers — see `rows-affected.ts` for why there is one copy. */
const n = rowsAffected;

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
     * The erasure fence's stamp — the FIRST statement. `accounts` survives erasure, so nothing
     * structural refuses a LATE settings writer: a consent PATCH in flight could recreate rows a
     * millisecond after the catalog sweep counted zero. The stamp is the interlock: it takes the
     * account row's exclusive lock at the top of this transaction; every settings writer opens by
     * reading the row `FOR SHARE` and refuses on a stamp (`erasure-fence.ts`). Whichever side
     * wins, zero rows survive. `coalesce` keeps a retried erasure on the FIRST stamp. The instant
     * travels as ISO text: a Date in a raw `sql` fragment is refused by postgres-js while PGlite
     * accepts it — the driver split the pg suite exists to catch.
     */
    await tx.update(accounts)
      .set({ erasedAt: sql`coalesce(${accounts.erasedAt}, ${ctx.now().toISOString()}::timestamptz)` })
      .where(eq(accounts.id, accountId));

    /**
     * The global lock order: `account_settings` FIRST, the change-log sequence row second
     * (`recordSettingsChange` in consent-seed.ts states it). This transaction once deleted
     * `change_log`/`account_sync_state` before `account_settings` — the reverse order, which
     * deadlocks against a consent PATCH racing the erasure: the PATCH holds the settings row and
     * waits on the sequence row this transaction holds, and Postgres can kill the erasure itself.
     * The settings delete runs first — a delete takes the row lock as an update would, creates
     * nothing, and a knob write inserting afresh queues on it while holding nothing, so no cycle
     * forms.
     */
    await drop("account_settings", tx.delete(accountSettings).where(eq(accountSettings.accountId, accountId)));

    /**
     * The user- and mailbox-keyed predicates are SUBQUERIES, not materialized id lists. Both
     * parents are deleted at the END of this transaction, so the subqueries read rows still
     * present at every line that uses them. `select`s and not arrays for the reason at the
     * message-keyed deletes below: an id list is one bind parameter per row against a collection
     * with no ceiling — "it is small today" is not a bound, and the subquery form costs nothing.
     * `userRows` is still READ for one thing an `IN` predicate cannot give: the erasure receipt's
     * `usersErased` count.
     */
    const userRows = await tx.select({ id: users.id })
      .from(users).where(eq(users.accountId, accountId));
    const ownUserIds = tx.select({ id: users.id }).from(users).where(eq(users.accountId, accountId));
    const ownMailboxIds = tx.select({ id: mailboxes.id })
      .from(mailboxes).where(eq(mailboxes.accountId, accountId));

    // ── SERIALIZE AGAINST THE THREAD BACKFILL, before any lock this transaction takes. ──
    // See {@link ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS}: erasure and the backfill lock `threads`
    // and `messages` in opposite orders for reasons neither can give up, so instead of racing
    // to acquire them, whichever gets here first finishes its whole sweep before the other
    // proceeds. Releases at COMMIT, same as every advisory lock this repo takes for this.
    await tx.execute(sql`select pg_advisory_xact_lock(${ACCOUNT_THREAD_STRUCTURE_LOCK_CLASS}, hashtext(${accountId}))`);

    // ── 0. THE THREAD-FIRST FENCE. Every live writer of a thread takes thread rows before
    // message or draft rows (ingest's mergeThreadMessage, both merge paths, the drafts
    // service's reply-target lock). Erasure's DELETE order is forced the other way by the
    // FKs — children before parents, so messages before threads — which would make it the
    // one transaction acquiring locks against the shared order and a deadlock partner for
    // any concurrent merge. Locking every thread row up front, in the shared stable order,
    // puts erasure's ACQUISITION on the same order as everyone else; the deletes below then
    // touch rows nobody else can be holding the other half of. The rows all die in this
    // transaction anyway, so the locks cost nothing extra.
    await tx.select({ id: threads.id }).from(threads)
      .where(eq(threads.accountId, accountId))
      .orderBy(asc(threads.id))
      .for("update");

    // ── 1. Sends and drafts (drafts reference mailboxes, threads AND messages) ──
    //
    // The content claim goes FIRST and EXPLICITLY, though its foreign key also cascades from
    // `outbound_sends` below. Both, deliberately: the cascade is what makes the other two cleanup
    // paths work (the desktop mirror wipe and the local mirror's per-draft delete, neither of which
    // is going to grow a per-table list), and the explicit delete is what makes this service's
    // ruling on the table READABLE — the erasure census asks for a written ruling per table, and
    // "it happens to cascade from the row below" is not one somebody auditing this can see.
    await drop(
      "outbound_send_fingerprints",
      tx.delete(outboundSendFingerprints).where(eq(outboundSendFingerprints.accountId, accountId)),
    );
    await drop("outbound_sends", tx.delete(outboundSends).where(eq(outboundSends.accountId, accountId)));
    await drop("drafts", tx.delete(drafts).where(eq(drafts.accountId, accountId)));

    // 2. Everything hanging off a message. TAGS FIRST, before `messages`: `message_tags` FKs both
    // `messages` and `tags` with `ON DELETE no action`, so deleting either parent while an
    // assignment survives aborts the whole erasure — an Art. 17 request failing on a foreign key.
    // Child before parent is the load-bearing order. This is also where the product's tags claim
    // becomes true: tags are OURS, not IMAP — a disconnect keeps them, erasure takes them, and
    // these two lines are the whole of "takes them"; folders survive because they are real
    // folders in someone else's mailbox. `unsubscribe_records` goes before `messages` and
    // `mailboxes` too: it FKs both, so a missed line fails erasure LOUDLY rather than retaining a
    // list of what somebody unsubscribed from.
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
    // `message_bodies`, `folder_state` and `flag_state` key off the MESSAGE, not the account. A
    // SUBQUERY — this used to be a materialized id list: one bind parameter PER MESSAGE, three
    // times over, and PostgreSQL refuses a statement with more than 65 535 parameters, so
    // self-serve erasure stopped working exactly for the largest real accounts. Nothing warned —
    // a small mailbox erases fine and every test account is small. The ids now never leave
    // PostgreSQL: no array, no parameter list, no cardinality to bound, and the planner joins
    // instead of matching a literal list. The `messages` delete is still by `account_id` and runs
    // AFTER these three (FK order), so the subquery resolves against rows still present.
    const ownMessageIds = tx.select({ id: messages.id })
      .from(messages).where(eq(messages.accountId, accountId));
    await drop("message_bodies", tx.delete(messageBodies).where(inArray(messageBodies.messageId, ownMessageIds)));
    await drop("folder_state", tx.delete(folderState).where(inArray(folderState.messageId, ownMessageIds)));
    // `folder_state`'s twin for the `\Seen` flag, and it has no `account_id` either — which is
    // why the catalog sweep could never have seen it. Read state is user data.
    await drop("flag_state", tx.delete(flagState).where(inArray(flagState.messageId, ownMessageIds)));

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
    // Subqueries for the same reason the message-keyed deletes above use them: the SELF-HOST
    // imposes no mailbox count limit at all (`SELF_HOST_MAILBOX_ALLOWANCE`), so a materialized
    // list here has no ceiling either — smaller in practice than the message list and the same
    // shape, which is the whole argument for preferring the subquery everywhere rather than
    // only where a count is known to be large.
    await drop("mailbox_credentials", tx.delete(mailboxCredentials).where(inArray(mailboxCredentials.mailboxId, ownMailboxIds)));
    // The folder COMMANDS before the folder inventory they reference (mail 0074). The FK
    // would CASCADE these with the inventory rows anyway; the delete is explicit so the
    // erasure receipt counts them and the ruling is written where the census looks — a
    // rename target is the user's own words, not residue to leave to a side effect.
    await drop("folder_ops", tx.delete(folderOps).where(inArray(folderOps.mailboxId, ownMailboxIds)));
    await drop("mailbox_folders", tx.delete(mailboxFolders).where(inArray(mailboxFolders.mailboxId, ownMailboxIds)));
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
    // The 0087 pair, and they are here for `away_responder_sent`'s reason stated one line up
    // rather than for tidiness: `away_replies.sender` and `away_sender_state.sender` are
    // CORRESPONDENTS' email addresses — somebody else's personal data, held because we sent them
    // mail — and `away_replies` additionally records that a named person wrote to this account and
    // when. That is exactly the class the catalog sweep in `account-deletion.test.ts` enumerates,
    // so both go, and both were red in that sweep until they did.
    await drop("away_replies", tx.delete(awayReplies).where(eq(awayReplies.accountId, accountId)));
    await drop("away_sender_state", tx.delete(awaySenderState).where(eq(awaySenderState.accountId, accountId)));
    await drop("away_responders", tx.delete(awayResponders).where(eq(awayResponders.accountId, accountId)));
    // The reader's outstanding decisions (mail 0088). Its `payload` carries whatever the person
    // decided about a sender — on a `screener.decide` that is a CORRESPONDENT'S ADDRESS and the
    // verdict passed on them, which is the same class as the two rows above it and is held for a
    // shorter time only by luck. The table has no foreign key by design (the record has to outlive
    // the message and the mailbox row), so nothing cascades it and this line is the only thing
    // that removes it. The catalog sweep enumerates every table with an `account_id` column, so
    // this was red there until it landed.
    await drop("organizer_requests", tx.delete(organizerRequests).where(eq(organizerRequests.accountId, accountId)));
    // The other half of that channel (mail 0094): what the ORGANIZER published, cached here by an
    // install that only READS this mailbox. `doc` is the whole profile document, so it holds the
    // screener list's CORRESPONDENT ADDRESSES, the person's own rule text and the away-responder
    // body they wrote — a superset of the classes the three rows above it are deleted for, in one
    // bag. It is keyed by mailbox and has no foreign key (the same design as the row above: the
    // cache has to outlive the mailbox row it names), so nothing cascades it and this line is the
    // only thing that removes it.
    await drop("mailbox_profile_mirror", tx.delete(mailboxProfileMirror).where(eq(mailboxProfileMirror.accountId, accountId)));
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
    // Six Cloud tables key off `accounts`, which erasure does NOT delete — so none of these
    // raises a foreign-key error and none of them was ever visible as a failure. They are the
    // quiet half of this fix and they are all personal data.
    //
    // A ceremony holds the KEK-wrapped PKCE verifier for a mailbox connect that was in flight,
    // plus `return_to`. Unconsumed, it is a live half of a consent flow for an account with no
    // users left to finish it.
    await drop("mailbox_oauth_ceremonies",
      tx.delete(mailboxOauthCeremonies).where(eq(mailboxOauthCeremonies.accountId, accountId)));
    // Its DEVICE-CODE sibling (cloud 0027), for the identical reason and with a sharper edge: this
    // row holds the KEK-wrapped `device_code`, which is a BEARER CREDENTIAL for the whole ceremony
    // rather than a PKCE verifier that buys nothing on its own. Same `accounts` FK, same absent
    // cascade, so the same silence — and the opportunistic prune only runs when somebody starts
    // ANOTHER device ceremony on this deployment, which on an account that has just erased itself
    // may be never.
    await drop("mailbox_oauth_device_ceremonies",
      tx.delete(mailboxOauthDeviceCeremonies).where(eq(mailboxOauthDeviceCeremonies.accountId, accountId)));
    // What an entitlements program holds is erased by THAT program: attempt claims, setup pools,
    // the suspension note and the customer email belong to whoever operates metering, reached
    // through the port's `releaseAccount`, which this service calls. NOT a delete — the staging
    // row is the only key to bytes in the staging bucket, and the sweep removes row and object
    // together, keyed on `expires_at <= now()`; bringing the expiry forward hands both to the
    // next maintenance pass, while deleting the row would strand the attachment for the life of
    // the deployment. `gt(expires_at, now)` keeps this IDEMPOTENT: a second erasure matches
    // nothing and reports zero.
    const stagingTicketsExpired = n(await tx.update(attachmentStaging)
      .set({ expiresAt: ctx.now() })
      .where(and(eq(attachmentStaging.accountId, accountId), gt(attachmentStaging.expiresAt, ctx.now()))));

    // ── 7. Sessions, devices, and every credential the user holds ───────────────
    await drop("refresh_tokens", tx.delete(refreshTokens).where(eq(refreshTokens.accountId, accountId)));
    await drop("sessions", tx.delete(sessions).where(eq(sessions.accountId, accountId)));
    await drop("devices", tx.delete(devices).where(eq(devices.accountId, accountId)));
    // Pairing tokens are CREDENTIALS THE USER MINTED (mail 0059): a live device-pair token
    // still opens this account, a live invite token still opens this server, and the label is
    // the user's own words. All of it goes — and it must go BEFORE the `users` delete below,
    // whose FK (`created_by_user_id`) would otherwise refuse the erasure outright. First-boot
    // tokens (creator NULL) belong to no user and are untouched.
    await drop("pairing_tokens", tx.delete(pairingTokens).where(inArray(pairingTokens.createdByUserId, ownUserIds)));
    await drop("login_tokens", tx.delete(loginTokens).where(inArray(loginTokens.userId, ownUserIds)));
    await drop("oauth_auth_codes", tx.delete(oauthAuthCodes).where(inArray(oauthAuthCodes.userId, ownUserIds)));
    await drop("recovery_codes", tx.delete(recoveryCodes).where(inArray(recoveryCodes.userId, ownUserIds)));
    await drop("totp_secrets", tx.delete(totpSecrets).where(inArray(totpSecrets.userId, ownUserIds)));
    await drop("webauthn_credentials", tx.delete(webauthnCredentials).where(inArray(webauthnCredentials.userId, ownUserIds)));
    // Nullable userId and no FK — an unconsumed ceremony would otherwise outlive
    // the user it was started for.
    await drop("webauthn_challenges", tx.delete(webauthnChallenges)
      .where(and(isNotNull(webauthnChallenges.userId), inArray(webauthnChallenges.userId, ownUserIds))));
    await drop("credentials", tx.delete(credentials).where(inArray(credentials.userId, ownUserIds)));
    // `auth_throttle.key` is "user:<id>" or "email:<addr>" — both are personal data, and the two
    // shapes are two predicates rather than one concatenated array. The strings are now BUILT IN
    // POSTGRES from the `users` row, so no address is materialized in this process and neither
    // list carries a bind parameter per user. `::text` is explicit: `id` is a uuid and `||`
    // against a text literal has no implicit cast for it.
    const throttleUserKeys = tx.select({ k: sql<string>`'user:' || ${users.id}::text` })
      .from(users).where(eq(users.accountId, accountId));
    const throttleEmailKeys = tx.select({ k: sql<string>`'email:' || ${users.email}` })
      .from(users).where(eq(users.accountId, accountId));
    await drop("auth_throttle", tx.delete(authThrottle).where(or(
      inArray(authThrottle.key, throttleUserKeys),
      inArray(authThrottle.key, throttleEmailKeys),
    )));
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
    return { accountId, deleted, stagingTicketsExpired, usersErased: userRows.length };
  });
}
