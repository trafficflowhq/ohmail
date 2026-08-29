/**
 * THE ENGINE COMPOSITION FOR THIS APP — how a real `OhmailEngine` is built on React Native.
 *
 * Everything platform-shaped is INJECTED through {@link MobileEngineDeps}: the app's screens
 * hand in `nativeEngineDeps()` (expo-sqlite, expo-crypto — see `native.ts`), the test suite
 * hands in `node:sqlite` and a counter. This module itself imports nothing from Expo or React
 * Native, which is what lets the repo's node-side suite drive the whole composition — store,
 * adapter, engine — without a device.
 *
 * The engine is NOT forked for RN — that is this app's hard line. It is the same
 * `OhmailEngine` the browser and desktop run, adapted at its published seams:
 *
 *  - **store**: `SqlMirrorStore` over the injected executor — the phone's IndexedDB;
 *  - **uuid**: the engine's `uuid` option. Hermes has no `crypto.randomUUID`, so the default
 *    seam would throw at the first mutation; the injected generator (expo-crypto) is a real
 *    RFC 4122 v4, which the mutation queue's Idempotency-Keys require;
 *  - **fetch**: RN's global fetch, through `HttpAdapter`'s own default binding. No CORS and no
 *    secure-context gate exist in RN fetch, which is exactly what makes the plain-http LAN
 *    desktop-host door reachable from the app;
 *  - **cookies**: none. Mobile is bearer-only — the `Authorization` header rides
 *    `HttpAdapter`'s `headers` seam, and `getCookie` is pinned to `null` so nothing ever
 *    consults a cookie jar that does not exist;
 *  - **EventSource**: OFF. This build polls `/sync` (foreground + pull-to-refresh); the
 *    engine's `attachWakeSignal` attach point is simply never called. It is the seam a push
 *    wake would feed later.
 */
import {
  HttpAdapter,
  OhmailEngine,
  SqlMirrorStore,
  flattenResponse,
  type EngineAdapter,
  type SqlExecutor,
  type StorePolicy,
  type SyncChange,
} from "@ohmail/client-engine";

/** What the platform must provide — expo modules in the app, node modules in tests. */
export interface MobileEngineDeps {
  /**
   * Open (creating if needed) the named mirror database. The name is
   * `mirrorDbName(ownerKey)`-shaped; the opener decides what a database physically is
   * (an expo-sqlite file, a node:sqlite handle).
   */
  openExecutor: (dbName: string) => SqlExecutor | Promise<SqlExecutor>;
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

/** What the pairing seam — or the tests, over a static token — supplies. */
export interface ConnectConfig {
  /** `https://mail.example.org`, `http://192.168.1.20:8028`, … — no trailing slash needed. */
  origin: string;
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
  | { kind: "mismatch"; reason: string };

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
  | { kind: "refused"; reason: string };

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
 * A mirror database name as a filename a storage engine will take — INJECTIVE, or it is a leak.
 *
 * Owner keys carry an origin, so they hold `:` and `/`; a lossy sanitizer (`[^\w.-] → "-"`)
 * mapped `http://a-123::acct` and `http://a:123::acct` onto ONE file, and the `__owner` stamp
 * only referees SEQUENTIAL opens — with two live handles on one collided file, either engine can
 * write after the other's check and one server's mail ends up under the other's stamp. So every
 * character outside a conservative set (the escape character `_` included) is encoded as
 * `_<hex>_` of its code point: distinct names cannot meet, decoding is unambiguous, and the
 * result stays a portable filename. Lives here rather than in `native.ts` so the node suite can
 * hold the injectivity, and so every platform half names files the same way.
 */
export function dbFileName(dbName: string): string {
  const safe = dbName.replace(/[^A-Za-z0-9.-]/gu, (ch) => `_${ch.codePointAt(0)!.toString(16)}_`);
  return `${safe}.db`;
}

/**
 * The phone keeps a window, not an archive — the browser client's own numbers
 * (`BROWSER_WINDOW` in the webapp's engine-config): the full copy lives on the server or the
 * desktop; search reaches past the window over the wire.
 */
export const MOBILE_WINDOW: StorePolicy = { mode: "windowed", days: 90, minRows: 5000 };

/**
 * THE `?types=` FILTER EVERY MOBILE DRAIN CARRIES — the cellular rule (a cold connect uses
 * `?types=` + the windowed bootstrap), stated as this client's COMPLETE vocabulary.
 *
 * It is the whole of `SyncEntityType`, written out, and that is the point on both edges: the
 * request is bounded to categories this client can apply (a server that grows new types cannot
 * flood a phone with vocabulary it has no reader for), and nothing the screens will render is
 * missing — the precedent to fear is the filter that OMITTED `tag` and shipped a client whose
 * tags silently never arrived. Prune deliberately, beside the screen change that stops reading
 * a type — never here alone.
 */
export const MOBILE_SYNC_TYPES: string[] = [
  "message", "thread", "routing_decision", "approval",
  "draft", "rule", "message_state", "folder", "tag",
];

/**
 * ASK THE SERVER WHOSE BEARER THIS IS, where the composition has a route to ask.
 *
 * The typed account id names — and, through the `__owner` stamp, CLAIMS — a mirror database.
 * The stamp referees databases against each other; it cannot referee the id against the BEARER,
 * so account A's token entered beside account B's previously-used id would open B's stamped
 * mirror legitimately and then try to drain A's mail into it. Where `GET /auth/session` is
 * mounted (the standalone server), it answers the account id the bearer resolves to — the
 * exact read the browser client names its mirror by — and a POSITIVE mismatch ends the
 * session: the caller runs this AFTER going live (boot-from-local, the boot header) and tears
 * the session down on the mismatch verdict. The mail on screen in that round-trip window is
 * the device's own cached mirror for the named profile — never anything the mismatched bearer
 * delivered, because the drain-time guard below refuses its pages.
 *
 * Only a positive mismatch judges. The desktop-host door mounts no session read (404), an old
 * server may answer anything, and a dead network answers nothing — all of those proceed as
 * "unverified", because the drain-time guard below still refuses a cross-account MERGE, and a
 * judgment here on a route that merely does not exist would brick the one door this app can
 * reach over a LAN.
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
 * THE DRAIN-TIME HALF of the account rule: no page whose entities name ANOTHER account is ever
 * handed to the store.
 *
 * Wire DTOs carry their `accountId`, and this wrapper reads it on every /sync page and every
 * snapshot page BEFORE the engine can apply them — so even on a door with no session read, a
 * bearer whose mail belongs to somebody other than the mirror's named owner produces a refused
 * drain (a visible sync error), never a merged mirror. Structured like the webapp's sync gate:
 * the wrapper IS the whole surface the engine sees, so every capability is forwarded by hand —
 * an absent forward would silently strip it on the live path only.
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
        throw new Error(
          `this server is syncing mail for account "${entityAccount}", not "${accountId}" — check the account id you entered`,
        );
      }
    }
  };
  return {
    sync: async (params) => {
      if (!cleared()) throw new Error(HELD);
      const resp = await adapter.sync(params);
      check(flattenResponse(resp));
      return resp;
    },
    // Guarded for the same reason `sync` is: the snapshot IS the bootstrap's pages. A refusal
    // on page 1 latches the engine's snapshot-unavailable fallback and the `since=0` drain
    // that follows is guarded above, so nothing merges through either path.
    snapshot: async (params = {}) => {
      if (!cleared()) throw new Error(HELD);
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
    unsubscribe: (id) => adapter.unsubscribe(id),
    listMessages: adapter.listMessages.bind(adapter),
    listAttachments: (id) => adapter.listAttachments(id),
    fetchAttachment: (id) => adapter.fetchAttachment(id),
    fetchAllAttachments: (id) => adapter.fetchAllAttachments(id),
  };
}

/**
 * Build the engine against a real server — or REFUSE, out loud.
 *
 * ── THE REFUSAL IS THE CONTRACT ─────────────────────────────────────────────────────────────
 *
 * A sqlite mirror that cannot open must surface as an error state the user sees — NEVER as a
 * silent fallback to `MemoryMirrorStore`. The fallback would "work": the engine boots, mail
 * renders, and the app has quietly become a cold mirror that re-bootstraps the whole mailbox
 * over the air on every launch and forgets the cursor on every kill — a dangerous default
 * standing in for a missing store. That is why the store is loaded HERE, before any
 * engine exists — `OhmailEngine`'s own `store` default IS a memory mirror, so an engine
 * constructed before the store proved itself would be one `?? new MemoryMirrorStore()` away
 * from the exact failure this refusal exists to prevent. `engine-boot.test.ts` kills the
 * executor and asserts the refusal; reinstating a silent fallback turns that test red.
 *
 * ── AND THE BOOT NEVER TOUCHES THE WIRE (boot-from-local-first, owner feedback 2026-08) ────
 *
 * This function used to await `GET /auth/session` before opening the mirror, which put a
 * network round trip — on a cold launch, THREE: the probe, the 401's rotation, the replay —
 * in front of the first rendered frame. That is the "connecting to mailbox" hold the owner
 * killed: the phone's own mirror was sitting on disk the whole time. Now everything awaited
 * here is local (keystore-shaped validation + the sqlite open/hydrate), the app renders its
 * last known state immediately, and the identity probe is handed back as
 * {@link EngineBoot.verifyIdentity} for the connection layer to run BEHIND the rendered UI.
 *
 * Deferring the probe does not open the cross-account hole the old ordering guarded, because
 * that ordering was never the guard — the drain-time account check below is: no /sync or
 * snapshot page naming another account can reach the store, probe or no probe. What the
 * deferral trades is WHERE a positive mismatch surfaces — as a background teardown one round
 * trip after first paint, instead of a pre-paint refusal — and what it buys is a first frame
 * that owes the network nothing. `engine-boot.test.ts` pins both halves: a boot that resolves
 * while /auth/session hangs forever, and a drain that still refuses a foreign account's pages.
 */
export async function bootEngine(deps: MobileEngineDeps, config: ConnectConfig): Promise<EngineBoot> {
  const origin = normalizeOrigin(config.origin);
  if (!/^https?:\/\/\S+$/.test(origin)) {
    return { kind: "refused", reason: `not a server origin: "${config.origin}"` };
  }
  const token = config.token?.trim() ?? "";
  const accountId = config.accountId.trim();
  if ((!token && !config.auth) || !accountId) {
    return { kind: "refused", reason: "a credential and an account id are both required" };
  }
  // The credential, behind two seams (headers + fetch). The manager supplies both; the
  // static path composes the same shapes from the pasted token, so everything below is one
  // code path and the rotating credential cannot diverge from the tested one.
  const authHeaders = config.auth?.headers ?? (() => ({ authorization: `Bearer ${token}` }));
  const fetchImpl =
    config.auth?.fetch ??
    deps.fetch ??
    (globalThis.fetch.bind(globalThis) as NonNullable<MobileEngineDeps["fetch"]>);

  // The claimed id is checked against the credential wherever the server can be asked — see
  // {@link verifyAccountId} — but NOT here, and not awaited: the probe rides behind the
  // rendered UI (the header's boot-from-local rule). Only a positive mismatch judges; a door
  // with no session read stays "unverified" under the drain-time guard. Any non-mismatch
  // settle OPENS the drain routes (`identityCleared` — the guard above holds them shut until
  // then), so the caller's sequence is verify → drain, and a drain fired early is a loud
  // refusal rather than a mirror a wrong bearer could move.
  let identityCleared = false;
  const verifyIdentity = async (): Promise<IdentityVerdict> => {
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
        reason: `this bearer belongs to account "${identity.serverSays}", not "${accountId}" — check the account id you entered`,
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
    return { kind: "refused", reason: `the on-device mirror could not open: ${String(err)}` };
  }

  const engine = new OhmailEngine({
    // The transport, inside the account guard: no page naming another account's mail can
    // reach the store, whatever the door could or could not verify above.
    adapter: accountGuarded(
      new HttpAdapter({
        baseUrl: origin,
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
