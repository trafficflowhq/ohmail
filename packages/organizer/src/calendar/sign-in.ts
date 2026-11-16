/**
 * THE SEALED CREDENTIAL, OPENED FOR ONE TURN. The only place a calendar's stored sign-in is
 * decrypted, read and handed to a request: opened after both gates said yes, kept in one object
 * that is unreachable once the turn returns, and never written to a log, an error, an outcome or
 * any column but its own sealed one.
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
 * Google's and Microsoft's lasting sign-ins are traded for a short one once a turn. Microsoft hands
 * out a new lasting sign-in with every trade: it is sealed again, in its own transaction, before the
 * short one reaches a reader, and only where the stored one is still the one this turn traded with.
 * A stop the trade answered (the consent ended, the registration is missing) is kept for the rest of
 * the turn, so nothing asks again.
 */
import { createHash } from "node:crypto";
import {
  parseCredential, Secret, serializeCredential, textOf, toCredential,
  type CalendarProvider, type Clock, type Connection, type Credential, type CredentialPlace, type HttpPort, type ProviderRefusal,
  type ProviderWord, type StoredCredential,
} from "@ohmail/cal-providers";
import { googleBearer } from "@ohmail/cal-providers/google";
import { MS_GRAPH_CALENDAR_SCOPE } from "@ohmail/cal-providers/microsoft";
import {
  OAuthClientRefusedError, OAuthConfigError, OAuthProviderUnavailableError, OAuthReauthRequiredError, refreshAccessToken,
  type FetchLike, type KeyProvider, type MicrosoftClientKind,
} from "@trafficflow/core";
import { and, eq, sql } from "drizzle-orm";
import { calCredentials, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { inConnection, type ConnectionDb, type ConnectionKey, type HeldConnection } from "./connection.js";
import type { CalendarOAuth } from "./types.js";

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
  /** Is the stored credential still the one this turn opened? Asked under the credential row's lock before a stop is written. */
  stillStored(tx: Tx): Promise<boolean>;
}

export interface SignInDeps {
  readonly keys: KeyProvider;
  readonly clock: Clock;
  readonly oauth: CalendarOAuth;
}

/** The turn's handle and connection, for the seal's own transaction. */
export interface SealPlace {
  readonly db: ConnectionDb;
  readonly key: ConnectionKey;
}

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The row a turn's sealed text must name to be this connection's: the turn's own key, never anything the row or a provider said. */
const placeOf = (key: ConnectionKey): CredentialPlace => ({ accountId: key.accountId, connectionId: key.id });

/** The credential row under lock, opened, or `null` when it is gone or opens to nothing. */
async function lockedOpened(tx: Tx, deps: SignInDeps, key: ConnectionKey, provider: ProviderWord): Promise<string | null> {
  const [row] = await dialect(tx).forUpdate(tx.select({ secretEnc: calCredentials.secretEnc, keyVersion: calCredentials.keyVersion })
    .from(calCredentials)
    .where(and(eq(calCredentials.accountId, key.accountId), eq(calCredentials.connectionId, key.id), eq(calCredentials.kind, CREDENTIAL_KIND[provider])))
    .limit(1), { mode: "update" });
  if (row === undefined) return null;
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
  let opened = digestOf(text);
  if (stored === null || stored.kind !== CREDENTIAL_KIND[word]) return { ok: false, word: "sign_in_incomplete" };

  let refusal: TradeRefusal | null = null;
  let stop: TradeRefusal | null = null;
  let superseded = false;
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
  } else if (word === "google") {
    const client = deps.oauth.google;
    if (client === null || client.clientId === "" || client.clientSecret === "") return { ok: false, word: "provider_off" };
    const bearer = googleBearer({ http: provider.http, clock: deps.clock }, {
      client: { id: client.clientId, secret: new Secret(client.clientSecret) }, refreshToken: stored.refreshToken,
    }) as Extract<Credential, { kind: "bearer" }>;
    credential = keeping(bearer);
  } else {
    const resolve = deps.oauth.microsoft;
    if (resolve === null) return { ok: false, word: "provider_off" };
    let lasting = stored.refreshToken;
    let access: { token: string; expiresAtMs: number } | null = null;
    const meta = microsoftMeta(sealed.meta);
    credential = keeping({
      kind: "bearer",
      async accessToken(signal) {
        if (access !== null && deps.clock.now() < access.expiresAtMs - RENEW_BEFORE_MS) return { ok: true, token: access.token };
        access = null;
        const traded = await tradeMicrosoftCalendar(resolve, provider.http, lasting, meta, deps.clock, signal);
        if (!traded.ok) return { ok: false, reason: traded.reason, retryAfterMs: null };
        if (traded.rotated !== null) {
          const sealedNow = await sealRotated(deps, place, word, lasting, traded.rotated);
          if (sealedNow === "superseded") {
            superseded = true;
            return { ok: false, reason: "unknown", retryAfterMs: null };
          }
          if (sealedNow.kind === "sealed") {
            lasting = traded.rotated;
            opened = sealedNow.digest;
          }
        }
        access = { token: traded.token, expiresAtMs: traded.expiresAtMs };
        return { ok: true, token: traded.token };
      },
    });
  }
  return {
    ok: true,
    signIn: {
      connection: { provider: word, credential, start },
      tradeRefusal: () => refusal,
      superseded: () => superseded,
      async stillStored(tx) {
        const now = await lockedOpened(tx, deps, place.key, word);
        return now !== null && digestOf(now) === opened;
      },
    },
  };
}

/** `fetch` for the mail core's trade, over the provider's own request port and nothing else. */
export function fetchOver(http: HttpPort, signal: AbortSignal): FetchLike {
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
  | { readonly ok: false; readonly reason: ProviderRefusal };

/**
 * Microsoft's lasting sign-in traded for a short one, with the calendar's permission and no other:
 * the scope is fixed here, the endpoint is derived from the tenant, and the way out is the
 * provider's request port. Outside every transaction.
 */
export async function tradeMicrosoftCalendar(
  resolve: NonNullable<CalendarOAuth["microsoft"]>, http: HttpPort, lasting: Secret,
  meta: { readonly tenant: string | null; readonly clientKind: MicrosoftClientKind }, clock: Clock, signal: AbortSignal,
): Promise<Traded> {
  try {
    const reg = await resolve(meta.clientKind);
    if (reg.clientId === "" || (meta.clientKind === "confidential" && reg.clientSecret === "")) return { ok: false, reason: "provider_off" };
    const result = await refreshAccessToken({
      refreshToken: lasting.reveal(),
      tenant: meta.tenant ?? reg.defaultTenant ?? "common",
      clientId: reg.clientId,
      ...(meta.clientKind === "confidential" ? { clientSecret: reg.clientSecret } : {}),
      clientKind: meta.clientKind,
      scope: MS_GRAPH_CALENDAR_SCOPE,
      fetch: fetchOver(http, signal),
    }, () => clock.now());
    return {
      ok: true, token: result.accessToken, expiresAtMs: result.expiresAtMs,
      rotated: result.refreshToken === undefined ? null : new Secret(result.refreshToken),
    };
  } catch (err) {
    if (err instanceof OAuthReauthRequiredError) return { ok: false, reason: "consent_needed" };
    // Our own registration refused, or Microsoft's trouble: this deployment's to mend, never the person's sign-in.
    if (err instanceof OAuthClientRefusedError || err instanceof OAuthProviderUnavailableError) return { ok: false, reason: "unavailable" };
    if (err instanceof OAuthConfigError) return { ok: false, reason: "provider_off" };
    throw err;
  }
}

/**
 * Microsoft's new lasting sign-in, sealed again in its own transaction: the credential row under
 * lock, opened, and written over only where it still holds the one this turn traded with. A
 * re-wrap of the same token is the same token; a reconnect or another worker's seal is not, and
 * then nothing is written and the turn ends. The new envelope is opened again before it is kept.
 */
async function sealRotated(
  deps: SignInDeps, place: SealPlace, word: ProviderWord, traded: Secret, rotated: Secret,
): Promise<"superseded" | { readonly kind: "sealed"; readonly digest: string } | { readonly kind: "kept" }> {
  const done = await inConnection(place.db, place.key, async ({ tx }) => {
    const now = await lockedOpened(tx, deps, place.key, word);
    const stored = now === null ? null : parseCredential(now, placeOf(place.key));
    if (stored === null || stored.kind !== "oauth" || stored.refreshToken.reveal() !== traded.reveal()) return "superseded" as const;
    const text = serializeCredential({ kind: "oauth", provider: stored.provider, refreshToken: rotated }, placeOf(place.key));
    if (text === null) return { kind: "kept" } as const;
    const envelope = await deps.keys.encrypt(text);
    if (await deps.keys.decrypt(envelope.ciphertext, envelope.keyVersion) !== text) throw new CalendarKeyRingFault();
    await tx.update(calCredentials).set({ secretEnc: envelope.ciphertext, keyVersion: envelope.keyVersion, updatedAt: sql`now()` })
      .where(and(eq(calCredentials.accountId, place.key.accountId), eq(calCredentials.connectionId, place.key.id), eq(calCredentials.kind, "oauth")));
    return { kind: "sealed", digest: digestOf(text) } as const;
  });
  return done === "gone" ? "superseded" : done;
}
