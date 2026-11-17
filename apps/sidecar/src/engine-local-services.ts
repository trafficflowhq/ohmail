// The desktop's engine: the service bag of an install on its own, and the release of its own claim.

import { UNMETERED_STORAGE_CAP, type KeyProvider, type OpenSendAdapter } from "@trafficflow/core/mail";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
// The release refusal's OWN class, from the one module that throws it: `releaseOwnClaim` tells a
// live-sibling refusal (`nonce_unknown` — the pane owes the sibling-lapse sentence) from "could not look".
import { ClaimReleaseError } from "@trafficflow/core/adapters/organizer-lease";
import { UNMETERED, UNMETERED_ACCESS } from "@trafficflow/db";
import {
  attachmentsService, awayResponderService, contactsService, draftingService, draftsService, kbService,
  scheduleService, tagsService, SCHEDULED_FILES_PLAIN, makeApprovalService, makeMailboxService, makePrivacyService,
  makeScreenerService, messageService, nodeHostResolver, notifyRulesService, rulesService, sendService,
  snippetsService, syncService, threadService, triageService, workflowsService, ServiceError,
  SEND_SUBMISSION_CEILING_MS, type UnsubscribeService, type AuthConfig, type MailboxAllowancePolicy,
  type PushService, type RemoteFetch,
} from "@trafficflow/services/mail";
/* The session LIFECYCLE — the machinery half of the hosted auth service (establish, refresh
 * rotation with reuse detection, family revocation, devices, the paired-device mint), from the
 * `/auth` entry that carries none of the ceremony, none of the Cloud schema and none of the
 * barrel's side effects. This import is what Phase 3's pairing rides on, and its closure is
 * census-pinned by the auth entry's own module-graph test in the services package — the engine
 * bundle's artifact census is the second line. */
import { makeSessionLifecycle } from "@trafficflow/services/auth";
import { ALLOW_ANY_PROBE_HOST, type ApiServices } from "@trafficflow/api/local";
import { AppointmentsRefused, runsPass, searchFor } from "./composition-passes.js";
import { releaseMailboxClaim } from "@ohmail/organizer/lease";
import type { OrganizerKind } from "@trafficflow/core/adapters/organizer-lease";
import type { LocalAi } from "./ai-provider.js";
import type { Diagnostic } from "./log.js";

/**
 * The key provider for an install with no durable key: it refuses instead of encrypting.
 * Modelled on the hosted API's `poisonedKeyProvider`, for a sharper reason: a launch-scoped key
 * allowed to encrypt produces a `mailbox_credentials` row that is garbage by the time anyone
 * reads it — the write succeeds, the shell stops passing the password, and the failure surfaces
 * on the NEXT launch as a mailbox that cannot be opened. Refusing at the write turns that into
 * an error the user sees while still looking at the password field. `503`, not `500`: the
 * request was well-formed and the server is what is not ready; the code matches the log line so
 * the two are greppable together.
 */
export function refusingKeyProvider(): KeyProvider {
  const refuse = (): never => {
    throw new ServiceError(
      "install_key_absent", 503,
      "this install has no durable key, so a password cannot be stored on this machine. " +
        "Nothing was written down: a key that dies with the process would seal a credential " +
        "the next launch could not open.",
    );
  };
  return {
    encrypt: async () => refuse(),
    decrypt: async () => refuse(),
    currentKeyVersion: () => refuse(),
    deriveSubkey: () => refuse(),
  };
}

/**
 * THE IMAGE PROXY'S EGRESS, ARMED — the third of this process's non-mailbox egresses, and the
 * one whose trade the reader has to be told about. The SSRF gate resolves every url and refuses
 * loopback, private, link-local and CGNAT addresses before a socket is opened, and the fetch is
 * PINNED to the addresses resolution returned, so a message can never make this machine talk to
 * something on its own network. The trade: on Cloud the fetch leaves our server, here it leaves
 * the reader's own machine, so a loaded picture tells the sender the message was opened and from
 * which network. Stated in Settings, and why tracking pixels stay refused in both positions — a
 * beacon is all cost and no picture.
 */

/**
 * The LOCAL service bag. Present: the mail domain. Absent, each absence meaning something:
 * `billing`/`waitlist` (the desktop tier is free — 503, the truth about this host); AI metering
 * (declared UNMETERED on `entitlementsPort` — BYO key or local model); `drafter`/`classifier`
 * present only with a verified model the account brings itself (`ai-provider.ts`) — absence keeps the one
 * shared name, `503 drafter_unconfigured`; `sends`/`sendAdapter` present — the shared
 * `SendService`, SMTP coordinates from `config.imap.smtp`, auth from the same sealed credential;
 * `alerts`/`admin` absent; `proposals` absent (no model ⇒ "none" ≠ "nobody asked"). `screener` and
 * `approval` are built without an adapter — the loop's reconcile does the IMAP move, as on Cloud.
 */
/**
 * The desktop tier has no mailbox limit, and nowhere to read one from. The hosted gate takes `SELECT …
 * FOR UPDATE` over the subscription table; a local install migrates the mail journal alone, so that
 * table does not exist here (left on the default gate, every mailbox write failed with `relation … does
 * not exist`). It lives in this file — the only permissive allowance policy in the repository — so the
 * hosted API has no name for it: a bypass Cloud cannot import is one it cannot take by accident, and
 * reaching it requires an import of `apps/sidecar`, which nothing serverless does. The free tier stated
 * once, beside `billing` and the unmetered AI declaration. What still gates a local mailbox is
 * everything not about money: the active-address unique index, the IMAP probe, and the organizer lease.
 */
export const UNMETERED_MAILBOX_ALLOWANCE: MailboxAllowancePolicy = async () => {
  /* No plan, no count, no lock. The desktop tier is free and its limit is the user's disk. */
};

/**
 * Push has no local store, and saying so is the honest version of what already happened.
 * `PushService` reads the push registration table, which the CLOUD migration journal creates; a
 * local database is built from the mail journal alone (`db.ts`), so every call from a desktop
 * install was a query against a missing relation, answered as a 500. This refuses in the
 * vocabulary the routes already speak, and it keeps `@trafficflow/db/cloud` — billing, the
 * ledger, the staff handle — out of the shipped engine bundle, which a static import of the real
 * service would put there. A desktop notification is the shell's to raise from the local event
 * stream; it needs no subscription registered with a server.
 */
const LOCAL_PUSH: PushService = {
  async subscribe() {
    throw new ServiceError("not_found", 404, "push subscriptions are a Cloud feature");
  },
  async unsubscribe() {
    throw new ServiceError("not_found", 404, "push subscriptions are a Cloud feature");
  },
} as unknown as PushService;

/**
 * A local install admits, always — not because the cap does not matter. The counter behind
 * {@link ImapAdmissionPort} lives in a per-address attempt table the Cloud journal creates,
 * which this database does not have. What the cap protects against is a multi-tenant burst: many
 * accounts' attachment fetches plus a worker, in two processes sharing no lock, against one
 * provider's per-account connection limit. Here there is one user, one process, and
 * `attachments-adapter.ts`'s in-process semaphore — which runs first and is unaffected — already
 * bounds how many sockets that one user can open at a time.
 */
const LOCAL_IMAP_ADMISSION = {
  acquire: async () => true,
  release: async () => {},
};

/**
 * How many of the last run's `pending` send reservations a launch names to the reconcile pass,
 * oldest first. A quit or a crash leaves the few a person had pressed; a store holding more is a
 * different fault, and the rest keep the ordinary stale window.
 */
export const INHERITED_SENDS_MAX = 200;

/**
 * Give this install's claim back, keeping every distinct answer apart — one function because a bare
 * `try`/`catch` at a call site collapses them: a number is how many of ours were removed (`0` is a
 * complete answer); `null` is COULD NOT LOOK (a refused search, a short walk, a folder over its
 * ceiling — swallowing it once told a person the mailbox was let go while the claim stood in
 * `ohmail/_meta`); and `"sibling"` (mail 0121) is a release that accomplished nothing because a
 * FRESH claim carries this install's id under a nonce it never wrote — a restored image or clone,
 * a fact the pane owes a sentence, not a "could not look". The sibling arm is tested BEFORE the
 * catch-all: widening a helper without moving the order makes the new class dead code.
 */
export async function releaseOwnClaim(
  adapter: MailboxAdapter,
  installId: string,
  mailboxId: string,
  /**
   * THE NONCES THIS INSTALL CAN NAME AS ITS OWN. A release is addressed by (install, nonce), so a
   * restored image does not lose its claim to a sibling's stop; a `current` of `null` is refused
   * inside rather than widened to the id. BOTH FIELDS REQUIRED, no default: `minted` is every nonce
   * this runtime minted here (`LeaseSelf.mintedNonces`), and an optional field would let a call
   * site forget it and clear every record EXCEPT the one holding the mailbox.
   */
  nonce: { current: string | null; minted: readonly string[] },
  log: Diagnostic,
  reason: string,
  /** The configured window the stale term is measured against — one clock on every tier. */
  staleAfterMs?: number,
): Promise<number | "sibling" | null> {
  try {
    return await releaseMailboxClaim(adapter, installId, mailboxId, nonce.current, {
      ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
      mintedNonces: nonce.minted,
    });
  } catch (err) {
    if (err instanceof ClaimReleaseError && err.code === "nonce_unknown") {
      log("organizer_claim_release_refused_sibling", {
        mailboxId,
        reason: "a fresh claim carries this install's id under a nonce it never wrote — another "
          + "copy of this computer keeps organizing this mailbox until its claim lapses; the "
          + "request stands and the lapse bound records the release then",
      });
      return "sibling";
    }
    log("organizer_claim_release_failed", { err, mailboxId, reason });
    return null;
  }
}

/**
 * How the holder of this mailbox relates to this install — by install id, and by the nonce this
 * install last armed. Read at the stand-down, where `organized_elsewhere:*` is all there is. It is
 * this site's comparison, not the gate's, and the difference is load-bearing: the gate writes a
 * nonce and decides against it (`runLeaseGate`'s confirm arms `lastNonce`), and that value never
 * reaches this scope — `leaseNonce` holds the previous nonce during a renew and `null` after a
 * restart. So `our_last_nonce` means "the holder carries the nonce we last armed" — true about this
 * install, not a claim the gate compared the same values. What it settles: `install_id` is somebody
 * else's install; every other member is this install looking at its own claim.
 */
export function ownClaimTerm(
  by: { installId: string; nonce: string } | null,
  installId: string,
  lastNonce: string | null,
  /** Every nonce this runtime minted here: one of them is ours too ({@link LeaseSelf.mintedNonces}). */
  minted: readonly string[] = [],
): "no_holder" | "install_id" | "other_nonce" | "our_last_nonce" | "no_armed_nonce" {
  if (by === null) return "no_holder";
  if (by.installId !== installId) return "install_id";
  if (lastNonce === null) return "no_armed_nonce";
  return by.nonce === lastNonce || minted.includes(by.nonce) ? "our_last_nonce" : "other_nonce";
}

/**
 * The service bag, rebuilt per request so the two AI slots can be present or absent according to
 * what this install can do at the moment it is asked. Per request rather than per launch because
 * the answer changes while the process runs: somebody saves a key, the endpoint stops answering,
 * a verification succeeds — a bag built at launch would freeze that answer, and a route would
 * offer a model that is gone or refuse one just configured. Every service in it is an imported
 * singleton or a constructor that stores its arguments; no per-request work beyond the object
 * literal. `ai` is `undefined` for a host with no AI at all — the same shape as an install that
 * has simply not configured one.
 */
export function localServices(
  authConfig: AuthConfig,
  keyProvider: KeyProvider,
  /**
   * THIS INSTALL'S OWN ID, and without it the hand-back is refused on the desktop whatever the
   * row says. `MailboxService.release` accepts a stranded claim only when the row's
   * `organized_by_install_id` equals `deps.installId`, and an absent one compares equal to
   * nothing — so the desktop was told it could not stop organizing a mailbox it holds. That is
   * the OTHER half of the same defect as the projection: one half records who holds it, the
   * other half is able to recognise itself. Neither works alone.
   */
  installId: string,
  openSendAdapter: OpenSendAdapter,
  /** True once this engine is leaving and a press can no longer be sent before its store closes. */
  holdOffer: () => boolean,
  unsubscribe: UnsubscribeService,
  /**
   * THE IMAGE PROXY'S FETCH — passed in rather than imported here for the reason `unsubscribe`
   * is: both are egresses, and a composition that builds its own could not be handed a counting
   * double. The call sites resolve it from the config seam.
   */
  imageFetch: RemoteFetch,
  /**
   * WHAT THIS COMPOSITION CLAIMS AS — and here it decides one thing only: whether the send-later
   * verbs may MINT an appointment. The kind rather than a boolean, so this function reads
   * `composition-passes.ts` itself and there is one answer to "does this install keep
   * appointments" rather than a derived flag a caller could compute the other way.
   */
  organizerKind: OrganizerKind,
  /** This composition checks a sender's own signature (`SidecarConfig.dkimKeys`): `providerConfirms`. */
  signatureChecks: boolean,
  ai?: LocalAi,
): ApiServices {
  const classifier = ai?.classifier();
  const drafter = ai?.drafter();
  return {
    sync: syncService,
    /**
     * The session lifecycle over the local store (Phase 3) — the same establish/rotate/revoke
     * machinery Cloud runs, instantiated bare: no ceremony, because this tier has no
     * registration and no factors (the machine's own login is the boundary — the
     * `mintLaunchSession` argument in `identity.ts`), and the base class's hosted hooks answer
     * the local truth: no event table, no throttle, no enrolled factors. Wired but not yet
     * consumed by `localRoutes`; it is what the desktop-as-host door mints paired-device
     * sessions through (`establishPairedDevice`), rotates bearer pairs with (`/auth/refresh`)
     * and revokes by (`GET/DELETE /devices`). The launch session stays `identity.ts`'s.
     */
    auth: makeSessionLifecycle({ config: authConfig }),
    // THE GATED IDEMPOTENT SEND, and the SAME `SendService` Cloud runs — the `outbound_sends`
    // reservation, the pre-minted Message-ID, the verify-by-Sent recovery and `SEND_STALE_AFTER_MS`
    // are all the shared implementation. Only the transport differs, and that difference is
    // `sendAdapter` below: `openLocalSend` builds SMTP from `config.imap.smtp` and authenticates
    // with the one sealed credential the IMAP side decrypts. Forking a second sender here is
    // exactly the divergence the one-pipeline rule forbids on the receive side, for the same reason.
    sends: sendService,
    sendAdapter: openSendAdapter,
    // No platform ceiling on attachment bytes — a fact about this host, not a preference. The
    // hosted API runs behind a serverless request-body limit, and `SendService`'s 3 MB constant
    // is that limit in raw bytes, reasoned from a deployment this process is not. Here the
    // compose form, this handler and the SMTP dial are one process: no request body sits
    // between them, so the only ceiling is the one the user's own submission server announced
    // (`mailboxes.smtp_max_size_bytes`, mail 0055), which `SendService` applies. `null` is a
    // declaration, not an absence — an install that said nothing would get the hosted constant,
    // the stricter branch; until the server has been probed the column is NULL and this still
    // resolves to 3 MB, so the loose direction is unreachable without a measurement.
    sendSurfaceMaxTotalBytes: null,
    // This process outlives every answer: the Sent copy is retried in memory, and an upload on a
    // slow link may run up to the ceiling, which ends it before a resolver may decide its row.
    sendCopyOutlivesAnswer: true,
    // And a delivered send's owed Sent copy is kept on disk, so a quit or a crash does not lose it.
    sendKeepOwedCopy: true,
    sendSubmissionCeilingMs: SEND_SUBMISSION_CEILING_MS,
    // A press offered after it could not end before the store closes is held for the next start.
    sendHoldOffer: holdOffer,
    // UNMETERED STORAGE, typed on the same declaration-not-inference terms as the mailbox
    // allowance below: the desktop tier is free and its limit is the user's own disk. A value
    // somebody wrote, never an absent-config default — the send route REFUSES the sent-copy
    // projection on a host that declared nothing.
    storageCapOf: async () => UNMETERED_STORAGE_CAP,
    push: LOCAL_PUSH,
    imapAdmission: LOCAL_IMAP_ADMISSION,
    // The add-time probe's SSRF gate is a no-op on a local install: a desktop user's own mail
    // server may sit on a LAN address or a non-standard port, and this process opens sockets only
    // on the user's own machine, so there is no cross-tenant network to protect. Named explicitly,
    // never a default — the hosted deployment wires the enforcing `makeProbeHostGuard` instead.
    probeHostGuard: ALLOW_ANY_PROBE_HOST,
    // Whether a no-TLS mail server is on the user's own network: plaintext is offered only then.
    probeScopeResolver: nodeHostResolver,
    /**
     * UNMETERED, SAID OUT LOUD — the ITEM-10 distinction, in the one bag where it matters most.
     *
     * An absent member is a composition nobody finished; this literal is a deployment that means
     * it. Nothing here dials anyone about an account's standing, no limit applies, and the AI half
     * is gated by whether this install has a model key of its owner's own and by nothing else.
     */
    entitlementsPort: UNMETERED,
    mailbox: makeMailboxService({
      keyProvider, allowance: UNMETERED_MAILBOX_ALLOWANCE, installId, signatureChecks,
      // Declared, not absent: `UNMETERED_MAILBOX_ALLOWANCE` ignores the verdict, and an ABSENT
      // reader is what a host that forgot to wire one looks like. This says which this is.
      accessOf: async () => UNMETERED_ACCESS,
    }),
    rules: rulesService,
    message: messageService,
    thread: threadService,
    // The classifier reaches the SUGGEST half only; the read half is constructed without one.
    // `credits` stays absent — this tier is free, so an absent gate means unmetered, not ungated.
    // `unsubscribe` IS here now, and the two things it was waiting for are both in place: this
    // door serves `consentRoutes`, so the account's off switch has a route and a surface, and the
    // shared client's pre-click disclosure reads that row rather than the build. A screen-out
    // states the unsubscribe before the press and then makes it, which is the self-host bag's
    // wiring exactly. Only an ORGANIZER reaches this path: a consent-less reader's decision is a
    // REQUEST, and requests carry no courtesy. `landing-mailbox-truth.test.ts` reads this call
    // site — the landing's standalone qualifier comes out with it.
    screener: makeScreenerService({ unsubscribe, ...(classifier ? { classifier } : {}) }),
    // `drafting` is ALWAYS present and `drafter` only when there is a model, which is the pairing
    // the route expects rather than an oversight. The two are different things: `drafting`
    // assembles the sensitivity-safe context and stores the result, `drafter` is the model. The
    // route resolves the model as an ARGUMENT to the drafting call, so an absent drafter refuses
    // with `503 drafter_unconfigured` before any retrieval happens — while an absent DRAFTING
    // service would answer `500 not configured`, which says a host is broken about a host that is
    // merely free of a model.
    drafting: draftingService,
    ...(drafter ? { drafter } : {}),
    approval: makeApprovalService({}),
    triage: triageService,
    search: searchFor(organizerKind),
    /* `imageFetch` is the test seam `oneClickPost` is, and for the same stated reason: both exist
       so a test can count what left the machine. Production passes nothing and gets the pinned,
       redirect-manual client the hosted door uses — one implementation, so the two doors cannot
       classify a beacon or resolve a host two ways. */
    privacy: makePrivacyService({ remote: imageFetch, resolver: nodeHostResolver }),
    // The MANUAL verb only: `POST /messages/:id/unsubscribe`, which `localRoutes` has mounted
    // (answering 503 `unsubscribe_unconfigured`) since the record table landed, now performs the
    // request on this door. A manual unsubscribe is the user's own explicit act on mail in front
    // of them — the same consent as clicking the list's link themselves, minus the trackers —
    // which is why it is armed while the AUTOMATIC pass above is deliberately not. On this door
    // the POST leaves the user's own machine (there are no ohmail servers in a standalone
    // install's loop, by the door's own design); the hosted door keeps the server-side posture
    // `unsubscribe-service.ts` documents.
    unsubscribe,
    contacts: contactsService,
    snippets: snippetsService,
    notify: notifyRulesService,
    away: awayResponderService,
    attachments: attachmentsService,
    kb: kbService,
    tags: tagsService,
    drafts: draftsService,
    /* Send later's two verbs (mail 0077). This process runs its own scheduled-send pass in the
       local sync loop (the standalone install has no Cloud worker), so an appointment made on this
       door is kept by this door — WHERE THE PASS IS COMPOSED. Where it is not, the door may not
       accept the promise either: `AppointmentsRefused` refuses the mint with the sentence and
       inherits cancel, so a standing appointment can still be taken off. Two independently
       measured conditions on purpose — the door stops the promise, the pass stops the delivery. */
    schedules: runsPass(organizerKind, "scheduled-send")
      ? scheduleService
      : new AppointmentsRefused(),
    // A scheduled letter's files stay in this install's own store, plain, until it goes (mail 0179).
    scheduledFiles: SCHEDULED_FILES_PLAIN,
    workflows: workflowsService,
  };
}
