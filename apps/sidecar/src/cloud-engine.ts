import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StaticKeyProvider, type KeyProvider } from "@trafficflow/core/mail";
import {
  resolveSession, syncService, ServiceError,
  type EntityType, type ServiceContext,
} from "@trafficflow/services/mail";
import { openLocalDb, type LocalDb, type OpenLocalDb } from "./db.js";
import { ensureLocalWorld, mintLaunchSession, type LocalWorld } from "./identity.js";
import {
  createCloudAuth, loadSealedTokens, sealTokens, type CloudAuth, type CloudTokens,
} from "./cloud-auth.js";
import { cloudSignIn, CloudSignInError, type CloudSignInRequest } from "./cloud-signin.js";
import { createCloudMirror, CLOUD_SYNC_TYPES, type CloudMirror } from "./cloud-mirror.js";
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
 *   · `GET  /health`        — public, and says `signedIn: false` so the shell can render the door;
 *   · `POST /cloud/signin`  — `{email, password, totp}`, the two-step hosted sign-in.
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
}

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
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The file recording which hosted address this cloud mirror was bootstrapped for. */
export const MIRROR_OWNER_FILE = "mirror-owner";

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
  const served = address.trim().toLowerCase();
  const ownerPath = join(dataDir, MIRROR_OWNER_FILE);
  const prior = existsSync(ownerPath) ? readFileSync(ownerPath, "utf8").trim().toLowerCase() : null;
  const foreign = prior !== null && prior !== served;
  if (foreign) {
    // The database, its cursor and the previous account's sealed session are all stale. Remove
    // them so the new account bootstraps from empty rather than inheriting a stranger's mail.
    for (const stale of ["pgdata", "cloud-cursor.json", "cloud-tokens.seal"]) {
      rmSync(join(dataDir, stale), { recursive: true, force: true });
    }
    log?.("cloud_mirror_reset_on_owner_change", { prior, served });
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(ownerPath, served, { mode: 0o600 });
  return foreign;
}

export async function createCloudSidecar(config: CloudSidecarConfig): Promise<CloudSidecar> {
  const log = config.log;
  const now = config.now ?? ((): Date => new Date());

  // The mirror belongs to exactly one hosted account; discard it whole if the served address has
  // changed. Must run before the database is opened — see {@link enforceMirrorOwner}.
  enforceMirrorOwner(config.dataDir, config.address, log);

  const opened: OpenLocalDb = await openLocalDb(config.dataDir);
  try {
    const db = opened.db;
    const world = await ensureLocalWorld(db, {
      address: config.address,
      ...(config.displayName ? { displayName: config.displayName } : {}),
      now: now(),
    });
    const session = await mintLaunchSession(db, world, now());

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
    }
    let authed: Authed | null = null;

    const activate = (tokens: CloudTokens): Authed => {
      const auth = createCloudAuth({
        baseUrl: config.cloudUrl,
        tokens,
        ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
        ...(keyProvider ? { keyProvider } : {}),
        sealPath,
        now,
        ...(log ? { log } : {}),
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

      authed = { auth, mirror, proxy };
      return authed;
    };

    const launchTokens = sealed ?? config.tokens;
    if (launchTokens) {
      // FIRST LAUNCH: seal the environment token so no later launch needs one. Skipped without a
      // key, and skipped when a sealed pair already exists — which keeps this idempotent.
      if (!sealed && keyProvider) {
        await sealTokens(sealPath, keyProvider, launchTokens);
      }
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
      live?.mirror.stop();
      try {
        rmSync(sealPath, { force: true });
      } catch (err) {
        log?.("cloud_seal_removal_failed", {
          err,
          reason: "the sealed session could not be deleted; it is no longer used by this process " +
            "and a later sign-in overwrites it",
        });
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
      if (req.method === "POST" && path === "/cloud/signin") {
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
            },
            body,
          );
        } catch (err) {
          if (err instanceof CloudSignInError) {
            return json({ error: { code: err.code, message: err.message } }, err.status);
          }
          throw err;
        }
        // SEALED BEFORE THE MIRROR IS TOLD ABOUT IT. A pair that could not be written to disk is a
        // session that survives until the next quit and then silently is not there — better to say
        // so now, while the person who typed the password is still looking at the app.
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
        await signOut();
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
      const { proxy } = authed;

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
          return await read.route.handler(req, ctxFor(core.accountId, core.userId, core.sessionId), read.params);
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

    return {
      db,
      world,
      sessionToken: session.token,
      handle,
      signedIn: () => authed !== null,
      online: () => authed !== null && authed.mirror.online(),
      async start() {
        // A pre-auth launch has nothing to pull. Not an error and not a no-op worth logging: the
        // engine already said so once, at assembly.
        await authed?.mirror.start();
      },
      async stop() {
        authed?.mirror.stop();
        await opened.close();
      },
    };
  } catch (err) {
    // The lock and the PGlite instance must not survive a failed assembly.
    await opened.close();
    throw err;
  }
}
