import { accountOfMailbox } from "@trafficflow/db";
import { and, eq } from "drizzle-orm";
import { buildImapAuth, storedTlsPin, type ImapConfig, type CredMetaAuth } from "@trafficflow/core/adapters/imap";
import { storedFoldersOf } from "@trafficflow/core/adapters/drizzle-repo";
import { mailboxCredentials, mailboxes, fenceErasedMailbox, MailboxErasedError, type Tx } from "@trafficflow/db";
import {
  ServiceError, fenceSignedOutMailbox, type CredentialOrigin, signedOutMetaOf,
} from "@trafficflow/services/mail";
import { credentialIsForeign, credentialIsForeignSmtp, sealedSmtpHost } from "./credential-host.js";
import { deriveRequestKey } from "@trafficflow/core/adapters/organizer-lease";
import { dialect } from "@trafficflow/db/dialect";
import type { LocalRosterRow } from "./identity.js";
import type { CredentialState } from "./roster.js";
import type { SidecarConfig } from "./engine-types.js";
import { SIDECAR_NET_TIMEOUTS } from "./engine-reconnect.js";
import { seedDial } from "./engine-classifiers.js";
import type { EngineScope } from "./engine-scope.js";
import type { MailboxScope } from "./engine-mailbox-scope.js";

/**
 * The desktop's engine, one section: one mailbox's login: what it dials, its stored password, the sign-out fence
 * and the connection's facts.
 */
export async function loginSection(
  scope: EngineScope, box: MailboxScope, config: SidecarConfig, mb: LocalRosterRow, isSeed: boolean,
): Promise<void> {
      scope.gapOwed.add(mb.id);
      /**
       * What this mailbox dials. `config.imap` — the `OHMAIL_IMAP_*` the shell set — is now the SEED's only,
       * and only until that mailbox's credential records what a probe proved; every other mailbox dials from
       * its own `imap` credential row's `meta`, where the hosted worker has always read it. One process-wide
       * server for N mailboxes is wrong in a way nothing surfaces: mailbox two dialled at mailbox one's host
       * with mailbox two's password is a login failure if you are lucky, and a successful login to the WRONG
       * ACCOUNT if they share a provider. The seed's fallback is narrow: on first launch it has no credential
       * row yet, and once its row exists the fallback is unreachable. A non-seed row with no credential is a
       * mailbox awaiting a password — it dials nothing and serves the mirror.
       */
      const dialRow = (await scope.db
        .select({ meta: mailboxCredentials.meta })
        .from(mailboxCredentials)
        .where(and(
          eq(mailboxCredentials.mailboxId, mb.id),
          eq(mailboxCredentials.transport, "imap"),
        ))
        .limit(1))[0];
      const dialMeta = (dialRow?.meta ?? null) as
        (CredMetaAuth & { host?: string; port?: number; secure?: boolean; insecureConsent?: boolean }) | null;
      /* The seed dials the host, port and TLS mode it was configured for — the boot contract. As
       * `isSeed && !dialMeta?.host`, a seed whose credential recorded a host dialled the
       * credential's host and ignored the configuration — which silently disables the incoming
       * boot contract: `credentialIsForeign(row.meta, mbImap.host)` with both sides from one
       * row compares the credential against itself and can never disagree, so a launch pointed
       * at a new server would go on dialling the old one for ever, with the password. The
       * seed's dial is the configuration the shell set, keeping the comparison real; mailboxes
       * #2..N have no configured server to disagree with, so the predicate never withholds. ITS
       * CONSENT to dial unencrypted is its row's, as for every other dialler ({@link seedDial}). */
      box.mbImap = isSeed
        ? seedDial(config.imap, dialMeta)
        : {
            host: dialMeta?.host ?? "",
            port: dialMeta?.port ?? 993,
            secure: dialMeta?.secure ?? true,
            ...(dialMeta?.insecureConsent === true ? { allowInsecure: true } : {}),
            // The certificate its row trusts for a server on this computer (honoured on loopback only).
            ...(storedTlsPin(dialMeta) ? { tlsPin: storedTlsPin(dialMeta) } : {}),
            auth: { user: dialMeta?.user ?? mb.address },
            /* NO `smtp` BLOCK. Submission coordinates are the send path's to resolve from this
               mailbox's own `smtp` credential row (`makeSendAdapter`), and a copy here would be a
               second source for them — the exact split that sent mailbox two's mail through
               mailbox one's server. The receive side has no use for them. */
          };

      /** The `(mailbox, imap)` credential row, or null when the user has not supplied one yet. */
      const storedLogin = async (): Promise<{ secretEnc: string; keyVersion: number; meta: unknown } | null> => {
        const rows = await scope.db
          .select({ secretEnc: mailboxCredentials.secretEnc, keyVersion: mailboxCredentials.keyVersion, meta: mailboxCredentials.meta })
          .from(mailboxCredentials)
          .where(and(
            eq(mailboxCredentials.mailboxId, mb.id),
            eq(mailboxCredentials.transport, "imap"),
          ))
          .limit(1);
        return rows[0] ?? null;
      };

      /**
       * Remove this mailbox's password from the store AND from this runtime — see
       * {@link LocalMailboxRuntime.purgeCredential}: every transport's row and the stamp in one
       * transaction, then the plaintext, the login, the timers and every refusal the password earned,
       * leaving a runtime that started without one. Nothing else: the mailbox, its messages and the
       * mirror are reconstructible and no secret. NO EPOCH BUMP: `dialUnder` is read once at attach,
       * so a bump refuses every later dial of this runtime for the process's life — the sign-out
       * wants that ({@link forgetStoredLogin}), a refused press does not.
       */
      const purgeCredential = async (opts?: { keepCoordinates?: boolean }): Promise<boolean> => {
        /**
         * The delete and its proof are one transaction, and the proof is a read. This issued the DELETE, logged
         * `stored_login_cleared` and answered 200 without asking whether the row was gone — a delete that removed
         * nothing read the same from outside, and the shell, seeing 2xx, removed `config.json` with its refusal arm
         * never reached. So the row is deleted and read back in one transaction; a surviving row makes this THROW.
         * `FOR UPDATE` serializes a competing credential write and does not stop it COMMITTING immediately after —
         * a `PATCH` that dialled before this ran re-inserts the sealed password after the 200. That is what the
         * `signed_out_at` stamp below closes: every writer that seals a secret re-reads it under the mailbox's own
         * row lock and refuses when it moved (`packages/services/src/signed-out-fence.ts`).
         */
        const had = await scope.db.transaction(async (tx) => {
          /* EVERY TRANSPORT, not the incoming row alone: a mailbox with an outgoing server holds
             the same password a second time in its `smtp` row, and that row used to survive the
             sign-out with this install's key beside it. */
          const before = await dialect(tx).forUpdate(
            tx.select({ transport: mailboxCredentials.transport, meta: mailboxCredentials.meta })
              .from(mailboxCredentials)
              .where(eq(mailboxCredentials.mailboxId, mb.id)));
          await tx.delete(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mb.id));
          /* AND THE DURABLE STAMP, in the same transaction as the delete. Every writer that seals
             a secret re-reads this column under the mailbox's row lock and refuses when it has
             moved, which is what closes the writer this transaction can serialize but not stop
             committing right after it — the shared `PATCH /mailboxes/:id` a paired phone sends.
             WHERE THE MAILBOX LIVES is kept beside it (mail 0127), through the one allow-list
             builder, so "Sign in again" can take a password alone. Not rewritten when nothing was
             stored, and not written for a seal a server refused, whose coordinates nobody proved. */
          const kept = before.length > 0 && opts?.keepCoordinates !== false
            ? { signedOutMeta: signedOutMetaOf(before) }
            : {};
          await tx.update(mailboxes).set({ signedOutAt: scope.now(), ...kept })
            .where(eq(mailboxes.id, mb.id));
          const after = await tx.select({ mailboxId: mailboxCredentials.mailboxId }).from(mailboxCredentials)
            .where(eq(mailboxCredentials.mailboxId, mb.id));
          if (after.length > 0) {
            throw new ServiceError(
              "stored_login_not_cleared", 500,
              "the stored mailbox password is still on this install — the delete did not take. " +
                "You have not been signed out.",
            );
          }
          return before.length > 0;
        });
        /* THE COPY IN MEMORY GOES WITH THE ROW. Left in `login` and in the dial config, a removed
           password was dialled again by the next poll or "Sync now" after a refused press. */
        box.login = { state: "absent", pass: null };
        useDialledPassword("");
        box.needsCredential = true;
        box.needsCredentialSince ??= scope.now();
        box.launchSkipped = true;
        if (box.timer) { clearTimeout(box.timer); box.timer = null; }
        box.wakePending = false;
        box.ringQueued = false;
        if (box.heartbeatTimer) { clearTimeout(box.heartbeatTimer); box.heartbeatTimer = null; }
        /* Nothing is dialled from here, so there is no outage to report and no refusal left to
           honour: every clock and flag the removed password earned goes with it. */
        box.outageSince = null;
        box.connectionDeadSince = null;
        box.connectionDeadBy = null;
        box.credentialBlock = null;
        box.certificateRefusedNow = false;
        box.plaintextRefusedNow = false;
        /* THE CREDENTIAL IS GONE, so a refusal recorded against the old one is stale evidence.
           This path does NOT detach the runtime, which is why the flag needs clearing here rather
           than by construction — see `signInRefused`. */
        box.clearSignInRefusal("the stored password was forgotten", "nothing dials until a password is entered again");
        await box.closeDialAfterSignOut();
        return had;
      };

      /** The sign-out's forget: {@link purgeCredential}, then the epoch. See {@link Sidecar.forgetStoredLogin}. */
      const forgetStoredLogin = async (opts?: { keepCoordinates?: boolean }): Promise<boolean> => {
        const had = await purgeCredential(opts);
        /**
         * AND THE EPOCH MOVES, so nothing in flight writes this password back and no dial opens a
         * login on a copy another path still holds. Here rather than only in the sign-out route
         * because the refused-launch path (`mobile.ts`) discards a seal without signing out and
         * leaves the same fact. After the row is proven gone: bumping over a clear that THREW would
         * leave an install refusing to dial a credential it still holds.
         */
        scope.fence.bump();
        scope.log("stored_login_cleared", {
          mailboxId: mb.id,
          state: had ? "removed" : "absent",
          reason: "the sealed mailbox password was removed from this install and read back as " +
            "absent; the mirror and the mailbox on the user's own server are untouched",
        });
        return had;
      };

      /**
       * The password this launch will use, and what the shell should be told. The store wins over the
       * environment (the hosted worker's rule: a variable seeds once, never overwrites). The boot contract —
       * one comparison closing both reachable mismatches: the boot (`start()` resolves once; `login.state !==
       * "ready"` stops the dial — the state a crash between the door's seal and `engine_configure` leaves)
       * and the send (`openLocalSend` resolves afresh per send). Before the decrypt: the comparison needs no
       * key, so a foreign credential never becomes plaintext, and foreign outranks `unreadable` — the fact
       * the person can act on. No environment fallback: `pass` is `null`. `smtpHost` is opt-in — only
       * `openLocalSend` passes it; a moved outgoing server must not stop mail.
       */
      const resolveLogin = async (
        opts?: { smtpHost?: string },
      ): Promise<{
        state: CredentialState;
        pass: string | null;
        foreign?: "incoming" | "outgoing" | "outgoing-none";
      }> => {
        /* THE SEED'S, AND ONLY THE SEED'S. The process environment describes one mailbox, so a
           password in it is a fact about that one. Offering it as a fallback for mailbox two
           would authenticate to mailbox two's server with mailbox one's secret. */
        const envPass = isSeed ? config.imap.auth.pass : undefined;
        const row = await storedLogin();
        if (!row) return envPass ? { state: "ready", pass: envPass } : { state: "absent", pass: null };
        /**
         * Which comparison failed rides out with the state — load-bearing, not convenience.
         * `foreign-host` is one state with two causes, and the send path has to say which in
         * words a person can act on: told the OUTGOING server is wrong when the incoming one
         * moved, they would change a setting that was already right, and following the
         * instruction cannot recover the install. A true sentence about the wrong server is the
         * exact failure this seam exists to end. The shell is not given this: it renders the
         * state, whose meaning there is the boot's — see {@link CredentialState}.
         */
        /* THIS MAILBOX'S configured host, not the process's. With one mailbox those were the
           same string; with several, comparing mailbox two's stored credential against mailbox
           one's host answers a question about the wrong pair of servers — and answers it
           WRONGLY in the direction that withholds a working password. */
        if (credentialIsForeign(row.meta, box.mbImap.host)) {
          return { state: "foreign-host", pass: null, foreign: "incoming" };
        }
        // Before the decrypt for the same reason the line above is: a credential this engine has no
        // business offering to this server is never brought into memory as plaintext at all.
        // INCOMING FIRST, so the incoming fault wins when both disagree: it stops the whole launch,
        // and settling it is what makes the outgoing question meaningful.
        if (opts !== undefined && credentialIsForeignSmtp(row.meta, opts.smtpHost)) {
          /**
           * TWO OUTGOING CAUSES, NOT ONE, and the split is not a refinement — it decides what the
           * person is told to do. The credential can disagree because it names a DIFFERENT server,
           * or because it names NONE — and those have different recoveries. "Point the outgoing
           * server back" is an instruction with no referent for the second: there was never a
           * previous submission server to return to, and the only way out is to save the password
           * for the one that is now configured. Telling somebody to restore a setting that never
           * existed is the same true-sentence-about-the-wrong-thing this whole seam exists to end.
           */
          return {
            state: "foreign-host",
            pass: null,
            foreign: sealedSmtpHost(row.meta) === "" ? "outgoing-none" : "outgoing",
          };
        }
        try {
          const secret = await scope.keyProvider.decrypt(row.secretEnc, row.keyVersion);
          // Route the stored row through the SHARED builder, with NO token source. A password row
          // (the only kind a desktop install writes) returns `{ user, pass }` and this validates it;
          // an oauth2 row THROWS here — the desktop has no token source in this phase — and is handled
          // below as "unreadable" rather than being decrypted and dialled with a refresh token as a
          // password. One interpreter of `authType`, on the desktop too.
          buildImapAuth((row.meta ?? {}) as CredMetaAuth, secret);
          return { state: "ready", pass: secret };
        } catch {
          // The thrown value is deliberately not logged and not inspected. It comes from AES-GCM
          // via a provider that also carries key material, and the only fact this code needs is
          // the one the branch already establishes: this key does not open that row.
          return { state: "unreadable", pass: envPass ?? null };
        }
      };


      /**
       * FIRST RUN: seal the password the user just typed, so no later launch needs it.
       *
       * Skipped without a durable key — the whole point of the refusal above — and skipped when a
       * row already exists, which is what keeps this idempotent across every relaunch. It is NOT
       * the recovery path: a row that exists and cannot be read is left exactly as it is, and
       * re-entry through `PATCH /mailboxes/:id` is what replaces it. Overwriting here would mean a
       * launch script with a stale password could silently reseal a credential the user had
       * already corrected.
       */
      // See the note in `resolveLogin`: the environment's password belongs to the seed.
      const envPass = isSeed ? config.imap.auth.pass : undefined;
      /* THE SIGN-OUT FENCE, over the launch's own seal. This is a credential write like the door's
         — it just runs at boot rather than at a press — and the encrypt above it is an await a
         sign-out can land inside, which would seal a password the person had just asked to be
         gone. Discarded rather than merely refused: the insert may already have committed. */
      if (scope.durableKey && envPass && !(await storedLogin())) {
        const bootSeal = scope.fence.begin();
        /* AND THE DURABLE STAMP, read BEFORE the encrypt — the await a sign-out lands inside. The
           insert runs in a transaction that re-reads it under this mailbox's row lock, so a
           password a sign-out overtook is never WRITTEN rather than written and removed again. A
           launch that starts AFTER a sign-out reads the same value it commits against and is
           admitted: signing out does not stop somebody signing back in. */
        const sealOrigin: CredentialOrigin = {
          row: "already-there", signedOutAt: await scope.signedOutAtOf(mb.id),
        };
        try {
          const sealed = await scope.keyProvider.encrypt(envPass);
          await scope.db.transaction(async (tx) => {
            await fenceSignedOutMailbox(tx as unknown as Tx, dialect(scope.db), mb.id, sealOrigin);
            /* AND THE ERASURE FENCE, on the row the sign-out fence just took, so it costs no
               lock. A removal leaves the `mailboxes` row as its tombstone, so this row's key to
               it refuses the ACCOUNT sweep and nothing else: without this, a relaunch reseals
               the passwords of a mailbox somebody erased. */
            await fenceErasedMailbox(tx as unknown as Tx, dialect(scope.db), mb.id);
            await tx.insert(mailboxCredentials).values({
              mailboxId: mb.id,
              accountId: accountOfMailbox(mb.id),
              transport: "imap",
              secretEnc: sealed.ciphertext,
              keyVersion: sealed.keyVersion,
              // The same non-secret shape the hosted worker writes, so one row shape serves both.
              meta: {
                host: box.mbImap.host, port: box.mbImap.port,
                secure: box.mbImap.secure, user: box.mbImap.auth.user,
                /**
                 * And the submission host this password is being sealed for — the outgoing half of the same record. One
                 * password covers both transports, and this is the only place that fact is written down. OMITTED, not
                 * empty, when this launch has no submission server configured — the one place that differs from the door,
                 * deliberately: an empty value states "no outgoing server is authorized", which the door can say because
                 * a door submit is a complete statement the person can make again. This seal is a bootstrap from an
                 * environment (the self-hosted path), where an operator may add the outgoing variable later with no door
                 * to re-save through — "none authorized" would refuse every later send with no recovery surface. Absent
                 * means "this row says nothing", the tolerance every older credential relies on.
                 */
                ...(isSeed && config.imap.smtp?.host ? { smtpHost: config.imap.smtp.host } : {}),
              },
              updatedAt: scope.now(),
            });
          });
          if (bootSeal.stale()) {
            await scope.discardCredentialsFor(mb.id);
            scope.log("stored_login_seal_discarded", {
              mailboxId: mb.id,
              reason: "this install signed out while the launch was sealing its password, so the "
                + "row it had just written was removed again and nothing dials on it",
            });
          } else {
            scope.log("stored_login_sealed", {
              mailboxId: mb.id,
              reason: "the mailbox password was encrypted into the local store under this install's " +
                "key; later launches read it back and need no password in the environment",
            });
          }
        } catch (err) {
          /* THE FENCE'S OWN REFUSAL IS NOT A FAILED LAUNCH — nothing was written, so there is
             nothing to undo and the mailbox comes up with no stored password, which is what
             signing out asked for. The ERASURE fence's refusal is the same answer for the same
             reason and is named FIRST, ahead of the code test: a class that fell through to the
             `throw` would stop the whole attach — every other mailbox with it — over one mailbox
             somebody removed. Any other fault still stops it. */
          if (err instanceof MailboxErasedError) {
            scope.log("stored_login_seal_discarded", {
              mailboxId: mb.id,
              reason: "this mailbox was erased before the launch finished sealing its password, "
                + "so no password was stored and nothing dials on it",
            });
          } else if ((err as { code?: string }).code !== "signed_out") throw err;
          else scope.log("stored_login_seal_discarded", {
            mailboxId: mb.id,
            reason: "this install had signed out of this mailbox before the launch finished "
              + "sealing its password, so no password was stored and nothing dials on it",
          });
        } finally {
          bootSeal.settle();
        }
      }

      // TWO LITERAL CALL SITES AND NOT ONE COMPUTED NAME. A guard over this package walks every
      // `log(...)` call and refuses an event name it cannot read statically, which is not pedantry:
      // a call site whose event is an expression is a call site whose FIELDS cannot be checked
      // either, and unchecked fields are how a secret reaches a log line. The guard caught this one
      // as a ternary while it was being written.
      /**
       * THE SIGN-OUT EPOCH THIS MAILBOX'S PASSWORD BELONGS TO, read before it is resolved. The
       * plaintext then lives in this closure and in `imapConfig.auth` for the life of the
       * attachment, so "the row is gone" is not the same fact as "nothing can dial with it" —
       * every dial re-reads the epoch and refuses when a sign-out has moved it.
       */
      const dialUnder = scope.fence.generation();
      /** Whether a sign-out has happened since this mailbox resolved its password. */
      const signedOutSinceDial = (): boolean => scope.fence.generation() !== dialUnder;
      /* `let`, and the one writer is {@link rereadCredential}. A launch that cannot open its
         stored password is an outage this install can come out of without a restart — the person
         re-enters it, the next poll's read opens the row, and this binding is what the dial then
         uses. Nothing else reassigns it. */
      box.login = await resolveLogin();
      if (box.login.state === "absent") {
        scope.log("stored_login_absent", {
          mailboxId: mb.id,
          state: box.login.state,
          reason: "no password is stored and none was supplied, so this install serves the mirror " +
            "it already has and waits for one",
        });
      } else if (box.login.state === "unreadable") {
        scope.log("stored_login_unavailable", {
          mailboxId: mb.id,
          state: box.login.state,
          reason: "a stored password exists and this install's key does not open it; the mirror is " +
            "intact and re-entering the password re-seals it. The mailbox on the server is " +
            "untouched, and deleting the data directory re-syncs it from scratch",
        });
      } else if (box.login.state === "foreign-host") {
        // NEITHER HOST IS NAMED, and that is the same rule the two lines above obey. Which mail
        // server a person's mailbox is on is the identifying signal this package's census keeps off
        // a log line, and the pair of them is more identifying than either. `mailboxId` is what
        // correlates this with everything else in the launch; the hosts are on screen, where the
        // person who can act on them already is.
        scope.log("stored_login_foreign_host", {
          mailboxId: mb.id,
          state: box.login.state,
          reason: "the stored password was proved against a different server than this launch is " +
            "configured for, so it was withheld and nothing was dialled. The mirror is intact and " +
            "the mailbox on the server is untouched; finishing or undoing the change of server " +
            "resolves it",
        });
      }

      /**
       * The adapter is built with whatever password this launch resolved, and `start()` refuses to
       * connect when there is none. "Takes effect on the next launch" is retired: that justification
       * (reconfiguring the local door replaces the engine) covers the SEED and nothing else — a mailbox
       * added from Settings gets no engine replacement, so a person fixing its password watched it stay
       * broken until they quit the app, with the form having said saved. The credentials stay immutable
       * underneath a running sync loop: `PATCH /local/mailboxes/:id` DETACHES the runtime and attaches
       * a fresh one, so the new password takes effect through a new connection — the same guarantee,
       * without making a connected socket's credentials mutable.
       */
      const imapConfig: ImapConfig = {
        ...box.mbImap,
        auth: { user: box.mbImap.auth.user, pass: box.login.pass ?? "" },
        /* HERE AND NOT AT THE `new ImapAdapter`, for two reasons. The adapter reads its deadlines
           off the CONFIG (`imapFlowOptions`), not off its options bag; and this config is what
           every dial of this mailbox is built from — the seed's and mailboxes #2..N's alike — so
           a value set at the one construction site would have missed an injected factory and any
           later caller. MERGED rather than assigned, so a caller that configured its own
           deadlines keeps them, and an explicitly-undefined key cannot clobber ours the way a
           plain spread order would. See {@link SIDECAR_NET_TIMEOUTS}. */
        timeouts: { ...SIDECAR_NET_TIMEOUTS, ...(box.mbImap.timeouts ?? {}) },
        /* What the last attach decided for Sent, Junk and Trash: a role never moves by a name guess. */
        storedFolders: await storedFoldersOf(scope.repo, mb.id),
      };
      /* THIS MAILBOX'S REQUEST KEY, from the credential on the line above — the one the socket is
       * opened with. Deriving it anywhere else is how it comes to disagree with the other installs
       * that share this mailbox; see the note where the old process-wide helper used to be. `null`
       * when there is no password to derive from (an OAuth mailbox, or a login not yet resolved),
       * which is the honest degraded mode: no key means the claim advertises no `requests` and a
       * reader is refused at the door with the holder named. */
      box.requestKey = null;
      /**
       * THE PASSWORD THIS MAILBOX DIALS WITH, AND THE KEY DERIVED FROM IT — one writer for both.
       *
       * The request key is HKDF over that password, so the two cannot move apart: left behind, it
       * stays `null` and every request record a reader wrote refuses as a forgery, with the log
       * naming an attack. A second derivation site would be a second chance to move one alone —
       * so the launch and the later read that opens the row both come through here, and
       * `request-key-agreement.test.ts`'s one-site census holds by construction.
       */
      const useDialledPassword = (pass: string): void => {
        imapConfig.auth = { user: box.mbImap.auth.user, pass };
        box.requestKey = deriveRequestKey({ auth: imapConfig.auth, address: mb.address });
      };
      useDialledPassword(box.login.pass ?? "");

      // The connection's own state — the fact the engine used to have no way to hold. A desktop
      // process outlives its sockets: a lid closed past the provider's idle timeout, a Wi-Fi
      // change, a VPN flap or a server `BYE` ends the connection while the timer, the serial
      // queue, the store and the roster entry carry on. With nowhere to write that down, the
      // poll fired into a dead socket and the accessors answered `organizing: true` while
      // nothing was filed and the claim in `ohmail/_meta` aged out. `null` is "the connection
      // is believed good"; a Date is the FIRST moment it was observed dead — first, not latest,
      // so the Settings row can say how long and a failing re-dial does not reset the clock.
      box.connectionDeadSince = null;
      /**
       * When this mailbox first stopped being served — the clock a PERSON is shown. Split from
       * {@link connectionDeadSince} deliberately: "the socket is open again" is a fact about the
       * socket, "this mailbox is being organized again" is a fact about the lease, and a re-dial
       * whose gate could not read `ohmail/_meta` has established the first and not the second.
       * Folded into one field, a re-dial that reached a live server with an unreadable lease
       * cleared the outage and reported the mailbox healthy while nothing was filed. So the
       * socket field drives the re-dial and this one drives the Settings row, clearing only when
       * a cycle has actually been served, or with the password itself ({@link purgeCredential}).
       */
      box.outageSince = null;
      /**
       * WHICH OBSERVATION MARKED IT DEAD, and they are worth telling apart in a log because they
       * are not equally fast and they are not about the same thing: the adapter's own
       * `close`/`error` event (seconds), the duration bound over failing cycles (the arm that
       * works for a connection whose death produced no event at all), the NOOP heartbeat, and
       * `credential` — no socket was ever opened, because the stored password could not be used.
       * The last one names the launch rather than a connection, and saying `event` there would
       * tell a reader a socket reported its own death when none was dialled.
       */
      box.connectionDeadBy = null;
      /**
       * Whether this runtime has already reported that its connection cannot be probed — once per
       * attachment, since it is a property of the adapter. An adapter with no
       * {@link MailboxAdapter.noop} is not a failing connection, and the skip has to be legible or
       * "no heartbeat lines" reads as "the link never went quiet".
       */
      box.heartbeatUnaskable = false;
      /**
       * The server answered and refused the sign-in — different from unreachable, and the difference decides
       * what we do and what the person is told. Unreachable is retried; a refused sign-in will not fix
       * itself, and retrying it every poll produced four LOGIN attempts a minute — which providers throttle
       * and some answer by locking the account, the app turning a wrong password into a lost mailbox. So this
       * suspends the automatic re-dial. It clears EXPLICITLY: "every path detaches the runtime" holds only
       * for `PATCH` on a NON-seed mailbox, so on the others the flag survived the act that fixes it. The
       * sign-out calls it, the seal route reaches it through {@link LocalMailboxRuntime.credentialReplaced},
       * and `test/credential-paths-clear-refusal.test.ts` is the census over which path reaches which.
       */
      box.signInRefused = false;
      /** The last failed dial ended on the server's silence ({@link dialWentQuiet}); a dial or a served cycle clears it. */
      box.wentQuiet = false;
      /**
       * THE SERVER'S CERTIFICATE WAS REFUSED — see {@link certificateRefused}. Stops the automatic
       * ladder (a certificate does not heal in five seconds, and a phone that keeps dialling says
       * "Reconnecting…" over a refusal). A person's forced dial or a foreground resume still asks,
       * rationed by the press floor; a dial that gets through clears it.
       */
      box.certificateRefusedNow = false;
      /**
       * THE CONSENTED PLAINTEXT SERVER IS NO LONGER ON THE PERSON'S OWN NETWORK — see
       * {@link pinPlaintextDial}. The ladder keeps climbing: a laptop that comes home heals it,
       * and a dial that gets through clears it.
       */
      box.plaintextRefusedNow = false;
      /**
       * THE STORED PASSWORD THIS LAUNCH COULD NOT DIAL WITH — see {@link CredentialBlock}.
       *
       * Its own field and not a second meaning for `signInRefused`: nothing answered this launch,
       * so the sentence about a server refusing a sign-in would be true of nothing that happened.
       * Set from `start()`'s non-ready arm, which used to return in silence — `outageSince` stayed
       * null over a mailbox that was not syncing, and Settings said "Up to date". Cleared only by
       * a fresh read that opens the row; the credential itself is never discarded here.
       */
      box.credentialBlock = null;
      /**
       * THIS RUNTIME NEVER DIALLED, BECAUSE IT HAD NO PASSWORD — see
       * {@link MailboxConnectionState.needsCredential}.
       *
       * Not {@link credentialBlock}, which is about a stored row that could not be OPENED: here
       * nothing is stored and there is nothing to open. Not an outage either — no clock is
       * armed and nothing is retried, because with no password there is nothing to retry and
       * dialling an empty one is how a provider locks an account. `start()`'s two no-password arms
       * and {@link purgeCredential} set it, a read that opens the row clears it; its clock moves too.
       */
      box.needsCredential = false;
      /** When {@link needsCredential} became true — set and cleared in the same statements. */
      box.needsCredentialSince = null;
      /**
       * `start()` RETURNED WITHOUT DIALLING FOR WANT OF A PASSWORD — and nothing in this process
       * dials such a runtime later: no poll, no heartbeat, no death for the re-dial to act on. Its
       * adapter was never asked to connect, so every door that would use it (a drain, a claim
       * release) refuses to. Unlike {@link needsCredential} it survives a password being stored:
       * the password is used by the launch that dials it, which on the first connect is the
       * engine the door starts next. One writer, `start()`'s two no-password arms.
       */
      box.launchSkipped = false;
      /* A relaunch over a stamped import is not a first sync; an unreadable row leaves it to the drain. */
      const importStamped = await scope.db.select({ at: mailboxes.initialImportCompletedAt })
        .from(mailboxes).where(eq(mailboxes.id, mb.id)).limit(1)
        .then((r) => r[0]?.at != null, () => false);
      box.storedLogin = storedLogin;
      box.purgeCredential = purgeCredential;
      box.forgetStoredLogin = forgetStoredLogin;
      box.resolveLogin = resolveLogin;
      box.signedOutSinceDial = signedOutSinceDial;
      box.imapConfig = imapConfig;
      box.useDialledPassword = useDialledPassword;
      box.importStamped = importStamped;
}
