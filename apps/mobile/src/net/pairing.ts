/**
 * The pairing seam — every flavor through one mechanism: `GET /hello`
 * negotiates, the credential is `${origin}/pair#${token}`, and the token is
 * spent exactly once, in the `POST /pair/redeem` body — it rides the link's
 * fragment ({@link parsePairLink} refuses query or path) and appears in no
 * URL, header, log or error sentence. {@link admitOrigin} refuses cleartext
 * to a network address and an address no pin can verify. The API base is
 * measured before the burn ({@link resolveApiBase}, `net/server-base.ts`);
 * {@link resolveAccountId} takes the server's word — a door naming no account is refused.
 */
import { originNeedsPin, type OhmailEngine, type SqlMirrorStore } from "@ohmail/client-engine";
import {
  bootEngine,
  forgetMirror,
  localEngineTransport,
  mirrorOwnerKey,
  normalizeOrigin,
  LOCAL_ENGINE_ORIGIN,
  type IdentityVerdict,
  type MobileEngineDeps,
} from "../engine/boot";
import { holdStandaloneDoor } from "../engine/organizer-session";
import type { ReopenOutcome, StandaloneEngine } from "../engine/standalone-door";
import { ServerProfileStore, type ServerProfile } from "../state/servers";
import { BearerManagerRN, type FetchLike, type RefreshVault } from "./bearer";
import {
  canPin, isNotTls, isPinFailure, pin as installPin, unpin,
} from "./host-pinning";
/* Every sentence this module hands back reaches a screen, so they live in the copy deck and are
   translated with everything else. The `throw new Error(…)` messages below do not: they are
   programming faults nobody but a developer ever reads. */
import { Copy } from "../copy";
import { faultDetail, refuse, type Refusal, type RefusalArg } from "../refusal";
import { dropWakeRow, type UnifiedPushDistributor } from "./push.js";
import { resolveApiBase } from "./server-base.js";

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
  /* `detail` is a refusal ARGUMENT, not a sentence: it is rendered where it is shown, so a
     language change reaches inside `Copy.unreachable`/`Copy.pairUnreachable` too. */
  | { kind: "unreachable"; detail: RefusalArg };

export async function negotiate(fetchImpl: FetchLike, origin: string): Promise<Negotiation> {
  let res: Response;
  try {
    res = await fetchImpl(`${normalizeOrigin(origin)}/hello`);
  } catch (err) {
    return { kind: "unreachable", detail: faultDetail(err) };
  }
  if (!res.ok) return { kind: "unreachable", detail: refuse("helloStatus", res.status) };
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
 * Parse `${origin}/pair#${fragment}` — the QR/copy-link shape, whose definition lives in
 * `@ohmail/client-engine` because the DESKTOP composes it and this parses it, and a composer and
 * a parser that disagree is a QR code nobody can scan with nothing on either machine to look at.
 *
 * Re-exported here rather than imported at every call site so that the screens keep one import,
 * and so this module's own header keeps documenting the token discipline it enforces.
 */
export { parsePairLink, shortPin, type PairLink } from "@ohmail/client-engine";

/* ── the picker's origin handoff ────────────────────────────────────────────────────────────── */

/**
 * The address the manual screen opens on — held in this process, never in a
 * URL. The `ohmail` scheme is a browsable deep link, so a route parameter let
 * any web page open `ohmail://connect?origin=<anything>` and choose the server
 * a pairing token would be sent to — and the token is the credential:
 * `POST /pair/redeem` is public+anonymous and hands a bearer pair to whoever
 * presents it, within the five-minute TTL. A module-level value is unreachable
 * from outside the process, so the address is one this app negotiated in this
 * launch. Read, not consumed: returning to the screen shows the same address.
 */
let stashedPairOrigin: string | null = null;

/** The picker hands the manual screen the address `/hello` answered for. Not a URL, not a param. */
export function stashPairOrigin(origin: string): void {
  stashedPairOrigin = normalizeOrigin(origin);
}

/** What the manual screen opens on: an address this app negotiated, or nothing at all. */
export function pendingPairOrigin(): string {
  return stashedPairOrigin ?? "";
}

/* ── the server-verified account id ─────────────────────────────────────────────────────────── */

/**
 * Ask the server whose session this is — the session read first, the server's
 * own rows where that route is not mounted. `null` = this door could name no
 * account. `/auth/session` is routed at the bare origin everywhere (the
 * self-host Caddyfile names `/auth/*`), while the row reads are `/sync`
 * family, which a one-origin self-host stack serves only under `/api` — this
 * read is the one place the fallback runs on the door that needs the prefix.
 * See `net/server-base.ts`.
 */
export async function resolveAccountId(
  fetchImpl: FetchLike,
  origin: string,
  authHeaders: () => Record<string, string>,
  /** Where the `/sync` family answers. Absent ⇒ the origin, which is right for two of three. */
  apiBase?: string,
): Promise<{ accountId: string; via: "session" | "rows" } | null> {
  const base = apiBase ?? origin;
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
    const res = await fetchImpl(`${base}/sync/snapshot?limit=1`, { headers: authHeaders() });
    if (res.ok) {
      const body = (await res.json()) as { changes?: Array<{ entity?: unknown }> };
      const id = fromEntity(body.changes?.[0]?.entity);
      if (id !== null) return { accountId: id, via: "rows" };
    }
  } catch {
    /* snapshot unavailable — the delta read below is the last word */
  }
  try {
    const res = await fetchImpl(`${base}/sync?since=0&limit=1&types=message`, { headers: authHeaders() });
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
  /**
   * THE ROTATING CREDENTIAL — or `null` ON THE STANDALONE DOOR, where there is no family to rotate.
   *
   * Named rather than filled in. A BearerManager built over the engine's own per-launch token would
   * be a manager whose `rotate()` has no server to ask and whose `onSessionDead` can never fire, so
   * every caller reading it would believe it had a credential lifecycle it has not got. The two
   * readers that genuinely want the MANAGER — the dead signal and the logout — ask for it and skip
   * their work when it is absent; everything that only wanted a transport uses {@link fetch}.
   */
  bearer: BearerManagerRN | null;
  /**
   * EVERY AUTHENTICATED REQUEST THIS SESSION MAKES — the manager's on a paired door, the engine's
   * `handle` on the standalone one.
   *
   * The app's own reads (`net/mailboxes.ts`, the release route, consent, the folder verbs) used to
   * reach through `bearer.fetch`, which made a manager the precondition for talking to a server at
   * all. None of them wants rotation; they want the transport this session is on, and the local
   * door has one — `localEngineTransport` — that is the same composition the engine's own adapter
   * rides. One field, so a screen cannot be written against a door it will not work on.
   */
  fetch: FetchLike;
  engine: OhmailEngine;
  store: SqlMirrorStore;
  ownerKey: string;
  /**
   * The deferred bearer/account judgment ({@link IdentityVerdict}) — the boot no longer waits
   * on the wire (boot-from-local, `engine/boot.ts`), so the connection layer starts this AFTER
   * adoption, once the dead signal is subscribed, and tears the session down on `mismatch`.
   */
  verifyIdentity: () => Promise<IdentityVerdict>;
  /**
   * IS THIS SESSION THE ENGINE IN THIS APP — the standalone door, rather than a server on a wire.
   *
   * Derived from the ORIGIN and nothing else, HERE rather than by the reader: `bootEngine` refuses
   * a local engine handed any other address, so the origin is the door's identity, and deriving it
   * in the layer that composes the session keeps the screens out of `engine/` (`privacy.test.ts`
   * — the connection layer is the one door to the network seam).
   */
  standalone: boolean;
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

/* ── the transport gate ─────────────────────────────────────────────────────────────────────── */

/** Loopback, in the two spellings a phone could ever see one. */
function isLoopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127\./.test(host);
}

/**
 * May this phone talk to this origin at all, and on what terms? Called before
 * the first request, in both places a session begins ({@link pairWithServer},
 * {@link buildSession}), so the pin installs before `/hello`. Three refusals:
 * cleartext to a network address (the OS would kill it obscurely; loopback is
 * exempt — not a network hop, and where the test servers live); an IP literal
 * with no pin (unverified TLS is worth nothing); a pin this build cannot
 * install (`canPin()` false — today iOS; connecting unpinned defeats the pin).
 * The pass: a DNS-named https origin — the platform's trust store verifies it.
 */
export type Admitted =
  /**
   * `enforcedPin` is the key the TLS stack is now enforcing for this origin, or
   * `null` where the platform's own trust store verifies it. It is not "the pin
   * that was in the link" — the distinction is this type's reason: a fingerprint
   * for a DNS-named origin installs nothing (`originNeedsPin` is false there),
   * yet the confirmation once rendered that unenforced value under "Its key" —
   * an attacker with a real certificate for their own name and the victim's
   * fingerprint in the fragment got a matching comparison from the very screen
   * built to catch them. Only an enforced key leaves here, so only one is shown.
   */
  | { ok: true; enforcedPin: string | null }
  | { ok: false; reason: Refusal };

export function admitOrigin(
  origin: string,
  pin: string | null,
  /**
   * The pin this phone already enforces for this origin, when it has one —
   * read from the stored profile by the caller so this function stays pure.
   * A different pin for an origin paired under another key is refused, never
   * installed: `installPin` replaces the registry's (host, port) entry, so a
   * probe nobody confirmed could rewrite the trust of a live pairing and the
   * next refresh would hand the existing bearer to an attacker's machine. A
   * key change is a deliberate re-pair — forget and pair again — never a side
   * effect of looking at a code.
   */
  knownPin?: string | null,
): Admitted {
  const normalized = normalizeOrigin(origin);
  const host = normalized.replace(/^https?:\/\//, "").replace(/:\d+$/, "");
  if (normalized.startsWith("http://") && !isLoopback(host)) {
    return {
      ok: false,
      reason: refuse("admitCleartext"),
    };
  }
  if (originNeedsPin(normalized)) {
    if (pin === null) {
      return {
        ok: false,
        reason: refuse("admitNoPin"),
      };
    }
    /**
     * A KEY CHANGE IS NOT AN INSTALL, and it is judged BEFORE `canPin()` on purpose.
     *
     * `installPin` replaces the registry's entry for a (host, port), so admitting this rewrites a
     * live pairing's trust before anybody confirms. Two reasons the order is this way round:
     * refusing a changed key is right whether or not this build can pin at all, and the sentence
     * a person needs is about their computer's identity rather than about a missing platform half.
     * Behind `canPin()` the check was also unreachable in the node suite, which is a guard nobody
     * could watch fail.
     */
    if (knownPin !== undefined && knownPin !== null && knownPin !== pin) {
      return { ok: false, reason: refuse("pinChanged") };
    }
    if (!canPin()) {
      return {
        ok: false,
        reason: refuse("admitCannotPin"),
      };
    }
    if (!installPin(normalized, pin)) {
      return {
        ok: false,
        reason: refuse("admitPinNotStored"),
      };
    }
    return { ok: true, enforcedPin: pin };
  }
  /**
   * An origin that needs no pin enforces none, and the two cases diverge.
   * Either way the admission carries no key — nothing was enforced, and only
   * an enforced key may be drawn. A DNS name is refused: the desktop composes
   * a key into a code only for its same-network address, so a pinned code
   * naming a host is a mistake or the attack (a real certificate plus the
   * victim's fingerprint), and admitting it leaves a person believing they
   * compared a key. Loopback is admitted with the pin dropped — no network
   * path exists to attack, and it is where this suite's own servers live.
   */
  if (pin !== null && !isLoopback(host)) {
    return { ok: false, reason: refuse("admitPinUnenforceable") };
  }
  return { ok: true, enforcedPin: null };
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
  /**
   * The UnifiedPush connector, so a forget can take down the registration that belongs to the
   * pairing it is forgetting — see {@link forgetProfile}.
   *
   * A PORT, absent by default, for the reason `push.ts` states: this module runs under node in the
   * suite and must not reach a native module. The composition hands the real one in; every test
   * that does not care about wakes omits it and forgets exactly as before.
   */
  distributor?: Pick<UnifiedPushDistributor, "unregister">;
  /**
   * The mailbox on this phone, as a port — the fourth door's half of
   * {@link buildSession}. Two members because a launch and a door press arrive
   * in opposite states: a press has already opened the engine (the door screen
   * holds it), a cold launch has a profile row and nothing running — `door()`
   * answers the first, `reopen()` the second. A port for `distributor`'s reason:
   * opening the engine needs the platform's SQLite, key ring and install marker,
   * none importable here. Absent means this build cannot organize a mailbox;
   * the arm refuses in words, never a silent fall-through to the chooser.
   */
  standalone?: {
    /** The engine this process holds, or `null` — `organizerDoor()` in the app. */
    door: () => StandaloneEngine | null;
    /** Open it again from what it sealed for itself. `reopenStandaloneMailbox` in the app. */
    reopen: () => Promise<ReopenOutcome>;
  };
}

export type PairOutcome =
  | { kind: "paired"; session: ConnectedSession }
  | { kind: "refused"; reason: Refusal };

export type ConnectOutcome =
  | { kind: "connected"; session: ConnectedSession }
  /** `needsRepair`: the credential is gone (a refusal cleared it) — one scan re-pairs. */
  | { kind: "refused"; reason: Refusal; needsRepair?: boolean };

const bareFetch = (): FetchLike => globalThis.fetch.bind(globalThis) as FetchLike;

/** The BearerManager's persistence, bound to one profile's slot in the keystore. */
function vaultFor(profiles: ServerProfileStore, id: string): RefreshVault {
  return {
    save: (t) => profiles.saveRefreshToken(id, t),
    clear: () => profiles.clearRefreshToken(id),
  };
}

/**
 * The admission — what a probe measured about a door, and the only way to
 * reach a redeem. A pairing is two acts with a person between them: find out
 * what is at this address (no credential spent), show them, then spend the
 * code. A type, not a screen's discipline — a confirmation any call site can
 * forget is not a gate: {@link pairWithServer} accepts only an admission, only
 * {@link probePairing} makes one, so an unconfirmed pairing is unrepresentable
 * (a census names the one component allowed to redeem). Every field is
 * measured, never the link's, except `origin` and `pin` — the question itself.
 */
export interface PairAdmission {
  /** Lower-cased scheme+host(+port) — where the redeem and every later request will go. */
  origin: string;
  /**
   * The key the TLS stack is ENFORCING for this origin — `admitOrigin`'s `enforcedPin` — and
   * never the raw value out of the link. `null` where the platform's trust store verifies the
   * origin on its own, which is also the only state in which the confirmation shows no key row.
   */
  pin: string | null;
  /** What `GET /hello` said this is — "local", "desktop-host", "selfhost", "managed". */
  flavor: string;
  /** Where the `/sync` family answers, measured (`server-base.ts`). */
  apiBase: string;
  /**
   * The brand. Not security — a phone cannot keep a secret from its own code — but a value with
   * this field can only have come from {@link probePairing}, so a call site cannot assemble one
   * out of a scanned link and skip the person.
   */
  readonly probed: true;
}

export type ProbeOutcome =
  | { kind: "offers"; admission: PairAdmission }
  | { kind: "refused"; reason: Refusal };

/**
 * Ask an address what it is, spending nothing. Steps 0, 1 and 1b of the
 * ceremony in order — the transport gate, `/hello`, and where the mail API
 * answers. Every step is credential-free, which is what lets them run before
 * the person has decided anything and makes a refusal cost a sentence instead
 * of a spent code. The token is not a parameter: it stays with whoever
 * scanned it until the confirmation is pressed, so nothing on this path can
 * log it, send it or hold it.
 */
export async function probePairing(
  env: PairingEnv,
  input: { origin: string; pin?: string | null },
): Promise<ProbeOutcome> {
  const fetchImpl = env.fetchImpl ?? bareFetch();
  const origin = normalizeOrigin(input.origin);
  if (!/^https?:\/\/\S+$/.test(origin)) {
    return { kind: "refused", reason: refuse("pairBadAddress", input.origin) };
  }

  // 0 — THE TRANSPORT, BEFORE THE FIRST REQUEST AND NOT BEFORE THE REDEEM. `/hello` below is
  // already a request to this origin, so a pin installed after it would leave the negotiation
  // judged by the platform trust store — which for a self-signed door means it fails, and the
  // person is told the server is unreachable. See {@link admitOrigin} for each refusal.
  const pin = input.pin ?? null;
  /**
   * THE PIN THIS PHONE ALREADY ENFORCES FOR THIS ORIGIN, if any. A stored pairing's key is not
   * this probe's to replace — see `admitOrigin`'s `knownPin`. Read before the first request,
   * because the install happens before `/hello`.
   */
  const stored = (await env.profiles.list()).find((row) => row.origin === origin) ?? null;
  const admitted = admitOrigin(origin, pin, stored?.pin ?? null);
  if (!admitted.ok) return { kind: "refused", reason: admitted.reason };

  // 1 — what is this server, and does it pair? The gate is the same rule the picker renders
  // by, so a flow that reached this line cannot die on a route the descriptor said is absent.
  const negotiated = await negotiate(fetchImpl, origin);
  if (negotiated.kind === "unreachable") {
    // A HANDSHAKE FAILURE IS NOT "UNREACHABLE", and telling somebody it is sends them to look at
    // their wifi over a computer whose key changed. The platform's own words for it are
    // unreadable and, worse, indistinguishable from a dead network — so the shape is recognised
    // and the sentence says what happened and what to do (`host-pinning.ts`).
    if (pin !== null && isPinFailure(negotiated.detail)) {
      return { kind: "refused", reason: refuse("pinChanged") };
    }
    // AND THE SAME DIAL FAILS THE OTHER WAY: a peer whose first bytes are not a TLS record at
    // all — plain http on the port that was typed or scanned. `isNotTls` recognises that shape,
    // which `HANDSHAKE` deliberately does not, so it gets a sentence instead of the platform's
    // exception nested inside "could not reach that server".
    if (isNotTls(negotiated.detail)) {
      return { kind: "refused", reason: refuse("notEncrypted") };
    }
    return { kind: "refused", reason: refuse("pairUnreachable", negotiated.detail) };
  }
  if (negotiated.kind === "not-ohmail") {
    return { kind: "refused", reason: refuse("pairNotOhmail") };
  }
  const step = nextStep(negotiated.hello);
  if (step.kind !== "pair") {
    return {
      kind: "refused",
      reason: refuse(step.kind === "managed-signin-later" ? "pairManagedDeferred" : "pairNoPairing"),
    };
  }

  // 1b — where is this server's mail API? Measured before the burn: a
  // one-origin self-host stack serves `/hello`, `/pair/*` and `/auth/*` at
  // its root and the `/sync` family only under `/api`, so a pairing could
  // succeed and then mirror nothing forever, with an HTML 404 as the only
  // clue (`net/server-base.ts` documents and closes it). Measured rather than
  // derived from the door or flavor — a QR carries an origin and no door —
  // and placed before the redeem so a server whose API cannot be found costs
  // a sentence, not a spent code.
  const resolved = await resolveApiBase(fetchImpl, origin);
  if (resolved.kind === "refused") {
    // A HANDSHAKE FAILURE HERE READS AS A PIN FAILURE too — the probe is a request to the same
    // socket the negotiation used, so a key that changed between them is the same event and gets
    // the same sentence rather than a second, vaguer one about a missing API.
    if (pin !== null && isPinFailure(resolved.reason)) {
      return { kind: "refused", reason: refuse("pinChanged") };
    }
    return { kind: "refused", reason: resolved.reason };
  }

  return {
    kind: "offers",
    admission: {
      origin,
      // `admitted.enforcedPin`, NOT `pin`: what the screen may show is what the socket checks.
      pin: admitted.enforcedPin,
      flavor: negotiated.hello.flavor,
      apiBase: resolved.base,
      probed: true,
    },
  };
}

/**
 * SPEND THE CODE against a door a person has just confirmed: redeem, learn the account, settle
 * any owed deletion, persist the profile (active), boot the engine. Every refusal is a sentence
 * the screen can show; none of them carries the token.
 *
 * It takes an {@link PairAdmission} rather than an origin, which is what makes the confirmation
 * structural: there is no way to reach this function from a scanned string alone.
 */
export async function pairWithServer(
  env: PairingEnv,
  input: { admission: PairAdmission; token: string },
): Promise<PairOutcome> {
  const fetchImpl = env.fetchImpl ?? bareFetch();
  const { origin, pin, apiBase } = input.admission;
  const negotiatedFlavor = input.admission.flavor;
  const token = input.token.trim();
  if (token === "") return { kind: "refused", reason: refuse("pairEmptyToken") };

  /**
   * THE ADMISSION'S PIN IS RE-INSTALLED HERE, and it is not belt-and-braces.
   *
   * The registry is keyed by host and port and REPLACES. A second probe between this admission
   * being shown and this press — another scan, another paste — rewrites the entry, so the socket
   * the redeem would open could be checked against a key nobody was shown. Re-installing binds
   * the request to the admission the person actually looked at. `null` ⇒ nothing to install, which
   * is the trust store's case.
   */
  if (pin !== null && !installPin(origin, pin)) {
    return { kind: "refused", reason: refuse("admitPinNotStored") };
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
    return { kind: "refused", reason: refuse("pairRedeemUnreachable") };
  }
  const tokens = answer.tokens;
  if (!redeemed.ok || typeof tokens?.accessToken !== "string" || typeof tokens.refreshToken !== "string") {
    // A wrong, spent or expired token gets the remedy sentence (the desktop PairScreen's
    // exact judgment); anything else shows the server's own words.
    const message =
      answer.error?.code === "pairing_invalid" || typeof answer.error?.message !== "string"
        ? refuse("pairCodeRejected")
        : refuse("verbatimDetail", answer.error.message);
    return { kind: "refused", reason: message };
  }

  // 3 — whose mailbox did this open? The server's word, or no mirror at all.
  const authHeaders = () => ({ authorization: `Bearer ${tokens.accessToken as string}` });
  const identity = await resolveAccountId(fetchImpl, origin, authHeaders, apiBase);
  if (identity === null) {
    // A door with no session read and zero rows (a fresh desktop engine) can name no account,
    // and the mirror's name, its __owner stamp and the drain-time guard all require the
    // server's word — a placeholder owner here would be a wrong default standing in for a
    // missing fact. The token above is single-use and is now spent, so the sentence says so.
    // (An identity read on the desktop-host door would let this name the account; not today.)
    return {
      kind: "refused",
      reason: refuse("pairNoAccountName"),
    };
  }

  // 3b — an owed forget for this mirror is settled before the pairing is
  // adopted. A forget whose deletion failed leaves `{oldId, owner}` in the
  // durable queue, and a re-pair of the same (origin, account) resolves to
  // the same owner — adopting it would boot the surviving mirror and let the
  // next launch's drain delete a database the person just re-authorized. So
  // the debt is paid here: mirror deleted and read back, the pairing starts
  // from empty. If the deletion still cannot land the pairing is refused —
  // the token is already spent, so the sentence says what to do next.
  const ownerKey = mirrorOwnerKey(origin, identity.accountId);
  if ((await env.profiles.pendingWipes()).some((w) => w.owner === ownerKey)) {
    try {
      await forgetMirror(env.engineDeps, ownerKey);
      // The CLEAR is inside the refusal too, and its read-back is what makes that matter: a
      // debt that survives being cleared would be collected by a later launch against the
      // mirror this pairing is about to create, deleting the mailbox the person just
      // re-authorized. Refusing the pairing is the only safe answer to that.
      await env.profiles.clearPendingWipe(ownerKey);
    } catch (err) {
      return {
        kind: "refused",
        reason: refuse("pairOwedDeletion", faultDetail(err)),
      };
    }
  }

  // 4 — persist (same (origin, account) re-pairs in place), then boot over the manager.
  // The keystore write can REFUSE, and by this line the single-use token is
  // already burned and a server session already minted — so a failure here must resolve to a
  // sentence, not escape as a throw that strands the screen on "Pairing…", and the minted
  // session is revoked rather than abandoned live under nobody's control. Whether that
  // revocation LANDED decides which sentence is told; see the arm itself.
  let profile: ServerProfile;
  try {
    profile = await env.profiles.add({
      origin,
      flavor: negotiatedFlavor,
      accountId: identity.accountId,
      refreshToken: tokens.refreshToken,
      // The pin is persisted with the credential, because it has to be re-installed on every
      // launch before the first request — a pin that lived only in this process would pair
      // perfectly and fail on the next cold start.
      pin,
      // The MEASURED base, persisted for the pin's reason: every later launch composes its drains
      // against it and must not pay for a probe to learn it. Stored even when it equals the origin
      // — recording what was measured is not the same as recording nothing, and a later build that
      // wanted to tell "measured, and it is the root" from "never measured" would have no way to.
      apiBase,
    });
  } catch (err) {
    // THE COMPENSATION IS ONLY CLAIMED IF IT LANDED. The status was not read at all, so a 401,
    // a 500 or a dead network still produced the sentence "the session was closed" over a live
    // server session — a take-back asserted on the strength of a request having been sent.
    // 401 counts as closed: the session this would revoke is already gone.
    let closed = false;
    try {
      const res = await fetchImpl(`${origin}/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${tokens.accessToken as string}` },
      });
      closed = (res.status >= 200 && res.status < 300) || res.status === 401;
    } catch {
      /* unreachable — the abandoned session ages out server-side */
    }
    return {
      kind: "refused",
      reason: refuse(closed ? "pairNotStoredClosed" : "pairNotStoredOpen", faultDetail(err)),
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
 * ITSELF). Never throws — but it does ANSWER: `false` means the server was not told, and the
 * caller must not report a forget over it. See {@link forgetProfile}.
 */
export async function revokeProfile(env: PairingEnv, profile: ServerProfile): Promise<boolean> {
  /**
   * A cleared token is not a completed revocation. The token is null because
   * the server refused the family (a reuse judgment, a device revoke): that
   * kills the sessions and nothing else — the push row is pruned only by
   * `AuthService.logout` or a Devices-pane revoke, neither of which ran, so
   * the registration stays live on a distributor endpoint the phone still
   * answers. Answering `true` here reported a complete forget over exactly
   * that; `false` shows the Devices-list remedy, the only one left.
   */
  if (profile.refreshToken === null) return false;
  const bearer = new BearerManagerRN({
    origin: profile.origin,
    accessToken: null,
    refreshToken: profile.refreshToken,
    // A throwaway vault: the profile is being forgotten, so nothing should persist into it.
    vault: { save: async () => undefined, clear: async () => undefined },
    ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
  });
  try {
    const res = await bearer.fetch(`${profile.origin}/auth/logout`, { method: "POST" });
    // 401 counts as told only when the family was actually JUDGED — the manager clears its
    // credential on a refusal and clears nothing on a transient one, so a 401 with the token
    // still held means the recovery could not run and the session is still open. See
    // `BearerManagerRN.logout` for the same rule and the reason it is not obvious.
    return (res.status >= 200 && res.status < 300) || (res.status === 401 && !bearer.paired());
  } catch {
    /* unreachable server — the server-side session ages out; the phone forgot it already */
    return false;
  }
}

/* ── forget: the take-back, and it is three stores ──────────────────────────────────────────── */

export type ForgetOutcome =
  /** The credential is gone from the keystore and the mail is gone from the device. */
  | { kind: "forgotten" }
  /**
   * Something the user was told would go is still here. `reason` is a showable sentence naming
   * WHAT remains and what happens next; the deletion stays owed in the profile index either way.
   */
  | { kind: "partial"; reason: Refusal };

/**
 * Forget a pairing — the whole ceremony at the seam, not in the React
 * provider. It spans three stores — keystore, the mirror's SQLite, the server
 * (session + wake registration) — performed at every place the thing exists,
 * verified there, honest when it cannot be: an outcome type, never `void`.
 * Forced order: mark the wipe owed (durable intent, drained each launch by
 * {@link drainPendingWipes}); wait for the store handle to close; remove the
 * credential, reading the keystore back; revoke server-side, awaited (hosted
 * `logout` prunes the device's push row); delete the mail, read back ({@link forgetMirror}).
 */
export async function forgetProfile(
  env: PairingEnv,
  profileId: string,
  opts: { closed?: Promise<void>; revoke?: (() => Promise<boolean>) | null } = {},
): Promise<ForgetOutcome> {
  const row = (await env.profiles.list()).find((p) => p.id === profileId) ?? null;
  /**
   * A second forget of a row the first already removed is not automatically
   * done. Two taps before the row re-renders both reach here: the first
   * writes the debt, removes the credential and may return `partial` with the
   * mail still on the phone; the second then found no row and returned
   * `forgotten` — an unearned success that replaced the honest warning and,
   * on the last pairing, sent the screen to Welcome over a mirror still
   * there. A missing row is not the end of the question: the durable queue is
   * asked whether this profile still owes a forget, and that debt is finished.
   */
  const owed = row === null
    ? (await env.profiles.pendingWipes()).find((w) => w.id === profileId) ?? null
    : null;
  const ownerKey = row !== null ? mirrorOwnerKey(row.origin, row.accountId) : owed?.owner ?? null;
  // The intent names BOTH stores. An owner key alone made this crash boundary RESURRECT the
  // pairing: a kill here left the profile standing and still active, and the next launch
  // deleted the mirror, cleared the debt, then reconnected and drained the mailbox back.
  if (ownerKey !== null) {
    try {
      await env.profiles.markPendingWipe(profileId, ownerKey);
    } catch (err) {
      // NOTHING HAS BEEN TOUCHED YET, and that is why this refusal is safe: the queue is full
      // of forgets whose mail could not be deleted, and recording one more would mean evicting
      // one — stranding a mirror whose only remaining name is the entry being dropped. So the
      // forget does not start. The credential stays, which is the recoverable state.
      return {
        kind: "partial",
        reason: refuse("forgetCannotStart", faultDetail(err)),
      };
    }
  }

  // The server half is awaited and its answer shapes the result. The
  // credential this call destroys is the only thing that could ever retry
  // the logout, and the logout both revokes the session and (hosted) takes
  // the device's wake registration down — reporting a forget over a logout
  // that never landed leaves both alive with nothing left to retry. A durable
  // revocation debt was rejected: retrying a logout needs the refresh token,
  // so the queue would be a second durable home for the exact secret the
  // forget exists to remove. The remedy (revoke from the server's Devices
  // list) needs neither this phone nor its token.
  /* NOBODY TO TELL ON THE STANDALONE DOOR, and `revokeProfile` would say the opposite. It answers
     `false` for a credential-less row — right for a pairing whose token a server judged, and a
     false negative here: the session this row names was minted by the engine in this process and
     ends with it. Reported as "the server was not told", a forget of the phone's own mailbox would
     show the Devices-list remedy for a server that does not exist. */
  const localOnly = (row?.origin ?? "") === LOCAL_ENGINE_ORIGIN
    || (ownerKey ?? "").startsWith(`${LOCAL_ENGINE_ORIGIN}::`);
  const told = localOnly ? true
    : opts.revoke ? await opts.revoke().catch(() => false)
    : row !== null ? await revokeProfile(env, row)
    : true;

  // ── AND IT RUNS BEFORE THE CREDENTIAL IS DESTROYED, WHICH IS THE ORDER THAT SURVIVES A KILL ──
  //
  // This used to remove the keystore row first. A kill in the window that opened — after the
  // credential was gone and before the logout landed — stranded the server session and its push
  // row PERMANENTLY: the launch drain finds the profile already absent, so it has no token to
  // revoke with, and it clears the debt on the local halves alone. Revoking first means a kill
  // before it leaves the profile standing and OWED, which the launch drain can still spend (see
  // {@link drainPendingWipes}) — and the profile is non-bootable meanwhile, because
  // `buildSession` refuses anything the queue names.
  try {
    await env.profiles.remove(profileId);
    // THE TLS PIN GOES WITH THE CREDENTIAL. Best-effort and deliberately un-awaited-for-verdict:
    // a leftover pin can only ever NARROW what this phone accepts (it names one key for one
    // host), so it cannot be a residue that opens anything, and holding the forget open over it
    // would be a take-back refused for a reason nobody could act on.
    if (row !== null) unpin(row.origin);
    /**
     * The wake registration goes too — per-pairing now. Step 4's `logout` prunes
     * the server's `push_subscriptions` row, but the distributor end is the
     * phone's and no server can reach it: forgetting one of two pairings would
     * leave an instance registered for an account this phone can no longer open.
     * `wake.tsx` sweeps only when the last pairing goes (the distributor choice
     * is app-wide) and `forgetWake` is reached only by turning wakes off — neither
     * is this path. Best-effort for the pin's reason: an endpoint nothing POSTs to
     * opens nothing, and a forget must not fail in somebody's face over it.
     */
    if (env.distributor) {
      await env.distributor.unregister(profileId).catch(() => undefined);
    }
  } catch (err) {
    return {
      kind: "partial",
      reason: refuse("forgetKeystoreRefused", faultDetail(err)),
    };
  }

  if (ownerKey === null) return told ? { kind: "forgotten" } : { kind: "partial", reason: NOT_TOLD() };
  try {
    await (opts.closed ?? Promise.resolve());
    await forgetMirror(env.engineDeps, ownerKey);
    // INSIDE the try, because its read-back can refuse. A debt that survives being cleared is
    // collected by a later launch against whatever mirror that owner key names THEN — which,
    // after a re-pair, is the mailbox the person just re-authorized. Reporting a completed
    // forget over a debt that is still recorded would arm exactly that.
    await env.profiles.clearPendingWipe(ownerKey);
  } catch (err) {
    // HONEST. The pairing and its credential are gone — that half is done, and it is the half
    // that could still open the mailbox — but the mail is still here and the wipe is still owed.
    return {
      kind: "partial",
      reason: refuse("forgetMailRemains", faultDetail(err)),
    };
  }
  return told ? { kind: "forgotten" } : { kind: "partial", reason: NOT_TOLD() };
}

/** See {@link forgetProfile}: everything local is gone; the server was not told. A GETTER over
 *  the deck rather than a captured string — this module is imported at the top of the graph, long
 *  before a language is resolved, and a constant would freeze the sentence in English. */
const NOT_TOLD = (): Refusal => refuse("forgetServerUnreachable");

/**
 * Finish the forgets that did not finish — run once at launch, before any
 * profile is read. The credential goes first here too: an owed entry means
 * Forget was pressed and the process died before the keystore row went, and
 * deleting only the mirror would leave an active profile whose next launch
 * reconnects and drains the whole mailbox back onto the phone. So the row is
 * removed first, then the mirror deleted and read back. A refusal keeps the
 * debt — the entry stays and the next launch retries; that is why the intent
 * is durable. Answers the mirror keys whose mail remains, for the caller's log.
 */
export async function drainPendingWipes(env: PairingEnv): Promise<string[]> {
  const stillOwed: string[] = [];
  const rows = await env.profiles.list();
  for (const owed of await env.profiles.pendingWipes()) {
    try {
      // THE SERVER HALF FIRST, while the credential to do it with still exists. A debt whose
      // profile row survives is a forget that died before its logout, and this is the only
      // moment anything can still spend that token — after the removal below there is nothing
      // left to revoke with, for ever. Best-effort: an unreachable server must not hold the
      // local deletion hostage, and the row ages out.
      const stillHere = owed.id === "" ? undefined : rows.find((p) => p.id === owed.id);
      if (stillHere) await revokeProfile(env, stillHere).catch(() => false);
      // Idempotent: `remove` on a row that is already gone touches nothing and its read-back
      // passes, so a debt whose credential half landed before the kill costs one no-op.
      if (owed.id !== "") await env.profiles.remove(owed.id);
      await forgetMirror(env.engineDeps, owed.owner);
      // Its read-back can refuse, and a debt that survives being cleared stays owed rather than
      // being reported paid — the next launch tries again.
      await env.profiles.clearPendingWipe(owed.owner);
    } catch {
      stillOwed.push(owed.owner);
    }
  }
  return stillOwed;
}

/**
 * Pay the owed wake-row deletions — run at launch, beside
 * {@link drainPendingWipes}. A profile switch or a superseded registration
 * used to fire the delete and discard id and verdict, so a refusal left a row
 * nothing could name again, waking a phone for an account it no longer syncs.
 * Ridden through a manager on the profile's own vault (unlike
 * {@link revokeProfile} — load-bearing): the first attempt 401s, recovery
 * spends the stored refresh token, and the rotation must be kept because this
 * launch boots that same profile. A gone or refused entry is dropped. Never throws.
 */
export async function drainPendingWakeDrops(env: PairingEnv): Promise<string[]> {
  const stillOwed: string[] = [];
  const rows = await env.profiles.list();
  for (const owed of await env.profiles.pendingWakeDrops()) {
    const profile = rows.find((p) => p.id === owed.profileId);
    if (profile === undefined || profile.refreshToken === null) {
      await env.profiles.clearPendingWakeDrop(owed.subscriptionId);
      continue;
    }
    const bearer = new BearerManagerRN({
      origin: profile.origin,
      accessToken: null,
      refreshToken: profile.refreshToken,
      /**
       * The profile's real vault — a throwaway one here killed pairings.
       * `revokeProfile` uses a throwaway correctly: the profile it spends is
       * being forgotten. This drain is the opposite case — the profile is
       * about to be booted by the same launch. A cold manager 401s, recovery
       * spends the stored refresh token, the server rotates it; discarding
       * the replacement leaves a consumed token in the keystore, and
       * presenting a consumed token is the reuse signal that revokes the
       * family — paying a "stop waking me" debt would end a good pairing.
       */
      vault: vaultFor(env.profiles, profile.id),
      ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
    });
    const dropped = await dropWakeRow(
      /* `fetch` beside the manager, because that is the member `dropWakeRow` reads now. A cast
         through `unknown` compiles either way, so the omission would have been a runtime throw on
         the launch path that pays these debts. */
      { profile, bearer, fetch: bearer.fetch } as unknown as ConnectedSession,
      owed.subscriptionId,
    );
    if (dropped.ok) await env.profiles.clearPendingWakeDrop(owed.subscriptionId);
    else stillOwed.push(owed.subscriptionId);
  }
  return stillOwed;
}

/**
 * Boot a STORED profile — app launch and profile switch. No token is spent here. The
 * null-credential refusal lives in {@link buildSession}, the one place every session is
 * built, so this is a plain delegation.
 */
export async function connectProfile(env: PairingEnv, profile: ServerProfile): Promise<ConnectOutcome> {
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
    return { kind: "refused", reason: refuse("notPairedHere") };
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
  /**
   * A profile the person asked to forget is not bootable. A forget whose
   * credential removal was refused leaves the row and the debt — correctly,
   * the launch retries — but the launch must not then read that row as the
   * active profile and connect it: the retry mechanism would be a
   * resurrection path showing the mailbox they pressed Forget on. Here, not
   * at call sites: this is the one place every session is built, so launch,
   * switch and re-pair inherit it. A re-pair is not caught here because
   * `pairWithServer` settles the owed forget before it arrives.
   */
  if (await env.profiles.isOwedForget(profile.id)) {
    return {
      kind: "refused",
      reason: refuse("forgetStillPending"),
    };
  }
  /**
   * The mailbox on this phone — this arm's position is load-bearing. Ahead of
   * the admission: `LOCAL_ENGINE_ORIGIN` is `http://sidecar` and `admitOrigin`
   * correctly refuses cleartext to a non-loopback name — a network rule
   * applied to a door that never reaches one. Ahead of the refresh-token
   * refusal: this row holds no refresh token by design. Behind the
   * owed-forget refusal: a person who pressed Forget on this phone's own
   * mailbox must not have it re-opened by the next launch — the same
   * resurrection the queue prevents one door over.
   */
  if (profile.origin === LOCAL_ENGINE_ORIGIN) return buildLocalSession(env, profile);
  /**
   * The pin is re-installed on every launch, here, before any wire touch.
   * The native registry is process-local and empty at launch, so a cold
   * start of a phone paired with a desktop host holds no pin until this
   * runs. `buildSession` is the one place every session is built (launch,
   * switch, re-pair) — a new caller cannot forget it. A refusal is a refusal
   * to boot, never a boot without the pin: the alternative is a phone that,
   * after one restart, accepts any key on the local network.
   */
  /* The stored pin is BOTH the pin to install and the known one, so a launch can never be read
     as a key change: a profile's own key is what it is paired under. */
  const admitted = admitOrigin(profile.origin, profile.pin, profile.pin);
  if (!admitted.ok) return { kind: "refused", reason: admitted.reason };

  /**
   * The one population an upgrade cannot fix by itself, repaired here: a
   * self-hosted pairing made before the measured base stored none, which reads
   * as the origin — exactly what never worked (an HTML 404 on every drain) —
   * and nothing re-probes, so those profiles stay broken until told to re-pair.
   * Not a blanket re-probe: gated on `flavor === "selfhost"` and
   * `apiBase === null`, precisely the profiles that never mirrored a message, so
   * `bootEngine`'s wire-free contract holds for everyone else. A failure here
   * is not fatal: the profile boots against the origin as before, no worse than it was.
   */
  let apiBase = profile.apiBase;
  if (apiBase === null && profile.flavor === "selfhost") {
    const measured = await resolveApiBase(env.fetchImpl ?? bareFetch(), profile.origin);
    if (measured.kind === "base") {
      apiBase = measured.base;
      /* Persisted, so the next launch is wire-free again. A refusal from the keystore is not worth
         failing the boot over — the session works either way and the repair simply retries. */
      await env.profiles.setApiBase(profile.id, measured.base).catch(() => undefined);
    }
  }

  const bearer = new BearerManagerRN({
    origin: profile.origin,
    accessToken,
    refreshToken: profile.refreshToken,
    vault: vaultFor(env.profiles, profile.id),
    ...(env.fetchImpl ? { fetchImpl: env.fetchImpl } : {}),
  });
  // A CREDENTIAL-LESS BEARER IS REFUSED HERE, STRUCTURALLY — not left to the caller's guard.
  // `connectProfile` already refuses a `refreshToken: null` row, but the property must hold
  // wherever a session could be built, because a null-credential bearer is the one shape the
  // "dies on first wire touch" rule below cannot catch: with no refresh token to present,
  // `rotate()` returns false without ever firing `onSessionDead`, and an adopted session
  // would render cached mail behind an endless quiet 401 instead of routing to re-pair.
  if (!bearer.paired()) {
    return {
      kind: "refused",
      needsRepair: true,
      reason: refuse("pairEndedRefused"),
    };
  }
  const boot = await bootEngine(env.engineDeps, {
    origin: profile.origin,
    // WHERE THIS SERVER'S `/sync` FAMILY ANSWERS — measured at pairing time and stored on the
    // profile, so no launch pays for a probe and the boot still touches no wire. Absent on every
    // row written before it existed, which `bootEngine` reads as the origin: exactly what those
    // rows have always used, and right for the two doors that serve their API at their root.
    //
    // THE LOCAL, NOT `profile.apiBase`: the self-host repair above may have just measured one for a
    // row that had none, and reading the held copy would store the base and then boot without it —
    // a repair that runs, persists, and changes nothing until the launch after.
    apiBase,
    accountId: profile.accountId,
    auth: { headers: () => bearer.headers(), fetch: bearer.fetch },
  });
  if (boot.kind === "refused") return { kind: "refused", reason: boot.reason };
  // The boot makes NO request any more (boot-from-local, `engine/boot.ts`), so the bearer
  // cannot die inside it — the "ready-but-dead" window a `bearer.paired()` check used to
  // close here has moved, not vanished. A revoked cold profile now boots ready over its own
  // cached mirror and dies on the FIRST wire touch (the deferred identity probe or the first
  // drain, whichever 401s into the refused rotation first) — and both of those are started
  // by the connection layer AFTER it subscribes `onSessionDead` in `adopt`, so the death
  // always lands on a listener and tears down to the same one-gesture sentence.
  // `pairing.test.ts` pins that ordering-free version of the property.
  return {
    kind: "connected",
    session: {
      profile,
      bearer,
      /* THE MANAGER'S OWN TRANSPORT — the same function the adapter above rides, so the app's reads
         and the drain's pages carry one credential and one rotation. */
      fetch: bearer.fetch,
      engine: boot.engine,
      store: boot.store,
      ownerKey: mirrorOwnerKey(profile.origin, profile.accountId),
      verifyIdentity: boot.verifyIdentity,
      standalone: profile.origin === LOCAL_ENGINE_ORIGIN,
    },
  };
}

/**
 * The standalone door's session — the engine in this process, as a session
 * like any other; this is `bootEngine`'s once-missing caller. It does not give
 * this install a second copy of the mailbox: the mirror is keyed
 * (`LOCAL_ENGINE_ORIGIN`, accountId) with the id the engine reports, and the
 * id on the row is compared against it rather than trusted — a restored backup
 * can leave a row naming an account this store no longer serves, and opening
 * a mirror under that name would be the second copy, quietly.
 */
async function buildLocalSession(env: PairingEnv, profile: ServerProfile): Promise<ConnectOutcome> {
  const port = env.standalone;
  if (port === undefined) return { kind: "refused", reason: refuse("standaloneNoEngine") };
  let door = port.door();
  if (door === null) {
    /* A COLD LAUNCH. Nothing is running, the form that took the password is long gone, and what
       opens the mailbox is what the engine sealed for itself — see `reopenStandaloneMailbox`. */
    const opened = await port.reopen();
    if (!opened.ok) return { kind: "refused", reason: opened.reason };
    door = opened.door;
    /**
     * Held here, not by the port: this is the one place a door becomes the
     * session's. A port implementation that forgot would leave
     * `organizerDoor()` null with an engine running, so a second connect in
     * the same launch opens a second engine — two organizers of one mailbox —
     * the forget finds nothing to hand back, and the engine keeps polling a
     * mailbox the person removed. First-start-wins, so a port that holds it
     * itself is not a conflict.
     */
    holdStandaloneDoor(door);
  }
  const says = door.accountId.trim();
  if (says !== profile.accountId.trim()) {
    return { kind: "refused", reason: refuse("standaloneOtherMailbox") };
  }
  const boot = await bootEngine(env.engineDeps, {
    origin: LOCAL_ENGINE_ORIGIN,
    accountId: profile.accountId,
    localEngine: door,
  });
  if (boot.kind === "refused") return { kind: "refused", reason: boot.reason };
  return {
    kind: "connected",
    session: {
      profile,
      /* NO MANAGER, and that is the state rather than a gap: the engine mints its own bearer per
         launch, there is no family to rotate and nothing can refuse it. The two readers that want a
         manager check for it. */
      bearer: null,
      fetch: localEngineTransport(door).fetch,
      engine: boot.engine,
      store: boot.store,
      ownerKey: mirrorOwnerKey(LOCAL_ENGINE_ORIGIN, profile.accountId),
      verifyIdentity: boot.verifyIdentity,
      standalone: profile.origin === LOCAL_ENGINE_ORIGIN,
    },
  };
}
