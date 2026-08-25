import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StaticKeyProvider, type KeyProvider } from "@trafficflow/core/mail";
import {
  resolveSession, syncService, ServiceError,
  type EntityType, type ServiceContext,
} from "@trafficflow/services/mail";
import { openLocalDb, type LocalDb, type LocalDbOpenPhase, type OpenLocalDb } from "./db.js";
import { ensureLocalWorld, mintLaunchSession, type LocalWorld } from "./identity.js";
import {
  createCloudAuth, loadSealedTokens, sealTokens, type CloudAuth, type CloudTokens,
} from "./cloud-auth.js";
import {
  cloudIdentity,
  cloudSignIn,
  CloudSignInError,
  desktopDeviceKind,
  newDesktopLinkPair,
  type CloudSignInRequest,
} from "./cloud-signin.js";
import { createCloudMirror, CLOUD_SYNC_TYPES, type CloudMirror } from "./cloud-mirror.js";
import { startCloudWake, type CloudWake } from "./cloud-wake.js";
import { matchReadRoute } from "./cloud-read.js";
import { createWriteThroughProxy, type WriteThroughProxy } from "./cloud-proxy.js";
import type { Diagnostic } from "./log.js";

/**
 * THE CLOUD ENGINE — a read-only mirror of a hosted account, assembled into the same stdio process
 * the shell already knows how to spawn.
 *
 * ── WHY THIS FILE EXISTS BESIDE `engine.ts`, AND WHAT IT DELIBERATELY LACKS ───────────────────
 *
 * `engine.ts` is the LOCAL organizer: an `ImapAdapter` against the user's own server, the organizer
 * lease in `@trafficflow/worker/lease`, and the shared sync loop in `@trafficflow/worker/sync`. In
 * Cloud mode the hosted worker is the single organizer, and this process must never become a
 * second one. That is not left to discipline: this module's transitive import graph reaches NONE of
 * those three — no IMAP adapter, no lease, no sync loop — and `test/cloud-engine-census.test.ts` is
 * a static census that fails the moment one of them enters the graph. The safe branch is selected
 * by construction, and `main.ts` refuses to start Cloud mode if any `OHMAIL_IMAP_*` is present at
 * all, so the IMAP path cannot be reached even by misconfiguration.
 *
 * What this engine does instead is pull (`cloud-mirror.ts`) over a bearer client (`cloud-auth.ts`)
 * and serve the Swift client three things: `/sync` and the full mail READ surface out of the local
 * mirror (`cloud-read.ts`), and a write-through proxy (`cloud-proxy.ts`) for everything else.
 *
 * ── THE SURFACE IS NOT A SECOND MIDDLEWARE CHAIN ──────────────────────────────────────────────
 *
 * The local organizer serves the full `packages/api` route table through the full middleware chain,
 * because it answers mutations locally. A Cloud-mode install owns no mailbox — the hosted worker
 * does — so it splits the surface: READS are served from the mirror it already holds, and every
 * WRITE (and the attachment/media byte reads the mirror does not hold) is FORWARDED to Cloud with
 * the bearer. The one gate that matters over stdio is a valid launch bearer (`resolveSession`, the
 * same primitive the hosted chain uses); the hosted API applies its own gates to the forwarded call.
 *
 * Reusing `packages/api`'s `createApp` (or its `localRoutes`) would drag the whole route table —
 * and with it the IMAP adapter the `/mailboxes`, `/attachments` and `/drafts` routes carry — into
 * this module's graph, which is exactly what the census forbids. So the read table is curated in
 * `cloud-read.ts` from read services alone, and the census over this file's expanded graph proves
 * it reaches no organizer module.
 *
 * ── THE WRITE-THROUGH ECHO, AND OFFLINE ───────────────────────────────────────────────────────
 *
 * A forwarded 2xx mutation echoes `X-Sync-Seq`; the proxy waits for the mirror to pull that far
 * before answering, so the client's immediate local `/sync` re-drain already holds its own write.
 * When a pull fails the mirror goes offline and the proxy answers `503 offline_read_only` writing
 * nothing locally — `online` rides `/health` and the ready frame so the shell can say which it is.
 *
 * ── SIGNED OUT IS A STATE THIS ENGINE SERVES, NOT A REASON TO REFUSE TO START ─────────────────
 *
 * A launch with no token pair — a fresh install that has just picked the hosted door, or one whose
 * session was cleared — used to be a startup failure. That is the wrong shape: the shell would show
 * "the engine did not start" to somebody whose only problem is that they have not signed in yet,
 * and the only way out was for the shell to obtain a token pair from somewhere it has no way to
 * reach. So this engine now comes up in a PRE-AUTH state and serves two things:
 *
 *   · `GET  /health`                   — public, and says `signedIn: false` so the shell can render
 *                                        the door;
 *   · `POST /cloud/signin/challenge`   — mint the PKCE pair for a browser handoff; answers the
 *                                        CHALLENGE and keeps the verifier here;
 *   · `POST /cloud/signin`             — `{email, password, totp}` or `{handoffCode}`.
 *
 * ── THE VERIFIER LIVES IN THIS PROCESS'S MEMORY AND NOWHERE ELSE ─────────────────────────────
 *
 * `POST /cloud/signin/challenge` is what makes a code safe to hand back over the `ohmail://`
 * scheme instead of through a person's fingers: it invents a PKCE pair, answers with the public
 * half, and holds the secret half in the binding below. The account binds the code the browser
 * mints to that digest, so a program that claims the scheme first receives a code it cannot spend.
 *
 * The verifier is a `let` in this closure — not a row, not a file, not a field on any response.
 * Three consequences, all deliberate:
 *
 *  · **It cannot be supplied from the wire.** `POST /cloud/signin` reads a body that has no
 *    verifier field at all; the claim is made with what this process is holding or with nothing.
 *    A caller that could name the verifier would be a caller that could spend an intercepted code.
 *  · **It dies with the engine.** A reconfigure REPLACES this process, so a handoff has to be
 *    started after the door is configured, not before. That is a real constraint on the window's
 *    ordering and it is written down in `doors.ts` where the ordering lives.
 *  · **It is cleared on a successful sign-in**, so a second handoff mints a second pair rather
 *    than reusing a commitment the browser has already published.
 *
 * Everything else answers `409 not_signed_in`. Deliberately NOT the mirror: after a sign-out the
 * mirror still holds the previous account's mail, and serving it to a signed-out window would be a
 * reader gaining access by the absence of a credential rather than by one.
 *
 * A successful sign-in seals the pair and TRANSITIONS IN PLACE — the same process, the same open
 * database, the same bridge — because a restart here would tear down the stdio host the window is
 * mid-request on. Only the authed half (`cloud-auth`, the mirror, the write-through proxy) is
 * assembled at that point, which is why it lives in {@link activate} rather than inline.
 *
 * ── SECRETS NEVER TRAVEL THROUGH THE SHELL ────────────────────────────────────────────────────
 *
 * The password and the code arrive over the same bridge every other request uses, addressed to this
 * process, and leave it as a sealed file. The shell composes no credential into the engine's
 * environment and holds none in its own state; what it holds is the per-install key the seal is
 * written under, which is the arrangement the IMAP password already uses.
 */

export interface CloudSidecarConfig {
  /** Where the local mirror lives. Created if absent; locked while open. */
  dataDir: string;
  /** The hosted API base, e.g. `https://api.ohmail.app`. */
  cloudUrl: string;
  /** The bearer/refresh pair the shell passes on FIRST launch. Absent on later launches (sealed). */
  tokens?: CloudTokens;
  /** The mailbox address this account mirrors — the local identity's address. */
  address: string;
  displayName?: string;
  /** The per-install key ring, for the token seal. Absent ⇒ tokens live in memory for this launch. */
  keks?: Record<number, Buffer>;
  log?: Diagnostic;
  now?: () => Date;
  /** Injected for tests; production dials the real hosted API. */
  fetchImpl?: typeof fetch;
  pageLimit?: number;
  pollIntervalMs?: number;
  /**
   * Told what the boot is about to spend its time on — the same narration, and the same consumer
   * (`main.ts` turning it into `phase` frames), as the local engine's. See `SidecarConfig.onPhase`.
   */
  onPhase?: (phase: CloudBootPhase) => void;
}

/** The cloud door's boot phases. Identical to the local door's: the two share `openLocalDb`. */
export type CloudBootPhase = LocalDbOpenPhase | "preparing";

export interface CloudSidecar {
  readonly db: LocalDb;
  readonly world: LocalWorld;
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
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * ADD THE HOSTED MESSAGE COUNT TO A LOCAL `GET /mailboxes` ANSWER, per mailbox that has one.
 *
 * The window's status strip needs two numbers to say how much of the account this device is
 * holding, and in Cloud mode only ONE of them is here: `cloud-read.ts` serves this list out of the mirror,
 * so everything on those rows is a fact about the copy. The other number is what the mirror is
 * draining toward, and `cloud-mirror.ts` learns it from the hosted `?counts=1` on a cadence of its
 * own (see `HOSTED_COUNTS_TTL_MS` — this function costs nothing and asks for nothing).
 *
 * `hostedMessageCount`, NOT `messageCount`. The latter is the shared DTO's field and means "how
 * much mail is in this mailbox" as answered by whoever was asked — so filling it from here would
 * make the strip compare the mirror against itself and read "N of N" for ever, and would put a
 * number about the hosted account into the field Settings renders as this install's own count. A
 * separate name is what keeps those two facts from being spent as one.
 *
 * ABSENT, NEVER ZERO. A mailbox the map has nothing for — the launch before the first counted
 * refresh, an account that answers no counts, a mailbox added since — is left exactly as the read
 * surface produced it. `0` would assert an empty account, which is the shape of lie the shell's
 * ladder is built to refuse: it would read as "this device is ahead of your account" and go
 * silent, or, with the comparison written the other way, announce a negative shortfall.
 *
 * A non-JSON or non-list body is passed through untouched: this is a decoration, and a decoration
 * that can fail a response is worse than one that quietly does nothing.
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

/** The file recording which hosted address this cloud mirror was bootstrapped for. */
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
 * The address this mirror was bootstrapped for, or null when the marker file is ABSENT.
 *
 * Written by {@link enforceMirrorOwner} at construction, so from the moment the engine is serving
 * it holds exactly the address the local world was built for and the reads are scoped by.
 *
 * A file that EXISTS AND IS EMPTY returns `""`, and the distinction is deliberate rather than
 * pedantic: absent means "this install predates the marker", which is adopted, and empty means "a
 * write of this marker was torn", which is an owner that cannot be established and must never be
 * read as a match. Collapsing the two would turn a crash between the discard and the rewrite into
 * the one thing this whole mechanism exists to refuse.
 */
export function readMirrorOwner(dataDir: string): string | null {
  const ownerPath = join(dataDir, MIRROR_OWNER_FILE);
  if (!existsSync(ownerPath)) return null;
  return readFileSync(ownerPath, "utf8").trim();
}

/**
 * ONE MIRROR, ONE ACCOUNT — enforced before the database is opened.
 *
 * The cloud mirror's directory is keyed by MODE, not by account: `src-tauri/src/config.rs`
 * derives `engine-cloud/` from the door alone and DELIBERATELY FREEZES it across a switch. And
 * `identity.ts`'s `ensureLocalWorld` reuses the single local `accounts` row for every address it
 * is ever asked for — the reads the shell issues scope by that one `accountId`. Put those two
 * facts together and re-pointing the cloud door at a DIFFERENT hosted address reopens a database
 * still holding the previous account's mail, under the very `accountId` the new session reads by,
 * so the previous account's messages render in the new account's Ohbox and Screener.
 *
 * That is not hypothetical. A mirror that had been bootstrapped against a different account's
 * mailbox went on rendering that account's messages after the door was re-pointed — a signed-in
 * account showing another mailbox's mail, which is the worst failure shape this product has.
 *
 * The mirror is a CACHE and the hosted account is master, so the only correct response to a
 * change of owner is to throw the cache away and re-bootstrap clean — never to reconcile two
 * accounts in one database. The sealed session and the sync cursor belong to the OLD account too,
 * so they are discarded with it; the next launch establishes a session for the new address and
 * bootstraps from `since=0`.
 *
 * ── AND IT IS NOT THE ONLY PLACE THE QUESTION IS ASKED ────────────────────────────────────────
 *
 * This settles a LAUNCH. It cannot settle a sign-in, which happens after the database is open and
 * against a mirror this function has already approved for a different address: `signOut` leaves
 * the mirror, the cursor and the marker where they are, so the next `POST /cloud/signin` may carry
 * another account's credentials. That handler therefore resolves the hosted identity from the
 * minted pair and compares it against the marker written here, and refuses rather than activating.
 * The DISCARD stays here — the only point at which the files can be removed without a live PGlite
 * holding them — and a refused sign-in sends the shell back through a door configure, which is a
 * relaunch, which is this function.
 *
 * Called BEFORE {@link openLocalDb}, so nothing holds the files being removed. Idempotent: a
 * launch whose owner matches — every ordinary relaunch — removes nothing and only rewrites the
 * same marker. An install that predates this marker (a `pgdata` with no owner file) is ADOPTED as
 * the current address rather than wiped: its owner is unknowable in retrospect, and the common
 * case is that it already belongs to the address now being served; the guarantee this makes is
 * forward — no future owner change can mix two accounts.
 *
 * @returns whether a foreign mirror was discarded — for the log line and the test, nothing reads it.
 */
export function enforceMirrorOwner(dataDir: string, address: string, log?: Diagnostic): boolean {
  const served = sameOwner(address);
  const ownerPath = join(dataDir, MIRROR_OWNER_FILE);
  const priorRaw = readMirrorOwner(dataDir);
  const prior = priorRaw === null ? null : sameOwner(priorRaw);
  const foreign = prior !== null && prior !== served;
  if (foreign) {
    // The database, its cursor and the previous account's sealed session are all stale. Remove
    // them so the new account bootstraps from empty rather than inheriting a stranger's mail.
    for (const stale of ["pgdata", "cloud-cursor.json", "cloud-tokens.seal"]) {
      rmSync(join(dataDir, stale), { recursive: true, force: true });
    }
    // Never the addresses. Which mailbox was served before and which is served now are the exact
    // identifying signal the sidecar log census exists to keep off the line — an operator needs to
    // know a foreign mirror was discarded, not whose it was. The event NAME carries the WHAT; the
    // one non-identifying fact worth a field is that a reset happened, and `prior`/`served` stay
    // local to the decision above.
    log?.("cloud_mirror_reset_on_owner_change", { changed: true });
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(ownerPath, served, { mode: 0o600 });
  return foreign;
}

export async function createCloudSidecar(config: CloudSidecarConfig): Promise<CloudSidecar> {
  const log = config.log;
  const now = config.now ?? ((): Date => new Date());

  // ── THE BOOT CLOCK — the same bracket `engine.ts` puts round its own constructor ─────────
  //
  // Started before `enforceMirrorOwner` because the shell is already showing "Opening your
  // mailbox" by then: the window waits on this whole function, so the total has to include the
  // mirror-owner check, and on a launch that DOES discard a foreign mirror it includes the delete.
  const tBoot = Date.now();

  // The mirror belongs to exactly one hosted account; discard it whole if the served address has
  // changed. Must run before the database is opened — see {@link enforceMirrorOwner}.
  enforceMirrorOwner(config.dataDir, config.address, log);

  const opened: OpenLocalDb = await openLocalDb(config.dataDir, {
    ...(log ? { log } : {}),
    ...(config.onPhase ? { onPhase: config.onPhase } : {}),
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
    const session = await mintLaunchSession(db, world, now());
    // One phase, both identity writes — see the same two lines in `engine.ts`.
    const worldMs = Date.now() - tWorld;

    // ── TOKENS: SEALED WINS OVER ENVIRONMENT, THE SAME PRECEDENCE THE IMAP CREDENTIAL FOLLOWS ──
    //
    // A durable key lets a rotated token pair be sealed to disk, so a later launch resumes with no
    // token in its environment. Without a key, tokens live for this launch only and the shell must
    // pass one every time — the honest degradation, identical to the IMAP no-key case.
    const ring = config.keks ?? {};
    const versions = Object.keys(ring).map(Number).filter((v) => Number.isInteger(v) && v >= 1);
    const keyProvider: KeyProvider | undefined = versions.length > 0 ? new StaticKeyProvider(ring) : undefined;
    const sealPath = join(config.dataDir, "cloud-tokens.seal");

    const sealed = keyProvider ? await loadSealedTokens(sealPath, keyProvider) : null;

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
     * WHAT THIS INSTALL IS, in the hosted device vocabulary — this process's own fact, read once
     * from the platform the binary runs on and carried on both sign-in paths so the hosted
     * account can name the install (`desktop-linux` / `desktop-macos` / `desktop-windows`).
     * `null` on a platform the vocabulary has no word for: the declaration is then omitted and
     * the hosted side keeps its legacy reading. Never read from the bridge body, for the
     * verifier's exact reason.
     */
    const declaredDeviceKind = desktopDeviceKind(process.platform);

    /**
     * TRUE from the moment the hosted API definitively refuses to renew the session (401/403 on
     * `/auth/refresh` — a revoked or rotated-past family) until the next successful activation.
     * `/health` carries it beside `signedIn`, so the shell can say "your session ended — sign in
     * again" instead of the plain first-run sign-in. The measured alternative was a desktop that
     * retried into 401s every five minutes for a day while its window showed week-old mail.
     */
    let sessionExpired = false;
    /**
     * The in-flight session-death teardown, retained so a shutdown that races it can wait.
     * `onSessionRefused` fires from inside a pull's own refresh and cannot await the teardown
     * (its stop() resolves only after that pull fails out — awaiting there is the deadlock),
     * so the teardown runs detached — and a `stop()` that found `authed` already null would
     * otherwise close the database under a mirror still draining its last page.
     */
    let sessionTeardown: Promise<void> | null = null;

    const activate = (tokens: CloudTokens): Authed => {
      sessionExpired = false;
      const auth = createCloudAuth({
        baseUrl: config.cloudUrl,
        tokens,
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        ...(keyProvider ? { keyProvider } : {}),
        sealPath,
        now,
        ...(log ? { log } : {}),
        onSessionRefused: () => {
          // The session is DEAD server-side; nothing this process can send will renew it. Tear
          // down to the pre-auth state (stop the pulls, drop the spent seal) so the window
          // renders the sign-in surface instead of a silently frozen mirror. Fire-and-forget:
          // this fires from inside a pull's own refresh, and the teardown's stop() resolves
          // only after that pull fails out — awaiting it here would be the deadlock.
          sessionExpired = true;
          log?.("cloud_session_renewal_failed", {
            reason: "the hosted API refused to renew the session (revoked or rotated past); " +
              "the engine returns to sign-in and the mirror keeps serving what it holds",
          });
          sessionTeardown = signOut().catch(() => undefined).finally(() => {
            sessionTeardown = null;
          });
        },
      });

      const mirror: CloudMirror = createCloudMirror({
        db,
        world,
        auth,
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
    if (launchTokens) {
      // FIRST LAUNCH: seal the environment token so no later launch needs one. Skipped without a
      // key, and skipped when a sealed pair already exists — which keeps this idempotent.
      if (!sealed && keyProvider) {
        await sealTokens(sealPath, keyProvider, launchTokens);
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
      // NOT A FAILURE. See the pre-auth section in this file's header: the engine serves
      // `/health` and `/cloud/signin`, and the shell renders a sign-in surface rather than an
      // error about a process that would not start.
      log?.("cloud_pre_auth", {
        reason: "no session is sealed on this install and none was supplied, so the engine serves " +
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
      // is being asked to leave.
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
      log?.("cloud_signed_out", { mailboxId: world.mailboxId });
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
          mailboxId: world.mailboxId,
          signedIn: authed !== null,
          online: authed !== null && authed.mirror.online(),
          // The reason `signedIn` is false, when the reason is the server ending the session
          // rather than nobody having signed in yet. The shell words its sign-in surface off it.
          sessionExpired,
        });
      }

      // Everything else requires the launch bearer — the same `resolveSession` the hosted chain runs.
      const header = req.headers.get("authorization");
      const token = header && /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, "").trim() : "";
      const core = token ? await resolveSession(db, token, now()) : null;
      if (!core) return json({ error: { code: "unauthorized", message: "authentication required" } }, 401);

      // ── SIGNING IN, AND SIGNING OUT ────────────────────────────────────────────────────────
      //
      // Both are addressed to THIS process over the pipe the shell already holds. The password and
      // the code are read here, exchanged for a token pair, sealed, and never seen again — the
      // shell composes no credential and stores none.
      // ── HALF ONE OF THE BROWSER HANDOFF: THE COMMITMENT ───────────────────────────────────
      //
      // Answers the CHALLENGE and keeps the verifier. The window passes the challenge to the shell,
      // which appends it to the `link-desktop` address it already owns — so the code the browser
      // mints is spendable only by this process, and the `ohmail://` link that carries it back is
      // worth nothing to whatever else on the machine may have claimed the scheme.
      //
      // Behind the same launch bearer as everything below, and refused once signed in for the
      // reason the sign-in itself is: there is nothing to hand off to an install that already
      // holds a session, and minting a commitment would leave a live code bound to a process
      // nobody is waiting on.
      if (req.method === "POST" && path === "/cloud/signin/challenge") {
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
        log?.("cloud_link_challenge_minted", { mailboxId: world.mailboxId });
        return json({ challenge: pair.challenge });
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
        let tokens: CloudTokens;
        try {
          tokens = await cloudSignIn(
            {
              baseUrl: config.cloudUrl,
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

        // ── ONE MIRROR, ONE ACCOUNT — THE SECOND ENFORCEMENT POINT ────────────────────────────
        //
        // `enforceMirrorOwner` runs at construction and settles the question for a LAUNCH. It
        // cannot settle it for a sign-in, because a sign-in happens after the database is open:
        // signing out leaves the mirror, the cursor and the marker exactly where they are (see
        // `signOut`), so the very next `POST /cloud/signin` can carry a DIFFERENT account's
        // credentials into an engine whose `world`, `db` and cursor are still the previous
        // account's — and `ctxFor(core.accountId, …)` would then serve that account's mail to this
        // session. Construction was one entry point too few.
        //
        // The comparison is against the mirror's RECORDED OWNER and the resolved HOSTED identity,
        // and neither of those is an input. `body.email` is what somebody typed and the browser
        // path sends no address at all, so a check against either would be a check against the
        // attacker's own claim; `cloudIdentity` asks the account instead. The marker is what
        // `enforceMirrorOwner` wrote for this data directory, and from a serving engine it always
        // equals `config.address` — the fallback covers only the impossible-in-practice case of a
        // marker that has gone missing under a running engine, where the address the local world
        // was actually built for is the honest thing to compare against.
        let hostedAddress: string;
        try {
          hostedAddress = await cloudIdentity(
            {
              baseUrl: config.cloudUrl,
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
        const recordedOwner = readMirrorOwner(config.dataDir) ?? config.address;
        if (sameOwner(hostedAddress) !== sameOwner(recordedOwner)) {
          // REFUSED, AND NOTHING IS KEPT. The pair is not sealed and `activate` is not called, so
          // `authed` stays null and every read below this stays a `409 not_signed_in` — there is
          // no window in which this session can reach the previous account's rows.
          //
          // The DISCARD is deliberately not done here. Throwing the mirror away means removing
          // `pgdata` out from under an open PGlite instance and rebuilding the world, the launch
          // session and every closure that captured them; the constructor already does all of it,
          // correctly, before the database is opened. So this refuses and names the remedy, and
          // the shell re-points the door — which restarts the engine and takes the ONE code path
          // that has always been able to do this. One discard, one place.
          //
          // The message never names the other account. Somebody standing at this machine signing
          // in with their own credentials must not be told whose mail is on it.
          log?.("cloud_signin_owner_mismatch", { changed: true });
          return json(
            {
              error: {
                code: "mirror_owner_mismatch",
                message:
                  "this install is set up for a different ohmail account, so signing in here has " +
                  "to start that account's mail over from scratch",
              },
            },
            409,
          );
        }

        // SEALED BEFORE THE MIRROR IS TOLD ABOUT IT, and after the mirror-owner check for the reason
        // above: a foreign pair must not be written into this account's directory even briefly. A
        // pair that could not be written to disk is a session that survives until the next quit and
        // then silently is not there — better to say so now, while the person who typed the
        // password is still looking at the app.
        if (keyProvider) await sealTokens(sealPath, keyProvider, tokens);
        const live = activate(tokens);
        log?.("cloud_signed_in", { mailboxId: world.mailboxId });
        // NOT AWAITED, and for the reason the launch path does not await it either: a first pull of
        // a real account takes a while, and a sign-in that appears to hang for it looks broken. The
        // mirror reports its own progress through `/health.online` and the next `/sync`.
        void live.mirror.start().catch((err: unknown) => {
          log?.("cloud_pull_failed", {
            err,
            reason: "the first pull after signing in did not complete; the mirror retries with backoff",
          });
        });
        return json({ status: "signed_in", mailboxId: world.mailboxId, address: config.address });
      }

      if (req.method === "DELETE" && path === "/cloud/session") {
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
          const result = await syncService.getChanges(ctxFor(core.accountId, core.userId, core.sessionId), {
            since,
            ...(limit !== undefined && !Number.isNaN(limit) ? { limit } : {}),
            ...(types && types.length > 0 ? { types } : {}),
          });
          return json(result);
        } catch (err) {
          if (err instanceof ServiceError) {
            return json({ error: { code: err.code, message: err.message } }, err.httpStatus);
          }
          throw err;
        }
      }

      // THE LOCAL READ SURFACE — GET /messages*, /threads/:id, /search, /mailboxes, /tags, /rules,
      // served from the mirror through read services alone. The census over this file's expanded
      // graph proves none of these handlers can reach the IMAP adapter, the lease or the sync loop.
      const read = matchReadRoute(req.method, path);
      if (read) {
        try {
          const answer = await read.route.handler(req, ctxFor(core.accountId, core.userId, core.sessionId), read.params);
          // THE ONE FACT THE MIRROR ADDS ABOUT SOMEWHERE ELSE. `GET /mailboxes` is served from
          // this database, so every number on those rows is a number about the COPY; a strip cannot
          // say how much of the account is here from a list whose halves both come from the same
          // store. `hostedCounts()` is what the mirror is draining toward, learned on
          // its own cadence (`cloud-mirror.ts`), and it travels under a field whose name says so.
          // Absent when the map has nothing for a row — never 0, which would claim an empty account.
          if (req.method === "GET" && path === "/mailboxes") {
            return await decorateHostedCounts(answer, liveMirror.hostedCounts());
          }
          return answer;
        } catch (err) {
          if (err instanceof ServiceError) {
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
      worldMs,
      totalReadyMs: Date.now() - tBoot,
    });

    return {
      db,
      world,
      sessionToken: session.token,
      handle,
      signedIn: () => authed !== null,
      online: () => authed !== null && authed.mirror.online(),
      mirrorDraining: () => authed !== null && authed.mirror.draining(),
      async start() {
        // A pre-auth launch has nothing to pull. Not an error and not a no-op worth logging: the
        // engine already said so once, at assembly.
        await authed?.mirror.start();
      },
      async stop() {
        // The wake first, for `signOut`'s reason: no frame may kick a pull into a mirror that
        // is leaving — and the abort inside also frees a reader that would otherwise sit on an
        // idle stream past the shell's grace period.
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
        await opened.close();
      },
    };
  } catch (err) {
    // The lock and the PGlite instance must not survive a failed assembly.
    await opened.close();
    throw err;
  }
}
