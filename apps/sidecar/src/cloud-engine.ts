import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { StaticKeyProvider, type KeyProvider } from "@trafficflow/core/mail";
import {
  resolveSession, syncService, ServiceError, isUuid,
  type EntityType, type ServiceContext, type SyncResponse,
} from "@trafficflow/services/mail";
import {
  openLocalDb, type LocalDb, type LocalDbOpenPhase, type MigrationProgress, type OpenLocalDb,
} from "./db.js";
import { ensureLocalWorld, type LocalWorld } from "./identity.js";
import { mintLaunchBearer } from "./launch-bearer.js";
import {
  createCloudAuth, loadSealedTokens, sealTokens, ACCOUNT_ERASED,
  type CloudAuth, type CloudSessionReading, type CloudTokens,
} from "./cloud-auth.js";
import {
  cloudIdentity,
  cloudSignIn,
  CloudSignInError,
  desktopDeviceKind,
  newDesktopLinkPair,
  pollDesktopApproval,
  redeemPairingToken,
  requestDesktopApproval,
  type CloudSignInRequest,
} from "./cloud-signin.js";
import { createCloudMirror, integrityLogFields, CLOUD_SYNC_TYPES, FOLLOW_UP_CAP_MS, type CloudMirror } from "./cloud-mirror.js";
import { startCloudWake, type CloudWake } from "./cloud-wake.js";
import { matchReadRoute } from "./cloud-read.js";
import { answerAccountFirst } from "./cloud-account-first.js";
import {
  handleWindowConsentReadFailure, handleWindowSearchPhases, handleWindowSyncFailure,
  WINDOW_CONSENT_READ_FAILED_ROUTE, WINDOW_SEARCH_PHASES_ROUTE, WINDOW_SYNC_FAILED_ROUTE,
} from "./window-report.js";
import { createWriteThroughProxy, type WriteThroughProxy } from "./cloud-proxy.js";
import {
  accountAnswer,
  accountIsForeign,
  apiBaseFor,
  baseIsForeign,
  decodeMirrorRecord,
  encodeMirrorRecord,
  normalizeBase,
  normalizeOrigin,
  mirrorIsForeign,
  MANAGED_CLOUD_BASE,
  OPERATOR_CA_FILE,
} from "./cloud-origin.js";
import { createHostFetch, probeHostPin } from "./host-pin-probe.js";
import { createAdoptedDoor, DoorFileError } from "./adopted-door.js";
import { probeTransport } from "./operator-ca-fetch.js";
import { originNeedsPin } from "@trafficflow/core/pair-link";
import type { Diagnostic } from "./log.js";
import { startEngineVitals } from "./vitals.js";
import { createSessionWatch, heldReadingOf, sameReading } from "./session-watch.js";

/**
 * The cloud engine — a read-only mirror of a hosted account, in the same stdio process the shell
 * spawns. Unlike `engine.ts` (the LOCAL organizer), a Cloud install must never become a second
 * organizer, so this module's import graph reaches NO IMAP adapter, lease or sync loop
 * (`cloud-engine-census.test.ts` fails the moment one enters), and `main.ts` refuses Cloud mode if
 * any `OHMAIL_IMAP_*` is set. It pulls (`cloud-mirror.ts`) over a bearer client and serves READS
 * from the mirror (`cloud-read.ts`), forwarding every WRITE to Cloud (`cloud-proxy.ts`; a failed
 * pull answers `503 offline_read_only`). Signed-out is a served STATE: it comes up pre-auth serving
 * `/health` and `/cloud/signin` (the PKCE verifier in memory only), and secrets travel the bridge.
 */

export interface CloudSidecarConfig {
  /** Where the local mirror lives. Created if absent; locked while open. */
  dataDir: string;
  /** The hosted API base — the managed service's public default origin. */
  cloudUrl: string;
  /**
   * THE ONE SERVER A BROWSER HAND-OFF MAY BE PERFORMED AGAINST. Absent ⇒ {@link MANAGED_CLOUD_BASE}.
   *
   * A value rather than a constant for the reason `cloudUrl` is one — a test, and a staging
   * deployment, are talking to a hosted service at an address that is not the production one, and a
   * hardcoded comparison would refuse the ceremony there while claiming to be about the ceremony's
   * meaning. Production never sets it; `main.ts` composes no such variable.
   */
  handoffBase?: string;
  /** The bearer/refresh pair the shell passes on FIRST launch. Absent on later launches (sealed). */
  tokens?: CloudTokens;
  /**
   * The mailbox address this account mirrors — the local identity's address.
   *
   * **`null` ONLY on a paired door or the pending door** — a link names a computer, and the pending
   * door's first claim names its account (`identityPending`). It is `null` and never `""`, because
   * an empty string is an address that was configured and is blank — `sameOwner("")` matches
   * nothing, and a mirror recorded that way is thrown away on every launch.
   */
  address: string | null;
  /**
   * THE HOSTED DOOR BOOTED BEFORE ITS ACCOUNT IS KNOWN — the browser approval's first boot, with
   * `address: null`. The first sign-in adopts the account it reads from the hosted service: it
   * CREATES `doorFile` (this install's `config.json`) once and records the mirror's owner. Absent
   * on every other door. See `adopted-door.ts`.
   */
  identityPending?: { doorFile: string };
  displayName?: string;
  /** The per-install key ring, for the token seal. Absent ⇒ tokens live in memory for this launch. */
  keks?: Record<number, Buffer>;
  log?: Diagnostic;
  now?: () => Date;
  /** Injected for tests; production dials the real hosted API. */
  fetchImpl?: typeof fetch;
  /**
   * The fingerprint of the desktop this install paired with — present only on the desktop-host
   * door, turning every connection into a pinned one. No CA vouches for a machine on someone's
   * network, so trust comes from the pairing ceremony: the link carried `SHA-256(SubjectPublicKeyInfo)`
   * of the door's key, which is all this install accepts (see `host-pin-probe.ts` — the cert is a
   * cache, the KEY is the identity). ABSENT means UNPINNED, correct for the hosted service and a
   * self-host box (verified against the platform trust store); a desktop-host door refuses a link
   * with no fingerprint. An explicit {@link fetchImpl} wins — the test seam, unreachable from config.
   */
  hostPin?: string;
  pageLimit?: number;
  pollIntervalMs?: number;
  /** How long `/search` waits for the account before the mirror answers; absent, `ACCOUNT_FIRST_BOUND_MS`. */
  accountFirstBoundMs?: number;
  /**
   * Told what the boot is about to spend its time on — the same narration, and the same consumer
   * (`main.ts` turning it into `phase` frames), as the local engine's. See `SidecarConfig.onPhase`.
   */
  onPhase?: (phase: CloudBootPhase, progress?: MigrationProgress) => void;
  /**
   * Told the mailbox this launch serves when `ready` could not name one (a paired install, whose
   * world has no row until the first mailbox list lands) — `main.ts` writes it as a `mailbox`
   * frame. Awaited before any answer that depends on it goes out.
   */
  onServedMailbox?: (mailboxId: string) => Promise<void>;
  /** The pairing's wait for that name — {@link PAIR_SERVED_WAIT_MS}; a test shortens it. */
  pairServedWaitMs?: number;
}

/** The cloud door's boot phases. Identical to the local door's: the two share `openLocalDb`. */
export type CloudBootPhase = LocalDbOpenPhase | "preparing";

export interface CloudSidecar {
  readonly db: LocalDb;
  readonly world: LocalWorld;
  /** The mailbox this launch serves: `world.mailboxId`, or the one named after it (`onServedMailbox`). */
  servedMailboxId(): string;
  /** The per-launch bearer token for the LOCAL bridge. In memory only. */
  readonly sessionToken: string;
  /** `Request → Response` over the mirror (reads) + the write-through proxy — the stdio surface. */
  handle(req: Request): Promise<Response>;
  /** Pull the hosted feed now, then poll. A signed-out engine does nothing and does not throw. */
  start(): Promise<void>;
  /** Stop polling, close and unlock the database. */
  stop(): Promise<void>;
  /** Is the hosted account reachable? Surfaced in `/health` and the ready frame. */
  online(): boolean;
  /** Is there a session at all? False on a pre-auth launch and after a sign-out. */
  signedIn(): boolean;
  /**
   * Is the mirror mid-pull right now? For the shutdown line, which used to report only the stdio
   * host's in-flight request count — a number that is zero precisely when a drain is what the quit
   * is waiting for, so it said "nothing in flight" about the thing holding everything up.
   */
  mirrorDraining(): boolean;
  /** Answer every held `GET /cloud/session/wait` now and hold no new one — before a quit waits. */
  releaseHeld(): void;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const quiet = (r: SyncResponse): boolean =>
  !r.hasMore && r.changes.creates.length + r.changes.updates.length + r.changes.moves.length + r.changes.deletes.length === 0;

/**
 * THE DRAIN THAT WAITS ON A FOLLOW-UP CHAIN. A window drain with nothing new, while a write the
 * echo bound cut is still being pulled, is asked again at every page the mirror commits, so the
 * drain that follows the answer carries the write the moment this copy holds it. It ends with the
 * last live chain and never past `capMs` from the ask; a second drain on the same `key` (cursor,
 * limit, types) shares the first one's wait.
 */
export function drainOnFollowUp(
  held: Map<string, Promise<SyncResponse>>,
  key: string,
  mirror: Pick<CloudMirror, "followUps" | "awaitFollowUp">,
  ask: () => Promise<SyncResponse>,
  first: SyncResponse,
  capMs: number = FOLLOW_UP_CAP_MS,
): Promise<SyncResponse> {
  if (!quiet(first) || mirror.followUps() === 0) return Promise.resolve(first);
  const live = held.get(key);
  if (live) return live;
  const wait = (async (): Promise<SyncResponse> => {
    const end = Date.now() + capMs;
    let result = first;
    while (quiet(result) && mirror.followUps() > 0 && Date.now() < end) {
      if (!(await mirror.awaitFollowUp(end - Date.now()))) break;
      result = await ask();
    }
    return result;
  })().finally(() => { held.delete(key); });
  held.set(key, wait);
  return wait;
}

/**
 * Add the hosted message count to a local `GET /mailboxes` answer, per mailbox that has one. The
 * window's status strip needs two numbers; in Cloud mode only one is local (`cloud-read.ts` serves
 * the list from the mirror), and the other is what the mirror drains toward, learned from the hosted
 * `?counts=1` on its own cadence. It writes `hostedMessageCount`, NOT `messageCount`: the latter is
 * the shared DTO field, so filling it here would make the strip compare the mirror against itself.
 * ABSENT, NEVER ZERO — a mailbox the map has nothing for is left as the read produced it, since `0`
 * asserts an empty account. A non-JSON or non-list body passes through untouched (a decoration).
 */
async function decorateHostedCounts(
  res: Response,
  counts: ReadonlyMap<string, number>,
): Promise<Response> {
  if (counts.size === 0) return res;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return res;
  const decorated = items.map((row) => {
    const id = (row as { id?: unknown })?.id;
    const n = typeof id === "string" ? counts.get(id) : undefined;
    return typeof n === "number" ? { ...(row as object), hostedMessageCount: n } : row;
  });
  return json({ ...(body as object), items: decorated }, res.status);
}

/**
 * THE STORE-STUCK DISCLOSURE. The mirrored rows carry the HOSTED account's status — healthy —
 * so a mirror that cannot STORE what it pulls looked settled: the released 0.20.0's first-sync
 * 23503 wedge rendered no sentence anywhere. While the mirror holds quarantined rows, every
 * served row is overlaid `status: "error", errorCode: "storage"` — the closed set's own
 * "Sync failed — ohmail could not store this mail. This one is on us." — so the strip's
 * mailbox-error arm and Settings → Mailboxes disclose it through affordances that exist, and
 * the pane's "Sync now" ends in `pullOnce`, which re-applies the quarantine: the retry.
 * Derived at read time, never written, so it clears the moment the quarantine empties.
 */
async function decorateStoreStuck(
  res: Response,
  quarantined: { count: number },
): Promise<Response> {
  if (quarantined.count === 0) return res;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items)) return res;
  const overlaid = items.map((row) =>
    row && typeof row === "object"
      ? { ...(row as object), status: "error", errorCode: "storage" }
      : row,
  );
  return json({ ...(body as object), items: overlaid }, res.status);
}

/**
 * The file recording which hosted account this cloud mirror was bootstrapped for: the ADDRESS on
 * the first line and the SERVER's base URL on the second.
 *
 * It held the address alone until there was a third door. See `cloud-origin.ts` for why the server
 * had to join it — in one sentence: the mirror directory is keyed by MODE, so `me@example.com` on
 * the hosted service and `me@example.com` on an operator's own server were the same owner by this
 * file's own comparison, and shared one database.
 */
export const MIRROR_OWNER_FILE = "mirror-owner";

/**
 * How two addresses are compared for the purpose of "is this the same account".
 *
 * One function rather than two spellings, because the launch check and the sign-in check must
 * agree exactly: a difference of case or padding that one of them read as a change of owner and
 * the other did not would be a discard on every launch, or a foreign session admitted.
 */
const sameOwner = (v: string): string => v.trim().toLowerCase();

/**
 * The address this mirror was bootstrapped for, or null when the marker file is ABSENT. Written by
 * {@link enforceMirrorOwner} at construction, so from the moment the engine serves it holds exactly
 * the address the local world was built for and reads are scoped by. A file that EXISTS AND IS
 * EMPTY returns `""`, deliberately distinct: absent means "predates the marker" (adopted), empty
 * means "a write was torn" (an owner that cannot be established and must never read as a match) —
 * collapsing the two would turn a crash between the discard and the rewrite into the one thing this
 * whole mechanism exists to refuse.
 */
export function readMirrorOwner(dataDir: string): string | null {
  const raw = readMirrorRecordRaw(dataDir);
  return raw === null ? null : decodeMirrorRecord(raw).address;
}

/**
 * The SERVER this mirror was bootstrapped against, or null when the record does not name one.
 *
 * Null is a real and common answer rather than a defect, and it is the whole reason
 * {@link baseIsForeign} defaults to "not foreign": every install written before this line existed
 * has a one-line record, and there was only ever one server for it to have been written by.
 */
export function readMirrorBase(dataDir: string): string | null {
  const raw = readMirrorRecordRaw(dataDir);
  return raw === null ? null : decodeMirrorRecord(raw).base;
}

/**
 * The ACCOUNT this directory's mail belongs to, as a server named it, or null when none has.
 *
 * Null is the ordinary answer for every install that predates the pairing door and for every
 * composition that does not name accounts — see `MirrorRecord.account`, and `accountIsForeign`,
 * which is the only thing allowed to decide anything from it.
 */
export function readMirrorAccount(dataDir: string): string | null {
  const raw = readMirrorRecordRaw(dataDir);
  return raw === null ? null : decodeMirrorRecord(raw).account;
}

/**
 * Is this directory waiting for a discard that has not happened yet? The DURABLE answer, read from
 * the record rather than a process flag — the flag says what THIS process did, and every caller
 * here asks what state the DIRECTORY is in. A pairing stages a discard by stamping the record;
 * until a construction performs it, the mail on disk belongs to the world being left while the
 * record already names the world being arrived at. `false` for an absent or unreadable record — the
 * ordinary, safe state; reading an unreadable one as "pending" would refuse every pairing on an
 * install whose marker was damaged.
 */
export function readMirrorDiscardPending(dataDir: string): boolean {
  const raw = readMirrorRecordRaw(dataDir);
  return raw === null ? false : decodeMirrorRecord(raw).discardPending;
}

function readMirrorRecordRaw(dataDir: string): string | null {
  const ownerPath = join(dataDir, MIRROR_OWNER_FILE);
  if (!existsSync(ownerPath)) return null;
  return readFileSync(ownerPath, "utf8");
}

/**
 * One mirror, one account — enforced before the database is opened. The cloud directory is keyed by
 * MODE, not account, and `ensureLocalWorld` reuses one `accounts` row, so re-pointing the door at a
 * DIFFERENT hosted address would reopen a database holding the previous account's mail under the
 * `accountId` the new session reads by — the worst failure shape this product has (measured). The
 * mirror is a CACHE, so the answer is to discard and re-bootstrap, never reconcile two accounts (the
 * sealed session and cursor go with it). Called under the directory's lock, idempotent, marker-less
 * installs adopted. A mirror belongs to an account on a SERVER, so `cloudUrl` is compared as hard as the
 * address; sign-in and pair-redeem re-ask after the database is open (this settles only a launch).
 */
export function enforceMirrorOwner(
  dataDir: string,
  /** `null` on a paired door, which is configured with no mailbox address — see below. */
  address: string | null,
  /** The base this launch is configured to dial — `CloudSidecarConfig.cloudUrl`. */
  cloudUrl: string,
  log?: Diagnostic,
  /** The pending door: `address` is null because nobody knows it yet, not because none is owed. */
  opts: { identityPending?: boolean } = {},
): boolean {
  /* ── THE ADDRESS IS COMPARED ONLY WHEN BOTH SIDES CARRY ONE ─────────────────────────────
     A paired door is configured with no address at all: a pairing link names a computer, and which
     mailboxes this install reads is the host's answer. So `null` here is not an owner that fails to
     match — it is the absence of a claim, and a comparison against it would discard a healthy
     mirror on every single launch. The SERVER half is untouched and is what protects this door:
     `cloudUrl` is the host's own origin, unique per machine, and re-pointing at a different one
     still discards. The ACCOUNT recorded by the pairing redeem is the third, and it is the only
     one that can see a host reinstalled at the same address. */
  const served = address === null ? null : sameOwner(address);
  /* NULL WHEN IT DOES NOT PARSE, never the raw value. A base that is not a URL cannot be compared
     with anything, so recording it would be recording a fact this file's own predicate must then
     ignore — and it would put an arbitrary string into the record for no reader. `null` says
     exactly what is true: this launch's server could not be established, so no future launch is
     told it disagreed with one. `baseIsForeign`'s one-sided default is the same answer. */
  const servedBase = normalizeBase(cloudUrl);
  const ownerPath = join(dataDir, MIRROR_OWNER_FILE);
  const priorRaw = readMirrorRecordRaw(dataDir);
  const priorRecord = priorRaw === null ? null : decodeMirrorRecord(priorRaw);
  const prior = priorRecord?.address == null ? null : sameOwner(priorRecord.address);
  const addressChanged = prior !== null && served !== null && prior !== served;
  /**
   * Which server the state already in this directory belongs to. `null` means "nothing here to
   * protect" and is the only reading that may skip the comparison; everything else resolves to a
   * base, because a Cloud directory holding anything was filled by SOME server. A record naming one
   * is the ordinary case; a record naming NONE is an earlier one-line marker (compared against that);
   * NO record but state on disk is a real upgrade state (the seal predates the marker), which gating
   * the comparison on the record missed — that profile kept its seal and had the hosted bearer
   * activated against whatever server the door pointed at; a genuinely empty directory is adopted.
   */
  const holdsCloudState = ["pgdata", "cloud-cursor.json", "cloud-tokens.seal"].some((f) =>
    existsSync(join(dataDir, f)),
  );
  const serverChanged = mirrorIsForeign(priorRecord, holdsCloudState, servedBase ?? cloudUrl.trim());
  /* ── A DISCARD THE LAST RUN ASKED FOR, EXPLICITLY ────────────────────────────────────────────
     A pairing told to start over cannot throw the mirror away itself: at redeem time `pgdata` is an
     OPEN database, and removing it under the process holding it corrupts that process. So it stages
     the discard here, where the constructor already does one correctly, before anything is opened.
     It is a POSITIVE flag written by one route on one explicit instruction — never inferred, and
     never a default. */
  const askedToStartOver = priorRecord?.discardPending === true;
  const foreign = addressChanged || serverChanged || askedToStartOver;
  if (foreign) {
    /* THE SEAL SURVIVES A STAGED DISCARD, and this is the one asymmetry in this function. A
       start-over pairing has ALREADY sealed the new world's session — that is what it was for —
       and it is sitting in this directory waiting for this launch. Removing it here would spend
       somebody's single-use pairing code and then throw away the session it bought, leaving them
       at a sign-in screen with a code that no longer works. The mirror and cursor are the previous
       world's and go; the credential is the NEW world's and stays.

       On the other two paths nothing has been sealed for the world being arrived at, so the seal
       there belongs to the world being left and must go — which is what it has always done. */
    const stale = askedToStartOver && !addressChanged && !serverChanged
      ? ["pgdata", "cloud-cursor.json"]
      : ["pgdata", "cloud-cursor.json", "cloud-tokens.seal"];
    // The database, its cursor and (usually) the previous account's sealed session are all stale.
    // Remove them so the new account bootstraps from empty rather than inheriting a stranger's mail.
    for (const name of stale) {
      rmSync(join(dataDir, name), { recursive: true, force: true });
    }
    // Never the addresses, and never the two SERVERS either. Which mailbox was served before and
    // which is served now are the exact identifying signal the sidecar log census exists to keep
    // off the line — and an operator's own hostname identifies them at least as sharply as their
    // address does. An operator needs to know a foreign mirror was discarded, not whose it was.
    //
    // WHICH of the two comparisons demanded it does go on the line, because it tells "I switched
    // accounts" from "I moved this install to another server" and an operator reading a wiped
    // mirror needs to know which of those they did. It travels as `reason` — one of two FIXED
    // sentences chosen here, never composed from either value — rather than as two new field
    // names, so nothing about this widens `ALLOWED_FIELDS`. `prior`/`served` stay local.
    log?.("cloud_mirror_reset_on_owner_change", {
      changed: true,
      reason: addressChanged
        ? "the mailbox address this mirror was bootstrapped for is not the one being served"
        : serverChanged
          ? "this install has been pointed at a different server than the mirror was bootstrapped " +
            "against, so the mirror and the session sealed for the previous server are discarded"
          : "the last pairing was told to start over, so the mail this install held for the " +
            "previous account is discarded and the newly paired session keeps its place",
    });
  }
  mkdirSync(dataDir, { recursive: true });
  /* THE ACCOUNT IS CARRIED FORWARD, NOT REWRITTEN — this rewrite happens on EVERY launch, and a
     record composed from what this launch happens to know would drop the account the pairing
     redeem wrote and silently un-bind the directory. Carried only when the mirror SURVIVED: a
     discard is a new world, and keeping the previous world's account would then refuse the very
     re-pairing the discard exists to allow. */
  /* THE FLAG IS CLEARED BY BEING REWRITTEN WITHOUT IT — a staged discard that survived its own
     launch would throw the mirror away on every launch afterwards, which is a mailbox that never
     finishes syncing and no message anywhere saying why.

     AND THE ACCOUNT SURVIVES A STAGED DISCARD, unlike the other two: a start-over pairing wrote the
     NEW world's account id in the same breath as the flag, so it is not the discarded world's and
     clearing it would un-bind the directory the pairing had just bound. */
  /* THE PENDING DOOR KEEPS THE ACCOUNT IT FOUND. It launches knowing no address, and rewriting the
     record with none would make a directory holding another account's mail read as unowned — which
     the first claim would then adopt. A surviving mirror keeps its owner; a discarded one has none. */
  const recordedAddress = opts.identityPending === true && !foreign
    ? priorRecord?.address ?? null
    : served;
  writeFileSync(
    ownerPath,
    encodeMirrorRecord(
      recordedAddress,
      servedBase,
      addressChanged || serverChanged ? null : priorRecord?.account ?? null,
    ),
    { mode: 0o600 },
  );
  return foreign;
}

/** How long the door waits for a server to say hello. Short: somebody is watching a spinner. */
export const PROBE_DEADLINE_MS = 12_000;

/**
 * How long a pairing's answer waits for the first mailbox list to name the served mailbox. One
 * hosted read on the network the link named; past this the answer goes without it and the
 * window's lifecycle poll opens the mail when the name arrives.
 */
export const PAIR_SERVED_WAIT_MS = 10_000;

/**
 * What answered at the configured address — the self-hosted door's probe. Exported and pure-ish
 * (the `fetch` is a parameter) so the classification can be test-driven, which matters because
 * every branch is a SENTENCE somebody reads when least able to guess. Every refusal names what was
 * tried — the full base — so an operator can see the app dialled `https://…/api/hello` and not
 * something else. The private-CA branch is what this route exists for: a self-host stack issues its
 * own certificates and Node verifies against its compiled-in roots, so it fails
 * `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` (measured against the running stack) — the honest answer names
 * the `NODE_EXTRA_CA_CERTS` file to install, never an offer to skip verification, which nothing here can do.
 */
export async function probeCloudServer(cloudUrl: string, fetchImpl: typeof fetch): Promise<Response> {
  const base = cloudUrl.replace(/\/+$/, "");
  const target = `${base}/hello`;
  /* `more` is the structured half of a refusal whose remedy is mechanical — today only the
     certificate's names. It rides in `details` beside `kind`, so a surface can read the two names
     without parsing the sentence, and the sentence carries them too because the window renders the
     engine's message whole (`self-host.ts#probeConfiguredServer`). */
  const refuse = (message: string, kind: string, more?: Record<string, unknown>): Response =>
    json(
      { error: { code: "cloud_probe_failed", message, details: { kind, target, ...(more ?? {}) } } },
      502,
    );

  let res: Response;
  try {
    res = await fetchImpl(target, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_DEADLINE_MS),
    });
  } catch (err) {
    return refuse(...describeProbeFailure(err, target));
  }

  if (!res.ok) {
    return refuse(
      `${target} answered ${res.status}. That address is reachable, but it is not answering as an ` +
        "ohmail server — check that you gave the address you open ohmail at in a browser.",
      "status",
    );
  }

  let hello: { product?: unknown; flavor?: unknown; needsSetup?: unknown; auth?: unknown };
  try {
    hello = (await res.json()) as typeof hello;
  } catch {
    return refuse(
      `Something answered at ${target}, but not with the greeting an ohmail server sends. Check ` +
        "that you gave the address you open ohmail at in a browser.",
      "not_ohmail",
    );
  }
  /* THE PRODUCT NAME IS THE CHECK, and it is worth having: a 200 with a body is what a router's
     admin page, a NAS, a parked domain and a default nginx all return. Without this the door would
     accept them, configure the install against them, and fail at the sign-in with a sentence about
     credentials — sending somebody to check a password when what is wrong is the address. */
  if (hello.product !== "ohmail") {
    return refuse(
      `Something answered at ${target}, but it is not an ohmail server. Check that you gave the ` +
        "address you open ohmail at in a browser.",
      "not_ohmail",
    );
  }

  /* ── TWO ANSWERS THAT ARE AN OHMAIL SERVER AND STILL NOT A SERVER TO SIGN IN TO ─────────────
     Both were reaching the password form, because every 2xx read as success and the greeting's own
     fields were rendered and then ignored. Raised by review. A server saying `needsSetup` has no
     accounts yet, so every credential typed into the next screen is refused by definition — and the
     person is one step away from the page that would fix it. */
  if (hello.needsSetup === true) {
    return refuse(
      `That is an ohmail server, but it has not been set up yet — there are no accounts on it. ` +
        `Open ${target.replace(/\/api\/hello$/, "")} in a browser and finish setting it up first.`,
      "needs_setup",
    );
  }
  /* And the MANAGED service answering here means somebody typed our address into the field for
     their own server. The doors are not interchangeable: this one has no browser hand-off, and the
     hosted door is the one with the account behind it. */
  if (hello.flavor === "managed") {
    return refuse(
      `${target} is the hosted ohmail service rather than a server you run. Go back and choose ` +
        "“ohmail Cloud” instead.",
      "managed",
    );
  }
  /* AND `local` IS A DESKTOP'S OWN WINDOW DOOR, which is not a door anything may pair with.
     It is the private surface an install serves to ITSELF — no pairing redeem is mounted on it, so
     a client that got this far would configure successfully and then be refused at the redeem with
     a sentence about a token. The two desktop surfaces are told apart by exactly this field: a
     machine offering itself to other devices answers `desktop-host`, and one that is merely running
     answers `local`. Refusing by name here is the difference between "turn same-network access on
     over there" and an error about a pairing code. */
  if (hello.flavor === "local") {
    return refuse(
      `${target} is an ohmail desktop that is not offering itself to other devices. On that ` +
        "computer, open Settings → Devices and turn on access for your other devices, then use " +
        "the pairing code it prints.",
      "local",
    );
  }

  /* Everything here is the SERVER's own answer about itself and none of it is secret — it is what
     that address serves to anyone who asks. The door renders the flavor so somebody who typed our
     address into the self-hosted field can see what they actually reached. */
  return json({
    ok: true,
    target,
    /* THE BASE THIS ANSWER WAS OBTAINED AT, so the caller configures the one that worked instead
       of re-deriving it. The two-step discovery below tries the root and then `/api`, and which of
       them answered is a fact only this side holds; a window that recomposed it would be a second
       opinion about the thing that was just measured. */
    base,
    flavor: typeof hello.flavor === "string" ? hello.flavor : null,
    needsSetup: hello.needsSetup === true,
    auth: hello.auth ?? null,
  });
}

/**
 * A probe's answer, narrowed to the one flavor the paired-desktop door may configure.
 * `probeCloudServer` already refuses the two flavors nothing may pair with (the hosted service, and
 * a desktop not offering itself) with sentences that name what to do. What it does not refuse is a
 * SELF-HOSTED server, right on the self-hosted door but the wrong DOOR when reached from a pairing
 * link — saying so is the difference between moving one screen back and re-printing a pairing code
 * that was never the problem. A refusal is passed through untouched: it was composed where the
 * failure happened, and a second classification here would describe something this function did not observe.
 */
async function refuseUnlessDesktopHost(said: Response, origin: string): Promise<Response> {
  if (!said.ok) return said;
  const body = (await said.clone().json()) as { flavor?: unknown };
  if (body.flavor === "desktop-host") return said;
  return json(
    {
      error: {
        code: "cloud_probe_failed",
        message:
          `${origin} is an ohmail server you run rather than a desktop offering its mailbox to ` +
          "your other devices. Go back and choose “A server I run” instead.",
        details: { kind: "selfhost", target: origin },
      },
    },
    502,
  );
}

/**
 * Where is the API at this origin? — the root, or under `/api`. Discovered, not configured: the
 * hosted service and a desktop host answer at the ROOT, a self-host stack answers under `/api` (one
 * Caddy site carries the web app too), and the person typing the address cannot know which. So both
 * are tried, root first, and the greeting decides (`probeCloudServer` composes every sentence). A
 * second dial is only worth making when the first proved nothing about the ADDRESS: "something
 * answered and was not an ohmail greeting" (`not_ohmail`) is exactly a self-host root, so that is
 * retried; a transport failure or an ohmail server already identified and REFUSED is not — repeating
 * it at a longer path produces the same failure and a worse sentence.
 */
export async function probeCloudDoor(origin: string, fetchImpl: typeof fetch): Promise<Response> {
  const root = origin.replace(/\/+$/, "");
  const atRoot = await probeCloudServer(root, fetchImpl);
  if (atRoot.ok) return atRoot;

  const kind = await refusalKind(atRoot);
  if (kind !== "status" && kind !== "not_ohmail") return atRoot;
  return probeCloudServer(apiBaseFor(root), fetchImpl);
}

/**
 * The `details.kind` a refusal carries, or null when it carries none.
 *
 * CLONED, because the caller may still return this very response and a body may be read once.
 * Reading the original would hand the window a refusal whose body has been consumed — a 502 with
 * nothing in it, which the door renders as its own generic sentence and which looks like the
 * engine having failed rather than the server having answered.
 */
async function refusalKind(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { error?: { details?: { kind?: unknown } } };
    const kind = body.error?.details?.kind;
    return typeof kind === "string" ? kind : null;
  } catch {
    return null;
  }
}

/** Node's own TLS verification failures, as the codes it raises them with. */
const TLS_FAILURE_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_UNTRUSTED",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * A thrown probe, as the sentence to show and the kind to record — the classification, alone, so a
 * test can drive every branch with a constructed error and no network.
 *
 * The code is read off the CAUSE as well as the error: `fetch` wraps transport failures in a
 * `TypeError` whose `cause` is the real one, and reading only the outer error would classify every
 * single failure — a wrong name, a refused port, an untrusted certificate — as the same shrug.
 */
export function describeProbeFailure(
  err: unknown,
  target: string,
): [message: string, kind: string, more?: Record<string, unknown>] {
  const failure = transportFailure(err);
  const code = failure?.code ?? null;
  if (code !== null && TLS_FAILURE_CODES.has(code)) {
    if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
      /* THE ONE TLS REFUSAL WHOSE REMEDY IS MECHANICAL — a certificate issued for another name —
         and it used to name neither name, so the person was told to use "the address the
         certificate was issued for" while this process was holding it. */
      const { presented, requested } = certificateNames(failure?.at);
      const shown = presented.slice(0, MAX_CERT_NAMES);
      const rest = presented.length - shown.length;
      const names = shown.length === 0
        ? null
        : `${shown.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
      const message = names === null
        ? `${target} answered, but its certificate is for a different name. Use the address the `
          + "certificate was issued for."
        : `${target} answered, but its certificate is for ${names}`
          + `${requested === null ? "" : `, not ${requested}`}. Use one of the names the `
          + "certificate was issued for, or give that server a certificate for the address you typed.";
      if (names === null) return [message, "tls_name"];
      return [
        message,
        "tls_name",
        { tls: { presented, ...(requested === null ? {} : { requested }) } },
      ];
    }
    if (code === "CERT_HAS_EXPIRED" || code === "CERT_NOT_YET_VALID") {
      return [`${target} answered, but its certificate is not currently valid.`, "tls_validity"];
    }
    return [
      `${target} answered, but its certificate is signed by an authority this computer does not ` +
        "trust — which is what a server that issues its own certificates looks like from here. " +
        `ohmail verifies certificates and will not skip that. Put your server's root certificate ` +
        `in a file named ${OPERATOR_CA_FILE} in this app's data folder and open ohmail again, or ` +
        "give the server a certificate from an authority this computer already trusts.",
      "tls_trust",
    ];
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return [
      `Nothing on this network knows the name in ${target}. Check the address, or that this ` +
        "computer can look that name up.",
      "dns",
    ];
  }
  if (code === "ECONNREFUSED") {
    return [`Nothing is answering at ${target}. Check the address and the port.`, "refused"];
  }
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "TimeoutError") {
    return [`${target} did not answer in time. Check the address, and that it is reachable from ` +
      "this computer.", "timeout"];
  }
  const detail = err instanceof Error && err.message ? ` (${err.message})` : "";
  return [`ohmail could not reach ${target}${detail}.`, "unreachable"];
}

/**
 * The first transport code in a thrown value, down `cause` AND through `AggregateError.errors` —
 * both branches load-bearing. `fetch` throws `TypeError: fetch failed` with the real error on
 * `cause`, so reading the outer error alone classifies every failure as the same shrug (measured:
 * an untrusted cert surfaces as `cause.code = UNABLE_TO_GET_ISSUER_CERT_LOCALLY`). And a host with
 * more than one address — every dual-stack server — reports the lot as an `AggregateError` with no
 * `code` and no `cause`; a walker following only `cause` would report "unreachable" for a cert
 * problem it was holding. The first code found wins — a mixed aggregate is a judgement call, and the
 * first attempt's answer is the one the connection would have used.
 */
function transportFailure(err: unknown): { code: string; at: unknown } | null {
  const seen = new Set<unknown>();
  const walk = (cur: unknown, depth: number): { code: string; at: unknown } | null => {
    if (cur === null || cur === undefined || depth > 5 || seen.has(cur)) return null;
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return { code, at: cur };
    if ((cur as { name?: unknown }).name === "TimeoutError") return { code: "TimeoutError", at: cur };
    const nested = (cur as { errors?: unknown }).errors;
    if (Array.isArray(nested)) {
      for (const one of nested) {
        const found = walk(one, depth + 1);
        if (found !== null) return found;
      }
    }
    return walk((cur as { cause?: unknown }).cause, depth + 1);
  };
  return walk(err, 0);
}

/** The code alone, for the branches that need nothing else. ONE walk, so the two cannot diverge. */
function errorCode(err: unknown): string | null {
  return transportFailure(err)?.code ?? null;
}

/** At most this many names go into a sentence somebody reads; a certificate may carry hundreds. */
const MAX_CERT_NAMES = 4;

/**
 * THE TWO NAMES A HOSTNAME MISMATCH IS ABOUT, off the error Node threw — `host` is what was asked
 * for and `cert.subjectaltname` is what the server presented (falling back to the subject's common
 * name for a certificate old enough to have no SAN). Public by construction: they are what that
 * address serves to anyone who connects, and no key, token or fingerprint is read here.
 *
 * The list is TRUNCATED rather than dropped — a wildcard bundle can carry hundreds of names, and a
 * refusal that pastes all of them is one nobody reads.
 */
function certificateNames(at: unknown): { presented: string[]; requested: string | null } {
  const e = at as { host?: unknown; cert?: unknown };
  const requested = typeof e.host === "string" && e.host.trim() !== "" ? e.host.trim() : null;
  const cert = e.cert as { subjectaltname?: unknown; subject?: unknown } | undefined;

  const presented: string[] = [];
  const san = cert?.subjectaltname;
  if (typeof san === "string") {
    for (const entry of san.split(",")) {
      /* `DNS:a.example.com, IP Address:10.0.0.1` — the TYPE is dropped and the value kept, because
         the person is being asked to compare it with the address they typed. */
      const value = entry.trim().replace(/^[A-Za-z ]+:/, "").trim();
      if (value !== "" && !presented.includes(value)) presented.push(value);
    }
  }
  const cn = (cert?.subject as { CN?: unknown } | undefined)?.CN;
  if (presented.length === 0 && typeof cn === "string" && cn.trim() !== "") presented.push(cn.trim());

  return { presented, requested };
}

export async function createCloudSidecar(config: CloudSidecarConfig): Promise<CloudSidecar> {
  /**
   * The transport for a question about somebody else's address — the injected seam, NEVER the one
   * this door is pinned to. Captured before the pinning below, because after it `config.fetchImpl`
   * is either the test seam or the transport built for the CONFIGURED host: a candidate probe that
   * read it asked "is there an ohmail server at the address I just typed" over the transport of the
   * door the person is trying to LEAVE, so a self-hosted server that was up read as unreachable
   * (`cloud-probe-candidate-transport.test.ts`). The NO-CANDIDATE arm still reads `config.fetchImpl`
   * — it asks about the door this engine IS on, which belongs on that door's pinned connection.
   */
  const injectedFetch = config.fetchImpl;
  /* THE ONE SEAM. Everything this engine says to its server goes through the `fetchImpl` the
     bearer client, the mirror, the proxy and the wake channel are all handed — so pinning is done
     once, here, rather than at four call sites where the fifth would be the one that forgot. */
  const pinnedFetch = config.fetchImpl === undefined && (config.hostPin ?? "").trim() !== ""
    ? createHostFetch({
        origin: config.cloudUrl,
        pin: config.hostPin!.trim(),
        dataDir: config.dataDir,
        ...(config.log ? { log: config.log } : {}),
      })
    : undefined;
  if (pinnedFetch) config = { ...config, fetchImpl: pinnedFetch };
  const log = config.log;
  const now = config.now ?? ((): Date => new Date());

  /**
   * The server's base, canonicalized once — nothing below reads the raw value. Every URL is
   * `${base}${path}`, and the base is a string the WINDOW can choose (`engine_configure`), so a base
   * carrying a FRAGMENT turns concatenation into a different request — `http://host#/` + `/hello` is
   * `http://host#//hello`, the fragment is never sent, and `GET /` goes out instead (every route
   * collapses the same way). So the base is parsed and re-composed as scheme + host + path, so a
   * query, fragment or embedded credentials cannot survive into any request. A base that will not
   * parse REFUSES THE LAUNCH — continuing with the raw value is the hazard, and a default would
   * silently point the install at a server nobody chose.
   */
  const cloudBase = normalizeBase(config.cloudUrl);
  if (cloudBase === null) {
    throw new Error(
      "OHMAIL_CLOUD_URL is not a server address this engine can dial: it must be http or https, " +
        "with no query, fragment or embedded credentials.",
    );
  }

  // ── THE BOOT CLOCK — the same bracket `engine.ts` puts round its own constructor ─────────
  //
  // Started before `enforceMirrorOwner` because the shell is already showing "Opening your
  // mailbox" by then: the window waits on this whole function, so the total has to include the
  // mirror-owner check, and on a launch that DOES discard a foreign mirror it includes the delete.
  const tBoot = Date.now();

  // The mirror belongs to exactly one hosted account ON ONE SERVER; discard it whole if either has
  // changed. Run UNDER the data directory's lock and before the database opens — a second engine
  // is refused before it can remove a running one's seal or store (see {@link enforceMirrorOwner}).
  const opened: OpenLocalDb = await openLocalDb(config.dataDir, {
    ...(log ? { log } : {}),
    ...(config.onPhase ? { onPhase: config.onPhase } : {}),
    underLock: () => {
      enforceMirrorOwner(config.dataDir, config.address, cloudBase, log, {
        identityPending: config.identityPending !== undefined,
      });
    },
  });
  config.onPhase?.("preparing");
  try {
    const db = opened.db;
    const tWorld = Date.now();
    const world = await ensureLocalWorld(db, {
      address: config.address,
      ...(config.displayName ? { displayName: config.displayName } : {}),
      now: now(),
    });
    const session = await mintLaunchBearer(db, world, now());
    // One phase, both identity writes — see the same two lines in `engine.ts`.
    const worldMs = Date.now() - tWorld;

    /* THE MAILBOX THIS LAUNCH SERVES. A paired install has no address, so its world names no row
       and `ready` says "" — the window then waits for ever on a mailbox the mirror already holds.
       Named ONCE, when a mailbox list first gives this world a row, by the rule a relaunch applies
       (`ensureLocalWorld` again), and told to the shell before the pairing's answer goes out. */
    let served = world.mailboxId;
    const servedWaiters = new Set<() => void>();
    const nameServedMailbox = async (): Promise<void> => {
      if (served !== "") return;
      try {
        const again = await ensureLocalWorld(db, {
          address: config.address,
          ...(config.displayName ? { displayName: config.displayName } : {}),
          now: now(),
        });
        if (again.mailboxId === "" || served !== "") return;
        served = again.mailboxId;
        log?.("cloud_serving_mailbox", { mailboxId: served });
        await config.onServedMailbox?.(served);
      } catch (err) {
        log?.("cloud_serving_mailbox_failed", { err, reason: "the served mailbox could not be named; a relaunch names it" });
      } finally {
        if (served !== "") {
          for (const wake of servedWaiters) wake();
          servedWaiters.clear();
        }
      }
    };
    /** Resolves once a mailbox is served, or after `ms` — the caller answers with what there is. */
    const servedWithin = (ms: number): Promise<void> => {
      if (served !== "") return Promise.resolve();
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => { servedWaiters.delete(wake); resolve(); }, ms);
        timer.unref?.();
        const wake = (): void => { clearTimeout(timer); resolve(); };
        servedWaiters.add(wake);
      });
    };

    // ── TOKENS: SEALED WINS OVER ENVIRONMENT, THE SAME PRECEDENCE THE IMAP CREDENTIAL FOLLOWS ──
    //
    // A durable key lets a rotated token pair be sealed to disk, so a later launch resumes with no
    // token in its environment. Without a key, tokens live for this launch only and the shell must
    // pass one every time — the honest degradation, identical to the IMAP no-key case.
    const ring = config.keks ?? {};
    const versions = Object.keys(ring).map(Number).filter((v) => Number.isInteger(v) && v >= 1);
    const keyProvider: KeyProvider | undefined = versions.length > 0 ? new StaticKeyProvider(ring) : undefined;
    /* The pending door's claim hands its session to the relaunch through the seal, so a pending
       launch with no key could adopt an account and keep no sign-in for it. Refused by name. */
    if (config.identityPending !== undefined && keyProvider === undefined) {
      throw new Error("OHMAIL_IDENTITY_PENDING needs OHMAIL_KEK: the first claim seals its session for the relaunch.");
    }
    const sealPath = join(config.dataDir, "cloud-tokens.seal");

    const sealed = keyProvider ? await loadSealedTokens(sealPath, keyProvider) : null;
    /* A SEAL ON DISK THAT THIS KEY CANNOT OPEN is the one seal fault a sign-in is owed for — the
       key ring changed or the file was damaged — and the dialog says so rather than greeting the
       person as a first run. Read before anything else can write the path. */
    const sealUnreadable = sealed === null && existsSync(sealPath);

    /**
     * THE AUTHED HALF, assembled from a token pair — at construction when there is one, and from
     * `POST /cloud/signin` when there is not.
     *
     * `null` is the pre-auth state and is the ONLY thing the signed-in checks below read, so there
     * is no second flag that could disagree with it.
     */
    interface Authed {
      auth: CloudAuth;
      mirror: CloudMirror;
      proxy: WriteThroughProxy;
      /** The `/events` subscription that kicks the mirror per commit. See `cloud-wake.ts`. */
      wake: CloudWake;
    }
    let authed: Authed | null = null;
    /** Waiting drains by `since`/`limit`/`types`: a second drain on one cursor shares the first's wait. */
    const heldDrains = new Map<string, Promise<SyncResponse>>();

    /**
     * THE PKCE VERIFIER FOR A BROWSER HANDOFF — this process's memory, and the whole of where it
     * lives. See the file header for why it is here rather than on the sign-in body.
     *
     * `null` until `POST /cloud/signin/challenge` mints one. A second mint REPLACES it rather than
     * keeping both: the browser page a person is looking at is the last one that was opened, and
     * remembering an older commitment would only make a code from an abandoned page claimable.
     */
    let linkVerifier: string | null = null;

    /**
     * THE BROWSER APPROVAL this install is waiting on — the request id and the verifier, in this
     * process's memory only, beside `linkVerifier` and for its reason. A new request replaces it;
     * a claim that returned the pair, or a refusal that ended the request, clears it.
     */
    let approval: { id: string; verifier: string } | null = null;

    /**
     * THE ACCOUNT A PENDING ENGINE ADOPTED, or null — set by the first sign-in in the same
     * synchronous step that created the door file, so a second claim in this process meets it
     * (and the recorded owner) rather than a directory that still reads as nobody's.
     */
    let adoptedAddress: string | null = null;

    /**
     * WHAT THIS INSTALL IS, in the hosted device vocabulary — this process's own fact, read once
     * from the platform the binary runs on and carried on both sign-in paths so the hosted
     * account can name the install (`desktop-linux` / `desktop-macos` / `desktop-windows`).
     * `null` on a platform the vocabulary has no word for: the declaration is then omitted and
     * the hosted side keeps its legacy reading. Never read from the bridge body, for the
     * verifier's exact reason.
     */
    const declaredDeviceKind = desktopDeviceKind(process.platform);

    /**
     * THE HOSTED SESSION'S READING, kept past a refusal's teardown so `/health` can name the cause
     * (`cloud-auth.ts`). `null` is no session — a first run, or a sign-out the person asked for.
     * `sessionExpired` is DERIVED from it (`refused` and nothing else), so no second flag can say a
     * session ended that the refresh door never refused.
     */
    let hostedSession: CloudSessionReading | null = null;
    /* EVERY WRITE GOES THROUGH HERE, so a window holding `GET /cloud/session/wait` hears each move
       (`session-watch.ts`); a bare assignment would be a reading no held question learns of. */
    const sessionWatch = createSessionWatch();
    const setHostedSession = (next: CloudSessionReading | null): void => {
      hostedSession = next;
      sessionWatch.moved();
    };
    /**
     * A pairing finished here and cannot take effect until this process is replaced. Set by a
     * `startOver` redeem, which seals the new world's session and stages the old mirror's discard —
     * a discard only the constructor can perform (`pgdata` is open here). Between that answer and the
     * relaunch every other reading is a LIE: `signedIn: false` alone renders the hosted PASSWORD
     * FORM for an account that does not exist, and `sessionExpired: true` (deliberately NOT set)
     * would say this machine is no longer paired — the opposite of what happened. So the state says
     * what it is. PROCESS-LOCAL and never read back: the on-disk flag is cleared by the launch that
     * acts on it, and a fresh process is by definition one where this window has passed.
     */
    let restartRequired = false;
    /**
     * The in-flight session-death teardown, retained so a shutdown that races it can wait.
     * `onSessionRefused` fires from inside a pull's own refresh and cannot await the teardown
     * (its stop() resolves only after that pull fails out — awaiting there is the deadlock),
     * so the teardown runs detached — and a `stop()` that found `authed` already null would
     * otherwise close the database under a mirror still draining its last page.
     */
    let sessionTeardown: Promise<void> | null = null;
    /**
     * THE HOSTED ACCOUNT WAS DELETED — latched by the session's `account_erased` refusal and
     * cleared only when a new session is activated. It outlives the teardown that discards the
     * seal, so `/health` keeps saying it after `authed` is gone; a relaunch holds no seal and
     * starts at sign-in, which is the truth then.
     */
    let accountErasedLatch = false;

    const activate = (tokens: CloudTokens): Authed => {
      // A NEW session is a new answer about its account: a sign-in after the card starts clean.
      accountErasedLatch = false;
      const auth = createCloudAuth({
        baseUrl: cloudBase,
        tokens,
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        ...(keyProvider ? { keyProvider } : {}),
        sealPath,
        now,
        ...(log ? { log } : {}),
        onSessionState: (reading, next) => {
          setHostedSession(reading);
          log?.("cloud_session_state", {
            state: reading.state, code: reading.code, attempt: next.attempt, retryInMs: next.retryInMs,
          });
          // BACK FROM A FAULT: the mirror's own backoff may be minutes long by now.
          if (reading.state === "live") authed?.mirror.kick();
        },
        onSessionRefused: (code) => {
          // The refresh door REFUSED; nothing this process can send will renew it. Tear down to the
          // pre-auth state (stop the pulls, drop the spent seal) so the window renders the sign-in
          // surface. Fire-and-forget: this fires from inside a pull's own refresh, and the
          // teardown's stop() resolves only after that pull fails out — awaiting is the deadlock.
          // A DELETED account takes the same teardown and latches first, so the window says so.
          if (code === ACCOUNT_ERASED) accountErasedLatch = true;
          log?.("cloud_session_renewal_failed", {
            code,
            reason: code === ACCOUNT_ERASED
              ? "the hosted account was deleted; the engine discards its session and asks the " +
                "hosted API nothing more, and the mail already here stays readable"
              : "the hosted API refused to renew the session; the engine returns to sign-in " +
                "and the mirror keeps serving what it holds",
          });
          sessionTeardown = signOut().catch(() => undefined).finally(() => {
            sessionTeardown = null;
          });
        },
      });
      setHostedSession(auth.session());

      const mirror: CloudMirror = createCloudMirror({
        db,
        world,
        auth,
        onMailboxes: nameServedMailbox,
        cursorPath: join(config.dataDir, "cloud-cursor.json"),
        ...(log ? { log } : {}),
        now,
        ...(config.pageLimit !== undefined ? { pageLimit: config.pageLimit } : {}),
        ...(config.pollIntervalMs !== undefined ? { pollIntervalMs: config.pollIntervalMs } : {}),
      });

      const proxy: WriteThroughProxy = createWriteThroughProxy({
        auth,
        mirror,
        ...(log ? { log } : {}),
        /* The catch-all relay must not carry the HOSTED sign-in ceremony to a server the person
           runs — see `HANDOFF_CLAIM_PATHS`. Computed from the same comparison the two route guards
           use, so all three agree by sharing a predicate rather than by three readings of it. */
        handoffForeign: baseIsForeign(cloudBase, config.handoffBase ?? MANAGED_CLOUD_BASE),
      });

      /**
       * THE PUSH CHANNEL, beside the poll it accelerates. The SIDECAR holds the stream — it is
       * the process with the session (`authedFetch`), and the webapp inside the desktop window
       * talks only to this local engine, which serves no `/events`. Every `sync` frame kicks
       * one bounded pull; with the stream refused (the hosted flag's default until the deploy
       * flips it) the mirror's own poll carries the door exactly as before this existed.
       */
      const wake = startCloudWake({
        auth,
        onWake: () => { mirror.kick(); },
        ...(log ? { log } : {}),
      });

      authed = { auth, mirror, proxy, wake };
      return authed;
    };

    const launchTokens = sealed ?? config.tokens;
    /* A PENDING LAUNCH HOLDS NO SESSION BY CONSTRUCTION: its account is the claim's answer, and a
       seal left here (a claim that crashed before its door was written) is replaced by that claim. */
    if (launchTokens && config.identityPending === undefined) {
      // FIRST LAUNCH: seal the environment token so no later launch needs one. Skipped without a
      // key, and skipped when a sealed pair already exists — which keeps this idempotent.
      if (!sealed && keyProvider) {
        await sealTokens(sealPath, keyProvider, launchTokens, now());
      }
      // NO IDENTITY ROUND TRIP HERE, and that is a decision rather than an omission. The mirror-owner
      // check the sign-in path runs (see `POST /cloud/signin`) would have to dial the hosted
      // service before this engine could serve anything, which would make a launch with no
      // network a launch with no mailbox — and reading your own mirrored mail offline is the
      // point of a mirror. It is safe to skip because a SEALED pair cannot be foreign: it is
      // written inside this data directory, and `enforceMirrorOwner` deletes it, above, in the
      // same breath as the mirror whenever that address changes. `config.tokens` is the same pair
      // arriving from the environment on a launch that has no seal yet, against a directory that
      // check has just adopted or emptied.
      activate(launchTokens);
    } else {
      if (sealUnreadable) setHostedSession({ state: "seal_failed", code: "seal_unreadable", since: now().toISOString() });
      // NOT A FAILURE. See the pre-auth section in this file's header: the engine serves
      // `/health` and `/cloud/signin`, and the shell renders a sign-in surface rather than an
      // error about a process that would not start.
      log?.("cloud_pre_auth", {
        reason: config.identityPending !== undefined
          ? "this door is waiting for a browser confirmation, and the first sign-in names its account"
          : "no session is sealed on this install and none was supplied, so the engine serves " +
            "the sign-in surface until one is established",
      });
    }

    const ctxFor = (accountId: string, userId: string | null, sessionId: string | null): ServiceContext => ({
      db,
      accountId,
      userId,
      sessionId,
      now,
      requestId: "",
      ip: "",
      userAgent: undefined,
      origin: undefined,
    });

    /**
     * DROP THE HOSTED SESSION — the bridge-reachable half of signing out.
     *
     * Three things, and deliberately not a fourth. The poll stops, the sealed pair is removed, and
     * the engine returns to the pre-auth state it launches in. **The mirror is left exactly where
     * it is.** A door switch freezes the directory it leaves rather than deleting it: the mail is
     * still on the hosted account, and a mirror thrown away here is a full re-pull the next time
     * somebody signs back in — for no gain, since nothing can be read out of it while signed out.
     */
    const signOut = async (): Promise<void> => {
      const live = authed;
      authed = null;
      // THE SPENT SEAL GOES FIRST — before the awaits, not after them. This teardown's tail
      // used to remove the seal after waiting out the mirror, and a sign-in completing inside
      // that window sealed a FRESH pair the old rmSync then deleted. Removing it up front is
      // safe in every ordering: these tokens are dead (or leaving) either way, and a crash
      // right after leaves a pre-auth launch, which is the correct next state.
      try {
        rmSync(sealPath, { force: true });
      } catch (err) {
        log?.("cloud_seal_removal_failed", {
          err,
          reason: "the sealed session could not be deleted; it is no longer used by this process " +
            "and a later sign-in overwrites it",
        });
      }
      // The wake next — a frame arriving mid-sign-out must not kick a pull into a mirror that
      // is being asked to leave — and the renewal clock with it.
      live?.auth.stop();
      live?.wake.stop();
      // AWAITED. A drain that outlived the sign-out would go on writing the previous account's mail
      // into a database this process has just declared signed out.
      await live?.mirror.stop();
      // AGAIN, after the mirror is out: a request that was mid-refresh when the early removal
      // ran can have PERSISTED its rotated pair between the two — a "signed out" answer with a
      // live seal that signs back in on relaunch. This second, serialized deletion runs when
      // nothing of the old session can write any more; and it can never eat a NEW sign-in's
      // seal, because `POST /cloud/signin` awaits `sessionTeardown` (every teardown is retained
      // there, the user-initiated one included) before it seals anything.
      try {
        rmSync(sealPath, { force: true });
      } catch {
        /* logged by the first attempt's arm if it matters; nothing of this session reads it */
      }
      log?.("cloud_signed_out", { mailboxId: served });
    };

    /**
     * THE PENDING DOOR'S ADOPTION, in one synchronous step so no other request in this process
     * sees half of it: the door file first (the commit — created once, refused when any door is
     * there), then the mirror-owner record when it names nobody. A record that fails to write is
     * logged and not fatal: the next launch records the account from the door. Null once adopted.
     */
    const adoptIdentity = (address: string, unowned: boolean): Response | null => {
      try {
        createAdoptedDoor(config.identityPending!.doorFile, config.cloudUrl, address);
      } catch (err) {
        const refusal = err instanceof DoorFileError
          ? err
          : new DoorFileError("door_not_saved", "ohmail could not save which account this install is for", err);
        log?.("cloud_door_write_failed", {
          err: refusal.underlying ?? refusal,
          reason: refusal.code === "door_changed"
            ? "a door was chosen while the browser confirmation was pending, so this claim is refused"
            : "the door file could not be created, so this claim is refused and nothing is sealed",
        });
        return json(
          { error: { code: refusal.code, message: refusal.message } },
          refusal.code === "door_changed" ? 409 : 500,
        );
      }
      if (unowned) {
        try {
          writeFileSync(
            join(config.dataDir, MIRROR_OWNER_FILE),
            encodeMirrorRecord(address, cloudBase, readMirrorAccount(config.dataDir)),
            { mode: 0o600 },
          );
        } catch (err) {
          log?.("cloud_door_write_failed", {
            err,
            reason: "the mirror-owner record could not be written; the next launch records it from the door",
          });
        }
      }
      adoptedAddress = address;
      log?.("cloud_identity_adopted", { changed: true });
      return null;
    };

    const handle = async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const path = url.pathname;

      // `/health` is public: a readiness probe carries no credential, exactly as the hosted host's.
      // `online` is the live mirror state — the shell polls this to tell "offline mirror" apart from
      // "slow first pull", the same distinction the ready frame's `online` records at launch. A
      // pre-auth engine is not online: there is no session to be reachable with.
      if (req.method === "GET" && path === "/health") {
        return json({
          ok: true,
          mode: "cloud",
          schemaTier: "mail",
          mailboxId: served,
          signedIn: authed !== null,
          online: authed !== null && authed.mirror.online(),
          // The reason `signedIn` is false, when the reason is the server ending the session
          // rather than nobody having signed in yet. The shell words its sign-in surface off it.
          sessionExpired: hostedSession?.state === "refused" && hostedSession.code !== ACCOUNT_ERASED,
          // Where the session stands and why — the dialog's cause and the rail's notice.
          session: hostedSession,
          // …and the OTHER reason it can be false: a pairing that has succeeded and is waiting for
          // a relaunch. See the declaration — without this the shell shows a password form or a
          // "no longer paired" card, and both are false statements about a pairing that worked.
          //
          // THE RECORD IS THE AUTHORITY AND THE FLAG IS THE FAST PATH. They agree by construction
          // today — a construction clears the stamp, so only the process that staged it can see one
          // — and they are OR-ed rather than one being trusted, because the question is about the
          // DIRECTORY's state and only the record can answer that. A flag alone would report an
          // in-flight discard as an ordinary signed-out engine the moment this process was not the
          // one that staged it.
          restartRequired: restartRequired || readMirrorDiscardPending(config.dataDir),
          /* IS THIS INSTALL'S SIGN-IN ON DISK. A rotation whose seal could not be written leaves a
             session that works until the quit and a next launch with no credential — reported here
             as a state so the account pane can say it, rather than as a log line nobody reads.
             `true` before any rotation and on an install with no key, which is honest: there is no
             refused write. The reason is the thrown value's CLASS, never its message. */
          sealed: authed === null ? true : authed.auth.sealState().sealed,
          sealFailure: authed === null ? null : authed.auth.sealState().reason,
          /* THE MIRROR'S OWN STOP. `online: false` alone reads as a network blip a later poll
             clears; this one says the hosted account was deleted and nothing more will arrive.
             The mail already here stays readable — signing out never deletes mail, and neither
             does this. */
          accountErased: accountErasedLatch || (authed !== null && authed.mirror.accountErased()),
          /* THE PENDING DOOR, and whether its claim has adopted an account yet. `adopted` means the
             door on disk now names that account and the window relaunches this engine behind it. */
          identityPending: config.identityPending !== undefined && adoptedAddress === null,
          adopted: adoptedAddress !== null,
        });
      }

      // Everything else requires the launch bearer: held in memory (`launch-bearer.ts`), and any
      // other token asks the same `resolveSession` the hosted chain runs.
      const header = req.headers.get("authorization");
      const token = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
      const decided = token ? session.decide(token, now()) : "refused";
      const core = decided === "refused" ? null
        : decided === "unknown" ? await resolveSession(db, token, now()) : decided.held;
      if (!core) return json({ error: { code: "unauthorized", message: "authentication required" } }, 401);

      // THE WINDOW'S SEARCH TIMINGS, into this log (`window-report.ts`); the bearer was read above.
      if (req.method === "POST" && path === WINDOW_SEARCH_PHASES_ROUTE) {
        return handleWindowSearchPhases(req, { authorized: async () => true, log: log ?? (() => undefined) });
      }

      /* THE WINDOW'S OWN REPORTS, into THIS log — the local engine's two doors, served here too.
         Unrouted, both fell to the relay, which refuses a `/local/*` path (`cloud_relay_refused`),
         so a paired window's failed pull and failed consent read reached no log at all. */
      if (req.method === "POST" && (path === WINDOW_SYNC_FAILED_ROUTE || path === WINDOW_CONSENT_READ_FAILED_ROUTE)) {
        const deps = { authorized: async () => true, log: log ?? (() => undefined) };
        return path === WINDOW_SYNC_FAILED_ROUTE
          ? handleWindowSyncFailure(req, deps)
          : handleWindowConsentReadFailure(req, deps);
      }

      /* THE WINDOW'S HELD QUESTION (`session-watch.ts`): answered the moment the session reading
         differs from the one it names, else at the hold bound with `changed: false`. Served before
         the signed-in check, because a refusal is exactly the move the window is waiting to hear. */
      if (req.method === "GET" && path === "/cloud/session/wait") {
        const held = heldReadingOf(url.searchParams);
        await sessionWatch.wait(() => sameReading(hostedSession, held));
        return json({ changed: !sameReading(hostedSession, held), session: hostedSession });
      }

      // Signing in, and signing out — both addressed to THIS process over the pipe the shell holds;
      // the password and code are exchanged for a token pair, sealed, and never seen again (the
      // shell composes no credential). The browser handoff's first half answers the CHALLENGE and
      // keeps the verifier here, so the code the browser mints is spendable only by this process;
      // it is refused once signed in. `/cloud/probe` is the self-hosted door's question about
      // somebody else's machine, asked here because the window's CSP is `connect-src 'none'`. It
      // takes a CANDIDATE origin deliberately: probing the configured base forced configuring first,
      // which runs `enforceMirrorOwner` and destroyed a whole mirror on a MISTYPED address. The cost
      // (a window can make this dial an origin it chooses) is bounded by `normalizeOrigin`. It uses
      // `/hello`, not `/health`, because only `/hello` names the product and flavor; behind the launch bearer.
      if (req.method === "POST" && path === "/cloud/probe") {
        let candidate: unknown = null;
        let wantFlavor: unknown = null;
        let wantPin: unknown = null;
        try {
          const parsed = (await req.json()) as { origin?: unknown; flavor?: unknown; hostPin?: unknown };
          candidate = parsed.origin ?? null;
          wantFlavor = parsed.flavor ?? null;
          wantPin = parsed.hostPin ?? null;
        } catch {
          /* No body, or not JSON: probe what this engine is configured for. */
        }
        if (candidate === null || candidate === undefined) {
          return probeCloudServer(cloudBase, config.fetchImpl ?? fetch);
        }
        if (typeof candidate !== "string") {
          return json(
            { error: { code: "invalid_request", message: "the origin to probe must be text" } },
            400,
          );
        }
        /* THROUGH THE DOOR'S OWN PARSE, which is the whole of the bound on what this route can be
           made to dial: https, or http on loopback, with no path, query, fragment or credentials.
           The `/api` is composed here rather than accepted, so the path is never the caller's. */
        const origin = normalizeOrigin(candidate);
        if (origin === null) {
          /* CLEARTEXT IS ITS OWN REFUSAL when the door asked for a paired desktop, because it is
             the one shape a person can produce by hand and reasonably expect to work: an address
             copied off a machine that serves plain HTTP. `normalizeOrigin` admits `http:` only on
             loopback, so a rejected `http://<something else>` is exactly that case and deserves
             the sentence rather than the general one about server addresses. */
          const raw = typeof candidate === "string" ? candidate.trim() : "";
          if (wantFlavor === "desktop-host" && /^http:\/\//i.test(raw)) {
            return json(
              {
                error: {
                  code: "invalid_request",
                  message:
                    "That address is not encrypted, so ohmail will not send your mail over it. " +
                    "Use the link that computer printed, which always names an encrypted address.",
                  details: { kind: "cleartext", target: raw },
                },
              },
              400,
            );
          }
          return json(
            {
              error: {
                code: "invalid_request",
                message:
                  "that is not a server address this app can open: it must be https (or http on " +
                  "this machine), with nothing after the host",
              },
            },
            400,
          );
        }
        /* ── THE PAIRED-DESKTOP ARM ─────────────────────────────────────────────────────────
           A desktop host is the one door whose certificate nothing can vouch for, so the probe
           has to establish the pin BEFORE it will speak to the address at all. Everything below
           happens with nothing configured — the whole reason this route takes a candidate — so a
           wrong link costs no mirror. */
        if (wantFlavor === "desktop-host") {
          const pin = typeof wantPin === "string" ? wantPin.trim() : "";
          /* AN ADDRESS NO CERTIFICATE CAN BE ISSUED FOR NEEDS THE FINGERPRINT. `originNeedsPin` is
             the pairing grammar's own predicate — the same one the phone applies — rather than a
             second IP test written here, so the two clients cannot disagree about which addresses
             are safe to pair with unpinned. */
          if (pin === "" && originNeedsPin(origin)) {
            return json(
              {
                error: {
                  code: "invalid_request",
                  message:
                    "That link does not carry the other computer's identity, and an address like " +
                    "this one cannot be checked without it. Print a fresh pairing code on that " +
                    "computer and paste the whole link.",
                  details: { kind: "no_pin", target: origin },
                },
              },
              400,
            );
          }
          if (pin !== "") {
            const url = new URL(origin);
            const seen = await probeHostPin({
              host: url.hostname.replace(/^\[|\]$/g, ""),
              port: url.port === "" ? 443 : Number(url.port),
              pin,
              /* WRITTEN INTO THE REAL DATA DIRECTORY, and this is a cache warm-up rather than a
                 commitment: nothing about the door is configured by a probe, and a leaf left here
                 for an address that is never chosen is a public certificate that the next pinned
                 connection either uses or replaces on its first verification failure. */
              dataDir: config.dataDir,
              ...(log ? { log } : {}),
            });
            if (!seen.ok) {
              return json(
                {
                  error: {
                    code: "cloud_probe_failed",
                    message: seen.message,
                    details: {
                      kind: seen.code === "pin_changed" ? "pin_mismatch" : seen.code,
                      target: origin,
                    },
                  },
                },
                502,
              );
            }
            /* AND THE GREETING IS FETCHED OVER THE PINNED CONNECTION, not an ordinary one. Proving
               the key and then asking the question over a connection that did not check it would
               be answering about whatever holds the address now. */
            const pinned = createHostFetch({
              origin, pin, dataDir: config.dataDir, ...(log ? { log } : {}),
            });
            const said = await probeCloudDoor(origin, injectedFetch ?? pinned);
            return refuseUnlessDesktopHost(said, origin);
          }
          return refuseUnlessDesktopHost(await probeCloudDoor(origin, injectedFetch ?? fetch), origin);
        }

        /* THE ORIGIN, NOT A BASE — `probeCloudDoor` decides whether the API is at the root or
           under `/api` from the server's own greeting, not from anything this window could know.
           AND IT DIALS WITH THE OPERATOR'S OWN CA, read from the data folder at THIS MOMENT: the
           candidate is somebody's own server and usually issues its own certificates, whose trust
           used to arrive only as `NODE_EXTRA_CA_CERTS` at launch — which a process already running
           cannot be given, so an install moving to such a server probed with the previous door's
           trust and was refused for a reason nothing the person typed could fix. `probeTransport`
           falls back to the platform's `fetch` when no CA is installed, so a publicly-trusted
           server is dialled exactly as before. */
        return probeCloudDoor(origin, injectedFetch ?? probeTransport(config.dataDir, log));
      }

      if (req.method === "POST" && path === "/cloud/signin/challenge") {
        /* A browser hand-off only ever makes sense against the hosted service. Its other half is a
           PAGE, and the only page the shell can open is one whose address it owns — all ohmail.app's
           — so on a self-hosted base the sign-in surface would send the browser to OUR service, mint
           a code there, and claim it against the OPERATOR's server. And the claim carries the
           VERIFIER (`cloudSignIn` posts `{code, verifier}`), so it would hand a third party a
           complete account-takeover primitive for the person's HOSTED account from a screen that
           says "Sign in". REFUSED here rather than hidden in the window, whose wording is not a guard
           — an expired self-hosted session renders the shared hosted sign-in surface. */
        if (baseIsForeign(cloudBase, config.handoffBase ?? MANAGED_CLOUD_BASE)) {
          return json(
            {
              error: {
                code: "handoff_not_available",
                message:
                  "Signing in through a browser only works with the hosted ohmail service. On " +
                  "your own server, sign in with your password and authenticator code.",
              },
            },
            409,
          );
        }
        if (authed) {
          return json(
            { error: { code: "already_signed_in", message: "this install already holds a session" } },
            409,
          );
        }
        const pair = newDesktopLinkPair();
        linkVerifier = pair.verifier;
        // The CHALLENGE is a log-safe fact — it is the value that is about to travel in a URL —
        // and the verifier is not logged here or anywhere else. Neither is emitted as a field:
        // `challenge` is not on the allowlist, so writing it would be dropped rather than shown,
        // and a line that says a handoff was started is the whole of what an operator needs.
        log?.("cloud_link_challenge_minted", { mailboxId: served });
        return json({ challenge: pair.challenge });
      }

      /* THE ONE-CONFIRM SIGN-IN: ask the hosted service for a request this install can claim, and
         hand the window the id for the page's URL. The same two refusals the challenge has, for its
         reasons; the name the page shows is this machine's own hostname, never a bridge value. */
      if (req.method === "POST" && path === "/cloud/signin/approval") {
        if (baseIsForeign(cloudBase, config.handoffBase ?? MANAGED_CLOUD_BASE)) {
          return json(
            {
              error: {
                code: "handoff_not_available",
                message:
                  "Signing in through a browser only works with the hosted ohmail service. On " +
                  "your own server, sign in with your password and authenticator code.",
              },
            },
            409,
          );
        }
        if (authed) {
          return json(
            { error: { code: "already_signed_in", message: "this install already holds a session" } },
            409,
          );
        }
        const pair = newDesktopLinkPair();
        try {
          const started = await requestDesktopApproval(
            {
              baseUrl: cloudBase,
              label: hostname(),
              ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
              ...(log ? { log } : {}),
              ...(declaredDeviceKind ? { deviceKind: declaredDeviceKind } : {}),
            },
            pair.challenge,
          );
          approval = { id: started.approvalId, verifier: pair.verifier };
          log?.("cloud_approval_requested", { mailboxId: served });
          return json(started);
        } catch (err) {
          if (err instanceof CloudSignInError) {
            return json({ error: { code: err.code, message: err.message } }, err.status);
          }
          throw err;
        }
      }

      if (req.method === "POST" && path === "/cloud/signin") {
        // An expiry teardown may still be draining its last mirror request; its tail removes
        // the seal. Sealing a FRESH pair before that tail runs hands the new session to the
        // old teardown's rmSync — recovery looks successful until the next launch signs out
        // again. Waiting here is bounded by one in-flight request and one page apply.
        await sessionTeardown;
        if (authed) {
          return json(
            { error: { code: "already_signed_in", message: "this install already holds a session" } },
            409,
          );
        }
        let body: CloudSignInRequest;
        try {
          body = (await req.json()) as CloudSignInRequest;
        } catch {
          return json({ error: { code: "invalid_request", message: "the sign-in body is not JSON" } }, 400);
        }

        /* And the code itself is refused here, not only the ceremony that mints one. Guarding
           `/cloud/signin/challenge` stops this install STARTING a hand-off on a self-hosted door; it
           does not stop one being FINISHED, because the browser path also accepts a code typed in by
           hand, and a typed code came from the hosted service. Sent to an operator's server it is a
           live, spendable credential for the person's hosted account. So the CODE is refused,
           wherever it came from, on any base that is not the hand-off's own; a password sign-in is
           unaffected, since that credential belongs to the server being dialled. */
        /* PRESENT AT ALL, not "present and a non-empty string". The narrower test would have to
           agree with `cloudSignIn`'s own branch predicate (`trimmed(req.handoffCode) !== ""`, which
           yields "" for any non-string) across two files, and a later change to either — a coercion
           added there, a shape widened here — would separate them silently. Refusing on presence
           cannot diverge from anything, and it is the correct answer for every value: a request
           naming this field on a self-hosted door is a hand-off attempt whatever the field holds. */
        const namesHandoff =
          (body as { handoffCode?: unknown }).handoffCode !== undefined &&
          (body as { handoffCode?: unknown }).handoffCode !== null;
        if (namesHandoff && baseIsForeign(cloudBase, config.handoffBase ?? MANAGED_CLOUD_BASE)) {
          return json(
            {
              error: {
                code: "handoff_not_available",
                message:
                  "That code is an ohmail Cloud sign-in code and this install opens a server you " +
                  "run. Sign in with your password and authenticator code instead.",
              },
            },
            409,
          );
        }

        /* THE APPROVAL ARM: `{approval: true}` asks this install to poll the request it is holding
           once. The id and the verifier come from memory, never the body; a pending answer goes
           back to the window with the wait, and an approved one joins the tail below unchanged. */
        const namesApproval = (body as { approval?: unknown }).approval === true;
        if (namesApproval && baseIsForeign(cloudBase, config.handoffBase ?? MANAGED_CLOUD_BASE)) {
          return json(
            {
              error: {
                code: "handoff_not_available",
                message:
                  "Signing in through a browser only works with the hosted ohmail service. On " +
                  "your own server, sign in with your password and authenticator code.",
              },
            },
            409,
          );
        }
        if (namesApproval && !approval) {
          return json(
            { error: { code: "approval_expired", message: "This request has expired. Start again from your computer." } },
            410,
          );
        }

        let tokens: CloudTokens;
        try {
          if (namesApproval && approval) {
            const polled = await pollDesktopApproval(
              {
                baseUrl: cloudBase,
                verifier: approval.verifier,
                ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
                ...(log ? { log } : {}),
                ...(declaredDeviceKind ? { deviceKind: declaredDeviceKind } : {}),
              },
              approval.id,
            );
            if (polled.status === "pending") {
              return json(
                { status: "pending", retryAfterMs: polled.retryAfterMs, ...(polled.note ? { note: polled.note } : {}) },
                202,
              );
            }
            approval = null;
            log?.("cloud_approval_claimed", { mailboxId: served });
            tokens = polled.tokens;
          } else tokens = await cloudSignIn(
            {
              baseUrl: cloudBase,
              ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
              ...(log ? { log } : {}),
              // FROM THE BINDING ABOVE, NEVER FROM `body`. The verifier is an OPTION and not a
              // request field precisely so that this line is the only way one can reach the claim
              // — a caller over the bridge names the code and nothing else about how it is spent.
              ...(linkVerifier ? { verifier: linkVerifier } : {}),
              // FROM THE PROCESS, NEVER FROM `body`, for the verifier's reason: what platform
              // this install runs on is this process's own fact — see `declaredDeviceKind`.
              ...(declaredDeviceKind ? { deviceKind: declaredDeviceKind } : {}),
            },
            body,
          );
        } catch (err) {
          if (err instanceof CloudSignInError) {
            // A refused request is over: a new one starts from the window, never a retry of this.
            if (namesApproval && err.status === 410) approval = null;
            return json({ error: { code: err.code, message: err.message } }, err.status);
          }
          throw err;
        }
        // SPENT. The commitment it was made against belongs to a code that has just been consumed,
        // so keeping it would only mean a later handoff silently reusing a digest the browser has
        // already published. Cleared once the pair EXISTS — which is the moment the code was
        // burned — and not once the sign-in has been admitted below: a claim that FAILED did not
        // consume the code (the hosted side's binding is a predicate on the burn) and leaves this
        // line unreached, so the person whose browser is still showing that code can press the
        // button again, while a claim that succeeded and is then turned away at the mirror-owner check
        // has still spent it.
        linkVerifier = null;

        // One mirror, one account — the second enforcement point. `enforceMirrorOwner` settles a
        // LAUNCH but not a sign-in, which happens after the database is open: signing out leaves the
        // mirror, cursor and marker in place, so the next `POST /cloud/signin` can carry a DIFFERENT
        // account's credentials into an engine whose `world`, `db` and cursor are still the previous
        // account's. The comparison is against the mirror's RECORDED OWNER and the resolved HOSTED
        // identity — never `body.email` or the browser path's absent address, which would check the
        // attacker's own claim. The marker always equals `config.address` from a serving engine; the
        // fallback covers only a marker gone missing under a running engine.
        let hostedAddress: string;
        try {
          hostedAddress = await cloudIdentity(
            {
              baseUrl: cloudBase,
              ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
              ...(log ? { log } : {}),
            },
            tokens,
          );
        } catch (err) {
          // The same mapping the sign-in itself gets, and the same refusal: an identity that could
          // not be established is not a session. Nothing has been sealed and nothing activated.
          if (err instanceof CloudSignInError) {
            return json({ error: { code: err.code, message: err.message } }, err.status);
          }
          throw err;
        }
        const recordedOwner = readMirrorOwner(config.dataDir) ?? adoptedAddress ?? config.address;
        /* THE PENDING DOOR'S FIRST CLAIM is the one sign-in an owner nobody recorded is ADOPTED
           from: the account is the hosted service's answer above, never the person's typing. */
        const adopting = config.identityPending !== undefined && adoptedAddress === null;
        /* ── AN OWNER THAT CANNOT BE ESTABLISHED IS A REFUSAL, NOT AN ADOPTION ────────────────
           `null` here means neither the marker nor the configuration names an address, which is
           the PAIRED door's ordinary state — and a password sign-in is not that door's ceremony at
           all: it gets in with a pairing code, and its mailboxes are the host's answer. Letting an
           unestablishable owner fall through as a match would activate a hosted session over a
           directory holding a paired host's mail, which is the exact mixing this check exists to
           refuse. Every hosted and self-hosted door is unaffected: `config.address` is a string
           there, so the fallback always establishes one and this arm is unreachable. */
        if (recordedOwner === null ? !adopting : sameOwner(hostedAddress) !== sameOwner(recordedOwner)) {
          // Refused, and nothing is kept: the pair is not sealed and `activate` is not called, so
          // `authed` stays null and every read stays `409 not_signed_in` — no window in which this
          // session reaches the previous account's rows. The DISCARD is deliberately not done here:
          // removing `pgdata` under an open PGlite and rebuilding the world is what the constructor
          // already does, before the database opens. So this refuses and names the remedy, and the
          // shell re-points the door — a restart, the one code path that has always done this. One
          // discard, one place. The message never names the other account: somebody signing in with
          // their own credentials must not be told whose mail is on the machine.
          log?.("cloud_signin_owner_mismatch", { changed: true });
          return json(
            {
              error: {
                code: "mirror_owner_mismatch",
                message: adopting
                  ? "this computer holds the mail of a different ohmail account, so the browser " +
                    "cannot sign it in to this one; type the address of the account you want, and " +
                    "its mail replaces the other copy here"
                  : "this install is set up for a different ohmail account, so signing in here has " +
                    "to start that account's mail over from scratch",
              },
            },
            409,
          );
        }
        if (adopting) {
          const refused = adoptIdentity(hostedAddress, recordedOwner === null);
          if (refused) return refused;
        }

        // SEALED BEFORE THE MIRROR IS TOLD ABOUT IT, and after the mirror-owner check for the reason
        // above: a foreign pair must not be written into this account's directory even briefly. A
        // pair that could not be written to disk is a session that survives until the next quit and
        // then silently is not there — better to say so now, while the person who typed the
        // password is still looking at the app.
        if (keyProvider) await sealTokens(sealPath, keyProvider, tokens, now());
        /* THE PENDING ENGINE STOPS AT THE SEAL. Its world was built with no address, so its ready
           frame named no mailbox and it cannot mount mail; the window relaunches it behind the door
           just written, and that engine activates from this seal and runs the first drain. */
        if (config.identityPending !== undefined) {
          log?.("cloud_signed_in", { mailboxId: served });
          return json({ status: "signed_in", mailboxId: served, address: adoptedAddress, adopted: true });
        }
        const live = activate(tokens);
        log?.("cloud_signed_in", { mailboxId: served });
        // NOT AWAITED, and for the reason the launch path does not await it either: a first pull of
        // a real account takes a while, and a sign-in that appears to hang for it looks broken. The
        // mirror reports its own progress through `/health.online` and the next `/sync`.
        void live.mirror.start().catch((err: unknown) => {
          const fk = integrityLogFields(err);
          log?.("cloud_pull_failed", {
            err,
            constraint: fk.constraint,
            table: fk.table,
            reason: "the first pull after signing in did not complete; the mirror retries with backoff",
          });
        });
        return json({ status: "signed_in", mailboxId: served, address: config.address });
      }

      /**
       * `POST /cloud/pair-redeem` — the third way in. A pairing code printed by ANOTHER machine's
       * desktop, spent here for a bearer pair; it takes its shape from `/cloud/signin` because this
       * is the one process allowed to hold a credential for the configured server. The body carries
       * the TOKEN and nothing else — the origin is not the caller's to name (this engine dials what
       * it was configured for) and neither is the KIND (the platform is this process's own fact). It
       * is the THIRD enforcement point of one-mirror-one-account, for a host REINSTALLED at the same
       * address (same base, new world): the account it names is compared with the one recorded and a
       * disagreement is REFUSED, never merged — the remedy is the shell re-pointing the door.
       */
      if (req.method === "POST" && path === "/cloud/pair-redeem") {
        /* The pending door is ohmail Cloud's; a pairing code opens another computer's door, which
           the shell configures on its own. Refused before anything is spent. */
        if (config.identityPending !== undefined) {
          return json(
            {
              error: {
                code: "identity_pending",
                message: "this install is waiting for a browser confirmation for ohmail Cloud",
              },
            },
            409,
          );
        }
        // The expiry teardown's tail removes the seal; sealing a fresh pair before it runs hands
        // the new session to the old teardown's rmSync. `/cloud/signin`'s wait, for its reason.
        await sessionTeardown;
        if (authed) {
          return json(
            { error: { code: "already_signed_in", message: "this install already holds a session" } },
            409,
          );
        }
        let token: unknown;
        let startOver = false;
        try {
          const parsed = (await req.json()) as { token?: unknown; startOver?: unknown };
          token = parsed.token;
          /* THE EXACT BOOLEAN AND NOTHING ELSE. This flag DELETES somebody's mail, so a truthy
             value that nobody deliberately wrote — a string, a number, the word "false" — must not
             select it. Absent is the ordinary pairing, which is the safe branch. */
          startOver = parsed.startOver === true;
        } catch {
          return json({ error: { code: "invalid_request", message: "the pairing body is not JSON" } }, 400);
        }
        if (typeof token !== "string") {
          return json(
            { error: { code: "invalid_request", message: "the pairing code must be text" } },
            400,
          );
        }
        /* A staged discard is not done until a relaunch has done it — the hole the account
           comparison cannot see: a `startOver` stamps the record with the NEW account, so from that
           moment `accountIsForeign` compares B against B and answers no. An ordinary redeem in that
           window would fall through to `activate()` and serve the new account's session over the OLD
           account's `pgdata`, still on disk because the discard has not run — the exact mixing every
           guard here refuses. REFUSED before the token is spent, so a single-use code is not burned
           to say "restart". A `startOver` is exempt: it replaces this world rather than joining it. */
        if (!startOver && readMirrorDiscardPending(config.dataDir)) {
          return json(
            {
              error: {
                code: "restart_required",
                message:
                  "this install has finished pairing and is waiting to be restarted; quit ohmail " +
                  "and open it again, then pair from there",
              },
            },
            409,
          );
        }
        /* REQUIRED, unlike on the sign-in paths. An absent kind is read by the host as "web", so a
           desktop that omitted it appears in somebody's Devices pane as a browser — a false state
           shown on the screen where a person decides what to revoke. Refused by name instead. */
        if (!declaredDeviceKind) {
          return json(
            {
              error: {
                code: "unsupported_platform",
                message:
                  "this build cannot tell the other computer what kind of machine this is, and " +
                  "pairing without that would list it there as a browser",
              },
            },
            409,
          );
        }

        let redeemed: Awaited<ReturnType<typeof redeemPairingToken>>;
        try {
          redeemed = await redeemPairingToken(
            {
              baseUrl: cloudBase,
              deviceKind: declaredDeviceKind,
              ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
              ...(log ? { log } : {}),
            },
            token,
          );
        } catch (err) {
          if (err instanceof CloudSignInError) {
            return json({ error: { code: err.code, message: err.message } }, err.status);
          }
          throw err;
        }

        const recordedAccount = readMirrorAccount(config.dataDir);
        /* ── THE SECOND PRESS IS THE SAME HOLE, REACHED THE OTHER WAY ──────────────────────
           `accountIsForeign` compares the RECORD against the answer, and a start-over has already
           written the new account into the record — so a SECOND start-over during the window
           compares B against B, answers no, and falls through to the ordinary path, which seals
           and ACTIVATES over the previous world's `pgdata`. Exactly the mixing the ordinary-redeem
           guard above refuses, reached through the one path that guard deliberately exempts.

           So a pending discard is a second reason to take this arm, independent of whose account
           it is: while a discard is staged, no redeem of any kind may activate.

           `accountIsForeign` covers the UNNAMED answer too since the header stopped counting as a
           match, and it belongs on this arm: a start-over is somebody saying "replace what is
           here", so staging the discard is what they asked for either way. */
        if (startOver && (accountIsForeign(recordedAccount, redeemed.accountId)
          || readMirrorDiscardPending(config.dataDir))) {
          /* The way out of the refusal below, only ever taken on purpose. Without it the mismatch is
             a dead end: the constructor discards on a change of ADDRESS or SERVER, and a host
             reinstalled at the same address changes neither, so an install refused here stays refused
             with nothing to press. This is that press — the caller's explicit `startOver`, never an
             inference from the mismatch. THE DISCARD IS STAGED, not done: `pgdata` is open, so the
             record is stamped and the next launch performs it (`enforceMirrorOwner`); the pair sealed
             below is spared, because it belongs to the world being arrived at. NOTHING IS ACTIVATED —
             reads stay `409 not_signed_in` until the relaunch. */
          if (keyProvider) await sealTokens(sealPath, keyProvider, redeemed.tokens, now());
          writeFileSync(
            join(config.dataDir, MIRROR_OWNER_FILE),
            encodeMirrorRecord(config.address, cloudBase, redeemed.accountId, true),
            { mode: 0o600 },
          );
          restartRequired = true;
          log?.("cloud_pair_started_over", { changed: true });
          return json({
            status: "paired",
            restartRequired: true,
            mailboxId: served,
            address: config.address,
          });
        }
        const answer = accountAnswer(recordedAccount, redeemed.accountId);
        if (answer !== "admitted") {
          // REFUSED, AND NOTHING KEPT. The pair is not sealed and `activate` is not called, so
          // every read below stays `409 not_signed_in` — there is no window in which this session
          // reaches the previous world's rows. The DISCARD is deliberately not done here, for the
          // reason the sign-in's mismatch does not do it either: throwing a mirror away means
          // removing `pgdata` under an open database, which the constructor already does correctly
          // before anything is opened.
          //
          // TWO REFUSALS, because they are two facts and a person can act on only one of them. A
          // MISMATCH is another world at the same address and the way on is a deliberate start
          // over. UNNAMED is a host that sent no account header over a directory whose mail IS
          // bound to one: nobody can say whose this is, so it was admitted — the absence read as
          // agreement — and one world's session was served over another world's mail. The sentence
          // names the header that did not arrive, because that is the thing to go and fix.
          //
          // Neither message names an account. Somebody standing at this machine pairing with
          // their own computer must not be told whose mail is on it.
          if (answer === "unnamed") {
            log?.("cloud_pair_account_unnamed", { changed: true });
            return json(
              {
                error: {
                  code: "pair_account_unnamed",
                  message:
                    "that computer did not say which account this pairing belongs to, and this " +
                    "install already holds mail that belongs to one. Update ohmail on that " +
                    "computer and pair again, or start over from scratch here",
                },
              },
              409,
            );
          }
          log?.("cloud_pair_account_mismatch", { changed: true });
          return json(
            {
              error: {
                code: "pair_account_mismatch",
                message:
                  "this install already holds mail from a different account on that computer, so " +
                  "pairing again has to start over from scratch",
              },
            },
            409,
          );
        }

        // SEALED BEFORE THE MIRROR IS TOLD, and after the account check, for `/cloud/signin`'s
        // reasons exactly: a pair belonging to another world must not be written into this
        // directory even briefly, and a pair that could not reach the disk is a session that
        // silently is not there after the next quit.
        if (keyProvider) await sealTokens(sealPath, keyProvider, redeemed.tokens, now());
        /* THE BINDING IS WRITTEN ONLY WHEN THE HOST NAMED ONE. A composition that names no account
           leaves the field as it was rather than stamping `null` over a recorded id — "this answer
           carried no header" is not evidence about whose mail is here. */
        if (redeemed.accountId !== null) {
          const record = readMirrorRecordRaw(config.dataDir);
          const prior = record === null ? null : decodeMirrorRecord(record);
          writeFileSync(
            join(config.dataDir, MIRROR_OWNER_FILE),
            encodeMirrorRecord(prior?.address ?? config.address, prior?.base ?? cloudBase, redeemed.accountId),
            { mode: 0o600 },
          );
        }
        const live = activate(redeemed.tokens);
        log?.("cloud_paired", { mailboxId: served });
        // NOT AWAITED — a first pull takes a while and a pairing that appears to hang for it looks
        // broken. The mirror reports its own progress through `/health.online`.
        void live.mirror.start().catch((err: unknown) => {
          const fk = integrityLogFields(err);
          log?.("cloud_pull_failed", {
            err,
            constraint: fk.constraint,
            table: fk.table,
            reason: "the first pull after pairing did not complete; the mirror retries with backoff",
          });
        });
        /* …but its FIRST MAILBOX LIST is awaited, bounded: that list names the mailbox this launch
           serves, and the shell has recorded it before this answer arrives, so the window's status
           read after the pairing names the mail to open. Past the bound the answer goes anyway. */
        await servedWithin(config.pairServedWaitMs ?? PAIR_SERVED_WAIT_MS);
        return json({ status: "paired", mailboxId: served, address: config.address });
      }

      /* THE WINDOW'S TRY AGAIN — renew now rather than on the fault's own clock (the disk may
         have room again). Answers the reading it leaves; refuses nothing but a missing session. */
      if (req.method === "POST" && path === "/cloud/session/renew") {
        if (!authed) {
          return json({ error: { code: "not_signed_in", message: "there is no session to renew" } }, 409);
        }
        return json({ session: await authed.auth.renewNow() });
      }

      if (req.method === "DELETE" && path === "/cloud/session") {
        setHostedSession(null);
        const teardown = signOut();
        sessionTeardown = teardown.catch(() => undefined).finally(() => {
          sessionTeardown = null;
        });
        await teardown;
        return json({ status: "signed_out" });
      }

      // ── EVERYTHING ELSE NEEDS A HOSTED SESSION ─────────────────────────────────────────────
      //
      // Including the reads. After a sign-out the mirror still holds the previous account's mail,
      // and answering a read out of it would hand that mail to a window that holds no hosted
      // credential — access granted by the ABSENCE of one, which is the shape this refuses.
      if (!authed) {
        return json(
          {
            error: {
              code: "not_signed_in",
              message: "this install is not signed in to a hosted account yet",
            },
          },
          409,
        );
      }
      // Captured, not re-read: `authed` is written by `activate`, so TypeScript cannot keep a
      // narrowing across the awaits below and neither should a reader.
      const { proxy, mirror: liveMirror } = authed;

      if (req.method === "GET" && path === "/sync") {
        const since = url.searchParams.get("since") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined;
        const typesRaw = url.searchParams.get("types");
        const valid = new Set<string>(CLOUD_SYNC_TYPES);
        const types = typesRaw
          ? (typesRaw.split(",").map((t) => t.trim()).filter((t) => valid.has(t)) as EntityType[])
          : undefined;
        try {
          const ctx = ctxFor(core.accountId, core.userId, core.sessionId);
          const ask = (): Promise<SyncResponse> => syncService.getChanges(ctx, {
            since,
            ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
            ...(types && types.length > 0 ? { types } : {}),
          });
          let result = await ask();
          // A bootstrap (no cursor) never waits; a resumed drain with nothing new may.
          if (since !== undefined && since !== "0") {
            result = await drainOnFollowUp(heldDrains, JSON.stringify([since, limitRaw, typesRaw]), liveMirror, ask, result);
          }
          return json(result);
        } catch (err) {
          if (err instanceof ServiceError) {
            return json({ error: { code: err.code, message: err.message } }, err.httpStatus);
          }
          throw err;
        }
      }

      // THE FRESHNESS PROBE — the Freshness Contract's verdict for THIS mirror (INSTANT-ARCH
      // §6.6), served to the window so its "as of <time> · catching up" label is driven by the
      // stamp that actually ages: the WINDOW engine drains this process's local feed and is
      // always "current" relative to it, so its own stamp can never say the desktop is behind
      // the hosted account — this one can. `draining` rides along so a surface can tell "stale,
      // converging" from "stale, waiting for the next poll"; the label itself keys on `state`.
      if (req.method === "GET" && path === "/mirror/freshness") {
        return json({ ...liveMirror.freshness(), draining: liveMirror.draining() });
      }

      // THE ACCOUNT FIRST — a read row marked `accountFirst` (`/search`) relays to the account and
      // is answered from the mirror only while the account cannot be reached (`cloud-account-first.ts`).
      const first = matchReadRoute(req.method, path);
      if (first?.route.accountFirst) {
        return answerAccountFirst(req, first, {
          ctx: ctxFor(core.accountId, core.userId, core.sessionId),
          forward: proxy.forward,
          ...(config.accountFirstBoundMs !== undefined ? { boundMs: config.accountFirstBoundMs } : {}),
          ...(log ? { log } : {}),
        });
      }

      // THE LOCAL READ SURFACE — GET /messages/:id(+/body), /messages/bodies, /threads/:id,
      // /mailboxes, /tags, /rules, served from the mirror through read services alone.
      // The census over this file's expanded graph proves none of these handlers can reach the
      // IMAP adapter, the lease or the sync loop. The LIST route (`GET /messages`) is deliberately
      // NOT in the table — it is the reach-past door, a question about mail the mirror does not
      // hold — so it falls through to the proxy below; see `cloud-read.ts` at its former position.
      const read = matchReadRoute(req.method, path);
      if (read) {
        // Every read parameter names a uuid row. The API's door refuses a misshapen one with a
        // 400 before any query (`app.ts` `firstMisshapenParam`); this door says the same, rather
        // than letting the uuid column throw a plain error the window reads as a failed request.
        const bad = Object.keys(read.params).find((k) => !isUuid(read.params[k]));
        if (bad !== undefined) {
          return json({ error: { code: "validation_failed", message: `${bad} must be an id` } }, 400);
        }
        try {
          const answer = await read.route.handler(req, ctxFor(core.accountId, core.userId, core.sessionId), read.params);
          // THE ONE FACT THE MIRROR ADDS ABOUT SOMEWHERE ELSE. `GET /mailboxes` is served from
          // this database, so every number on those rows is a number about the COPY; a strip cannot
          // say how much of the account is here from a list whose halves both come from the same
          // store. `hostedCounts()` is what the mirror is draining toward, learned on
          // its own cadence (`cloud-mirror.ts`), and it travels under a field whose name says so.
          // Absent when the map has nothing for a row — never 0, which would claim an empty account.
          if (req.method === "GET" && path === "/mailboxes") {
            const counted = await decorateHostedCounts(answer, liveMirror.hostedCounts());
            // AFTER the counts: the overlay is the louder fact and must not be decorated away.
            return await decorateStoreStuck(counted, liveMirror.quarantined());
          }
          return answer;
        } catch (err) {
          if (err instanceof ServiceError) {
            /**
             * A body the mirror never held is a reach-past body — forward it, don't 404 it. The
             * reach-past list (`GET /messages`, forwarded above the table) hands the client rows the
             * mirror does not hold; opening one asks this route for its body, and the local read
             * honestly answers `not_found`. That is the one `not_found` that is not the end: the
             * hosted account holds the row and its body (or its `withheld` marker), so the ask
             * travels the same door the list did — a genuinely unknown id comes back as the hosted
             * 404. Scoped to the BODY read alone; every other local `not_found` stays a local 404.
             */
            if (err.code === "not_found" && req.method === "GET" && read.route.pattern === "/messages/:id/body") {
              return proxy.forward(req);
            }
            return json({ error: { code: err.code, message: err.message } }, err.httpStatus);
          }
          throw err;
        }
      }

      // EVERYTHING ELSE IS A WRITE (or an attachment/media byte read the mirror does not hold): the
      // mailbox is the hosted worker's, so it is forwarded to Cloud with the bearer. A 2xx that
      // echoes `X-Sync-Seq` waits for the mirror to pull that far before answering; offline ⇒
      // `503 offline_read_only`, and nothing is written locally.
      return proxy.forward(req);
    };

    // The same line the local door emits, from the door this install actually launched. Both are
    // needed: the two constructors share `openLocalDb` and nothing else, so a wait that shows up
    // on one and not the other is the difference between a database problem and an engine one.
    // See `engine.ts` for what the phases are and why they are one line.
    log?.("boot_phases", {
      pgliteOpenMs: opened.timings.pgliteOpenMs,
      adoptBaselineMs: opened.timings.adoptBaselineMs,
      migrateMs: opened.timings.migrateMs,
      compactMs: opened.timings.compactMs,
      searchSetupMs: opened.timings.searchSetupMs,
      // The same four the local door carries, for the reason the line itself is on both doors:
      // this door opens the same store, and the upgrade it waits for is the same upgrade.
      migrationsPending: opened.migrations?.pending ?? null,
      migrationsApplied: opened.migrations?.applied ?? null,
      slowestMigration: opened.migrations?.slowest?.migration ?? null,
      slowestMs: opened.migrations?.slowest?.ms ?? null,
      worldMs,
      totalReadyMs: Date.now() - tBoot,
    });
    /* THE SAME INSTRUMENT ON THIS DOOR, for the reason the line above it is on both: the two
       constructors share `openLocalDb` and nothing else, so a figure that shows up on one and not
       the other is the difference between a database cost and an engine one. This door runs a
       mirror rather than a mail pipeline, which makes it the closest thing to a control the
       measurement has. No-op when this install was given no logger. */
    const stopVitals = log
      ? startEngineVitals(log, { storeBytes: () => opened.storeBytes() })
      : () => { /* nothing to write to */ };

    return {
      db,
      world,
      servedMailboxId: () => served,
      sessionToken: session.token,
      handle,
      signedIn: () => authed !== null,
      online: () => authed !== null && authed.mirror.online(),
      mirrorDraining: () => authed !== null && authed.mirror.draining(),
      releaseHeld: () => sessionWatch.release(),
      async start() {
        // A pre-auth launch has nothing to pull. Not an error and not a no-op worth logging: the
        // engine already said so once, at assembly.
        await authed?.mirror.start();
      },
      async stop() {
        // The wake first, for `signOut`'s reason: no frame may kick a pull into a mirror that
        // is leaving — and the abort inside also frees a reader that would otherwise sit on an
        // idle stream past the shell's grace period.
        // FIRST: a reading taken during teardown would describe a process that has stopped
        // serving as though it were.
        stopVitals();
        sessionWatch.release();
        authed?.auth.stop();
        authed?.wake.stop();
        // THE AWAIT IS THE FIX. `opened.close()` hands PGlite a close that queues behind whatever
        // the mirror has already asked it to do, so closing while a drain was still enqueuing pages
        // meant the close waited on a walk that had no idea it should stop — past the shell's grace
        // period, and the process was killed instead of leaving. Now the drain is asked to stop and
        // this waits for it to be out of the database before the close is issued.
        await authed?.mirror.stop();
        // A session-death teardown that raced this shutdown already set `authed` null, so the
        // stop above matched nothing — but ITS mirror may still be draining its last page.
        // Wait for the teardown to be out of the database before the close is issued.
        await sessionTeardown;
        session.end();
        await opened.close();
      },
    };
  } catch (err) {
    // The lock and the PGlite instance must not survive a failed assembly.
    await opened.close();
    throw err;
  }
}
