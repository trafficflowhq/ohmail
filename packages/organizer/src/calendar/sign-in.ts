/**
 * THE SEALED CREDENTIAL, OPENED FOR ONE TURN. The only place a calendar's stored sign-in is
 * decrypted and handed to a request. It is opened after both gates say yes and kept in the turn.
 * The bearer cache holds only short-lived access grants under their current sealed generation.
 *
 * A SEALED TEXT IS READ FOR THE ROW IT WAS FOUND ON AND FOR NO OTHER. The text names the account
 * and the connection it was sealed for; found on another connection's row, this account's or
 * another's, it is no sign-in: nothing is dialled with it, and the connection waits for its person
 * as one whose sign-in is missing does.
 *
 * A PASSWORD IS SENT TO THE SERVER ITS SEALED TEXT NAMES AND TO NO OTHER. The row's `server_url`
 * stands in the clear and is never dialled; a row that names another server than the text does is
 * refused in the same way, so one written column moves no password.
 *
 * Google's and Microsoft's short sign-ins can be reused for later turns under the same seal. Microsoft hands
 * out a new lasting sign-in with every trade: it is sealed again, in its own transaction, before the
 * short one reaches a reader, and only where the stored one is still the one this turn traded with.
 * A stop the trade answered (the consent ended, the registration is missing) is kept for the rest of
 * the turn, so nothing asks again.
 */
import { createHash } from "node:crypto";
import {
  parseCredential, retryAfterMs, Secret, serializeCredential, textOf, toCredential,
  type CalendarProvider, type Clock, type Connection, type Credential, type CredentialPlace, type HttpPort, type HttpResponse, type ProviderRefusal,
  type ProviderWord, type StoredCredential,
} from "@ohmail/cal-providers";
import { renewGoogleAccess } from "@ohmail/cal-providers/google";
import { MS_GRAPH_CALENDAR_SCOPE } from "@ohmail/cal-providers/microsoft";
import {
  OAuthClientRefusedError, OAuthConfigError, OAuthProviderUnavailableError, OAuthReauthRequiredError, refreshAccessToken,
  type FetchLike, type KeyProvider, type MicrosoftClientKind,
} from "@trafficflow/core";
import { and, eq, sql } from "drizzle-orm";
import { calCredentials, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { inConnection, type ConnectionDb, type ConnectionKey, type HeldConnection } from "./connection.js";
import { remember } from "./memory.js";
import type { CalendarOAuth, CalendarSyncMemory } from "./types.js";

/** A short sign-in with less than this left is traded again: a page may take several requests. */
const RENEW_BEFORE_MS = 120_000;

/** The kind of stored credential each provider's connection keeps, and its row's `kind`. */
export const CREDENTIAL_KIND: Readonly<Record<ProviderWord, StoredCredential["kind"]>> = {
  ics: "address", caldav: "basic", google: "oauth", microsoft: "oauth",
};

/** A connection's sealed row, as the gate's transaction read it. Nothing of it is opened there. */
export interface SealedCredential {
  readonly secretEnc: string;
  readonly keyVersion: number;
  readonly meta: unknown;
}

/** The host's key ring could not open a sealed value: the host's fault, never the person's. Nothing is written for it. */
export class CalendarKeyRingFault extends Error {
  constructor() {
    super("a calendar's sealed sign-in could not be opened with this host's keys");
    this.name = "CalendarKeyRingFault";
  }
}

/** The sealed row of a connection's credential, of the kind its provider keeps. */
export async function sealedCredentialOf(tx: Tx, key: ConnectionKey, provider: ProviderWord): Promise<SealedCredential | null> {
  const [row] = await tx.select({ secretEnc: calCredentials.secretEnc, keyVersion: calCredentials.keyVersion, meta: calCredentials.meta })
    .from(calCredentials)
    .where(and(eq(calCredentials.accountId, key.accountId), eq(calCredentials.connectionId, key.id), eq(calCredentials.kind, CREDENTIAL_KIND[provider])))
    .limit(1);
  return row ?? null;
}

/** A refusal a trade answered, as the turn keeps it. */
export interface TradeRefusal {
  readonly reason: ProviderRefusal;
  readonly retryAfterMs: number | null;
}

/** The turn's sign-in: the port's connection, and what the trade said where it said no. */
export interface PassSignIn {
  readonly connection: Connection;
  /** The refusal the last trade answered, or `null`: a provider's refusal that came from the trade, not from its calendar. */
  tradeRefusal(): TradeRefusal | null;
  /** The stored sign-in changed under the turn (a reconnect, another worker's seal): it writes nothing more. */
  superseded(): boolean;
  /** Is the turn still using the stored generation? Checked under the credential row's share lock. */
  stillStored(tx: Tx): Promise<boolean>;
  /** Opaque identity of the current encrypted envelope, for resuming a reading. */
  generation(): string;
  /** Drop a refused resource bearer. True when the turn had reused a bearer from an earlier exchange. */
  dropBearer(): boolean;
}

export interface SignInDeps {
  readonly keys: KeyProvider;
  readonly clock: Clock;
  readonly oauth: CalendarOAuth;
  readonly memory: CalendarSyncMemory;
}

interface CachedGrant {
  readonly token: string;
  readonly expiresAtMs: number;
  readonly generation: string;
}

type RefreshResult = ({ readonly ok: true; readonly grant: CachedGrant; readonly rotated: Secret | null }
  | { readonly ok: false; readonly superseded?: true } & TradeRefusal);

export interface CalendarBearers {
  readonly grants: Map<string, CachedGrant>;
  readonly refreshing: Map<string, Promise<RefreshResult>>;
}

const bearerKey = (key: ConnectionKey): string => `${key.accountId}:${key.id}`;
export function forgetCalendarBearer(memory: CalendarSyncMemory, key: ConnectionKey): void {
  memory.bearers.grants.delete(bearerKey(key));
}

/** The turn's handle and connection, for the seal's own transaction. */
export interface SealPlace {
  readonly db: ConnectionDb;
  readonly key: ConnectionKey;
}

const generationOf = (sealed: { readonly keyVersion: number; readonly secretEnc: string }): string =>
  createHash("sha256").update(`${sealed.keyVersion}:${sealed.secretEnc}`).digest("hex");

/** The row a turn's sealed text must name to be this connection's: the turn's own key, never anything the row or a provider said. */
const placeOf = (key: ConnectionKey): CredentialPlace => ({ accountId: key.accountId, connectionId: key.id });

/** The credential row under lock, opened, or `null` when it is gone or opens to nothing. */
async function lockedOpened(tx: Tx, deps: SignInDeps, key: ConnectionKey, provider: ProviderWord, generation: string): Promise<string | null> {
  const [row] = await dialect(tx).forUpdate(tx.select({ secretEnc: calCredentials.secretEnc, keyVersion: calCredentials.keyVersion })
    .from(calCredentials)
    .where(and(eq(calCredentials.accountId, key.accountId), eq(calCredentials.connectionId, key.id), eq(calCredentials.kind, CREDENTIAL_KIND[provider])))
    .limit(1), { mode: "update" });
  if (row === undefined || generationOf(row) !== generation) return null;
  try {
    return await deps.keys.decrypt(row.secretEnc, row.keyVersion);
  } catch {
    // Not opened, so not the one this turn holds: nothing is written over it.
    return null;
  }
}

/** Microsoft's sign-in details beside the sealed text: the tenant and the door it was issued through. */
function microsoftMeta(meta: unknown): { readonly tenant: string | null; readonly clientKind: MicrosoftClientKind } {
  const m = meta !== null && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
  return {
    tenant: typeof m.tenant === "string" && m.tenant !== "" ? m.tenant : null,
    clientKind: m.clientKind === "public" ? "public" : "confidential",
  };
}

/** A trade's refusal that ends the turn and is never asked again in it. */
const STOPS: ReadonlySet<ProviderRefusal> = new Set(["consent_needed", "sign_in_refused", "sign_in_incomplete", "provider_off"]);

/**
 * Open the sealed credential for this turn. `null` sealed, a text that opens to nothing, a text
 * sealed for another row, a password sealed for another server than the row names, or a kind that
 * does not fit the provider is `sign_in_incomplete`: the person connects again. A key ring that
 * cannot open the value throws {@link CalendarKeyRingFault}, and nothing is written for it.
 */
export async function openPassSignIn(
  deps: SignInDeps, place: SealPlace, sealed: SealedCredential | null, held: HeldConnection,
  word: ProviderWord, provider: CalendarProvider,
): Promise<{ readonly ok: true; readonly signIn: PassSignIn } | { readonly ok: false; readonly word: "sign_in_incomplete" | "provider_off" }> {
  if (sealed === null) return { ok: false, word: "sign_in_incomplete" };
  let text: string;
  try {
    text = await deps.keys.decrypt(sealed.secretEnc, sealed.keyVersion);
  } catch {
    throw new CalendarKeyRingFault();
  }
  const stored = parseCredential(text, placeOf(place.key));
  let generation = generationOf(sealed);
  if (stored === null || stored.kind !== CREDENTIAL_KIND[word]) return { ok: false, word: "sign_in_incomplete" };

  let refusal: TradeRefusal | null = null;
  let stop: TradeRefusal | null = null;
  let superseded = false;
  let used: CachedGrant | undefined;
  let reused = false;
  const cache = deps.memory.bearers;
  const cacheKey = bearerKey(place.key);
  const stillStored = async (tx: Tx) => {
    const [current] = await dialect(tx).forUpdate(tx.select({
      secretEnc: calCredentials.secretEnc, keyVersion: calCredentials.keyVersion,
    }).from(calCredentials).where(and(eq(calCredentials.accountId, place.key.accountId), eq(calCredentials.connectionId, place.key.id),
      eq(calCredentials.kind, CREDENTIAL_KIND[word]))).limit(1), { mode: "share" });
    if (current === undefined || generationOf(current) !== generation) superseded = true;
    return !superseded;
  };
  /** A bearer that keeps a stop for the rest of the turn and remembers the trade's last refusal. */
  const keeping = (inner: Extract<Credential, { kind: "bearer" }>): Credential => ({
    kind: "bearer",
    async accessToken(signal) {
      if (stop !== null) return { ok: false, reason: stop.reason, retryAfterMs: stop.retryAfterMs };
      const a = await inner.accessToken(signal);
      if (a.ok) {
        refusal = null;
        return a;
      }
      refusal = { reason: a.reason, retryAfterMs: a.retryAfterMs };
      if (STOPS.has(a.reason) || superseded) stop = refusal;
      return a;
    },
  });

  let credential: Credential;
  let start: string | null = null;
  if (stored.kind === "address") {
    credential = toCredential(stored);
  } else if (stored.kind === "basic") {
    // CalDAV's typed address is needed at every call: the hosts the password may travel to are worked out from it. It
    // is THE SEALED TEXT's server that is dialled, never the row's: the row's stands in the clear, and one that is not
    // the server this password was sealed for (another address written there, or none) holds no sign-in of its own.
    if (stored.server !== held.serverUrl) return { ok: false, word: "sign_in_incomplete" };
    credential = toCredential(stored);
    start = stored.server;
  } else if (stored.provider !== word) {
    return { ok: false, word: "sign_in_incomplete" };
  } else {
    const client = deps.oauth.google;
    const resolve = deps.oauth.microsoft;
    if (word === "google"
      ? client === null || client.clientId === "" || client.clientSecret === ""
      : resolve === null) return { ok: false, word: "provider_off" };
    let lasting = stored.refreshToken;
    const meta = microsoftMeta(sealed.meta);
    const refresh = async (signal: AbortSignal): Promise<RefreshResult> => {
      const traded = word === "google" && client !== null
        ? await renewGoogleAccess({ http: provider.http, clock: deps.clock }, {
          client: { id: client.clientId, secret: new Secret(client.clientSecret) }, refreshToken: lasting,
        }, signal).then((a) => a.ok ? { ok: true as const, ...a.value, rotated: null } : a)
        : await tradeMicrosoftCalendar(resolve!, provider.http, lasting, meta, deps.clock, signal);
      if (!traded.ok) return traded;
      if (traded.rotated !== null) {
        const sealedNow = await sealRotated(deps, place, word, lasting, traded.rotated, generation);
        if (sealedNow === "superseded") return { ok: false, superseded: true, reason: "unknown", retryAfterMs: null };
        if (sealedNow.kind === "sealed") generation = sealedNow.generation;
      } else if (await inConnection(place.db, place.key, ({ tx }) => stillStored(tx)) !== true) {
        return { ok: false, superseded: true, reason: "unknown", retryAfterMs: null };
      }
      const grant = { token: traded.token, expiresAtMs: traded.expiresAtMs, generation };
      if (grant.expiresAtMs - RENEW_BEFORE_MS > deps.clock.now()) remember(cache.grants, cacheKey, grant);
      return { ok: true, grant, rotated: traded.rotated };
    };
    credential = keeping({
      kind: "bearer",
      async accessToken(signal) {
        const cached = cache.grants.get(cacheKey);
        const held = used ?? cached;
        if (held?.generation === generation && deps.clock.now() < held.expiresAtMs - RENEW_BEFORE_MS) {
          if (used === undefined) reused = true;
          used = held;
          return { ok: true, token: held.token };
        }
        if (cached !== undefined && (cached.generation === generation || cached.expiresAtMs <= deps.clock.now())) cache.grants.delete(cacheKey);
        const refreshing = `${cacheKey}:${generation}`;
        let pending = cache.refreshing.get(refreshing);
        if (pending === undefined) {
          pending = refresh(signal).finally(() => cache.refreshing.delete(refreshing));
          cache.refreshing.set(refreshing, pending);
        }
        const result = await pending;
        if (!result.ok) {
          if (result.superseded) superseded = true;
          return result;
        }
        generation = result.grant.generation;
        lasting = result.rotated ?? lasting;
        used = result.grant;
        reused = false;
        return { ok: true, token: used.token };
      },
    });
  }
  return {
    ok: true,
    signIn: {
      connection: { provider: word, credential, start },
      tradeRefusal: () => refusal,
      superseded: () => superseded,
      generation: () => generation,
      stillStored,
      dropBearer() {
        if (cache.grants.get(cacheKey) === used) cache.grants.delete(cacheKey);
        used = undefined;
        return reused;
      },
    },
  };
}

/** `fetch` for the mail core's trade, over the provider's own request port and nothing else. */
export function fetchOver(http: HttpPort, signal: AbortSignal, received?: (response: HttpResponse) => void): FetchLike {
  return async (url, init) => {
    const headers: { "content-type"?: string; accept?: string } = {};
    for (const [name, value] of Object.entries(init.headers)) {
      const lower = name.toLowerCase();
      if (lower === "content-type" || lower === "accept") headers[lower] = value;
      else throw new Error("a header the request port does not carry");
    }
    const answer = await http.request(url, { method: "POST", headers, body: init.body, auth: null, validators: null, signal });
    // The trade reads a thrown fetch as "we could not ask": the word only, never an address.
    if (!answer.arrived) throw new Error(answer.reason);
    received?.(answer);
    const text = textOf(answer.body);
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      json: async () => JSON.parse(text) as unknown,
      text: async () => text,
    };
  };
}

type Traded =
  | { readonly ok: true; readonly token: string; readonly expiresAtMs: number; readonly rotated: Secret | null }
  | ({ readonly ok: false } & TradeRefusal);

/**
 * Microsoft's lasting sign-in traded for a short one, with the calendar's permission and no other:
 * the scope is fixed here, the endpoint is derived from the tenant, and the way out is the
 * provider's request port. Outside every transaction.
 */
export async function tradeMicrosoftCalendar(
  resolve: NonNullable<CalendarOAuth["microsoft"]>, http: HttpPort, lasting: Secret,
  meta: { readonly tenant: string | null; readonly clientKind: MicrosoftClientKind }, clock: Clock, signal: AbortSignal,
): Promise<Traded> {
  const metadata: { throttled?: TradeRefusal } = {};
  try {
    const reg = await resolve(meta.clientKind);
    if (reg.clientId === "" || (meta.clientKind === "confidential" && reg.clientSecret === "")) {
      return { ok: false, reason: "provider_off", retryAfterMs: null };
    }
    const result = await refreshAccessToken({
      refreshToken: lasting.reveal(),
      tenant: meta.tenant ?? reg.defaultTenant ?? "common",
      clientId: reg.clientId,
      ...(meta.clientKind === "confidential" ? { clientSecret: reg.clientSecret } : {}),
      clientKind: meta.clientKind,
      scope: MS_GRAPH_CALENDAR_SCOPE,
      fetch: fetchOver(http, signal, (response) => {
        if (response.status === 429) metadata.throttled = { reason: "throttled", retryAfterMs: retryAfterMs(response, clock) };
      }),
    }, () => clock.now());
    return {
      ok: true, token: result.accessToken, expiresAtMs: result.expiresAtMs,
      rotated: result.refreshToken === undefined ? null : new Secret(result.refreshToken),
    };
  } catch (err) {
    if (metadata.throttled !== undefined) return { ok: false, ...metadata.throttled };
    if (err instanceof OAuthReauthRequiredError) return { ok: false, reason: "consent_needed", retryAfterMs: null };
    // Our own registration refused, or Microsoft's trouble: this deployment's to mend, never the person's sign-in.
    if (err instanceof OAuthClientRefusedError || err instanceof OAuthProviderUnavailableError) return { ok: false, reason: "unavailable", retryAfterMs: null };
    if (err instanceof OAuthConfigError) return { ok: false, reason: "provider_off", retryAfterMs: null };
    throw err;
  }
}

/**
 * Microsoft's new lasting sign-in, sealed again in its own transaction: the credential row under
 * lock, opened, and written over only where it still holds the one this turn traded with. A
 * reconnect or another worker's seal ends the turn. The new envelope is opened again before it is kept.
 */
async function sealRotated(
  deps: SignInDeps, place: SealPlace, word: ProviderWord, traded: Secret, rotated: Secret, generation: string,
): Promise<"superseded" | { readonly kind: "sealed"; readonly generation: string } | { readonly kind: "kept" }> {
  const done = await inConnection(place.db, place.key, async ({ tx }) => {
    const now = await lockedOpened(tx, deps, place.key, word, generation);
    const stored = now === null ? null : parseCredential(now, placeOf(place.key));
    if (stored === null || stored.kind !== "oauth" || stored.refreshToken.reveal() !== traded.reveal()) return "superseded" as const;
    const text = serializeCredential({ kind: "oauth", provider: stored.provider, refreshToken: rotated }, placeOf(place.key));
    if (text === null) return { kind: "kept" } as const;
    const envelope = await deps.keys.encrypt(text);
    if (await deps.keys.decrypt(envelope.ciphertext, envelope.keyVersion) !== text) throw new CalendarKeyRingFault();
    await tx.update(calCredentials).set({ secretEnc: envelope.ciphertext, keyVersion: envelope.keyVersion, updatedAt: sql`now()` })
      .where(and(eq(calCredentials.accountId, place.key.accountId), eq(calCredentials.connectionId, place.key.id), eq(calCredentials.kind, "oauth")));
    return { kind: "sealed", generation: generationOf({ secretEnc: envelope.ciphertext, keyVersion: envelope.keyVersion }) } as const;
  });
  return done === "gone" ? "superseded" : done;
}
