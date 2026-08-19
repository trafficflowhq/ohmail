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
}

export type EngineBoot =
  | { kind: "ready"; engine: OhmailEngine; store: SqlMirrorStore; ownerKey: string }
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
 * mirror legitimately and then drain A's mail into it. Where `GET /auth/session` is mounted
 * (the standalone server), it answers the account id the bearer resolves to — the exact read
 * the browser client names its mirror by — and a POSITIVE mismatch refuses the boot.
 *
 * Only a positive mismatch refuses. The desktop-host door mounts no session read (404), an old
 * server may answer anything, and a dead network answers nothing — all of those proceed as
 * "unverified", because the drain-time guard below still refuses a cross-account MERGE, and a
 * refusal here on a route that merely does not exist would brick the one door this app can
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

function accountGuarded(adapter: HttpAdapter, accountId: string): GuardedMobileAdapter {
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
      const resp = await adapter.sync(params);
      check(flattenResponse(resp));
      return resp;
    },
    // Guarded for the same reason `sync` is: the snapshot IS the bootstrap's pages. A refusal
    // on page 1 latches the engine's snapshot-unavailable fallback and the `since=0` drain
    // that follows is guarded above, so nothing merges through either path.
    snapshot: async (params = {}) => {
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
  // {@link verifyAccountId}. Only a positive mismatch refuses; a door with no session read
  // proceeds under the drain-time guard instead.
  const identity = await verifyAccountId(fetchImpl, origin, authHeaders, accountId);
  if (identity.kind === "mismatch") {
    return {
      kind: "refused",
      reason: `this bearer belongs to account "${identity.serverSays}", not "${accountId}" — the mirror is not opened`,
    };
  }

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
    ),
    store,
    storePolicy: MOBILE_WINDOW,
    // Every drain carries the client's complete type vocabulary — the cellular rule above.
    types: MOBILE_SYNC_TYPES,
    uuid: deps.uuid,
    // No wake signal attached: this build polls /sync. `attachWakeSignal` stays the seam a
    // push wake would feed later.
  });
  return { kind: "ready", engine, store, ownerKey };
}
