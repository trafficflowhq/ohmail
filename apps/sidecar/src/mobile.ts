/**
 * The phone's composition root — the same engine, in the app's own runtime, over SQLite. `main.ts`
 * is the desktop twin; the differences are the file: no process to spawn (so no environment and no
 * frame codec — the engine is called IN-PROCESS and `handle(req)` is the seam), no PGlite or lock
 * file (the store arrives open through `SidecarConfig.store`), no `hostname()` (so `machineName` is
 * required), and no host or same-network door (this build must not contain the code for one). It is
 * NOT a second engine: `createSidecar` is imported and called once, so the drain loop, lease gate,
 * reconnect and `runSyncCycle` are the desktop's — a fork would be two implementations of "may this
 * install move a message". Host-mode knobs are REFUSED by name, not ignored (`phone-engine-boot.test.ts`).
 */
/**
 * `net` — THE ALIAS, and under Node the builtin, which is why the call below is optional.
 *
 * On a phone this specifier resolves to `apps/mobile/src/engine/shims/net.js`, the same module
 * instance the mail client's socket comes from, so this is the one place inside the artifact that
 * can hand the socket bridge the engine's own diagnostic. Node's `net` has no such export and the
 * optional call is simply not made — the shim's sink stays the no-op it starts as.
 */
import * as socketModule from "net";

import { and, asc, eq } from "drizzle-orm";
import { drizzle as drizzleSqliteProxy } from "drizzle-orm/sqlite-proxy";
/* The two tables a relaunch reads to find out where this mailbox lives. The barrel, like
   `engine.ts` — the device twin is substituted at the module the barrel itself reaches. */
import { mailboxCredentials, mailboxes, organizerDisplayName } from "@trafficflow/db";
import { brandDialect } from "@trafficflow/db/dialect";
import { migrateSqlite } from "@trafficflow/db/sqlite-migrate";
import type { LeasePeekAnswer, OrganizerKind, StandDownReason } from "@trafficflow/core/adapters/organizer-lease";
/* THE WORKER'S SOCKET PROFILE, not a third one. See {@link startPhoneEngine}. */
import { DEFAULT_NET_TIMEOUTS, WORKER_NET_TIMEOUTS } from "@trafficflow/core/adapters/imap";
/* The ceiling the consent door's look runs under, from the bound class the lease read itself uses
   — one ceiling per KIND of read, never a second number written here. `adapters/imap` re-exports
   `imap-bounds.ts` whole, so this is the leaf the line above already imports. */
import {
  ImapDeadline, IMAP_META_DEADLINE_MS, isImapBoundExceeded,
} from "@trafficflow/core/adapters/imap";
import type { ImapConfig, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  createSidecar,
  credentialsRefused,
  tlsRefused,
  type AdapterDialContext,
  type CredentialState,
  type OrganizerState,
  type MailboxConnectionState,
  type SidecarImapConfig,
} from "./engine.js";
import type { LocalDb, OpenLocalDb } from "./db.js";
/* A VALUE import now: {@link PhoneEngineDeps.logSink} builds the hardened logger HERE, in the
   artifact, rather than letting the app assemble log lines of its own. `log.ts` is this package's
   own funnel — the allowlist, the redaction and the value grammars come with it. */
import { createSidecarLog, describeMethod, describeRoute, type Diagnostic } from "./log.js";
/* `@trafficflow/core/mail` and NOT the default barrel, for the reason `engine.ts:6` and
   `log.ts:1` both give: the barrel is `export *` over twenty-odd modules and reaches the private
   half. Type-only here, so it erases — but a specifier a later edit turns into a value import
   would carry the whole barrel into a phone's artifact, and the census would be the only witness. */
import type { LogFields, Logger, LogLevel, LogSink } from "@trafficflow/core/mail";

/**
 * One statement at a time, one handle, rows as ARRAYS in the statement's column order — the shape
 * the phone's platform half implements and the node suite doubles. Three members carry a measured
 * rule: `all` returns rows as ARRAYS (`drizzle-orm/sqlite-proxy` maps positionally, and row OBJECTS
 * collapse two same-named columns into one key, filling both positions from one value with nothing
 * erroring); `batch` runs its statements in one transaction in one call (statement-by-statement is
 * ~90 ms/row, turning a 3.6 s drain into 17–22 s); and every call is SERIALIZED (the async driver
 * loses one of two overlapping read-modify-writes). Serializing each call is not enough — a
 * transaction spans separate `begin`/`commit` — so {@link oneTransactionAtATime} holds the mutex.
 */
export interface PhoneSqlRows {
  /**
   * The STATEMENT's column names, in its own order — not the keys of whatever the driver returned.
   *
   * Returned beside the rows rather than left implicit because two consumers need opposite shapes
   * from one call: `drizzle-orm/sqlite-proxy` maps POSITIONALLY and wants arrays, and the SQLite
   * migrator reads `select sqlite_version() as version` and `pragma compile_options` as OBJECTS.
   * An executor that answered only one of them would leave the other guessing, and the guess that
   * was written first — take element zero and hope — makes the capability check read version
   * "0.0.0" and refuse every store.
   */
  readonly columns: readonly string[];
  readonly rows: readonly unknown[][];
}

export interface PhoneSqlExecutor {
  /** Rows as arrays, in the statement's own column order, with those names. See the banner. */
  all(sql: string, params: readonly unknown[]): Promise<PhoneSqlRows>;
  /** A statement with no rows to return. */
  run(sql: string, params: readonly unknown[]): Promise<void>;
  /** All of these, in one transaction, in one call. Rolls back as a unit. */
  batch(statements: readonly { sql: string; params?: readonly unknown[] }[]): Promise<void>;
  /** Release the handle. Idempotent — shutdown paths call it more than once. */
  close(): Promise<void>;
}

/** What a phone hands the engine. Everything the desktop reads from its environment, as values. */
export interface PhoneEngineDeps {
  /** The ENGINE's store — a second SQLite file, never the UI mirror's. */
  exec: PhoneSqlExecutor;
  /** The user's own IMAP (and optionally SMTP) server. */
  imap: SidecarImapConfig;
  /** The mailbox address. Defaults to the IMAP username, as it does on every other door. */
  address?: string;
  /**
   * HOW THIS PHONE NAMES ITSELF in the claim it writes — required, and required for a reason a
   * default would hide. The holder line on somebody's desktop reads this string. A composition with
   * no name of its own has nothing true to put there, and the engine refuses rather than inventing
   * one (there is no `hostname()` here to fall back to).
   */
  machineName: string;
  /**
   * WHO THIS INSTALL IS TO THE LEASE — from the app's install marker, which rotates on a restore.
   * Never the store's own account id: a restored backup carries that id back and two installs
   * sharing one are coalesced by the lease into a single organizer nobody can see.
   */
  installId: string;
  /**
   * THE PER-INSTALL KEY RING, `version → 64 hex characters`. The desktop's `OHMAIL_KEK` contract as
   * a value rather than an environment variable; `apps/mobile/src/engine/kek.ts` produces it.
   *
   * ABSENT ⇒ nothing is sealed to disk at all and credential storage is REFUSED rather than
   * performed under a key that dies with the process. That is the engine's own rule and it is not
   * softened here.
   */
  keks?: Record<number, string>;
  /** What the phone calls itself in the claim's kind. `mobile`, and the default is not `local`. */
  organizerKind?: OrganizerKind;
  now?: () => Date;
  log?: Diagnostic;
  /**
   * Where a diagnostic line goes on this phone — the bytes' destination, and nothing else. A
   * phone's engine wrote NOTHING anywhere, because the app had no way to give it a channel: {@link
   * log} is a `Diagnostic` (composing `detail` objects), and the app composing them would be a
   * second logger outside every control `log.ts` exists for. So the app supplies a SINK — one
   * finished line in, nowhere out — and this builds {@link createSidecarLog} over it, with the field
   * allowlist, name-keyed redaction, value grammars, string bounds and `err` collapsing all carried,
   * byte-identical to the desktop's stderr line. {@link log} still WINS where a caller passes one.
   */
  logSink?: LogSink;
  /**
   * A nominal directory, for the few paths that name one in a log line. Nothing is created here and
   * nothing is read from here: the store arrives open and this build has no filesystem module.
   */
  dataDir?: string;
  /**
   * TEST SEAM — how a mailbox connection is opened. Production passes nothing and the engine dials
   * for real.
   *
   * It is here because {@link startPhoneEngine} now DIALS on its own, and a composition suite that
   * did not intercept the dial would open a socket to whatever host its fixture named. The suite
   * had been passing this all along and it was being dropped on the floor: the config assembled
   * below never carried it, so the file's own statement that "no socket is opened: the adapter is
   * a double" was false, and harmless only for as long as nothing started the engine.
   */
  adapterFactory?: (cfg: ImapConfig, ctx: AdapterDialContext) => MailboxAdapter;
}

/**
 * WHAT ASKING FOR THIS PHONE ANSWERED — three states, each with its own sentence and no `null`.
 *
 * `held` and `refused` are kept apart on purpose. A live foreign holder is the ORDINARY answer for
 * a phone whose mailbox a laptop is organizing: nothing is wrong, nobody needs telling, and the
 * watcher that asked will ask again. A `refused` is anything else the door said — a mailbox the
 * person removed, an unreadable row, a store fault — and it IS worth a sentence. Collapsing them
 * would put "we could not start organizing" under a chip that already says which machine has the
 * mailbox, once a minute, for as long as that machine keeps it.
 */
export type ClaimHereOutcome =
  /** The consent is recorded and the gate has been asked; this install organizes the mailbox. */
  | "claimed"
  /** A live foreign claim. The door refused, nothing was written, and no sentence is owed. */
  | "held"
  /**
   * THE DOOR COULD NOT SEE WHETHER ANYBODY HOLDS THE MAILBOX, so it wrote nothing.
   *
   * Its own word rather than `refused`, because the two want opposite sentences: `refused` is
   * something being wrong, and this is a look that did not land — the phone says so and the next
   * press asks again. It is also the answer that must never arrive as `claimed`: measured, a
   * folder the engine could not read left the door admitting the press, writing the consent and
   * the authorization, and reporting `claimed` for a mailbox nothing organized.
   */
  | "unreadable"
  /** The door said no for any other reason. The caller says so where a person can read it. */
  | "refused";

/**
 * WHAT THE PERSON'S STOP SETTLED — three answers, because a boolean collapsed two of them.
 *
 * `released` is the only one a caller may act on as "the mailbox has been let go": the claim is
 * out of `ohmail/_meta` and the row records the stop. Everything else leaves the mailbox
 * organized here, and a caller that tears down the notification over it is showing a false state.
 */
export type StopOrganizingOutcome =
  /** The claim is gone and the release is recorded. The notification may come down. */
  | "released"
  /** There was nothing of ours to give up — not a failure, and not a release either. */
  | "not_organizing"
  /** The route said no, or the cycle could not confirm the claim left the mailbox. */
  | "refused";

  /**
   * THE CONSENT PATH IN BOTH SPELLINGS — the phone's 409 keys on this, and it must key on the door
   * the presses actually use.
   *
   * `/local/` is optional and the id carries no slash, so `/mailboxes/x/organize/anything` is still
   * not this route. It used to match the shared spelling alone: the local door has always been on
   * this handle, and since {@link LOCAL_ORGANIZE_PATH} it is the only door a claim goes through. A
   * regex naming one spelling would leave the other a way past the one-organizer rule.
   */
const ORGANIZE_ROUTE = /^(?:\/local)?\/mailboxes\/([^/]+)\/organize$/;

  /**
   * ══ THE DOOR A CLAIM PRESSES, AND WHY IT IS NOT THE SHARED ONE ═════════════════════════════
   *
   * The shared route is `stepUp: true`, which on a standalone install is a permanent refusal:
   * `mintLaunchSession` stamps `lastTwofaAt` once at boot, so `withStepUp` answers 403 from five
   * minutes after launch for the life of the process. Measured on a device: 202 at +44 s, 403 at
   * +6 m 06 s and +14 m 30 s, and 29 re-claims over 4 m 24 s all 403 while the folder stayed empty.
   *
   * `engine.ts` answered this the same way: the window is right for the door it was written for.
   */
const LOCAL_ORGANIZE_PATH = (id: string): string =>
  `/local/mailboxes/${encodeURIComponent(id)}/organize`;

/**
 * THE VERB THIS PHONE DOES NOT HAVE. `POST /local/organizer/takeover` makes this install the
 * organizer of its own row whoever holds the mailbox — a desktop button, and on this handle it is
 * refused rather than forwarded. The refusal below is what makes "there is no takeover verb on
 * this phone" a fact about the door instead of a sentence about the app.
 */
const TAKEOVER_ROUTE = "/local/organizer/takeover";

/** `POST /mailboxes/:id/release` — the person's stop, as the row records it. */
const RELEASE_PATH = (id: string): string => `/mailboxes/${encodeURIComponent(id)}/release`;

/**
 * THE ORIGIN THE ENGINE COMPOSES ITS OWN REQUESTS AGAINST — a name that resolves nowhere.
 *
 * `handle` routes on the PATHNAME and the API's browser guards key on `Origin`/`Sec-Fetch-*`,
 * which an in-process request carries neither of. So this exists only because `new Request` needs
 * an absolute URL; nothing dials it and nothing may read it as an address.
 */
const SELF_ORIGIN = "http://engine.invalid";

/**
 * Who holds this mailbox, if it is not this install. The row's holder columns, as the gate's last
 * peek left them: `organizer_state` is `held` only while a claim in `ohmail/_meta` is still being
 * renewed, so it is LIVENESS, not the row's memory of a stand-down. `disabled_reason` is that
 * memory and outlives the holder, which is why it is not read here — a mailbox whose laptop has
 * gone away must not be refused to the phone in front of the person. A claim carrying OUR install
 * id is not foreign (own-role resumption after a crash or restore); a NULL stored id is a live
 * claim from a build that records no id, so it stays refused as another install.
 */
type RowHolderAnswer =
  /** A live foreign claim, as the last look left it. The fast path, and the only `held`. */
  | { readonly answer: "held"; readonly holder: { readonly name: string; readonly kind: string } }
  /** A look ANSWERED and named nobody this press has to yield to. */
  | { readonly answer: "free" }
  /**
   * THE COLUMNS CANNOT SAY. `organizer_state` NULL is two facts in one value — "nobody has ever
   * organized this mailbox" and "we have not looked" — and the schema says so in its own comment.
   * A door cannot tell them apart from the row, so it stops reading the row and looks.
   */
  | { readonly answer: "unknown" };

async function liveForeignHolder(
  db: LocalDb,
  mailboxId: string,
  ourInstallId: string,
): Promise<RowHolderAnswer> {
  const [row] = await db
    .select({
      role: mailboxes.organizerRole,
      state: mailboxes.organizerState,
      name: mailboxes.organizedByName,
      kind: mailboxes.organizedByKind,
      holderInstallId: mailboxes.organizedByInstallId,
    })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId))
    .limit(1);
  /* NO ROW is not a free mailbox — it is a mailbox this door knows nothing about, and the route
     behind it will answer for the id. `free` here would be a decision taken on an absence. */
  if (row === undefined) return { answer: "unknown" };
  /* AN ORGANIZER OF RECORD has already been through the gate for this mailbox; the press is a
     second becoming and the route answers it idempotently. Nothing to yield to and nothing to
     look up. */
  if (row.role !== "reader") return { answer: "free" };
  /* `stopped` IS AN ANSWER — somebody was organizing and nothing has renewed since, which is the
     gate's own `available`. Only NULL is the unlooked-at state. */
  if (row.state === null) return { answer: "unknown" };
  if (row.state !== "held") return { answer: "free" };
  if (row.holderInstallId !== null && row.holderInstallId === ourInstallId) return { answer: "free" };
  return { answer: "held", holder: { name: row.name ?? "", kind: row.kind ?? "" } };
}

/** What a phone gets back. `handle` is the seam the in-app client talks to. */
export interface PhoneEngine {
  /** `Request → Response` over the local API — the desktop's stdio door, called directly. */
  handle(req: Request): Promise<Response>;
  /** The per-launch bearer the in-app client must send. In memory only. */
  readonly sessionToken: string;
  /**
   * WHOSE MAILBOX THIS IS, in the engine's own words — `ensureLocalWorld`'s account row.
   *
   * The app's mirror is named by `(origin, accountId)`, so the id has to come from the thing that
   * serves the mail rather than from the app: a guessed one would key a second copy of this
   * mailbox on the same phone. Exposed because this door mounts no `/auth/session` for the app to
   * ask on, which is where every other door's client reads it.
   */
  readonly accountId: string;
  /** The mailbox this install serves, as the store holds it. The notification names it. */
  readonly address: string;
  /**
   * RE-DIAL EVERY DEAD CONNECTION NOW — call this when the app returns to the foreground.
   *
   * A phone's socket dies on every background. Without this the phone shows "organizing" and files
   * nothing until the next poll tick comes round, bounded on the desktop's own numbers at up to
   * 120 s. It restores a connection and lets the ordinary gated cycle decide what may happen on
   * it; it never drains, because draining over a connection whose lease has not been read is how
   * two installs organize one mailbox.
   */
  wake(): Promise<void>;
  /**
   * Hand the mailbox back — call this when the app leaves the foreground and cannot keep running.
   * The claim is removed from `ohmail/_meta`; the row is not touched, so a desktop or Cloud asked to
   * take the mailbox gets it honestly and at once, and this phone claims it back on the next gated
   * cycle after it returns (or stands down if somebody took it — neither half needs a press). One
   * entry per mailbox: a count of claims removed, `0` for "none of ours", `null` for "could not
   * look". NOT {@link stop}, which also gives the claim back and then closes the store — the
   * difference is that a hand-back leaves this install running, reading, and able to resume.
   */
  handBack(): Promise<readonly { mailboxId: string; released: number | null }[]>;
  /**
   * Take it back — call this when the app returns to the foreground after a {@link handBack}. It
   * asks the mailbox who holds it: free, and this install claims it again; held by a computer or
   * Cloud, and this install stands down and reads instead. Neither needs a press, and a resume can
   * never take a mailbox from a machine that has it. NOT {@link wake}, which restores a dead SOCKET
   * and runs no cycle — a hand-back left no socket problem, so a wake would find nothing to do and
   * the mailbox would stay unclaimed until the next poll tick, which `handBack` has cleared.
   */
  resume(): Promise<void>;
  /**
   * The person asked for this phone — the consent recorded and the claim taken now. A method
   * rather than a request the app composes, because the phone's privacy census admits a URL and a
   * transport in six named files and the app's organizer session is not one of them: the app
   * presses a verb, the engine's own door presses the route. Three answers, named by
   * {@link ClaimHereOutcome}; `held` is the point — a live foreign claim is refused AT THE DOOR,
   * so no caller can take a mailbox another machine is organizing.
   */
  claimHere(): Promise<ClaimHereOutcome>;
  /**
   * The person stopped — the half a relaunch can still read. {@link handBack} removes the claim but
   * leaves the ROW saying organizer, serving an app that left the foreground: the next resume takes
   * the mailbox back with no press. A person's stop is the opposite and needs the opposite
   * durability, surviving the app being killed, so it goes through the release ceremony the row
   * records: `release_requested_at`, honoured by the gate before the lease, writing the reader role
   * and `organizer_released_at`. The answer is the CYCLE's own reading, not the route's acceptance
   * — see {@link StopOrganizingOutcome}: a boolean left "the claim is gone" and "the server would
   * not let it go" both false, so a refused stop was reported as a success.
   */
  stopOrganizing(): Promise<StopOrganizingOutcome>;
  /**
   * DISCARD THE PASSWORD THIS LAUNCH SEALED — for the refusal the APP decides, not this one.
   *
   * The seal is written at attach, before anything dials, and the refusals this module decides
   * already remove it ({@link removeRefusedSeal}). A launch this module completed and the app then
   * could not record is the same state by a different road: a credential the store will let win
   * over the next press's corrected form. So the act is offered rather than left to a caller that
   * has no way to reach the store.
   */
  forgetStoredLogin(): Promise<boolean>;
  /** What each mailbox reports — the row's answer, not the gate's optimism. */
  runtimes(): { organizer: Record<string, OrganizerState>; connection: Record<string, MailboxConnectionState> };
  /**
   * THE ENGINE'S OWN HARDENED LOGGER, HANDED BACK OUT — the sink's return trip.
   *
   * The app supplies a SINK and may never build a logger ({@link PhoneEngineDeps.logSink}); this
   * is the half that was missing. `apps/mobile/src/engine/background.ts` decides what happens to
   * the mailbox at every app-state edge and its `log` seam was never wired, so every decline was
   * invisible in `adb logcat`. The caller names the event and the fields; THIS logger decides what
   * may be in the line. A no-op where the launch was given neither a `log` nor a sink. A PROPERTY
   * and not a method, so this package's log census does not read the declaration as a call site.
   */
  readonly log: Diagnostic;
  /**
   * Flush, give every claim back, and release. A phone whose engine is going down organizes
   * nothing, and a claim left to age out is `DEFAULT_STALE_AFTER_MS` in which the person's other
   * machine is refused a mailbox nothing is renewing. The ROW is untouched — a stop is not
   * {@link stopOrganizing}, which records a release the row remembers.
   */
  stop(): Promise<void>;
}

/**
 * One-click unsubscribe, refused by name — because on this build it cannot work and today fails as
 * a module error. The chain: `UnsubscribeService` posts through `pinnedHttpRequest` → `node:http`/
 * `node:https`, which on a phone are thrower stubs, so without this arm a tap gets a sentence about
 * a Node process. A refusal, NOT a half-wired pass-through: the `List-Unsubscribe` URL is the
 * SENDER's choice, the desktop refuses a LAN address, and its SSRF gate resolves DNS — also a
 * thrower here — so honouring the header safely needs a device resolver and a ruling, both the
 * door's own slice. It THROWS so the service records the attempt `failed`, does NOT retry
 * (at-most-once), and re-throws; NOTHING leaves the device, asserted by a control.
 */
export const phoneOneClickPost = {
  async post(_url: string, _pin: readonly string[]): Promise<{ status: number }> {
    throw new Error(
      "one-click unsubscribe is not available on this phone yet. The link a sender puts in an " +
        "unsubscribe header has to be checked before anything is sent to it — a link pointing " +
        "inside your own network must be refused — and that check is not built for this app yet. " +
        "Nothing was sent.",
    );
  },
};

/** The knobs that only mean something on a machine that serves a door to another device. */
const HOST_ONLY_KEYS = ["hostMode", "hostOrigin", "hostPort", "hostAssetsDir", "lanBind"] as const;

const KEK_HEX_RE = /^[0-9a-f]{64}$/i;

/**
 * HOW LONG A TRANSACTION MAY WAIT FOR THE ONE AHEAD OF IT BEFORE IT REFUSES BY NAME.
 *
 * Generous against any honest transaction on a device store — a drain page is milliseconds and the
 * slowest measured single-row write is about 90 ms — and short enough that the failure it exists to
 * name is diagnosable rather than a frozen screen.
 */
export const TRANSACTION_WAIT_MS = 30_000;

/**
 * No two transactions in flight on this store, ever — an install-wide mutex on `transaction`. Two
 * started in the same tick end with the first committed and the second DEAD ("cannot start a
 * transaction within a transaction"), carrying one writer's work, and it is reachable without a
 * second connection because the proxy issues `begin`, statements and `commit` as separate calls — a
 * per-STATEMENT queue does not make a TRANSACTION atomic. Not in the executor (it cannot see which
 * caller a statement belongs to) and not per-mailbox (an API request during a drain is the same
 * overlap), so it goes where every transaction funnels: the handle's `transaction` method. A
 * re-entrant `db.transaction` would deadlock, so the wait is bounded by {@link TRANSACTION_WAIT_MS}.
 */
export function oneTransactionAtATime<T extends object>(db: T, waitMs = TRANSACTION_WAIT_MS): T {
  const handle = db as T & {
    transaction?: (fn: unknown, config?: unknown) => Promise<unknown>;
  };
  const inner = handle.transaction;
  if (typeof inner !== "function") return db;
  let tail: Promise<unknown> = Promise.resolve();
  handle.transaction = function serialized(fn: unknown, config?: unknown): Promise<unknown> {
    let started = false;
    const run = tail.then(
      () => { started = true; return inner.call(handle, fn, config); },
      () => { started = true; return inner.call(handle, fn, config); },
    );
    // The CHAIN keeps the entry whatever the caller is told, and swallows so that one transaction's
    // failure does not reject the next caller's turn.
    tail = run.catch(() => undefined);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (started) return;   // it is running; a slow transaction is not this failure
        reject(new Error(
          "this store allows one transaction at a time, and this one waited " +
            `${waitMs} ms without its turn. The usual cause is a transaction opened on the ` +
            "database handle from INSIDE another transaction's body: a nested transaction must be " +
            "opened on the transaction object it is nested in, which the driver renders as a " +
            "savepoint, not on the handle — the handle's turn cannot come round until the outer " +
            "one returns.",
        ));
      }, waitMs);
      run.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (err: unknown) => { clearTimeout(timer); reject(err); },
      );
    });
  };
  return db;
}

/**
 * THE DEVICE STORE, BEHIND THE SERVER'S HANDLE TYPE — the one cast, and the migrator that runs
 * first.
 *
 * `migrateSqlite` before `drizzle`, in that order and through the same executor: the capability
 * check and `PRAGMA foreign_keys` are the migrator's, so a factory that did them itself would be a
 * factory the next factory does not copy. The journal is the DEVICE's, never the server's — the
 * server's is adopted by `db.ts`, which this bundle does not contain.
 */
export async function openPhoneStore(
  exec: PhoneSqlExecutor,
  /** TEST SEAM. Production takes {@link TRANSACTION_WAIT_MS}; a guard cannot wait thirty seconds. */
  transactionWaitMs = TRANSACTION_WAIT_MS,
): Promise<OpenLocalDb> {
  await migrateSqlite({
    run: async (statement: string): Promise<void> => { await exec.run(statement, []); },
    /* The migrator reads BY NAME (`version`, `compile_options`), so the positional rows are zipped
       back into objects with the statement's own column names. Zipped here rather than in the
       executor, because the executor must not know what any caller's columns mean — and read by
       name rather than by position because a `pragma` that grew a column would otherwise silently
       shift the one being read. */
    all: async <T,>(statement: string): Promise<T[]> => {
      const { columns, rows } = await exec.all(statement, []);
      return rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i]])) as T);
    },
  });

  const db = drizzleSqliteProxy(
    async (sql, params, method) => {
      if (method === "run") {
        await exec.run(sql, params as readonly unknown[]);
        return { rows: [] };
      }
      const { rows } = await exec.all(sql, params as readonly unknown[]);
      return { rows: method === "get" ? [...(rows[0] ?? [])] : rows.map((r) => [...r]) };
    },
    /* THE BATCH CALLBACK IS WHAT MAKES A TRANSACTION ONE CALL, and it is the SECOND argument —
       `drizzle(callback, batchCallback?, config?)`. Passed third (beside an `undefined` config) it
       is read as the config, which has no member in common with a function, and the store then
       issues `BEGIN`, the statements and `COMMIT` separately: any other work interleaving between
       them is the "cannot start a transaction within a transaction" refusal with one writer's rows
       lost. Measured against the driver's own overloads rather than assumed from the order the
       parameters are documented in. */
    async (queries): Promise<{ rows: unknown[] }[]> => {
      await exec.batch(queries.map((q) => ({ sql: q.sql, params: q.params as readonly unknown[] })));
      return queries.map(() => ({ rows: [] }));
    },
  );

  const branded = brandDialect(oneTransactionAtATime(db, transactionWaitMs), "sqlite") as unknown as LocalDb;
  return {
    db: branded,
    dataDir: "",
    pgDataDir: "",
    timings: { pgliteOpenMs: 0, adoptBaselineMs: 0, migrateMs: 0, compactMs: 0 },
    // A write-ahead checkpoint is a PGlite concept the engine calls after a drain. On this store the
    // journal is the platform's and there is nothing for a caller to reclaim, so this answers zero
    // rather than pretending to have flushed something.
    checkpoint: async () => 0,
    // THE CONTRACT'S DEFINED ANSWER FOR A RUNTIME WITH NO STORE HEAP, not a made-up figure:
    // `OpenLocalDb.storeBytes` documents `0` as exactly that. The desktop's number is the WASM
    // heap Postgres runs inside, and this store has none — SQLite is the platform's, on disk and
    // outside this process, so it contributes nothing to `rss` and there is no half to attribute.
    storeBytes: () => 0,
    /**
     * NOT SCHEDULED, said rather than implied. The desktop's two lanes sit in front of ONE PGlite
     * connection (`store-lanes.ts`); this store is the platform's SQLite behind `exec`, with its
     * own transaction gate above it (`oneTransactionAtATime`), and putting a second queue under
     * that gate without a rig that can measure the phone would be a change nobody has watched.
     */
    laneCensus: () => null,
    close: async () => { await exec.close(); },
  };
}

/**
 * A `Logger` over the phone's one Diagnostic — the inverse of `log.ts#diagnosticFor`.
 * `SidecarConfig` carries two faces of one channel: {@link Diagnostic} `(event, detail) => void`
 * with the level derived from the event, and `Logger` stating its level per line. The desktop
 * passes both faces of one logger; this composition passed only the `Diagnostic`, so `config.logger`
 * was absent and every `log?.warn`/`log?.error` in the shared sync loop optional-chained into
 * nothing — losing the lines that describe a write the mail server did NOT accept. With no second
 * sink this DERIVES the `Logger` face from the supplied `Diagnostic`; `child` MERGES (a returning
 * stub drops bindings), `level` is `info`, and `warn`/`error` carry the level in the FIELDS.
 */
export function loggerOver(log: Diagnostic, bound: LogFields = {}): Logger {
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    log(event, { ...bound, ...fields, level });
  };
  return {
    level: "info",
    child: (fields: LogFields): Logger => loggerOver(log, { ...bound, ...fields }),
    /* Below `level`. See the note above: the alternative is a line the logger's own filter says
       it did not emit. */
    debug: (): void => undefined,
    info: (event, fields) => { emit("info", event, fields); },
    warn: (event, fields) => { emit("warn", event, fields); },
    error: (event, fields) => { emit("error", event, fields); },
  };
}

/**
 * START THE ENGINE IN THIS RUNTIME. The phone's `main()`.
 *
 * @throws when a host-only knob is present, when `machineName` or `installId` is empty, or when a
 * key ring entry is not 64 hex characters. All three refuse BEFORE the store is touched: a
 * composition that is wrong about who it is should not have written anything.
 */
export async function startPhoneEngine(deps: PhoneEngineDeps): Promise<PhoneEngine> {
  const started = await composePhoneEngine(deps, deps.imap);
  /* Unreachable on this arm: the sealed read is the only thing that answers `no-credential`, and
     it is not consulted when a caller supplies a config. Stated rather than cast away. */
  if (started.kind === "no-credential") {
    throw new Error("a configured start cannot answer no-credential; the sealed read was not asked");
  }
  return started.engine;
}

/** What a sealed start answers. `no-credential` is a STATE, not a failure — see below. */
export type SealedStart =
  | { kind: "started"; engine: PhoneEngine }
  /** Nothing on this store says where this mailbox lives, so there is nothing to open. */
  | { kind: "no-credential" };

/** A sealed start's deps: every one of {@link PhoneEngineDeps} except the mailbox's own config. */
export type SealedPhoneDeps = Omit<PhoneEngineDeps, "imap" | "address">;

  /**
   * Start from what the last launch sealed — the phone's relaunch, and the desktop's shape. The form
   * that took the password exists once; every later launch has only the store, which holds both
   * halves: the sealed password (`resolveLogin` reads and decrypts it) and the coordinates it was
   * proved against. So this reads the COORDINATES — host, port, secure, user — and supplies no
   * password; nothing here decrypts anything. A store with no credential row answers `no-credential`
   * rather than starting, since an engine given an empty dial would come up, report a mailbox, and
   * authenticate to nothing.
   */
export async function startPhoneEngineFromSealed(deps: SealedPhoneDeps): Promise<SealedStart> {
  return composePhoneEngine(deps, null);
}

/**
 * THE ONE COMPOSITION, WITH OR WITHOUT A CONFIG — so the two entries cannot drift.
 *
 * `imap === null` means "read it off the sealed row", which is the only difference between a first
 * launch and a relaunch. Everything below this line is the same code either way, including the
 * refusals, which run BEFORE the store is touched.
 */
async function composePhoneEngine(
  deps: SealedPhoneDeps & { readonly address?: string },
  imap: SidecarImapConfig | null,
): Promise<SealedStart> {
  const bag = deps as unknown as Record<string, unknown>;
  const present = HOST_ONLY_KEYS.filter((k) => bag[k] !== undefined);
  if (present.length > 0) {
    throw new Error(
      `this build has no host door, so it cannot accept ${present.join(", ")}. A phone organizes ` +
        "its own mailbox and never serves one to another device; the modules that would answer " +
        "these knobs are not in this artifact at all. Refused rather than disarmed silently, so a " +
        "caller cannot believe it has a door it has not got.",
    );
  }
  if (deps.machineName.trim() === "") {
    throw new Error(
      "machineName is required: it is the name every other install shows for the holder of this " +
        "mailbox, and this build has no machine name of its own to fall back to",
    );
  }
  if (deps.installId.trim() === "") {
    throw new Error(
      "installId is required: the lease tells two installs apart by it, and an empty one would " +
        "make this phone and any restored copy of it read as a single organizer",
    );
  }
  const keks = deps.keks ?? {};
  for (const [version, hex] of Object.entries(keks)) {
    if (!KEK_HEX_RE.test(hex)) {
      // The VERSION, never the value.
      throw new Error(`the key ring's version ${version} is not a 32-byte key in hex`);
    }
  }

  /* ONE DIAGNOSTIC, handed to the engine AND to the launch catch below. Two would be two places a
     caller has to wire up, and the one that gets forgotten is the one that swallows the only
     record of a mailbox that never came up.
     A supplied `log` wins; a supplied SINK is wrapped in this package's own hardened logger (see
     {@link PhoneEngineDeps.logSink}); neither, and every call below is a no-op, which is the
     pre-existing shape for the compositions that pass nothing. */
  const wired = deps.log !== undefined || deps.logSink !== undefined;
  const log: Diagnostic = deps.log
    ?? (deps.logSink !== undefined ? createSidecarLog({ sink: deps.logSink }) : (): void => undefined);

  /* THE SOCKET BRIDGE GETS THE SAME DIAGNOSTIC, so a write refused at a closed connection is a
     line rather than a silence. See the `net` import: present only on a phone, where that
     specifier is the shim the mail client's socket is built by. */
  (socketModule as { setSocketLog?: (l: Diagnostic) => void }).setSocketLog?.(log);

  const store = await openPhoneStore(deps.exec);
  /**
   * THE DIAL, AND WHO SUPPLIES IT. A configured start uses what it was given; a sealed start reads
   * the row. A store with nothing to read ends here, with the store CLOSED — an engine left open
   * behind a refusal holds this phone's only SQLite handle for a mailbox nobody can dial.
   */
  const dial = imap ?? await sealedDial(store.db);
  if (dial === null) {
    await store.close().catch(() => undefined);
    return { kind: "no-credential" };
  }
  const sidecar = await createSidecar({
    dataDir: deps.dataDir ?? "",
    /**
     * The phone's socket deadline is the composition's, and it is the WORKER's number. The engine's
     * default profile is chosen against a 60 s serverless ceiling — a 25 s deadline for a connection
     * opened, used and thrown away in one request. This connection is held for as long as the app is
     * foregrounded, and one fetch pass over a couple of hundred messages was measured at 42 s, so
     * under the serverless profile that pass is a dead socket and a mailbox that never finishes
     * opening. `WORKER_NET_TIMEOUTS` already exists for exactly this shape, passed INSIDE the config
     * object with no engine change. A caller that supplies its own timeouts WINS — a default, not an override.
     */
    imap: { ...dial, timeouts: dial.timeouts ?? WORKER_NET_TIMEOUTS },
    ...(deps.address !== undefined ? { address: deps.address } : {}),
    machineName: deps.machineName,
    installId: deps.installId,
    organizerKind: deps.organizerKind ?? "mobile",
    ...(deps.now ? { now: deps.now } : {}),
    ...(wired ? { log } : {}),
    /* BOTH FACES OF THE ONE CHANNEL, spread on the same condition — see {@link loggerOver}. A
       caller that supplies NEITHER a `log` nor a `logSink` gets neither, which keeps the
       pre-existing shape for the many compositions that pass nothing (`exactOptionalPropertyTypes`
       wants absence, not `undefined`); a caller that supplies either gets the sync loop's
       diagnostics too. `wired` rather than a second `deps.log` test, because the sink arm has to
       reach both faces or the phone would get the launch's lines and none of the drain's. */
    ...(wired ? { logger: loggerOver(log) } : {}),
    ...(deps.adapterFactory ? { adapterFactory: deps.adapterFactory } : {}),
    // Hex to bytes happens HERE and nowhere else: `Buffer` is bound in this bundle by the builder's
    // `inject`, and the app-side code that reads the keystore has no such global.
    ...(Object.keys(keks).length > 0
      ? { keks: Object.fromEntries(Object.entries(keks).map(([v, hex]) => [Number(v), Buffer.from(hex, "hex")])) }
      : {}),
    // The store, already open. This is the line the whole file exists for.
    store: async () => store,
    /* See {@link phoneOneClickPost}: refused by name, so the failure is about the person's mail
       rather than about a missing Node module. */
    oneClickPost: phoneOneClickPost,
  });

  /**
   * The engine starts itself — nobody outside has to remember to. `main.ts` does exactly this on the
   * line after the engine is built; this file did not and exposed no way to, so a phone booted,
   * reported `organizing: true`, and synchronised nothing for ever with no diagnostic. NOT a
   * `start()` member (a door that must remember to call something is the built-tested-unreachable
   * shape this closes). And a launch the server answered NO is not handed back as an engine: this
   * was `void sidecar.start().catch(...)` whose catch was UNREACHABLE (`start()` settles with
   * `allSettled`). So the launch is awaited and bounded, and exactly two outcomes refuse — the
   * sign-in and the encrypted way in; an OUTAGE is not a refusal, and on a refusal the engine STOPS.
   */
  /* MERGED THE WAY `imapFlowOptions` MERGES IT — `timeouts` on a config is PARTIAL, and a caller
     that overrode only `socketMs` would otherwise leave the two halves of this bound undefined. */
  const timeouts = { ...DEFAULT_NET_TIMEOUTS, ...(dial.timeouts ?? WORKER_NET_TIMEOUTS) };
  const launched = sidecar.start().then(
    (report) => report.failures,
    // `start()` does not reject per mailbox; an assembly-level throw is still a launch failure and
    // is classified by the same two predicates rather than swallowed here.
    (err: unknown) => [{ mailboxId: "", err }],
  );
  const bounded = await Promise.race([
    launched,
    new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), timeouts.connectionMs + timeouts.greetingMs);
      (t as unknown as { unref?: () => void }).unref?.();
    }),
  ]);
  /**
   * A refused launch does not leave the credential it sealed on the way in. `attachLocal` seals the
   * supplied password at ATTACH, before anything dials, so a first press with the wrong password —
   * or the wrong host — writes the row and is refused, and the next press is ignored: `resolveLogin`
   * lets the STORE win, and a corrected HOST leaves the row FOREIGN so `start()` returns without
   * dialling and this used to hand back an engine over a door that never authenticated (measured: an
   * Ohbox in under six seconds, zero bytes on the wire). Only where THIS start SUPPLIED a password —
   * a sealed start or coordinates-only relaunch carries no second copy, and an `unreadable` row is
   * the dial-with-nothing state the form recovers from, not a row to delete.
   */
  const typed = imap === null ? undefined : (imap.auth as { pass?: string } | undefined)?.pass;
  const suppliedPassword = typeof typed === "string" && typed !== "";

  const removeRefusedSeal = async (why: string): Promise<void> => {
    if (!suppliedPassword) return;
    await sidecar.forgetStoredLogin().catch((err: unknown) => {
      log("stored_login_clear_failed", {
        err,
        reason: "a refused launch could not remove the password it had just sealed, so the next " +
          "attempt would dial the refused one again; entering it again replaces the row",
      });
    });
    log("mailbox_open_seal_discarded", {
      reason: why,
    });
  };

  const answered = (bounded ?? []).find((f) => credentialsRefused(f.err) || tlsRefused(f.err));
  if (answered !== undefined) {
    log("mailbox_open_refused", {
      err: answered.err,
      mailboxId: answered.mailboxId,
      reason: "the mail server answered this launch and refused it, so no engine is handed back " +
        "and the caller can say why rather than reporting an opened mailbox",
    });
    await removeRefusedSeal(
      "the mail server refused this launch, so the password it had just sealed is not a "
        + "credential for this mailbox and the next press composes from the form again",
    );
    await sidecar.stop().catch(() => { /* nothing to keep: the launch is being refused */ });
    // THE ORIGINAL ERROR, rethrown. It carries imapflow's own `authenticationFailed`/`tlsFailed`
    // and its cause chain, so the caller classifies it with the same predicates this file used
    // rather than being handed a verdict it cannot check. No password is in it.
    throw answered.err;
  }

  /**
   * And an engine that dialled nothing is not an opened mailbox. The runtime's `start()` returns
   * without dialling whenever the login does not resolve to a usable password — `foreign-host`,
   * `unreadable` (this install's key does not open its own row), `absent` — reporting no failure,
   * correct on the desktop where the shell shows a password field. A CONFIGURED start has no such
   * field: the person just typed a password, and an engine handed back here is an Ohbox over a door
   * that never authenticated. So the unusable row is removed and the launch refuses; pressing Connect
   * again seals the form. Reachable independently: a keystore that minted a new ring leaves a row
   * this install cannot open. A start with NO password of its own is untouched (that is the relaunch).
   */
  if (suppliedPassword) {
    const credential = await sidecar.credentialState().then(
      (state) => state,
      /* An unreadable store is not an opened mailbox either. Named rather than defaulted to
         `ready`, which would make this guard decorative. */
      (): CredentialState => "unreadable",
    );
    if (credential !== "ready") {
      log("mailbox_open_no_login", {
        state: credential,
        reason: "this launch supplied a password and the store answered with a credential it "
          + "could not dial, so nothing was dialled and no engine is handed back",
      });
      await removeRefusedSeal(
        "the stored password for this mailbox could not be used by this launch, so it is removed "
          + "and the next press seals what is on the form",
      );
      await sidecar.stop().catch(() => { /* nothing to keep: the launch is being refused */ });
      throw new Error(
        "this phone had a stored password for this mailbox that it could not use, so nothing was "
          + "signed in. It has been removed — press Connect again.",
      );
    }
  }
  /* The launch that is still running, or one that failed for a reason a poll may heal. Its own
     failures are logged by `start()`; this attaches nothing so a later rejection cannot become an
     unhandled one. */
  void launched.catch(() => undefined);

  /**
   * ══ THE CONSENT DOOR, AND IT ANSWERS IN THREE WORDS ═══════════════════════════════════════
   *
   * Not the enforcement — that is the fence. What this must never do is admit a press over a
   * mailbox it could not see. `held` on the row is the FAST PATH: one indexed read, no round trip.
   * `stopped` is a look that ANSWERED and found nobody renewing. NULL is neither — the schema says
   * *"we have not looked"*, and this door used to read it as "nobody holds it" — so on NULL the
   * door asks the ENGINE to look, and only `free` admits the press. An UNREADABLE row or folder is
   * 503 and never 409: nobody is told a machine has their mailbox on a look that did not land.
   */
  /** 503 with the code the app renders as its own sentence. Never 409: the two are different
   *  facts and a person told "another computer has it" about a look that did not land would go
   *  looking for a machine that may not exist. */
  const unreadableResponse = (): Response => new Response(
    JSON.stringify({
      error: {
        code: "organizer_unreadable",
        message: "whether another install organizes this mailbox could not be read",
      },
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );

  /**
   * ══ WHO THE DOOR LAST REFUSED A PRESS TO, PER MAILBOX ═════════════════════════════════════
   *
   * The refusal already names the holder in its body, and that was the only place it existed: the
   * app got back one word, `held`, so over a mailbox another install was organizing the panel went
   * on saying "Nothing organizes this mailbox" beside a live Start verb — measured, five reads over
   * 35 s, and again after leaving and returning.
   *
   * So the fact is kept where every OTHER holder lives, the organizer state {@link
   * PhoneEngine.runtimes} reports, rather than added as a second channel the app would have to
   * merge: one answer to "who holds this mailbox", and the claim watch — which arms on a stand-down
   * reason — comes back on its own cadence and refreshes or clears this through the presses it
   * already makes.
   *
   * `logged` is the other half: the refusal is logged at the TRANSITION and not per press. A
   * stood-down phone presses once a tick for as long as the holder keeps the mailbox (61 lines in
   * one device run, 37 of them 10.016 s apart for one standing cause), and one line per standing
   * cause is what an operator can read.
   */
  const refusedHolders = new Map<string, {
    readonly heldBy: string | null;
    readonly reason: StandDownReason;
    readonly logged: string;
  }>();

  /**
   * The holder's KIND as the stand-down spells it — the closed set, and every member on its own
   * arm. `unknown` is the honest answer for a claim written by a build this one cannot rank, which
   * is a state and not a fallback; the type is what refuses a fifth spelling.
   */
  const standDownReasonForKind = (kind: string): StandDownReason =>
    (kind === "cloud" ? "organized_elsewhere:cloud"
      : kind === "local" ? "organized_elsewhere:local"
        : kind === "mobile" ? "organized_elsewhere:mobile"
          : "organized_elsewhere:unknown");

  /**
   * The organizer state, with the door's own refusal answering for a mailbox the gate has nothing
   * to say about — the ONE place the app asks who holds a mailbox.
   *
   * A STAND-DOWN THE GATE WROTE WINS: it has READ the claim folder, and this memo is one press old.
   * Where the gate has no reason of its own the refusal answers, which is exactly the state it
   * exists for — a mailbox this phone handed back and another install then took, where nothing
   * runs the gate at all and the row goes on saying what it said before the press.
   *
   * AND IT ANSWERS `organizing: false` WITH IT. The refusal happened because
   * {@link liveForeignHolder} read this mailbox's row as a READER with another install renewing a
   * claim; a runtime still saying this install organizes it is that read's own poll behind, and
   * leaving it standing would put "Organizing" and a hand-back on screen over a mailbox the door
   * had just refused this install a claim on. The door's read is the newer of the two.
   */
  const organizerStatesWithRefusals = (): Record<string, OrganizerState> => {
    const states = sidecar.organizerStates();
    for (const [mailboxId, refused] of refusedHolders) {
      const state = states[mailboxId];
      if (state === undefined || state.reason !== null) continue;
      states[mailboxId] = { ...state, organizing: false, heldBy: refused.heldBy, reason: refused.reason };
    }
    return states;
  };

  const refuseIfOrganizedElsewhere = async (req: Request): Promise<Response | null> => {
    if (req.method !== "POST") return null;
    const matched = ORGANIZE_ROUTE.exec(new URL(req.url).pathname);
    if (matched === null) return null;
    const mailboxId = decodeURIComponent(matched[1]!);
    let fromRow: RowHolderAnswer;
    try {
      fromRow = await liveForeignHolder(store.db, mailboxId, deps.installId);
    } catch (err) {
      log("organizer_consent_row_read_failed", {
        err,
        reason: "the row that says who holds this mailbox could not be read, so no consent was "
          + "recorded; an unreadable row is not permission and the next press asks again",
      });
      return unreadableResponse();
    }
    /* A LOOK THAT ANSWERED "NOBODY" ENDS THE MEMO, here and at the lease's own arm below. The
       holder this door last named is a statement about now, and leaving it standing would keep
       "Organized by …" on screen over a mailbox this very press is about to be admitted to. */
    if (fromRow.answer === "free") {
      refusedHolders.delete(mailboxId);
      return null;
    }
    let holder: { readonly name: string; readonly kind: string };
    if (fromRow.answer === "held") {
      holder = fromRow.holder;
    } else {
      /* ══ THE ROW CANNOT SAY, SO THE ENGINE LOOKS ═══════════════════════════════════════════
       *
       * `organizer_state` NULL is "we have not looked", and this door used to read it as "nobody
       * holds it". Measured on the phone's own composition with the adapter unable to read
       * `ohmail/_meta`: the columns were byte-identical to an unorganized mailbox's, the press was
       * admitted 202, consent and authorization were written, and `claimHere` answered `claimed`.
       * So the door peeks through its OWN engine — the same APPEND-less bounded read the poll
       * makes — answering free / held / unreadable. Only on this path; a `held` row costs nothing.
       */
      /* ══ AND THE LOOK RUNS UNDER A CLOCK ══════════════════════════════════════════════════
       *
       * Nothing beneath this bounded a WHOLE look: the fetch out of `ohmail/_meta` is raced
       * against `IMAP_META_DEADLINE_MS`, while the folder resolution, the mailbox lock and the
       * STATUS probe ahead of it carry no clock at all — measured here against a look that never
       * answers, the press was still outstanding at 120 s. A look that is merely SLOW is a look
       * that did not land: the 503 a failed one takes, and the next press asks again. The ceiling
       * is the peek read's own, never a second number minted at this door.
       */
      const lookedAt = Date.now();
      let looked: LeasePeekAnswer;
      let lookOutcome: "landed" | "timeout" | "failed";
      try {
        looked = await ImapDeadline.in(IMAP_META_DEADLINE_MS, "read_deadline")
          .race(sidecar.peekOrganizer(mailboxId));
        lookOutcome = looked.answer === "unreadable" ? "failed" : "landed";
      } catch (err) {
        /* A REJECTION IS A LOOK THAT DID NOT LAND, never a 500. The clock throws
           `ImapBoundExceeded`; anything else arriving here came out of `listClaims`, the only read
           a peek performs. Both become the answer the arms below already handle. */
        lookOutcome = isImapBoundExceeded(err) ? "timeout" : "failed";
        looked = { answer: "unreadable", op: "list_claims", cause: err };
      }
      /* ONE LINE PER LOOK THIS PRESS PAID FOR, and none for the fast path — what an operator
         cannot otherwise tell apart is a door that answered slowly from a door that never asked.
         `latencyMs` and not a new name: an unregistered field has its value dropped silently. */
      log("organizer_consent_look", {
        mailboxId,
        outcome: lookOutcome,
        latencyMs: Date.now() - lookedAt,
        reason: "the row did not say who organizes this mailbox, so this press paid for a live "
          + "read of the claim folder; past the ceiling the look did not land, and the door "
          + "refuses instead of holding the press open",
      });
      if (looked.answer === "free") {
        refusedHolders.delete(mailboxId);
        return null;
      }
      if (looked.answer === "unreadable") {
        log("organizer_consent_lease_read_failed", {
          mailboxId,
          op: looked.op,
          reason: "the row does not say who organizes this mailbox and the claim folder could not "
            + "be read either, so no consent was recorded; a look that did not land is not "
            + "permission, and the next press looks again",
        });
        return unreadableResponse();
      }
      /* OUR OWN CLAIM IS NOT A FOREIGN ONE, on the path that has to LOOK for it. The row read
         above takes this exemption off `organized_by_install_id`; this path did not, and a row
         whose holder columns are empty while this install's claim is still being renewed is
         ordinary — a restore, a fresh row, a stand-down that cleared them. Refusing there answers
         a person "another install is organizing this mailbox" about the phone in their hand.
         `LeaseHolder.installId` exists for exactly this question. */
      if (looked.holder.installId === deps.installId) {
        refusedHolders.delete(mailboxId);
        return null;
      }
      /* A HOLDER THE ROW HAD NOT CAUGHT UP WITH. The claim's own display name, through the same
         normaliser the row's column is written with, so the app is handed one spelling. */
      holder = {
        name: organizerDisplayName(looked.holder.displayName) ?? "",
        kind: looked.holder.kind,
      };
    }
    /* TWO EVENTS FOR TWO FACTS, each spelled out. The row's answer is the fast path and the
       lease's is a look this press paid for, and an operator reading a refusal nobody expected
       wants to know which one saw the claim. Not one event with a `source` field — that would be a
       new name on the logger's own census, which is a decision about every line in the product —
       and not a ternary, which is an event name no grep can find. */
    const refusedBecause = "another install is renewing its claim on this mailbox, so no consent "
      + "was recorded here; this phone has no takeover verb and reads the mailbox instead";
    /* ══ ONE LINE PER STANDING CAUSE ═══════════════════════════════════════════════════════════
       The claim watch presses once a tick for as long as another install keeps the mailbox, and
       this logged every press: 37 identical lines 10.016 s apart in one device run, for one cause
       that had not changed. The signature is the whole of what an operator would read — which door
       saw the claim, and who holds it — so a holder going away, a DIFFERENT holder arriving, or the
       other door answering all write a fresh line, and a repetition writes none. The backoff that
       paces the presses is the claim watch's; this decides only what is worth saying.

       BOTH EVENT NAMES STAY LITERAL, on the rule the paragraph above them states: a ternary is an
       event name no grep can find, and the log census reads these call sites as text. */
    const signature = JSON.stringify([fromRow.answer, holder.name, holder.kind]);
    const worthSaying = refusedHolders.get(mailboxId)?.logged !== signature;
    if (worthSaying && fromRow.answer === "held") {
      log("organizer_consent_refused_elsewhere", { mailboxId, verdict: "held", reason: refusedBecause });
    } else if (worthSaying) {
      log("organizer_consent_refused_by_lease", { mailboxId, verdict: "held", reason: refusedBecause });
    }
    refusedHolders.set(mailboxId, {
      heldBy: holder.name === "" ? null : holder.name,
      reason: standDownReasonForKind(holder.kind),
      logged: signature,
    });
    return new Response(
      JSON.stringify({
        error: {
          code: "organized_elsewhere",
          message: "another install is organizing this mailbox",
        },
        /* THE HOLDER RIDES THE REFUSAL, because the sentence a person needs names the machine and
           the app holds no other source for it on this door. Empty strings rather than absent
           members: the app's reader distinguishes "named nothing" from "no holder" by the STATUS,
           and an optional member here would collapse them. */
        holder: { name: holder.name, kind: holder.kind },
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    );
  };

  /**
   * THE ONE MAILBOX THIS PHONE SERVES, or `null` where the engine cannot name exactly one.
   *
   * One mailbox per phone is the fourth door's own ruled line, and `standaloneHere` in the app
   * takes the same reading for the same reason: picking the first of several would act on
   * whichever came back first.
   */
  const soleMailbox = (): string | null => {
    const ids = Object.keys(sidecar.organizerStates());
    return ids.length === 1 ? ids[0]! : null;
  };

  /**
   * THE VERB THIS DOOR WRITES, onto every consent request that passes it — here and not in the
   * app, because a check the caller supplies is one the next caller can be added past.
   *
   * Three things the rebuild must get right: `req.body` is never touched (React Native's bodies
   * are not the streams `new Request(req.body, …)` expects); `content-length` is dropped, the body
   * having grown by a key; and the door's key is spread LAST, so a body asking for `takeover` gets
   * `join`. An unparseable body is forwarded untouched, so the API's own refusal answers it.
   */
  const organizeWithJoinIntent = async (req: Request): Promise<Request> => {
    const raw = await req.text();
    let parsed: Record<string, unknown>;
    try {
      const v: unknown = raw === "" ? {} : JSON.parse(raw);
      if (v === null || typeof v !== "object" || Array.isArray(v)) return new Request(req, { body: raw });
      parsed = v as Record<string, unknown>;
    } catch {
      return new Request(req, { body: raw });
    }
    const headers = new Headers(req.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json");
    return new Request(req.url, {
      method: req.method,
      headers,
      body: JSON.stringify({ ...parsed, intent: "join" }),
    });
  };

    /**
     * ══ THE STEP-UP'D SPELLING IS NOT ON THIS DOOR AT ALL ══════════════════════════════════════
     *
     * A 404, not a forward and not a rewrite. See {@link LOCAL_ORGANIZE_PATH}: on a standalone
     * install the shared consent route is a permanent 403, so every caller reaching it is a press
     * that cannot work — and the way to stop a caller being added back is for the path to be
     * absent rather than discouraged. `/local/` is the door this build serves.
     *
     * Scoped to the PHONE; the shared route stays on the hosted and self-hosted tables.
     */
  const SHARED_ORGANIZE_ROUTE = /^\/mailboxes\/([^/]+)\/organize$/;

  /**
   * ══ THE PHONE'S ONE DOOR — and `claimHere` goes through it, which is the whole point ════════
   *
   * Composed once and used by BOTH the app-facing `handle` and the engine's own two verbs: with
   * `claimHere` pressing `sidecar.handle` directly, the claim watch reached the service over a
   * live foreign claim and the 409 never ran. THREE ACTS, in order: the takeover verb is refused
   * outright, a live foreign holder is refused off the row, and whatever is left through a consent
   * path is forwarded carrying `join`. The ANSWER; the door that logs it is `phoneHandle` below.
   */
  const answer = async (req: Request): Promise<Response> => {
      /* THE ONE-ORGANIZER RULE FIRST, on every organize and takeover spelling. A live foreign
         claim is the answer a person's screen needs — the holder NAMED — and it outranks "this
         door is not served": answering 404 there would lose the holder the panel renders.
         Nothing is written before this check. */
      const held = await refuseIfOrganizedElsewhere(req);
      if (held !== null) return held;
      /* A TAKEOVER PRESS IS NEVER REINTERPRETED AS A JOIN — it is refused at the door. */
      if (req.method === "POST" && new URL(req.url).pathname === TAKEOVER_ROUTE) {
        log("organizer_takeover_verb_absent", {
          reason: "this install has no takeover verb, so the route that makes it the organizer "
            + "whoever holds the mailbox is not served here and nothing was written",
        });
        return new Response(
          JSON.stringify({ error: { code: "not_found", message: "this phone has no takeover verb" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      /* THE SHARED CONSENT SPELLING IS ABSENT HERE, not discouraged: on a standalone install it
         carries a second factor this build can never produce. The local door records consent. */
      if (req.method === "POST" && SHARED_ORGANIZE_ROUTE.test(new URL(req.url).pathname)) {
        log("organizer_consent_route_absent", {
          reason: "the shared consent route carries a second factor a standalone install can never "
            + "produce, so it is not served here; the local door records the consent",
        });
        return new Response(
          JSON.stringify({ error: { code: "not_found", message: "not found" } }),
          { status: 404, headers: { "content-type": "application/json" } },
        );
      }
      /* AND THE VERB IS STAMPED AT THE DOOR, never taken from the caller. */
      const isConsent = req.method === "POST" && ORGANIZE_ROUTE.test(new URL(req.url).pathname);
      return sidecar.handle(isConsent ? await organizeWithJoinIntent(req) : req);
  };

  /**
   * ══ AND EVERY REFUSAL THIS DOOR ANSWERS NAMES ITSELF ═══════════════════════════════════
   *
   * `GET /mailboxes` over this door answers a row under Node and was refused on a device, twice,
   * unreadable both times: the app's roster read folds a non-200 and a throw into one `null`, so
   * the status that decided it existed nowhere. Written HERE, through the engine's own hardened
   * logger — an app composing it would be a second logger outside the field allowlist. A refusal
   * is `info`; a throw is the failure. `route` and `method` drop the query first.
   */
  const phoneHandle = async (req: Request): Promise<Response> => {
    /* LITERAL FIELDS AT BOTH CALL SITES, never a spread of a shared object: the census that
       reads this package can only see a field set written out, and an opaque one is refused. */
    const route = describeRoute(req.url);
    const method = describeMethod(req.method);
    let res: Response;
    try {
      res = await answer(req);
    } catch (err) {
      log("phone_door_failed", { route, method, err });
      throw err;
    }
    if (res.status >= 400) log("phone_door_refused", { route, method, status: res.status });
    return res;
  };

  /** The engine pressing its OWN door, with this launch's bearer. See {@link SELF_ORIGIN}. */
  const pressOwnRoute = async (path: string): Promise<Response> => phoneHandle(new Request(
    `${SELF_ORIGIN}${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${sidecar.sessionToken}`,
        "content-type": "application/json",
      },
      /* EMPTY. The screening answer belongs to the door that asks the question; this verb is the
         claim-back, which asks nothing and must write nothing about a window. */
      body: "{}",
    },
  ));

  /* ══ A REFUSED PRESS SAYS WHY, AND THIS DOOR IS THE ONLY PLACE THAT KNOWS ═════════════════
   *
   * Both verbs had `return "refused"` exits with no line at all, and the app's own catch turns a
   * throw into the same word — so a press a person made and watched fail left NOTHING anywhere,
   * on the device or in the log. Measured on a device: a Start refused for over a minute after a
   * Stop, with not one line from this door saying what the route had answered.
   *
   * Written out at each exit rather than through a helper taking the event as an argument: the
   * package's log census parses these call sites for LITERAL event names, so a name reaching the
   * logger through a variable is a line the roster cannot see. */
  const claimHere = async (): Promise<ClaimHereOutcome> => {
    const mailboxId = soleMailbox();
    if (mailboxId === null) {
      log("organizer_claim_here_refused", {
        reason: "this install does not serve exactly one mailbox, so there is none to ask for",
      });
      return "refused";
    }
    let res: Response;
    try {
      res = await pressOwnRoute(LOCAL_ORGANIZE_PATH(mailboxId));
    } catch (err) {
      log("organizer_claim_here_failed", { err, mailboxId });
      return "refused";
    }
    if (res.status === 409) return "held";
    /* THE THIRD ANSWER, AND IT IS NOT `refused`. The door says 503 exactly where it could not see
       whether anybody holds the mailbox; folding it into `refused` would put "we could not start
       organizing" in front of a person whose real answer is "try again". */
    if (res.status === 503) {
      const body = await res.json().then(
        (b) => b as { error?: { code?: unknown } },
        () => ({ error: undefined }),
      );
      if (body.error?.code === "organizer_unreadable") return "unreadable";
      return "refused";
    }
    /* ── THE LOCAL DOOR ANSWERS 200 FOR EVERY OUTCOME, so the OUTCOME is what is read ────────
     *
     * The shared route split its answer across the status (202 authorized, 200 otherwise); this
     * one says so in the body, because on this door every one of the four is an answer about the
     * row rather than a refusal of the request. `authorized` is the becoming and
     * `already_organizing` is the row already saying so — the same end state, not a second
     * becoming. `no_mailbox` and `removed` are not claims: the person took the mailbox off this
     * phone while the press was in flight. */
    if (res.status !== 200) {
      log("organizer_claim_here_refused", {
        mailboxId,
        status: res.status,
        reason: "the door refused this install the mailbox and the press is recorded nowhere",
      });
      return "refused";
    }
    const body = await res.json().then(
      (b) => b as { outcome?: unknown },
      () => ({ outcome: undefined }),
    );
    if (body.outcome !== "authorized" && body.outcome !== "already_organizing") {
      log("organizer_claim_here_refused", {
        mailboxId,
        status: res.status,
        reason: "the door answered about this mailbox without making this install its organizer",
      });
      return "refused";
    }
    /* ══ THE DECISION IS WRITTEN WHERE IT IS MADE, NOT WHERE THE CYCLE ENDS ═══════════════════
     *
     * This line stood AFTER the forced cycle below, and that cycle queues behind whatever drain is
     * already running — so a press measured on a device left the door silent for over a minute
     * while the person watched `Starting`, with nothing to say the press had even been taken. The
     * door decides here; the gate's own lines close the sequence when it runs. */
    log("organizer_reclaimed", {
      mailboxId,
      status: res.status,
      /* WHICH OF THE TWO, because the status no longer says: the local door answers 200 for both
         the becoming and the row already saying so, and a log that cannot tell them apart cannot
         tell a re-claim that worked from a press over a mailbox this install already held. */
      verdict: String(body.outcome),
      reason: "this install was asked to organize this mailbox and no other install is renewing a "
        + "claim on it, so the consent is recorded and the gate is asked now",
    });
    /* AND THE GATE IS ASKED NOW. The stamp alone is inert — it is spent by the next gated cycle,
       which on a phone is a poll interval away, and the person is looking at the screen. `resume`
       is the same forced cycle the foreground path uses and it can displace nobody. It is AWAITED:
       `claimed` raises the background session and ends the transition, so answering before the
       engine organizes would paint an idle mailbox over a start the person was just told worked. */
    await sidecar.resume().catch((err: unknown) => {
      log("organizer_claim_here_cycle_failed", {
        err,
        reason: "the consent is recorded and the forced cycle did not run, so the claim is taken "
          + "on the next poll instead",
      });
    });
    return "claimed";
  };

  const stopOrganizing = async (): Promise<StopOrganizingOutcome> => {
    const mailboxId = soleMailbox();
    if (mailboxId === null) {
      log("organizer_stop_here_refused", {
        reason: "this install does not serve exactly one mailbox, so there is none to give up",
      });
      return "refused";
    }
    let res: Response;
    try {
      res = await pressOwnRoute(RELEASE_PATH(mailboxId));
    } catch (err) {
      log("organizer_stop_here_failed", { err, mailboxId });
      return "refused";
    }
    /* 202 IS THE ONLY ONE THAT RECORDED ANYTHING — the route's own contract: *"the ceasing has not
       happened yet"*, so 200 is `not_organizing`/`disconnected`, both of which mean there was
       nothing of ours to give up. Neither is a failure and neither is a release. */
    if (res.status === 200) return "not_organizing";
    if (res.status !== 202) {
      log("organizer_stop_here_refused", {
        mailboxId,
        status: res.status,
        reason: "the door refused the stop and recorded nothing, so this install organizes the "
          + "mailbox still",
      });
      return "refused";
    }
    /* THE DOOR'S OWN DECISION, before the cycle — the claim's reason one verb over. */
    log("organizer_stop_here_recorded", {
      mailboxId,
      reason: "this install asked to stop organizing this mailbox, the request is on the row where "
        + "a relaunch reads it, and the gate is asked now",
    });
    /* THE GATE HONOURS THE REQUEST BEFORE IT READS THE LEASE, so this forced cycle is what takes
       the claim out of the folder and writes the reader role — the person pressed a button and the
       mailbox is free for their other machine within a cycle rather than a poll interval. */
    let cycled = true;
    await sidecar.resume().catch((err: unknown) => {
      cycled = false;
      log("organizer_stop_here_cycle_failed", {
        err,
        reason: "the stop is recorded on the row and the forced cycle did not run, so the claim "
          + "leaves the mailbox on the next poll instead",
      });
    });
    /* AND THE ANSWER IS THE CYCLE'S OWN READING, NOT THE ROUTE'S ACCEPTANCE. This returned `true`
     * for every 202, but the cycle above has three endings and only one is a release: it can fail
     * to confirm the claim is out of `ohmail/_meta` (the search refused, the folder over its
     * ceiling), and it can lose the write to a press that landed while the server was being asked.
     * In both the mailbox is still organized here, and both leave `organizing: false`, so the
     * caller read `false` as "let go", took the notification and the background work down, and the
     * phone went on organizing with nothing saying so. `released` therefore requires the gate to
     * have SPENT the request — the same write that records the release. A cycle that did not run
     * is not a reading. */
    const settled = cycled ? sidecar.organizerStates()[mailboxId] : undefined;
    if (settled === undefined || settled.organizing || settled.releaseRequestedAt !== null) {
      log("organizer_stop_here_unconfirmed", {
        mailboxId,
        reason: "this install asked to stop organizing this mailbox and its claim is not confirmed "
          + "out of the mailbox, so the mailbox is still organized here and the next poll asks the "
          + "server again",
      });
      return "refused";
    }
    return "released";
  };

  return { kind: "started", engine: {
    handle: phoneHandle,
    sessionToken: sidecar.sessionToken,
    /* THE ENGINE'S OWN ACCOUNT, off the world it just established rather than composed from what a
       caller passed: the app keys its mirror by it, and an id the app invented would key a second
       copy of this mailbox. The address is `createSidecar`'s own derivation, spelled once. */
    accountId: sidecar.world.accountId,
    address: deps.address ?? dial.auth.user,
    wake: () => sidecar.wake(),
    handBack: () => sidecar.handBack(),
    resume: () => sidecar.resume(),
    claimHere,
    stopOrganizing,
    forgetStoredLogin: () => sidecar.forgetStoredLogin(),
    runtimes: () => ({ organizer: organizerStatesWithRefusals(), connection: sidecar.connectionStates() }),
    /* THE SAME `log` EVERY LINE ABOVE GOES THROUGH — not a second one built for the app. */
    log,
    stop: () => sidecar.stop(),
  } };
}

/**
 * The mailbox this store serves and the server it was proved against — or `null`. `engine.ts` seals
 * `host/port/secure/user` beside the ciphertext, which is what makes a relaunch possible without the
 * app holding a secret. Read here in the SAME order `ensureLocalWorld` picks the seed — the oldest
 * live row — so the engine that follows serves the mailbox whose credential this dial came from.
 * `null` for every shape that is not a dial: no mailbox, no credential row, or a row whose meta
 * names no host (the shape sealed before the probe recorded coordinates) — treating that as a dial
 * would start with an empty host, and the honest answer is that this store cannot say where it is.
 */
async function sealedDial(db: LocalDb): Promise<SidecarImapConfig | null> {
  const rows = await db
    .select({ address: mailboxes.address, meta: mailboxCredentials.meta })
    .from(mailboxes)
    .innerJoin(mailboxCredentials, eq(mailboxCredentials.mailboxId, mailboxes.id))
    .where(and(eq(mailboxCredentials.transport, "imap"), eq(mailboxes.provider, "imap")))
    .orderBy(asc(mailboxes.createdAt))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return null;
  /* The device store keeps `meta` as JSON text in one dialect and as a parsed object in the other.
     Both are read, because a relaunch that worked on one store and not the other would be a
     failure only a device could show. */
  const meta = (typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta) as
    { host?: unknown; port?: unknown; secure?: unknown; user?: unknown; insecureConsent?: unknown } | null;
  const host = typeof meta?.host === "string" ? meta.host.trim() : "";
  if (host === "") return null;
  return {
    host,
    port: typeof meta?.port === "number" ? meta.port : 993,
    secure: meta?.secure !== false,
    ...(meta?.insecureConsent === true ? { allowInsecure: true } : {}),
    /* NO PASSWORD, and no `smtp` block. The password is the engine's to decrypt, and submission
       coordinates are the send path's to resolve from this mailbox's own `smtp` row — a copy here
       would be a second source for them. */
    auth: { user: typeof meta?.user === "string" && meta.user !== "" ? meta.user : row.address },
  };
}
