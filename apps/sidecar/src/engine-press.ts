import { eq } from "drizzle-orm";
import { loopbackHarnessReason, googleAuthHint } from "@trafficflow/core/adapters/imap";
import { mailboxCredentials, mailboxes } from "@trafficflow/db";
import { nodeRemoteFetch, launchRefused, signedOutTransportMeta } from "@trafficflow/services/mail";
import { API_VERSION, type ApiDeps } from "@trafficflow/api/local";
import { runsPass } from "./composition-passes.js";
import { HOST_SEND_MAX_TOTAL_BYTES } from "./host-listener.js";
import type { DialAnswer, LocalMailboxRuntime } from "./roster.js";
import type { SidecarConfig } from "./engine-types.js";
import { localServices } from "./engine-local-services.js";
import { SIDECAR_NET_TIMEOUTS } from "./engine-reconnect.js";
import { tlsRefused, credentialsRefused, BAKED_ENGINE_VERSION } from "./engine-classifiers.js";
import type { EngineScope } from "./engine-scope.js";

/** The desktop's engine, one section: the host door's container and what a pressed sign-in is answered with. */
export function pressSection(scope: EngineScope, config: SidecarConfig): void {
    /**
     * Attach one mailbox — everything this install does with one server and one login. The body
     * below is what `createSidecar` used to do to its only mailbox, unchanged in substance and
     * now parameterised by the row: it resolves that row's credential, opens its connection,
     * holds its lease, runs its poll timer and its serial queue, and hands back the runtime the
     * roster keeps. The install's own passes are NOT in here — they take an account and no
     * mailbox, so they are resolved once and shared by every runtime.
     */
    /**
     * The host door's per-request container — {@link depsFor} with the three differences that ARE the door:
     * the descriptor (`flavor: "desktop-host"`; `pairing: true` is this table's truth — the redeem is
     * mounted, the mint is the window's; `sse: false` is honest until the follow-up the ruling names); the
     * auth config ({@link hostAuthConfig} — the service bag is rebuilt with it so the session lifecycle and
     * the guard read ONE config); and the send surface — the stdio bag declares `sendSurfaceMaxTotalBytes:
     * null`, false on THIS door: a phone's send rides an HTTP body, so the door declares {@link
     * HOST_SEND_MAX_TOTAL_BYTES}, and `effectiveAttachmentCap` still takes the smaller of this and the
     * announced size. `allowCookieAuth: false` rides in — the zero-Set-Cookie census sweeps on that flag.
     */
    const depsForHost = (): ApiDeps => ({
      ...scope.depsFor(),
      authConfig: scope.hostAuthConfig,
      services: {
        ...localServices(
          scope.hostAuthConfig, scope.keyProvider, scope.world.accountId, scope.openLocalSend, scope.holdOffer, scope.unsubscribe,
          config.imageFetch ?? nodeRemoteFetch, scope.organizerKind, scope.signatureCheck !== null, scope.ai,
        ),
        sendSurfaceMaxTotalBytes: HOST_SEND_MAX_TOTAL_BYTES,
      },
      hello: {
        flavor: "desktop-host",
        apiVersion: BAKED_ENGINE_VERSION ?? API_VERSION,
        // No setup ceremony exists on this door: the world was created at first boot, and a
        // device becomes a session through the pairing redeem, never through a setup page.
        needsSetup: false,
        auth: { password: false, totp: false, webauthn: false, publicSignup: false },
        features: {
          sse: false, staging: false, ai: scope.ai.drafter() !== undefined, pairing: true,
          // Same composition, same armed egress as the window's own door above.
          remoteImages: true,
          // Same store and the same pass as the window's own door.
          scheduleFiles: runsPass(scope.organizerKind, "scheduled-send"),
        },
      },
    });

    /* The stored login — what makes a restart survivable. The division of labour across the
       host boundary: the SHELL holds one per-install key in the OS keystore and passes it at
       spawn; the DATABASE holds the mailbox password, envelope-encrypted under that key; the
       environment carries the password EXACTLY ONCE, on the launch the user types it. One key
       per install scales to any number of mailboxes; one keystore item per mailbox would be a
       second credential-at-rest design competing with the hosted envelope. The key wraps
       `mailbox_credentials` and nothing else: losing it costs the stored password, not the
       mail — the mailbox on the user's own server is the master, so a lost key is a password
       prompt, and deleting the data directory plus the keystore item is a clean uninstall that
       leaves every folder and message where it physically sits. */

    /**
     * An outgoing server is not a reason to stop receiving. This door proves both transports before storing anything,
     * and `MailboxService` refuses the whole write when either dial is refused — right on the hosted door, backwards
     * here: a mailbox whose incoming server works could not be connected because its outgoing one was blocked or
     * guessed wrong, and "Test connection" only ever proved IMAP. So a refusal whose transport is `smtp` is not
     * fatal: the call is made again with the submission block dropped and `smtpUnsettled` carrying the probe's reason
     * — the incoming credential is stored and organizes, no `smtp` row is written (an unproven submission credential
     * is exactly what this service refuses to store), the send path refuses with that reason instead of guessing
     * `imap host:587`, and an ordinary credential patch settles it. Only `smtp`: an IMAP refusal stays fatal.
     */
    const SMTP_ONLY_RETRY = "the submission server was refused; the mailbox keeps its incoming "
      + "credential and sending is recorded as unsettled";

    /** A server with no encryption on this network refused: the person's consent line answers it. */
    const consentableRefusal = (err: unknown): boolean => {
      const e = err as { code?: string; details?: { tls?: { kind?: unknown; plaintext?: unknown } } } | null;
      return e?.code === "mailbox_probe_failed" && e.details?.tls?.kind === "tls_unavailable"
        && e.details.tls.plaintext === "offered";
    };

    /** A server on this computer offered its own certificate: the person's trust line answers it. */
    const trustableRefusal = (err: unknown): boolean => {
      const e = err as { code?: string; details?: { tls?: { kind?: unknown; certificate?: unknown } } } | null;
      return e?.code === "mailbox_probe_failed" && e.details?.tls?.kind === "self_signed"
        && typeof e.details.tls.certificate === "object" && e.details.tls.certificate !== null;
    };

    /** Whether the incoming and outgoing servers this install keeps for a mailbox are one host. */
    const pairSharesHost = async (mailboxId: string): Promise<boolean> => {
      const rows = await scope.db.select({ transport: mailboxCredentials.transport, meta: mailboxCredentials.meta })
        .from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mailboxId));
      const [kept] = await scope.db.select({ meta: mailboxes.signedOutMeta }).from(mailboxes)
        .where(eq(mailboxes.id, mailboxId)).limit(1);
      const hostOf = (transport: "imap" | "smtp"): string => {
        const meta = (rows.find((r) => r.transport === transport)?.meta ?? signedOutTransportMeta(kept?.meta, transport)) as
          { host?: unknown } | null | undefined;
        return typeof meta?.host === "string" ? meta.host.trim().toLowerCase() : "";
      };
      return hostOf("imap") !== "" && hostOf("imap") === hostOf("smtp");
    };

    /**
     * The refusal's own reason when it is an SMTP probe refusal, else `null`. A server with no
     * encryption on this network, or one on this computer with its own certificate, is not one: its
     * own line answers it, so the press asks the person, as an incoming refusal of that kind does.
     */
    const smtpRefusalReason = (err: unknown): string | null => {
      const e = err as { code?: string; details?: { reason?: unknown; transport?: unknown } };
      if (e?.code !== "mailbox_probe_failed") return null;
      if (e.details?.transport !== "smtp") return null;
      if (consentableRefusal(err) || trustableRefusal(err)) return null;
      return typeof e.details.reason === "string" && e.details.reason !== ""
        ? e.details.reason
        : "unknown";
    };

    /**
     * Run a credential write; on an SMTP-only refusal, run it again without the submission block.
     *
     * The body is rebuilt rather than mutated: `create` and `update` both read it more than once
     * and a caller's object is not this function's to change.
     */
    const keepingIncoming = async <T>(
      body: Record<string, unknown>,
      run: (b: Record<string, unknown>) => Promise<T>,
    ): Promise<T> => {
      try {
        return await run(body);
      } catch (err) {
        const reason = smtpRefusalReason(err);
        if (reason === null) throw err;
        scope.log("local_mailbox_smtp_unsettled", { verdict: reason, reason: SMTP_ONLY_RETRY });
        const imap = (body.imap ?? {}) as Record<string, unknown>;
        const { smtp: _dropped, ...rest } = body;
        return await run({ ...rest, imap: { ...imap, smtpUnsettled: reason } });
      }
    };

    /**
     * THE ANSWER A "SIGN IN AGAIN" PRESS GIVES ON A MAILBOX THAT NEVER DIALLED — the first
     * connect's shape. The launch is awaited within its own two dial deadlines (connect +
     * greeting); a server refusing the sign-in or the encrypted way in is the press's refusal, and
     * the password the press stored leaves the store AND the runtime ({@link LocalMailboxRuntime.purgeCredential},
     * never the sign-out's bump), so it cannot win over the next press and nothing dials it again.
     * An outage, a slow server or no dial at all is not a refusal: the password stays, and the
     * connection record says what the mailbox is doing.
     */
    const answerPressLaunch = async (
      mailboxId: string, rt: LocalMailboxRuntime, answer: Promise<DialAnswer | null>,
    ): Promise<void> => {
      const t = { ...SIDECAR_NET_TIMEOUTS, ...(rt.imap.timeouts ?? {}) };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const within = await Promise.race([
        answer.catch((err: unknown) => {
          scope.log("local_mailbox_repoint_failed", {
            err,
            reason: "the new password is stored and this mailbox uses it from the next launch; "
              + "nothing was undone",
          });
          return null;
        }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), t.connectionMs + t.greetingMs);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]).finally(() => clearTimeout(timer));
      if (within === null || within.outcome !== "failed") return;
      const refused = credentialsRefused(within.err) ? "auth" : tlsRefused(within.err) ? "tls" : null;
      if (refused === null) return;
      await rt.purgeCredential({ keepCoordinates: false });
      scope.log("local_mailbox_launch_refused", {
        mailboxId,
        err: within.err,
        reason: "the mail server refused the launch this press started, so the password it had "
          + "just stored was removed again, from the store and from this mailbox's memory, and "
          + "the press is answered with the refusal",
      });
      // This engine dials every mailbox with the long wait, so a loopback host's refusal is said as its own;
      // Google's refused sign-in says why (`googleAuthHint`, its hosts only).
      throw launchRefused(
        refused, loopbackHarnessReason(rt.imap.host) !== null,
        refused === "auth" ? googleAuthHint(within.err, rt.imap.host) : null,
      );
    };
    scope.depsForHost = depsForHost;
    scope.consentableRefusal = consentableRefusal;
    scope.trustableRefusal = trustableRefusal;
    scope.pairSharesHost = pairSharesHost;
    scope.keepingIncoming = keepingIncoming;
    scope.answerPressLaunch = answerPressLaunch;
}
