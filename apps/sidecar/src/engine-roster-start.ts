import { accountOfMailbox } from "@trafficflow/db";
import { and, eq, sql } from "drizzle-orm";
import { mailboxCredentials, fenceErasedMailbox, type Tx } from "@trafficflow/db";
import { fenceSignedOutMailbox, type CredentialOrigin } from "@trafficflow/services/mail";
// The boot contract's one comparison. Its own file, with no imports, because the desktop shell's
// install model has to apply the identical rule and `apps/desktop` declares no `@trafficflow`
// dependency at all — see the header of `credential-host.ts` for why one definition, not two.
import {
  sealedHost, sealedSmtpHost,
} from "./credential-host.js";
import { dialect } from "@trafficflow/db/dialect";
import { endLegacyOrganizerPauses, loadLocalRoster, loadUnattachedLocalRoster } from "./identity.js";
import { mirrorRowsRemain, stripSettingsHashes, wipeLocalMirror } from "./local-mirror.js";
// An earlier build's sign-out left the outgoing password behind; the boot removes it.
import { removeSignedOutResidue } from "./signed-out-residue.js";
import { forgetStoreCopies } from "./store-copies.js";
import type { SidecarConfig } from "./engine-types.js";
import type { EngineScope } from "./engine-scope.js";

/**
 * The desktop's engine, one section: the start's roster: the stored mailboxes attached, the removals finished, the
 * seed's first launch.
 */
export async function rosterStartSection(scope: EngineScope, config: SidecarConfig): Promise<void> {
    /**
     * A pause an older build left is ended BEFORE the roster is read. The fourth write of the
     * in-place upgrade below, and the one that cannot sit with the other three: they repair a
     * credential the ATTACH seals (so they run after it), while this decides WHICH ROWS THE ATTACH
     * SEES. After the loop it would attach nothing this launch, so the mailbox returns one restart
     * later. {@link endLegacyOrganizerPauses} carries the shape and why the rewrite is a reader.
     * One line per row; the id and the reason, never the address.
     */
    try {
      for (const ended of await endLegacyOrganizerPauses(scope.db, scope.world.accountId, scope.now())) {
        scope.log("local_mailbox_pause_ended", {
          mailboxId: ended.id,
          disabledReason: ended.keptReason,
          /* Appointments the row could not keep, closed with the stand-down's own sentence — a
             send scheduled before the handover, which a reader's drain never reaches. */
          closed: ended.closedSends,
          reason: "a build older than this one recorded that another organizer had taken this "
            + "mailbox by switching the mailbox off; this launch rewrote the row to what it means "
            + "— a READER of that mailbox, mirror growing, organizing nothing — so it runs again "
            + "and can be asked to organize it. Nothing was claimed by the rewrite, and any "
            + "scheduled send it could no longer make was closed with a sentence",
        });
      }
    } catch (err) {
      scope.log("local_mailbox_pause_end_failed", {
        err,
        reason: "a mailbox this install paused under an older version was not fully re-attached: "
          + "either the row still says paused — no connection and no poll timer this launch, and "
          + "the next launch tries again — or it is a reader whose scheduled send is still to be "
          + "closed, which this mailbox's own launch catch-up does on the next start",
      });
    }

    /**
     * Attach every live mailbox. Read ONCE, never on a timer — the only writers of this table are
     * this engine's own routes, so attach and detach are EVENTS. The seed is the row the configured
     * address names; every other is a mailbox added through the door, and the difference matters for
     * two things — the environment password and the process's submission server, both facts about
     * the seed. SEQUENTIALLY, inverting the concurrency rule elsewhere: each attach may WRITE the
     * credential table (a first launch's seal is one such write), and parallel writes into one
     * PGlite backend gain nothing since attaching does not dial — `start()` opens connections.
     */
    for (const row of await loadLocalRoster(scope.db, scope.world.accountId)) {
      await scope.attachLocal(row, scope.isSeedRow(row.address));
    }
    scope.log("local_roster_attached", {
      count: scope.runtimes.size,
      /* It counts RUNTIMES, and used to claim they held claims. The sentence ended "…and its own
       * organizer claim", but attaching does not dial (`start()` does), so the count is runtimes
       * and the clause printed verbatim for a mailbox this install merely READS — one with no claim
       * in `ohmail/_meta`. It cost a release investigation: an empty `ohmail/_meta` beside
       * `count: 1` read as this install believing it held a claim. A log line that overstates is
       * the same fault as a comment that overstates, and dearer. Whether this install organizes a
       * mailbox is the lease's answer, per mailbox, with its own lines. */
      reason: "every mailbox this install holds has a runtime: its own connection and its own poll "
        + "timer; whether it also organizes that mailbox is the lease's answer, logged per mailbox",
    });
    /* And the rows the roster read left out, by name. The count above says how many mailboxes this
     * install RUNS, not which, and `loadLocalRoster` omits every `disabled` row — a paused one and
     * a tombstone alike — so a mailbox this install holds but does not run was absent from the boot
     * record entirely. `ensureLocalWorld`'s lookup is WIDER than the roster's, so a paused row can
     * be the seed and the `serving` line then prints the id of the one mailbox with no runtime — an
     * incident that reads backwards from the log. One line per left-out row (the ordinary install
     * says nothing extra); the id and the reason, never the address. */
    const unattached = await loadUnattachedLocalRoster(scope.db, scope.world.accountId);
    for (const row of unattached) {
      scope.log("local_mailbox_not_attached", {
        mailboxId: row.id,
        disabledReason: row.disabledReason,
        reason: "this install holds this mailbox and is not running it: no connection, no poll "
          + "timer and no organizer claim. A row with a reason is paused; one without is a "
          + "mailbox that was removed here",
      });
    }
    /**
     * A REMOVAL THE LAST RUN DID NOT FINISH IS FINISHED HERE. A removal commits its tombstone and
     * then wipes the mirror in many statements, and a close, a crash or an older build can leave
     * the tombstone with mail still under it — readable in the window, and doubled the day the
     * address is added again. From the next launch a tombstone has no runtime, so nothing else
     * would ever wipe it. Only a row WITHOUT a reason (`endLegacyOrganizerPauses`' own
     * discriminator; a paused row is the same mailbox and keeps every message) and WITHOUT a
     * credential, which is the removal's own shape: `MailboxService.delete` writes the tombstone
     * and deletes the credentials in one transaction, while a row switched off by a plain
     * `PATCH {status: "disabled"}` keeps both its credential and its mail. And only one that still
     * holds rows (`mirrorRowsRemain`), so an ordinary start reads a few empty rows per removed
     * mailbox and writes nothing. BEFORE the doors serve, so the window never reads the mail
     * again; the wipe writes its receipt, which takes the mailbox out of the window's own mirror. A
     * wipe that fails is said and tried at the next start; it never stops this one.
     */
    /* AND THE HASHES OF A REMOVED MAILBOX'S SETTINGS, which a removal by an earlier version left on
       its audit rows (`stripSettingsHashes`): asked of every removed row before its mail, and once
       of rows naming a mailbox this store no longer has. A clean store only reads. */
    const clearRemovedHashes = async (mailboxId: string | null): Promise<void> => {
      try {
        await stripSettingsHashes(scope.db as unknown as Tx, mailboxId);
      } catch (err) {
        scope.log("removed_mailbox_hashes_clear_failed", {
          err, mailboxId,
          reason: "a hash of a removed mailbox's settings is still on this computer's audit rows; "
            + "the next start tries again",
        });
      }
    };
    for (const row of unattached) {
      if (row.disabledReason !== null) continue;
      try {
        const credential = await scope.db.select({ id: mailboxCredentials.mailboxId }).from(mailboxCredentials)
          .where(eq(mailboxCredentials.mailboxId, row.id)).limit(1);
        if (credential.length > 0) continue;
        await clearRemovedHashes(row.id);
        if (!(await mirrorRowsRemain(scope.db, row.id))) continue;
        await wipeLocalMirror(scope.db, { accountId: scope.world.accountId, mailboxId: row.id });
        // …and every earlier copy of the store, which still holds it; one left is removed by the next start.
        try { forgetStoreCopies(config.dataDir, "start_cleanup", scope.log); } catch { /* said by the removal's own line */ }
        scope.log("local_mirror_wipe_finished", {
          mailboxId: row.id,
          reason: "this mailbox was removed here and its mail was still on this computer — a "
            + "removal cut short by a close or a crash, or one an older version made — so this "
            + "start took it off and told the window; nothing was deleted from the mail server",
        });
      } catch (err) {
        scope.log("local_mirror_wipe_failed", {
          err,
          mailboxId: row.id,
          reason: "a mailbox removed here still has mail on this computer and this start could "
            + "not clear it; the next start tries again, and removing it again runs the same wipe",
        });
      }
    }
    await clearRemovedHashes(null);

    /* THE REPAIRS RUN AFTER THE ATTACH, and the order is the whole of whether they ever fire.
       On a FIRST launch the seed's incoming credential does not exist when this function starts —
       it is sealed inside `attachLocal`, out of the password this process was handed — so a repair
       placed ahead of the attach would find nothing to read and nothing to copy. The measured cost
       of that ordering was a fresh install that could not send for its whole first session and
       silently acquired the ability on its second launch, which is the shape of defect that gets
       reported as "it started working on its own". */
    /**
     * The in-place upgrade and the roster it leaves. Nothing moves — store, rows, credential and
     * the `ohmail/_meta` claim are byte-identical; only the READER changed (an install that ran one
     * mailbox now runs a roster of one). Four writes make it true, each keyed on a predicate false
     * once done (no marker, no journal). The FOURTH is above the attach loop (it decides which rows
     * the attach sees); the three below repair what the attach sealed — the seed row, the incoming
     * server backfilled onto the seed's `imap`, and the submission credential — because every
     * mailbox now dials from its own row, so a seed predating that would come up with no server.
     */
    const seedRow = scope.world.mailboxId ? scope.runtimeRosterRow(await loadLocalRoster(scope.db, scope.world.accountId), scope.world.mailboxId) : null;
    if (seedRow) {
      /* 2. The incoming server. `sealedHost(meta) === null` is the whole predicate — the row does
       * not record which server it was proved against, the shape of every credential sealed before
       * the probe recorded one, and exactly what the new reader cannot dial from. It writes what
       * THIS launch is configured with — the only evidence, and the same pair the old reader
       * dialled, so a rollback finds a `meta.host` its `credentialIsForeign` agrees with. MERGED,
       * never replaced: the blob may already carry `smtpHost` or an OAuth block. */
      try {
        const [row] = await scope.db
          .select({ meta: mailboxCredentials.meta })
          .from(mailboxCredentials)
          .where(and(
            eq(mailboxCredentials.mailboxId, seedRow.id),
            eq(mailboxCredentials.transport, "imap"),
          ))
          .limit(1);
        if (row && sealedHost(row.meta) === null && config.imap.host) {
          await scope.db.update(mailboxCredentials)
            .set({
              /* Through the seam: the server's `||` is the shallow merge and on the device store
                 `||` concatenates STRINGS, so this spelling would have written two JSON documents
                 end to end into the column with nothing failing at the write. */
              meta: dialect(scope.db).jsonMergeShallow(mailboxCredentials.meta, sql`${JSON.stringify({
                host: config.imap.host, port: config.imap.port,
                secure: config.imap.secure, user: config.imap.auth.user,
              })}`),
            })
            .where(and(
              eq(mailboxCredentials.mailboxId, seedRow.id),
              eq(mailboxCredentials.transport, "imap"),
            ));
          scope.log("seed_login_server_recorded", {
            mailboxId: seedRow.id,
            reason: "this mailbox's stored password did not record which server it was proved "
              + "against, and every mailbox now dials from its own credential; the server this "
              + "launch is configured for was written onto it, which is where the previous "
              + "version dialled",
          });
        }
      } catch (err) {
        scope.log("seed_login_server_record_failed", {
          err,
          reason: "the stored password does not say which server it belongs to; this launch dials "
            + "the configured server as before and the next launch tries the repair again",
        });
      }

      /* 3. The submission credential. The send path reads a mailbox's `smtp` row, so a seed that
       * never had one loses the ability to send on upgrade (its submission server was a process
       * setting, no longer consulted). THE SECRET IS COPIED, NEVER DECRYPTED: `secretEnc` and
       * `keyVersion` come from the `imap` row verbatim — same password, same mailbox, same key, so
       * the ciphertext is already what an `smtp` row should hold. Re-encrypting would put plaintext
       * in this process for nothing and break a boot whose key cannot open its own row. The `meta`
       * is the coordinates typed beside that password. */
      try {
        const rows = await scope.db
          .select({
            transport: mailboxCredentials.transport,
            secretEnc: mailboxCredentials.secretEnc,
            keyVersion: mailboxCredentials.keyVersion,
            meta: mailboxCredentials.meta,
          })
          .from(mailboxCredentials)
          .where(eq(mailboxCredentials.mailboxId, seedRow.id));
        const imapRow = rows.find((r) => r.transport === "imap");
        const hasSmtp = rows.some((r) => r.transport === "smtp");
        /**
         * Which submission server this row is for — not simply "the configured one". This read
         * `config.imap.smtp`, which would let an install acquire a submission server nobody saved
         * the password for, just by relaunching with a different setting. The credential RECORDS
         * the host it was saved for (`meta.smtpHost`), and that is an authorization.
         * {@link sealedSmtpHost}'s three answers are the cases: a HOSTNAME — use it whatever this
         * launch configures; NOTHING (key absent) — predates the record, so the process setting is
         * honest; the EMPTY STRING — saved for a pair with NO submission server, so write nothing.
         */
        const witness = sealedSmtpHost(imapRow?.meta ?? null);
        const configured = config.imap.smtp;
        /**
         * And the port must come from the same server as the host. The witness records a HOSTNAME
         * only (a flat `meta.smtpHost`, so a merge cannot erase a stored port), so when it
         * DISAGREES with this launch's configuration there is no port to pair it with — taking the
         * configured one builds the row from two different servers (e.g. `{465-server, 587,
         * cleartext}`), written once and never healing. So a disagreeing witness writes NO ROW —
         * the old behaviour the send path's outgoing arm used to refuse, right because the person is
         * mid-change. The two agreeing cases (a match, or nothing recorded) are unchanged.
         */
        const witnessAgrees = witness !== null && witness !== ""
          && witness === (configured?.host ?? "").trim().toLowerCase();
        /* A SEAL THAT RECORDED THE OUTGOING SERVER AS REFUSED is a decision, not a gap: copying a row
           nobody proved, with no consent on it, over that record is what made every send fail. */
        const unsettled = (imapRow?.meta as { smtpUnsettled?: unknown } | null | undefined)?.smtpUnsettled;
        const refusedHere = typeof unsettled === "string" && unsettled !== "";
        const smtp = !refusedHere && (witness === null || witnessAgrees) ? configured : undefined;
        if (witness !== null && witness !== "" && !witnessAgrees) {
          scope.log("seed_submission_login_unsettled", {
            mailboxId: seedRow.id,
            reason: "this mailbox's password was saved for a different outgoing server than this "
              + "launch is configured for, so no submission credential was written and sending is "
              + "refused; entering the password again records the pair that is wanted",
          });
        }
        if (smtp?.host) {
          if (imapRow && !hasSmtp) {
            /* THE SIGN-OUT FENCE, because this copies a SECRET. The rows above were read before
               this repair decided anything, so a sign-out landing in between would leave this
               writing the removed password back as an `smtp` row — the same window the shared
               PATCH carries, reached at boot instead of at a press. */
            const copyOrigin: CredentialOrigin = {
              row: "already-there", signedOutAt: await scope.signedOutAtOf(seedRow.id),
            };
            await scope.db.transaction(async (tx) => {
              await fenceSignedOutMailbox(tx as unknown as Tx, dialect(scope.db), seedRow.id, copyOrigin);
              // The erasure fence, the seal's note above — this copies the same secret onto a
              // second transport, so an erased mailbox must refuse it for the same reason.
              await fenceErasedMailbox(tx as unknown as Tx, dialect(scope.db), seedRow.id);
              await tx.insert(mailboxCredentials).values({
                mailboxId: seedRow.id,
                accountId: accountOfMailbox(seedRow.id),
                transport: "smtp",
                // The SAME ciphertext under the SAME key version. See the note above.
                secretEnc: imapRow.secretEnc,
                keyVersion: imapRow.keyVersion,
                meta: {
                  host: smtp.host, port: smtp.port, secure: smtp.secure,
                  user: config.imap.auth.user,
                },
                updatedAt: scope.now(),
              });
            });
            scope.log("seed_submission_login_copied", {
              mailboxId: seedRow.id,
              reason: "the outgoing server this install was configured with was written onto this "
                + "mailbox as its own credential, so sending keeps working now that every mailbox "
                + "submits through the server its own row names; no password was decrypted",
            });
          }
        }
      } catch (err) {
        scope.log("seed_submission_login_copy_failed", {
          err,
          reason: "this mailbox has no stored outgoing server, so a send from it is refused until "
            + "the password is entered again; nothing else is affected and the next launch tries "
            + "the repair again",
        });
      }
    }

    /* WHAT AN EARLIER BUILD'S SIGN-OUT LEFT: a mailbox with no incoming row holding its
       outgoing one, password and all. AFTER the attach, so a launch that sealed a password just
       now is signed in and keeps its rows. The coordinates move into `signed_out_meta` first
       (`signed-out-residue.ts`); one line per mailbox, never again once removed. */
    try {
      for (const done of await removeSignedOutResidue(scope.db, scope.world.accountId)) {
        // An earlier copy of the store still holds that password; one left is removed by the next start.
        try { forgetStoreCopies(config.dataDir, "start_cleanup", scope.log); } catch { /* said by the removal's own line */ }
        scope.log("signed_out_residue_removed", {
          mailboxId: done.mailboxId,
          count: done.count,
          reason: "an earlier version signed this mailbox out and left its outgoing server's "
            + "password stored; it was removed, and the server and username were kept so "
            + "Sign in again can still name them",
        });
      }
    } catch (err) {
      scope.log("signed_out_residue_remove_failed", {
        err,
        reason: "a signed-out mailbox still holds its outgoing server's password from an earlier "
          + "version; Sign in again replaces it, and the next launch tries the removal again",
      });
    }
}
