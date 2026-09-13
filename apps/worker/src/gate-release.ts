import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  accountSettings, approvals, autoReplyByUsWhere, contacts, drafts, folderState, mailboxes,
  messageStates, messages, recordChange, recordRuleDelta, rules as rulesTbl,
  CUTLINE_ALLOW_DESTINATIONS, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { silentLogger, type Destination, type Logger } from "@trafficflow/core";
import { dialect } from "@trafficflow/db/dialect";

/* THE ONE-TIME REPAIR FOR MAIL STUCK AT THE SCREENING GATE BEHIND A DECISION ALREADY MADE.
   `confirmSeed` used to write its rules with `retro_requested_at` NULL — consent granted in bulk
   must not move the past — and a NULL there is not owed work, so no pass was ever selected for
   them. Mail imported BEFORE the confirmation therefore sat at the gate for ever, and the Screener
   went on calling its sender first-time. 0.19.0 fixes the seed; this fixes the accounts that
   already confirmed one. It writes NO folder_state for rule-backed senders: it arms the release
   licence (`rules.release_held_at` = `retro_requested_at`, `isReleaseRun`'s shape) and `rule-retro`
   does the filing through `evaluateRules`, with its own bounds. For a sender who is only a
   `contacts` row there is no rule to arm, so those rows are desired into the Ohbox here, under the
   same bounds. Once per account, stamped in `account_settings.gate_release_done_at`. */

/**
 * Rules armed, and contact-only rows released, per account per cycle.
 *
 * The same 100 as {@link RULE_RETRO_BATCH} and for the same reason: `recordChange` and
 * `recordRuleDelta` take the account's `account_sync_state` row lock for the length of their
 * transaction, so a whole-account transaction would stall every API write for that account while
 * the sweep drained. A short page is what says the half is finished.
 */
export const GATE_RELEASE_BATCH = 100;

/** The screening gate, named once. Spelled here rather than imported, for `rule-retro.ts`' reason:
 *  a bulk repair that can pull a service's import graph in is how an IMAP dialer arrives. The
 *  `Destination` annotation is what keeps the spelling honest. */
const SCREENER_GATE: Destination = "ohmail/Screener";

/** Where a sender this account knows belongs. */
const OHBOX: Destination = "INBOX";

export interface GateReleaseDeps {
  /** Scope to ONE account — the worker loops its served accounts. */
  accountId: string;
  log?: Logger;
  /** Test seam. Default {@link GATE_RELEASE_BATCH}. */
  batch?: number;
  /**
   * Sweep an account whose `gate_release_done_at` is already stamped — EVIDENCE, not a repair.
   *
   * The pass is idempotent WITHOUT the marker (an armed rule is in flight and drops out of the
   * selection; a released row is desired into the Ohbox and is no longer at the gate), and this
   * flag exists so that claim can be exercised rather than asserted.
   */
  force?: boolean;
}

export interface GateReleaseResult {
  /** False ⇒ the account was already swept, or this install organizes none of its mailboxes. */
  ran: boolean;
  /** Rules given the release licence. `rule-retro` files their held mail on its next cycle. */
  rulesArmed: number;
  /** Gate rows desired into the Ohbox for senders who are only `contacts` rows. */
  contactRowsReleased: number;
  /** True ⇒ both halves came back short and `gate_release_done_at` was stamped. */
  completed: boolean;
}

/**
 * THE ROWS THE GATE IS HOLDING — the TWIN of `held-release-service.ts#heldAtGate` and of
 * `rule-retro.ts#selectCandidates`' release arm, which it must stay: this is the set that screen
 * offers and that pass moves. The worker may not import the services package, so the tie is
 * BEHAVIOURAL — `gate-release.pg.test.ts` drives both over one fixture.
 *
 * Each bound excludes a shape that must not move: a writer this product knows (an allow-list);
 * both folders the gate, so a hand file elsewhere and a row in flight are untouched; a mailbox
 * this install organizes; and the three cheap user-intent exclusions.
 */
function atTheGate(accountId: string) {
  return and(
    eq(messages.accountId, accountId),
    isNull(messages.deletedAt),
    sql`${folderState.lastSetBy} in ('us', 'peer', 'external')`,
    eq(folderState.desiredFolder, SCREENER_GATE),
    eq(folderState.observedFolder, SCREENER_GATE),
    sql`not exists (
      select 1 from ${mailboxes} mb
       where mb.id = ${messages.mailboxId}
         and (mb.status = 'disabled' or mb.organizer_role <> 'organizer')
    )`,
    sql`not exists (
      select 1 from ${messageStates} ms
       where ms.message_id = ${messages.id} and ms.state <> 'none'
    )`,
    sql`not exists (
      select 1 from ${drafts} d where d.in_reply_to_message_id = ${messages.id}
    )`,
    sql`not exists (
      select 1 from ${approvals} a
       where a.message_id = ${messages.id} and a.status <> 'pending'
    )`,
  );
}

/** Does an enabled `sender`/`domain` rule of this account claim this message's author? */
const ruleClaimsAuthor = (t: Tx, side: "allow" | "any") => {
  const d = dialect(t);
  const allow = sql`(${sql.join(CUTLINE_ALLOW_DESTINATIONS.map((f) => sql`${f}`), sql`, `)})`;
  return sql`exists (
    select 1 from rules rg
     where rg.account_id = ${messages.accountId}
       and rg.enabled
       and rg.kind in ('sender', 'domain')
       ${side === "allow" ? sql`and rg.destination in ${allow}` : sql``}
       and ((rg.kind = 'sender' and trim(lower(rg.match)) = lower(${messages.fromAddress}))
         or (rg.kind = 'domain' and trim(lower(rg.match)) = ${d.domainOf(messages.fromAddress)}))
  )`;
};

/**
 * THE PASS. Per account: arm the release on every allow rule the gate is still holding mail for,
 * release what it is holding from contact-only senders, and stamp the account once both are done.
 *
 * Pure and hermetic — a db/tx handle, a clock and a logger — so a test drives it against PGlite
 * with no worker, no lease and no network.
 */
export async function gateReleasePass(
  db: Tx, deps: GateReleaseDeps, now: Date = new Date(),
): Promise<GateReleaseResult> {
  const log = deps.log ?? silentLogger;
  const batch = deps.batch ?? GATE_RELEASE_BATCH;
  const accountId = deps.accountId;
  const out: GateReleaseResult = {
    ran: false, rulesArmed: 0, contactRowsReleased: 0, completed: false,
  };

  /* AN ACCOUNT THIS INSTALL CANNOT ACT ON IS NOT SWEPT, and is not stamped either — the same
     argument `rule-retro.ts`' owed probe makes. Stamping it would swallow the repair for ever on
     the one state a later promotion can still honour. */
  const [live] = await db.select({ id: mailboxes.id }).from(mailboxes)
    .where(and(
      eq(mailboxes.accountId, accountId),
      sql`${mailboxes.status} <> 'disabled'`,
      eq(mailboxes.organizerRole, "organizer"),
    ))
    .limit(1);
  if (!live) return out;

  if (!deps.force) {
    const [settings] = await db.select({ at: accountSettings.gateReleaseDoneAt })
      .from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1);
    // An ABSENT row and a NULL both mean "never swept", which is every account that predates this
    // column. There is no arm that turns a missing value into "done".
    if (settings?.at != null) return out;
  }
  out.ran = true;

  // THE ACCOUNT'S OWN ADDRESSES, for the fifth user-intent exclusion below — "the user replied
  // from their own mail client", which is the one thing that looks like their action and is not
  // recorded as one.
  const ownRows = await db.select({ address: mailboxes.address }).from(mailboxes)
    .where(eq(mailboxes.accountId, accountId));
  const own = ownRows.map((r) => r.address.toLowerCase());

  const page = await db.transaction(async (tx) => {
    const d = dialect(tx as unknown as Tx);
    const allow = sql`(${sql.join(CUTLINE_ALLOW_DESTINATIONS.map((f) => sql`${f}`), sql`, `)})`;

    /* ── HALF ONE: ARM THE RULES ────────────────────────────────────────────────────────────
     *
     * A rule already IN FLIGHT is excluded rather than re-armed, and that is what makes the page
     * advance: without it the same rules would be selected every cycle until `rule-retro` had
     * moved their mail, and an account with more rules than one page would never finish. It is
     * also the honest answer — a rule whose backlog is open is already being walked.
     */
    const armable = await tx.select({ id: rulesTbl.id }).from(rulesTbl)
      .where(and(
        eq(rulesTbl.accountId, accountId),
        eq(rulesTbl.enabled, true),
        sql`${rulesTbl.kind} in ('sender', 'domain')`,
        sql`${rulesTbl.destination} in ${allow}`,
        or(isNull(rulesTbl.retroRequestedAt), isNotNull(rulesTbl.retroDoneAt)),
        sql`exists (
          select 1 from ${messages}
            join ${folderState} on ${folderState.messageId} = ${messages.id}
           where ${atTheGate(accountId)}
             and ((${rulesTbl.kind} = 'sender'
                   and trim(lower(${rulesTbl.match})) = lower(${messages.fromAddress}))
               or (${rulesTbl.kind} = 'domain'
                   and trim(lower(${rulesTbl.match})) = ${d.domainOf(messages.fromAddress)}))
        )`,
      ))
      .orderBy(asc(rulesTbl.id))
      .limit(batch);

    for (const r of armable) {
      /* THE RELEASE SHAPE, ONE INSTANT FOR BOTH COLUMNS — `isReleaseRun` compares `getTime()`, so
         two clock reads a millisecond apart would write a pair that is never a release run and the
         gate would go on holding the mail. `retro_moved` is reset with the cursor because this
         re-opens the WALK. */
      await tx.update(rulesTbl)
        .set({
          releaseHeldAt: now, retroRequestedAt: now,
          retroDoneAt: null, retroCursor: null, retroMoved: 0, updatedAt: now,
        })
        .where(and(eq(rulesTbl.id, r.id), eq(rulesTbl.accountId, accountId)));
      // THE DELTA, IN THE SAME BLOCK AS THE WRITE — `releaseHeld` does it this way and
      // `rule-state-delta-census.test.ts` refuses a rule write whose block has no door call. A
      // client renders `release_held_at` and the retro cursor, so a mirror that never heard of
      // this would show the rule as it stood until something else touched it.
      await recordRuleDelta(tx as unknown as LedgerTx, accountId, [r.id], "update");
    }

    /* HALF TWO: THE SENDERS WHO ARE ONLY A CONTACT. No rule means nothing to arm, and
       `heldReleaseGroups` is keyed on a rule, so this mail is reachable by no press. A `contacts`
       row is what `evaluateRules` reads as a known sender and what admits their NEW mail past the
       gate, so the only reason theirs is held is that it arrived before the row existed — hence
       the Ohbox. ANY enabled sender/domain rule excludes, not just an allow one: a contact
       somebody later wrote a DENY rule for is the Screened-out tab's, and that rule's own walk is
       what should move their mail. */
    const filters = [
      atTheGate(accountId),
      sql`not ${ruleClaimsAuthor(tx as unknown as Tx, "any")}`,
      sql`exists (
        select 1 from ${contacts} cg
         where cg.account_id = ${messages.accountId}
           and lower(cg.address) = lower(${messages.fromAddress})
      )`,
    ];
    if (own.length > 0) {
      // The fifth exclusion, guarded on a non-empty list (`in ()` is a syntax error) and skipped
      // for a NULL `thread_id`. `and not autoReplyByUsWhere(...)`: an automatic reply is the one
      // thing here that looks like the person's action and is not.
      filters.push(sql`not exists (
        select 1 from ${messages} sent
         where sent.account_id = ${messages.accountId}
           and sent.thread_id = ${messages.threadId}
           and ${messages.threadId} is not null
           and lower(sent.from_address) in ${sql`(${sql.join(own.map((a) => sql`${a}`), sql`, `)})`}
           and not ${autoReplyByUsWhere(dialect(tx as unknown as Tx), {
             accountId: sql`sent.account_id`,
             id: sql`sent.id`,
             fromAddress: sql`sent.from_address`,
             messageIdHeader: sql`sent.message_id_header`,
           })}
      )`);
    }

    const rows = await tx.select({
      messageId: messages.id, observedFolder: folderState.observedFolder,
    }).from(folderState)
      .innerJoin(messages, eq(messages.id, folderState.messageId))
      .where(and(...filters))
      .orderBy(asc(messages.id))
      .limit(batch)
      .for("update", { of: folderState });

    for (const r of rows) {
      // Desired only — `reconcileFolders` is the one crash-safe mover, exactly as `rule-retro`
      // leaves it. `reconcile_status` is DERIVED here for `upsertFolderState`'s reason: a row can
      // never claim a convergence it does not have.
      await tx.insert(folderState).values({
        messageId: r.messageId, desiredFolder: OHBOX, observedFolder: r.observedFolder,
        lastSetBy: "us",
        reconcileStatus: OHBOX === r.observedFolder ? "reconciled" : "pending",
        conflict: false,
      }).onConflictDoUpdate({
        target: folderState.messageId,
        set: {
          desiredFolder: OHBOX, observedFolder: r.observedFolder, lastSetBy: "us",
          reconcileStatus: OHBOX === r.observedFolder ? "reconciled" : "pending",
          conflict: false, updatedAt: now,
        },
      });
      // `meta.from` carries the TRUE previous desired folder, as `rule-retro` does: that one
      // field is what makes a later undo possible without this pass writing anything extra.
      await recordChange(tx as unknown as LedgerTx, {
        accountId, entityType: "message", entityId: r.messageId, op: "move",
        meta: { from: SCREENER_GATE, to: OHBOX },
      });
    }

    return { armed: armable.length, released: rows.length };
  });

  out.rulesArmed = page.armed;
  out.contactRowsReleased = page.released;

  /* THE STAMP IS WRITTEN LAST, and only when BOTH halves came back short — a full page means
     there is more, and claiming completion first would make a crash permanent. Written on its own
     rather than inside the page transaction for the same reason: the sweep is resumable, and a
     page that committed its work is work done whether or not the account is finished. */
  if (page.armed < batch && page.released < batch) {
    await db.insert(accountSettings)
      .values({ accountId, gateReleaseDoneAt: now })
      .onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { gateReleaseDoneAt: now, updatedAt: now },
      });
    out.completed = true;
  }

  if (out.rulesArmed > 0 || out.contactRowsReleased > 0) {
    log.info("gate_release_pass", {
      accountId, rulesArmed: out.rulesArmed,
      contactRowsReleased: out.contactRowsReleased, completed: out.completed,
    });
  }
  return out;
}
