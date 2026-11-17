import type { OpenSendAdapter, SendAdapter } from "@trafficflow/core/mail";
import type { ImapAdapter, ImapConfig } from "@trafficflow/core/adapters/imap";
import { mailboxProviderAuthservIds } from "@trafficflow/core/adapters/drizzle-repo";
import { providerAuthservIds } from "@trafficflow/core/mail";
import {
  makeUnsubscribeService, nodeHostResolver, nodeOneClickPost, nodeRemoteFetch, ServiceError,
} from "@trafficflow/services/mail";
import {
  API_VERSION, DEFAULT_SSE, makeSendAdapter, type ProbeDialer, type SmtpProbeOptions, type ApiDeps,
} from "@trafficflow/api/local";
import { runsPass } from "./composition-passes.js";
/* A mail server on this computer read for its own certificate; the phone's artifact takes `phone/host-pin-probe.ts`. */
import { readLoopbackMailCertificate } from "./host-pin-probe.js";
import { dialectOf } from "@trafficflow/db/dialect";
import type { SidecarConfig } from "./engine-types.js";
import { localServices } from "./engine-local-services.js";
import { ONE_SHOT_DIAL, SIDECAR_NET_TIMEOUTS } from "./engine-reconnect.js";
import { BAKED_ENGINE_VERSION } from "./engine-classifiers.js";
import type { EngineScope } from "./engine-scope.js";

/**
 * The desktop's engine, one section: what a request is answered with: the unsubscribe service, the probes' options,
 * the send door and the per-request container.
 */
export function requestDepsSection(scope: EngineScope, config: SidecarConfig): void {
    /**
     * One-click unsubscribe — the same service, the same gates, as the hosted API. Constructed once and handed to
     * every per-request bag for the MANUAL verb alone (`POST /messages/:id/unsubscribe`); the screener's automatic
     * pass deliberately does not receive it (see `localServices`'s `screener:` entry). Three deps: `post` — {@link
     * nodeOneClickPost}, the pinned redirect-refusing client (the second of the process's two non-mailbox egresses);
     * `resolver` — the REAL `node:dns`, as the image proxy above now also uses: the SSRF gate protects the user's own home network
     * from a `List-Unsubscribe` header naming a private address, and this URL is only POSTed after a screen-out the
     * user performed; `trustedAuthservIdsFor` — the provider of the mailbox that HOLDS the letter, never the first
     * mailbox's: the host its runtime dials, which is the one ingest checked it against (a seed with no stored
     * password has no credential row to ask), else its credential row, read through the handle the service passes
     * and never the outer one, for `retroDue`'s one-connection reason. `runtimes` is called at request time only.
     */
    const unsubscribe = makeUnsubscribeService({
      post: config.oneClickPost ?? nodeOneClickPost,
      resolver: nodeHostResolver,
      trustedAuthservIdsFor: async (tx, mailboxId) => {
        const rt = scope.runtimes.get(mailboxId);
        return rt ? providerAuthservIds(rt.imap.host) : mailboxProviderAuthservIds(tx, mailboxId);
      },
    });

    /**
     * A FRESH `ApiDeps` PER REQUEST. `ApiDeps` is mutable by design — `withRequestId` writes
     * `requestId`, `withSession` writes `session`, `withIdempotency` writes `idempotency` — so a
     * shared object would leak one request's identity into the next. It is the same shape the
     * client engine's contract tests build when they drive `app.handle` directly.
     */
    /**
     * The send transport — the shared `makeSendAdapter`, resolved per mailbox from that mailbox's own credential
     * rows. A hand-written `openLocalSend` assumed the SMTP server is an environment fact, true only for one mailbox:
     * with several, a reply composed in mailbox two went out through mailbox ONE's submission server authenticated
     * with mailbox two's password — silent, the copy in Sent, the only trace in the receiving server's headers. So
     * the transport comes from the rows: the `smtp` row when it exists, the mailbox's own `imap` host on 587 when
     * not. Engine-scoped: `OpenSendAdapter` takes the mailbox id. The outgoing `foreign-host` sentences go with the
     * old path; the incoming `credentialIsForeign` gate is untouched. The factory seam lets a test observe WHICH
     * server a send dialled — the only way to tell a correct send from the defect.
     */
    /**
     * The probe seam, threaded from the same place the sync adapter takes one. A probe IS a dial
     * — it opens a login against the server a person just typed — so an install configured to
     * dial through a double must dial the probe through it too; without this the local door
     * would be the one path in this process that reaches a real socket regardless. Production is
     * unaffected: `config.adapterFactory` is absent there and both probe factories fall through
     * to a real `ImapAdapter`.
     */
    /* A server on this computer may be trusted by its own certificate (a gateway such as Proton
       Mail Bridge) on the desktop's local door alone: never the phone, never a hosted door. */
    const loopbackTrust = scope.organizerKind === "local" ? { loopbackCertificate: readLoopbackMailCertificate } : {};
    const probeOpts = {
      /* A server on this computer gets the sync dial's own wait (`ImapProbeOptions.localServerDial`):
         ONE key outside the seam's ternary, so the tested branch and production cannot differ. */
      localServerDial: SIDECAR_NET_TIMEOUTS,
      ...loopbackTrust,
      ...(config.adapterFactory
        ? { adapterFactory: (cfg: ImapConfig) => config.adapterFactory!(cfg, ONE_SHOT_DIAL) as unknown as ProbeDialer }
        : {}),
    };
    /**
     * …and the submission leg, on the same condition and for the same reason. A mailbox has two
     * servers and adding one probes both; intercepting the incoming dial while the outgoing one
     * opens a real socket would make `adapterFactory` a half-seam. The double resolves an EMPTY
     * proof rather than a fabricated one — `undefined` is the documented "nothing was learned"
     * answer, and inventing an announced size would put a measurement into the store that no
     * server made. Production is unaffected: with no factory this is `{}` and the probe dials
     * for real.
     */
    const smtpProbeOpts: SmtpProbeOptions = {
      ...loopbackTrust,
      ...(config.smtpDial
      /* THE SUBMISSION DIAL, INJECTED — the same argument `adapterFactory` carries, and it exists
         because the default double CANNOT REFUSE. `{ dial: async () => undefined }` resolves an
         empty proof for every host, which is the right stand-in for a composition that must not
         open sockets and useless for the one behaviour that matters here: what this door does when
         a submission server says no. A test that cannot produce a refusal cannot hold the line
         that an incoming credential survives one. Production passes neither and dials for real. */
        ? { dial: config.smtpDial }
        : config.adapterFactory
          ? { dial: async (): Promise<void> => undefined }
          : {}),
    };
    const openLocalSend: OpenSendAdapter = async (mailboxId: string): Promise<SendAdapter> => {
      /* The boot contract reaches the send path, and it has to. The incoming comparison gates
       * the launch: a credential proved against one server is not offered to another. A send
       * is a dial like any other, on its own fresh connection built straight from the
       * credential rows — without this it would go on offering the password while the launch
       * that owns the mailbox was refusing to. It used to hold by construction (the deleted
       * local sender resolved through the same `resolveLogin`); the shared adapter reads the
       * rows directly, so the check is made here, at the seam that knows both. Only the
       * incoming arm (no process-wide submission host remains), and only for a mailbox this
       * install is actually running — a row with no runtime has no configuration to be
       * measured against. */
      const rt = scope.runtimes.get(mailboxId);
      if (rt && (await rt.credentialState()) === "foreign-host") {
        throw new ServiceError(
          "upstream_unavailable", 502,
          "the stored mailbox password was proved against a different incoming (IMAP) server " +
            "than this install is now configured for, so it was not offered and nothing was " +
            "sent. Finishing or undoing the change of server resolves it.",
        );
      }
      return config.adapterFactory
        /* The sync dial's deadlines: an upload on a slow link outlasts the serverless 25 s, and the
           phone's socket timer only moves when a write completes. Passed positionally so the
           factory lands in the fourth slot. `proveKept`: nothing reaches SMTP over a kept
           connection whose server has stopped answering; a quit then hands the press to the
           next start, which sends it with its Sent copy. */
        ? makeSendAdapter(depsFor(), mailboxId, { timeouts: SIDECAR_NET_TIMEOUTS, proveKept: true },
            (cfg: ImapConfig) => config.adapterFactory!(cfg, ONE_SHOT_DIAL) as unknown as ImapAdapter)
        : makeSendAdapter(depsFor(), mailboxId, { timeouts: SIDECAR_NET_TIMEOUTS, proveKept: true });
    };

    const depsFor = (): ApiDeps => ({
      db: scope.db,
      now: scope.now,
      requestId: "",
      /* WHICH RUN OF THIS STORE the cursors this door hands out belong to. Spread, because a
         store that cannot lose a committed row states nothing and the field must then be absent
         rather than a number. `depsForHost` spreads this container, so the paired phone's door
         states the same run as the window's. */
      ...(scope.opened.storeGeneration === null ? {} : { storeGeneration: scope.opened.storeGeneration }),
      /**
       * A route fault on this door has a sink — the same omission as `SidecarConfig.logger`'s.
       * `withErrorEnvelope` writes the one line describing an unhandled route fault (`request_unhandled`)
       * through `deps.logger`, falling back to `silentLogger`; this container injected none, so a 500 on the
       * standalone door was answered `internal` and recorded nowhere — on the one door where the log is the
       * only witness. `withRequestId` runs above the envelope and binds `requestId` onto whatever sits here,
       * so the line a user can quote an id for is the same line this field makes reachable. `depsForHost`
       * spreads this container, so the host door inherits the sink. Spread rather than assigned so a
       * no-logger install keeps the field ABSENT (`exactOptionalPropertyTypes`).
       */
      ...(config.logger === undefined ? {} : { logger: config.logger }),
      // The organize walks a route runs (the decision count, the Screener's offer) hand the loop back.
      ...(scope.walkTurn === undefined ? {} : { loopTurn: scope.walkTurn }),
      session: null,
      authConfig: scope.authConfig,
      keyProvider: scope.keyProvider,
      // Rebuilt per request so the AI slots reflect what this install can do NOW — see
      // `localServices`. `openLocalSend` (below) is the send transport, resolving the sealed
      // credential fresh per send.
      services: localServices(
        scope.authConfig, scope.keyProvider, scope.world.accountId, openLocalSend, scope.holdOffer, unsubscribe,
        config.imageFetch ?? nodeRemoteFetch, scope.organizerKind, scope.signatureCheck !== null, scope.ai,
      ),
      // BEARER ONLY. There is no browser here, so there is no ambient cookie to abuse — and with
      // `via` structurally unable to be "cookie", `withCsrf` becomes a no-op by construction
      // rather than by a check. Same posture as the managed API base.
      allowCookieAuth: false,
      // SSE OFF, and this one is load-bearing for the transport rather than a preference: a frame
      // carries a COMPLETE response, and `GET /events` never completes. Disabled, it answers a
      // finite 503 that `HttpAdapter` already tolerates (it treats SSE as an optional wake signal
      // and polls `/sync` regardless). See the note in `protocol.ts`.
      sse: { ...DEFAULT_SSE, enabled: false },
      /**
       * `/health` publishes the key's identity, in the hosted service's own shape: `{ active,
       * count, fingerprint }` — a digest and two integers, never key material. It makes a
       * rotation observable from outside the process: after the shell installs a new version,
       * `active` moves and `fingerprint` changes. `kekError` is deliberately never set: on the
       * hosted side it makes `/health` answer 503, right for a server that cannot decrypt
       * anybody's credentials; here the same condition means "this user has not typed their
       * password yet", and an app reporting itself dead while happily serving the mirror would
       * be lying.
       */
      // `schemaTier: "mail"` because this install migrated the mail journal and nothing else
      // (`db.ts`). Without it `/health` probes for the hosted billing ledger and answers 503
      // `schema_incomplete` for ever — about a database that is complete for what it is.
      health: {
        version: API_VERSION, kek: scope.kekIdentity, schemaTier: "mail",
        /* The shell's baked commit, forwarded verbatim — see `SidecarConfig.buildCommit`. */
        ...(config.buildCommit?.trim() ? { buildCommit: config.buildCommit.trim() } : {}),
        /**
         * Which store this install actually opened, named rather than left null. Null was
         * harmless with one possible answer and stops being harmless with two: `/health` on a
         * phone reports no schema census (no Postgres catalogs), so the provider is the only
         * thing in the body that says why — and a null reads as "this host does not know". Read
         * from the handle's own brand, so it cannot disagree with the store that answered the
         * request. Generic rather than a package name: the device store is expo-sqlite on a
         * phone and `node:sqlite` in the harness, and naming one would be false in the other
         * place while looking more precise.
         */
        dbProvider: dialectOf(scope.db) === "sqlite" ? "sqlite" : "pglite",
      },
      /**
       * What `GET /hello` answers — this install's capability statement, on `health`'s injection
       * pattern. `flavor: "local"` is what a client's server picker reads to learn it is talking
       * to a desktop engine. The auth block is all-false and that is the truth: this process
       * mints one session per launch for the shell that spawned it, so there is no sign-in
       * ceremony to offer — the machine's own login is the boundary, and `needsSetup` is `false`
       * for the same reason. `ai` is per-request honest because this container is rebuilt per
       * request: whether THIS install has a verified model right now, the same fact that decides
       * whether `services.drafter` exists.
       */
      hello: {
        flavor: "local",
        // The release this engine is a build of: the version the bundler baked in, else `0.0.0`.
        apiVersion: BAKED_ENGINE_VERSION ?? API_VERSION,
        needsSetup: false,
        auth: { password: false, totp: false, webauthn: false, publicSignup: false },
        features: {
          // SSE is off in this host — see `sse` above; `GET /events` answers a finite 503.
          sse: false,
          // No staging: the send runs in the same process as the SMTP dial (see local.ts).
          staging: false,
          ai: scope.ai.drafter() !== undefined,
          // The host-mode arm, truthfully. Armed, this door carries the window-only mint
          // (`host-pair-routes.ts` — the window hands a phone a credential; no invite arm and
          // nobody to register), so the descriptor says so and the window can offer the
          // ceremony. Disarmed — the default — nothing is mounted and this stays `false`:
          // `localRoutes` itself never carries `/pair*` (the census in the API package's
          // `hello.test.ts` pins that), the mount is this composition's own, and both readings
          // are pinned — disarmed in the sidecar's hello suite, armed in its host-mode suite —
          // so neither composition can lie about the ceremony.
          pairing: scope.hostMode,
          /* This door's image proxy FETCHES: the composition wires `nodeRemoteFetch` and the
             real resolver (see `localServices`'s `privacy:` entry), so a reading pane may offer
             pictures here and Settings may draw the switch. It was `false` in effect for as long
             as the egress was a refusal, and the route being mounted never said otherwise. */
          remoteImages: true,
          // Files wait in this store for the pass that keeps the appointment; a phone keeps none.
          scheduleFiles: runsPass(scope.organizerKind, "scheduled-send"),
        },
      },
    });
    /**
     * The host door's auth config — the served MagicDNS origin, threaded into the request
     * guard's allow-list. With `depsFor`'s loopback config, an Origin-carrying mutation from a
     * real phone browser (whose origin IS the machine's tailnet name — what `tailscale serve`
     * publishes) was refused by `withRequestGuard` as cross-site; the listener suite captured
     * exactly that red before this line existed. Built through the same
     * `makeAuthConfig`/`assertOriginConfig` every door boots through (`resolveHostConfig`); with
     * no origin configured the door keeps the stdio config — nothing browser-shaped can reach
     * it, because the listener refuses to start without the origin.
     */
    const hostAuthConfig = scope.hostConfig.authConfig ?? scope.authConfig;
    scope.unsubscribe = unsubscribe;
    scope.probeOpts = probeOpts;
    scope.smtpProbeOpts = smtpProbeOpts;
    scope.openLocalSend = openLocalSend;
    scope.depsFor = depsFor;
    scope.hostAuthConfig = hostAuthConfig;
}
