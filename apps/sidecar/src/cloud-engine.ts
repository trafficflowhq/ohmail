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
import {
  apiBaseFor,
  baseIsForeign,
  decodeMirrorRecord,
  encodeMirrorRecord,
  normalizeBase,
  normalizeOrigin,
  recordedBaseOfExisting,
  MANAGED_CLOUD_BASE,
  OPERATOR_CA_FILE,
} from "./cloud-origin.js";
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

function readMirrorRecordRaw(dataDir: string): string | null {
  const ownerPath = join(dataDir, MIRROR_OWNER_FILE);
  if (!existsSync(ownerPath)) return null;
  return readFileSync(ownerPath, "utf8");
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
 * ── AND THE OWNER IS AN ACCOUNT ON A SERVER, NOT AN ADDRESS ───────────────────────────────────
 *
 * `cloudUrl` is compared with the same force as the address, and for a reason the address alone
 * cannot cover: with a self-hosted door, `me@example.com` on the hosted service and
 * `me@example.com` on an operator's own machine are DIFFERENT ACCOUNTS spelled identically. The
 * address check reads them as the same owner and keeps the mirror; the reads are then scoped by an
 * `accountId` that belongs to neither in particular, and one server's mail renders under the
 * other's session. It is the same defect this function was written for, reached by moving a
 * different field.
 *
 * The discard is what closes the SESSION half too. `cloud-tokens.seal` holds a bearer minted by the
 * server being left, and a launch that kept it would send it to the server being arrived at — our
 * service's token to a machine somebody else runs, or an operator's to ours. It is already in the
 * list of things removed, so widening what counts as foreign is the entire fix; there is no second
 * place where a session has to be revoked, and deliberately no second enforcement point to keep in
 * step. See `cloud-origin.ts` for the one-sided default that keeps every existing install running.
 *
 * @returns whether a foreign mirror was discarded — for the log line and the test, nothing reads it.
 */
export function enforceMirrorOwner(
  dataDir: string,
  address: string,
  /** The base this launch is configured to dial — `CloudSidecarConfig.cloudUrl`. */
  cloudUrl: string,
  log?: Diagnostic,
): boolean {
  const served = sameOwner(address);
  /* NULL WHEN IT DOES NOT PARSE, never the raw value. A base that is not a URL cannot be compared
     with anything, so recording it would be recording a fact this file's own predicate must then
     ignore — and it would put an arbitrary string into the record for no reader. `null` says
     exactly what is true: this launch's server could not be established, so no future launch is
     told it disagreed with one. `baseIsForeign`'s one-sided default is the same answer. */
  const servedBase = normalizeBase(cloudUrl);
  const ownerPath = join(dataDir, MIRROR_OWNER_FILE);
  const priorRaw = readMirrorRecordRaw(dataDir);
  const priorRecord = priorRaw === null ? null : decodeMirrorRecord(priorRaw);
  const prior = priorRecord === null ? null : sameOwner(priorRecord.address);
  const addressChanged = prior !== null && prior !== served;
  /* A record that EXISTS and names no server was written by a build that could only dial one, so
     the absence is read as that one rather than as "cannot say" — see `recordedBaseOfExisting`,
     which carries the migration-launch leak that reading it the other way created. A record that
     does not exist is a fresh directory and is adopted, which is why this is only asked of one
     that does. */
  const serverChanged =
    priorRecord !== null && baseIsForeign(recordedBaseOfExisting(priorRecord.base), cloudUrl);
  const foreign = addressChanged || serverChanged;
  if (foreign) {
    // The database, its cursor and the previous account's sealed session are all stale. Remove
    // them so the new account bootstraps from empty rather than inheriting a stranger's mail.
    for (const stale of ["pgdata", "cloud-cursor.json", "cloud-tokens.seal"]) {
      rmSync(join(dataDir, stale), { recursive: true, force: true });
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
        : "this install has been pointed at a different server than the mirror was bootstrapped " +
          "against, so the mirror and the session sealed for the previous server are discarded",
    });
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(ownerPath, encodeMirrorRecord(served, servedBase), { mode: 0o600 });
  return foreign;
}

/** How long the door waits for a server to say hello. Short: somebody is watching a spinner. */
export const PROBE_DEADLINE_MS = 12_000;

/**
 * WHAT ANSWERED AT THE CONFIGURED ADDRESS — the self-hosted door's probe.
 *
 * Exported and pure-ish (the `fetch` is a parameter) so the classification below can be driven by
 * a test without a server, which matters more here than almost anywhere else in this file: every
 * branch is a SENTENCE somebody will read at the exact moment they are least able to guess.
 *
 * ── EVERY REFUSAL NAMES WHAT WAS TRIED ────────────────────────────────────────────────────────
 *
 * The base, in full, in every single message. An operator debugging their own server has to be
 * able to see that the app dialled `https://ohmail.example.com/api/hello` and not something else —
 * that one line answers "did it use the right port", "did it keep my scheme", "did it add the
 * `/api`", and it is the difference between a bug report and a fixed typo. The value is the
 * operator's OWN address, typed by them into this app, so there is nothing to withhold; the only
 * reason it does not go into the log is that the LOG is read by us and this sentence is not.
 *
 * ── THE PRIVATE-CA BRANCH IS THE ONE THIS WHOLE ROUTE EXISTS FOR ──────────────────────────────
 *
 * A self-host stack on a private name issues its own certificates — the shipped compose stack does
 * exactly that (`OHMAIL_TLS_INTERNAL=1` selects Caddy's local CA), and that is the RIGHT thing for
 * a name no public authority can validate. Node does not read the operating system's trust store:
 * it verifies against its own compiled-in root list, so a certificate from the operator's CA fails
 * with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` — measured against the running stack, where a default
 * `tls.connect` to `ohmail.test:443` threw exactly that and the same connection with
 * `NODE_EXTRA_CA_CERTS` pointed at the stack's exported root came back `authorized`.
 *
 * So the honest answer is a FILE, and the sentence names it. It is not "we could not connect", and
 * it is emphatically not an offer to skip verification: nothing in this app has a way to turn
 * certificate checking off, and adding one would hand every self-hoster's mail to whatever answers
 * on their network. Installing the CA is a step the operator performs once, on the machine, and
 * the sentence tells them where to put it.
 */
export async function probeCloudServer(cloudUrl: string, fetchImpl: typeof fetch): Promise<Response> {
  const base = cloudUrl.replace(/\/+$/, "");
  const target = `${base}/hello`;
  const refuse = (message: string, kind: string): Response =>
    json({ error: { code: "cloud_probe_failed", message, details: { kind, target } } }, 502);

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

  /* Everything here is the SERVER's own answer about itself and none of it is secret — it is what
     that address serves to anyone who asks. The door renders the flavor so somebody who typed our
     address into the self-hosted field can see what they actually reached. */
  return json({
    ok: true,
    target,
    flavor: typeof hello.flavor === "string" ? hello.flavor : null,
    needsSetup: hello.needsSetup === true,
    auth: hello.auth ?? null,
  });
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
export function describeProbeFailure(err: unknown, target: string): [message: string, kind: string] {
  const code = errorCode(err);
  if (code !== null && TLS_FAILURE_CODES.has(code)) {
    if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
      return [
        `${target} answered, but its certificate is for a different name. Use the address the ` +
          "certificate was issued for.",
        "tls_name",
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
 * The first transport code in a thrown value, down `cause` AND through `AggregateError.errors`.
 *
 * ── BOTH BRANCHES ARE LOAD-BEARING, AND THE SECOND ONE IS THE COMMON CASE ─────────────────────
 *
 * `fetch` never throws the real error. It throws `TypeError: fetch failed` and hangs the cause off
 * it, so a reader of the outer error alone classifies every failure — a wrong name, a refused port,
 * an untrusted certificate — as the same shrug. Measured against the running self-host stack with
 * its CA withheld: `TypeError(fetch failed)` → `cause: Error(code:
 * UNABLE_TO_GET_ISSUER_CERT_LOCALLY)`.
 *
 * And when a host resolves to more than one address — which is EVERY dual-stack server, so most of
 * them — undici tries them in turn and reports the lot as an `AggregateError`. That has no `code`
 * and no `cause`: the real errors are in `.errors`, and a walker that followed only `cause` would
 * fall off the end and report "unreachable" for a certificate problem it was holding. The
 * self-hosted door is exactly where that matters, because its whole value is saying WHICH thing
 * went wrong.
 *
 * The first code found wins. A mixed aggregate — say IPv6 refused and IPv4 untrusted — is a
 * judgement call either way; taking the first attempt's answer is at least the one the connection
 * would have used, and no ordering here could be right for every mix.
 */
function errorCode(err: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (cur: unknown, depth: number): string | null => {
    if (cur === null || cur === undefined || depth > 5 || seen.has(cur)) return null;
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    if ((cur as { name?: unknown }).name === "TimeoutError") return "TimeoutError";
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

export async function createCloudSidecar(config: CloudSidecarConfig): Promise<CloudSidecar> {
  const log = config.log;
  const now = config.now ?? ((): Date => new Date());

  /**
   * ── THE SERVER'S BASE, CANONICALIZED ONCE, AND NOTHING BELOW READS THE RAW VALUE ────────────
   *
   * Every URL this process composes is `${base}${path}`, and until this line the base was whatever
   * arrived in the environment. That is a string the WINDOW can choose: `engine_configure` is one of
   * the commands it holds, and the shell stores what it is given. So a base carrying a FRAGMENT
   * turns concatenation into a different request entirely — `http://host:port#/` + `/hello` is
   * `http://host:port#//hello`, and the fragment is never sent, so what actually goes out is
   * `GET /` at that address. Every one of `/auth/login`, `/sync` and the probe collapses the same
   * way. Raised by review of this slice, which is where the reach became a designed feature rather
   * than an unused capability, and the honest fix is at the seam rather than in one route: the base
   * is parsed and re-composed as scheme + host + path, so a query, a fragment and embedded
   * credentials cannot survive into any request.
   *
   * A base that will not parse REFUSES THE LAUNCH. Every other reading is worse: continuing with
   * the raw value is the hazard above, and falling back to a default would silently point somebody's
   * install at a server they did not choose — which on this door is the one thing that must never
   * happen quietly.
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
  // changed. Must run before the database is opened — see {@link enforceMirrorOwner}.
  enforceMirrorOwner(config.dataDir, config.address, cloudBase, log);

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
        baseUrl: cloudBase,
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
      // ── IS THERE AN OHMAIL SERVER AT THE ADDRESS THIS ENGINE WAS POINTED AT? ───────────────
      //
      // The self-hosted door's question, and the only one in this file whose answer is a fact
      // about somebody else's machine. The window cannot ask it — its CSP is `connect-src 'none'`
      // and `offline-guard.ts` replaces every API that could leave the process — so it has to be
      // asked here, by the process that already dials this server for everything else.
      //
      // ── IT TAKES A CANDIDATE ORIGIN, AND THAT IS A DELIBERATE WIDENING ────────────────────
      //
      // The first version probed only the CONFIGURED base, on the reasoning that a route dialling an
      // address out of the request would turn the one bridge the window is allowed into a
      // general-purpose request forwarder. Two things were wrong with that, both raised by review.
      //
      // THE REASONING DID NOT HOLD. `engine_configure` is also a command the window holds, so the
      // window could already choose the address and then ask this route what answered. The reach was
      // never bounded by where the value was read from — only by what the value may BE.
      //
      // AND THE ORDER IT FORCED WAS DESTRUCTIVE. Probing the configured base means configuring
      // first, and configuring for a different server runs `enforceMirrorOwner`, which discards the
      // previous mirror and its sealed session before the database opens. So a MISTYPED address
      // cost somebody their whole hosted mirror and a full re-sync — for a typo, before anything had
      // been proved, with Back offering no way to undo it. That contradicts what the door is for:
      // the address step exists precisely so that nothing is committed until the server has
      // answered.
      //
      // So the candidate is read from the body and the door probes BEFORE it configures anything.
      // What that costs, stated plainly rather than argued away: a window running hostile script can
      // make this process issue `GET <origin>/api/hello` for an origin it chooses, without a restart
      // between attempts. It is bounded — `normalizeOrigin` admits only https, or http on loopback,
      // with no path, query, fragment or credentials, and the path is always `/api/hello` — and it
      // is a cheaper version of something the window could already do. That trade buys removing a
      // real, reachable-by-accident data loss from every self-hoster's first attempt.
      //
      // ── `/hello` AND NOT `/health`, BECAUSE ONLY ONE OF THEM SAYS *WHAT* ANSWERED ───────────
      //
      // `/health` says a service is alive. `/hello` is the capability handshake and names the
      // product, the flavor (`selfhost` / `managed`), whether the install still needs its
      // first-run setup, and which sign-in methods it has. That difference is what lets the door
      // tell "nothing is there" from "something is there and it is not ohmail" — the second being
      // what an operator gets when they type the address of their router, their NAS, or the
      // machine they MEANT to install this on. Measured on both deployments: `flavor:"selfhost"`
      // from a stack at `https://ohmail.test`, `flavor:"managed"` from `https://api.ohmail.app`.
      //
      // BEHIND THE LAUNCH BEARER, like `/cloud/signin` and unlike `/health`. The bearer is minted
      // per launch and added SHELL-SIDE (`bridge-fetch.ts` never sees it), so requiring it costs
      // the door nothing — it is on the far end of the same pipe — and means nothing that is not
      // this window can make this process dial anything.
      if (req.method === "POST" && path === "/cloud/probe") {
        let candidate: unknown = null;
        try {
          candidate = ((await req.json()) as { origin?: unknown }).origin ?? null;
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
        return probeCloudServer(apiBaseFor(origin), config.fetchImpl ?? fetch);
      }

      if (req.method === "POST" && path === "/cloud/signin/challenge") {
        /* ── A BROWSER HAND-OFF ONLY EVER MAKES SENSE AGAINST THE HOSTED SERVICE ──────────────
           The ceremony's other half is a PAGE, and the only page the shell can open is one whose
           address it owns — all of them ohmail.app's. So on a self-hosted base the sign-in surface
           would send somebody's browser to OUR service, mint a code there, and then claim it
           against the OPERATOR's server.

           AND THE CLAIM CARRIES THE VERIFIER. `cloudSignIn` posts `{code, verifier}` to the
           configured base (`cloud-signin.ts`, the browser path), and that pair is exactly what is
           needed to spend the code at ohmail.app. So the ceremony would not merely fail on the
           wrong server — it would hand a third party a complete, two-minute account-takeover
           primitive for the person's HOSTED account, from a screen that says "Sign in". Raised by
           review, which found the path reachable through the reconnect surface after a self-hosted
           session expires.

           REFUSED HERE rather than hidden in the window, because the window's wording is not a
           guard: an install whose session expired renders the shared hosted sign-in surface for any
           cloud door. This makes the attempt impossible instead of unlikely, and names the path
           that does work. */
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

      // THE FRESHNESS PROBE — the Freshness Contract's verdict for THIS mirror (INSTANT-ARCH
      // §6.6), served to the window so its "as of <time> · catching up" label is driven by the
      // stamp that actually ages: the WINDOW engine drains this process's local feed and is
      // always "current" relative to it, so its own stamp can never say the desktop is behind
      // the hosted account — this one can. `draining` rides along so a surface can tell "stale,
      // converging" from "stale, waiting for the next poll"; the label itself keys on `state`.
      if (req.method === "GET" && path === "/mirror/freshness") {
        return json({ ...liveMirror.freshness(), draining: liveMirror.draining() });
      }

      // THE LOCAL READ SURFACE — GET /messages/:id(+/body), /messages/bodies, /threads/:id,
      // /search, /mailboxes, /tags, /rules, served from the mirror through read services alone.
      // The census over this file's expanded graph proves none of these handlers can reach the
      // IMAP adapter, the lease or the sync loop. The LIST route (`GET /messages`) is deliberately
      // NOT in the table — it is the reach-past door, a question about mail the mirror does not
      // hold — so it falls through to the proxy below; see `cloud-read.ts` at its former position.
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
            /**
             * A BODY THE MIRROR NEVER HELD IS A REACH-PAST BODY — forward it, don't 404 it.
             *
             * The reach-past list (`GET /messages`, forwarded above the table) hands the client
             * rows the local mirror does not hold; opening one asks THIS route for its body, and
             * the local read service honestly answers `not_found` because the message row is not
             * in the mirror. That is the one `not_found` that is not the end of the story: the
             * hosted account holds the row (it just listed it) and its stored body — or the
             * body's honest `withheld` marker — so the ask travels the same door the list did.
             * A genuinely unknown id costs one forwarded round trip and comes back as the hosted
             * 404, which is the same answer with better provenance. Scoped to the BODY read
             * alone: every other local `not_found` (a thread, a rule, a message row) stays a
             * local 404, because nothing hands the client those ids from beyond the mirror.
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
