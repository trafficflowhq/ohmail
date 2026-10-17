/**
 * THE ERASURE FIXTURE — one definition of "a fully populated account", shared by the PGlite suite
 * (`account-deletion.test.ts`) and the real-Postgres one (`account-deletion.pg.test.ts`).
 *
 * It lives in its own file for a reason that is the whole subject of this slice. **The seed IS
 * the oracle.** The catalog sweep can only report a table it finds ROWS in, so a table this
 * helper does not populate is a table that sweep passes vacuously, for ever. That is exactly how
 * `message_instances`, `message_failures` and `flag_state` — three tables any account that has
 * fetched mail is full of — sat behind a green suite while erasure of a real account died on a
 * foreign key.
 *
 * Two copies of this seed would mean the two suites could disagree about what "full" means, and
 * the weaker one would be the one that stayed green. There is one copy.
 */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { upsertMessageSearch } from "@trafficflow/core/mail";
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
  folderOps,
  folderState,
  graduations,
  junkRescues,
  idempotencyKeys,
  kbEntries,
  learningSignals,
  listAddresses,
  mailboxCredentials,
  mailboxFolders,
  mailboxes,
  messageBodies,
  messageFailures,
  messageInstances,
  messageStates,
  messageTags,
  messages,
  notifyRules,
  organizerRequests,
  mailboxProfileMirror,
  outboundSendFingerprints,
  outboundSends,
  pairingTokens,
  refreshTokens,
  routingDecisions,
  rules,
  SCREENER_SUGGESTION_PROVENANCE,
  SCREENER_SUGGESTION_STATUS,
  sessions,
  snippets,
  tags,
  threadNotes,
  threads,
  trackerEvents,
  unsubscribeExamined,
  unsubscribeRecords,
  users,
  workflowProposals,
  workflowRuns,
  workflows,
} from "@trafficflow/db";
import {
  attachmentStaging,
  authEvents,
  authThrottle,
  creditRefundObligations,
  credentials,
  invites,
  loginTokens,
  mailboxOauthCeremonies,
  mailboxOauthDeviceCeremonies,
  oauthAuthCodes,
  pushSubscriptions,
  recoveryCodes,
  accountLifecycleNotices,
  screenerSuggestOwed,
  totpSecrets,
  waitlist,
  webauthnChallenges,
  webauthnCredentials,
} from "@trafficflow/db/cloud";

/** The shared surface of the PGlite and postgres-js drizzle clients. */
export type Db = Awaited<ReturnType<typeof makeTestDb>>;

export const NOW = new Date("2026-07-31T09:00:00.000Z");
export const LATER = new Date("2026-08-30T09:00:00.000Z");

/**
 * WHAT SURVIVES AN ERASURE: the account row, and the one table the erasure itself writes.
 *
 * `accounts` alone. Every money row that used to be listed here — the customer, the subscription,
 * the balance, the append-only ledger, the webhook events, the invoice mirror and the usage
 * aggregates — is held by whoever operates metering, not by this database, so the statutory
 * retention argument that kept them (GDPR Art. 17(3)(b): a money trail that can be erased on
 * request is not a money trail) is theirs to make. What is left here is a random uuid with a
 * blank name, which is not personal data and which the retained record elsewhere points at.
 */
/**
 * ── THE RELIABILITY BOARD (cloud 0030) — OUTSIDE THE GRAPH, and one honest footnote ────────
 *
 * `alert_pass_runs`, `alert_driver_gaps` (cloud 0048: per driver per day, counts and a timestamp)
 * and `platform_signals` are NOT in `RETAINED` and are not in the account graph at all, for one
 * reason: none has an `account_id` and none can. One records that an alert DRIVER completed a pass — a fact about a process — and
 * the other holds what our hosting platform served for our projects, counted per five-minute
 * window with the path, the query string, the request id and the address all dropped at the
 * adapter. There is no join from either to a person, so an erasure has nothing to find in them.
 *
 * ── THE FOOTNOTE, WHICH IS `alert_state.fix_href` AND IS WORTH STATING RATHER THAN SKIPPING ──
 *
 * `alert_state` has no `account_id` either and never has, so it has always been outside this
 * graph. Cloud 0030 gives it a column that can CONTAIN one: a per-account rule writes
 * `fix_href = "/accounts/<uuid>"` so an operator can click through from the board. That is a
 * genuine change in what the table can hold, and three things settle it without an entry here:
 *
 *  · **The account never survives the condition — and this bullet was re-argued once the storage
 *    changed under it.** It used to read "`runAlertPass` DELETES the row the moment its
 *    condition stops firing", and that stopped being true in cloud 0030: resolution MARKS the
 *    row so the observation write's insert branch has something to fence against, and resolved
 *    rows are pruned by count (64, table-wide). A `fix_href` of `/accounts/<uuid>` would then sit
 *    on a tombstone until sixty-four later resolutions pushed it out — on a quiet deployment,
 *    indefinitely. The ruling would have gone on reading as settled while its premise was false.
 *
 *    What restores it is not the argument but the code: the mark BLANKS `fix_href`, `detail`,
 *    `title` and `affected_accounts`. A tombstone keeps the key, the two stamps and the
 *    notification record, because that is all the fence and the renotify policy read. So the
 *    account uuid is gone at resolution rather than at deletion, and every rule that writes one
 *    is still a rule whose condition an erasure ENDS: erasing revokes the sessions, drops the
 *    devices and removes the mailboxes, so `device_sync_stale`, `session_sync_stale` and
 *    `session_reuse_revoked` stop firing and are marked — and blanked — within one cadence.
  *  · **What is left is a pseudonymous id.** After erasure `accounts` is a random uuid with a
 *    blank name, and the row itself is retained. A uuid in a href is not a person.
 *  · **Nothing else on the row names the person.** `detail` is composed from counts and ages by
 *    `alerts.ts` itself, and the table's own header rules mail content out of every field.
 *
 * If a rule is ever added that writes an account into `fix_href` for a condition an erasure does
 * NOT end, this ruling stops covering it and the table needs a real entry — a `DELETE FROM
 * alert_state WHERE fix_href LIKE '/accounts/' || $1 || '%'` in the erasure transaction. No such
 * rule exists today: every per-account rule reads sessions, devices or mailboxes, all of which
 * the erasure removes.
 */
export const RETAINED = new Set([
  // See the header: the account row alone, as a pseudonymous subject.
  "accounts",
  // WRITTEN by the erasure, not left behind by it (cloud 0043): the hashes of the account's
  // live tokens, so an app still holding one is told the account was deleted. A SHA-256 of a
  // random secret, the pseudonymous id and an expiry — the column set is pinned in
  // `account-deletion.test.ts`, so a column that could name a person fails there.
  "erased_bearers",
]);

/**
 * The one table erasure EXPIRES rather than deletes, so its rows are still here afterwards.
 *
 * A staging row is the only key to bytes in the object store, and the worker's sweep removes row
 * and object as a pair keyed on `expires_at <= now()`. Deleting the row here would orphan the
 * attachment in the bucket for the life of the deployment — an Art. 17 erasure that leaves the
 * actual file behind and unreachable — so erasure brings the expiry forward instead. Asserted
 * directly by the "brings staged attachment tickets forward to expire NOW" case in both suites,
 * which is what stops this exemption from being a hole in the sweep.
 */
export const EXPIRED_NOT_DELETED = new Set(["attachment_staging"]);

/** PGlite returns `{ rows }`; postgres-js returns the array itself. */
export function rowsOf<T>(r: unknown): T[] {
  return Array.isArray(r) ? (r as T[]) : ((r as { rows: T[] }).rows ?? []);
}

/**
 * The SEED-COVERAGE half of the census: every account-scoped table the sweeps count must
 * hold a row for the account BEFORE erasure, or a zero after it is the fixture's zero and not the
 * deleter's. `screener_suggest_owed` was admitted exactly this way — in scope, unseeded, counted
 * 0 -> 0 with no deleter anywhere. An unseedable table is a red, not a skip: teach
 * `seedFullAccount` its row, or rule the table out of the scope with the reason written down.
 */
export async function unseededScopedTables(db: Db, accountId: string, tables: string[]): Promise<string[]> {
  const unseeded: string[] = [];
  for (const t of tables) {
    // A RETAINED table is not swept, so nothing about a sweep is vacuous over it.
    if (RETAINED.has(t)) continue;
    const rows = await db.execute(
      sql`select count(*)::int as c from ${sql.identifier(t)} where account_id = ${accountId}`,
    );
    if (rowsOf<{ c: number }>(rows)[0]!.c === 0) unseeded.push(t);
  }
  return unseeded;
}

/** Every public table that carries an `account_id`, straight from the catalog. */
export async function accountScopedTables(db: Db): Promise<string[]> {
  const rows = await db.execute(sql`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'account_id'
    order by table_name
  `);
  return rowsOf<{ table_name: string }>(rows).map((r) => r.table_name);
}

/**
 * Every public table carrying an `email` column, straight from the catalog — the SECOND scope an
 * erasure has to have an opinion about.
 *
 * The foreign-key walk below cannot reach the signup funnel: `invites` and `waitlist` hold an
 * address and nothing else that names the account, on purpose (see their headers). A table that
 * stores a person by their address rather than by their account is structurally invisible to the
 * erasure scope, which is how the guard passed over both. This is the question the next
 * funnel table has to answer.
 */
export async function emailBearingTables(db: Db): Promise<string[]> {
  const rows = await db.execute(sql`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'email'
    order by table_name
  `);
  return rowsOf<{ table_name: string }>(rows).map((r) => r.table_name);
}

/**
 * Email-bearing tables outside the account's graph that a CUSTOMER's erasure must not touch.
 *
 * `staff_users` is the operator's own identity — the same fact the structural case's two
 * `not.toContain("staff_…")` assertions state from the other direction. A customer erasing their
 * account has no opinion about who operates the service, and a sweep that redacted this table
 * would sign the operator out of their own console.
 *
 * Nothing else belongs here without a sentence of the same kind. A new table with an `email`
 * column is a place an erased person's address can survive: redact it in
 * `account-deletion-service.ts`, or write down here why it is not a customer's address at all.
 */
export const EMAIL_NOT_A_CUSTOMERS = new Set(["staff_users"]);

/**
 * EVERY TABLE AN ERASURE HAS TO HAVE AN OPINION ABOUT, computed from the catalog rather than
 * written down.
 *
 * Roots are `accounts` plus every table carrying an `account_id`. The closure then follows
 * foreign keys in the CHILD direction only: a table that references something already in the set
 * joins the set.
 *
 * **The roots have to include the `account_id` tables and not just `accounts`**, and that is not
 * belt-and-braces. `mailboxes.account_id` carries no foreign key at all, so a walk that started
 * at `accounts` and followed FKs would never reach `mailboxes` — and therefore never reach
 * `messages`, `flag_state`, `message_instances`, or anything else beneath them. Starting from the
 * column gets the mail half; following FKs downward then picks up the children that have no
 * `account_id` of their own (`message_bodies`, `folder_state`, `flag_state`,
 * `mailbox_credentials`, `credentials`, `totp_secrets`, …), which are precisely the tables an
 * `account_id` sweep is structurally blind to.
 *
 * Only the child direction is followed, so no edge OUT of the account's graph can drag the
 * operator's own identity tables into a customer's erasure. The live counter-example used to be
 * `account_suspensions.suspended_by -> staff_users`, and that table left with the billing half;
 * the direction rule is still the mechanism, and reversing it here is what the two
 * `not.toContain("staff_…")` assertions in the structural case refuse.
 */
export async function erasureScopeTables(db: Db): Promise<string[]> {
  const edges = rowsOf<{ child: string; parent: string }>(await db.execute(sql`
    select tc.table_name as child, ccu.table_name as parent
    from information_schema.table_constraints tc
    join information_schema.constraint_column_usage ccu
      on tc.constraint_name = ccu.constraint_name and tc.table_schema = ccu.table_schema
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'
  `));

  const scope = new Set<string>(["accounts", ...(await accountScopedTables(db))]);
  // Fixed point. The graph is small and shallow; iterating to stability is easier to read than a
  // queue of pending nodes and cannot miss an edge that is discovered out of order.
  for (let grew = true; grew;) {
    grew = false;
    for (const e of edges) {
      if (e.parent !== e.child && scope.has(e.parent) && !scope.has(e.child)) {
        scope.add(e.child);
        grew = true;
      }
    }
  }
  return [...scope].sort();
}

/** What the seed built, for assertions on tables that carry no `account_id` of their own. */
export interface SeededAccount {
  accountId: string;
  userId: string;
  email: string;
  mailboxId: string;
  messageId: string;
  threadId: string;
  contactId: string;
  deviceId: string;
  sessionId: string;
  stagingTicketId: string;
  /** The invite this person was let in on — keyed by their address, outside the account graph. */
  inviteId: string;
  /** Their waitlist entry — same shape, same reason. */
  waitlistId: string;
}

/**
 * Populate one account with a row in every table erasure has to reach. Every globally-unique
 * column gets a fresh value so two accounts can coexist — which is what the cross-account
 * isolation case needs, and what makes this safe to run against the SHARED test Postgres, where
 * rows from other files are present throughout.
 */
export async function seedFullAccount(db: Db, name = "Mila Brunner"): Promise<SeededAccount> {
  const u = randomUUID().slice(0, 8);
  const [acct] = await db.insert(accounts).values({ name }).returning();
  const accountId = acct!.id;
  const email = `mila-${u}@lichtgrat.example`;

  const [user] = await db.insert(users).values({ accountId, email, displayName: "Mila" }).returning();
  const userId = user!.id;

  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: email,
  }).returning();
  const mailboxId = mb!.id;

  await db.insert(mailboxCredentials).values({
    mailboxId, transport: "imap", secretEnc: "enc:xxxx", keyVersion: 1,
  });
  const [screenerFolder] = await db.insert(mailboxFolders)
    .values({ mailboxId, folder: "ohmail/Screener" }).returning();

  const [thread] = await db.insert(threads).values({ accountId }).returning();
  const threadId = thread!.id;

  const dedup = `mid:${randomUUID()}`;
  const [msg] = await db.insert(messages).values({
    accountId, mailboxId, threadId, messageIdHeader: dedup, bodyHash: randomUUID(),
    dedupKey: dedup, subject: "Glaze order", fromAddress: "giulia@example.test",
    date: NOW, nativeLocator: { folder: "INBOX", ref: "1:1" }, snippet: "ciao",
  }).returning();
  const messageId = msg!.id;

  await db.insert(messageBodies).values({ messageId, text: "the whole letter" });
  // The message's search document (mail 0125) — its words again, so an erasure must take it.
  await upsertMessageSearch(db as never, messageId, {
    accountId, subject: "ciao", from: null, to: [], cc: [], attachmentNames: [],
    bodyText: "the whole letter", source: "text",
  });
  await db.insert(folderState).values({
    messageId, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
    reconcileStatus: "reconciled", conflict: false,
  });
  // ── WHAT AN ORDINARY SYNC LEAVES BEHIND, and the reason this fixture is its own file ────────
  // These three are written by the sync loop on any account that has ever fetched mail, they FK
  // `messages`/`mailboxes` with `ON DELETE no action`, and none of them was seeded here before —
  // so the catalog sweep visited `message_instances` and `message_failures`, counted zero rows,
  // and passed, while erasure of a real account died on a foreign-key violation.
  await db.insert(messageInstances).values({
    accountId, mailboxId, messageId, folder: "INBOX", uidvalidity: 1n, uid: 1, isPrimary: true,
  });
  // The SECOND copy — the row shape this table exists for. One message, two folders.
  await db.insert(messageInstances).values({
    accountId, mailboxId, messageId, folder: "Archive", uidvalidity: 1n, uid: 9, isPrimary: false,
  });
  await db.insert(messageFailures).values({
    accountId, mailboxId, folder: "INBOX", uidvalidity: 1n, uid: 42, code: "mime_unparseable",
  });
  await db.insert(flagState).values({
    messageId, desiredSeen: true, observedSeen: false, lastSetBy: "us", reconcileStatus: "pending",
  });
  // `routing_decisions` is also where a BOUGHT SCREENER SUGGESTION lives — same table, told apart
  // by `input_provenance`. Both shapes are seeded so the delete is proven to take both.
  await db.insert(routingDecisions).values({
    accountId, messageId, inputProvenance: "rule", destination: "INBOX", status: "applied",
  });
  await db.insert(routingDecisions).values({
    accountId, messageId, inputProvenance: SCREENER_SUGGESTION_PROVENANCE, destination: "INBOX",
    status: SCREENER_SUGGESTION_STATUS,
  });
  await db.insert(messageStates).values({ accountId, messageId });
  await db.insert(trackerEvents).values({ accountId, messageId, kind: "pixel" });
  await db.insert(attachments).values({ accountId, messageId, contentType: "application/pdf" });
  await db.insert(approvals).values({ accountId, messageId, kind: "route", action: "move" });

  const [contact] = await db.insert(contacts).values({ accountId, address: "giulia@example.test" }).returning();
  const contactId = contact!.id;
  await db.insert(contactNotes).values({ accountId, contactId, body: "prefers Italian" });
  await db.insert(threadNotes).values({ accountId, threadId, body: "delivery moved" });

  const [draft] = await db.insert(drafts).values({
    accountId, mailboxId, threadId, inReplyToMessageId: messageId, subject: "Re: Glaze order",
  }).returning();
  const [send] = await db.insert(outboundSends).values({
    accountId, draftId: draft!.id, idempotencyKey: randomUUID(), mintedMessageId: "<x@y>",
  }).returning();

  await db.insert(rules).values({
    accountId, kind: "sender", match: "giulia@example.test", destination: "INBOX",
  });
  await db.insert(graduations).values({ accountId, patternKey: "sender:giulia@example.test" });
  await db.insert(learningSignals).values({
    accountId, triggeringActionId: randomUUID(), kind: "screener", label: "yes",
  });
  await db.insert(snippets).values({ accountId, title: "Delivery", body: "Standard note" });
  await db.insert(kbEntries).values({ accountId, title: "Voice", content: "warm, short" });
  await db.insert(notifyRules).values({ accountId, target: "giulia@example.test" });
  await db.insert(awayResponders).values({ accountId });
  // The at-most-once record for automatic replies. Seeded because the sweep only sees a table
  // this helper populates: `sender` is a correspondent's address, so an unseeded row here would be
  // a retention the catalog test cannot report.
  await db.insert(awayResponderSent).values({
    accountId, sender: "giulia@example.test", responderUpdatedAt: NOW,
  });
  /*
   * THE READER'S SIDE OF THE ORGANIZER HANDOVER — both halves, seeded for the reason the comment
   * three lines above gives: the catalog sweep counts rows AFTER erasure, so a table this helper
   * never populates is 0 before and 0 after and passes whatever the delete statement does. Both of
   * these were exactly that until now.
   *
   * `organizer_requests.payload` (mail 0088) is a decision about a sender — on a `screener.decide`
   * that is a CORRESPONDENT'S ADDRESS and the verdict passed on them.
   *
   * `mailbox_profile_mirror.doc` (mail 0094) is the whole profile document as a reader cached it:
   * the screener list's correspondent addresses, the person's own rule text, and the
   * away-responder body they wrote. Neither table has a foreign key by design — the record has to
   * outlive the message and the mailbox row — so nothing cascades either one and the two DELETE
   * statements in `account-deletion-service.ts` are the only things that remove them.
   */
  await db.insert(organizerRequests).values({
    accountId, mailboxId, kind: "screener.decide",
    payload: { sender: "giulia@example.test", verdict: "screened_in" },
    decidedAt: NOW, state: "pending",
  });
  await db.insert(mailboxProfileMirror).values({
    mailboxId, accountId, uidvalidity: 1n, uid: 3,
    doc: { v: 1, awayResponder: { body: "Back on Monday." }, tagNames: ["invoices"] },
    readAt: NOW,
  });

  const [wf] = await db.insert(workflows).values({ accountId, name: "File receipts" }).returning();
  await db.insert(workflowRuns).values({ accountId, workflowId: wf!.id });
  await db.insert(workflowProposals).values({ accountId, name: "Proposed: file receipts" });

  await db.insert(changeLog).values({
    accountId, seq: 1n, entityType: "message", entityId: messageId, op: "create",
  });
  await db.insert(accountSyncState).values({ accountId });
  await db.insert(auditLog).values({ accountId, action: "message.move" });
  await db.insert(idempotencyKeys).values({
    accountId, key: randomUUID(), requestHash: "abc", responseStatus: 200,
    responseJson: { ok: true }, expiresAt: LATER,
  });
  await db.insert(pushSubscriptions).values({ accountId, transport: "webpush", endpoint: `https://push.test/${u}` });
  // The account's preferences, including `seedConfirmedAt` — the consent event of onboarding.
  await db.insert(accountSettings).values({
    accountId, dormancyDays: 30, seedConfirmedAt: NOW, seedConfirmedCount: 4, autoSuggestAt: NOW,
  });

  // ── THE HOSTED-ONLY ROWS. None of these raises a foreign-key error, because they all FK
  // `accounts` and `accounts` SURVIVES erasure — which is precisely why they went unnoticed.
  await db.insert(mailboxOauthCeremonies).values({
    accountId, state: `st-${u}`, provider: "microsoft",
    codeVerifierEnc: "enc:verifier", codeVerifierKeyVersion: 1, returnTo: "/mailbox",
  });
  /*
   * …AND ITS DEVICE-CODE SIBLING (cloud 0027), seeded here for a reason the structural test cannot
   * supply on its own: that test accepts the mere PRESENCE of a table's key in `deleted` as
   * coverage, so a DELETE whose predicate is wrong reports zero, satisfies the structure, and
   * leaves a live wrapped device code sitting in the database after an Art. 17 erasure. Without a
   * row here the new statement was never executed against anything at all.
   *
   * The sealed value is the credential this row exists to hold — a `device_code` is a bearer token
   * for the whole ceremony, unlike the PKCE verifier above, which buys nothing on its own.
   */
  await db.insert(mailboxOauthDeviceCeremonies).values({
    accountId, state: `dev-st-${u}`, provider: "microsoft",
    deviceCodeEnc: "enc:device-code", deviceCodeKeyVersion: 1,
    userCode: "ABCD-EFGH", verificationUri: "https://microsoft.com/devicelogin",
    pollIntervalMs: 5_000, grantExpiresAt: LATER,
  });
  // The id is minted by the CALLER here, not defaulted by the column — the object path is derived
  // from it, so the real write path knows the id before it writes. See `attachment-staging.ts`.
  const stagingTicketId = randomUUID();
  await db.insert(attachmentStaging).values({
    id: stagingTicketId, accountId, objectPath: `staging/${accountId}/${stagingTicketId}`,
    filename: "kiln-schedule.pdf", contentType: "application/pdf",
    sizeBytes: 12_345, expiresAt: LATER,
  });

  // The worker's suggest-owed mark (cloud 0039), keyed by the account. Seeded because the seed IS
  // the oracle (see the header): this table sat in the erasure scope UNSEEDED, so both suites'
  // sweeps read 0 -> 0 over it — green whether or not anything erased it.
  await db.insert(screenerSuggestOwed).values({ accountId, owedAt: NOW });

  // The wall's notice ledger (cloud 0040), keyed by the account. Seeded for the suggest-owed
  // mark's reason one block up: the seed IS the oracle, and an unseeded table reads 0 -> 0 over
  // any deleter, green whether or not erasure touched it.
  await db.insert(accountLifecycleNotices).values({ accountId, kind: "closed", anchor: NOW });

  // THE OTHER ELEVEN: each of these had a deleter and no seed, so both sweeps counted
  // 0 -> 0 over them — a wrong predicate in any of those deletes was invisible. One row each;
  // `unseededScopedTables` now refuses the next table that arrives without one.
  await db.insert(accountStorage).values({ accountId, bytes: 2_048 });
  await db.insert(folderOps).values({
    accountId, mailboxId, folderId: screenerFolder!.id, op: "create",
  });
  await db.insert(junkRescues).values({
    accountId, mailboxId, folder: "Junk", uidvalidity: 7n, uid: 11,
  });
  const [tag] = await db.insert(tags).values({ accountId, name: `Invoices-${u}` }).returning();
  await db.insert(messageTags).values({ accountId, messageId, tagId: tag!.id });
  await db.insert(outboundSendFingerprints).values({
    accountId, mailboxId, fingerprint: "ab".repeat(32), sendId: send!.id,
  });
  const [unsubRecord] = await db.insert(unsubscribeRecords).values({
    accountId, mailboxId, listKey: `list-${u}`, state: "sent", httpStatus: 202, messageId,
  }).returning();
  await db.insert(unsubscribeExamined).values({ messageId, recordId: unsubRecord!.id, accountId });
  await db.insert(awayReplies).values({
    accountId, mailboxId, messageId, sender: "giulia@example.test", outcome: "sent", sentAt: NOW,
  });
  await db.insert(awaySenderState).values({
    accountId, sender: "giulia@example.test", lastRepliedAt: NOW, lastTextHash: `th-${u}`,
  });
  // A list address the account's mail named, and a brand a press consented there (mail 0150).
  await db.insert(listAddresses).values({ accountId, address: "club@lists.example.test", consentedBrands: ["PostFinance"] });
  // SETTLED, deliberately: two suites seed accounts they never erase (mailbox-erasure,
  // logout-push-prune), and an OWED row on a shared database is bait for the deployment-global
  // refund drain — the erasure question only needs a ROW, and the deleter takes settled ones too.
  await db.insert(creditRefundObligations).values({
    accountId, action: "screener_suggest", attemptKey: `ak-${u}`, attempt: `at-${u}`,
    reason: "drafter_failed", settledAt: NOW,
  });

  const [device] = await db.insert(devices).values({ accountId, userId, kind: "macos" }).returning();
  const deviceId = device!.id;
  const [session] = await db.insert(sessions).values({
    accountId, userId, deviceId, familyId: randomUUID(),
    accessExpiresAt: LATER, refreshExpiresAt: LATER,
  }).returning();
  const sessionId = session!.id;
  await db.insert(refreshTokens).values({
    accountId, userId, sessionId, familyId: randomUUID(),
    tokenHash: `hash-${u}`, expiresAt: LATER,
  });
  await db.insert(credentials).values({ userId, passwordHash: `scrypt$password-hash-${u}` });
  await db.insert(totpSecrets).values({ userId, secretEnc: "enc:totp", keyVersion: 1 });
  await db.insert(recoveryCodes).values({ userId, codeHash: `h-${u}`, batchId: randomUUID() });
  await db.insert(webauthnCredentials).values({ userId, credentialId: `cid-${u}`, publicKey: "pk" });
  await db.insert(webauthnChallenges).values({
    userId, challenge: "chal", type: "registration", rpId: "app.ohmail.app",
    origin: "https://app.ohmail.app", expiresAt: LATER,
  });
  await db.insert(loginTokens).values({ userId, tokenHash: `lt-${u}`, expiresAt: LATER });
  // A LIVE pairing token (mail 0059): a credential the user minted that still opens the account
  // (device-pair) or the server (invite). Seeded live so the erasure's delete is proven against
  // a row that would otherwise keep working after the account is gone.
  await db.insert(pairingTokens).values({
    createdByUserId: userId, grant: "device-pair", tokenHash: `pt-${u}`,
    label: "erasure fixture device", expiresAt: LATER,
  });
  await db.insert(oauthAuthCodes).values({
    userId, clientId: "desktop", codeHash: `ch-${u}`, codeChallenge: "cc",
    redirectUri: "ohmail://cb", expiresAt: LATER,
  });
  await db.insert(authEvents).values({ accountId, userId, event: "login", ip: "1.2.3.4", device: "app.ohmail.app" });
  await db.insert(authThrottle).values({ key: `email:${email}`, failures: 2 });
  await db.insert(authThrottle).values({ key: `user:${userId}`, failures: 1 });

  // ── THE SIGNUP FUNNEL ────────────────────────────────────────────────────────────
  // How this person got in, keyed by their ADDRESS and by nothing else. Neither table carries an
  // `account_id` and neither has a foreign key into the account's graph — deliberately, so an
  // erasure never has to choose between Art. 17 and the invite record — which is exactly why the
  // structural guard cannot see them and why the seed has to. A row here the sweep misses is an
  // erased person's address still on file.
  const [invite] = await db.insert(invites).values({
    codeHash: `ih-${u}`, email, issuedBy: "operator", expiresAt: LATER,
    consumedAt: NOW, consumedByUserId: userId,
  }).returning();
  const inviteId = invite!.id;
  const [listed] = await db.insert(waitlist).values({
    email, tier: "solo", source: "landing", invitedAt: NOW, registeredAt: NOW,
  }).returning();
  const waitlistId = listed!.id;

  return {
    accountId, userId, email, mailboxId, messageId, threadId, contactId,
    deviceId, sessionId, stagingTicketId, inviteId, waitlistId,
  };
}
