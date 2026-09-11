/**
 * The engine composition for this app — a real `OhmailEngine` on React Native. Everything
 * platform-shaped is injected through {@link MobileEngineDeps} (screens hand in
 * `nativeEngineDeps()`; the suite hands in `node:sqlite`), so this module imports nothing from
 * Expo or RN and the node suite drives the composition without a device. The engine is not
 * forked — the same `OhmailEngine` every client runs, adapted at its seams: store =
 * `SqlMirrorStore` over the injected executor; uuid = injected (Hermes has no
 * `crypto.randomUUID`; Idempotency-Keys need a real v4); fetch = RN's global (no CORS, no
 * secure-context gate); cookies = none, `getCookie` pinned `null`; EventSource off — polls `/sync`.
 */
import {
  HttpAdapter,
  OhmailEngine,
  SqlMirrorStore,
  flattenResponse,
  mirrorDbName,
  type EngineAdapter,
  type SqlExecutor,
  type StorePolicy,
  type SyncChange,
} from "@ohmail/client-engine";
/* The `reason` fields below are RETURNED and rendered — `net/pairing.ts` hands a boot reason
   straight to the connect screen — so they are copy and live in the deck. The thrown faults in
   this file are not: nobody but a developer reads a stack trace. */
import { Copy } from "../copy";
import { faultDetail, refuse, type Refusal } from "../refusal";
import { StoreFault } from "../state/servers";

/** What the platform must provide — expo modules in the app, node modules in tests. */
export interface MobileEngineDeps {
  /**
   * Open (creating if needed) the named mirror database. The name is
   * `mirrorDbName(ownerKey)`-shaped; the opener decides what a database physically is
   * (an expo-sqlite file, a node:sqlite handle).
   */
  openExecutor: (dbName: string) => SqlExecutor | Promise<SqlExecutor>;
  /**
   * Remove the named mirror database from the device — the take-back's other half, required
   * rather than optional: a platform half that can only create mail on a phone is not complete.
   * Forgetting a server used to close the store handle and stop there, leaving the SQLite file
   * on disk with every header and hydrated body and no deletion path at all. A required member
   * means a new platform half cannot compile until it answers "and how does this device
   * forget?". Deleting a name that does not exist must resolve, not throw: {@link forgetMirror}
   * deletes twice by design and a pending wipe is retried at every launch.
   */
  deleteDatabase: (dbName: string) => Promise<void>;
  /** RFC 4122 v4 — the engine's Idempotency-Key generator. */
  uuid: () => string;
  /** Override the transport (tests). Absent, `HttpAdapter` binds the global RN fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * The BearerManager's two-seam credential — the desktop host client's shape, verbatim:
 * `headers` stamps the CURRENT access token per request, `fetch` is the manager's own
 * transport whose single 401 recovery rotates the pair and replays once. Fed to the adapter
 * as a PAIR because the seams cover each other's blind moment: a rotation landing between the
 * adapter building its headers and the send is corrected by the manager's fetch stamping last.
 */
export interface ConnectAuth {
  headers: () => Record<string, string>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * The engine running in this app — present only on a standalone install. A paired phone talks
 * to a desktop or the hosted service over the network; a standalone phone organizes its own
 * mailbox with the engine in this same runtime, so the client's transport is a function call.
 * Two members, the whole seam: `handle` is `Request → Response` over the engine's local API,
 * and `sessionToken` is the per-launch bearer it mints for the shell. The adapter is composed
 * against both exactly as against a real server's — the client does not learn a second way to
 * talk to a mailbox.
 */
export interface LocalEngineDoor {
  handle(req: Request): Promise<Response>;
  /** In memory, per launch. Never stored, never sent anywhere but into this same process. */
  readonly sessionToken: string;
}

/** What the pairing seam — or the tests, over a static token — supplies. */
export interface ConnectConfig {
  /** `https://mail.example.org`, `http://192.168.1.20:8028`, … — no trailing slash needed. */
  origin: string;
  /**
   * Where the `/sync` family lives on that origin — absent means the origin itself. A second
   * field rather than a replacement for {@link origin}, load-bearing both ways: the mirror is
   * named by the origin (`mirrorOwnerKey`), so the base must not reach it — keying the mirror
   * by the base would fork one account's copy in two and re-download it; the adapter is
   * composed against the base, because `/sync` and the mutation surface are the routes a
   * one-origin self-host deployment does not serve at its root (see `net/server-base.ts` for
   * the measurement). `/auth/session` stays on the origin — routed at the bare path on every
   * deployment, and moving a request that works would be churn for no measured gain.
   */
  apiBase?: string | null;
  /**
   * A STATIC bearer (the tests' path, and nothing else's in-app).
   * When `auth` is present it wins — a static copy of a rotating token is stale by design.
   */
  token?: string;
  /** The rotating credential — BearerManager-RN behind the two seams above. */
  auth?: ConnectAuth;
  /**
   * The account the mirror belongs to. Server-verified by the pairing seam (the session
   * read where mounted, the server's own rows where not), stored on the profile, which owns
   * this field. The `__owner` stamp still makes a wrong id cost a wipe, never a bleed.
   */
  accountId: string;
  /** Override the identity probe's deadline (tests). Absent, {@link IDENTITY_PROBE_DEADLINE_MS}. */
  identityDeadlineMs?: number;
  /**
   * The standalone arm: the engine in this app, instead of a server on the network. Present ⇒
   * this install organizes its own mailbox and the transport is a call into
   * {@link LocalEngineDoor.handle}. Absent ⇒ every existing door is unchanged — the property
   * that matters most: the three doors this app already has must not acquire a branch. `origin`
   * must be {@link LOCAL_ENGINE_ORIGIN} when this is present, and is refused otherwise rather
   * than corrected: a standalone mirror keyed by some other string would silently hold a second
   * copy of the same mailbox, and a caller passing both a local engine and a remote address has
   * not decided which one it is talking to.
   */
  localEngine?: LocalEngineDoor;
}

/**
 * The address of an engine that is not on a network. Absolute because the adapter composes
 * URLs against it and a relative base has no meaning in a runtime with no document. The host
 * is a name that cannot resolve anywhere — nothing dials it, and a request that somehow
 * escaped this seam would fail rather than leave the device. It is also the mirror's owner key
 * on this door (`mirrorOwnerKey(origin, accountId)`), so it is a fixed string: a key that
 * varied per launch would fork one install's copy of its own mailbox on every start.
 */
export const LOCAL_ENGINE_ORIGIN = "http://sidecar";

/**
 * Every request a door in this process answers, with this launch's bearer on it. Composed here
 * and read by two callers — {@link bootEngine}'s own adapter and the session the connection
 * layer builds over the same door (`net/pairing.ts`) — because two spellings of "how do you
 * talk to the local engine" is one too many: the app's own reads would be stamped differently
 * from the drain's. `new Request(url, init)` because the engine's door is written against the
 * same `Request`/`Response` pair the network one is; the token is read per request rather than
 * captured, keeping this seam identical in shape to a rotating credential's.
 */
export function localEngineTransport(door: LocalEngineDoor): {
  headers: () => Record<string, string>;
  /* `unknown` rather than `RequestInit`, because both readers have to fit: the adapter's seam is
     typed `RequestInit` and the session's is the app's wider `FetchLike`, which every network
     transport in this app already is. */
  fetch: (url: string, init?: unknown) => Promise<Response>;
} {
  const headers = (): Record<string, string> => ({ authorization: `Bearer ${door.sessionToken}` });
  return {
    headers,
    fetch: async (url, init) => {
      const given = (init ?? {}) as RequestInit;
      return door.handle(new Request(url, {
        ...given,
        /* THE DOOR'S TOKEN LAST, so it wins. A caller's own `authorization` header can only ever
           be a different door's or a stale one, and this engine would refuse it — a refusal a
           person would read as their own mailbox rejecting them. */
        headers: { ...Object.fromEntries(new Headers(given.headers).entries()), ...headers() },
      }));
    },
  };
}

/**
 * HOW LONG THE IDENTITY PROBE MAY HOLD THE DRAIN ROUTES SHUT. Every sync chains on the
 * verdict (the clearance below), so a server that ACCEPTS the probe and never answers must
 * not become a session that renders cached mail and never syncs — the exact unbounded hold
 * boot-from-local exists to kill, reintroduced through a side door. Past the deadline the
 * verdict is `unverified` and the routes open; the residual — a server both slower than the
 * deadline AND answering for the wrong account — keeps the per-entity guard, which is the
 * rule every no-session-read door lives under permanently. Eight seconds: far above any
 * healthy round trip, far below "the app never syncs".
 */
export const IDENTITY_PROBE_DEADLINE_MS = 8000;

/**
 * The deferred identity judgment — see {@link bootEngine}'s header for why it is no longer
 * awaited before the mirror opens. `mismatch` carries the sentence the connection layer shows
 * when it tears the session down.
 */
export type IdentityVerdict =
  | { kind: "verified" | "unverified" }
  | { kind: "mismatch"; reason: Refusal };

export type EngineBoot =
  | {
      kind: "ready";
      engine: OhmailEngine;
      store: SqlMirrorStore;
      ownerKey: string;
      /**
       * Ask the server whose bearer this is — STARTED BY THE CALLER, after it has gone live
       * and wired the bearer's dead signal (a cold probe can 401 → rotate → be refused, and
       * that death must land on a subscribed listener, never before one exists). A positive
       * mismatch is the caller's cue to tear the session down with the carried sentence.
       */
      verifyIdentity: () => Promise<IdentityVerdict>;
    }
  | { kind: "refused"; reason: Refusal };

/**
 * ONE MIRROR PER (ORIGIN, ACCOUNT) — composed HERE rather than in the
 * store. A browser gets origin-scoping for free from the storage layer; a phone does not, and
 * two servers' opaque account ids may collide, so the owner string the store names and stamps
 * with carries both halves.
 */
export function mirrorOwnerKey(origin: string, accountId: string): string {
  return `${normalizeOrigin(origin)}::${accountId.trim()}`;
}

/** Lower-case scheme+host, no trailing slash — so `Https://Host/` and `https://host` are one mirror. */
export function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * A mirror database name as a filename a storage engine will take — injective, or it is a leak.
 * Owner keys carry an origin, so they hold `:` and `/`; a lossy sanitizer (`[^\w.-] → "-"`)
 * mapped `http://a-123::acct` and `http://a:123::acct` onto one file, and the `__owner` stamp
 * only referees sequential opens — with two live handles on one collided file, one server's
 * mail can end up under the other's stamp. So every character outside a conservative set (the
 * escape character `_` included) is encoded as `_<hex>_` of its code point: distinct names
 * cannot meet, decoding is unambiguous, the result stays a portable filename. Lives here so
 * the node suite can hold the injectivity and every platform half names files the same way.
 */
export function dbFileName(dbName: string): string {
  const safe = dbName.replace(/[^A-Za-z0-9.-]/gu, (ch) => `_${ch.codePointAt(0)!.toString(16)}_`);
  return `${safe}.db`;
}

/**
 * Remove one mirror from this phone — then read back to prove it is gone. Awaiting
 * {@link MobileEngineDeps.deleteDatabase} proves only that a function returned, which is the
 * evidence the original defect already had (the forget path closed a handle and deleted
 * nothing). The proof is at the store: re-open the same name and ask SQLite's catalog whether
 * the mirror's two tables (`entities`, `meta`) are there. Neither ⇒ the delete landed; either
 * present ⇒ mail survived, and this throws rather than letting a screen say the phone forgot.
 * The second delete is the probe's own litter (opening a deleted name creates it). The caller
 * owns the order: handles closed first, the pending-wipe marker already durable.
 */
/**
 * Does this phone still hold a mirror for this owner? — the sentinel that tells an upgrade
 * from a reinstall. The install-generation marker lives in the app container, which the
 * platform removes with the app; on the first launch of the build that adds the marker there
 * is no marker either, and reading the two as identical would cost every existing user their
 * pairings. An upgrade carries the mirrors of every server that ever synced, a reinstall
 * carries none — answered with the same catalog read `forgetMirror` uses, cleaning up after
 * itself (opening a name creates it). Safe: a genuine reinstall cannot produce a mirror file,
 * and the only names asked about derive from profiles the keystore already holds.
 */
export async function mirrorExists(deps: MobileEngineDeps, ownerKey: string): Promise<boolean> {
  const dbName = mirrorDbName(ownerKey);
  const probe = await deps.openExecutor(dbName);
  let tables: ReadonlyArray<unknown>;
  try {
    tables = await probe.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('entities', 'meta')",
    );
  } finally {
    await probe.close?.();
  }
  if (tables.length > 0) return true;
  // Our own stub: the open above created it. Leaving it would also make the NEXT launch read it
  // as a mirror, turning one absent answer into a permanent present one.
  await deps.deleteDatabase(dbName).catch(() => undefined);
  return false;
}

export async function forgetMirror(deps: MobileEngineDeps, ownerKey: string): Promise<void> {
  const dbName = mirrorDbName(ownerKey);
  await deps.deleteDatabase(dbName);

  const probe = await deps.openExecutor(dbName);
  let survivors: ReadonlyArray<{ name: unknown }>;
  try {
    survivors = (await probe.all(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('entities', 'meta')",
    )) as ReadonlyArray<{ name: unknown }>;
  } finally {
    await probe.close?.();
  }
  await deps.deleteDatabase(dbName).catch(() => undefined);

  if (survivors.length > 0) {
    /* A CODE, not a sentence. `forgetProfile` catches this and hands it to `faultDetail`, which
       words OUR failures and quotes everyone else's — so an English `Error` message here ended
       up frozen inside a German refusal. The detail a developer needs stays in `message`, which
       is what a stack trace shows and what `String(err)` yields if a caller forgets the mapping. */
    throw new StoreFault(
      "mirror_not_deleted",
      `the mail this phone held for ${ownerKey} is still on the device — ` +
        `the mirror database "${dbName}" survived being deleted ` +
        `(${survivors.map((r) => String(r.name)).sort().join(", ")})`,
    );
  }
}

/**
 * The phone keeps a window, not an archive — the browser client's own numbers
 * (`BROWSER_WINDOW` in the webapp's engine-config): the full copy lives on the server or the
 * desktop; search reaches past the window over the wire.
 */
export const MOBILE_WINDOW: StorePolicy = { mode: "windowed", days: 90, minRows: 5000 };

/**
 * The `?types=` filter every mobile drain carries — the cellular rule, stated as this client's
 * complete vocabulary. It is the whole of `SyncEntityType`, written out, and that is the point
 * on both edges: the request is bounded to categories this client can apply (a server that
 * grows new types cannot flood a phone with vocabulary it has no reader for), and nothing the
 * screens render is missing — the precedent to fear is the filter that omitted `tag` and
 * shipped a client whose tags silently never arrived. Prune deliberately, beside the screen
 * change that stops reading a type — never here alone.
 */
export const MOBILE_SYNC_TYPES: string[] = [
  "message", "thread", "routing_decision", "approval",
  "draft", "rule", "message_state", "folder", "tag",
];

/**
 * Ask the server whose bearer this is, where the composition has a route to ask. The typed
 * account id names — and, through the `__owner` stamp, claims — a mirror; the stamp cannot
 * referee the id against the bearer, so account A's token beside account B's id would open B's
 * stamped mirror and drain A's mail into it. Where `GET /auth/session` is mounted it answers
 * the id the bearer resolves to, and a positive mismatch tears the session down — run after
 * going live, behind the rendered UI; the mail on screen in that window is the device's own
 * cached mirror. Only a positive mismatch judges: a 404, an odd answer or a dead network
 * proceed as "unverified" — the drain-time guard below still refuses a cross-account merge.
 */
async function verifyAccountId(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
  origin: string,
  authHeaders: () => Record<string, string>,
  accountId: string,
): Promise<{ kind: "verified" | "unverified" } | { kind: "mismatch"; serverSays: string }> {
  try {
    const res = await fetchImpl(`${origin}/auth/session`, { headers: authHeaders() });
    if (!res.ok) return { kind: "unverified" };
    const body = (await res.json()) as { user?: { accountId?: unknown } };
    const serverSays = body.user?.accountId;
    if (typeof serverSays !== "string" || serverSays === "") return { kind: "unverified" };
    return serverSays === accountId ? { kind: "verified" } : { kind: "mismatch", serverSays };
  } catch {
    return { kind: "unverified" };
  }
}

/**
 * The drain-time half of the account rule: no page whose entities name another account is ever
 * handed to the store. Wire DTOs carry their `accountId`, and this wrapper reads it on every
 * /sync page and every snapshot page before the engine can apply them — so even on a door with
 * no session read, a bearer whose mail belongs to somebody other than the mirror's named owner
 * produces a refused drain (a visible sync error), never a merged mirror. Structured like the
 * webapp's sync gate: the wrapper is the whole surface the engine sees, so every capability is
 * forwarded by hand — an absent forward would silently strip it on the live path only.
 */
type GuardedMobileAdapter = EngineAdapter & Pick<HttpAdapter, "snapshot" | "listMessages">;

function accountGuarded(
  adapter: HttpAdapter,
  accountId: string,
  /**
   * HAS THE IDENTITY VERDICT SETTLED WITHOUT A MISMATCH? The entity check below cannot see
   * every way a wrong-account bearer can move a mirror: a 410 on this mirror's cursor makes
   * the engine wipe and re-bootstrap before one entity arrives, and an empty or delete-only
   * page carries no `accountId` to refuse yet advances the cursor. So the DRAIN routes are
   * held shut until {@link EngineBoot.verifyIdentity} has settled (`verified` and
   * `unverified` both open them; `mismatch` never does) — structural, so a caller that
   * forgets the sequence gets a loud refusal, never a moved mirror. Per-account isolation
   * has two halves here: the owner stamp stops mirror bleed, and this stops cursor bleed.
   */
  cleared: () => boolean,
): GuardedMobileAdapter {
  const HELD = `this mirror's sync is held until the account identity check settles — run verifyIdentity() first`;
  const check = (changes: SyncChange[]): void => {
    for (const ch of changes) {
      const entityAccount = (ch.entity as { accountId?: unknown } | undefined)?.accountId;
      if (typeof entityAccount === "string" && entityAccount !== accountId) {
        throw new StoreFault(
          "account_mismatch",
          `this server is syncing mail for account "${entityAccount}", not "${accountId}" — check the account id you entered`,
        );
      }
    }
  };
  return {
    sync: async (params) => {
      if (!cleared()) throw new StoreFault("sync_held_pre_identity", HELD);
      const resp = await adapter.sync(params);
      check(flattenResponse(resp));
      return resp;
    },
    // Guarded for the same reason `sync` is: the snapshot IS the bootstrap's pages. A refusal
    // on page 1 latches the engine's snapshot-unavailable fallback and the `since=0` drain
    // that follows is guarded above, so nothing merges through either path.
    snapshot: async (params = {}) => {
      if (!cleared()) throw new StoreFault("sync_held_pre_identity", HELD);
      const page = await adapter.snapshot(params);
      check(page.changes);
      return page;
    },
    // Forwarded, not gated — user-intent calls bounded by the act that fires them (the
    // webapp's gate draws the same line). Forwarded BY HAND because this literal is the whole
    // surface the engine sees: a capability missing here is missing on the live path only.
    mutate: (m, opts) => adapter.mutate(m, opts),
    fetchBody: (id) => adapter.fetchBody(id),
    fetchBodies: (ids: string[]) => adapter.fetchBodies(ids),
    searchServer: (query, opts) => adapter.searchServer(query, opts),
    // The worker doorbell (`POST /sync/pull`) — forwarded, not gated, on `mutate`'s rule: it
    // moves no mirror and no cursor, and the connection layer already rings it only inside the
    // clearance continuation (`boot-surface.test.ts` pins guard → ring → drain). This forward
    // is a REPAIR: pull-to-refresh and Sync-now shipped ringing `engine.requestPull()` while
    // this literal — the whole surface the engine sees — omitted the capability, so the engine
    // read "no doorbell", returned null without touching the wire, and every refresh gesture
    // quietly degraded to the mirror drain it had before the doorbell existed. Same defect,
    // same day, same shape as the webapp's sync gate; found live on the webapp's rail control.
    requestPull: () => adapter.requestPull(),
    unsubscribe: (id) => adapter.unsubscribe(id),
    listMessages: adapter.listMessages.bind(adapter),
    listAttachments: (id) => adapter.listAttachments(id),
    fetchAttachment: (id) => adapter.fetchAttachment(id),
    fetchAllAttachments: (id) => adapter.fetchAllAttachments(id),
  };
}

/**
 * Build the engine against a real server — or refuse, out loud. A sqlite mirror that cannot
 * open must surface as an error the user sees, never a silent fallback to `MemoryMirrorStore`:
 * the fallback would "work" while re-bootstrapping the mailbox over the air every launch. The
 * store is loaded here, before any engine exists — `OhmailEngine`'s own `store` default IS a
 * memory mirror. `engine-boot.test.ts` kills the executor and asserts the refusal. The boot
 * never touches the wire (boot-from-local-first): everything awaited is local, the app renders
 * its last known state immediately, and the identity probe is handed back as
 * {@link EngineBoot.verifyIdentity} — safe because the drain-time account check is the guard.
 */
export async function bootEngine(deps: MobileEngineDeps, config: ConnectConfig): Promise<EngineBoot> {
  const origin = normalizeOrigin(config.origin);
  if (!/^https?:\/\/\S+$/.test(origin)) {
    return { kind: "refused", reason: refuse("bootBadOrigin", config.origin) };
  }
  /**
   * THE ADAPTER'S BASE — the measured one, or the origin. See {@link ConnectConfig.apiBase}.
   *
   * Normalized through the SAME function the origin is, so a base and an origin that name one
   * server cannot differ by a trailing slash or by case. Validated with the same shape test and
   * REFUSED rather than silently falling back to the origin: a stored base that is not an address
   * means the profile is describing a server this app cannot compose a request for, and quietly
   * dialling the origin instead would be this file guessing that the operator's proxy has moved
   * back — the exact silent-wrong-answer class the refusal contract above exists to avoid.
   */
  const apiBase = config.apiBase == null || config.apiBase.trim() === ""
    ? origin
    : normalizeOrigin(config.apiBase);
  if (!/^https?:\/\/\S+$/.test(apiBase)) {
    return { kind: "refused", reason: refuse("bootBadApiBase", config.apiBase ?? "") };
  }
  /**
   * The base must be derivable from the origin — a structural invariant. `resolveApiBase` only
   * ever answers the origin or the origin + `/api`, so anything else here came from a corrupted
   * keystore value or a hand-composed caller. The consequence is sharp: this string is
   * `HttpAdapter`'s `baseUrl`, so a foreign value would send the profile's live bearer there on
   * every drain while `origin` and `accountId` stay untouched and every other guard passes. A
   * shape check does not stop that; only comparison against the origin does. A tampered store
   * is not recoverable (the attacker holds the refresh token too), but it must not be a state
   * this app helps. Refused rather than silently corrected, on this file's refusal contract.
   */
  if (apiBase !== origin && apiBase !== `${origin}/api`) {
    return {
      kind: "refused",
      reason: refuse("bootApiBaseOffOrigin", apiBase, origin),
    };
  }
  const local = config.localEngine;
  if (local !== undefined && origin !== LOCAL_ENGINE_ORIGIN) {
    return {
      kind: "refused",
      reason: refuse("bootLocalEngineOffOrigin", LOCAL_ENGINE_ORIGIN, origin),
    };
  }
  const token = config.token?.trim() ?? "";
  const accountId = config.accountId.trim();
  /* The local door mints its own per-launch bearer, so a standalone install needs no credential
     from a caller — it needs an account id, which still keys the mirror. */
  if ((!token && !config.auth && local === undefined) || !accountId) {
    return { kind: "refused", reason: refuse("bootNeedsCredential") };
  }
  // The credential, behind two seams (headers + fetch). The manager supplies both; the
  // static path composes the same shapes from the pasted token, so everything below is one
  // code path and the rotating credential cannot diverge from the tested one.
  /* THE WHOLE TRANSPORT, on the local door: a function call, composed once in
     {@link localEngineTransport} so the app's own reads over the same door cannot differ from this
     adapter's. */
  const localTransport = local !== undefined ? localEngineTransport(local) : null;
  const authHeaders = localTransport !== null
    ? localTransport.headers
    : config.auth?.headers ?? (() => ({ authorization: `Bearer ${token}` }));
  const fetchImpl = localTransport !== null
    ? localTransport.fetch
    : config.auth?.fetch ??
      deps.fetch ??
      (globalThis.fetch.bind(globalThis) as NonNullable<MobileEngineDeps["fetch"]>);

  // The claimed id is checked against the credential wherever the server can be asked — see
  // {@link verifyAccountId} — but NOT here, and not awaited: the probe rides behind the
  // rendered UI (the header's boot-from-local rule). Only a positive mismatch judges; a door
  // with no session read stays "unverified" under the drain-time guard. Any non-mismatch
  // settle OPENS the drain routes (`identityCleared` — the guard above holds them shut until
  // then), so the caller's sequence is verify → drain, and a drain fired early is a loud
  // refusal rather than a mirror a wrong bearer could move.
  /**
   * On the standalone door the probe is already answered, and skipping it is the correct
   * answer, not a shortcut. The probe catches a bearer belonging to a different account than
   * the mirror's key — a remote server's answer against a locally stored id. A standalone
   * install has no remote server: the engine in this runtime minted the bearer for this
   * launch, and there is exactly one account. Running it anyway would hold the drain routes
   * shut for the full eight-second deadline on every launch with no route to answer. The
   * per-entity account guard stays armed either way — the rule every door lives under.
   */
  let identityCleared = local !== undefined;
  const verifyIdentity = async (): Promise<IdentityVerdict> => {
    if (local !== undefined) return { kind: "unverified" };
    // BOUNDED — see {@link IDENTITY_PROBE_DEADLINE_MS}: a probe the server accepts and never
    // answers times out into `unverified` (the timer is cleared when the probe wins).
    const deadline = config.identityDeadlineMs ?? IDENTITY_PROBE_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ kind: "unverified" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "unverified" }), deadline);
    });
    const identity = await Promise.race([
      verifyAccountId(fetchImpl, origin, authHeaders, accountId).finally(() => clearTimeout(timer)),
      timedOut,
    ]);
    if (identity.kind === "mismatch") {
      return {
        kind: "mismatch",
        reason: refuse("bootAccountMismatch", identity.serverSays, accountId),
      };
    }
    identityCleared = true;
    return { kind: identity.kind };
  };

  const ownerKey = mirrorOwnerKey(origin, accountId);
  const store = new SqlMirrorStore({ owner: ownerKey, open: deps.openExecutor });
  try {
    // Open + ownership-bind + hydrate, BEFORE an engine exists. This is the seam where a
    // broken sqlite host surfaces; nothing below runs unless the device's copy is real.
    await store.load();
  } catch (err) {
    store.close();
    return { kind: "refused", reason: refuse("bootMirrorFailed", faultDetail(err)) };
  }

  const engine = new OhmailEngine({
    // The transport, inside the account guard: no page naming another account's mail can
    // reach the store, whatever the door could or could not verify above.
    adapter: accountGuarded(
      new HttpAdapter({
        // THE MEASURED BASE, not the origin — see {@link ConnectConfig.apiBase}. On the hosted
        // service and on a desktop host these are the same string; on a one-origin self-host
        // stack they are not, and the difference is whether this phone ever mirrors a message.
        baseUrl: apiBase,
        // Bearer-only, both directions: the header seam carries the credential (the manager's
        // live copy — stamped per request, so a rotation mid-drain is picked up), and
        // the cookie read is pinned off — there is no document.cookie on Hermes and there must
        // never be a reason to want one (the host-only session cookie is the browser's, not
        // this app's).
        headers: authHeaders,
        getCookie: () => null,
        fetch: fetchImpl,
      }),
      accountId,
      () => identityCleared,
    ),
    store,
    storePolicy: MOBILE_WINDOW,
    // Every drain carries the client's complete type vocabulary — the cellular rule above.
    types: MOBILE_SYNC_TYPES,
    uuid: deps.uuid,
    // No wake signal attached: this build polls /sync. `attachWakeSignal` stays the seam a
    // push wake would feed later.
    //
    // THE HOST OWNS THE OUTBOX REPLAY. This app routes EVERY flush result: `flushQueued`
    // (state/live.ts) reads `pendingMutations()` for each key's kind before flushing, and the
    // world layer toasts the terminal outcomes — a background send confirming announces itself
    // as the send it was, a hard refusal says the save failed. The engine's own drive replay
    // would settle those entries silently, so it is turned off and the post-sync flush cadence
    // (which already runs after every successful drain) is the replay — restored entries
    // included, whose kinds the same ledger reads the same way.
    outboxAutoReplay: false,
  });
  /**
   * RE-ARM THE DURABLE OUTBOX NOW, not at the first drive. The store loaded ABOVE the engine
   * (this file's construction order), so `engine.hydrate()` never runs here and the automatic
   * restore it carries never fires — and the first frame this boot paints must already show a
   * killed session's un-sent verbs (a read marked on the train, the app swiped away). The call
   * is synchronous over the loaded store and idempotent; the verbs themselves replay at the
   * head of the first drive, before its sync pages.
   */
  engine.restoreOutbox();
  return { kind: "ready", engine, store, ownerKey, verifyIdentity };
}
