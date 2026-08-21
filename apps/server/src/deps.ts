import { users, providerFamily, type Tx } from "@trafficflow/db";
import {
  acquireImapSlot, releaseImapSlot, webhookAlertSink,
  resolveOAuthProviderConfig, rotateMailboxOAuthSecret, MICROSOFT_PROVIDER,
  makeSupabaseStagingStorage, makeS3StagingStorage,
  type AlertSink, type AttachmentStagingStorage,
} from "@trafficflow/db/cloud";
import {
  makeAnthropicClient, makeHaikuClassifier, makeSonnetDrafter,
  MicrosoftTokenProvider,
  type FetchLike, type Logger, type UpdateSecretPort,
} from "@trafficflow/core";
import { mailboxProviderAuthservIds } from "@trafficflow/core/adapters/drizzle-repo";
import { makePushEndpointGuard } from "@trafficflow/core/net";
import {
  makeAuthService, makeMailboxService, makeScreenerService, makeApprovalService,
  makePrivacyService, makeUnsubscribeService, nodeOneClickPost,
  nodeRemoteFetch, nodeHostResolver, scryptHasher,
  syncService, makePushService, rulesService, messageService, threadService, triageService,
  searchService, contactsService, snippetsService, notifyRulesService, awayResponderService,
  attachmentsService, kbService, tagsService, draftsService, draftingService, sendService,
  workflowsService, proposalsService, redeemInviteGrant,
  makeAttachmentStagingPort, MailService, SmtpMailer,
} from "@trafficflow/services";
// The policy TYPE lives on the mail entry (the sidecar imports it there too); the full barrel
// above is still loaded by this app — which is exactly why the explicit allowance below exists.
import type { MailboxAllowancePolicy } from "@trafficflow/services/mail";
import type { PairingTokenMinted } from "@trafficflow/services";
import { makeProbeHostGuard, ALLOW_ANY_PROBE_HOST } from "@trafficflow/api";
import type { ApiDeps, ApiServices, ChangeWakeHub } from "@trafficflow/api";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@trafficflow/db/cloud";
import {
  allowCookieAuthForRequest, SELF_HOST_SEND_MAX_TOTAL_BYTES,
  type ServerConfig, type StorageConfig,
} from "./config.js";
import { ensureSetupTokenInvariant } from "./setup-token.js";

/**
 * The per-request {@link ApiDeps} for the standalone self-host server.
 *
 * ONE process, ONE lifetime for almost everything: the service bag, the owned pool, the wake hub
 * and the logger are built once at boot (`index.ts`) and threaded here as {@link ServerRuntime};
 * per request only `session`, `requestId`, `idempotency` and the host's cookie decision vary.
 * This is `apps/api-vercel/src/deps.ts` re-stated for a host with no cold starts — deliberately a
 * SECOND composition root rather than an extraction of the first: two shapes controlled by CI
 * (the bag-parity suite compares the service bags key for key) beat one shared shape whose
 * every self-host edit would churn the managed deployment.
 */

/**
 * **THE UNMETERED MAILBOX ALLOWANCE, stated where the OBLIGATION is lodged.**
 *
 * `routes/self-host.ts` obligation 1: this app loads the full `@trafficflow/services` barrel
 * (auth and erasure need it), and LOADING THAT BARREL registers the hosted PAID gate as the
 * process-wide default allowance. This explicit `allowance:` argument to `makeMailboxService`
 * below is therefore the only thing between a self-host boot and `POST /mailboxes` refusing
 * every mailbox with a subscription error on a server that has no subscriptions — a defect
 * class this product has shipped once already, one composition over. The boot-ceremony pg test
 * adds TWO mailboxes with zero billing env and shows the reverted-to-default composition red.
 *
 * It lives HERE, in the app, following the sidecar's design without importing it
 * (`UNMETERED_MAILBOX_ALLOWANCE`, apps/sidecar/src/engine.ts): the hosted API must have no name
 * for a permissive policy, so none is exported from `@trafficflow/services` and none is imported
 * across apps. What still gates a mailbox is everything that is not about money: the
 * active-address unique index, the IMAP probe, the admission counter, and the organizer lease.
 */
export const SELF_HOST_MAILBOX_ALLOWANCE: MailboxAllowancePolicy = async () => {
  /* No plan, no count, no lock. The operator pays for their own box; the limit is their disk. */
};

type Db = PostgresJsDatabase<typeof schema>;

/**
 * THE ENV-KIND FACTORY over the two staging-storage implementations (Ruling 3): `supabase`
 * selects the managed host's client verbatim, `s3` the SigV4 client MinIO and AWS both speak.
 * The switch is EXHAUSTIVE over {@link StorageConfig} — an unknown kind cannot reach here at all,
 * because `loadStorageConfig` already refused it at boot (config.test.ts pins that refusal), and
 * a kind added to the union without an arm here is a compile error, not a runtime surprise.
 *
 * `fetchImpl` is the same injection seam both implementations already expose, threaded through
 * so the factory test can PROVE which arm it armed by watching the wire instead of trusting a
 * label. Production passes nothing.
 */
export function stagingStorageFor(
  storage: StorageConfig, fetchImpl: typeof fetch = fetch,
): AttachmentStagingStorage {
  switch (storage.kind) {
    case "supabase":
      return makeSupabaseStagingStorage(
        { url: storage.url, serviceKey: storage.serviceKey, bucket: storage.bucket }, fetchImpl,
      );
    case "s3":
      return makeS3StagingStorage({
        endpoint: storage.endpoint,
        region: storage.region,
        accessKeyId: storage.accessKeyId,
        secretAccessKey: storage.secretAccessKey,
        bucket: storage.bucket,
        // The browser-facing half of the split (S3_PUBLIC_ENDPOINT, default OHMAIL_ORIGIN):
        // upload grants alone are addressed — and therefore SigV4-signed — against it.
        publicEndpoint: storage.publicEndpoint,
      }, fetchImpl);
  }
}

/** `"ohmail <no-reply@x>"` → `no-reply@x` — the bare address inside an RFC5322 display form. */
const bareAddress = (from: string): string => {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
  return (m ? m[1]! : from).trim();
};

/**
 * The `MailService` customer mail goes through on this host, or `null` when the operator set no
 * SMTP block — the managed composition's `customerMailerFor`, restated over `SmtpMailer`.
 *
 * `null` is a WORKING configuration, not a degraded one: the pairing invite path never needs
 * mail (verification rides the consumed token's own `confers_verified` record), and the only
 * surface that hard-requires a mailer — open public signup — does not exist on this composition
 * at all, so the 503-on-the-open-gate degradation inside `AuthService.register` is compiled-in
 * caution rather than a reachable state. What a mailer ADDS is the ordinary verification flow
 * for addresses that arrive unverified, `resendVerification`, and the new-device sign-in notice.
 *
 * Unlike the managed host's version this one THROWS on an unusable block, deliberately: there,
 * construction runs on the path of every request and a bad value must cost mail rather than
 * availability; here it runs once at boot, and config.ts's contract is that a misshapen value
 * refuses the start with the variable named. Every message on that path is a fixed sentence —
 * `SmtpMailer`'s own refusals name no value, because `SMTP_URL` embeds a credential.
 *
 * The link bases are all {@link ServerConfig.origin}: one origin is the whole point of this
 * composition, and it was validated at boot, so `MailService`'s own base assertion cannot add a
 * second refusal. `supportEmail` — the address templates tell people to write to — is the
 * operator's `MAIL_REPLY_TO` when set (a mailbox a human reads), else the bare `MAIL_FROM`.
 */
export function customerMailerFor(cfg: ServerConfig): MailService | null {
  if (!cfg.smtp) return null;
  try {
    return new MailService({
      mailer: new SmtpMailer({
        url: cfg.smtp.url,
        from: cfg.smtp.from,
        replyTo: cfg.smtp.replyTo ?? undefined,
      }),
      config: {
        appUrl: cfg.origin,
        siteUrl: cfg.origin,
        supportEmail: cfg.smtp.replyTo ?? bareAddress(cfg.smtp.from),
        // The operator origin must be NAMED as a permitted link base — the default list is the
        // managed product's own origins, and "mail links wherever an env var points" must stay
        // a property nobody acquires by accident (mail-service.ts states the rule).
        allowedOrigins: [cfg.origin],
        // No `operatorEmail`: this instance exists to reach the box's users, and without the
        // address `sendOperatorAlert` skips — the alert path stays webhook-only for now (see
        // alertSinksFor).
      },
    });
  } catch (err) {
    // Boot refusal, config.ts's grammar: the variable, the rule, never the value. The inner
    // message is one of our own fixed sentences (SmtpMailer/assertUsableFrom echo nothing).
    throw new Error(
      `SMTP is configured but not usable — check SMTP_URL and MAIL_FROM: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Everything with process lifetime, built once by `index.ts` and handed to every request. */
export interface ServerRuntime {
  cfg: ServerConfig;
  db: Db;
  services: ApiServices;
  changeWake: ChangeWakeHub | null;
  /** One long-lived token provider — see {@link oauthProviderFor}. */
  oauth: MicrosoftTokenProvider;
  /** Where a setup token minted OUTSIDE boot gets printed — see {@link needsSetupFor}. */
  onSetupTokenMinted: (minted: PairingTokenMinted) => void;
  logger: Logger;
}

/**
 * The service bag — built ONCE at boot (no cold starts, so no lazy getters: paying the scrypt
 * decoy warm-up before `listen()` is strictly better than paying it on the first sign-in, and
 * `makeAuthService`'s decoy hash stays computed once per process exactly as the timing-oracle
 * note in the managed composition requires).
 *
 * WHAT IS ABSENT, against the managed bag, each on purpose (the bag-parity test freezes this
 * list): `billingPlane`/`entitlements` (nothing to buy), `waitlist` (no funnel), and `aiCredits`
 * (the operator supplies the model key and pays the model bill themselves — absent gate means
 * UNMETERED, the sidecar's grammar, never ungated-by-accident: the barrel default this bag
 * overrides is the mailbox allowance, and the credit gate is simply never constructed).
 * `attachmentStaging` is conditional, not absent: armed from `cfg.storage` through the env-kind
 * factory when the operator configured object storage, and absent otherwise (absence ⇒ the mint
 * route answers 503 and sends carry inline bytes — load-bearing, `deps.ts` in packages/api
 * states the semantics).
 */
export function buildServerServices(cfg: ServerConfig, db: Db): ApiServices {
  const { authConfig, keyProvider } = cfg;
  // Built ONCE for the process — the storage client is stateless config + a signing key, and one
  // instance serving every request is the long-running host's shape (the managed bag constructs
  // per cold instance for the same reason).
  const stagingStorage = cfg.storage ? stagingStorageFor(cfg.storage) : null;
  const bag: Record<string, unknown> = {
    sync: syncService,
    // UnifiedPush wake registrations, with THIS install's endpoint policy. Strict by default; the
    // operator's explicit TF_PUSH_ALLOW_PRIVATE=1 relaxes it for a distributor on their own LAN.
    // A SEPARATE variable from `TF_PROBE_ALLOW_PRIVATE` on purpose — see config.ts for why one
    // value must not decide both. The organizer reads the same variable, so the two processes
    // cannot disagree about whether a registered endpoint is dialable.
    push: makePushService({
      endpointGuard: makePushEndpointGuard(nodeHostResolver, { allowPrivate: cfg.pushAllowPrivate }),
    }),
    // This deployment is in the admission cap's exact position: several users, one connection
    // budget per upstream account, TWO processes (this one and the organizer) that share no
    // lock. The counter's table exists here — this host runs both journals.
    imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot },
    // ENFORCING by default; the operator's explicit TF_PROBE_ALLOW_PRIVATE=1 selects the
    // desktop's allow-any for a LAN mail server. See config.ts for the argument.
    probeHostGuard: cfg.probeAllowPrivate
      ? ALLOW_ANY_PROBE_HOST
      : makeProbeHostGuard(nodeHostResolver),
    // The adapter's own body cap expressed in raw attachment bytes — config.ts derives the pair.
    sendSurfaceMaxTotalBytes: SELF_HOST_SEND_MAX_TOTAL_BYTES,
    // ── AND THIS IS THE WAY ROUND THAT CAP, when the operator armed object storage ──────────
    // The browser mints a grant, PUTs the bytes straight into the bucket (MinIO on the compose;
    // any S3 endpoint or a Supabase project via TF_STORAGE_KIND), and the send carries a
    // reference — the managed transport verbatim, behind the same factory-over-the-request-db
    // shape. ABSENT when no storage is configured, and the absence is load-bearing: the mint
    // route answers 503, `/hello` reports `staging: false` (it reads THIS member), and inline
    // sends keep working under the body cap above.
    ...(stagingStorage
      ? {
        attachmentStaging: (reqDb: Tx) => makeAttachmentStagingPort({
          db: reqDb,
          storage: stagingStorage,
        }),
      }
      : {}),
    rules: rulesService,
    message: messageService,
    thread: threadService,
    triage: triageService,
    search: searchService,
    contacts: contactsService,
    snippets: snippetsService,
    notify: notifyRulesService,
    away: awayResponderService,
    attachments: attachmentsService,
    kb: kbService,
    tags: tagsService,
    drafts: draftsService,
    drafting: draftingService,
    sends: sendService,
    workflows: workflowsService,
    proposals: proposalsService,
    // Register/verify/factors/OAuth ceremony. `mail` is the SmtpMailer behind MailService when
    // the operator set the SMTP block, and `null` otherwise — a WORKING state, not a gap: the
    // pairing invite path never needs mail (routes/self-host.ts obligation 3 — verification
    // rides the consumed token's own record), and open signup does not exist here. See
    // customerMailerFor for what a mailer adds and why its failure refuses the boot.
    auth: makeAuthService({
      config: authConfig, keyProvider, passwordHasher: scryptHasher, mail: customerMailerFor(cfg),
    }),
    // The `/pair/redeem` invite arm's bridge to the Cloud-half `invites` table — present HERE
    // because this composition's database holds that table (obligation 3, routes/self-host.ts);
    // absent on any deployment that lacks it, where the route answers `validation_failed`.
    inviteRedeem: redeemInviteGrant,
    // Envelope-encrypts mailbox credentials with the SAME provider the organizer decrypts with —
    // the KEK identity on the two /health responses is what proves they agree. The explicit
    // allowance is obligation 1; see SELF_HOST_MAILBOX_ALLOWANCE above.
    mailbox: makeMailboxService({ keyProvider, allowance: SELF_HOST_MAILBOX_ALLOWANCE }),
    // NO adapter injected: a screener/approval decision leaves folder_state pending and the
    // ORGANIZER (apps/worker, running beside this process) applies the IMAP move — one organizer
    // per mailbox is the rule, and this server never opens IMAP to apply organization.
    approval: makeApprovalService({}),
    // The image proxy's outbound fetch — real network by design (that is what strips a tracking
    // pixel's access to the reader's IP), SSRF-gated by the required resolver.
    privacy: makePrivacyService({ remote: nodeRemoteFetch, resolver: nodeHostResolver }),
    // RFC 8058 one-click unsubscribe, per-mailbox authserv trust — the managed wiring verbatim.
    unsubscribe: makeUnsubscribeService({
      post: nodeOneClickPost,
      resolver: nodeHostResolver,
      trustedAuthservIdsFor: mailboxProviderAuthservIds,
    }),
  };

  // The screener: classifier only when the operator supplied a model key; NO credit gate and no
  // `remaining` reader — this tier is unmetered by design (the operator's key, the operator's
  // model bill), which is the sidecar's grammar exactly. A screen-out arms auto-unsubscribe
  // through the same instance the bag holds, so the two paths cannot diverge in configuration.
  bag.screener = makeScreenerService({
    ...(cfg.anthropicApiKey
      ? {
        classifier: makeHaikuClassifier({
          client: makeAnthropicClient({
            apiKey: cfg.anthropicApiKey,
            timeoutMs: 10_000,
            maxRetries: 1,
            onUsage: (r) => { console.log(JSON.stringify({ event: "ai_call", ...r })); },
          }),
        }),
      }
      : {}),
    unsubscribe: bag.unsubscribe as ReturnType<typeof makeUnsubscribeService>,
  });

  // THE LIVE DRAFTER, armed by the same key the descriptor reads. Absent, the draft route
  // answers 503 drafter_unconfigured — the state an unkeyed install is honestly in.
  if (cfg.anthropicApiKey) {
    bag.drafter = makeSonnetDrafter(makeAnthropicClient({
      apiKey: cfg.anthropicApiKey,
      timeoutMs: 25_000,
      maxRetries: 1,
      onUsage: (r) => { console.log(JSON.stringify({ event: "ai_call", ...r })); },
    }));
  }

  return bag as unknown as ApiServices;
}

/**
 * The alert sinks this host can reach: the JSON webhook, when the operator configured one. The
 * MAIL sink is still deliberately absent even now that `SmtpMailer` exists, because it needs the
 * one thing this host's config does not yet name: an OPERATOR ADDRESS (`MailService` refuses to
 * take a recipient as an argument — the anti-mail-bomb rule — and `operatorEmail` is unset on
 * the customer instance on purpose). Wiring it is an env-vocabulary decision, not an adapter
 * gap; named follow-up. Cannot throw — an observability feature must never cause the outage it
 * exists to report.
 */
export function alertSinksFor(cfg: ServerConfig, logger: Logger): AlertSink[] {
  const sinks: AlertSink[] = [];
  if (cfg.alerts?.webhookUrl) {
    try {
      const hook = webhookAlertSink(cfg.alerts.webhookUrl);
      if (hook) sinks.push(hook);
    } catch (err) {
      logger.error("alert_sink_unavailable", {
        err, reason: "the webhook alert sink could not be constructed; the pass will report undeliverable",
      });
    }
  }
  return sinks;
}

/**
 * The Microsoft OAuth2 token source — ONE long-lived provider for the process, the WORKER's
 * lifetime rather than the serverless per-invocation one: this host has no cold starts, the
 * provider's token cache is keyed by mailbox with expiry handled inside it, and `resolveClient`
 * re-reads the config store on every refresh so a rotated client secret takes effect without a
 * restart. The rotation write targets the mailbox's own credential row and is the only write
 * this port makes.
 */
export function oauthProviderFor(cfg: ServerConfig, db: Db): MicrosoftTokenProvider {
  const updateSecret: UpdateSecretPort = (mailboxId, ciphertextEnc, keyVersion) =>
    rotateMailboxOAuthSecret(db, {
      mailboxId, ciphertext: ciphertextEnc, keyVersion, now: new Date(),
    });
  return new MicrosoftTokenProvider({
    clientId: cfg.msOAuth?.clientId ?? "",
    clientSecret: cfg.msOAuth?.clientSecret ?? "",
    defaultTenant: cfg.msOAuth?.tenant || "common",
    resolveClient: async () => {
      const resolved = await resolveOAuthProviderConfig({
        tx: db,
        decrypt: (ct, kv) => cfg.keyProvider.decrypt(ct, kv),
        bootstrap: cfg.msOAuth,
        provider: MICROSOFT_PROVIDER,
      });
      return {
        clientId: resolved.clientId,
        clientSecret: resolved.clientSecret,
        defaultTenant: resolved.tenant || cfg.msOAuth?.tenant || "common",
      };
    },
    keyProvider: cfg.keyProvider,
    updateSecret,
    fetch: globalThis.fetch as unknown as FetchLike,
  });
}

/**
 * `needsSetup` as the DATABASE FACT it is: does any user exist yet. A capability rather than a
 * boot-time boolean because the answer flips the moment the first account registers, and
 * `/hello` must tell the truth per request. It may throw — the route answers 503 rather than
 * guessing in either direction (hello.ts states why both guesses are wrong).
 *
 * It first ENFORCES the setup-token invariant (`ensureSetupTokenInvariant`): `needsSetup: true`
 * must never be advertised while the token that ceremony needs exists nowhere (the last account
 * erased itself; the boot token expired unredeemed), and a live ownerless token must never
 * survive on a server that has users (the restart-races-first-registration residue). A token
 * this path mints is printed through {@link ServerRuntime.onSetupTokenMinted} — stdout, where
 * the boot already told the operator to look.
 */
export function needsSetupFor(
  db: Db,
  onMinted: (minted: PairingTokenMinted) => void,
): () => Promise<boolean> {
  return async () => {
    await ensureSetupTokenInvariant(db, { onMinted });
    const row = await db.select({ id: users.id }).from(users).limit(1);
    return row.length === 0;
  };
}

/** Build the per-request container. `req` is the ALREADY-NORMALIZED request (see `handler.ts`). */
export function buildDeps(req: Request, rt: ServerRuntime): ApiDeps {
  const { cfg } = rt;
  return {
    db: rt.db,
    now: () => new Date(),
    requestId: "",                 // `withRequestId` assigns one
    session: null,                 // `withSession` resolves it
    authConfig: cfg.authConfig,
    keyProvider: cfg.keyProvider,
    services: rt.services,
    sse: cfg.sse,
    // ONE LISTEN for the process, fanned out per account — the extracted change-wake hub over
    // the same plain DATABASE_URL everything else dials (session-capable by nature here).
    changeWake: rt.changeWake,
    allowCookieAuth: allowCookieAuthForRequest(req, cfg.cookieHosts),
    /**
     * **OBLIGATION 4 (`routes/self-host.ts`): stated `false`, EXPLICITLY.** Accounts on this
     * server legitimately arrive unverified — a family invite is a pairing token, its redeemer
     * types their own address, nothing is mailed — and the box may have NO mailer to verify
     * with. The default is REQUIRE on purpose (an absent value must never relax a gate), so a
     * composition root that stays silent here bricks every pairing-invited account at their
     * first mailbox add: a working gate presenting as a broken server. `false` is honest for
     * the same reason requiring is honest on the hosted service — the mailbox add presents an
     * IMAP credential, which proves more about mailbox ownership than a verification mail ever
     * did, and the operator pays for their own box.
     */
    requireVerifiedForProduct: false,
    health: {
      version: cfg.version,
      // BOTH journals — this server has real sign-in, so it has the identity tables, and a
      // health probe that certified the mail half alone would bless a half-migrated database.
      schemaTier: "all",
      kek: cfg.kek,
      kekError: cfg.kekError,
      buildError: null,
      // "unrecognized" on an operator's own Postgres is healthy and documented as such — the
      // field exists so the connection guards' blind spots are visible, not as a fault.
      dbProvider: providerFamily(cfg.databaseUrl),
    },
    /**
     * What `GET /push/vapid-key` answers. The PUBLIC half only — see config.ts: this process never
     * reads `TF_VAPID_PRIVATE_KEY`, because nothing a request handler does needs the ability to
     * sign a wake. `null` when the operator generated no keypair, which the app renders as a
     * sentence rather than an error.
     */
    vapidPublicKey: cfg.vapidPublicKey,
    // What `GET /hello` answers — this host's capability statement. Every flag reads the SAME
    // member the wiring arms from, so the negotiation cannot disagree with what the routes do.
    hello: {
      flavor: "selfhost",
      needsSetup: needsSetupFor(rt.db, rt.onSetupTokenMinted),
      auth: {
        password: true,
        totp: true,
        webauthn: true,
        // NEVER on this composition — there is no TF_PUBLIC_SIGNUP here and must not be: the
        // first account is the boot-minted setup token, every later one a pairing invite.
        publicSignup: false,
      },
      features: {
        // Free on a long-running server; config.ts pins it enabled with no flag to forget.
        sse: cfg.sse.enabled === true,
        // Reads the BAG, not the parsed config: the descriptor must announce what the routes DO
        // (the mint route answers 503 while the port is absent), not what the environment hopes.
        // `cfg.storage` arms the bag member through the env-kind factory; this reads the member.
        staging: rt.services.attachmentStaging !== undefined,
        ai: cfg.anthropicApiKey !== null,
        // OBLIGATION 2: the pairing routes are mounted on this table and this table only, so
        // this descriptor is the one that says true.
        pairing: true,
      },
    },
    logger: rt.logger,
    // Armed by TF_ALERT_SECRET (≥ 24 chars); absent ⇒ both /internal/alerts routes answer 404,
    // which is the correct surface for a box nobody armed a pager on.
    alerts: cfg.alerts
      ? {
        secret: cfg.alerts.secret,
        sinks: alertSinksFor(cfg, rt.logger),
        environment: cfg.environment,
      }
      : undefined,
    // NO admin, NO adminDb: selfHostRoutes carries no admin group at all — account isolation on
    // this server is absolute, and the operator's observability is /health + /internal/alerts.
    msOAuth: cfg.msOAuth,
    appOrigin: cfg.origin,
    oauth: rt.oauth,
  };
}
