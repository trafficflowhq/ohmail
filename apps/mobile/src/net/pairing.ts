/**
 * THE PAIRING SEAM — how this phone becomes a session on a server, all flavors, one mechanism.
 *
 * One mechanism, every server flavor: the picker negotiates via `GET /hello` and shows a next
 * step only where `features.pairing` allows it (never a dead button); the credential arrives as
 * `${origin}/pair#${token}` — a QR on the desktop's Devices pane, a copy link on the LAN pane,
 * or two fields typed by hand — and is spent exactly once, in the body of `POST /pair/redeem`.
 *
 * ── THE TOKEN DISCIPLINE (carried from the desktop PairScreen) ──────────────────────────────
 *
 *  · the token rides the link's FRAGMENT; {@link parsePairLink} refuses a token moved into the
 *    query or the path, so the safe shape cannot regress by convenience;
 *  · the ONLY request that ever carries it is the redeem's JSON body — it appears in no URL,
 *    no header, no log line, and no error sentence this module composes;
 *  · the redeem rides a BARE fetch, deliberately not a BearerManager's: there is no session
 *    yet, and a 401 recovery has nothing to recover.
 *
 * ── THE NO-SECURE-CONTEXT WIN, STATED ───────────────────────────────────────────────────────
 *
 * The served BROWSER client carries three [SecureContext] dependencies that make a plain-http
 * LAN origin unusable there — which is why the desktop's LAN door serves an explainer, not the
 * client, and why its pane says "browsers use Tailscale, the mobile app uses LAN". This module
 * is the other half of that sentence: RN fetch has no secure-context gate and no CORS, and
 * nothing in this seam or the manager touches `navigator.locks`, `isSecureContext` or bare
 * `crypto.randomUUID` (the census in `pairing.test.ts` pins that), so a plain
 * `http://192.168…` desktop-host door pairs and drains exactly like an https one.
 *
 * ── WHO NAMES THE ACCOUNT ───────────────────────────────────────────────────────────────────
 *
 * The mirror is named by (origin, accountId) and the `__owner` stamp CLAIMS it, so the id must
 * be the SERVER's word, never a guess: {@link resolveAccountId} asks `GET /auth/session` where
 * the composition mounts it (the standalone server), and falls back to the server's own rows —
 * one snapshot/sync page's `entity.accountId` — on the desktop-host door, which mounts no
 * session read. A door that can name no account (no session read AND zero rows) refuses the
 * pairing out loud rather than minting a mirror under an invented owner that the drain-time
 * account guard would then refuse forever.
 */
import type { OhmailEngine, SqlMirrorStore } from "@ohmail/client-engine";
import {
  bootEngine,
  mirrorOwnerKey,
  normalizeOrigin,
  type MobileEngineDeps,
} from "../engine/boot";
import { ServerProfileStore, type ServerProfile } from "../state/servers";
import { BearerManagerRN, type FetchLike, type RefreshVault } from "./bearer";

/** The hosted service — the managed picker card negotiates against this and nothing else. */
export const MANAGED_ORIGIN = "https://api.ohmail.app";

/* ── /hello negotiation ─────────────────────────────────────────────────────────────────────── */

/** What the picker acts on, narrowed from the frozen /hello wire. */
export interface HelloAnswer {
  flavor: string;
  /** `features.pairing` — the one capability the picker's choices gate on. */
  pairing: boolean;
  needsSetup: boolean;
  apiVersion: string;
}

export type Negotiation =
  | { kind: "hello"; hello: HelloAnswer }
  /** Something answered, but not an ohmail server (the `product` probe failed). */
  | { kind: "not-ohmail" }
  | { kind: "unreachable"; detail: string };

export async function negotiate(fetchImpl: FetchLike, origin: string): Promise<Negotiation> {
  let res: Response;
  try {
    res = await fetchImpl(`${normalizeOrigin(origin)}/hello`);
  } catch (err) {
    return { kind: "unreachable", detail: String(err) };
  }
  if (!res.ok) return { kind: "unreachable", detail: `the server answered ${res.status}` };
  let body: {
    product?: unknown; flavor?: unknown; apiVersion?: unknown; needsSetup?: unknown;
    features?: { pairing?: unknown };
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { kind: "not-ohmail" };
  }
  if (body.product !== "ohmail" || typeof body.flavor !== "string") return { kind: "not-ohmail" };
  return {
    kind: "hello",
    hello: {
      flavor: body.flavor,
      // `=== true` and nothing looser: an absent or malformed capability is an absent ceremony.
      pairing: body.features?.pairing === true,
      needsSetup: body.needsSetup === true,
      apiVersion: typeof body.apiVersion === "string" ? body.apiVersion : "",
    },
  };
}

/**
 * What the picker OFFERS for a negotiated server — the whole gating rule in one function, so
 * the dead-button discipline is testable: a pairing step exists exactly when the server said
 * `features.pairing: true`. The managed card is honest about the hosted service: today its
 * /hello answers `pairing: false` because it mounts no redeem, so the card says
 * sign-in-arrives-later; the moment the hosted service mounts the ceremony and flips the
 * descriptor, the SAME rule starts offering the pair step with zero client change.
 */
export type PickerStep =
  | { kind: "pair" }
  | { kind: "managed-signin-later" }
  | { kind: "no-pairing"; flavor: string };

export function nextStep(hello: HelloAnswer): PickerStep {
  if (hello.pairing) return { kind: "pair" };
  if (hello.flavor === "managed") return { kind: "managed-signin-later" };
  return { kind: "no-pairing", flavor: hello.flavor };
}

/* ── the pairing link ───────────────────────────────────────────────────────────────────────── */

/**
 * Parse `${origin}/pair#${token}` — the frozen QR/copy-link shape. A hand regex rather than
 * `new URL`, so node tests and Hermes parse identically. Refused, deliberately:
 *  · a non-http(s) scheme (nothing else can be redeemed against);
 *  · any path but `/pair` (a token in the path would ride access logs);
 *  · ANY query string — `?token=` is the regression the fragment rule exists to prevent;
 *  · an empty fragment (there is no token to redeem).
 */
export function parsePairLink(text: string): { origin: string; token: string } | null {
  // The scheme match is case-insensitive (a QR encoder may upcase); normalizeOrigin lowercases
  // the result, so one server stays one profile. The PATH comparison stays exact — /pair is a
  // route, and routes are case-sensitive.
  const m = /^(https?):\/\/([^/?#\s]+)(\/[^?#\s]*)?(\?[^#\s]*)?(?:#(\S+))?$/i.exec(text.trim());
  if (!m) return null;
  const [, scheme, host, path, query, fragment] = m;
  if (query !== undefined) return null;
  if ((path ?? "").replace(/\/+$/, "") !== "/pair") return null;
  const token = (fragment ?? "").trim();
  if (token === "") return null;
  return { origin: normalizeOrigin(`${scheme}://${host}`), token };
}

/* ── the server-verified account id ─────────────────────────────────────────────────────────── */

/**
 * Ask the server whose session this is — the session read first, the server's own rows where
 * that route is not mounted (see the header). `null` = this door could name no account.
 */
export async function resolveAccountId(
  fetchImpl: FetchLike,
  origin: string,
  authHeaders: () => Record<string, string>,
): Promise<{ accountId: string; via: "session" | "rows" } | null> {
  try {
    const res = await fetchImpl(`${origin}/auth/session`, { headers: authHeaders() });
    if (res.ok) {
      const body = (await res.json()) as { user?: { accountId?: unknown } };
      const id = body.user?.accountId;
      if (typeof id === "string" && id !== "") return { accountId: id, via: "session" };
    }
  } catch {
    /* fall through to the rows — a dead route and a dead network read the same here */
  }
  const fromEntity = (entity: unknown): string | null => {
    const id = (entity as { accountId?: unknown } | undefined)?.accountId;
    return typeof id === "string" && id !== "" ? id : null;
  };
  try {
    const res = await fetchImpl(`${origin}/sync/snapshot?limit=1`, { headers: authHeaders() });
    if (res.ok) {
      const body = (await res.json()) as { changes?: Array<{ entity?: unknown }> };
      const id = fromEntity(body.changes?.[0]?.entity);
      if (id !== null) return { accountId: id, via: "rows" };
    }
  } catch {
    /* snapshot unavailable — the delta read below is the last word */
  }
  try {
    const res = await fetchImpl(`${origin}/sync?since=0&limit=1&types=message`, { headers: authHeaders() });
    if (res.ok) {
      const body = (await res.json()) as { changes?: { creates?: Array<{ entity?: unknown }> } };
      const id = fromEntity(body.changes?.creates?.[0]?.entity);
      if (id !== null) return { accountId: id, via: "rows" };
    }
  } catch {
    /* nothing left to ask */
  }
  return null;
}

/* ── pair + connect ─────────────────────────────────────────────────────────────────────────── */

/** What the connection layer holds while a profile is live. */
export interface ConnectedSession {
  profile: ServerProfile;
  bearer: BearerManagerRN;
  engine: OhmailEngine;
  store: SqlMirrorStore;
  ownerKey: string;
}

/** The two kinds this app can truthfully be — the hosted device vocabulary's mobile half. */
export type MobileDeviceKind = "mobile-android" | "mobile-ios";

/**
 * What THIS phone is, from the platform React Native reports. A pure mapping, deliberately not
 * an import of `react-native` here: this module runs under node in the suite, and the OS is the
 * composition's fact to hand in (`connection.tsx` passes `Platform.OS`), the same way the
 * transport is.
 */
export function mobileDeviceKind(os: string): MobileDeviceKind {
  return os === "ios" ? "mobile-ios" : "mobile-android";
}

export interface PairingEnv {
  profiles: ServerProfileStore;
  engineDeps: MobileEngineDeps;
  /** Override the transport (tests). Absent, RN's global fetch. */
  fetchImpl?: FetchLike;
  /**
   * The kind this phone declares in the redeem body, so the server's device list and its
   * staleness attribution say WHICH install a row is ("mobile-android", not "Web"). Composed by
   * the provider from {@link mobileDeviceKind}(Platform.OS). Absent means the field is omitted
   * and the server defaults the row to `"web"` — exactly what every redeem sent before the
   * vocabulary existed.
   */
  deviceKind?: MobileDeviceKind;
}

export type PairOutcome =
  | { kind: "paired"; session: ConnectedSession }
  | { kind: "refused"; reason: string };

export type ConnectOutcome =
  | { kind: "connected"; session: ConnectedSession }
  /** `needsRepair`: the credential is gone (a refusal cleared it) — one scan re-pairs. */
  | { kind: "refused"; reason: string; needsRepair?: boolean };

const bareFetch = (): FetchLike => globalThis.fetch.bind(globalThis) as FetchLike;

/** The BearerManager's persistence, bound to one profile's slot in the keystore. */
function vaultFor(profiles: ServerProfileStore, id: string): RefreshVault {
  return {
    save: (t) => profiles.saveRefreshToken(id, t),
    clear: () => profiles.clearRefreshToken(id),
  };
}

/**
 * The whole ceremony: negotiate, redeem, learn the account, persist the profile (active),
 * boot the engine. Every refusal is a sentence the screen can show; none of them carries the
 * token.
 */
export async function pairWithServer(
  env: PairingEnv,
  input: { origin: string; token: string },
): Promise<PairOutcome> {
  const fetchImpl = env.fetchImpl ?? bareFetch();
  const origin = normalizeOrigin(input.origin);
  if (!/^https?:\/\/\S+$/.test(origin)) {
    return { kind: "refused", reason: `not a server address: "${input.origin}"` };
  }
  const token = input.token.trim();
  if (token === "") return { kind: "refused", reason: "the pairing code is empty" };

  // 1 — what is this server, and does it pair? The gate is the same rule the picker renders
  // by, so a flow that reached this line cannot die on a route the descriptor said is absent.
  const negotiated = await negotiate(fetchImpl, origin);
  if (negotiated.kind === "unreachable") {
    return { kind: "refused", reason: `could not reach that server — ${negotiated.detail}` };
  }
  if (negotiated.kind === "not-ohmail") {
    return { kind: "refused", reason: "that address answers, but not as an ohmail server" };
  }
  const step = nextStep(negotiated.hello);
  if (step.kind !== "pair") {
    return {
      kind: "refused",
      reason:
        step.kind === "managed-signin-later"
          ? "ohmail.app does not offer device pairing yet — it arrives with a later update"
          : "this server does not offer device pairing",
    };
  }

  // 2 — spend the token: its one appearance, in the redeem body. `kind` is this phone's own
  // declaration (the server's whitelist now carries the mobile vocabulary), omitted only when
  // the composition handed none in — the server then defaults the row to "web" as it always has.
  //
  // ONE RETRY, for one refusal: an OLDER server whose whitelist predates the mobile kinds
  // answers the declaration `validation_failed` naming "device kind" — and it refuses BEFORE
  // the burn (every version that has ever validated the field checks it ahead of consuming the
  // token; the versions before that ignore unknown body fields entirely), so the single-use
  // token is still live and the same redeem without the declaration is exactly the request that
  // server has always accepted. Honesty degrades to silence, never to a dead pairing code.
  const redeem = async (declare: boolean): Promise<Response> =>
    fetchImpl(`${origin}/pair/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant: "device-pair",
        token,
        ...(declare && env.deviceKind ? { kind: env.deviceKind } : {}),
      }),
    });
  type RedeemAnswer = {
    tokens?: { accessToken?: unknown; refreshToken?: unknown };
    error?: { code?: unknown; message?: unknown };
  };
  const parse = async (res: Response): Promise<RedeemAnswer> => {
    try {
      return (await res.json()) as RedeemAnswer;
    } catch {
      return {};
    }
  };
  let redeemed: Response;
  let answer: RedeemAnswer;
  try {
    redeemed = await redeem(true);
    answer = await parse(redeemed);
    const kindRefused =
      env.deviceKind !== undefined &&
      redeemed.status === 400 &&
      answer.error?.code === "validation_failed" &&
      typeof answer.error?.message === "string" &&
      answer.error.message.includes("device kind");
    if (kindRefused) {
      redeemed = await redeem(false);
      answer = await parse(redeemed);
    }
  } catch {
    return { kind: "refused", reason: "could not reach that server to redeem the pairing" };
  }
  const tokens = answer.tokens;
  if (!redeemed.ok || typeof tokens?.accessToken !== "string" || typeof tokens.refreshToken !== "string") {
    // A wrong, spent or expired token gets the remedy sentence (the desktop PairScreen's
    // exact judgment); anything else shows the server's own words.
    const message =
      answer.error?.code === "pairing_invalid" || typeof answer.error?.message !== "string"
        ? "that pairing code was not accepted — mint a fresh one and scan again"
        : answer.error.message;
    return { kind: "refused", reason: message };
  }

  // 3 — whose mailbox did this open? The server's word, or no mirror at all.
  const authHeaders = () => ({ authorization: `Bearer ${tokens.accessToken as string}` });
  const identity = await resolveAccountId(fetchImpl, origin, authHeaders);
  if (identity === null) {
    // A door with no session read and zero rows (a fresh desktop engine) can name no account,
    // and the mirror's name, its __owner stamp and the drain-time guard all require the
    // server's word — a placeholder owner here would be a wrong default standing in for a
    // missing fact. The token above is single-use and is now spent, so the sentence says so.
    // (An identity read on the desktop-host door would let this name the account; not today.)
    return {
      kind: "refused",
      reason:
        "paired, but the server could not name the account this pairing opens — once it holds mail, mint a fresh code and pair again",
    };
  }

  // 4 — persist (same (origin, account) re-pairs in place), then boot over the manager.
  // The keystore write can REFUSE, and by this line the single-use token is
  // already burned and a server session already minted — so a failure here must resolve to a
  // sentence, not escape as a throw that strands the screen on "Pairing…", and the minted
  // session is revoked best-effort rather than abandoned live under nobody's control.
  let profile: ServerProfile;
  try {
    profile = await env.profiles.add({
      origin,
      flavor: negotiated.hello.flavor,
      accountId: identity.accountId,
      refreshToken: tokens.refreshToken,
    });
  } catch (err) {
    try {
      await fetchImpl(`${origin}/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.accessToken as string}` },
      });
    } catch {
      /* unreachable — the abandoned session ages out server-side */
    }
    return {
      kind: "refused",
      reason: `this phone could not store the pairing (${String(err)}) — the session was closed; mint a fresh code and try again`,
    };
  }
  const connected = await buildSession(env, profile, tokens.accessToken);
  if (connected.kind === "refused") return { kind: "refused", reason: connected.reason };
  return { kind: "paired", session: connected.session };
}

/**
 * Best-effort SERVER-SIDE revocation of a profile's session — what "forget this server" owes
 * beyond deleting the local row: without it the refresh family stays live on the server until
 * it ages out. Ridden through a throwaway manager's `fetch` on purpose: a stored profile holds
 * only the refresh token, so the logout's first attempt carries no access token, 401s, and the
 * manager's one recovery spends the refresh into a fresh access token and replays — which
 * revokes the session (`allDevices` stays step-up-gated server-side, so this can only ever end
 * ITSELF). Never throws and never blocks: an unreachable server means the session ages out,
 * and the local forget must not hang on it.
 */
export async function revokeProfile(env: PairingEnv, profile: ServerProfile): Promise<void> {
  if (profile.refreshToken === null) return; // already judged dead — nothing live to revoke
  const bearer = new BearerManagerRN({
    origin: profile.origin,
    accessToken: null,
    refreshToken: profile.refreshToken,
    // A throwaway vault: the profile is being forgotten, so nothing should persist into it.
    vault: { save: async () => undefined, clear: async () => undefined },
    ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
  });
  try {
    await bearer.fetch(`${profile.origin}/auth/logout`, { method: "POST" });
  } catch {
    /* unreachable server — the server-side session ages out; the phone forgot it already */
  }
}

/** Boot a STORED profile — app launch and profile switch. No token is spent here. */
export async function connectProfile(env: PairingEnv, profile: ServerProfile): Promise<ConnectOutcome> {
  if (profile.refreshToken === null) {
    return {
      kind: "refused",
      needsRepair: true,
      reason: "this pairing ended — the server refused its token. Scan a fresh QR to pair again",
    };
  }
  return buildSession(env, profile, null);
}

/**
 * {@link connectProfile}, keyed by id — the form every SCREEN must use. A profile object held
 * in React state goes stale the moment a rotation lands (its `refreshToken` is the CONSUMED
 * one, and presenting it is the reuse signal that revokes the family), so the row is re-read
 * from the keystore at the last moment and the held copy never reaches a wire.
 */
export async function connectProfileById(env: PairingEnv, id: string): Promise<ConnectOutcome> {
  const profile = (await env.profiles.list()).find((p) => p.id === id);
  if (profile === undefined) {
    return { kind: "refused", reason: "that server is no longer paired on this phone" };
  }
  return connectProfile(env, profile);
}

/**
 * The engine composition, fed through the manager's two seams instead of a hand-typed static
 * header — the same shape the desktop's host client uses. A cold launch holds no access token;
 * the first 401 buys one through the rotation — which is the machine `bearer.test.ts` pins.
 */
async function buildSession(
  env: PairingEnv,
  profile: ServerProfile,
  accessToken: string | null,
): Promise<ConnectOutcome> {
  const bearer = new BearerManagerRN({
    origin: profile.origin,
    accessToken,
    refreshToken: profile.refreshToken,
    vault: vaultFor(env.profiles, profile.id),
    ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
  });
  const boot = await bootEngine(env.engineDeps, {
    origin: profile.origin,
    accountId: profile.accountId,
    auth: { headers: () => bearer.headers(), fetch: bearer.fetch },
  });
  if (boot.kind === "refused") return { kind: "refused", reason: boot.reason };
  // The bearer can DIE inside the boot's own /auth/session probe (a revoked cold profile: the
  // 401 recovery presents the refresh token and the server refuses it) — and that death lands
  // BEFORE any screen could subscribe to the dead signal. A ready-but-dead session would render
  // the cached mirror as live mail over a credential the server already judged, so the boot is
  // refused here, the mirror handle released, and the sentence is the same one-gesture remedy
  // the mid-use death shows.
  if (!bearer.paired()) {
    boot.store.close();
    return {
      kind: "refused",
      needsRepair: true,
      reason: "this pairing ended — the server refused its token. Scan a fresh QR to pair again",
    };
  }
  return {
    kind: "connected",
    session: {
      profile,
      bearer,
      engine: boot.engine,
      store: boot.store,
      ownerKey: mirrorOwnerKey(profile.origin, profile.accountId),
    },
  };
}
